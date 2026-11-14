// 票 provider-onboarding-consistency/01 的协调器与呈现层契约：
// 概览配置类错误「去设置」记录首配续跑意图；首配保存成功后在同一视频续跑一次；
// 取消 / 换视频 / 任务代次变化 / 已消费均不续跑。
//
// 手法（对齐 overview-coordinator.test.ts 注入直驱 + overview.test.ts 骨架）：
//   - 协调器依赖全注入；setupResume 接真实意图叶（reader/overview-setup-resume），
//     registerUiActions 接真实 registerOverviewUiActions，点击分派走真实
//     onReadingOverviewClick；
//   - DOM 用例开阅读视图闸门 + mountReaderSkeleton 挂概览宿主；
//   - 管线 runOverviewAnalysis 用 vi.fn，provider 解析默认通过、错误用例自改。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { OverviewAnalysis } from "../../extension/ai/analysis.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import type { AiProvider } from "../../extension/ai/types.js";
import type { OverviewUiActions } from "../../extension/reader/overview-ui.js";
import {
  MISSING_PROVIDER_KEY_MESSAGE,
  NO_ACTIVE_MODEL_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE
} from "../../extension/core/overview-setup-error.js";

const BODY: SubtitleBodyItem[] = [
  { from: 0, to: 10, content: "大家好" },
  { from: 10, to: 300, content: "今天讲测试" }
];

