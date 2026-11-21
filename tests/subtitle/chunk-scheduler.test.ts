import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubtitleChunkScheduler,
  PAUSE_TIMEOUT_MS,
  type SubtitleSchedulableChunk
} from "../../extension/subtitle/chunk-scheduler.js";

interface DeferredGate {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function createDeferredGate(): DeferredGate {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createTenChunks(): SubtitleSchedulableChunk<string>[] {
  return Array.from({ length: 10 }, (_, index) => ({
    index,
    startSec: index * 60,
    endSec: (index + 1) * 60,
    payload: `chunk-${index}`
  }));
}

function createGateMap(count: number): Map<number, DeferredGate> {
  return new Map(Array.from({ length: count }, (_, idx) => [idx, createDeferredGate()]));
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function createRateLimitFlakyRunner(
  failCount: number,
  recordedSignals: AbortSignal[],
  onAttempt: (attempts: number) => void
): (chunk: SubtitleSchedulableChunk<string>, signal: AbortSignal) => Promise<void> {
  let chunk0Attempts = 0;
  return async (chunk, signal) => {
    recordedSignals.push(signal);
    if (chunk.index !== 0) {
      return;
    }
    chunk0Attempts += 1;
    onAttempt(chunk0Attempts);
    if (chunk0Attempts <= failCount) {
      throw Object.assign(new Error("HTTP 429: Too Many Requests"), { status: 429 });
    }
  };
}

describe("createSubtitleChunkScheduler：90s 播放游标优先与并发懒调度", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("共 10 个分块，起播处理块 0 时用户 seek 到第 7 块对应时间，立即插队块 7 与块 8 而非块 1", async () => {
    const chunks = createTenChunks();
    const gates = createGateMap(10);
    const scheduledOrder: number[] = [];

    const scheduler = createSubtitleChunkScheduler({
      chunks,
      initialTimeSec: 0,
      preloadWindowSec: 90,
      maxConcurrency: 2,
      firstScreenSolo: true,
      fillBackground: false,
      runChunk: async (chunk) => {
        scheduledOrder.push(chunk.index);
        await gates.get(chunk.index)!.promise;
      }
    });

    scheduler.start();
    expect(scheduledOrder).toEqual([0]);
    expect(scheduler.getChunkStatus(1)).toBe("pending");

    scheduler.seek(425);
    expect(scheduledOrder).toEqual([0, 7]);
    expect(scheduler.getChunkStatus(1)).toBe("pending");

    gates.get(0)!.resolve();
    await flushMicrotasks();
    expect(scheduledOrder).toEqual([0, 7, 8]);
    expect(scheduler.getChunkStatus(1)).toBe("pending");

    gates.get(7)!.resolve();
    gates.get(8)!.resolve();
    const idleResult = await scheduler.waitForIdle();
    expect(idleResult).toEqual({ total: 10, done: 3, failed: 0, aborted: false });
    expect(scheduledOrder).toEqual([0, 7, 8]);
  });

  it("timeupdate 扫描受节流保护，后台补齐非窗口块施加 300–600ms 抖动退避且可被新窗口打断", async () => {
    const chunks = createTenChunks().slice(0, 4);
    const gates = createGateMap(4);
    const scheduledOrder: number[] = [];
    const getCurrentTimeSec = vi.fn(() => 0);

    const scheduler = createSubtitleChunkScheduler({
      chunks,
      initialTimeSec: 0,
      getCurrentTimeSec,
      preloadWindowSec: 90,
      maxConcurrency: 2,
      firstScreenSolo: true,
      fillBackground: true,
      scanThrottleMs: 500,
      backgroundJitterRangeMs: [300, 600],
      random: () => 0.5,
      runChunk: async (chunk) => {
        scheduledOrder.push(chunk.index);
        await gates.get(chunk.index)!.promise;
      }
    });

    scheduler.start();
    expect(scheduledOrder).toEqual([0]);

    gates.get(0)!.resolve();
    await flushMicrotasks();
    expect(scheduledOrder).toEqual([0, 1]);

    gates.get(1)!.resolve();
    await flushMicrotasks();
    expect(scheduledOrder).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(100);
    scheduler.updatePlaybackTime(5);
    scheduler.updatePlaybackTime(10);
    await vi.advanceTimersByTimeAsync(340);
    expect(scheduledOrder).toEqual([0, 1]);

    await vi.advanceTimersByTimeAsync(10);
    expect(scheduledOrder).toEqual([0, 1, 2]);

    scheduler.seek(185);
    expect(scheduledOrder).toEqual([0, 1, 2, 3]);

    gates.get(2)!.resolve();
    gates.get(3)!.resolve();
    await scheduler.waitForIdle();
  });

  it("429 速率限制触发指数退避冷却重试，暂停 5 分钟自动停止，AbortSignal 立即取消", async () => {
    const chunks = createTenChunks().slice(0, 2);
    let latestChunk0Attempt = 0;

    const abortController = new AbortController();
    const onPauseTimeout = vi.fn();
    const runSignals: AbortSignal[] = [];

    const scheduler = createSubtitleChunkScheduler({
      chunks,
      initialTimeSec: 0,
      preloadWindowSec: 90,
      maxConcurrency: 2,
      firstScreenSolo: true,
      fillBackground: false,
      maxRateLimitRetries: 2,
      rateLimitBaseDelayMs: 1000,
      pauseTimeoutMs: PAUSE_TIMEOUT_MS,
      signal: abortController.signal,
      onPauseTimeout,
      runChunk: createRateLimitFlakyRunner(2, runSignals, (attempts) => {
        latestChunk0Attempt = attempts;
      })
    });

    scheduler.start();
    await flushMicrotasks();
    expect(latestChunk0Attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(latestChunk0Attempt).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(latestChunk0Attempt).toBe(2);

    await vi.advanceTimersByTimeAsync(1999);
    expect(latestChunk0Attempt).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(latestChunk0Attempt).toBe(3);

    const idle = await scheduler.waitForIdle();
    expect(idle).toEqual({ total: 2, done: 2, failed: 0, aborted: false });

    scheduler.notifyPause();
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS - 1000);
    expect(onPauseTimeout).not.toHaveBeenCalled();

    scheduler.notifyPlay();
    scheduler.notifyPause();
    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS - 1000);
    expect(onPauseTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(onPauseTimeout).toHaveBeenCalledTimes(1);
    expect(scheduler.getSnapshot().stopped).toBe(true);
    expect(runSignals[0].aborted).toBe(true);
  });

  it("外部 AbortSignal 中止立即拒绝后续调度并标记 aborted", async () => {
    const chunks = createTenChunks().slice(0, 2);
    const gate = createDeferredGate();
    const abortController = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    const scheduler = createSubtitleChunkScheduler({
      chunks,
      signal: abortController.signal,
      runChunk: async (_chunk, signal) => {
        capturedSignal = signal;
        await gate.promise;
      }
    });

    scheduler.start();
    expect(capturedSignal?.aborted).toBe(false);

    abortController.abort();
    expect(capturedSignal?.aborted).toBe(true);
    const idle = await scheduler.waitForIdle();
    expect(idle.aborted).toBe(true);
    expect(scheduler.getSnapshot().stopped).toBe(true);
  });
});
