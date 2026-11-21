import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import type { OverviewAnalysis } from "../../extension/ai/analysis.js";
import { getAsrFailureNotice } from "../../extension/core/asr-failure-notice.js";
import type { TestState } from "./reader-test-env.d.ts";

vi.mock("../../extension/ai/analysis.js", async (importActual) => {
  const actual = await importActual<typeof import("../../extension/ai/analysis.js")>();
  return { ...actual, runOverviewAnalysis: vi.fn() };
});

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");
let runOverviewMock: Mock;

interface ChromeStub {
  runtime: { sendMessage: Mock };
  storage: { local: { get: Mock; set: Mock; remove: Mock } };
}

function chromeStub(): ChromeStub {
  return globalThis.chrome as unknown as ChromeStub;
}

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  ids = (await import("../../extension/reader/state.js")).ids;
  const analysis = await import("../../extension/ai/analysis.js");
  runOverviewMock = vi.mocked(analysis.runOverviewAnalysis);
}

function stubRuntimeMessages(extra?: (message: Record<string, unknown>) => unknown | undefined) {
  chromeStub().runtime.sendMessage.mockImplementation((message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
    const respond = (resp: unknown) => {
      callback?.(resp);
      return undefined;
    };
    if (extra) {
      const overridden = extra(message);
      if (overridden !== undefined) {
        return respond(overridden);
      }
    }
    switch (message?.type) {
      case "resolve-ai-provider":
        return respond({
          ok: true,
          provider: [{ id: "prov-1", presetId: "custom", name: "测试平台", baseUrl: "https://api.test/v1", model: "test-model", enabled: true, hasSavedKey: true }][0],
          apiKey: "sk-test"
        });
      default:
        return respond({ ok: true });
    }
  });
}

const SAMPLE_ANALYSIS: OverviewAnalysis = {
  summary: "这支视频介绍测试的常见误区，并说明如何用有效反馈改进代码。",
  chapters: [
    { from: 0, to: 120, title: "开场", summary: "为什么测试难写" },
    { from: 120, to: 300, title: "误区一", summary: " mocking 一切" }
  ],
  quotes: [
    { from: 125, content: "测试不是目的，而是反馈。" }
  ]
};

function overviewBody(): HTMLElement {
  return document.getElementById(ids.readingOverviewBody) as HTMLElement;
}

function overviewText(): string {
  return overviewBody().textContent || "";
}

function bindOverviewDelegation() {
  overviewBody().addEventListener("click", (event) => {
    reader.onReadingOverviewClick(event as MouseEvent);
  });
}

function seedClip({ chapters = [] as unknown[] } = {}) {
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "1000";
  state.clip.title = "测试视频";
  state.clip.author = "作者";
  state.clip.description = "视频简介";
  state.clip.videoDuration = 300;
  state.clip.selectedSubtitleId = "sub-1";
  state.clip.selectedSubtitleUrl = "https://subtitle.test/1";
  state.clip.selectedSubtitleLang = "中文（自动）";
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 300, content: "今天讲测试" }
  ];
  state.clip.chapters = chapters as TestState["clip"]["chapters"];
  state.reader.readingViewOpen = true;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  await loadModules();
  mountReaderSkeleton(ids);
  mountPlayerChain();
  chromeStub().storage.local.get.mockImplementation(async () => ({}));
  stubRuntimeMessages();
});

afterEach(() => {
  document.body.innerHTML = "";
  statusBus.publishSubtitleStatusPhase("idle");
  vi.restoreAllMocks();
});

