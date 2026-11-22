import { sendRuntimeMessage } from "../shared/messaging.js";
import type { ProviderHttpMessage } from "../shared/messaging-protocol.js";
import { withTimeout } from "../shared/error-helpers.js";
import { extractOriginFromBaseUrl, HOST_PERMISSION_HINT, hasHostPermission } from "./host-permissions.js";
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

export type ProviderHttpRequestMessage = Omit<ProviderHttpMessage, "type">;

export interface ProviderHttpRequestResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

export async function handleProviderHttpRequest({
  url,
  method,
  headers,
  body
}: ProviderHttpRequestMessage): Promise<ProviderHttpRequestResult> {
  const target = resolveRequestTarget(url, extractOriginFromBaseUrl);
  if (!target) {
    return { ok: false, error: "请求地址不合法" };
  }
  if (!(await hasHostPermission(target))) {
    return { ok: false, error: HOST_PERMISSION_HINT };
  }
  const controller = new AbortController();
  const timeoutError = new Error("请求超时，请检查 baseUrl 或稍后重试");
  try {
    const { status, body: responseText } = await withTimeout(
      (async () => {
        const resp = await fetch(target, buildProviderFetchInit({ method, headers, body }, controller.signal));
        return { status: resp.status, body: await resp.text() };
      })(),
      15000,
      timeoutError
    );
    return { ok: true, status, body: responseText };
  } catch (error) {
    if (error === timeoutError) {
      controller.abort();
    }
    return { ok: false, error: errorText(error) };
  }
}

async function providerFetchViaBackgroundImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const payload = buildProviderRequestPayload(input, init);
  if (isRequestAborted(init?.signal)) {
    throw makeAbortError();
  }
  const resp = await raceWithAbort(sendRuntimeMessage({ type: "provider-http", ...payload }), init?.signal);
  if (!resp?.ok) {
    throw new Error(resp?.error || "请求失败");
  }
  return new Response(resp.body ?? "", { status: normalizeResponseStatus(resp.status) });
}

export const providerFetchViaBackground: ProviderTransport = Object.assign(
  providerFetchViaBackgroundImpl,
  { supportsStreaming: false as const }
);

function raceWithAbort<T>(pending: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) {
    return pending;
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(makeAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
