// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureReaderDomain: vi.fn(),
  isReaderViewOpen: vi.fn(() => false),
  ensureReaderChatTab: vi.fn()
}));

vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: mocks.ensureReaderDomain
}));
vi.mock("../../extension/reader/state.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../extension/reader/state.js")>(),
  isReaderViewOpen: mocks.isReaderViewOpen,
  enforceNormalPageStateIfNeeded: vi.fn(),
  setReaderActiveScriptTab: vi.fn()
}));
vi.mock("../../extension/core/url-watcher.js", () => ({
  startUrlWatcher: vi.fn()
}));
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: vi.fn()
  };
});
vi.mock("../../extension/subtitle/lazy.js", () => ({
  ensureSummarizeChain: vi.fn()
}));
vi.mock("../../extension/core/ui-status.js", () => ({
  setStatus: vi.fn()
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn(async () => {})
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: mocks.ensureReaderChatTab,
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => ""),
  fetchHotComments: vi.fn(async () => [])
}));

import { bindRuntimeEvents } from "../../extension/entry/message-handler.js";
import {
  setLiveCompanionStopHandler
} from "../../extension/reader/reader-bus.js";

const {
  ensureReaderDomain,
  isReaderViewOpen,
  ensureReaderChatTab: ensureReaderChatTabMock
} = mocks;

type OnMessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void
) => boolean | void;

const onMessageListeners: OnMessageListener[] = [];
vi.stubGlobal("chrome", {
  runtime: {
    getURL: (path: string) => `chrome-extension://test/${path}`,
    onMessage: {
      addListener: (listener: OnMessageListener) => onMessageListeners.push(listener)
    }
  }
});

bindRuntimeEvents();
const messageListener = onMessageListeners[0];

function makeChatStub() {
  return {
    ensureChatTabActivated: vi.fn(async () => {}),
    runQuickActionPrompt: vi.fn(async () => true),
    closeChatSession: vi.fn(),
    stopLiveCompanion: vi.fn()
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isReaderViewOpen.mockReturnValue(false);
  ensureReaderChatTabMock.mockReset();
  ensureReaderChatTabMock.mockResolvedValue(makeChatStub());
});

describe("reader-enter + chat 负载：打开阅读模式并激活对话 tab（单命令）", () => {
  it("reader 未开：先 enterReaderMode，再带 prompt 走 runQuickActionPrompt", async () => {
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    const enterReaderMode = vi.fn(async () => {});
    ensureReaderDomain.mockResolvedValue({ enterReaderMode });

    const sendResponse = vi.fn();
    const keepOpen = messageListener(
      { type: "reader-enter", readerUrl: "https://www.bilibili.com/video/BV1/?biliscript_reader=1", chat: { prompt: "总结" } },
      {},
      sendResponse
    );

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(chat.runQuickActionPrompt).toHaveBeenCalledTimes(1));
    expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("总结");
    expect(chat.ensureChatTabActivated).not.toHaveBeenCalled();
    expect(ensureReaderDomain).toHaveBeenCalledTimes(1);
  });

  it("reader 已开：不重复 enterReaderMode，无 prompt 只激活对话 tab（consumeIntent:false）", async () => {
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    isReaderViewOpen.mockReturnValue(true);

    const sendResponse = vi.fn();
    messageListener({ type: "reader-enter", chat: {} }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(chat.ensureChatTabActivated).toHaveBeenCalledTimes(1));
    expect(chat.ensureChatTabActivated).toHaveBeenCalledWith({ consumeIntent: false });
    expect(ensureReaderDomain).not.toHaveBeenCalled();
    expect(chat.runQuickActionPrompt).not.toHaveBeenCalled();
  });

  it("无 chat 负载：纯 open 意图，零对话激活", async () => {
    const enterReaderMode = vi.fn(async () => {});
    ensureReaderDomain.mockResolvedValue({ enterReaderMode });

    const sendResponse = vi.fn();
    messageListener({ type: "reader-enter", readerUrl: "https://www.bilibili.com/video/BV1/?biliscript_reader=1" }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(enterReaderMode).toHaveBeenCalledTimes(1));
    expect(ensureReaderChatTabMock).not.toHaveBeenCalled();
  });

  it("完成语义：进入事务未完成时不回 ok，完成后才回成功", async () => {
    let releaseEnter: () => void = () => {};
    const enterGate = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    ensureReaderDomain.mockResolvedValue({
      enterReaderMode: vi.fn(async () => {
        await enterGate;
      })
    });

    const sendResponse = vi.fn();
    messageListener({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, {}, sendResponse);

    await vi.waitFor(() => expect(ensureReaderDomain).toHaveBeenCalledTimes(1));
    expect(sendResponse).not.toHaveBeenCalled();
    releaseEnter();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
  });
});