describe("概览状态机与触发", () => {  it("无字幕：不触发生成，展示诚实空态（转写中给出预期文案）", async () => {
    seedClip();
    state.clip.subtitleBody = [];

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).not.toHaveBeenCalled();
    expect(overviewText()).toContain("该视频没有可用字幕");

    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览等字幕就绪后自动生成");
  });

  it("无字幕且字幕抓取中：loading 预期态文案，不误显「该视频没有可用字幕」", async () => {
    seedClip();
    state.clip.subtitleBody = [];
    state.clip.subtitleFetchState = "loading";

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).not.toHaveBeenCalled();
    expect(overviewText()).toContain("字幕抓取中");
    expect(overviewText()).not.toContain("该视频没有可用字幕");
  });

  it("无字幕且已归因（noSubtitleReason）：空态跟着原因走（标题=病因、正文=补救），不带详情行", async () => {
    seedClip();
    state.clip.subtitleBody = [];
    state.clip.subtitleFetchState = "empty";
    state.clip.noSubtitleReason = "asr-auth";
    state.clip.noSubtitleDetail = "（错误详情：HTTP 401: invalid token）";

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).not.toHaveBeenCalled();
    const notice = getAsrFailureNotice("asr-auth");
    const text = overviewText();
    expect(text).toContain(notice.cause);
    expect(text).toContain(notice.remedyText);
    expect(text).not.toContain("该视频没有可用字幕");
    expect(text).not.toContain("错误详情");
  });

  it("无字幕且原因为 null：维持通用兜底空态", async () => {
    seedClip();
    state.clip.subtitleBody = [];
    state.clip.subtitleFetchState = "empty";
    state.clip.noSubtitleReason = null;

    await reader.triggerReaderOverviewGeneration();

    expect(overviewText()).toContain("该视频没有可用字幕");
  });

  it("idle 触发 → 生成 → ready 渲染：章节/金句 + 上下文与 provider 入参正确", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    const args = runOverviewMock.mock.calls[0][0] as {
      provider: { apiKey?: string; baseUrl?: string; model?: string; presetId?: string };
      context: Record<string, unknown>;
      forceRefresh?: boolean;
      thinkingLevel?: string;
    };
    expect(args.provider).toEqual({ baseUrl: "https://api.test/v1", apiKey: "sk-test", model: "test-model", presetId: "custom" });
    expect(args.forceRefresh).toBe(false);
    expect(args.thinkingLevel).toBe("off");
    expect(args.context.bvid).toBe("BV1test000000");
    expect(args.context.selectedSubtitleId).toBe("sub-1");
    expect(Array.isArray(args.context.subtitleBody)).toBe(true);

    const text = overviewText();
    expect(text).toContain("开场");
    expect(text).toContain("为什么测试难写");
    expect(text).toContain("测试不是目的，而是反馈。");
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-chapter").length).toBe(2);
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-quote").length).toBe(1);
  });

  it("热评拉取失败：ready 产物上方挂概览自己的提示条（反馈归位概览 tab，不写全局状态行）", async () => {
    seedClip();
    state.clip.hotCommentsNotice =
      "热评没拿到（B 站风控校验失败（-352），拿不到热评目录）：本次概览没有评论目录。";
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);

    await reader.triggerReaderOverviewGeneration();

    const strip = overviewBody().querySelector(".biliscript-reading-ov-strip") as HTMLElement;
    expect(strip).not.toBeNull();
    expect(strip.classList.contains("is-generating")).toBe(false);
    expect(strip.classList.contains("is-error")).toBe(false);
    expect(strip.textContent).toContain("热评没拿到");
    expect(strip.textContent).toContain("本次概览没有评论目录");
    expect(overviewText()).toContain("开场");
  });

  it("热评提示条：字段为空（拉取成功）时 ready 产物不挂条", async () => {
    seedClip();
    state.clip.hotCommentsNotice = "";
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);

    await reader.triggerReaderOverviewGeneration();

    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-strip").length).toBe(0);
  });

  it("presetId 穿线：解析链带回记录的 presetId（preset 词表键），随 provider 进入概览管线", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    stubRuntimeMessages((message) => {
      if (message?.type === "resolve-ai-provider") {
        return {
          ok: true,
          provider: [{ id: "prov-1", presetId: "qwen", name: "反代百炼", baseUrl: "https://thinking-proxy.example.com/v1", model: "qwen3-max", enabled: true, hasSavedKey: true }][0],
          apiKey: "sk-test"
        };
      }
      return undefined;
    });

    await reader.triggerReaderOverviewGeneration();

    const args = runOverviewMock.mock.calls[0][0] as { provider: { presetId?: string; baseUrl?: string; model?: string } };
    expect(args.provider.presetId).toBe("qwen");
    expect(args.provider.baseUrl).toBe("https://thinking-proxy.example.com/v1");
    expect(args.provider.model).toBe("qwen3-max");
  });

  it("生成中重复触发：复用进行中 promise，管线只发起一次；落定后 ready", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      () => new Promise<OverviewAnalysis>((resolve) => {
        resolveRun = resolve;
      })
    );

    const first = reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));

    const second = reader.triggerReaderOverviewGeneration();
    expect(second).toBe(first);
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    expect(overviewText()).toContain("正在生成概览");

    resolveRun({ ...SAMPLE_ANALYSIS });
    await first;
    expect(overviewText()).toContain("开场");

    await reader.triggerReaderOverviewGeneration();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
  });

  it("切到新视频后旧 inflight 不复用：新视频换血重跑，旧回执按过期丢弃", async () => {
    seedClip();
    let resolveOld!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      () => new Promise<OverviewAnalysis>((resolve) => {
        resolveOld = resolve;
      })
    );

    const oldRun = reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));

    seedClip();
    state.clip.bvid = "BV1newvideo000";
    state.clip.cid = "2000";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新视频内容" }];
    runOverviewMock.mockClear();
    let resolveNew!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      () => new Promise<OverviewAnalysis>((resolve) => {
        resolveNew = resolve;
      })
    );

    const newRun = reader.triggerReaderOverviewGeneration();
    expect(newRun).not.toBe(oldRun);
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect(overviewText()).toContain("正在生成概览");

    resolveOld({
      summary: "",
      chapters: [{ from: 0, to: 120, title: "旧视频章节", summary: "" }],
      quotes: []
    });
    await oldRun;
    expect(overviewText()).toContain("正在生成概览");
    expect(overviewText()).not.toContain("旧视频章节");

    resolveNew({
      summary: "",
      chapters: [{ from: 0, to: 120, title: "新视频章节", summary: "" }],
      quotes: []
    });
    await newRun;
    expect(overviewText()).toContain("新视频章节");
  });

  it("分段进度文案（onProgress 注入）渲染进生成中状态条", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      (_args, deps?: { onProgress?: (notice: string) => void }) => {
        deps?.onProgress?.("正在整理第 2/3 段（67%）");
        return new Promise<OverviewAnalysis>((resolve) => {
          resolveRun = resolve;
        });
      }
    );

    const run = reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(overviewText()).toContain("正在整理第 2/3 段（67%）"));

    resolveRun({ ...SAMPLE_ANALYSIS });
    await run;
    expect(overviewText()).toContain("开场");
  });

  it("生成中状态条单槽：文案全面板只出现一次，未收到进度前回落「正在生成概览…」", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    let notify!: (notice: string) => void;
    runOverviewMock.mockImplementation(
      (_args, deps?: { onProgress?: (notice: string) => void }) => {
        notify = (notice) => deps?.onProgress?.(notice);
        return new Promise<OverviewAnalysis>((resolve) => {
          resolveRun = resolve;
        });
      }
    );

    const run = reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));

    const occurrences = () => overviewText().split("正在生成概览").length - 1;
    expect(overviewText()).toContain("正在生成概览…");
    expect(occurrences()).toBe(1);
    expect(overviewBody().querySelector(".biliscript-reading-placeholder-title")).toBeNull();
    expect(overviewBody().querySelector(".biliscript-reading-placeholder.is-generating")).not.toBeNull();

    notify("正在生成概览…（已接收 1195 字）");
    expect(overviewText()).toContain("正在生成概览…（已接收 1195 字）");
    expect(occurrences()).toBe(1);

    resolveRun({ ...SAMPLE_ANALYSIS });
    await run;
  });

  it("AI 分章（稿件章节为空）章节标头带「AI 生成」标注；自带章节不标", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    const sectionHead = overviewBody().querySelector(".biliscript-reading-ov-h")?.parentElement?.textContent || "";
    expect(overviewText()).toContain("AI 生成");
    expect(sectionHead).toBeDefined();

    seedClip({ chapters: [{ title: "自带章节", from: 0 }] });
    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    const headings = Array.from(overviewBody().querySelectorAll(".biliscript-reading-ov-h")).map((node) => node.textContent || "");
    expect(headings.some((heading) => heading.includes("章节") && !heading.includes("AI 生成"))).toBe(true);
  });

  it("partial：失败区间标记条 + 重试失败区间按钮（forceRefresh 重跑）", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({
      ...SAMPLE_ANALYSIS,
      failedRanges: [{ from: 120, to: 300 }]
    });

    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("1 个分段生成失败");
    expect(overviewText()).toContain("开场");

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    const retryBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='retry-failed']");
    expect(retryBtn).not.toBe(null);
    bindOverviewDelegation();
    retryBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect((runOverviewMock.mock.calls[0][0] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    await vi.waitFor(() => expect(overviewText()).not.toContain("个分段生成失败"));
  });

  it("简介缺失：章节与金句照常展示，复用 partial 重试入口补简介", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({
      ...SAMPLE_ANALYSIS,
      summary: "",
      summaryFailed: true
    });

    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("简介暂未生成");
    expect(overviewText()).toContain("全片简介未生成");
    expect(overviewText()).toContain("开场");
    expect(overviewText()).toContain("测试不是目的，而是反馈。");

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    const retry = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='retry-failed']");
    expect(retry?.textContent).toBe("重试简介");
    bindOverviewDelegation();
    retry!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(overviewText()).toContain(SAMPLE_ANALYSIS.summary));
    expect(overviewText()).not.toContain("简介暂未生成");
  });

  it("error：错误条带原因 + 重试按钮；error 态切 tab 不自动重跑", async () => {
    seedClip();
    runOverviewMock.mockRejectedValue(new Error("模型请求失败"));

    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("概览生成失败");
    expect(overviewText()).toContain("模型请求失败");

    reader.ensureReaderOverviewTab();
    await Promise.resolve();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    const retryBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='retry']");
    expect(retryBtn).not.toBe(null);
    bindOverviewDelegation();
    retryBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect((runOverviewMock.mock.calls[0][0] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    await vi.waitFor(() => expect(overviewText()).toContain("开场"));
  });

  it("provider 解析失败（未配置 AI 平台）落入 error 态并如实展示", async () => {
    seedClip();
    chromeStub().runtime.sendMessage.mockImplementation((message: Record<string, unknown>, callback?: (resp: unknown) => void) => {
      if (message?.type === "resolve-ai-provider") {
        callback?.({ ok: false, error: "还没有配置 AI 平台，请先在插件设置中添加并启用。" });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    await reader.triggerReaderOverviewGeneration();

    expect(runOverviewMock).not.toHaveBeenCalled();
    expect(overviewText()).toContain("概览生成失败");
    expect(overviewText()).toContain("还没有配置 AI 平台");
  });
});

describe("章节与金句分区渲染（自带章节 / AI 分章 / 无章节）", () => {
  const GROUPED_ANALYSIS: OverviewAnalysis = {
    summary: "全片简介。",
    chapters: [
      { from: 100, to: 200, title: "章一", summary: "前半段" },
      { from: 200, to: 300, title: "章二", summary: "后半段" }
    ],
    quotes: [
      { from: 30, content: "开篇点题的金句" },
      { from: 120, content: "章一里的原话金句" },
      { from: 250, content: "章二里的原话金句" }
    ]
  };

  function quoteCard(seconds: number): HTMLElement | null {
    return overviewBody().querySelector<HTMLElement>(`.biliscript-reading-ov-quote[data-seconds='${seconds}']`);
  }

  function assertSectionsSplit(): void {
    const sections = Array.from(overviewBody().querySelectorAll(".biliscript-reading-ov-section"));
    expect(sections.length).toBe(3);
    const [summarySection, chapterSection, quoteSection] = sections;
    expect(summarySection.querySelector(".biliscript-reading-ov-h")).toBeNull();
    expect(summarySection.textContent).toContain("全片简介");
    expect(chapterSection.querySelector(".biliscript-reading-ov-h")?.textContent).toContain("章节");
    expect(quoteSection.querySelector(".biliscript-reading-ov-h")?.textContent).toContain("金句");
    expect(chapterSection.querySelectorAll(".biliscript-reading-ov-quote").length).toBe(0);
    expect(quoteSection.querySelectorAll(".biliscript-reading-ov-chapter").length).toBe(0);
  }

  it("自带章节视频：章节与金句分区呈现，时间戳与原话保真", async () => {
    seedClip({ chapters: [{ from: 100, title: "章一" }, { from: 200, title: "章二" }] });
    runOverviewMock.mockResolvedValue(GROUPED_ANALYSIS);

    await reader.triggerReaderOverviewGeneration();

    assertSectionsSplit();
    expect(quoteCard(30)?.textContent).toContain("开篇点题的金句");
    expect(quoteCard(120)?.textContent).toContain("章一里的原话金句");
    expect(quoteCard(250)?.textContent).toContain("章二里的原话金句");
    const text = overviewText();
    expect(text.indexOf("章一里的原话金句")).toBeLessThan(text.indexOf("章二里的原话金句"));
  });

  it("AI 分章视频：章节与金句同样分区，章节标头带「AI 生成」", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(GROUPED_ANALYSIS);

    await reader.triggerReaderOverviewGeneration();

    assertSectionsSplit();
    expect(overviewText()).toContain("AI 生成");
  });

  it("orphan 金句（早于第一章）：按 from 平铺进金句 section，不丢弃", async () => {
    seedClip({ chapters: [{ from: 100, title: "章一" }] });
    runOverviewMock.mockResolvedValue({
      summary: "全片简介。",
      chapters: [{ from: 100, to: 300, title: "章一", summary: "" }],
      quotes: [
        { from: 30, content: "开篇点题的金句" },
        { from: 150, content: "章一里的原话金句" }
      ]
    });

    await reader.triggerReaderOverviewGeneration();

    assertSectionsSplit();
    const quotes = Array.from(overviewBody().querySelectorAll<HTMLElement>(".biliscript-reading-ov-quote"));
    expect(quotes.map((node) => node.dataset.seconds)).toEqual(["30", "150"]);
  });

  it("无章节视频：维持平铺——章节空态 + 独立金句 section（AI 精选）", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({
      chapters: [],
      quotes: [
        { from: 125, content: "平铺金句甲" },
        { from: 200, content: "平铺金句乙" }
      ]
    });

    await reader.triggerReaderOverviewGeneration();

    expect(overviewText()).toContain("没有可用的章节");
    const headings = Array.from(overviewBody().querySelectorAll(".biliscript-reading-ov-h")).map((node) => node.textContent || "");
    expect(headings.some((heading) => heading.includes("金句") && heading.includes("AI 精选"))).toBe(true);
    const quotes = Array.from(overviewBody().querySelectorAll<HTMLElement>(".biliscript-reading-ov-quote"));
    expect(quotes.map((node) => node.dataset.seconds)).toEqual(["125", "200"]);
  });

  it("有章节但金句为空：章节照常呈现，金句空态不丢", async () => {
    seedClip({ chapters: [{ from: 100, title: "章一" }] });
    runOverviewMock.mockResolvedValue({
      chapters: [{ from: 100, to: 300, title: "章一", summary: "" }],
      quotes: []
    });

    await reader.triggerReaderOverviewGeneration();

    expect(overviewText()).toContain("章一");
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-quote").length).toBe(0);
    expect(overviewText()).toContain("没有可用的金句");
  });

  it("目录来源章节只留标题（summary 空串）：不渲染简介区块，金句照常", async () => {
    seedClip({ chapters: [{ from: 100, title: "章一" }] });
    runOverviewMock.mockResolvedValue({
      chapters: [
        { from: 100, to: 300, title: "评论区开场", summary: "" },
        { from: 300, to: 600, title: "评论区正题", summary: "" }
      ],
      quotes: [{ from: 150, content: "金句照常渲染" }]
    });

    await reader.triggerReaderOverviewGeneration();

    expect(overviewText()).toContain("评论区开场");
    expect(overviewText()).toContain("评论区正题");
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-chapter-desc").length).toBe(0);
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-quote").length).toBe(1);
  });
});

