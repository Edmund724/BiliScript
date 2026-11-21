import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CreateSubtitleWaiterDeps } from "../../extension/chat/subtitle-wait.js";
import { createSubtitleWaiter } from "../../extension/chat/subtitle-wait.js";

const POLL_MS = 4000;

interface PollOutcome {
  ok: boolean;
  pending: boolean;
}

type PollStep = PollOutcome | (() => PollOutcome | Promise<PollOutcome>);

interface TimerHandle {
  id: number;
  fn: () => void;
  ms: number;
  cleared: boolean;
}

function makeHarness(
  pollResults: PollStep[],
  { pollIntervalMs = POLL_MS }: { pollIntervalMs?: number } = {}
) {
  const timers: TimerHandle[] = [];
  let timerSeq = 0;
  let pollIndex = 0;
  const deps = {
    pollIntervalMs,
    pollContext: vi.fn(async () => {
      const item = pollResults[Math.min(pollIndex, pollResults.length - 1)];
      pollIndex += 1;
      return typeof item === "function" ? await item() : item;
    }),
    showWaitingNotice: vi.fn(),
    removeNotice: vi.fn(),
    setTimer: vi.fn((fn: () => void, ms: number) => {
      const handle = { id: ++timerSeq, fn, ms, cleared: false };
      timers.push(handle);
      return handle;
    }),
    clearTimer: vi.fn((handle: TimerHandle) => {
      handle.cleared = true;
      const index = timers.indexOf(handle);
      if (index >= 0) {
        timers.splice(index, 1);
      }
    })
  };
  const waiter = createSubtitleWaiter(deps as unknown as CreateSubtitleWaiterDeps);
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fireNextTimer = async () => {
    const timer = timers.shift();
    if (!timer) {
      throw new Error("no pending timer");
    }
    timer.fn();
    await flush();
  };
  return { deps, waiter, timers, flush, fireNextTimer };
}

const READY = { ok: true, pending: false };
const PENDING = { ok: true, pending: true };
const FAILED = { ok: false, pending: false };

describe("createSubtitleWaiter", () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness([READY]);
  });

  it("首次轮询即就绪：resolve true，不显示等待提示，不留定时器", async () => {
    const result = await harness.waiter.wait();

    expect(result).toBe(true);
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);
    expect(harness.deps.showWaitingNotice).not.toHaveBeenCalled();
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("pending 期间显示提示并按间隔轮询，就绪后 resolve true 并清理提示", async () => {
    harness = makeHarness([PENDING, PENDING, READY]);
    const promise = harness.waiter.wait();
    await harness.flush();

    expect(harness.deps.showWaitingNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(1);
    expect(harness.timers[0].ms).toBe(POLL_MS);

    await harness.fireNextTimer();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(2);
    expect(harness.deps.showWaitingNotice).toHaveBeenCalledTimes(2);

    await harness.fireNextTimer();
    expect(await promise).toBe(true);
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("轮询读取失败：resolve false", async () => {
    harness = makeHarness([FAILED]);

    expect(await harness.waiter.wait()).toBe(false);
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);
  });

  it("pending 期间 kick()：立即补一轮轮询，不等定时器", async () => {
    harness = makeHarness([PENDING, READY]);
    const promise = harness.waiter.wait();
    await harness.flush();

    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);
    harness.waiter.kick();
    await harness.flush();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(2);

    expect(await promise).toBe(true);
  });

  it("tick 进行中重复 kick()：去重，不并发多轮轮询", async () => {
    let releasePoll!: (value: PollOutcome) => void;
    harness = makeHarness([
      () => new Promise((resolve) => {
        releasePoll = resolve;
      }),
      READY
    ]);
    const promise = harness.waiter.wait();
    await harness.flush();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);

    harness.waiter.kick();
    harness.waiter.kick();
    harness.waiter.kick();
    await harness.flush();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);

    releasePoll(PENDING);
    await harness.flush();
    await harness.fireNextTimer();
    expect(await promise).toBe(true);
  });

  it("cancel() 立即终止在飞等待，迟到轮询不得重新挂起定时器", async () => {
    let releasePoll!: (value: PollOutcome) => void;
    harness = makeHarness([
      () => new Promise((resolve) => {
        releasePoll = resolve;
      }),
      READY
    ]);
    const promise = harness.waiter.wait();
    await harness.flush();
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);

    harness.waiter.cancel();

    await expect(promise).resolves.toBe(false);
    expect(harness.deps.removeNotice).toHaveBeenCalledTimes(1);
    expect(harness.timers).toHaveLength(0);

    releasePoll(PENDING);
    await harness.flush();
    expect(harness.timers).toHaveLength(0);
    expect(harness.deps.pollContext).toHaveBeenCalledTimes(1);
  });

  it("新 wait() 使旧等待立即失效（resolve false），旧定时器作废", async () => {
    harness = makeHarness([PENDING, READY]);
    const first = harness.waiter.wait();
    await harness.flush();
    expect(harness.timers).toHaveLength(1);

    const second = harness.waiter.wait();
    expect(await first).toBe(false);
    expect(harness.timers).toHaveLength(0);

    expect(await second).toBe(true);
  });

  it("finish 后挂着的定时器不触发（不再轮询）", async () => {
    harness = makeHarness([READY]);
    await harness.waiter.wait();
    expect(harness.timers).toHaveLength(0);

    const pollsBefore = harness.deps.pollContext.mock.calls.length;
    harness.waiter.kick();
    expect(harness.deps.pollContext.mock.calls.length).toBe(pollsBefore);
  });
});
