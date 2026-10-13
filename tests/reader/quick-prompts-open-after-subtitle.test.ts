// tests/reader/quick-prompts-open-after-subtitle.test.ts
// 建议区「打开面板后一直停在固定三条兜底」的回归：页面预抓取先落定字幕、用户随后
// 才打开文摘面板时，建议区必须仍能拿到本视频生成的问题。
//
// 触发源事实：预热（reader/quick-prompts.ts）只有两个起跑点——subtitle-ready 通知
// 与抓取落定对账，两者都在 `state.reader.readingViewOpen` 为真时才判定。面板打开
// 晚于字幕落定（预抓取已结束，不会再有 subtitle-ready；isSubtitleInHandOrInFlight
// 让对账链当拍退场）时，这一条也最容易被漏掉：概览由 enterReaderMode 自己触发，
// 建议区没有同位的触发点。
//
// 手法：真实进入路径（reader/index.js 的 enterReaderMode）+ 真实建议区渲染链
//（chat-lists 的三档取用 → 建议区属主写 DOM），AI 边界（平台解析 / 模型调用 /
// offscreen 代发）以替身接管；概览链与本契约无关，以空产物替身落定。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";
import type { TestState } from "./reader-test-env.js";
import type { ReaderChatLists } from "../../extension/reader/chat-lists.js";

const mocks = vi.hoisted(() => ({
  resolveActiveProvider: vi.fn(),
  chatCompletion: vi.fn(),
  providerFetchViaOffscreen: vi.fn()
}));

vi.mock("../../extension/ai/active-provider.js", () => ({
  resolveActiveProvider: mocks.resolveActiveProvider
}));
vi.mock("../../extension/ai/completion.js", () => ({
  chatCompletion: mocks.chatCompletion
}));
vi.mock("../../extension/core/provider-http-offscreen.js", () => ({
  providerFetchViaOffscreen: mocks.providerFetchViaOffscreen
}));
// 概览生成是同一时刻的兄弟触发，不是本用例的契约面：以空产物替身落定，避免它
// 走真实分析管线（要动态装载 map-reduce 一大片）。
vi.mock("../../extension/ai/analysis.js", () => ({
  runOverviewAnalysis: vi.fn(async () => ({ chapters: [], quotes: [], failedRanges: [] }))
}));

const PAGE_BVID = "BV1test000000";
const PAGE_CID = "1000";
const GENERATED = ["核心结论是什么", "三种成因分别是什么", "怎么避免缓存穿透"];
// 与助手同形：把答案按片经 token 事件回吐（正文不在返回值里）。
const ANSWER = JSON.stringify(GENERATED);
const SUBTITLE_BODY = [
  { from: 0, to: 5, content: "今天我们聊缓存穿透" },
  { from: 5, to: 10, content: "先看它的三种成因" }
];

function stubStreamingAnswer(): void {
  mocks.chatCompletion.mockImplementation(async (args: Record<string, unknown>) => {
    const onEvent = args.onEvent as ((event: { type: string; data?: string }) => void) | undefined;
    for (let i = 0; i < ANSWER.length; i += 3) {
      onEvent?.({ type: "token", data: ANSWER.slice(i, i + 3) });
    }
    return { done: true };
  });
}

