// tests/reader/chat-suggestions-video-switch.test.ts
// 用户报障的端到端回归：换片瞬间（音频转写中，新视频还没有字幕）建议区显示的是
// 上一个视频的三个生成问题。
//
// 真实时序（本文件在真实组合根上重演，不走 DOM 替身）：
//   1. 看到 A 视频（字幕就绪），建议区显示 A 的三个生成问题（缓存 video:BV_A|cid）；
//   2. 跳到 B 视频（无字幕，正在音频转写）：URL 变化通知先到，clip 重置链后到
//      ——"clip 仍停在上一个视频"是这一窗口的真实形态；
//   3. 建议区必须回落固定三条默认问题（旧实现读对话上下文的 currentContextKey，
//      该键此刻停在 A，缓存命中 → 把 A 的问题显示在 B 上）；
//   4. B 字幕落定、预热写入 B 的三个问题后，建议区换成 B 的（缓存写入通知触发重渲）。
//
// 相邻文件分工：tests/reader/chat-lists.test.ts 锁渲染取键的口径（纯函数级），
// 本文件锁「换片 → URL 变化同步 → 建议区重渲」这条编排链真的把新口径用上；
// tests/reader/chat-tab-urlsync.test.ts 锁同一触发源的防抖行为。
//
// 纪元注意（同 chat-tab-urlsync.test.ts）：biliscript:urlchange 监听挂在 window 上，
// 旧纪元模块实例摘不掉自己的监听——每例收尾 closeChatSession 摘本纪元监听。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
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

// gateway 替身（与 chat-tab-urlsync.test.ts 同一手法）：装配链静态 import 它，
// 不打网络；aid 恒 0 时热评编排早退空列表。
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

// 上一个视频（jsdom 起始地址 = BV1test000000）与换片后的新视频。
const PREV_KEY = "video:BV1test000000|101";
const NEXT_BASE_URL = "https://www.bilibili.com/video/BV1next00000/";
const NEXT_URL = `${NEXT_BASE_URL}?biliscript_reader=1`;
const NEXT_KEY = "video:BV1next00000|202";

type Sendstub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: Sendstub; connect: Sendstub };
    storage: {
      local: { get: Sendstub; set: Sendstub };
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
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
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

// A 视频就绪（字幕体非空 = 建议区取生成结果的前置）。
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

describe("换片建议区（转写中不遗留上一个视频的问题）", () => {
  it("clip 还停在上一个视频：URL 变化同步后建议区回落固定三条默认问题", async () => {
    seedPrevVideoReady();
    writeCachedQuickPrompts(PREV_KEY, ["上一个视频问题一", "上一个视频问题二", "上一个视频问题三"]);

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => suggestionsChips().length > 0);
    expect(suggestionsChips()).toEqual(["上一个视频问题一", "上一个视频问题二", "上一个视频问题三"]);

    // 换片：地址已变，clip 重置链还没跑（本窗口的真实形态）→ 报障画面
    setLocationUrl(NEXT_URL);
    window.dispatchEvent(new Event("biliscript:urlchange"));
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
    window.dispatchEvent(new Event("biliscript:urlchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    // 字幕落定（acceptSubtitle 事务：身份 + 字幕体一起写入）
    state.clip.title = "新视频";
    state.clip.bvid = "BV1next00000";
    state.clip.cid = "202";
    state.clip.aid = "7200";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新视频的第一句" }];
    // 预热写入（lifecycle 在 subtitle-ready 后 fire-and-forget）→ 缓存变化通知重渲
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

    // 换片：URL 变化同步先到（读到旧 clip）→ 装配按未就绪空快照收口，键落 url: 档
    setLocationUrl(NEXT_URL);
    window.dispatchEvent(new Event("biliscript:urlchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(chatSessionState.currentContextKey).toBe(`url:${NEXT_BASE_URL}`);

    // 转写等待期间用户打好的草稿（后台对账不得清掉它）
    const input = document.getElementById(inputId) as HTMLTextAreaElement;
    input.value = "这段是谁讲的？";

    // 字幕落定：subtitle/commit 的 acceptSubtitle 事务（身份 + 字幕体原子写入）
    // 收尾发 subtitle-ready → 组合根据此补一轮上下文对账
    state.clip.title = "新视频";
    state.clip.bvid = "BV1next00000";
    state.clip.cid = "202";
    state.clip.aid = "7200";
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新视频的第一句" }];
    notifyReaderPresenter("subtitle-ready");

    await waitFor(() => chatSessionState.currentContextKey === NEXT_KEY);
    expect(chatSessionState.contextData?.bvid).toBe("BV1next00000");
    expect(chatSessionState.liveContextData?.title).toBe("新视频");
    // 对账是「跟着 clip 走」而不是用户语义上的新会话：草稿原样保留
    expect(input.value).toBe("这段是谁讲的？");
    chat.closeChatSession();
  });
});