describe("章节完整标题渲染", () => {
  function chapterTitleTexts(): string[] {
    return Array.from(overviewBody().querySelectorAll(".biliscript-reading-ov-chapter-title")).map(
      (node) => node.textContent || ""
    );
  }

  it("时间轴标题含分隔符也完整保留，不拆成次级说明", async () => {
    seedClip();
    state.clip.description = "00:00 环境准备：安装与配置\n03:00 常见问题——答疑";
    runOverviewMock.mockResolvedValue({
      summary: "全片简介。",
      chapters: [
        { from: 0, to: 180, title: "环境准备：安装与配置", summary: "" },
        { from: 180, to: 300, title: "常见问题——答疑", summary: "" }
      ],
      quotes: []
    });

    await reader.triggerReaderOverviewGeneration();

    expect(chapterTitleTexts()).toEqual(["环境准备：安装与配置", "常见问题——答疑"]);
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-chapter-subtitle").length).toBe(0);
  });

  it("完整标题经安全转义，不产生注入元素", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({
      summary: "全片简介。",
      chapters: [{ from: 0, to: 300, title: "主线<img>：细节&", summary: "" }],
      quotes: []
    });

    await reader.triggerReaderOverviewGeneration();

    expect(chapterTitleTexts()).toEqual(["主线<img>：细节&"]);
    expect(overviewBody().querySelectorAll(".biliscript-reading-ov-chapter img").length).toBe(0);
  });
});

