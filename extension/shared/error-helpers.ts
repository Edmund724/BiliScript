import { sleep } from "./utils.js";
import { logInfo } from "./logging.js";

interface BiliscriptErrorLike {
  code?: unknown;
  retryable?: unknown;
  status?: unknown;
  message?: unknown;
  aborted?: unknown;
  name?: unknown;
  cancelled?: unknown;
}

function isErrorObject(value: unknown): value is BiliscriptErrorLike {
  return typeof value === "object" && value !== null;
}

export function toReadableText(value: unknown, fallback = ""): string {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || text === "[object Object]") {
      return fallback;
    }
    return text;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") {
      return json;
    }
  } catch {
  }
  const text = String(value);
  if (!text || text === "[object Object]") {
    return fallback;
  }
  return text;
}

export function getErrorMessage(error: unknown, fallback = "未知错误"): string {
  if (isErrorObject(error)) {
    const code = toReadableText(error.code, "");
    const message = toReadableText(error.message, "");
    if (message) {
      return code ? `${message} (code: ${code})` : message;
    }
    if (code) {
      return `code: ${code}`;
    }
  }
  return toReadableText(error, fallback);
}

export function makeStaleRunError(): Error & { code: string } {
  return Object.assign(new Error("Stale refresh run"), { code: "STALE_RUN" });
}

export function ensureRunActive(runId: string | number, expectedRunId: string | number): void {
  if (runId !== expectedRunId) {
    throw makeStaleRunError();
  }
}

export function isStaleRunError(error: unknown): boolean {
  return isErrorObject(error) && error.code === "STALE_RUN";
}

export function isRetryableNetworkError(error: unknown): boolean {
  const status = isErrorObject(error) ? Number(error.status) : NaN;
  if (Number.isFinite(status) && status > 0) {
    return status === 408 || status === 429 || status >= 500;
  }

  const message = getErrorMessage(error, "").toLowerCase();
  if (!message) {
    return false;
  }

  if (message.includes("http ")) {
    return true;
  }

  return (
    message.includes("请求失败") ||
    message.includes("failed to fetch") ||
    message.includes("fetch failed") ||
    message.includes("networkerror") ||
    message.includes("net::") ||
    message.includes("background fetch failed") ||
    message.includes("timeout") ||
    message.includes("timed out")
  );
}

export async function retryAsync<T>(task: () => Promise<T>, retries = 1, delayMs = 180): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const err = isErrorObject(error) ? error : null;
      const isNetworkError = isRetryableNetworkError(error);
      const isRetryable = err?.retryable === true;
      if (!isNetworkError && !isRetryable) {
        throw error;
      }
      if (attempt >= retries) {
        throw error;
      }
      const backoffDelay = Math.min(delayMs * Math.pow(2, attempt - 1), 5000);
      logInfo(`[BILISCRIPT] retrying after ${backoffDelay}ms, attempt ${attempt + 1}/${retries}`, {
        error: getErrorMessage(error),
        code: err?.code
      });
      await sleep(backoffDelay);
    }
  }
  throw lastError || new Error("Unknown retry error");
}

export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError?: null): Promise<T | undefined>;
export function withTimeout<T>(promise: Promise<T>, ms: number, timeoutError: Error): Promise<T>;
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  timeoutError: Error | null = null
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<T | undefined>((resolve, reject) => {
    timer = setTimeout(() => {
      if (timeoutError) {
        reject(timeoutError);
      } else {
        resolve(undefined);
      }
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export function makeAbortedError(message = "已停止生成"): Error & { aborted: true } {
  return Object.assign(new Error(message), { aborted: true as const });
}

export function isAbortedMarkerError(error: unknown): boolean {
  return isErrorObject(error) && error.aborted === true;
}

export function isAbortNamedError(error: unknown): boolean {
  return isErrorObject(error) && error.name === "AbortError";
}

export function isCancelledError(error: unknown): boolean {
  return isErrorObject(error) && error.cancelled === true;
}

export function isExtensionContextInvalidated(error: unknown): boolean {
  const msg = isErrorObject(error) ? String(error.message || "") : "";
  return msg.includes("Extension context invalidated");
}
