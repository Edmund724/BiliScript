// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSubtitleBody, resetModuleState } from "../setup.js";
import { installChromeHost } from "../helpers/chrome-host.js";
import {
  DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  getDefaultAiSystemPrompt
} from "../../extension/core/default-prompts.js";
import {
  buildMessages,
  getDefaultAiSystemPrompt as getContextDefaultAiSystemPrompt
} from "../../extension/ai/context.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  GIVEN_CHAPTERS_SYSTEM_PROMPT,
  OUTLINE_QUOTES_SYSTEM_PROMPT,
  STATE_RELAY_GIVEN_CHAPTERS_SYSTEM_PROMPT,
  STATE_RELAY_OUTLINE_QUOTES_SYSTEM_PROMPT,
  STATE_RELAY_SYSTEM_PROMPT,
  buildAnalysisPrompt,
  buildStateRelayStepPrompt,
  getOverviewSystemPrompt,
  getStateRelaySystemPrompt
} from "../../extension/ai/analysis-prompts.js";
import { runOverviewAnalysis } from "../../extension/ai/analysis-orchestrate.js";
import { buildExplainMessages } from "../../extension/ai/explain.js";
import {
  buildChunkSubtitleContext,
  buildSubtitleContextPromptBlock,
  cleanVideoDescription,
  extractVideoStaticContext,
  resolveRuntimeSubtitleContext
} from "../../extension/ai/subtitle-context.js";
import { runToolLoop } from "../../extension/ai/tool-loop.js";
import { streamChat } from "../../extension/ai/client.js";
import { runLadderChat, type ChatPort, type StreamChatArgs } from "../../extension/ai/ladder.js";
import { buildQuickPromptMessages } from "../../extension/chat/quick-prompts.js";
import type { ChatPortMessage } from "../../extension/chat/protocol.js";
import type { ChatCompletionInput } from "../../extension/ai/completion.js";
import type { L1VideoIndexCacheRecord } from "../../extension/ai/long-video-hybrid-types.js";
import type { ChapterItem } from "../../extension/ai/types.js";
import { clipState } from "../../extension/core/state.js";
import { createInProcessContextFetch } from "../../extension/core/context-assembly.js";
import { createSubtitleBodySlot } from "../../extension/entry/offscreen-subtitle-slot.js";
import { attachOffscreenChatPort } from "../../extension/entry/offscreen-chat-port.js";
import { createOverviewCoordinator } from "../../extension/reader/overview-coordinator.js";
import { buildL1VideoIndex } from "../../extension/ai/l1-directory.js";
import { installMinimalChromeHost } from "../helpers/chrome-runtime-host.js";

const PROVIDER = {
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  apiKey: "sk-test"
};

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true as const };
          }
        };
      }
    }
  } as unknown as Response;
}

function sseData(delta: unknown, finishReason?: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

function makePort(): ChatPort & { messages: ChatPortMessage[] } {
  const messages: ChatPortMessage[] = [];
  return {
    messages,
    postMessage(message: ChatPortMessage) {
      messages.push(message);
    }
  };
}

function emitTokens(input: Pick<ChatCompletionInput, "onEvent">, text: string): void {
  input.onEvent?.({ type: "token", data: text });
}

function createRelayMockCompletion() {
  const calls: ChatCompletionInput[] = [];
  const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
    calls.push(input);
    const sys = input.messages[0].content;
    if (sys.includes("提炼全片总体脉络简介")) {
      emitTokens(input, JSON.stringify({ summary: "全片总结。" }));
    } else {
      emitTokens(
        input,
        JSON.stringify({
          chapters: [{ title: "窗口章", timestampSeconds: 0, summary: "要点", keyEntities: ["Entity"] }],
          keyQuotes: [{ startLine: 0, endLine: 0 }],
          nextStateCard: { rollingSummary: "主线", openThreads: [], confirmedEntities: ["Entity"] }
        })
      );
    }
    return { done: true, finishReason: "stop" } as const;
  });
  return { calls, chatCompletion };
}

function createYoutubeFrameGateFetch() {
  const requests: Array<{ tools?: Array<{ function: { name: string } }>; messages: unknown[] }> = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || "{}"));
    requests.push(body);
    if (requests.length === 1) {
      return sseResponse([
        sseData({
          tool_calls: [
            {
              index: 0,
              id: "bad_hist_1",
              type: "function",
              function: { name: "capture_video_frame_at_time", arguments: '{"targetTime":42}' }
            }
          ]
        }),
        sseData({}, "tool_calls")
      ]);
    }
    if (requests.length === 2) {
      return sseResponse([
        sseData({
          tool_calls: [
            {
              index: 0,
              id: "ok_curr_1",
              type: "function",
              function: { name: "capture_current_video_frame", arguments: "{}" }
            }
          ]
        }),
        sseData({}, "tool_calls")
      ]);
    }
    return sseResponse([sseData({ content: "当前帧回答完成" }), sseData({}, "stop")]);
  });
  return { requests, fetchImpl };
}