describe("概览点击 seek（章节/金句跳播）与金句复制", () => {
  beforeEach(async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    bindOverviewDelegation();
  });

  it("点击章节：seekReadingTarget 通道跳播（resumePlayback 语义）", () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    const chapter = overviewBody().querySelector<HTMLElement>(".biliscript-reading-ov-chapter[data-seconds='120']")!;
    chapter.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(video.currentTime).toBe(120);
    expect(video.play).toHaveBeenCalledTimes(1);
  });

  it("点击金句：右下角时间戳整卡可点，跳到金句时间", () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    const quote = overviewBody().querySelector<HTMLElement>(".biliscript-reading-ov-quote")!;
    quote.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(video.currentTime).toBe(125);
  });

  it("点击 Copy：剪贴板写入金句文本（含时间戳），反馈「金句已复制到剪贴板」；不触发跳播", async () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    const clipboardWriteText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true
    });

    const copyBtn = overviewBody().querySelector<HTMLElement>("[data-overview-action='copy-quote']")!;
    copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1));
    const copied = String(clipboardWriteText.mock.calls[0][0]);
    expect(copied).toContain("测试不是目的，而是反馈。");
    expect(copied).toMatch(/\d{1,2}:\d{2}/);
    expect(video.currentTime).toBe(0);
    expect(video.play).not.toHaveBeenCalled();
  });

  it("点击 Copy 失败（剪贴板拒绝写入）：按钮闪现「复制失败」", async () => {
    const clipboardWriteText = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true
    });

    const copyBtn = overviewBody().querySelector<HTMLElement>("[data-overview-action='copy-quote']")!;
    copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(copyBtn.classList.contains("is-copy-failed")).toBe(true));
    expect(copyBtn.getAttribute("aria-label")).toBe("复制失败");
  });

  it("金句卡选中文本（复制场景）时不跳转", () => {
    const video = document.querySelector("video") as HTMLVideoElement;
    const selectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "已选中的文字"
    } as unknown as Selection);

    const quote = overviewBody().querySelector<HTMLElement>(".biliscript-reading-ov-quote")!;
    quote.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(video.currentTime).toBe(0);
    selectionSpy.mockRestore();
  });
});

