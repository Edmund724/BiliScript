// extension/ai/index-translate.ts
// 内置 Bilibili Index-Translate 免 Key 翻译通道的运行时适配原语：
//   1. `<think>...</think>` 兜底清洗（整段清洗 + 流式状态机过滤，防止偶发思维链污染 JSON 解析）；
//   2. 并发与速率限制器（默认最多 2 路并发、每 1000ms 窗口不超过 3 次请求，适配公网免费接口限流）；
//   3. HTTP 429 / 网络抖动 / 5xx 指数退避重试与可读错误格式化（配合共享冷却窗口与 AbortSignal 中止）。

import {
  isAbortNamedError,
  isAbortedMarkerError,
  isCancelledError,
  isRetryableNetworkError
} from "../shared/error-helpers.js";

export const DEFAULT_INDEX_TRANSLATE_MAX_CONCURRENCY = 2;
export const DEFAULT_INDEX_TRANSLATE_MAX_REQUESTS_PER_WINDOW = 3;
export const DEFAULT_INDEX_TRANSLATE_WINDOW_MS = 1000;
export const DEFAULT_INDEX_TRANSLATE_MAX_RETRIES = 3;
export const DEFAULT_INDEX_TRANSLATE_BASE_DELAY_MS = 1000;
export const DEFAULT_INDEX_TRANSLATE_MAX_DELAY_MS = 10_000;

const OPEN_THINK_TAG = "<think>";
const CLOSE_THINK_TAG = "</think>";

function makeAbortError(signal?: AbortSignal | null): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

export function isAbortLikeError(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    Boolean(signal?.aborted) ||
    isAbortedMarkerError(error) ||
    isAbortNamedError(error) ||
    isCancelledError(error)
  );
}

