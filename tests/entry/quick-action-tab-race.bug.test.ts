// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl, setupEnvironment } from "../setup.js";
import { DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../../extension/core/default-prompts.js";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";
import type { MessageSender, SendResponse } from "../../extension/shared/messaging-protocol.js";

vi.mock("../../extension/shared/tab-utils.js", () => ({
  sendMessageToTab: vi.fn(async () => ({ ok: true })),
  waitForTabComplete: vi.fn(async () => true)
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));
vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(),
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/ui/lazy-ui.js", () => ({
  ensureUiReady: vi.fn()
}));
vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(),
  isPlayerAiLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: vi.fn()
  };
});

describe("background 半边：点 AI 键只发一条带 chat 负载的 reader-enter", () => {
  let onMessageListener: (message: unknown, sender: MessageSender, sendResponse: SendResponse) => boolean | void;

  beforeAll(async () => {
    setupEnvironment();
    vi.stubGlobal("chrome", {
      ...globalThis.chrome,
      runtime: {
        ...globalThis.chrome.runtime,
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      tabs: { ...globalThis.chrome.tabs, onUpdated: { addListener: vi.fn() } },
      storage: {
        ...globalThis.chrome.storage,
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onMessageListener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.mocked(sendMessageToTab).mockClear();
    vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: true }));
  });

  it("成功路径：单条 { type: reader-enter, chat: { prompt } }，无二次直发", async () => {
    const sendResponse = vi.fn();
    const keepOpen = onMessageListener({ type: "player-ai-quick-action", tabId: 7 }, { tab: { id: 7 } }, sendResponse);

    expect(keepOpen).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));

    expect(sendMessageToTab).toHaveBeenCalledTimes(1);
    expect(sendMessageToTab).toHaveBeenCalledWith(7, {
      type: "reader-enter",
      readerUrl: "",
      chat: { prompt: DEFAULT_PLAYER_AI_QUICK_PROMPT }
    });
  });

  it("重试耗尽：回固定失败文案，全程没有第二条消息", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(sendMessageToTab).mockImplementation(async () => ({ ok: false }));
      const sendResponse = vi.fn();
      onMessageListener({ type: "player-ai-quick-action", tabId: 7 }, { tab: { id: 7 } }, sendResponse);

      await vi.advanceTimersByTimeAsync(60_000);

      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: "阅读模式触发失败，请刷新浏览器网页重试"
      });
      expect(sendMessageToTab).toHaveBeenCalledTimes(12);
      expect(sendMessageToTab).toHaveBeenCalledWith(7, {
        type: "reader-enter",
        readerUrl: "",
        chat: { prompt: DEFAULT_PLAYER_AI_QUICK_PROMPT }
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

type Modules = {
  dispatch: typeof import("../../extension/entry/message-handler.js").dispatchContentScriptMessage;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureUiReady: typeof import("../../extension/ui/lazy-ui.js").ensureUiReady;
  activateScriptTab: typeof import("../../extension/reader/script-tab-activation.js").activateScriptTab;
  isReadingSubtitleBodyVisible: typeof import("../../extension/reader/state.js").isReadingSubtitleBodyVisible;
  state: typeof import("../../extension/core/state.js").state;
  transitionReaderShell: typeof import("../../extension/core/state.js").transitionReaderShell;
  ids: typeof import("../../extension/reader/state.js").ids;
  uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
};

function tabBody(ids: Modules["ids"], name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTabBody${name}`]) as HTMLElement;
}
function tabButton(ids: Modules["ids"], name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTab${name}`]) as HTMLElement;
}
function expectTabActive(
  ids: Modules["ids"],
  name: "Subtitle" | "Overview" | "Chat",
  active: boolean
) {
  expect(tabBody(ids, name).classList.contains("is-active"), `${name} body is-active`).toBe(active);
  expect(tabBody(ids, name).hasAttribute("hidden"), `${name} body hidden`).toBe(!active);
  expect(tabButton(ids, name).classList.contains("is-active"), `${name} button is-active`).toBe(active);
}