describe("概览划词防误跳与金句键盘可达性", () => {
  afterEach(async () => {
    const quoteShareModal = await import("../../extension/reader/quote-share-modal.js");
    quoteShareModal.closeQuoteShareModal({ restoreFocus: false });
  });

  it("pointerdown 时存在文本选区、click 时已清空选区仍不跳播，下一次正常点击恢复跳播", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();

    const overviewUi = await import("../../extension/reader/overview-ui.js");
    overviewUi.bindReadingOverviewEvents();

    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];
    const chapter = overviewBody().querySelector<HTMLElement>(".biliscript-reading-ov-chapter[data-seconds='120']")!;

    const selectionSpy = vi.spyOn(window, "getSelection").mockReturnValue({
      toString: () => "选中的概览文本"
    } as unknown as Selection);
    chapter.dispatchEvent(new Event("pointerdown", { bubbles: true }));

    selectionSpy.mockReturnValue({
      toString: () => ""
    } as unknown as Selection);
    chapter.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(video.currentTime).toBe(0);
    expect(video.play).not.toHaveBeenCalled();

    chapter.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    chapter.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(video.currentTime).toBe(120));
    expect(video.play).toHaveBeenCalledTimes(1);
    selectionSpy.mockRestore();
  });

  it("金句内嵌分享与复制按钮具有 tabindex=0，通过 Space / Enter 键盘触发时不跳播", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();

    const overviewUi = await import("../../extension/reader/overview-ui.js");
    const quoteShareModal = await import("../../extension/reader/quote-share-modal.js");
    overviewUi.bindReadingOverviewEvents();

    const video = document.querySelector("video") as HTMLVideoElement;
    video.play = vi.fn(() => Promise.resolve()) as unknown as HTMLVideoElement["play"];

    const clipboardWriteText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: clipboardWriteText },
      configurable: true
    });

    const copyBtn = overviewBody().querySelector<HTMLElement>("[data-overview-action='copy-quote']")!;
    const shareBtn = overviewBody().querySelector<HTMLElement>("[data-overview-action='share-quote']")!;
    expect(copyBtn.getAttribute("tabindex")).toBe("0");
    expect(shareBtn.getAttribute("tabindex")).toBe("0");

    copyBtn.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(clipboardWriteText).toHaveBeenCalledTimes(1));
    expect(video.currentTime).toBe(0);
    expect(video.play).not.toHaveBeenCalled();

    shareBtn.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(quoteShareModal.isQuoteShareModalOpen()).toBe(true));
    expect(video.currentTime).toBe(0);
    expect(video.play).not.toHaveBeenCalled();
  });
});

