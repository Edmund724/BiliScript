// extension/subtitle/chunk-scheduler.ts
// 播放进度优先懒调度器（参考 fishjar/kiss-translator 的 createAiChunkScheduler）：
//   - 首屏秒出：初始阶段单路并发独占当前播放点所在分块，完成后或 Seek 时解锁可控并发（默认 2）；
//   - 90 秒预载窗口：[currentTimeSec, currentTimeSec + 90] 内分块零延迟优先派发，Seek 立即插队；
//   - 节流与退避：timeupdate 扫描节流（默认 500ms），后台全量补齐块间随机抖动退避（300–600ms），
//     429 速率限制指数退避冷却重试，支持暂停超时保护（300_000ms）与 AbortSignal 取消。

export const PAUSE_TIMEOUT_MS = 300_000;
export const DEFAULT_PRELOAD_WINDOW_SEC = 90;
export const DEFAULT_MAX_CONCURRENCY = 2;
export const DEFAULT_SCAN_THROTTLE_MS = 500;
export const DEFAULT_BACKGROUND_JITTER_RANGE_MS: readonly [number, number] = [300, 600];
export const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
export const DEFAULT_RATE_LIMIT_BASE_DELAY_MS = 1000;
export const DEFAULT_RATE_LIMIT_MAX_DELAY_MS = 30_000;

export type SubtitleChunkStatus = "pending" | "running" | "done" | "failed";

export interface SubtitleSchedulableChunk<T = unknown> {
  index: number;
  startSec: number;
  endSec: number;
  payload?: T;
  status?: SubtitleChunkStatus;
}

export interface SubtitleChunkSchedulerOptions<T = unknown> {
  chunks?: readonly SubtitleSchedulableChunk<T>[];
  runChunk: (chunk: SubtitleSchedulableChunk<T>, signal: AbortSignal) => Promise<void>;
  getCurrentTimeSec?: () => number;
  initialTimeSec?: number;
  video?: HTMLVideoElement | null;
  preloadWindowSec?: number;
  maxConcurrency?: number;
  firstScreenSolo?: boolean;
  fillBackground?: boolean;
  scanThrottleMs?: number;
  backgroundJitterRangeMs?: readonly [number, number];
  maxRateLimitRetries?: number;
  rateLimitBaseDelayMs?: number;
  rateLimitMaxDelayMs?: number;
  failureCooldownMs?: number;
  pauseTimeoutMs?: number;
  signal?: AbortSignal | null;
  random?: () => number;
  now?: () => number;
  onChunkDone?: (chunk: SubtitleSchedulableChunk<T>) => void;
  onChunkError?: (chunk: SubtitleSchedulableChunk<T>, error: unknown) => void;
  onPauseTimeout?: () => void;
}

export interface SubtitleChunkSchedulerSnapshot {
  currentTimeSec: number;
  started: boolean;
  stopped: boolean;
  inFlight: number;
  total: number;
  done: number;
  failed: number;
}

export interface SubtitleChunkSchedulerIdleResult {
  total: number;
  done: number;
  failed: number;
  aborted: boolean;
}

export interface SubtitleChunkScheduler<T = unknown> {
  start(): void;
  stop(): void;
  seek(timeSec: number): void;
  updatePlaybackTime(timeSec: number): void;
  notifyPause(): void;
  notifyPlay(): void;
  upsertChunk(chunk: SubtitleSchedulableChunk<T>, options?: { resetStatus?: boolean }): void;
  getChunkStatus(index: number): SubtitleChunkStatus | undefined;
  getSnapshot(): SubtitleChunkSchedulerSnapshot;
  waitForIdle(): Promise<SubtitleChunkSchedulerIdleResult>;
}

interface InternalChunkRecord<T> {
  chunk: SubtitleSchedulableChunk<T>;
  status: SubtitleChunkStatus;
  revision: number;
  rateLimitAttempts: number;
  rateLimitUntil: number;
  failCount: number;
  cooldownUntil: number;
}

