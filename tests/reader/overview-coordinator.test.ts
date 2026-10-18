// 概览协调器工厂（createOverviewCoordinator(deps)）注入直测。
//
// 手法（对齐 subtitle-search-factory 直驱套路）：不 mock 任何模块、不用 fake timers——
// clip 读取、readingViewOpen 闸门、provider 解析、analysis 管线、confirm、
// UI 动作注册、now/interval 全部经 deps 注入（vi.fn/局部假钟直驱）。
// 呈现层走真实 overview-ui，闸门默认关（isReadingViewOpen: () => false），DOM 用例显式开闸并挂宿主。
//
// 覆盖：
//   1. 相位迁移：idle→generating→ready / partial / error / empty；
//   2. 去重：同 key inflight 复用、换 key 旧回执按纪元校验丢弃；
//   3. cancel 矩阵：cancelRequested + aborted 上浮为 cancelled、无取消的 aborted
//      回落 idle、cancelled 短路表、forceRefresh 绕过；
//   4. ticker：假 now + 捕获 interval 回调直驱「等满 10 秒出提示」「有进度不叠加」
//      「非 generating 自停」；
//   5. ADR-0010 DOM 节点同一性：等待计时只改状态条文案节点，不重建整块 DOM；
//   6. reset 不取消在飞、回执不写入新会话。

import { describe, expect, it, vi, type Mock } from "vitest";
import type { OverviewAnalysis } from "../../extension/ai/analysis.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import type { AiProvider } from "../../extension/ai/types.js";
import { ids } from "../../extension/reader/state.js";
import {
  createOverviewCoordinator,
  type CreateOverviewCoordinatorDeps,
  type ReaderOverviewCoordinator
} from "../../extension/reader/overview-coordinator.js";

const BODY: SubtitleBodyItem[] = [
  { from: 0, to: 10, content: "大家好" },
  { from: 10, to: 300, content: "今天讲测试" }
];

const SAMPLE_ANALYSIS: OverviewAnalysis = {
  chapters: [
    { from: 0, to: 120, title: "开场", summary: "为什么测试难写" },
    { from: 120, to: 300, title: "误区一", summary: " mocking 一切" }
  ],
  quotes: [{ from: 125, content: "测试不是目的，而是反馈。" }]
};

const PROVIDER = {
  id: "prov-1",
  presetId: "custom",
  name: "测试平台",
  baseUrl: "https://api.test/v1",
  model: "test-model",
  enabled: true,
  hasSavedKey: true
} as unknown as AiProvider;

interface RunArgs {
  provider?: unknown;
  context?: Record<string, unknown>;
  forceRefresh?: boolean;
  thinkingLevel?: string;
  signal?: AbortSignal;
}

interface RunHandlers {
  onProgress?: (notice: string) => void;
  askCostGuard?: (message: string) => Promise<boolean>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function abortedMarkerError(): Error {
  return Object.assign(new Error("请求已中止"), { aborted: true });
}

interface Harness {
  clip: ReturnType<typeof seedClip>;
  coordinator: ReaderOverviewCoordinator;
  deps: CreateOverviewCoordinatorDeps;
  runOverviewAnalysis: Mock;
  confirm: Mock;
  registerUiActions: Mock;
  intervals: Map<number, () => void>;
  advance(ms: number): void;
  fireTick(): void;
  setReadingViewOpen(open: boolean): void;
}

function seedClip() {
  return {
    bvid: "BV1test000000",
    cid: "1000",
    aid: "",
    title: "测试视频",
    author: "作者",
    description: "视频简介",
    hotComments: [],
    videoDuration: 300,
    selectedSubtitleLang: "中文（自动）",
    selectedSubtitleId: "sub-1",
    selectedSubtitleUrl: "https://subtitle.test/1",
    subtitleBody: [...BODY],
    chapters: [] as unknown[]
  };
}

function makeHarness(): Harness {
  const clip = seedClip();
  const runOverviewAnalysis = vi.fn();
  const confirm = vi.fn(async () => true);
  const registerUiActions = vi.fn();
  const intervals = new Map<number, () => void>();
  let readingViewOpen = false;
  let now = 0;
  let nextIntervalId = 1;
  const deps: CreateOverviewCoordinatorDeps = {
    getClip: () => clip,
    // 闸门默认关：直驱相位机，不触达 DOM；DOM 用例显式开闸并挂宿主
    isReadingViewOpen: () => readingViewOpen,
    resolveProvider: async () => PROVIDER,
    loadAnalysis: async () =>
      ({ runOverviewAnalysis }) as unknown as Promise<typeof import("../../extension/ai/analysis.js")>,
    confirm,
    registerUiActions,
    now: () => now,
    setInterval: ((cb: () => void) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, cb);
      return id;
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      intervals.delete(id);
    }) as unknown as typeof clearInterval
  };
  const coordinator = createOverviewCoordinator(deps);
  return {
    clip,
    coordinator,
    deps,
    runOverviewAnalysis,
    confirm,
    registerUiActions,
    intervals,
    advance: (ms) => {
      now += ms;
    },
    fireTick: () => {
      const cb = [...intervals.values()].at(-1);
      cb?.();
    },
    setReadingViewOpen: (open: boolean) => {
      readingViewOpen = open;
    }
  };
}