describe("概览 tab 切换接线（ui-renderer → ensureReaderOverviewTab）", () => {
  it("切到概览 tab：idle 自动触发生成并渲染结果", async () => {
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    state.reader.readingViewOpen = true;

    const tabButton = document.getElementById(ids.readingTabOverview) as HTMLButtonElement;
    tabButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(overviewText()).toContain("开场"));
  });

  it("换轨后旧产物退场：渲染收敛回未生成态，切 tab 按新签名重新生成", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("开场");

    state.clip.selectedSubtitleId = "sub-2";
    state.clip.selectedSubtitleUrl = "https://subtitle.test/2";
    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览还未生成");

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(overviewText()).toContain("开场"));
  });

  it("简介出现时间轴目录后旧产物退场：分章来源从 AI 自由分章变时间轴，重新生成且不再标「AI 生成」", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    await reader.triggerReaderOverviewGeneration();
    expect(overviewText()).toContain("开场");
    expect(overviewText()).toContain("AI 生成");

    state.clip.description = "视频简介\n00:00 评论区开场\n01:40 评论区正题";
    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览还未生成");

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue(SAMPLE_ANALYSIS);
    reader.ensureReaderOverviewTab();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(overviewText()).toContain("开场"));
    expect(overviewText()).not.toContain("AI 生成");
  });
});

describe("closeReadingView 清理", () => {
  it("关闭阅读视图：概览状态归位；进行中的生成不取消，落定回执不写入新会话", async () => {
    seedClip();
    let resolveRun!: (value: OverviewAnalysis) => void;
    runOverviewMock.mockImplementation(
      () => new Promise<OverviewAnalysis>((resolve) => {
        resolveRun = resolve;
      })
    );
    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect(overviewText()).toContain("正在生成概览");

    reader.closeReadingView();
    expect(state.reader.readingViewOpen).toBe(false);

    reader.renderReadingOverview();
    expect(overviewText()).toContain("概览还未生成");

    resolveRun({ ...SAMPLE_ANALYSIS });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(overviewText()).toContain("概览还未生成");

    state.reader.readingViewOpen = true;
    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    await reader.triggerReaderOverviewGeneration();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    expect(overviewText()).toContain("开场");
  });
});

