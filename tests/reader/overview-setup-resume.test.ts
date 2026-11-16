// 概览配置类错误「去设置」跳转与保存续跑契约：
// 1. 统一协调模块（reader/setup-resume）：单飞防重入、errorClass（含 no-model）直传、
//    一次性恢复槽及按 scope/all 失效；
// 2. 概览协调器接线：配置类错误「去设置」收集有效性与恢复回调，保存成功后在同一视频
//    以 forceRefresh 续跑一次，取消 / 换视频 / 代次推进 / 空字幕 / 关抽屉均不续跑。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { OverviewAnalysis } from "../../extension/ai/analysis.js";
import type { SubtitleBodyItem } from "../../extension/core/state.js";
import type { AiProvider } from "../../extension/ai/types.js";
import type { OverviewUiActions } from "../../extension/reader/overview-ui.js";
import type { AiSetupSession, AiSetupTarget } from "../../extension/ui/settings-panel.js";
import {
  MISSING_PROVIDER_KEY_MESSAGE,
  NO_ACTIVE_MODEL_MESSAGE,
  NO_ACTIVE_PROVIDER_MESSAGE,
  type OverviewSetupErrorClass
} from "../../extension/core/overview-setup-error.js";

const setupMock = vi.hoisted(() => ({
  openReaderAiSetup: vi.fn<
    (errorClass: OverviewSetupErrorClass, session: AiSetupSession, target?: AiSetupTarget) => Promise<void>
  >(async () => {})
}));

vi.mock("../../extension/ui/settings-panel.js", () => setupMock);

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
  setupResume: typeof import("../../extension/reader/setup-resume.js");
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
  const [stateMod, readerState, overviewUi, coordinatorMod, setupResume] = await Promise.all([
    import("../../extension/core/state.js"),
    import("../../extension/reader/state.js"),
    import("../../extension/reader/overview-ui.js"),
    import("../../extension/reader/overview-coordinator.js"),
    import("../../extension/reader/setup-resume.js")
  ]);
  return { ids: readerState.ids, overviewUi, coordinatorMod, setupResume, state: stateMod };
}

async function makeHarness(options: { withSetupResume?: boolean } = {}): Promise<Harness> {
  const modules = await loadModules();
  const clip = seedClip();
  const runOverviewAnalysis = vi.fn();
  const resolveProvider = vi.fn(async () => PROVIDER);
  const begin = vi.fn(
    (request: import("../../extension/reader/overview-coordinator.js").OverviewSetupRequest) => {
      void modules.setupResume.beginReaderAiSetupFlow({
        scope: "overview",
        errorClass: request.errorClass,
        isStillValid: request.isStillValid,
        onResume: () => {
          void request.onResume();
        }
      });
    }
  );
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
    ...(options.withSetupResume === false ? {} : { setupResume: { begin } }),
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

function capturedSetupCall(index = 0): [OverviewSetupErrorClass, AiSetupSession, AiSetupTarget | undefined] {
  const call = setupMock.openReaderAiSetup.mock.calls[index];
  return [call[0], call[1], call[2]];
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  setLocationUrl(READER_MODE_URL);
  setupMock.openReaderAiSetup.mockReset();
  setupMock.openReaderAiSetup.mockImplementation(async () => {});
});

describe("setup-resume（reader/setup-resume）：单飞、直传与一次性消费语义", () => {
  it("透传 no-model（不改写为 missing-key）并在保存且仍有效时只恢复一次", async () => {
    const { setupResume } = await loadModules();
    const onResume = vi.fn();
    const onCancel = vi.fn();

    await setupResume.beginReaderAiSetupFlow({
      scope: "overview",
      errorClass: "no-model",
      providerId: "ollama-1",
      isStillValid: () => true,
      onResume,
      onCancel
    });

    expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1);
    const [errorClass, session, target] = capturedSetupCall(0);
    expect(errorClass).toBe("no-model");
    expect(target).toEqual({ providerId: "ollama-1" });

    session.onAfterSave();
    session.onAfterSave();
    session.onSessionEnd();

    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("异步装载期单飞去重 + invalidateReaderSetupFlows 作废并通知 onCancel", async () => {
    const { setupResume } = await loadModules();
    let resolveOpen!: () => void;
    setupMock.openReaderAiSetup.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        resolveOpen = resolve;
      })
    );
    const onResume = vi.fn();
    const onCancel = vi.fn();

    const first = setupResume.beginReaderAiSetupFlow({
      scope: "overview",
      errorClass: "no-provider",
      isStillValid: () => true,
      onResume,
      onCancel
    });
    const second = setupResume.beginReaderAiSetupFlow({
      scope: "overview",
      errorClass: "no-provider",
      isStillValid: () => true,
      onResume,
      onCancel
    });

    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    setupResume.invalidateReaderSetupFlows("overview");
    resolveOpen();
    await Promise.all([first, second]);

    session.onAfterSave();
    expect(onResume).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledWith("invalid");
  });
});

