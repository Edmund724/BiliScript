export interface ProviderTransport {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  readonly supportsStreaming?: boolean;
}

export interface ProviderRequestPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface ProviderFetchInitInput {
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

export function extractRequestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : String(input?.url || "");
}

export function normalizeRequestHeaders(headers?: HeadersInit): Record<string, string> {
  const normalized: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    normalized[key] = value;
  });
  return normalized;
}

export function isRequestAborted(signal?: AbortSignal | null): boolean {
  return signal?.aborted === true;
}

export function errorText(error: unknown): string {
  return (error as Error | undefined)?.message || String(error);
}

export function normalizeResponseStatus(status: unknown): number {
  return Number(status) || 200;
}

export function makeAbortError(): Error {
  const error = new Error("请求已中止");
  error.name = "AbortError";
  return error;
}

export function resolveRequestTarget(url: unknown, isValidTarget: (target: string) => unknown): string | null {
  const target = String(url || "").trim();
  return isValidTarget(target) ? target : null;
}

export function buildProviderFetchInit(input: ProviderFetchInitInput, signal: AbortSignal): RequestInit {
  return {
    method: String(input.method || "GET"),
    headers: input.headers,
    body: input.body == null ? undefined : input.body,
    signal
  };
}

export function buildProviderRequestPayload(input: RequestInfo | URL, init?: RequestInit): ProviderRequestPayload {
  return {
    url: extractRequestUrl(input),
    method: String(init?.method || "GET"),
    headers: normalizeRequestHeaders(init?.headers),
    body: typeof init?.body === "string" ? init.body : undefined
  };
}