type PickedCandidate<T> =
  | { kind: "window"; record: InternalChunkRecord<T> }
  | { kind: "background"; record: InternalChunkRecord<T> };

function normalizeTimeSec(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function isRateLimitError(error: unknown): boolean {
  const status = Number((error as { status?: unknown } | null | undefined)?.status);
  if (status === 429) {
    return true;
  }
  const message = String(
    (error as { message?: unknown } | null | undefined)?.message ?? error ?? ""
  );
  return /\b429\b|rate[\s_-]*limit|too many requests/i.test(message);
}

function isAbortedError(error: unknown, signal?: AbortSignal | null): boolean {
  if (signal?.aborted) {
    return true;
  }
  const candidate = error as { name?: unknown; aborted?: unknown; cancelled?: unknown } | null | undefined;
  return (
    candidate?.aborted === true ||
    candidate?.cancelled === true ||
    candidate?.name === "AbortError"
  );
}

function containsPlaybackTime(chunk: SubtitleSchedulableChunk<unknown>, timeSec: number): boolean {
  if (chunk.endSec > chunk.startSec) {
    return chunk.startSec <= timeSec && timeSec < chunk.endSec;
  }
  return Math.abs(chunk.startSec - timeSec) < 0.001;
}

function intersectsPreloadWindow(
  chunk: SubtitleSchedulableChunk<unknown>,
  timeSec: number,
  windowSec: number
): boolean {
  const windowEnd = timeSec + Math.max(0, windowSec);
  if (chunk.endSec > chunk.startSec) {
    return chunk.endSec > timeSec && chunk.startSec < windowEnd;
  }
  return chunk.startSec >= timeSec && chunk.startSec < windowEnd;
}

export function createSubtitleChunkScheduler<T = unknown>(
  options: SubtitleChunkSchedulerOptions<T>
): SubtitleChunkScheduler<T> {
  const {
    runChunk,
    getCurrentTimeSec,
    video = null,
    preloadWindowSec = DEFAULT_PRELOAD_WINDOW_SEC,
    maxConcurrency = DEFAULT_MAX_CONCURRENCY,
    firstScreenSolo = true,
    fillBackground = false,
    scanThrottleMs = DEFAULT_SCAN_THROTTLE_MS,
    backgroundJitterRangeMs = DEFAULT_BACKGROUND_JITTER_RANGE_MS,
    maxRateLimitRetries = DEFAULT_MAX_RATE_LIMIT_RETRIES,
    rateLimitBaseDelayMs = DEFAULT_RATE_LIMIT_BASE_DELAY_MS,
    rateLimitMaxDelayMs = DEFAULT_RATE_LIMIT_MAX_DELAY_MS,
    failureCooldownMs = 0,
    pauseTimeoutMs = PAUSE_TIMEOUT_MS,
    signal: externalSignal = null,
    random = Math.random,
    now = Date.now,
    onChunkDone,
    onChunkError,
    onPauseTimeout
  } = options;

  const effectiveMaxConcurrency = Math.max(1, Math.floor(maxConcurrency) || DEFAULT_MAX_CONCURRENCY);
  const jitterMinMs = Math.max(0, Number(backgroundJitterRangeMs[0]) || 0);
  const jitterMaxMs = Math.max(jitterMinMs, Number(backgroundJitterRangeMs[1]) || jitterMinMs);

  const records = new Map<number, InternalChunkRecord<T>>();
  for (const item of options.chunks || []) {
    const initialStatus: SubtitleChunkStatus = item.status ?? "pending";
    records.set(item.index, {
      chunk: { ...item, status: initialStatus },
      status: initialStatus,
      revision: 0,
      rateLimitAttempts: 0,
      rateLimitUntil: 0,
      failCount: 0,
      cooldownUntil: 0
    });
  }

  let currentTimeSec = normalizeTimeSec(
    options.initialTimeSec ?? getCurrentTimeSec?.() ?? video?.currentTime ?? 0
  );
  let started = false;
  let stopped = false;
  let soloUnlocked = !firstScreenSolo;
  let inFlightCount = 0;
  let lastScanAt = -Infinity;
  let globalCooldownUntil = 0;
  let backgroundDispatchAllowed = false;

  let scanThrottleTimer: ReturnType<typeof setTimeout> | null = null;
  let backgroundJitterTimer: ReturnType<typeof setTimeout> | null = null;
  let globalCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  const rateLimitTimers = new Set<ReturnType<typeof setTimeout>>();

  const internalAbortController = new AbortController();
  const idleWaiters: Array<(result: SubtitleChunkSchedulerIdleResult) => void> = [];
  let videoBound = false;

  const onVideoSeeking = (): void => {
    if (video) {
      seek(video.currentTime);
    }
  };
  const onVideoTimeUpdate = (): void => {
    if (video) {
      updatePlaybackTime(video.currentTime);
    }
  };
  const onVideoPause = (): void => {
    notifyPause();
  };
  const onVideoPlay = (): void => {
    notifyPlay();
  };
  const onExternalAbort = (): void => {
    stop();
  };

  function clearAllTimers(): void {
    if (scanThrottleTimer !== null) {
      clearTimeout(scanThrottleTimer);
      scanThrottleTimer = null;
    }
    if (backgroundJitterTimer !== null) {
      clearTimeout(backgroundJitterTimer);
      backgroundJitterTimer = null;
    }
    if (globalCooldownTimer !== null) {
      clearTimeout(globalCooldownTimer);
      globalCooldownTimer = null;
    }
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    for (const timer of rateLimitTimers) {
      clearTimeout(timer);
    }
    rateLimitTimers.clear();
  }

  function bindVideoListeners(): void {
    if (!video || videoBound) {
      return;
    }
    videoBound = true;
    video.addEventListener("seeking", onVideoSeeking);
    video.addEventListener("timeupdate", onVideoTimeUpdate);
    video.addEventListener("pause", onVideoPause);
    video.addEventListener("play", onVideoPlay);
  }

  function unbindVideoListeners(): void {
    if (!video || !videoBound) {
      return;
    }
    videoBound = false;
    video.removeEventListener("seeking", onVideoSeeking);
    video.removeEventListener("timeupdate", onVideoTimeUpdate);
    video.removeEventListener("pause", onVideoPause);
    video.removeEventListener("play", onVideoPlay);
  }

  function buildIdleResult(): SubtitleChunkSchedulerIdleResult {
    let done = 0;
    let failed = 0;
    for (const record of records.values()) {
      if (record.status === "done") {
        done += 1;
      } else if (record.status === "failed") {
        failed += 1;
      }
    }
    return {
      total: records.size,
      done,
      failed,
      aborted: internalAbortController.signal.aborted
    };
  }

  function isRecordEligible(record: InternalChunkRecord<T>, currentNow: number): boolean {
    if (record.status === "running" || record.status === "done") {
      return false;
    }
    if (currentNow < record.rateLimitUntil) {
      return false;
    }
    if (record.status === "failed") {
      return failureCooldownMs > 0 && currentNow >= record.cooldownUntil;
    }
    return true;
  }

  function pickNextCandidate(includeBackground: boolean): PickedCandidate<T> | null {
    const currentNow = now();
    if (currentNow < globalCooldownUntil) {
      return null;
    }

    const windowRecords: InternalChunkRecord<T>[] = [];
    const backgroundRecords: InternalChunkRecord<T>[] = [];

    for (const record of records.values()) {
      if (!isRecordEligible(record, currentNow)) {
        continue;
      }
      if (intersectsPreloadWindow(record.chunk, currentTimeSec, preloadWindowSec)) {
        windowRecords.push(record);
      } else if (includeBackground) {
        backgroundRecords.push(record);
      }
    }

    if (windowRecords.length > 0) {
      windowRecords.sort((a, b) => {
        const aHit = containsPlaybackTime(a.chunk, currentTimeSec) ? 0 : 1;
        const bHit = containsPlaybackTime(b.chunk, currentTimeSec) ? 0 : 1;
        if (aHit !== bHit) {
          return aHit - bHit;
        }
        if (a.chunk.startSec !== b.chunk.startSec) {
          return a.chunk.startSec - b.chunk.startSec;
        }
        return a.chunk.index - b.chunk.index;
      });
      return { kind: "window", record: windowRecords[0] };
    }

    if (backgroundRecords.length > 0) {
      const windowEnd = currentTimeSec + Math.max(0, preloadWindowSec);
      backgroundRecords.sort((a, b) => {
        const aAfter = a.chunk.startSec >= windowEnd ? 0 : 1;
        const bAfter = b.chunk.startSec >= windowEnd ? 0 : 1;
        if (aAfter !== bAfter) {
          return aAfter - bAfter;
        }
        if (a.chunk.startSec !== b.chunk.startSec) {
          return a.chunk.startSec - b.chunk.startSec;
        }
        return a.chunk.index - b.chunk.index;
      });
      return { kind: "background", record: backgroundRecords[0] };
    }

    return null;
  }

  function isSchedulerIdle(): boolean {
    if (stopped || !started) {
      return true;
    }
    if (
      inFlightCount > 0 ||
      backgroundJitterTimer !== null ||
      globalCooldownTimer !== null ||
      rateLimitTimers.size > 0
    ) {
      return false;
    }
    return pickNextCandidate(fillBackground) === null;
  }

  function resolveIdleIfDone(): void {
    if (!isSchedulerIdle() || idleWaiters.length === 0) {
      return;
    }
    const result = buildIdleResult();
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const resolve of waiters) {
      resolve(result);
    }
  }

  function scheduleGlobalCooldownPump(): void {
    if (stopped || !started) {
      return;
    }
    const remaining = Math.max(0, globalCooldownUntil - now());
    if (globalCooldownTimer !== null) {
      clearTimeout(globalCooldownTimer);
      globalCooldownTimer = null;
    }
    globalCooldownTimer = setTimeout(() => {
      globalCooldownTimer = null;
      if (stopped || !started) {
        return;
      }
      if (now() < globalCooldownUntil) {
        scheduleGlobalCooldownPump();
        return;
      }
      pump();
    }, remaining);
  }

  function scheduleBackgroundJitter(): void {
    if (stopped || !started || backgroundJitterTimer !== null) {
      return;
    }
    const rawRandom = random();
    const clampedRandom = Number.isFinite(rawRandom) ? Math.min(1, Math.max(0, rawRandom)) : 0.5;
    const delayMs = Math.round(jitterMinMs + clampedRandom * (jitterMaxMs - jitterMinMs));
    if (delayMs <= 0) {
      backgroundDispatchAllowed = true;
      return;
    }
    backgroundJitterTimer = setTimeout(() => {
      backgroundJitterTimer = null;
      if (stopped || !started) {
        return;
      }
      backgroundDispatchAllowed = true;
      pump();
    }, delayMs);
  }

  function dispatchRecord(record: InternalChunkRecord<T>): void {
    const startRevision = record.revision;
    record.status = "running";
    record.chunk.status = "running";
    inFlightCount += 1;

    let runPromise: Promise<void>;
    try {
      runPromise = Promise.resolve(
        runChunk({ ...record.chunk, status: "running" }, internalAbortController.signal)
      );
    } catch (syncError) {
      runPromise = Promise.reject(syncError);
    }

    void runPromise
      .then(
        () => {
          inFlightCount = Math.max(0, inFlightCount - 1);
          soloUnlocked = true;
          if (stopped || internalAbortController.signal.aborted) {
            resolveIdleIfDone();
            return;
          }
          if (record.revision !== startRevision) {
            record.status = "pending";
            record.chunk.status = "pending";
            pump();
            return;
          }
          record.status = "done";
          record.chunk.status = "done";
          record.failCount = 0;
          record.cooldownUntil = 0;
          record.rateLimitAttempts = 0;
          record.rateLimitUntil = 0;
          onChunkDone?.({ ...record.chunk });
          pump();
        },
        (error: unknown) => {
          inFlightCount = Math.max(0, inFlightCount - 1);
          soloUnlocked = true;
          if (stopped || isAbortedError(error, internalAbortController.signal)) {
            if (record.status === "running") {
              record.status = "pending";
              record.chunk.status = "pending";
            }
            resolveIdleIfDone();
            return;
          }
          if (record.revision !== startRevision) {
            record.status = "pending";
            record.chunk.status = "pending";
            pump();
            return;
          }

          if (isRateLimitError(error) && record.rateLimitAttempts < maxRateLimitRetries) {
            record.rateLimitAttempts += 1;
            const backoffDelay = Math.min(
              rateLimitMaxDelayMs,
              rateLimitBaseDelayMs * Math.pow(2, record.rateLimitAttempts - 1)
            );
            const readyAt = now() + backoffDelay;
            record.status = "pending";
            record.chunk.status = "pending";
            record.rateLimitUntil = readyAt;
            globalCooldownUntil = Math.max(globalCooldownUntil, readyAt);
            scheduleGlobalCooldownPump();
            const timer = setTimeout(() => {
              rateLimitTimers.delete(timer);
              if (!stopped && started) {
                pump();
              }
            }, backoffDelay);
            rateLimitTimers.add(timer);
            return;
          }

          record.status = "failed";
          record.chunk.status = "failed";
          record.failCount += 1;
          record.cooldownUntil =
            failureCooldownMs > 0
              ? now() + failureCooldownMs * Math.pow(2, record.failCount - 1)
              : Infinity;
          onChunkError?.({ ...record.chunk }, error);
          pump();
        }
      );
  }

  function pump(): void {
    if (!started || stopped) {
      resolveIdleIfDone();
      return;
    }

    const concurrencyLimit = soloUnlocked ? effectiveMaxConcurrency : 1;

    while (inFlightCount < concurrencyLimit) {
      const candidate = pickNextCandidate(fillBackground);
      if (!candidate) {
        break;
      }

      if (candidate.kind === "window") {
        // 窗口内高优分块零抖动延迟立即启动，并取消任何挂起的后台抖动等待
        if (backgroundJitterTimer !== null) {
          clearTimeout(backgroundJitterTimer);
          backgroundJitterTimer = null;
        }
        backgroundDispatchAllowed = false;
        dispatchRecord(candidate.record);
        continue;
      }

      // 非窗口后台补齐分块：按 300ms–600ms 随机抖动退避逐片派发
      if (!backgroundDispatchAllowed) {
        scheduleBackgroundJitter();
        if (!backgroundDispatchAllowed) {
          break;
        }
      }
      backgroundDispatchAllowed = false;
      dispatchRecord(candidate.record);
    }

    resolveIdleIfDone();
  }

  function start(): void {
    if (stopped || started) {
      return;
    }
    if (externalSignal?.aborted) {
      stop();
      return;
    }
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (getCurrentTimeSec) {
      currentTimeSec = normalizeTimeSec(getCurrentTimeSec());
    } else if (video) {
      currentTimeSec = normalizeTimeSec(video.currentTime);
    }
    started = true;
    lastScanAt = now();
    bindVideoListeners();
    if (video?.paused) {
      notifyPause();
    }
    pump();
  }

  function stop(): void {
    if (stopped) {
      return;
    }
    stopped = true;
    externalSignal?.removeEventListener("abort", onExternalAbort);
    unbindVideoListeners();
    clearAllTimers();
    if (!internalAbortController.signal.aborted) {
      internalAbortController.abort();
    }
    resolveIdleIfDone();
  }

  function seek(timeSec: number): void {
    currentTimeSec = normalizeTimeSec(timeSec);
    if (!started || stopped) {
      return;
    }
    soloUnlocked = true;
    lastScanAt = now();
    if (scanThrottleTimer !== null) {
      clearTimeout(scanThrottleTimer);
      scanThrottleTimer = null;
    }
    if (backgroundJitterTimer !== null) {
      clearTimeout(backgroundJitterTimer);
      backgroundJitterTimer = null;
    }
    backgroundDispatchAllowed = false;
    pump();
  }

  function updatePlaybackTime(timeSec: number): void {
    currentTimeSec = normalizeTimeSec(timeSec);
    if (!started || stopped) {
      return;
    }
    const currentNow = now();
    const elapsed = currentNow - lastScanAt;
    if (scanThrottleMs <= 0 || elapsed >= scanThrottleMs) {
      if (scanThrottleTimer !== null) {
        clearTimeout(scanThrottleTimer);
        scanThrottleTimer = null;
      }
      lastScanAt = currentNow;
      pump();
      return;
    }
    if (scanThrottleTimer === null) {
      const remaining = Math.max(0, scanThrottleMs - elapsed);
      scanThrottleTimer = setTimeout(() => {
        scanThrottleTimer = null;
        if (!started || stopped) {
          return;
        }
        lastScanAt = now();
        pump();
      }, remaining);
    }
  }

  function notifyPause(): void {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
    if (!started || stopped || pauseTimeoutMs <= 0) {
      return;
    }
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (!started || stopped) {
        return;
      }
      stop();
      onPauseTimeout?.();
    }, pauseTimeoutMs);
  }

  function notifyPlay(): void {
    if (pauseTimer !== null) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }
  }

  function upsertChunk(
    chunk: SubtitleSchedulableChunk<T>,
    upsertOptions: { resetStatus?: boolean } = {}
  ): void {
    const resetStatus = upsertOptions.resetStatus ?? true;
    const existing = records.get(chunk.index);
    if (!existing) {
      const initialStatus: SubtitleChunkStatus = chunk.status ?? "pending";
      records.set(chunk.index, {
        chunk: { ...chunk, status: initialStatus },
        status: initialStatus,
        revision: 0,
        rateLimitAttempts: 0,
        rateLimitUntil: 0,
        failCount: 0,
        cooldownUntil: 0
      });
    } else {
      existing.chunk = { ...chunk, status: existing.status };
      if (resetStatus) {
        existing.revision += 1;
        existing.rateLimitAttempts = 0;
        existing.rateLimitUntil = 0;
        existing.failCount = 0;
        existing.cooldownUntil = 0;
        if (existing.status !== "running") {
          const nextStatus: SubtitleChunkStatus = chunk.status ?? "pending";
          existing.status = nextStatus;
          existing.chunk.status = nextStatus;
        }
      }
    }

    if (started && !stopped) {
      pump();
    }
  }

  function getChunkStatus(index: number): SubtitleChunkStatus | undefined {
    return records.get(index)?.status;
  }

  function getSnapshot(): SubtitleChunkSchedulerSnapshot {
    let done = 0;
    let failed = 0;
    for (const record of records.values()) {
      if (record.status === "done") {
        done += 1;
      } else if (record.status === "failed") {
        failed += 1;
      }
    }
    return {
      currentTimeSec,
      started,
      stopped,
      inFlight: inFlightCount,
      total: records.size,
      done,
      failed
    };
  }

  function waitForIdle(): Promise<SubtitleChunkSchedulerIdleResult> {
    if (isSchedulerIdle()) {
      return Promise.resolve(buildIdleResult());
    }
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  return {
    start,
    stop,
    seek,
    updatePlaybackTime,
    notifyPause,
    notifyPlay,
    upsertChunk,
    getChunkStatus,
    getSnapshot,
    waitForIdle
  };
}