// 挂起的管线：让 runOverviewAnalysis 可控推挤（resolve/reject 由用例持有）
function pendingRun(h: Harness): { resolve: (v: OverviewAnalysis) => void; reject: (e: unknown) => void } {
  const d = deferred<OverviewAnalysis>();
  h.runOverviewAnalysis.mockImplementation(() => d.promise);
  return d;
}

// 等管线真正发起（loadAnalysis + resolveProvider 各一趟微任务）
async function waitForRunStarted(h: Harness, times = 1): Promise<void> {
  await vi.waitFor(() => expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(times));
}

describe("相位迁移", () => {
  it("idle 触发 → generating → ready：产物入槽、相位与快照同步", async () => {
    const h = makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);

    const run = h.coordinator.trigger();
    expect(h.coordinator.getPhase()).toBe("generating");
    expect(h.coordinator.getSnapshot().phase).toBe("generating");

    await run;
    expect(h.coordinator.getPhase()).toBe("ready");
    const snapshot = h.coordinator.getSnapshot();
    expect(snapshot.analysis?.chapters.length).toBe(2);
    expect(snapshot.progressText).toBe("");
    expect(snapshot.errorText).toBe("");

    // 入参口径：provider / 上下文 / 思考档位钉死 off
    const args = h.runOverviewAnalysis.mock.calls[0][0] as RunArgs;
    expect(args.provider).toBe(PROVIDER);
    expect(args.thinkingLevel).toBe("off");
    expect(args.forceRefresh).toBe(false);
    expect(args.signal).toBeInstanceOf(AbortSignal);
    expect(args.context?.bvid).toBe("BV1test000000");
  });

  it("failedRanges 非空 → partial", async () => {
    const h = makeHarness();
    h.runOverviewAnalysis.mockResolvedValue({ ...SAMPLE_ANALYSIS, failedRanges: [{ from: 120, to: 300 }] });

    await h.coordinator.trigger();

    expect(h.coordinator.getPhase()).toBe("partial");
    expect(h.coordinator.getSnapshot().analysis?.chapters.length).toBe(2);
  });

  it("管线拒绝 → error：错误文本带默认前缀与原因", async () => {
    const h = makeHarness();
    h.runOverviewAnalysis.mockRejectedValue(new Error("模型请求失败"));

    await h.coordinator.trigger();

    expect(h.coordinator.getPhase()).toBe("error");
    const snapshot = h.coordinator.getSnapshot();
    // 快照存原始错误文本；「概览生成失败」前缀由呈现层拼接（overview.test.ts 集成网断言）
    expect(snapshot.errorText).toBe("模型请求失败");
  });

  it("无字幕 → empty（不触发生成）；字幕到场 → empty 退场回 idle", async () => {
    const h = makeHarness();
    h.clip.subtitleBody = [];

    await h.coordinator.trigger();

    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
    expect(h.coordinator.getPhase()).toBe("empty");

    h.clip.subtitleBody = [...BODY];
    expect(h.coordinator.getPhase()).toBe("idle");
  });
});

