import { consumeRuntimeLastError, safePostMessage, sendRuntimeMessage } from "../shared/messaging.js";
import { checkHostPermissionViaBackground, extractOriginFromBaseUrl, HOST_PERMISSION_HINT } from "./host-permissions.js";
import {
  buildProviderFetchInit,
  buildProviderRequestPayload,
  errorText,
  isRequestAborted,
  makeAbortError,
  normalizeResponseStatus,
  resolveRequestTarget,
  type ProviderTransport
} from "./provider-http-shared.js";
import type {
  OffscreenProviderHttpPortMessage,
  OffscreenProviderHttpPortReply
} from "../shared/messaging-protocol.js";

export const PROVIDER_HTTP_OFFSCREEN_PORT_NAME = "provider-http-offscreen" as const;

const PORT_DISCONNECTED_MESSAGE = "代发通道已断开（offscreen 文档未就绪或被回收），请重试";

const DISPATCH_UNCLAIMED_MESSAGE = "代发通道无人接管（offscreen 文档未就绪或被回收），请重试";

const DISPATCH_ACK_TIMEOUT_MS = 2000;

const DISPATCH_MAX_ATTEMPTS = 2;

function makeUnclaimedPortError(): Error & { dispatchUnclaimed: true } {
  const error = new Error(DISPATCH_UNCLAIMED_MESSAGE) as Error & { dispatchUnclaimed: true };
  error.dispatchUnclaimed = true;
  return error;
}

function makeDisconnectedPortError(): Error & { portDisconnected: true } {
  const error = new Error(PORT_DISCONNECTED_MESSAGE) as Error & { portDisconnected: true };
  error.portDisconnected = true;
  return error;
}

function isRetryableDispatchFailure(error: unknown): boolean {
  const marked = error as { dispatchUnclaimed?: unknown; portDisconnected?: unknown } | null;
  return Boolean(marked?.dispatchUnclaimed || marked?.portDisconnected);
}

async function providerFetchViaOffscreenImpl(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const payload = buildProviderRequestPayload(input, init);
  if (isRequestAborted(init?.signal)) {
    throw makeAbortError();
  }
  const permission = await checkHostPermissionViaBackground(payload.url);
  if (!permission.granted) {
    throw new Error(permission.status === "invalid-origin" ? "请求地址不合法" : HOST_PERMISSION_HINT);
  }

  let attempt = 0;
  for (;;) {
    attempt += 1;
    await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
    if (isRequestAborted(init?.signal)) {
      throw makeAbortError();
    }
    const port = chrome.runtime.connect({ name: PROVIDER_HTTP_OFFSCREEN_PORT_NAME });
    try {
      return await openProviderStream(port, { action: "provider-http", ...payload }, init?.signal);
    } catch (error) {
      if (attempt >= DISPATCH_MAX_ATTEMPTS || !isRetryableDispatchFailure(error) || isRequestAborted(init?.signal)) {
        throw error;
      }
    }
  }
}

export const providerFetchViaOffscreen: ProviderTransport = Object.assign(
  providerFetchViaOffscreenImpl,
  { supportsStreaming: true as const }
);

function openProviderStream(
  port: chrome.runtime.Port,
  payload: OffscreenProviderHttpPortMessage,
  signal?: AbortSignal | null
): Promise<Response> {
  const encoder = new TextEncoder();

  return new Promise<Response>((resolve, reject) => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    let settled = false;
    let streamDone = false;
    let ackTimer: ReturnType<typeof setTimeout> | null = null;

    const clearAckTimer = (): void => {
      if (ackTimer !== null) {
        clearTimeout(ackTimer);
        ackTimer = null;
      }
    };
    const releasePort = (): void => {
      clearAckTimer();
      signal?.removeEventListener("abort", onAbort);
      try {
        port.disconnect();
      } catch {
      }
    };
    const closeStream = (): void => {
      if (streamDone) {
        return;
      }
      streamDone = true;
      releasePort();
      streamController.close();
    };
    const failStream = (message: string): void => {
      if (streamDone) {
        return;
      }
      streamDone = true;
      releasePort();
      streamController.error(new Error(message));
    };
    const onAbort = (): void => {
      if (!settled) {
        settled = true;
        releasePort();
        reject(makeAbortError());
        return;
      }
      failStream("请求已中止");
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
      cancel() {
        if (!streamDone) {
          streamDone = true;
          releasePort();
        }
      }
    });

    port.onMessage.addListener((raw) => {
      const reply = raw as OffscreenProviderHttpPortReply;
      clearAckTimer();
      if (reply?.accepted) {
        return;
      }
      if (!reply?.ok) {
        const message = reply?.error || "请求失败";
        if (settled) {
          failStream(message);
          return;
        }
        settled = true;
        releasePort();
        reject(new Error(message));
        return;
      }
      if (!settled) {
        settled = true;
        resolve(new Response(stream, { status: normalizeResponseStatus(reply.status) }));
        return;
      }
      if (streamDone) {
        return;
      }
      if (reply.chunk) {
        streamController.enqueue(encoder.encode(String(reply.chunk)));
        return;
      }
      if (reply.done) {
        closeStream();
      }
    });
    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      if (!settled) {
        settled = true;
        releasePort();
        reject(makeDisconnectedPortError());
        return;
      }
      failStream(PORT_DISCONNECTED_MESSAGE);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    ackTimer = setTimeout(() => {
      ackTimer = null;
      if (settled || streamDone) {
        return;
      }
      settled = true;
      streamDone = true;
      releasePort();
      reject(makeUnclaimedPortError());
    }, DISPATCH_ACK_TIMEOUT_MS);
    port.postMessage(payload);
  });
}

export function attachProviderHttpPort(port: chrome.runtime.Port): void {
  const inflight = new Set<AbortController>();
  port.onDisconnect.addListener(() => {
    consumeRuntimeLastError();
    for (const controller of inflight) {
      if (!controller.signal.aborted) {
        controller.abort();
      }
    }
    inflight.clear();
  });

  port.onMessage.addListener(async (rawMsg) => {
    const message = rawMsg as OffscreenProviderHttpPortMessage;
    if (!message || message.action !== "provider-http") {
      return;
    }
    safePostMessage(port, { ok: true, accepted: true });
    const controller = new AbortController();
    inflight.add(controller);
    try {
      await forwardProviderRequest(port, message, controller.signal);
    } finally {
      inflight.delete(controller);
    }
  });
}

async function forwardProviderRequest(
  port: chrome.runtime.Port,
  message: OffscreenProviderHttpPortMessage,
  signal: AbortSignal
): Promise<void> {
  const target = resolveRequestTarget(message.url, extractOriginFromBaseUrl);
  if (!target) {
    safePostMessage(port, { ok: false, error: "请求地址不合法" });
    return;
  }
  let resp: Response;
  try {
    resp = await fetch(
      target,
      buildProviderFetchInit({ method: message.method, headers: message.headers, body: message.body }, signal)
    );
  } catch (error) {
    safePostMessage(port, { ok: false, error: errorText(error) });
    return;
  }
  safePostMessage(port, { ok: true, status: resp.status });
  const body = resp.body;
  if (!body) {
    safePostMessage(port, { ok: true, status: resp.status, done: true });
    return;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) {
        safePostMessage(port, { ok: true, status: resp.status, chunk });
      }
    }
    const tail = decoder.decode();
    if (tail) {
      safePostMessage(port, { ok: true, status: resp.status, chunk: tail });
    }
  } catch (error) {
    safePostMessage(port, { ok: false, error: errorText(error) });
    return;
  }
  safePostMessage(port, { ok: true, status: resp.status, done: true });
}