const SAMPLE_ANALYSIS: OverviewAnalysis = {
  summary: "全片简介。",
  chapters: [{ from: 0, to: 120, title: "开场", summary: "为什么测试难写" }],
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

interface HarnessModules {
  ids: typeof import("../../extension/reader/state.js").ids;
  overviewUi: typeof import("../../extension/reader/overview-ui.js");
  coordinatorMod: typeof import("../../extension/reader/overview-coordinator.js");
  leaf: typeof import("../../extension/reader/overview-setup-resume.js");
  state: typeof import("../../extension/core/state.js");
}

interface Harness {
  modules: HarnessModules;
  clip: ReturnType<typeof seedClip>;
  coordinator: import("../../extension/reader/overview-coordinator.js").ReaderOverviewCoordinator;
  actions: OverviewUiActions;
  runOverviewAnalysis: Mock;
  resolveProvider: Mock;
  begin: Mock;
  openTranscribeSettings: Mock;
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

async function loadModules(): Promise<HarnessModules> {
  const [stateMod, readerState, overviewUi, coordinatorMod, leaf] = await Promise.all([
    import("../../extension/core/state.js"),
    import("../../extension/reader/state.js"),
    import("../../extension/reader/overview-ui.js"),
    import("../../extension/reader/overview-coordinator.js"),
    import("../../extension/reader/overview-setup-resume.js")
  ]);
  return { ids: readerState.ids, overviewUi, coordinatorMod, leaf, state: stateMod };
}

async function makeHarness(options: { withSetupResume?: boolean } = {}): Promise<Harness> {
  const modules = await loadModules();
  const clip = seedClip();
  const runOverviewAnalysis = vi.fn();
  const resolveProvider = vi.fn(async () => PROVIDER);
  const begin = vi.fn((intent) => modules.leaf.setOverviewSetupResumeIntent(intent));
  const openTranscribeSettings = vi.fn();
  let readingViewOpen = false;
  let actions: OverviewUiActions = {
    retry: () => {},
    cancel: () => {},
    setup: () => {},
    openTranscribeSettings: () => {}
  };
  const intervals = new Map<number, () => void>();
  let nextIntervalId = 1;
  const coordinator = modules.coordinatorMod.createOverviewCoordinator({
    getClip: () => clip,
    isReadingViewOpen: () => readingViewOpen,
    resolveProvider,
    loadAnalysis: async () =>
      ({ runOverviewAnalysis }) as unknown as Promise<typeof import("../../extension/ai/analysis.js")>,
    confirm: vi.fn(async () => true),
    registerUiActions: (a) => {
      actions = a;
      modules.overviewUi.registerOverviewUiActions(a);
    },
    ...(options.withSetupResume === false
      ? {}
      : {
          setupResume: {
            begin,
            consume: () => modules.leaf.consumeOverviewSetupResumeIntent()
          }
        }),
    openTranscribeSettings: () => openTranscribeSettings(),
    now: () => 0,
    setInterval: ((cb: () => void) => {
      const id = nextIntervalId;
      nextIntervalId += 1;
      intervals.set(id, cb);
      return id;
    }) as unknown as typeof setInterval,
    clearInterval: ((id: number) => {
      intervals.delete(id);
    }) as unknown as typeof clearInterval
  });
  return {
    modules,
    clip,
    coordinator,
    get actions() {
      return actions;
    },
    runOverviewAnalysis,
    resolveProvider,
    begin,
    openTranscribeSettings,
    setReadingViewOpen: (open: boolean) => {
      readingViewOpen = open;
    }
  };
}

function mountOverviewHost(h: Harness): HTMLElement {
  h.setReadingViewOpen(true);
  mountReaderSkeleton(h.modules.ids);
  return document.getElementById(h.modules.ids.readingOverviewBody) as HTMLElement;
}

function renderAndQuery(h: Harness, selector: string): HTMLElement | null {
  h.coordinator.render();
  return document.querySelector<HTMLElement>(selector);
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
});

describe("意图叶子：页面内存单槽语义", () => {
  it("set → peek 副本 → consume 取走清空 → 再 consume 为 null", async () => {
    const { leaf } = await loadModules();
    const intent = {
      overviewKey: "k1",
      taskEpoch: 0,
      createdAt: 1,
      errorClass: "no-provider" as const
    };
    leaf.setOverviewSetupResumeIntent(intent);
    const peeked = leaf.peekOverviewSetupResumeIntent();
    expect(peeked).toEqual(intent);
    expect(peeked).not.toBeNull();
    // 外部改写副本不影响内部状态
    (peeked as { overviewKey: string }).overviewKey = "tampered";
    expect(leaf.peekOverviewSetupResumeIntent()?.overviewKey).toBe("k1");
    expect(leaf.consumeOverviewSetupResumeIntent()).toEqual(intent);
    expect(leaf.consumeOverviewSetupResumeIntent()).toBeNull();
    expect(leaf.peekOverviewSetupResumeIntent()).toBeNull();
  });

  it("clear 作废未消费意图", async () => {
    const { leaf } = await loadModules();
    leaf.setOverviewSetupResumeIntent({
      overviewKey: "k1",
      taskEpoch: 0,
      createdAt: 1,
      errorClass: "missing-key"
    });
    leaf.clearOverviewSetupResumeIntent();
    expect(leaf.consumeOverviewSetupResumeIntent()).toBeNull();
  });
});

describe("setup 动作与续跑", () => {
  it("「去设置」记录意图（身份键 + 当前代次 + 错误类目）", async () => {
    const h = await makeHarness();
    h.actions.setup("no-provider");
    expect(h.begin).toHaveBeenCalledTimes(1);
    const intent = h.begin.mock.calls[0][0];
    expect(typeof intent.overviewKey).toBe("string");
    expect(intent.overviewKey).toContain("BV1test000000");
    expect(intent.taskEpoch).toBe(0);
    expect(intent.errorClass).toBe("no-provider");
  });

  it("首配保存成功：同一视频续跑一次（forceRefresh，一次性消费）", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("missing-key");
    // 装配方保存成功语义：消费意图（resumeAfterSetup 内同步取走）后续跑
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(true);
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
    const args = h.runOverviewAnalysis.mock.calls[0][0] as RunArgs;
    expect(args.forceRefresh).toBe(true);
    expect(h.coordinator.getPhase()).toBe("ready");
    // 重复保存 / 已消费：不再续跑
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it("取消编辑（会话结束清意图）→ 不续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("no-provider");
    // 装配方 onSessionEnd 语义（settings-panel 传入的会话回调）
    h.modules.leaf.clearOverviewSetupResumeIntent();
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("保存失败意图保留：编辑器不关、意图未清，重试保存仍可续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("missing-key");
    // 保存失败不走 onAfterSave / onSessionEnd——意图原样保留
    expect(h.modules.leaf.peekOverviewSetupResumeIntent()).not.toBeNull();
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(true);
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it("换视频（身份键变化）→ 意图作废，不续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("no-provider");
    h.clip.bvid = "BV1other00000";
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
    // 已随 consume 丢弃：换回视频也不会续跑
    h.clip.bvid = "BV1test000000";
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("任务代次变化（设置期间概览又起一轮）→ 不续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("no-provider");
    // 设置期间字幕就绪等路径又触发生成：代次推进
    await h.coordinator.trigger();
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it("无字幕（空态）→ 不续跑", async () => {
    const h = await makeHarness();
    h.actions.setup("no-provider");
    h.clip.subtitleBody = [];
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("无意图时 resumeAfterSetup 静默不续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("无 setupResume 的协调器（伴看无头侧）：setup 不抛、resume 不续跑", async () => {
    const h = await makeHarness({ withSetupResume: false });
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    expect(() => h.actions.setup("no-provider")).not.toThrow();
    await expect(h.coordinator.resumeAfterSetup()).resolves.toBe(false);
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });
});

describe("error 条：配置类错误给「去设置」，非配置类不给", () => {
  async function renderErrorStrip(h: Harness, error: Error): Promise<HTMLElement> {
    h.runOverviewAnalysis.mockRejectedValue(error);
    await h.coordinator.trigger();
    expect(h.coordinator.getPhase()).toBe("error");
    mountOverviewHost(h);
    h.coordinator.render();
    return document.getElementById(h.modules.ids.readingOverviewBody) as HTMLElement;
  }

  it("无平台错误：去设置（no-provider）+ 重试并存", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]');
    expect(setup).not.toBeNull();
    expect(setup?.dataset.setupClass).toBe("no-provider");
    expect(setup?.textContent).toContain("去设置");
    expect(body.querySelector('[data-overview-action="retry"]')).not.toBeNull();
  });

  it("缺 Key 错误：去设置（missing-key）", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(MISSING_PROVIDER_KEY_MESSAGE));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]');
    expect(setup?.dataset.setupClass).toBe("missing-key");
  });

  it("缺模型错误：去设置（no-model）", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(NO_ACTIVE_MODEL_MESSAGE));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]');
    expect(setup?.dataset.setupClass).toBe("no-model");
  });

  it("非配置类错误（管线失败）：只有重试，不伪装成配置问题", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error("模型请求失败"));
    expect(body.querySelector('[data-overview-action="setup"]')).toBeNull();
    expect(body.querySelector('[data-overview-action="retry"]')).not.toBeNull();
  });

  it("点击「去设置」→ setup 动作带错误类目分派", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    body.addEventListener("click", (event) => h.modules.overviewUi.onReadingOverviewClick(event as MouseEvent));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]')!;
    setup.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.begin.mock.calls[0][0].errorClass).toBe("no-provider");
  });
});