describe("去重与纪元校验", () => {
  it("同 key inflight 复用：第二次 trigger 返回同一 promise，管线只发起一次", async () => {
    const h = makeHarness();
    const d = pendingRun(h);

    const first = h.coordinator.trigger();
    await waitForRunStarted(h);
    const second = h.coordinator.trigger();

    expect(second).toBe(first);
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);

    d.resolve(SAMPLE_ANALYSIS);
    await first;
    expect(h.coordinator.getPhase()).toBe("ready");

    // ready 态再触发：短路表拦截，不重跑
    await h.coordinator.trigger();
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it("换 key 触发新编排：旧回执按纪元校验丢弃，不串片", async () => {
    const h = makeHarness();
    const oldRun = pendingRun(h);

    const first = h.coordinator.trigger();
    await waitForRunStarted(h);

    // 切片：新 key 换血重跑
    h.clip.bvid = "BV1newvideo000";
    h.clip.cid = "2000";
    const newRun = pendingRun(h);
    const second = h.coordinator.trigger();
    expect(second).not.toBe(first);
    await waitForRunStarted(h);

    // 旧编排落定：inflightAbort 已换代 + generatedFor 已换 key → 旧产物按过期丢弃
    oldRun.resolve({
      chapters: [{ from: 0, to: 120, title: "旧视频章节", summary: "" }],
      quotes: []
    });
    await first;
    expect(h.coordinator.getPhase()).toBe("generating");
    expect(h.coordinator.getSnapshot().analysis).toBeNull();

    // 新编排落定：正常入槽
    newRun.resolve({
      chapters: [{ from: 0, to: 120, title: "新视频章节", summary: "" }],
      quotes: []
    });
    await second;
    expect(h.coordinator.getPhase()).toBe("ready");
    expect(h.coordinator.getSnapshot().analysis?.chapters[0]?.title).toBe("新视频章节");
  });
});

describe("cancel 矩阵", () => {
  it("生成中 cancel：中止信号、相位转 cancelled；aborted 上浮后停在 cancelled", async () => {
    const h = makeHarness();
    const d = pendingRun(h);

    const run = h.coordinator.trigger();
    await waitForRunStarted(h);
    const signal = (h.runOverviewAnalysis.mock.calls[0][0] as RunArgs).signal;

    h.coordinator.cancel();
    expect(signal?.aborted).toBe(true);
    expect(h.coordinator.getPhase()).toBe("cancelled");

    // 管线以 aborted 上浮：cancelRequested 为真 → 维持 cancelled，不回落 idle
    d.reject(abortedMarkerError());
    await run;
    expect(h.coordinator.getPhase()).toBe("cancelled");
  });

  it("无取消的 aborted 上浮：回落 idle（不自动重跑的安全空态）", async () => {
    const h = makeHarness();
    const d = pendingRun(h);

    const run = h.coordinator.trigger();
    await waitForRunStarted(h);

    d.reject(abortedMarkerError());
    await run;
    expect(h.coordinator.getPhase()).toBe("idle");
  });

  it("cancelled 进短路表：再触发不重跑；forceRefresh 绕过换新信号", async () => {
    const h = makeHarness();
    const d = pendingRun(h);

    const run = h.coordinator.trigger();
    await waitForRunStarted(h);
    const firstSignal = (h.runOverviewAnalysis.mock.calls[0][0] as RunArgs).signal;
    h.coordinator.cancel();
    d.reject(abortedMarkerError());
    await run;

    // cancelled 态普通触发：短路
    await h.coordinator.trigger();
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);

    // forceRefresh 绕过短路：已中止的 controller 不复用，新信号未中止
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    await h.coordinator.trigger({ forceRefresh: true });
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(2);
    const args = h.runOverviewAnalysis.mock.calls[1][0] as RunArgs;
    expect(args.forceRefresh).toBe(true);
    expect(args.signal).not.toBe(firstSignal);
    expect(args.signal?.aborted).toBe(false);
    expect(h.coordinator.getPhase()).toBe("ready");
  });

  it("装配即注册 UI 动作：cancel 直通取消、retry 以 forceRefresh 重跑", async () => {
    const h = makeHarness();
    expect(h.registerUiActions).toHaveBeenCalledTimes(1);
    const actions = h.registerUiActions.mock.calls[0][0] as {
      retry: () => void;
      cancel: () => void;
    };
    const d = pendingRun(h);

    void h.coordinator.trigger();
    await waitForRunStarted(h);

    actions.cancel();
    expect(h.coordinator.getPhase()).toBe("cancelled");
    d.reject(abortedMarkerError());
    await Promise.resolve();
    await Promise.resolve();

    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    actions.retry();
    await waitForRunStarted(h, 2);
    expect((h.runOverviewAnalysis.mock.calls[1][0] as RunArgs).forceRefresh).toBe(true);
    expect(h.coordinator.getPhase()).toBe("ready");
  });
});