describe("取消生成与等待计时", () => {
  function cancelButton(): HTMLButtonElement | null {
    return overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='cancel']");
  }

  function regenerateButton(): HTMLButtonElement | null {
    return overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='retry']");
  }

  function clickButton(button: HTMLButtonElement): void {
    bindOverviewDelegation();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function runSignal(index: number): AbortSignal | undefined {
    return (runOverviewMock.mock.calls[index]?.[0] as { signal?: AbortSignal } | undefined)?.signal;
  }

  function pendingRun(): void {
    runOverviewMock.mockImplementation(() => new Promise<OverviewAnalysis>(() => {}));
  }

  it("生成中出现「取消」：点击即中止在飞请求，状态条转「已取消」并给出「重新生成」", async () => {
    seedClip();
    pendingRun();

    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));

    const button = cancelButton();
    expect(button).not.toBe(null);
    expect(overviewText()).toContain("正在生成概览…");
    clickButton(button!);

    expect(runSignal(0)?.aborted).toBe(true);
    expect(overviewText()).toContain("已取消概览生成");
    expect(regenerateButton()).not.toBe(null);
  });

  it("取消后切 tab / 再 ensure 不自动重跑（cancelled 态进短路表）", async () => {
    seedClip();
    pendingRun();

    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    clickButton(cancelButton()!);

    reader.ensureReaderOverviewTab();
    await Promise.resolve();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
    expect(overviewText()).toContain("已取消概览生成");
  });

  it("取消后「重新生成」以 forceRefresh 重跑（绕过 cancelled 短路，换新信号）", async () => {
    seedClip();
    pendingRun();

    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    clickButton(cancelButton()!);
    expect(runSignal(0)?.aborted).toBe(true);

    runOverviewMock.mockClear();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    clickButton(regenerateButton()!);

    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect((runOverviewMock.mock.calls[0][0] as { forceRefresh?: boolean }).forceRefresh).toBe(true);
    expect(runSignal(0)?.aborted).toBe(false);
    await vi.waitFor(() => expect(overviewText()).toContain("开场"));
    expect(cancelButton()).toBe(null);
  });

  it("取消后管线以 aborted 上浮：停在「已取消」，不落回 idle 触发自动重跑", async () => {
    seedClip();
    let rejectRun!: (reason: unknown) => void;
    runOverviewMock.mockImplementation(
      (args: { signal?: AbortSignal }) =>
        new Promise<OverviewAnalysis>((_resolve, reject) => {
          rejectRun = reject;
          args.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("请求已中止"), { aborted: true }));
          });
        })
    );

    const run = reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    clickButton(cancelButton()!);
    rejectRun(Object.assign(new Error("请求已中止"), { aborted: true }));
    await run;

    expect(overviewText()).toContain("已取消概览生成");
    reader.ensureReaderOverviewTab();
    await Promise.resolve();
    expect(runOverviewMock).toHaveBeenCalledTimes(1);
  });

  it("closeReadingView 仍不取消在飞请求；重开同视频复用同一信号，取消键仍能取消它", async () => {
    seedClip();
    pendingRun();

    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    const firstSignal = runSignal(0);

    reader.closeReadingView();
    expect(firstSignal?.aborted).toBe(false);

    state.reader.readingViewOpen = true;
    void reader.triggerReaderOverviewGeneration();
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(2));
    expect(runSignal(1)).toBe(firstSignal);

    clickButton(cancelButton()!);
    expect(firstSignal?.aborted).toBe(true);
    expect(overviewText()).toContain("已取消概览生成");
  });
});