describe("无字幕配置空态：remedy=open-settings 给「前往设置」", () => {
  async function renderEmptyState(reason: unknown): Promise<HTMLElement> {
    const h = await makeHarness();
    h.clip.subtitleBody = [];
    (h.modules.state.state.clip as { noSubtitleReason?: unknown }).noSubtitleReason = reason;
    mountOverviewHost(h);
    h.coordinator.render();
    expect(h.coordinator.getPhase()).toBe("empty");
    return document.getElementById(h.modules.ids.readingOverviewBody) as HTMLElement;
  }

  it("no-asr-config（配置类）：前往设置按钮在场", async () => {
    const body = await renderEmptyState("no-asr-config");
    const button = body.querySelector<HTMLElement>('[data-overview-action="open-transcribe-settings"]');
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("前往设置");
  });

  it("asr-empty（无人声，非配置类）：不挂设置动作", async () => {
    const body = await renderEmptyState("asr-empty");
    expect(body.querySelector('[data-overview-action="open-transcribe-settings"]')).toBeNull();
  });

  it("asr-quota（充值类，非配置类）：不挂设置动作", async () => {
    const body = await renderEmptyState("asr-quota");
    expect(body.querySelector('[data-overview-action="open-transcribe-settings"]')).toBeNull();
  });

  it("点击「前往设置」→ openTranscribeSettings 分派", async () => {
    const h = await makeHarness();
    h.clip.subtitleBody = [];
    (h.modules.state.state.clip as { noSubtitleReason?: unknown }).noSubtitleReason = "no-asr-config";
    const body = mountOverviewHost(h);
    h.coordinator.render();
    body.addEventListener("click", (event) => h.modules.overviewUi.onReadingOverviewClick(event as MouseEvent));
    body
      .querySelector<HTMLElement>('[data-overview-action="open-transcribe-settings"]')!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(h.openTranscribeSettings).toHaveBeenCalledTimes(1);
  });
});