beforeEach(() => {
  resetModuleState();
  installChromeHost();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("默认 AI 系统提示词与对话上下文站点参数化", () => {
  it("getDefaultAiSystemPrompt 保持 B 站向后兼容并为 YouTube 替换平台与作者措辞", () => {
    expect(getContextDefaultAiSystemPrompt).toBe(getDefaultAiSystemPrompt);
    expect(getDefaultAiSystemPrompt()).toBe(DEFAULT_AI_SYSTEM_PROMPT);
    expect(getDefaultAiSystemPrompt("bilibili")).toBe(DEFAULT_AI_SYSTEM_PROMPT);

    const ytPrompt = getDefaultAiSystemPrompt("youtube");
    expect(ytPrompt).toContain("YouTube 视频");
    expect(ytPrompt).toContain("频道作者");
    expect(ytPrompt).not.toContain("B 站");
    expect(ytPrompt).not.toContain("UP 主");
  });

  it("buildMessages：未定制或命中归一化内置默认时按 site 切换提示词，用户自定义原封不动保留", () => {
    const ytImplicit = buildMessages({
      context: { site: "youtube", title: "Attention Is All You Need", author: "Two Minute Papers" },
      userPrompt: "总结一下"
    });
    expect(ytImplicit[0].content).toContain("YouTube 视频");
    expect(ytImplicit[0].content).toContain("频道作者");
    expect(ytImplicit[0].content).not.toContain("B 站");
    expect(ytImplicit[0].content).not.toContain("UP 主");

    const ytFromNormalizedDefault = buildMessages({
      context: { site: "youtube", title: "Demo" },
      systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
      userPrompt: "继续"
    });
    expect(ytFromNormalizedDefault[0].content).toContain("YouTube 视频");
    expect(ytFromNormalizedDefault[0].content).not.toContain("B 站");

    const ytFromLegacyDefault = buildMessages({
      context: { site: "youtube", title: "Demo" },
      systemPrompt: LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
      userPrompt: "继续"
    });
    expect(ytFromLegacyDefault[0].content).toContain("YouTube 视频");
    expect(ytFromLegacyDefault[0].content).not.toContain("B 站");

    const ytInferredFromUrl = buildMessages({
      context: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "Demo" },
      systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
      userPrompt: "继续"
    });
    expect(ytInferredFromUrl[0].content).toContain("YouTube 视频");

    const custom = "自定义系统提示词：永远只列三点，保持 UP 主原话风格。";
    const ytCustom = buildMessages({
      context: { site: "youtube", title: "Demo" },
      systemPrompt: custom,
      userPrompt: "总结"
    });
    expect(String(ytCustom[0].content).startsWith(`${custom}\n\n`)).toBe(true);

    const biliDefault = buildMessages({
      context: { site: "bilibili", title: "B站视频" },
      systemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
      userPrompt: "总结"
    });
    expect(biliDefault[0].content).toContain("B 站视频");
    expect(biliDefault[0].content).toContain("UP 主");
  });
});

describe("概览提示词、状态卡、作者标签与分章/热评策略", () => {
  it("概览与状态卡系统提示词在 YouTube 去除 B 站表述并调整自动字幕说明", () => {
    expect(getOverviewSystemPrompt({ site: "bilibili" })).toBe(ANALYSIS_SYSTEM_PROMPT);
    expect(getOverviewSystemPrompt({ site: "bilibili", hasGivenChapters: true })).toBe(GIVEN_CHAPTERS_SYSTEM_PROMPT);
    expect(getOverviewSystemPrompt({ site: "bilibili", hasGivenChapters: true, titlesOnly: true })).toBe(
      OUTLINE_QUOTES_SYSTEM_PROMPT
    );

    expect(getStateRelaySystemPrompt({ site: "bilibili" })).toBe(STATE_RELAY_SYSTEM_PROMPT);
    expect(getStateRelaySystemPrompt({ site: "bilibili", hasGivenChapters: true })).toBe(
      STATE_RELAY_GIVEN_CHAPTERS_SYSTEM_PROMPT
    );
    expect(getStateRelaySystemPrompt({ site: "bilibili", hasGivenChapters: true, titlesOnly: true })).toBe(
      STATE_RELAY_OUTLINE_QUOTES_SYSTEM_PROMPT
    );

    const ytFree = getOverviewSystemPrompt({ site: "youtube" });
    const ytGiven = getOverviewSystemPrompt({ site: "youtube", hasGivenChapters: true });
    const ytQuotes = getOverviewSystemPrompt({ site: "youtube", hasGivenChapters: true, titlesOnly: true });
    const ytRelay = getStateRelaySystemPrompt({ site: "youtube" });
    const ytRelayGiven = getStateRelaySystemPrompt({ site: "youtube", hasGivenChapters: true });
    const ytRelayQuotes = getStateRelaySystemPrompt({ site: "youtube", hasGivenChapters: true, titlesOnly: true });

    expect(ytFree).toContain("YouTube 视频");
    expect(ytFree).toContain("YouTube 的自动字幕");
    expect(ytFree).not.toContain("B 站");
    expect(ytGiven).toContain("YouTube 视频");
    expect(ytGiven).not.toContain("B 站");
    expect(ytQuotes).toContain("YouTube 视频");
    expect(ytQuotes).not.toContain("B 站");
    expect(ytRelay).toContain("YouTube 视频");
    expect(ytRelay).not.toContain("B 站");
    expect(ytRelayGiven).toContain("YouTube 视频");
    expect(ytRelayGiven).not.toContain("B 站");
    expect(ytRelayQuotes).toContain("YouTube 视频");
    expect(ytRelayQuotes).not.toContain("B 站");
  });

  it("buildAnalysisPrompt 与 buildStateRelayStepPrompt 按站点渲染 UP 主 vs 频道作者", () => {
    const outline = [
      { seconds: 0, title: "Intro" },
      { seconds: 60, title: "Core" }
    ];
    const ytPrompt = buildAnalysisPrompt({
      site: "youtube",
      title: "YT Talk",
      ownerName: "Veritasium",
      items: [{ from: 0, to: 10, content: "Hello" }],
      chapterOutline: outline
    });
    expect(ytPrompt.prompt).toContain("频道作者：Veritasium");
    expect(ytPrompt.prompt).toContain("来自视频章节/简介，共 2 章");
    expect(ytPrompt.prompt).not.toContain("UP 主");

    const biliPrompt = buildAnalysisPrompt({
      site: "bilibili",
      title: "B 站视频",
      ownerName: "老番茄",
      items: [{ from: 0, to: 10, content: "大家好" }],
      chapterOutline: outline
    });
    expect(biliPrompt.prompt).toContain("UP 主：老番茄");
    expect(biliPrompt.prompt).toContain("来自视频章节/简介/评论，共 2 章");

    const ytRelayStep = buildStateRelayStepPrompt({
      site: "youtube",
      title: "Long YT",
      ownerName: "3Blue1Brown",
      window: {
        windowIndex: 0,
        fromSeconds: 0,
        toSeconds: 600,
        startLineNumber: 0,
        endLineNumber: 1,
        chars: 10,
        lines: [{ lineNumber: 0, from: 0, to: 10, content: "Linear algebra" }],
        overlapLines: []
      },
      totalWindows: 2,
      previousStateCard: null,
      chapterOutline: outline
    });
    expect(ytRelayStep.prompt).toContain("频道作者：3Blue1Brown");
    expect(ytRelayStep.prompt).not.toContain("UP 主");
  });

  it("runOverviewAnalysis 在 YouTube 支持热评目录并维持分章优先级（简介/热评目录 > 官方/自动章节 > 自由分章）", async () => {
    const calls: ChatCompletionInput[] = [];
    const chatCompletion = vi.fn(async (input: ChatCompletionInput) => {
      calls.push(input);
      emitTokens(
        input,
        JSON.stringify({
          summary: "概览简介。",
          chapters: [
            { title: "模型自拟章", timestampSeconds: 10, summary: "模型章说明" },
            { title: "官方章节二", timestampSeconds: 120, summary: "官方二说明" }
          ],
          keyQuotes: [{ quote: "Hello", timestampSeconds: 0 }]
        })
      );
      return { done: true, finishReason: "stop" } as const;
    });

    const hotCommentsWithOutline = [
      { uname: "commenter", like: 100, message: "00:00 热评第一章\n02:00 热评第二章" }
    ];
    const officialChapters: ChapterItem[] = [
      { from: 0, to: 120, title: "官方第一章" },
      { from: 120, to: 300, title: "官方第二章" }
    ];
    const body = [
      { from: 0, to: 10, content: "Hello" },
      { from: 120, to: 130, content: "World" }
    ];

    const fromDescription = await runOverviewAnalysis(
      {
        provider: PROVIDER,
        forceRefresh: true,
        context: {
          site: "youtube",
          bvid: "dQw4w9WgXcQ",
          cid: "yt",
          title: "YT Priority 1",
          author: "Channel A",
          videoDescription: "00:00 简介第一章\n01:30 简介第二章",
          hotComments: [],
          chapters: officialChapters,
          subtitleBody: body,
          videoDuration: 300
        }
      },
      { chatCompletion }
    );
    expect(fromDescription.chapters.map((c) => c.title)).toEqual(["简介第一章", "简介第二章"]);
    expect(calls[0].messages[0].content).toContain("YouTube 视频");
    expect(calls[0].messages[0].content).not.toContain("B 站");
    expect(calls[0].messages[1].content).toContain("频道作者：Channel A");

    calls.length = 0;
    const fromHotComment = await runOverviewAnalysis(
      {
        provider: PROVIDER,
        forceRefresh: true,
        context: {
          site: "youtube",
          bvid: "dQw4w9WgXcH",
          cid: "yt",
          title: "YT Priority HotComment",
          author: "Channel H",
          videoDescription: "普通简介，无时间轴",
          hotComments: hotCommentsWithOutline,
          chapters: officialChapters,
          subtitleBody: body,
          videoDuration: 300
        }
      },
      { chatCompletion }
    );
    expect(fromHotComment.chapters.map((c) => c.title)).toEqual(["热评第一章", "热评第二章"]);

    calls.length = 0;
    const fromOfficial = await runOverviewAnalysis(
      {
        provider: PROVIDER,
        forceRefresh: true,
        context: {
          site: "youtube",
          bvid: "dQw4w9WgXc2",
          cid: "yt",
          title: "YT Priority 2",
          author: "Channel B",
          videoDescription: "普通简介，无时间轴",
          hotComments: [],
          chapters: officialChapters,
          subtitleBody: body,
          videoDuration: 300
        }
      },
      { chatCompletion }
    );
    expect(fromOfficial.chapters.map((c) => c.title)).toEqual(["官方第一章", "官方第二章"]);

    calls.length = 0;
    const fromAiFree = await runOverviewAnalysis(
      {
        provider: PROVIDER,
        forceRefresh: true,
        context: {
          site: "youtube",
          bvid: "dQw4w9WgXc3",
          cid: "yt",
          title: "YT Priority 3",
          author: "Channel C",
          videoDescription: "普通简介，无时间轴",
          hotComments: [],
          chapters: [],
          subtitleBody: body,
          videoDuration: 300
        }
      },
      { chatCompletion }
    );
    expect(fromAiFree.chapters.map((c) => c.title)).toEqual(["模型自拟章", "官方章节二"]);
    expect(calls[0].messages[0].content).toContain("YouTube 的自动字幕");
  });

  it("runOverviewAnalysis 长视频状态卡接力路径在 YouTube 使用 YouTube 状态卡提示词与频道作者", async () => {
    const { calls, chatCompletion } = createRelayMockCompletion();
    const body = makeSubtitleBody(210000);

    await runOverviewAnalysis(
      {
        provider: PROVIDER,
        forceRefresh: true,
        context: {
          site: "youtube",
          bvid: "LongYT12345",
          cid: "yt",
          title: "Long YouTube Lecture",
          author: "MIT OpenCourseWare",
          subtitleBody: body,
          videoDuration: 2400
        }
      },
      { chatCompletion }
    );

    const stepCalls = calls.filter((call) => !call.messages[0].content.includes("提炼全片总体脉络简介"));
    expect(stepCalls.length).toBeGreaterThan(0);
    expect(stepCalls[0].messages[0].content).toContain("YouTube 视频");
    expect(stepCalls[0].messages[0].content).not.toContain("B 站");
    expect(stepCalls[0].messages[1].content).toContain("频道作者：MIT OpenCourseWare");
    expect(stepCalls[0].messages[1].content).not.toContain("UP 主");
  });

  it("createOverviewCoordinator 在 YouTube 传递 site 与热评", async () => {
    const runOverviewAnalysisMock = vi.fn(async (_input: { context: Record<string, unknown> }) => ({
      summary: "OK",
      chapters: [{ from: 0, to: 60, title: "热评一", summary: "说明" }],
      quotes: []
    }));
    const clip = {
      site: "youtube" as const,
      bvid: "dQw4w9WgXcQ",
      cid: "yt",
      aid: "",
      title: "YT Clip",
      author: "Creator",
      description: "无时间轴简介",
      hotComments: [{ uname: "User", like: 99, message: "00:00 热评一\n00:30 热评二" }],
      videoDuration: 60,
      selectedSubtitleLang: "en",
      selectedSubtitleId: "sub-en",
      selectedSubtitleUrl: "",
      subtitleBody: [{ from: 0, to: 10, content: "Hello" }],
      chapters: [] as ChapterItem[]
    };
    const coordinator = createOverviewCoordinator({
      getClip: () => clip,
      isReadingViewOpen: () => false,
      resolveProvider: async () => PROVIDER,
      loadAnalysis: async () => ({ runOverviewAnalysis: runOverviewAnalysisMock }) as unknown as typeof import("../../extension/ai/analysis.js"),
      confirm: async () => true,
      registerUiActions: () => {},
      now: () => 0,
      setInterval,
      clearInterval
    });

    await coordinator.trigger();

    expect(runOverviewAnalysisMock).toHaveBeenCalledTimes(1);
    const args = runOverviewAnalysisMock.mock.calls[0][0];
    expect(args.context.site).toBe("youtube");
    expect(args.context.hotComments).toEqual(clip.hotComments);
    expect(coordinator.getSnapshot().aiChapters).toBe(false);
  });
});

describe("划词解释与快捷提问站点参数化", () => {
  it("buildExplainMessages 按 site 参数化且 YouTube 无 B 站表述", () => {
    const ytPlain = buildExplainMessages({
      site: "youtube",
      videoTitle: "Transformers Explained",
      selection: "Self-Attention",
      line: "Self-Attention computes pairwise weights.",
      from: 12
    });
    expect(ytPlain[0].content).toContain("YouTube 视频");
    expect(ytPlain[0].content).not.toContain("B 站");

    const ytSearch = buildExplainMessages({
      site: "youtube",
      videoTitle: "Transformers Explained",
      selection: "Self-Attention",
      line: "Self-Attention computes pairwise weights.",
      from: 12,
      webSearch: {
        maxToolCalls: 2,
        executeSearch: async () => ({ results: [], platform: "Tavily" })
      }
    });
    expect(ytSearch[0].content).toContain("YouTube 视频");
    expect(ytSearch[0].content).toContain("web_search");
    expect(ytSearch[0].content).not.toContain("B 站");

    const biliPlain = buildExplainMessages({
      site: "bilibili",
      videoTitle: "测试",
      selection: "词",
      line: "句",
      from: 0
    });
    expect(biliPlain[0].content).toContain("B 站视频");
  });

  it("openReaderExplainCard 在 YouTube 页面下向 explainSelection 传递 site='youtube'", async () => {
    vi.resetModules();
    const explainSelectionSpy = vi.fn(async (_input: Record<string, unknown>) => "Explain output");
    vi.doMock("../../extension/ai/explain.js", () => ({
      explainSelection: explainSelectionSpy
    }));
    vi.doMock("../../extension/ai/active-provider.js", () => ({
      resolveActiveProvider: vi.fn(async () => PROVIDER)
    }));
    vi.doMock("../../extension/search/opt-in-notice.js", () => ({
      resolveWebSearchOptIn: vi.fn(async () => "declined")
    }));
    vi.doMock("../../extension/search/search-runtime.js", () => ({
      resolveWebSearchRuntime: vi.fn(async () => ({}))
    }));

    const { clipState: freshClipState } = await import("../../extension/core/state.js");
    const { ids } = await import("../../extension/reader/state.js");
    const { openReaderExplainCard, closeReaderExplainCard } = await import("../../extension/reader/explain-card.js");

    document.body.innerHTML = `<div id="${ids.readingExplainCard}" hidden></div>`;
    freshClipState.setSite("youtube");
    freshClipState.setTitle("YouTube Explain Test");
    freshClipState.setSubtitleBody([{ from: 0, to: 5, content: "Hello world" }]);

    openReaderExplainCard({
      selection: "Hello",
      line: "Hello world",
      from: 0,
      index: 0
    });

    await vi.waitFor(() => expect(explainSelectionSpy).toHaveBeenCalledTimes(1));
    expect(explainSelectionSpy.mock.calls[0][0]).toMatchObject({
      site: "youtube",
      videoTitle: "YouTube Explain Test",
      selection: "Hello"
    });
    closeReaderExplainCard({ restoreFocus: false });
    document.body.innerHTML = "";
    vi.doUnmock("../../extension/ai/explain.js");
    vi.doUnmock("../../extension/ai/active-provider.js");
    vi.doUnmock("../../extension/search/opt-in-notice.js");
    vi.doUnmock("../../extension/search/search-runtime.js");
    vi.resetModules();
  });

  it("buildQuickPromptMessages 与 warmUpInitialQuickPrompts 在 YouTube 去除 B 站表述", async () => {
    const ytMsgs = buildQuickPromptMessages({
      site: "youtube",
      title: "Why Planes Fly",
      excerpt: "Bernoulli and Newton both help explain lift."
    });
    expect(ytMsgs[0].content).toContain("YouTube 视频阅读扩展");
    expect(ytMsgs[0].content).not.toContain("B 站");

    const biliMsgs = buildQuickPromptMessages({
      title: "为什么飞机能飞",
      excerpt: "伯努利原理"
    });
    expect(biliMsgs[0].content).toContain("B 站视频阅读扩展");

    vi.resetModules();
    const completionSpy = vi.fn(async (input: ChatCompletionInput) => {
      input.onEvent?.({ type: "token", data: '["升力原理是什么","伯努利够用吗","失速怎么发生"]' });
      return { done: true, finishReason: "stop" } as const;
    });
    vi.doMock("../../extension/ai/completion.js", () => ({
      chatCompletion: completionSpy
    }));
    vi.doMock("../../extension/ai/active-provider.js", () => ({
      resolveActiveProvider: vi.fn(async () => PROVIDER)
    }));
    vi.doMock("../../extension/core/provider-http-offscreen.js", () => ({
      providerFetchViaOffscreen: vi.fn()
    }));

    const { warmUpInitialQuickPrompts } = await import("../../extension/reader/quick-prompts.js");
    await warmUpInitialQuickPrompts({
      bvid: "ytQuick1234",
      cid: "yt",
      title: "Why Planes Fly",
      subtitleBody: [{ from: 0, to: 5, content: "Lift comes from airflow deflection." }]
    });

    expect(completionSpy).toHaveBeenCalledTimes(1);
    const sentMessages = completionSpy.mock.calls[0][0].messages;
    expect(sentMessages[0].content).toContain("YouTube 视频阅读扩展");
    expect(sentMessages[0].content).not.toContain("B 站");
    vi.doUnmock("../../extension/ai/completion.js");
    vi.doUnmock("../../extension/ai/active-provider.js");
    vi.doUnmock("../../extension/core/provider-http-offscreen.js");
    vi.resetModules();
  });
});

describe("简介清洗与字幕上下文标签站点参数化", () => {
  it("cleanVideoDescription 在 YouTube 跳过 b23.tv、一键三连/投币抽奖规则，在 B 站照常清洗", () => {
    const raw = [
      "相关资料：https://example.com/docs 与 www.example.org/ref",
      "短链示例 b23.tv/BV1xx411c7mD 仍保留于科普说明中",
      "一键三连抽 2 位送大会员！",
      "互动抽奖：关注+投币+转发抽奖送礼品",
      "核心内容：讲解神经网络的反向传播推导。"
    ].join("\n");

    const ytCleaned = cleanVideoDescription(raw, "youtube");
    expect(ytCleaned).not.toContain("https://example.com");
    expect(ytCleaned).not.toContain("www.example.org");
    expect(ytCleaned).toContain("b23.tv/BV1xx411c7mD");
    expect(ytCleaned).toContain("一键三连抽 2 位送大会员");
    expect(ytCleaned).toContain("互动抽奖");
    expect(ytCleaned).toContain("核心内容：讲解神经网络的反向传播推导。");

    const ytCapped = cleanVideoDescription("b23.tv/abc 这里是一段比较长的说明文字用于截断测试", "youtube", 18);
    expect(ytCapped).toContain("b23.tv/abc");
    expect(ytCapped.length).toBeLessThanOrEqual(18);

    const biliCleaned = cleanVideoDescription(raw, "bilibili");
    expect(biliCleaned).not.toContain("b23.tv");
    expect(biliCleaned).not.toContain("一键三连");
    expect(biliCleaned).not.toContain("互动抽奖");
    expect(biliCleaned).toContain("核心内容：讲解神经网络的反向传播推导。");
  });

  it("extractVideoStaticContext、buildSubtitleContextPromptBlock 与 resolveRuntimeSubtitleContext 按站点切换作者标签与清洗规则", async () => {
    const ytStatic = extractVideoStaticContext({
      site: "youtube",
      title: "Compiler Design",
      author: "Computerphile",
      description: "讨论 b23.tv/demo 与一键三连抽 1 位案例。官网：https://example.com"
    });
    expect(ytStatic).toEqual({
      title: "Compiler Design",
      ownerName: "Computerphile",
      description: "讨论 b23.tv/demo 与一键三连抽 1 位案例。"
    });

    const ytBlock = buildSubtitleContextPromptBlock({
      site: "youtube",
      title: "Compiler Design",
      ownerName: "Computerphile",
      description: "参考 b23.tv/demo"
    });
    expect(ytBlock).toContain("频道作者：Computerphile");
    expect(ytBlock).not.toContain("UP 主");
    expect(ytBlock).toContain("b23.tv/demo");

    const chunkCtx = buildChunkSubtitleContext(
      { site: "youtube", title: "Compiler Design", ownerName: "Computerphile" },
      "Parser"
    );
    expect(chunkCtx?.site).toBe("youtube");

    clipState.setSite("youtube");
    clipState.setBvid("ytClip12345");
    clipState.setCid("yt");
    clipState.setTitle("Live YT");
    clipState.setAuthor("3Blue1Brown");
    clipState.setDescription("说明 b23.tv/abc 与 https://math.example.com");
    clipState.setSubtitleBody([{ from: 0, to: 5, content: "Math" }]);

    const runtimeCtx = await resolveRuntimeSubtitleContext();
    expect(runtimeCtx?.site).toBe("youtube");
    expect(runtimeCtx?.description).toBe("说明 b23.tv/abc 与");
    const runtimeBlock = buildSubtitleContextPromptBlock(runtimeCtx);
    expect(runtimeBlock).toContain("频道作者：3Blue1Brown");
    expect(runtimeBlock).not.toContain("UP 主");
  });
});

describe("YouTube 当前帧独占截帧门控与热评禁用（tool-loop / client / ladder）", () => {
  it("runToolLoop includeHistoricalFrameTool=false 时仅注册当前帧工具，并拒绝越权历史帧调用", async () => {
    const { requests, fetchImpl } = createYoutubeFrameGateFetch();
    const captureCurrentVideoFrame = vi.fn(async (request?: unknown) => {
      expect(request).toBeUndefined();
      return {
        image: { mime: "image/jpeg", data: "Q1VSUkVOVA==" },
        currentTime: 15
      };
    });

    await runToolLoop({
      requestProfile: {
        provider: PROVIDER,
        fetchImpl,
        includeWebSearchTool: false,
        includeHistoricalFrameTool: false
      },
      messages: [{ role: "user", content: "看看当前画面" }],
      maxToolCalls: 2,
      executeSearch: async () => ({ results: [], platform: "Tavily" }),
      captureCurrentVideoFrame
    });

    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(["capture_current_video_frame"]);
    expect(requests[1].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "bad_hist_1",
          content: expect.stringContaining("不支持历史时间点截帧")
        })
      ])
    );
    expect(captureCurrentVideoFrame).toHaveBeenCalledTimes(1);
    expect(captureCurrentVideoFrame).toHaveBeenCalledWith();
    expect(requests[2].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "ok_curr_1",
          content: "已截取视频在 0:15 的画面。"
        })
      ])
    );
  });

  it("streamChat 在 YouTube 下仅注入当前帧与联网工具，剥离历史帧工具与热评工具", async () => {
    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body || "{}")));
        return sseResponse([sseData({ content: "完成" }), sseData({}, "stop")]);
      })
    );
    const captureCurrentVideoFrame = vi.fn(async () => ({
      image: { mime: "image/jpeg", data: "QUJD" },
      currentTime: 10
    }));
    const fetchHotComments = vi.fn(async () => [{ uname: "u", like: 1, message: "m" }]);

    await streamChat({
      provider: PROVIDER,
      context: { site: "youtube", title: "YT", subtitleBody: [{ from: 0, to: 5, content: "Hi" }] },
      userPrompt: "看下画面和评论",
      history: [],
      port: makePort(),
      webSearch: {
        maxToolCalls: 2,
        executeSearch: async () => ({ results: [], platform: "Tavily" })
      },
      captureCurrentVideoFrame,
      fetchHotComments
    });

    expect(requests[0].tools?.map((t) => t.function.name)).toEqual([
      "web_search",
      "capture_current_video_frame",
      "capture_video_frame_at_time",
      "fetch_hot_comments"
    ]);
    expect(fetchHotComments).not.toHaveBeenCalled();

    requests.length = 0;
    await streamChat({
      provider: PROVIDER,
      context: { site: "youtube", title: "YT", subtitleBody: [] },
      userPrompt: "评论区怎么说",
      history: [],
      port: makePort(),
      fetchHotComments
    });
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual(["fetch_hot_comments"]);

    requests.length = 0;
    await streamChat({
      provider: PROVIDER,
      context: { site: "bilibili", title: "B站", subtitleBody: [] },
      userPrompt: "看下画面和评论",
      history: [],
      port: makePort(),
      webSearch: {
        maxToolCalls: 2,
        executeSearch: async () => ({ results: [], platform: "Tavily" })
      },
      captureCurrentVideoFrame,
      fetchHotComments
    });
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual([
      "web_search",
      "capture_current_video_frame",
      "capture_video_frame_at_time",
      "fetch_hot_comments"
    ]);
  });

  it("runLadderChat 在 YouTube 混合长视频与常规路径启用历史三帧自动探测与当前帧工具", async () => {
    const body = [
      { from: 0, to: 10, content: "开场讲架构图" },
      { from: 120, to: 130, content: "这里的公式和黑板推导很关键" }
    ];
    const l1Index: L1VideoIndexCacheRecord = buildL1VideoIndex({
      bvid: "yt~LongYT12345",
      cid: "yt",
      subtitleId: "en",
      subtitleLang: "en",
      subtitleSignature: "sig-yt",
      videoDuration: 3600,
      globalSummary: "讲解架构图与数学推导。",
      lines: body,
      chapters: [
        { from: 0, to: 100, title: "开场", coreThesis: "总体概述", keyEntities: ["架构"] },
        { from: 100, to: 3600, title: "核心推导", coreThesis: "黑板推导细节", keyEntities: ["公式"] }
      ]
    });

    const captureCurrentVideoFrame = vi.fn(async () => ({
      image: { mime: "image/jpeg", data: "Q1VSUg==" },
      currentTime: 125
    }));
    const fetchHotComments = vi.fn(async () => [{ uname: "u", like: 1, message: "c" }]);
    const streamCalls: StreamChatArgs[] = [];
    const ytPort = makePort();

    await runLadderChat(
      {
        msg: {
          context: {
            site: "youtube",
            bvid: "LongYT12345",
            cid: "yt",
            title: "Long YT",
            videoDuration: 3600,
            subtitleBody: body,
            chapters: [],
            l1Index
          },
          history: [],
          prompt: "02:00 这里的黑板公式写的是什么？",
          thinkingLevel: "off"
        },
        provider: PROVIDER,
        port: ytPort,
        signal: null,
        captureCurrentVideoFrame,
        fetchHotComments
      },
      {
        askCostGuard: async () => true,
        streamChat: vi.fn(async (args: StreamChatArgs) => {
          streamCalls.push(args);
          return { done: true as const };
        })
      }
    );

    expect(captureCurrentVideoFrame).toHaveBeenCalledWith(
      { times: [120], spanSeconds: 0, maxFrames: 1 },
      undefined
    );
    expect(ytPort.messages.some((m) => m.type === "tool-status" && m.tool === "capture_video_frame_at_time")).toBe(true);
    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].captureCurrentVideoFrame).toBe(captureCurrentVideoFrame);
    expect(streamCalls[0].initialFramesUsed).toBe(1);
    expect(streamCalls[0].userImages).toHaveLength(1);
    expect(streamCalls[0].fetchHotComments).toBe(fetchHotComments);

    const directCalls: StreamChatArgs[] = [];
    await runLadderChat(
      {
        msg: {
          context: {
            site: "youtube",
            bvid: "ShortYT1234",
            cid: "yt",
            title: "Short YT",
            videoDuration: 120,
            subtitleBody: body,
            chapters: []
          },
          history: [],
          prompt: "总结一下",
          thinkingLevel: "off"
        },
        provider: PROVIDER,
        port: makePort(),
        signal: null,
        captureCurrentVideoFrame,
        fetchHotComments
      },
      {
        askCostGuard: async () => true,
        streamChat: vi.fn(async (args: StreamChatArgs) => {
          directCalls.push(args);
          return { done: true as const };
        })
      }
    );

    expect(directCalls).toHaveLength(1);
    expect(directCalls[0].captureCurrentVideoFrame).toBe(captureCurrentVideoFrame);
    expect(directCalls[0].fetchHotComments).toBe(fetchHotComments);

    const biliPort = makePort();
    const biliCalls: StreamChatArgs[] = [];
    const biliCapture = vi.fn(async () => [
      { image: { mime: "image/jpeg", data: "RjE=" }, currentTime: 118 },
      { image: { mime: "image/jpeg", data: "RjI=" }, currentTime: 120 },
      { image: { mime: "image/jpeg", data: "RjM=" }, currentTime: 122 }
    ]);
    await runLadderChat(
      {
        msg: {
          context: {
            site: "bilibili",
            bvid: "BV1long12345",
            cid: "100",
            title: "Long Bilibili",
            videoDuration: 3600,
            subtitleBody: body,
            chapters: [],
            l1Index
          },
          history: [],
          prompt: "02:00 这里的黑板公式写的是什么？",
          thinkingLevel: "off"
        },
        provider: PROVIDER,
        port: biliPort,
        signal: null,
        captureCurrentVideoFrame: biliCapture,
        fetchHotComments
      },
      {
        askCostGuard: async () => true,
        streamChat: vi.fn(async (args: StreamChatArgs) => {
          biliCalls.push(args);
          return { done: true as const };
        })
      }
    );

    expect(biliCapture).toHaveBeenCalledWith(
      { times: [120], spanSeconds: 0, maxFrames: 1 },
      undefined
    );
    expect(biliPort.messages.some((m) => m.type === "tool-status" && m.tool === "capture_video_frame_at_time")).toBe(true);
    expect(biliCalls[0].fetchHotComments).toBe(fetchHotComments);
    expect(biliCalls[0].captureCurrentVideoFrame).toBe(biliCapture);
    expect(biliCalls[0].initialFramesUsed).toBe(1);
    expect(biliCalls[0].userImages).toHaveLength(1);
  });

  it("全链路集成：context-assembly → offscreen-chat-port → runLadderChat → streamChat → runToolLoop 在 YouTube 下禁历史帧与热评且保留当前帧", async () => {
    installMinimalChromeHost({
      preserveExisting: true,
      replies: {
        "check-provider-origin": () => ({ granted: true, status: "granted" }),
        "resolve-ai-provider": () => ({
          ok: true,
          provider: {
            id: "prov-yt",
            presetId: "custom",
            name: "Test",
            baseUrl: "https://api.example.com/v1",
            model: "test-model",
            enabled: true
          },
          apiKey: "sk-test"
        })
      }
    });

    const requests: Array<{ tools?: Array<{ function: { name: string } }> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        const parsed = JSON.parse(String(init?.body || "{}"));
        requests.push(parsed);
        return sseResponse([sseData({ content: "已结合当前画面回答。" }), sseData({}, "stop")]);
      })
    );

    const subtitleBody = [
      { from: 0, to: 10, content: "开场白" },
      { from: 120, to: 135, content: "这里展示公式板书" }
    ];
    const l1Index = buildL1VideoIndex({
      bvid: "yt~_a_b-C12_34",
      cid: "yt",
      subtitleId: "en",
      subtitleLang: "en",
      subtitleSignature: "sig-chain1",
      videoDuration: 3600,
      globalSummary: "讲解板书推导。",
      lines: subtitleBody,
      chapters: [
        { from: 0, to: 100, title: "开场", coreThesis: "开场", keyEntities: ["开场"] },
        { from: 100, to: 3600, title: "推导", coreThesis: "板书", keyEntities: ["公式"] }
      ]
    });

    const fetchHotComments = vi.fn(async () => [{ uname: "u", like: 10, message: "hot" }]);
    const fetchContext = createInProcessContextFetch({
      url: () => "https://www.youtube.com/watch?v=_a_b-C12_34",
      clip: () => ({
        site: "youtube",
        bvid: "_a_b-C12_34",
        cid: "yt",
        aid: "999999",
        title: "YT Chain 1",
        author: "Channel",
        subtitleFetchState: "ready",
        selectedSubtitleId: "en",
        selectedSubtitleUrl: "https://www.youtube.com/api/timedtext?v=_a_b-C12_34",
        selectedSubtitleLang: "English",
        subtitleBody,
        videoDuration: 3600,
        chapters: []
      }),
      fetchHotComments
    });
    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("payload");
    const payload = (outcome as { payload: Record<string, unknown> }).payload;
    expect(payload.site).toBe("youtube");
    expect(payload.hotComments).toEqual([{ uname: "u", like: 10, message: "hot" }]);

    const messageListeners: Array<(msg: unknown) => void> = [];
    const postedMessages: Array<Record<string, unknown>> = [];
    const port = {
      name: "offscreen-chat",
      onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
      onDisconnect: { addListener: vi.fn() },
      postMessage: vi.fn((m: Record<string, unknown>) => {
        postedMessages.push(m);
        if (m.type === "video-frame-request") {
          queueMicrotask(() => {
            messageListeners[0]({
              action: "video-frame-result",
              requestId: m.requestId,
              ok: true,
              frames: [
                { image: { mime: "image/jpeg", data: "Q1VSUg==" }, currentTime: 118 },
                { image: { mime: "image/jpeg", data: "Q1VSUg==" }, currentTime: 120 },
                { image: { mime: "image/jpeg", data: "Q1VSUg==" }, currentTime: 122 }
              ]
            });
          });
        }
      })
    } as unknown as chrome.runtime.Port;

    attachOffscreenChatPort(port, {
      subtitleSlot: createSubtitleBodySlot(),
      loadLadder: async () => runLadderChat
    });

    messageListeners[0]({
      action: "chat",
      providerId: "prov-yt",
      model: "test-model",
      videoFrameToolEnabled: true,
      contextKey: "video:youtube:_a_b-C12_34",
      context: { ...payload, l1Index },
      prompt: "02:00 这里的黑板公式写的是什么？",
      thinkingLevel: "off",
      history: []
    });

    await vi.waitFor(() =>
      expect(postedMessages.some((m) => m.type === "done")).toBe(true)
    );

    expect(postedMessages.some((m) => m.type === "video-frame-request")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].tools?.map((t) => t.function.name)).toEqual([
      "capture_current_video_frame",
      "capture_video_frame_at_time",
      "fetch_hot_comments"
    ]);
  });
});
