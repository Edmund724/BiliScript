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

type StreamReadWaiter = {
  resolve: (result: ReadableStreamReadResult<Uint8Array>) => void;
  reject: (error: unknown) => void;
};

interface PortStreamResponseHandle {
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
  error: (err: Error) => void;
  toResponse: (status: unknown) => Response;
}

function createPortStreamResponse(onCancel: () => void): PortStreamResponseHandle {
  const chunks: Uint8Array[] = [];
  const waiters: StreamReadWaiter[] = [];
  let closed = false;
  let cancelled = false;
  let failedError: Error | null = null;
  let locked = false;
  let bodyUsed = false;

  const flushWaitersDone = (): void => {
    while (waiters.length > 0) {
      waiters.shift()!.resolve({ value: undefined, done: true });
    }
  };

  const enqueue = (chunk: Uint8Array): void => {
    if (closed || cancelled || failedError) {
      return;
    }
    const waiter = waiters.shift();
    if (waiter) {
      waiter.resolve({ value: chunk, done: false });
      return;
    }
    chunks.push(chunk);
  };

  const close = (): void => {
    if (closed || cancelled || failedError) {
      return;
    }
    closed = true;
    flushWaitersDone();
  };

  const error = (err: Error): void => {
    if (closed || cancelled || failedError) {
      return;
    }
    failedError = err;
    chunks.length = 0;
    while (waiters.length > 0) {
      waiters.shift()!.reject(err);
    }
  };

  const cancelStream = (): void => {
    if (closed || cancelled || failedError) {
      return;
    }
    cancelled = true;
    chunks.length = 0;
    flushWaitersDone();
    onCancel();
  };

  const body = {
    get locked(): boolean {
      return locked;
    },
    getReader() {
      if (locked) {
        throw new TypeError("ReadableStream is locked");
      }
      locked = true;
      return {
        read(): Promise<ReadableStreamReadResult<Uint8Array>> {
          if (failedError) {
            return Promise.reject(failedError);
          }
          if (chunks.length > 0) {
            return Promise.resolve({ value: chunks.shift()!, done: false });
          }
          if (closed || cancelled) {
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        cancel(): Promise<void> {
          cancelStream();
          return Promise.resolve();
        },
        releaseLock(): void {
          locked = false;
        }
      };
    },
    cancel(): Promise<void> {
      if (locked) {
        return Promise.reject(new TypeError("ReadableStream is locked"));
      }
      cancelStream();
      return Promise.resolve();
    }
  };

  const toResponse = (rawStatus: unknown): Response => {
    const status = normalizeResponseStatus(rawStatus);
    const ok = status >= 200 && status < 300;
    const text = async (): Promise<string> => {
      if (bodyUsed) {
        throw new TypeError("Body has already been used");
      }
      const reader = body.getReader();
      bodyUsed = true;
      const decoder = new TextDecoder();
      let result = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          result += decoder.decode(value, { stream: true });
        }
        result += decoder.decode();
        return result;
      } finally {
        reader.releaseLock();
      }
    };
    const json = async (): Promise<unknown> => JSON.parse(await text());
    return {
      status,
      ok,
      body,
      get bodyUsed(): boolean {
        return bodyUsed;
      },
      text,
      json
    } as unknown as Response;
  };

  return { enqueue, close, error, toResponse };
}

function openProviderStream(
  port: chrome.runtime.Port,
  payload: OffscreenProviderHttpPortMessage,
  signal?: AbortSignal | null
): Promise<Response> {
  const encoder = new TextEncoder();

  return new Promise<Response>((resolve, reject) => {
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
    const portStream = createPortStreamResponse(() => {
      if (!streamDone) {
        streamDone = true;
        releasePort();
      }
    });
    const closeStream = (): void => {
      if (streamDone) {
        return;
      }
      streamDone = true;
      releasePort();
      portStream.close();
    };
    const failStream = (message: string): void => {
      if (streamDone) {
        return;
      }
      streamDone = true;
      releasePort();
      portStream.error(new Error(message));
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
        resolve(portStream.toResponse(reply.status));
        return;
      }
      if (streamDone) {
        return;
      }
      if (reply.chunk) {
        portStream.enqueue(encoder.encode(String(reply.chunk)));
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