export function sleepWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(makeAbortError(signal));
  }
  const delay = Math.max(0, Math.floor(Number(ms) || 0));
  if (delay === 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(makeAbortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 兜底清洗模型返回文本中的 `<think>...</think>` 思维链块（大小写不敏感）。
 * - 移除所有闭合的 `<think>...</think>` 块；
 * - 若因截断残留未闭合 `<think>...` 块，一并剔除后裁剪首尾空白。
 */
export function stripThinkBlocks(text: string): string {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}

export interface ThinkBlockStreamFilter {
  push(chunk: string): void;
  flush(): void;
  reset(): void;
}

function trailingTagPrefixLength(text: string, tag: string): number {
  const lower = text.toLowerCase();
  const maxCheck = Math.min(lower.length, tag.length - 1);
  for (let len = maxCheck; len >= 1; len -= 1) {
    if (lower.endsWith(tag.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * 创建流式 `<think>...</think>` 过滤器：
 * 在 SSE token 分片到达时即时屏蔽思维链内容，仅向消费方（如流式 JSON 解析器）吐出正文，
 * 并正确处理 `<think>` / `</think>` 跨分片被切开的边界。
 */
export function createThinkBlockStreamFilter(
  onText: (cleanChunk: string) => void
): ThinkBlockStreamFilter {
  let buffer = "";
  let inThink = false;

  function drain(): void {
    while (buffer.length > 0) {
      if (!inThink) {
        const idx = buffer.toLowerCase().indexOf(OPEN_THINK_TAG);
        if (idx !== -1) {
          const before = buffer.slice(0, idx);
          if (before) {
            onText(before);
          }
          buffer = buffer.slice(idx + OPEN_THINK_TAG.length);
          inThink = true;
          continue;
        }
        const keep = trailingTagPrefixLength(buffer, OPEN_THINK_TAG);
        const safe = buffer.slice(0, buffer.length - keep);
        if (safe) {
          onText(safe);
        }
        buffer = buffer.slice(buffer.length - keep);
        break;
      }

      const closeIdx = buffer.toLowerCase().indexOf(CLOSE_THINK_TAG);
      if (closeIdx !== -1) {
        buffer = buffer.slice(closeIdx + CLOSE_THINK_TAG.length);
        inThink = false;
        continue;
      }
      const keep = trailingTagPrefixLength(buffer, CLOSE_THINK_TAG);
      buffer = buffer.slice(buffer.length - keep);
      break;
    }
  }

  return {
    push(chunk: string): void {
      if (!chunk) {
        return;
      }
      buffer += chunk;
      drain();
    },
    flush(): void {
      if (!inThink && buffer) {
        onText(buffer);
      }
      buffer = "";
    },
    reset(): void {
      buffer = "";
      inThink = false;
    }
  };
}

export interface IndexTranslateRateLimiterOptions {
  maxConcurrency?: number;
  maxRequestsPerWindow?: number;
  windowMs?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
}

export interface IndexTranslateRateLimiter {
  run<T>(task: () => Promise<T>, signal?: AbortSignal | null): Promise<T>;
  noteCooldown(delayMs: number): void;
  getSnapshot(): {
    active: number;
    recentRequestCount: number;
    cooldownUntil: number;
  };
}

/**
 * 创建 Index-Translate 通道限流器：
 * - 限制同时在飞的并发请求数（默认 <= 2）；
 * - 滑动时间窗限制请求频率（默认每 1000ms 最多 3 次，<= 3 req/s）；
 * - 支持 429 全局冷却广播，避免并发分片在限流期集中重试。
 */
export function createIndexTranslateRateLimiter(
  options: IndexTranslateRateLimiterOptions = {}
): IndexTranslateRateLimiter {
  const maxConcurrency = Math.max(
    1,
    Math.floor(options.maxConcurrency ?? DEFAULT_INDEX_TRANSLATE_MAX_CONCURRENCY)
  );
  const maxRequestsPerWindow = Math.max(
    1,
    Math.floor(options.maxRequestsPerWindow ?? DEFAULT_INDEX_TRANSLATE_MAX_REQUESTS_PER_WINDOW)
  );
  const windowMs = Math.max(
    1,
    Math.floor(options.windowMs ?? DEFAULT_INDEX_TRANSLATE_WINDOW_MS)
  );
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? sleepWithAbort;

  let active = 0;
  let cooldownUntil = 0;
  const recentTimestamps: number[] = [];
  const slotWaiters = new Set<() => void>();
  let acquireChain: Promise<void> = Promise.resolve();

  function pruneExpired(currentNow: number): void {
    const cutoff = currentNow - windowMs;
    while (recentTimestamps.length > 0 && recentTimestamps[0] <= cutoff) {
      recentTimestamps.shift();
    }
  }

  function waitForSlotRelease(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(makeAbortError(signal));
    }
    return new Promise<void>((resolve, reject) => {
      const notify = (): void => {
        signal?.removeEventListener("abort", onAbort);
        slotWaiters.delete(notify);
        resolve();
      };
      const onAbort = (): void => {
        slotWaiters.delete(notify);
        reject(makeAbortError(signal));
      };
      slotWaiters.add(notify);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function release(): void {
    active = Math.max(0, active - 1);
    const next = slotWaiters.values().next().value as (() => void) | undefined;
    if (next) {
      next();
    }
  }

  async function acquireSingle(signal?: AbortSignal | null): Promise<void> {
    for (;;) {
      if (signal?.aborted) {
        throw makeAbortError(signal);
      }
      const currentNow = now();
      pruneExpired(currentNow);

      const cooldownWait = cooldownUntil > currentNow ? cooldownUntil - currentNow : 0;
      const windowWait =
        recentTimestamps.length >= maxRequestsPerWindow
          ? Math.max(1, recentTimestamps[0] + windowMs - currentNow)
          : 0;

      if (active < maxConcurrency && cooldownWait === 0 && windowWait === 0) {
        active += 1;
        recentTimestamps.push(currentNow);
        return;
      }

      const waitMs = Math.max(cooldownWait, windowWait);
      if (waitMs > 0) {
        await sleep(waitMs, signal);
      } else {
        await waitForSlotRelease(signal);
      }
    }
  }

  function acquire(signal?: AbortSignal | null): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(makeAbortError(signal));
    }
    const run = acquireChain.then(() => acquireSingle(signal));
    // 保持 FIFO 队列不因单次中止/失败而阻塞后续请求
    acquireChain = run.catch(() => {});
    return run;
  }

  return {
    async run<T>(task: () => Promise<T>, signal?: AbortSignal | null): Promise<T> {
      await acquire(signal);
      try {
        return await task();
      } finally {
        release();
      }
    },
    noteCooldown(delayMs: number): void {
      const normalized = Math.max(0, Math.floor(Number(delayMs) || 0));
      if (normalized > 0) {
        cooldownUntil = Math.max(cooldownUntil, now() + normalized);
      }
    },
    getSnapshot() {
      pruneExpired(now());
      return {
        active,
        recentRequestCount: recentTimestamps.length,
        cooldownUntil
      };
    }
  };
}

export const defaultIndexTranslateLimiter: IndexTranslateRateLimiter = createIndexTranslateRateLimiter();

export function getHttpStatusFromError(error: unknown): number | undefined {
  const err = error as { status?: unknown; message?: unknown } | null | undefined;
  const direct = Number(err?.status);
  if (Number.isFinite(direct) && direct > 0) {
    return direct;
  }
  const msg = String(err?.message ?? error ?? "");
  const match = /\bHTTP\s+(\d{3})\b/i.exec(msg);
  if (match) {
    const parsed = Number(match[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

export function isHttp429Error(error: unknown): boolean {
  if (getHttpStatusFromError(error) === 429) {
    return true;
  }
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? error ?? "");
  return /\b429\b|rate[\s_-]*limit|too many requests/i.test(message);
}

export function isIndexTranslateRetryableError(error: unknown): boolean {
  if (isAbortLikeError(error)) {
    return false;
  }
  const status = getHttpStatusFromError(error);
  if (status !== undefined) {
    return status === 408 || status === 429 || status >= 500;
  }
  if (isHttp429Error(error) || isRetryableNetworkError(error)) {
    return true;
  }
  const message = String((error as { message?: unknown } | null | undefined)?.message ?? error ?? "").toLowerCase();
  return (
    message.includes("代发通道已断开") ||
    message.includes("代发通道无人接管") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("network") ||
    message.includes("stream")
  );
}

export interface IndexTranslateRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
  random?: () => number;
  sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  limiter?: IndexTranslateRateLimiter;
  signal?: AbortSignal | null;
  onRetry?: (info: { attempt: number; maxRetries: number; delayMs: number; error: unknown }) => void;
}

export function computeIndexTranslateBackoffMs(
  attempt: number,
  options: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    jitterRatio?: number;
    random?: () => number;
  } = {}
): number {
  const base = Math.max(0, Number(options.baseDelayMs ?? DEFAULT_INDEX_TRANSLATE_BASE_DELAY_MS));
  const max = Math.max(base, Number(options.maxDelayMs ?? DEFAULT_INDEX_TRANSLATE_MAX_DELAY_MS));
  const jitterRatio = Math.max(0, Math.min(0.5, Number(options.jitterRatio ?? 0.2)));
  const random = options.random ?? Math.random;

  const exponential = Math.min(max, base * Math.pow(2, Math.max(0, attempt)));
  if (exponential <= 0 || jitterRatio <= 0) {
    return Math.round(exponential);
  }
  const rawRand = random();
  const clampedRand = Number.isFinite(rawRand) ? Math.min(1, Math.max(0, rawRand)) : 0.5;
  const jitter = exponential * jitterRatio * clampedRand;
  return Math.min(max, Math.round(exponential + jitter));
}

export function formatIndexTranslateError(error: unknown): Error {
  if (isAbortLikeError(error)) {
    return error instanceof Error ? error : new Error("请求已中止");
  }
  const status = getHttpStatusFromError(error);
  const originalMessage = String(
    (error as { message?: unknown } | null | undefined)?.message ?? error ?? ""
  ).trim();
  const cause = (error as { cause?: unknown } | null | undefined)?.cause;

  let formatted: Error & { status?: number; retryable?: boolean; cause?: unknown };
  if (status === 429 || isHttp429Error(error)) {
    formatted = new Error(
      `Bilibili Index-Translate 请求过于频繁（HTTP 429 限流），已退避重试仍受限，请稍后再试${originalMessage ? `（${originalMessage}）` : ""}`
    );
    formatted.status = 429;
    formatted.retryable = true;
  } else if (status === 412) {
    formatted = new Error(
      `Bilibili Index-Translate 请求被风控拦截（HTTP 412），请确认扩展域名权限与请求头规则已生效${originalMessage ? `（${originalMessage}）` : ""}`
    );
    formatted.status = 412;
    formatted.retryable = false;
  } else if (status !== undefined && status >= 500) {
    formatted = new Error(
      `Bilibili Index-Translate 服务暂时不可用（HTTP ${status}），请稍后重试${originalMessage ? `（${originalMessage}）` : ""}`
    );
    formatted.status = status;
    formatted.retryable = true;
  } else if (isIndexTranslateRetryableError(error)) {
    formatted = new Error(
      `Bilibili Index-Translate 网络连接波动或请求超时，请检查网络后重试${originalMessage ? `（${originalMessage}）` : ""}`
    );
    if (status !== undefined) {
      formatted.status = status;
    }
    formatted.retryable = true;
  } else {
    formatted = new Error(
      originalMessage
        ? `Bilibili Index-Translate 翻译失败：${originalMessage}`
        : "Bilibili Index-Translate 翻译失败"
    );
    if (status !== undefined) {
      formatted.status = status;
    }
    formatted.retryable = false;
  }

  if (cause !== undefined) {
    formatted.cause = cause;
  }
  return formatted;
}

/**
 * 在 Index-Translate 限流器保护下执行请求，遇到 HTTP 429 或网络抖动时做指数退避重试，
 * 并在重试耗尽或不可恢复失败时抛出清晰可读的错误提示。
 */
export async function runWithIndexTranslateRetry<T>(
  task: () => Promise<T>,
  options: IndexTranslateRetryOptions = {}
): Promise<T> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_INDEX_TRANSLATE_MAX_RETRIES));
  const sleep = options.sleep ?? sleepWithAbort;
  const limiter = options.limiter ?? defaultIndexTranslateLimiter;
  const signal = options.signal ?? null;

  let lastError: unknown = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) {
      throw makeAbortError(signal);
    }
    try {
      return await limiter.run(task, signal);
    } catch (error) {
      if (isAbortLikeError(error, signal)) {
        throw error;
      }
      lastError = error;
      if (!isIndexTranslateRetryableError(error) || attempt >= maxRetries) {
        throw formatIndexTranslateError(error);
      }
      const delayMs = computeIndexTranslateBackoffMs(attempt, options);
      if (isHttp429Error(error)) {
        limiter.noteCooldown(delayMs);
      }
      options.onRetry?.({ attempt: attempt + 1, maxRetries, delayMs, error });
      await sleep(delayMs, signal);
    }
  }
  throw formatIndexTranslateError(lastError);
}