describe("空 readerUrl 兜底：视图未开时用当前地址构造阅读 URL", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-biliscript-reader-mode");
    document.body.removeAttribute("data-biliscript-reader-mode");
  });

  it("reader-enter：空 readerUrl 且视图未开 → 兜底改写 + 翻门控属性 + enterReaderMode", async () => {
    const { setLocationUrl, NORMAL_PAGE_URL } = await import("../setup.js");
    setLocationUrl(NORMAL_PAGE_URL);
    const { replaceReaderModeUrl } = await import("../../extension/bilibili/reader-url.js");
    const enterReaderMode = vi.fn(async () => {});
    ensureReaderDomain.mockResolvedValue({ enterReaderMode });

    const sendResponse = vi.fn();
    messageListener({ type: "reader-enter", readerUrl: "" }, {}, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(enterReaderMode).toHaveBeenCalledTimes(1));
    expect(replaceReaderModeUrl).toHaveBeenCalledWith("https://www.bilibili.com/video/BV1test000000/?biliscript_reader=1");
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(document.body.getAttribute("data-biliscript-reader-mode")).toBe("1");
  });

  it("reader-enter：空 readerUrl 且视图已开 → 保持纯聚焦语义，不改写 URL", async () => {
    isReaderViewOpen.mockReturnValue(true);
    ensureReaderDomain.mockResolvedValue({ focusReadingView: vi.fn() });
    const { replaceReaderModeUrl } = await import("../../extension/bilibili/reader-url.js");

    const sendResponse = vi.fn();
    messageListener({ type: "reader-enter", readerUrl: "" }, {}, sendResponse);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(ensureReaderDomain).toHaveBeenCalledTimes(1);
  });

  it("reader-enter + chat：空 readerUrl 且视图未开 → 兜底改写后 enterReaderMode + runQuickActionPrompt", async () => {
    const { setLocationUrl, NORMAL_PAGE_URL } = await import("../setup.js");
    setLocationUrl(NORMAL_PAGE_URL);
    const { replaceReaderModeUrl } = await import("../../extension/bilibili/reader-url.js");
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    ensureReaderDomain.mockResolvedValue({ enterReaderMode: vi.fn(async () => {}) });

    messageListener({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, {}, vi.fn());

    await vi.waitFor(() => expect(chat.runQuickActionPrompt).toHaveBeenCalledWith("总结"));
    expect(replaceReaderModeUrl).toHaveBeenCalledWith("https://www.bilibili.com/video/BV1test000000/?biliscript_reader=1");
    expect(document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
  });

});

describe("live-session-takeover 跨标签页接管伴看停止", () => {
  afterEach(() => {
    setLiveCompanionStopHandler(null);
  });

  it("仅经 reader-bus 通知当前页伴看停止，不触碰或装载对话 tab", async () => {
    const { isReaderChatTabLoaded } = await import("../../extension/reader/lazy-chat-tab.js");
    (isReaderChatTabLoaded as any).mockReturnValue(true);
    const chat = makeChatStub();
    ensureReaderChatTabMock.mockResolvedValue(chat);
    const companionStop = vi.fn();
    setLiveCompanionStopHandler(companionStop);

    const sendResponse = vi.fn();
    const keepOpen = messageListener({ type: "live-session-takeover" }, {}, sendResponse);
    expect(keepOpen).toBe(false);

    expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    expect(companionStop).toHaveBeenCalledWith("takeover");
    expect(ensureReaderChatTabMock).not.toHaveBeenCalled();
    expect(chat.stopLiveCompanion).not.toHaveBeenCalled();
  });
});