describe("setup 动作与续跑", () => {
  it("「去设置」携带错误类目直接经 beginReaderAiSetupFlow 进 openReaderAiSetup", async () => {
    const h = await makeHarness();
    h.actions.setup("no-model");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.begin.mock.calls[0][0].errorClass).toBe("no-model");
    const [errorClass] = capturedSetupCall(0);
    expect(errorClass).toBe("no-model");
  });

  it("首配保存成功：同一视频续跑一次（forceRefresh，一次性消费）", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("missing-key");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    session.onAfterSave();
    await vi.waitFor(() => expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1));
    const args = h.runOverviewAnalysis.mock.calls[0][0] as RunArgs;
    expect(args.forceRefresh).toBe(true);
    expect(h.coordinator.getPhase()).toBe("ready");

    // 重复保存 / 已消费：不再续跑
    session.onAfterSave();
    await Promise.resolve();
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it("取消编辑（onSessionEnd）→ 不续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("no-provider");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    session.onSessionEnd();
    session.onAfterSave();
    await Promise.resolve();
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("保存失败意图保留：会话未结束时，重试保存仍可续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("missing-key");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    session.onAfterSave();
    await vi.waitFor(() => expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1));
  });

  it("换视频（身份键变化）→ 失效，不续跑且换回原视频也不恢复", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("no-provider");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    h.clip.bvid = "BV1other00000";
    session.onAfterSave();
    await Promise.resolve();
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();

    // 槽已随保存尝试作废：换回原视频也不会再续跑
    h.clip.bvid = "BV1test000000";
    session.onAfterSave();
    await Promise.resolve();
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("任务代次变化（设置期间概览又起一轮）→ 不续跑", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.actions.setup("no-provider");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    await h.coordinator.trigger();
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);

    session.onAfterSave();
    await Promise.resolve();
    expect(h.runOverviewAnalysis).toHaveBeenCalledTimes(1);
  });

  it("无字幕（空态）→ 不续跑", async () => {
    const h = await makeHarness();
    h.actions.setup("no-provider");
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupCall(0);

    h.clip.subtitleBody = [];
    session.onAfterSave();
    await Promise.resolve();
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("无意图时 invalidateReaderSetupFlows 静默、无副作用", async () => {
    const h = await makeHarness();
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    h.modules.setupResume.invalidateReaderSetupFlows("all");
    expect(h.runOverviewAnalysis).not.toHaveBeenCalled();
  });

  it("无 setupResume 的协调器（伴看无头侧）：setup 不抛、不调用 openReaderAiSetup", async () => {
    const h = await makeHarness({ withSetupResume: false });
    h.runOverviewAnalysis.mockResolvedValue(SAMPLE_ANALYSIS);
    expect(() => h.actions.setup("no-provider")).not.toThrow();
    expect(setupMock.openReaderAiSetup).not.toHaveBeenCalled();
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

  it("无平台错误：仅展示主按钮去设置（no-provider），不再渲染重试", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(NO_ACTIVE_PROVIDER_MESSAGE));
    const strip = body.querySelector<HTMLElement>(".biliscript-reading-ov-strip.is-error");
    expect(strip?.getAttribute("role")).toBe("alert");
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]');
    expect(setup).not.toBeNull();
    expect(setup?.classList.contains("is-primary")).toBe(true);
    expect(setup?.dataset.setupClass).toBe("no-provider");
    expect(setup?.textContent).toContain("去设置");
    expect(body.querySelector('[data-overview-action="retry"]')).toBeNull();
  });

  it("缺 Key 错误：仅展示主按钮去设置（missing-key）", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(MISSING_PROVIDER_KEY_MESSAGE));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]');
    expect(setup).not.toBeNull();
    expect(setup?.classList.contains("is-primary")).toBe(true);
    expect(setup?.dataset.setupClass).toBe("missing-key");
    expect(body.querySelector('[data-overview-action="retry"]')).toBeNull();
  });

  it("缺模型错误：仅展示主按钮去设置（no-model）", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(NO_ACTIVE_MODEL_MESSAGE));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]');
    expect(setup).not.toBeNull();
    expect(setup?.classList.contains("is-primary")).toBe(true);
    expect(setup?.dataset.setupClass).toBe("no-model");
    expect(body.querySelector('[data-overview-action="retry"]')).toBeNull();
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

  it("点击「去设置」（no-model）→ setup 动作带 no-model 分派", async () => {
    const h = await makeHarness();
    const body = await renderErrorStrip(h, new Error(NO_ACTIVE_MODEL_MESSAGE));
    body.addEventListener("click", (event) => h.modules.overviewUi.onReadingOverviewClick(event as MouseEvent));
    const setup = body.querySelector<HTMLElement>('[data-overview-action="setup"]')!;
    setup.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(h.begin).toHaveBeenCalledTimes(1);
    expect(h.begin.mock.calls[0][0].errorClass).toBe("no-model");
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