describe("单命令 reader-enter（带 chat 负载）的进入事务序", () => {
  let m: Modules;

  beforeEach(async () => {
    resetModuleState();
    setLocationUrl(NORMAL_PAGE_URL);
    document.body.innerHTML = "";
    document.documentElement.removeAttribute("data-biliscript-reader-mode");
    document.body.removeAttribute("data-biliscript-reader-mode");

    const messageHandler = await import("../../extension/entry/message-handler.js");
    const lazyReader = await import("../../extension/reader/lazy-reader.js");
    const lazyChatTab = await import("../../extension/reader/lazy-chat-tab.js");
    const lazyUi = await import("../../extension/ui/lazy-ui.js");
    const activation = await import("../../extension/reader/script-tab-activation.js");
    const coreState = await import("../../extension/core/state.js");
    const readerState = await import("../../extension/reader/state.js");
    const uiRenderer = (await import("../../extension/ui/ui-renderer.js")) as Modules["uiRenderer"];

    m = {
      dispatch: messageHandler.dispatchContentScriptMessage,
      ensureReaderDomain: lazyReader.ensureReaderDomain,
      ensureReaderChatTab: lazyChatTab.ensureReaderChatTab,
      ensureUiReady: lazyUi.ensureUiReady,
      activateScriptTab: activation.activateScriptTab,
      state: coreState.state,
      transitionReaderShell: coreState.transitionReaderShell,
      ids: readerState.ids,
      isReadingSubtitleBodyVisible: readerState.isReadingSubtitleBodyVisible,
      uiRenderer
    };

    m.transitionReaderShell("closed");
    m.state.reader.setViewReady(false);

    uiRenderer.ensureUiReady();
    (m.ensureUiReady as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      uiRenderer.ensureUiReady();
    });

    (m.ensureReaderChatTab as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      return {
        ensureChatTabActivated: vi.fn(async () => {}),
        runQuickActionPrompt: vi.fn(async (prompt: string) => {
          await m.activateScriptTab("chat", { consumeIntent: false });
          return Boolean(prompt);
        }),
        closeChatSession: vi.fn()
      };
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("输序（回归）：进入事务未收敛 ⇒ chat 激活排尾，事务收敛后最终停在对话 tab", async () => {
    const order: string[] = [];
    let releaseEnter: () => void = () => {};
    const enterGate = new Promise<void>((resolve) => {
      releaseEnter = resolve;
    });
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      ensureReaderOverviewTab: vi.fn(),
      enterReaderMode: async () => {
        m.transitionReaderShell("open");
        order.push("enter-start");
        await enterGate;
        order.push("restore-tab");
        await m.activateScriptTab("overview", { persist: false });
      }
    });

    const sendResponse = vi.fn();
    m.dispatch({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, sendResponse);

    await vi.waitFor(() => expect(order).toContain("enter-start"));
    expect(sendResponse).not.toHaveBeenCalled();
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();

    releaseEnter();
    await vi.waitFor(() => expect(order).toContain("restore-tab"));
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));

    await vi.waitFor(() => expectTabActive(m.ids, "Chat", true));
    expectTabActive(m.ids, "Chat", true);
    expectTabActive(m.ids, "Subtitle", false);
    expectTabActive(m.ids, "Overview", false);
    expect(m.isReadingSubtitleBodyVisible()).toBe(false);
  });

  it("对照（赢序）：enterReaderMode 先收敛、chat 激活后落 ⇒ 停在对话 tab（绿灯）", async () => {
    const order: string[] = [];
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      ensureReaderOverviewTab: vi.fn(),
      enterReaderMode: async () => {
        m.transitionReaderShell("open");
        await m.activateScriptTab("overview", { persist: false });
        order.push("enter-done");
      }
    });

    m.dispatch({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, vi.fn());
    await vi.waitFor(() => expect(order).toContain("enter-done"));

    await vi.waitFor(() => expectTabActive(m.ids, "Chat", true));

    expectTabActive(m.ids, "Chat", true);
    expectTabActive(m.ids, "Subtitle", false);
    expect(m.isReadingSubtitleBodyVisible()).toBe(false);
  });

  it("无 chat 负载：纯 open 意图，零对话激活，tab 停在持久值（概览）", async () => {
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      ensureReaderOverviewTab: vi.fn(),
      enterReaderMode: async () => {
        m.transitionReaderShell("open");
        await m.activateScriptTab("overview", { persist: false });
      }
    });

    const sendResponse = vi.fn();
    m.dispatch({ type: "reader-enter", readerUrl: "" }, sendResponse);

    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expectTabActive(m.ids, "Chat", false);
    expectTabActive(m.ids, "Overview", true);
    expectTabActive(m.ids, "Subtitle", false);
    expect(m.isReadingSubtitleBodyVisible()).toBe(false);
  });
});