describe("重试/取消/失败期间的上一轮产物保留", () => {
  function chapterTitles(): string[] {
    return Array.from(overviewBody().querySelectorAll(".biliscript-reading-ov-chapter-title")).map(
      (node) => node.textContent || ""
    );
  }

  function quoteCount(): number {
    return overviewBody().querySelectorAll(".biliscript-reading-ov-quote").length;
  }

  function deferredRun(): {
    promise: Promise<OverviewAnalysis>;
    resolve: (value: OverviewAnalysis) => void;
    reject: (reason: unknown) => void;
  } {
    let resolve!: (value: OverviewAnalysis) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<OverviewAnalysis>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  it("重试进 generating 仍渲染旧产物；cancelled / error 落定也不清产物引用", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    await reader.triggerReaderOverviewGeneration();
    expect(chapterTitles()).toContain("开场");
    expect(quoteCount()).toBe(1);

    const retry = deferredRun();
    runOverviewMock.mockClear();
    runOverviewMock.mockImplementation(() => retry.promise);
    void reader.triggerReaderOverviewGeneration({ forceRefresh: true });
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect(overviewText()).toContain("正在生成概览…");
    expect(chapterTitles()).toContain("开场");
    expect(quoteCount()).toBe(1);

    bindOverviewDelegation();
    overviewBody()
      .querySelector<HTMLButtonElement>("button[data-overview-action='cancel']")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(overviewText()).toContain("已取消概览生成");
    const afterCancel = deferredRun();
    runOverviewMock.mockClear();
    runOverviewMock.mockImplementation(() => afterCancel.promise);
    void reader.triggerReaderOverviewGeneration({ forceRefresh: true });
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect(chapterTitles()).toContain("开场");
    expect(quoteCount()).toBe(1);

    afterCancel.reject(new Error("模型请求失败"));
    await vi.waitFor(() => expect(overviewText()).toContain("概览生成失败"));
    const afterError = deferredRun();
    runOverviewMock.mockClear();
    runOverviewMock.mockImplementation(() => afterError.promise);
    void reader.triggerReaderOverviewGeneration({ forceRefresh: true });
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));
    expect(chapterTitles()).toContain("开场");
    expect(quoteCount()).toBe(1);

    afterError.resolve({
      summary: "新一轮简介。",
      chapters: [{ from: 0, to: 120, title: "新一轮章节", summary: "" }],
      quotes: [{ from: 10, content: "新一轮金句" }]
    });
    await vi.waitFor(() => expect(chapterTitles()).toContain("新一轮章节"));
    expect(chapterTitles()).not.toContain("开场");
  });

  it("生成中刷新只更新状态条，保留旧结果的滚动位置、文本选区与按钮焦点", async () => {
    seedClip();
    runOverviewMock.mockResolvedValue({ ...SAMPLE_ANALYSIS });
    await reader.triggerReaderOverviewGeneration();
    expect(chapterTitles()).toContain("开场");
    expect(quoteCount()).toBe(1);

    let notifyProgress!: (notice: string) => void;
    const retry = deferredRun();
    runOverviewMock.mockClear();
    runOverviewMock.mockImplementation((_args, deps?: { onProgress?: (notice: string) => void }) => {
      notifyProgress = (notice: string) => deps?.onProgress?.(notice);
      return retry.promise;
    });

    void reader.triggerReaderOverviewGeneration({ forceRefresh: true });
    await vi.waitFor(() => expect(runOverviewMock).toHaveBeenCalledTimes(1));

    const chapterEl = overviewBody().querySelector(".biliscript-reading-ov-chapter");
    const quoteEl = overviewBody().querySelector(".biliscript-reading-ov-quote");
    const cancelBtn = overviewBody().querySelector<HTMLButtonElement>("button[data-overview-action='cancel']");
    const stripTextEl = overviewBody().querySelector<HTMLElement>(".biliscript-reading-ov-strip-text");

    expect(chapterEl).not.toBeNull();
    expect(quoteEl).not.toBeNull();
    expect(cancelBtn).not.toBeNull();
    expect(stripTextEl?.textContent).toBe("正在生成概览…");

    cancelBtn!.focus();
    expect(document.activeElement).toBe(cancelBtn);

    overviewBody().scrollTop = 150;
    expect(overviewBody().scrollTop).toBe(150);

    const quoteTextNode = quoteEl!.querySelector(".biliscript-reading-ov-quote-text")!.firstChild!;
    const range = document.createRange();
    range.setStart(quoteTextNode, 0);
    range.setEnd(quoteTextNode, 4);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("测试不是");
    expect(selection.anchorNode).toBe(quoteTextNode);

    notifyProgress("正在整理第 1/3 段（33%）");

    expect(stripTextEl?.textContent).toBe("正在整理第 1/3 段（33%）");
    expect(overviewBody().querySelector(".biliscript-reading-ov-strip-text")).toBe(stripTextEl);

    expect(overviewBody().querySelector(".biliscript-reading-ov-chapter")).toBe(chapterEl);
    expect(overviewBody().querySelector(".biliscript-reading-ov-quote")).toBe(quoteEl);
    expect(overviewBody().querySelector("button[data-overview-action='cancel']")).toBe(cancelBtn);

    expect(document.activeElement).toBe(cancelBtn);

    expect(selection.toString()).toBe("测试不是");
    expect(selection.anchorNode).toBe(quoteTextNode);
    expect(quoteTextNode.isConnected).toBe(true);

    expect(overviewBody().scrollTop).toBe(150);

    notifyProgress("正在生成概览…（已接收 1200 字）");
    expect(stripTextEl?.textContent).toBe("正在生成概览…（已接收 1200 字）");
    expect(document.activeElement).toBe(cancelBtn);
    expect(selection.toString()).toBe("测试不是");
    expect(overviewBody().scrollTop).toBe(150);

    retry.resolve({
      summary: "第二轮简介。",
      chapters: [{ from: 0, to: 120, title: "第二轮章节", summary: "" }],
      quotes: [{ from: 20, content: "第二轮金句" }]
    });
    await vi.waitFor(() => expect(chapterTitles()).toContain("第二轮章节"));
    expect(chapterTitles()).not.toContain("开场");
  });
});

