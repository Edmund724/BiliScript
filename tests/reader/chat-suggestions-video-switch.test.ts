import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "../helpers/memory-storage-area.js";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock, gatewayCoreMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async (_count?: number) => [])
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(),
    isBiliUrl: vi.fn(() => true)
  }
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments,
  fetchHotCommentsWithLedger: async () => {
    if (!gatewayMock.getCurrentAid()) {
      return { comments: [], note: "无法获取视频 aid" };
    }
    try {
      return { comments: await gatewayMock.fetchHotComments(20) };
    } catch (error) {
      return { comments: [], note: String((error as Error)?.message || error) };
    }
  }
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

let state: TestState;
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let notifyReaderPresenter: typeof import("../../extension/reader/reader-bus.js").notifyReaderPresenter;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let suggestionsId: string;
let inputId: string;

const PREV_KEY = "video:BV1test000000|101";
const NEXT_BASE_URL = "https://www.bilibili.com/video/BV1next00000/";
const NEXT_URL = `${NEXT_BASE_URL}?biliscript_reader=1`;
const NEXT_KEY = "video:BV1next00000|202";

type Sendstub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: Sendstub; connect: Sendstub };
    storage: {
      local: ChromeHostStorageArea;
      sync: { set: Sendstub };
      onChanged: { addListener: Sendstub; removeListener: Sendstub };
    };
  };
  chromeStub.runtime.sendMessage = callbackStyleSendMessage({
    "ai-providers-list": () => ({ ok: true, providers: [{ id: "p1", name: "平台一", model: "模型一", enabled: true }] }),
    "get-settings": () => ({ ok: true, settings: {} })
  });
  chromeStub.runtime.connect = vi.fn(() => ({
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} }
  }));
  chromeStub.storage.local = createMemoryStorageArea();
  chromeStub.storage.sync.set = vi.fn(async () => {});
}

async function waitFor(predicate: () => boolean, { timeoutMs = 2000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function suggestionsChips(): string[] {
  return [...document.querySelectorAll(`#${suggestionsId} .chat-chip`)].map(
    (btn) => btn.textContent || ""
  );
}

function seedPrevVideoReady(): void {
  state.clip.title = "上一个视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "上一个视频的第一句" }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  writeCachedQuickPrompts = (await import("../../extension/chat/quick-prompt-cache.js")).writeCachedQuickPrompts;
  notifyReaderPresenter = (await import("../../extension/reader/reader-bus.js")).notifyReaderPresenter;
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  const ids = (await import("../../extension/reader/state.js")).ids;
  suggestionsId = ids.readingChatSuggestions;
  inputId = ids.readingChatInput;
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  (await import("../../extension/ui/ui-renderer.js")).ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  stubChromeByType();
});

import { contentEventBus } from "../../extension/shared/content-event-bus.js";

describe("换片建议区（转写中不遗留上一个视频的问题）", () => {
  it("clip 还停在上一个视频：URL 变化同步后建议区回落固定三条默认问题", async () => {
    seedPrevVideoReady();
    writeCachedQuickPrompts(PREV_KEY, ["上一个视频问题一", "上一个视频问题二", "上一个视频问题三"]);

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => suggestionsChips().length > 0);
    expect(suggestionsChips()).toEqual(["上一个视频问题一", "上一个视频问题二", "上一个视频问题三"]);

    setLocationUrl(NEXT_URL);
    contentEventBus.emit("host:url-change", { url: location.href });
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(suggestionsChips()).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
    chat.closeChatSession();
  });

  it("新视频字幕落定、预热写入后：建议区换成新视频的三个生成问题", async () => {
    seedPrevVideoReady();
    writeCachedQuickPrompts(PREV_KEY, ["上一个视频问题一", "上一个视频问题二", "上一个视频问题三"]);
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => suggestionsChips().length > 0);

    setLocationUrl(NEXT_URL);
    contentEventBus.emit("host:url-change", { url: location.href });
    await new Promise((resolve) => setTimeout(resolve, 250));

    state.clip.title = "新视频";
    state.clip.bvid = "BV1next00000";
    state.clip.cid = "202";
    state.clip.aid = "7200";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新视频的第一句" }];
    writeCachedQuickPrompts(NEXT_KEY, ["新视频问题一", "新视频问题二", "新视频问题三"]);

    expect(suggestionsChips()).toEqual(["新视频问题一", "新视频问题二", "新视频问题三"]);
    chat.closeChatSession();
  });

  it("clip 落定通知（subtitle-ready）后主动补一次对账：上下文归位到新视频，草稿保留", async () => {
    seedPrevVideoReady();
    writeCachedQuickPrompts(PREV_KEY, ["上一个视频问题一", "上一个视频问题二", "上一个视频问题三"]);
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => suggestionsChips().length > 0);

    setLocationUrl(NEXT_URL);
    contentEventBus.emit("host:url-change", { url: location.href });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(chatSessionState.currentContextKey).toBe(`url:${NEXT_BASE_URL}`);

    const input = document.getElementById(inputId) as HTMLTextAreaElement;
    input.value = "这段是谁讲的？";

    state.clip.title = "新视频";
    state.clip.bvid = "BV1next00000";
    state.clip.cid = "202";
    state.clip.aid = "7200";
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新视频的第一句" }];
    notifyReaderPresenter({ kind: "subtitle-ready" });

    await waitFor(() => chatSessionState.currentContextKey === NEXT_KEY);
    expect(chatSessionState.contextData?.bvid).toBe("BV1next00000");
    expect(chatSessionState.liveContextData?.title).toBe("新视频");
    expect(input.value).toBe("这段是谁讲的？");
    chat.closeChatSession();
  });
});