describe("字幕已落定后打开面板：建议区的预热触发", () => {
  let state: TestState;
  let shell: typeof import("../../extension/reader/index.js");
  let lists: ReaderChatLists;
  let chipTexts: () => string[];

  beforeEach(async () => {
    resetModuleState();
    document.body.innerHTML = "";
    setLocationUrl(READER_MODE_URL);
    mocks.resolveActiveProvider.mockReset();
    mocks.chatCompletion.mockReset();
    mocks.providerFetchViaOffscreen.mockReset();
    mocks.resolveActiveProvider.mockResolvedValue({
      baseUrl: "https://api.test/v1",
      apiKey: "sk-test",
      model: "test-model",
      presetId: "custom"
    });
    stubStreamingAnswer();
    mocks.providerFetchViaOffscreen.mockResolvedValue({ ok: true });

    state = (await import("../../extension/core/state.js")).state as TestState;
    shell = await import("../../extension/reader/index.js");
    const ids = (await import("../../extension/reader/state.js")).ids;
    mountReaderSkeleton(ids);
    mountPlayerChain();
    mockPlayerRects();

    // 建议区渲染链：列表决策（chat-lists）→ 建议区属主（写 DOM）。预热落定后的
    // 重渲与对话 tab 的 quickPrompts 触发源同形（subscribeQuickPromptsChange）。
    const messages = document.createElement("div");
    document.body.appendChild(messages);
    const slot = (await import("../../extension/reader/chat-suggestions-slot.js")).createChatSuggestionsSlot({
      messages,
      id: "test-chat-suggestions",
      onPick: () => {}
    });
    // 建议区先在场（消息区清场路径的产物：属主建壳、内容为空）——列表的
    // renderSuggestions 只做对账重渲，不负责建节点。
    slot.render([]);
    lists = (await import("../../extension/reader/chat-lists.js")).createReaderChatLists({
      historyList: document.createElement("div"),
      historyClearBtn: document.createElement("button"),
      applyById: () => {},
      deleteById: async () => {},
      suggestions: slot,
      hideHistoryPopover: () => {}
    });
    const { subscribeQuickPromptsChange } = await import("../../extension/chat/quick-prompt-cache.js");
    subscribeQuickPromptsChange(() => {
      lists.renderSuggestions();
    });

    // 对话 tab 的就绪前提：有平台、有视频上下文、无会话历史（renderSuggestions 的
    // 取用门）。
    const chatState = await import("../../extension/chat/chat-state.js");
    chatState.resetChatSessionStateForTests();
    chatState.chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", enabled: true }];
    chatState.chatSessionStateForTests.contextData = {
      isVideoContext: true,
      title: "缓存穿透的三种成因",
      url: READER_MODE_URL
    };

    chipTexts = () =>
      [...messages.querySelectorAll(".chat-chip")].map((node) => node.textContent || "");
  });

  it("进入阅读模式时字幕已在手（预抓取先落定）：建议区换成生成的问题，不停在固定三条兜底", async () => {
    state.clip.setTitle("缓存穿透的三种成因");
    state.clip.setBvid(PAGE_BVID);
    state.clip.setCid(PAGE_CID);
    state.clip.setSubtitleBody(SUBTITLE_BODY);

    // 用户动作：点文摘按钮（字幕早已在页面预抓取里落定，此刻不会再发 subtitle-ready）
    await shell.enterReaderMode();

    // 用户动作：切到 AI 对话 tab，建议区按当前缓存首渲——此刻预热最多还在飞，
    // 先落固定三条兜底不算错。
    lists.renderSuggestions();
    expect(chipTexts()).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);

    // 预热落定即就地换成本视频生成的问题（chat-tab 的订阅重渲）。
    await vi.waitFor(() => {
      expect(chipTexts()).toEqual(GENERATED);
    });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });

  // 差分探针：同一套骨架、同一份 clip，只补一条 subtitle-ready 通知——若建议区
  // 立刻换成生成的问题，则红点唯一落在「进入路径没有预热触发点」上（而不是
  // 替身/渲染链本身不工作）。
  it("同场景补一条 subtitle-ready（面板开着）：建议区拿到生成的问题", async () => {
    state.clip.setTitle("缓存穿透的三种成因");
    state.clip.setBvid(PAGE_BVID);
    state.clip.setCid(PAGE_CID);
    state.clip.setSubtitleBody(SUBTITLE_BODY);

    await shell.enterReaderMode();
    shell.handleReaderPresenterNotification({ kind: "subtitle-ready", text: "抓取完成" });

    lists.renderSuggestions();
    await vi.waitFor(() => {
      expect(chipTexts()).toEqual(GENERATED);
    });
  });
});
