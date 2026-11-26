import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mockPlayerRects, mountPlayerChain, mountReaderSkeleton } from "../helpers/reader-skeleton.js";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";
import type { TestState } from "./reader-test-env.js";
import type { ChatSuggestionsSlot } from "../../extension/reader/chat-suggestions-slot.js";

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
vi.mock("../../extension/ai/analysis.js", () => ({
  runOverviewAnalysis: vi.fn(async () => ({ chapters: [], quotes: [], failedRanges: [] }))
}));

const PAGE_BVID = "BV1test000000";
const PAGE_CID = "1000";
const GENERATED = ["核心结论是什么", "三种成因分别是什么", "怎么避免缓存穿透"];
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
  let suggestions: ChatSuggestionsSlot;
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

    const messages = document.createElement("div");
    document.body.appendChild(messages);
    suggestions = (await import("../../extension/reader/chat-suggestions-slot.js")).createChatSuggestionsSlot({
      messages,
      id: "test-chat-suggestions",
      onPick: () => {}
    });
    const { subscribeQuickPromptsChange } = await import("../../extension/chat/quick-prompt-cache.js");
    subscribeQuickPromptsChange(() => {
      suggestions.refresh();
    });

    const chatState = await import("../../extension/chat/chat-state.js");
    chatState.resetChatSessionStateForTests();
    chatState.chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", enabled: true }];
    chatState.chatSessionStateForTests.contextData = {
      isVideoContext: true,
      title: "缓存穿透的三种成因",
      url: READER_MODE_URL
    };
    suggestions.reset();

    chipTexts = () =>
      [...messages.querySelectorAll(".chat-chip")].map((node) => node.textContent || "");
  });

  it("进入阅读模式时字幕已在手（预抓取先落定）：建议区换成生成的问题，不停在固定三条兜底", async () => {
    state.clip.setTitle("缓存穿透的三种成因");
    state.clip.setBvid(PAGE_BVID);
    state.clip.setCid(PAGE_CID);
    state.clip.setSubtitleBody(SUBTITLE_BODY);

    await shell.enterReaderMode();

    suggestions.refresh();
    expect(chipTexts()).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);

    await vi.waitFor(() => {
      expect(chipTexts()).toEqual(GENERATED);
    });
    expect(mocks.chatCompletion).toHaveBeenCalledTimes(1);
  });

  it("同场景补一条 subtitle-ready（面板开着）：建议区拿到生成的问题", async () => {
    state.clip.setTitle("缓存穿透的三种成因");
    state.clip.setBvid(PAGE_BVID);
    state.clip.setCid(PAGE_CID);
    state.clip.setSubtitleBody(SUBTITLE_BODY);

    await shell.enterReaderMode();
    shell.handleReaderPresenterNotification({ kind: "subtitle-ready" });

    suggestions.refresh();
    await vi.waitFor(() => {
      expect(chipTexts()).toEqual(GENERATED);
    });
  });
});