describe("wait ticker（假 now + 捕获 interval 回调）", () => {
  it("首字节未至：等满 10 秒状态条给出等待计时", async () => {
    const h = makeHarness();
    pendingRun(h);

    void h.coordinator.trigger();
    await waitForRunStarted(h);
    expect(h.intervals.size).toBe(1);

    // 阈值内：无等待文案
    h.advance(9_000);
    h.fireTick();
    expect(h.coordinator.getSnapshot().stripText).toBe("");

    // 跨过阈值：就地给出等待计时
    h.advance(2_000);
    h.fireTick();
    expect(h.coordinator.getSnapshot().stripText).toBe("正在等待平台响应…（已等待 11 秒）");
  });

  it("已有进度时不叠加等待计时（管线文案优先）", async () => {
    const h = makeHarness();
    let notify!: (notice: string) => void;
    h.runOverviewAnalysis.mockImplementation((_args: RunArgs, handlers: RunHandlers) => {
      notify = (notice) => handlers.onProgress?.(notice);
      return new Promise<OverviewAnalysis>(() => {});
    });

    void h.coordinator.trigger();
    await waitForRunStarted(h);
    notify("正在生成概览…（已接收 1195 字）");

    h.advance(11_000);
    h.fireTick();
    const stripText = h.coordinator.getSnapshot().stripText;
    expect(stripText).toContain("已接收 1195 字");
    expect(stripText).not.toContain("正在等待平台响应");
  });

  it("非 generating 相位 tick 自停并清 interval", async () => {
    const h = makeHarness();
    const d = pendingRun(h);

    void h.coordinator.trigger();
    await waitForRunStarted(h);
    expect(h.intervals.size).toBe(1);

    d.resolve(SAMPLE_ANALYSIS);
    await vi.waitFor(() => expect(h.coordinator.getPhase()).toBe("ready"));
    // 落定清理：编排收尾即停 ticker
    expect(h.intervals.size).toBe(0);

    // 即便回调再来（迟到 tick）：相位非 generating → 自停，不再写状态
    h.fireTick();
    expect(h.intervals.size).toBe(0);
    expect(h.coordinator.getSnapshot().stripText).toBe("");
  });

  it("等待计时只改状态条文案节点，不重建整块 DOM（ADR-0010）", async () => {
    const h = makeHarness();
    h.setReadingViewOpen(true);
    document.body.innerHTML = `<div id="${ids.readingOverviewBody}"></div>`;
    try {
      pendingRun(h);
      void h.coordinator.trigger();
      await waitForRunStarted(h);

      const stripText = document.querySelector<HTMLElement>(".biliscript-reading-ov-strip-text");
      const cancelBtn = document.querySelector<HTMLElement>("button[data-overview-action='cancel']");
      expect(stripText?.textContent).toBe("正在生成概览…");
      expect(cancelBtn).not.toBeNull();

      // 跨过等待阈值：tick 每秒就地刷新那句文案
      h.advance(11_000);
      h.fireTick();

      // 同一性不变：状态条与其取消键都是原来的节点（整块重建会丢滚动位置与选区）
      expect(document.querySelector(".biliscript-reading-ov-strip-text")).toBe(stripText);
      expect(document.querySelector("button[data-overview-action='cancel']")).toBe(cancelBtn);
      expect(stripText?.textContent).toContain("正在等待平台响应…（已等待 11 秒）");
    } finally {
      document.body.innerHTML = "";
    }
  });
});

describe("reset 会话收尾", () => {
  it("reset 不取消在飞请求；落定回执不写入新会话", async () => {
    const h = makeHarness();
    const d = pendingRun(h);

    const run = h.coordinator.trigger();
    await waitForRunStarted(h);
    const signal = (h.runOverviewAnalysis.mock.calls[0][0] as RunArgs).signal;

    h.coordinator.reset();
    expect(h.coordinator.getPhase()).toBe("idle");
    expect(signal?.aborted).toBe(false);

    // 后台落定：generatedFor 已清 → 回执按过期丢弃
    d.resolve(SAMPLE_ANALYSIS);
    await run;
    expect(h.coordinator.getPhase()).toBe("idle");
    expect(h.coordinator.getSnapshot().analysis).toBeNull();
    expect(h.intervals.size).toBe(0);
  });
});
