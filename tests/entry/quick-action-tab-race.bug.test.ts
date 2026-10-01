// Bug 回归回路（工单：点 AI 键偶发进的是字幕 tab 而不是 AI 对话）——单命令形状
// + 标签激活属主串行化。
//
// 历史形状（双消息直发，已退役）：background 先发 reader-enter，content 侧处理器
// 「即答」后紧接着再直发 player-ai-quick-action-chat——两条链在 content 侧并发：
//   链 A（reader-enter → shell open）：ensureUiReady → … → enterReaderMode
//        → 按持久值恢复 tab（无对话步）
//   链 B（quick-action-chat）：ensureUiReady → ensureReaderChatTab
//        → runQuickActionPrompt → 激活对话 tab
// 谁后落谁赢。链 B 的对话激活先落、链 A 的恢复后落 ⇒ 最终停在「字幕」tab——
// 与生产偶发一致（胜负由两侧动态 chunk 装载快慢决定）。
//
// 新形状（单命令 + 属主收口）：background 的 handlePlayerAiQuickAction 只发一条
// 带 chat 负载的 reader-enter（经 triggerReaderModeInTab 的重试/注入链）；content
// 侧对话激活收进 shell 进入事务体内（reader/shell.ts chat 档，单飞队列排尾），
// 在进入事务收敛（含按持久值恢复 tab）后才落地。race 防护两层：进入事务单飞
// 队列 + 标签激活属主（reader/script-tab-activation）的激活串行队列——不变式是
// 「并发意图串行化，最终状态 = 最后意图」，不再依赖「谁后落」。
//
// 本文件两段验证：
//   1. background 半边（handlePlayerAiQuickAction → triggerReaderChatInTab →
//      triggerReaderModeInTab）：只发一条 { type: "reader-enter", chat: { prompt } }，
//      无任何二次直发；重试耗尽回固定失败文案。
//   2. content 半边（dispatchContentScriptMessage）：带 chat 负载的 reader-enter
//      在进入事务收敛后激活对话 tab（输序 gate 钉死确定性防护）；无 chat 负载
//      则零对话激活。断言面是真实 ui-renderer 投影出的 DOM（is-active /
//      aria-selected / hidden 三通道）+ 真实状态位谓词（isReadingSubtitleBodyVisible）。
//
// 保真边界（content 半边；两个 tab 写手都是属主 activateScriptTab 的排队调用，
// 其余代码只决定到达次序）：
//   - enterReaderMode 桩复刻 lifecycle.enterReaderMode 的 tab 相关行为
//     （setViewOpen(true) + await activateScriptTab(持久值, { persist:false })，
//     lifecycle.ts 的恢复链）；
//   - runQuickActionPrompt 桩复刻 chat-tab.runQuickActionPrompt 的 tab 相关
//     行为（await activateScriptTab("chat", { consumeIntent:false })）。
// 两个写手之间的派发链（message-handler → shell → 属主串行队列 → project-tab
// 投影命令 → ui-renderer 的 setReaderScriptTab）全部走真实模块。

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";
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
// shell 进入链的 replaceState：jsdom 下无谓改写地址，mock 掉（与 shell.test.ts 同款）
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: vi.fn()
  };
});

// ===== background 半边：单命令形状 =====

describe("background 半边：点 AI 键只发一条带 chat 负载的 reader-enter", () => {
  let onMessageListener: (message: unknown, sender: MessageSender, sendResponse: SendResponse) => boolean | void;

  beforeAll(async () => {
    // setup.ts 的 chrome stub 缺 getManifest / tabs.onUpdated / runtime.onMessage
    //（background 顶层要注册监听器），这里装 superset 后动态装载 background。
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: vi.fn(),
        getManifest: () => ({ version: "9.9.9" }),
        onInstalled: { addListener: vi.fn() },
        onMessage: { addListener: vi.fn() }
      },
      tabs: { onUpdated: { addListener: vi.fn() } },
      storage: {
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        sync: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() }
      }
    });
    await import("../../extension/entry/background.js");
    onMessageListener = vi.mocked(chrome.runtime.onMessage.addListener).mock.calls[0][0];
  });

  // content 半边的用例依赖 setup.ts 的 chrome stub：用例结束后摘掉本 describe
  // 的 superset，让 resetModuleState → setupEnvironment 重新装回通用 stub。
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

// ===== content 半边：对话激活在进入事务收敛后落地 =====

// 每用例 resetModules 后动态重取（setup.ts 的全局 beforeEach 会清
// globalThis.__BILISCRIPT_READER_BUS__ 槽；ui-renderer 与属主的订阅都在模块求值时
// 注册，必须每用例重新求值/装载，否则 subscribeUiCommand/subscribeTabIntent 落在
// 已被清空的槽上）。
type Modules = {
  dispatch: typeof import("../../extension/entry/message-handler.js").dispatchContentScriptMessage;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureUiReady: typeof import("../../extension/ui/lazy-ui.js").ensureUiReady;
  activateScriptTab: typeof import("../../extension/reader/script-tab-activation.js").activateScriptTab;
  isReadingSubtitleBodyVisible: typeof import("../../extension/reader/state.js").isReadingSubtitleBodyVisible;
  state: typeof import("../../extension/core/state.js").state;
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
      ids: readerState.ids,
      isReadingSubtitleBodyVisible: readerState.isReadingSubtitleBodyVisible,
      uiRenderer
    };

    m.state.reader.setViewOpen(false);
    m.state.reader.setViewReady(false);

    // 预热壳：装载真实 ui-renderer（注册 project-tab 订阅者）并构建 文摘面板
    // DOM。消息链的 ensureUiReady 桩走幂等 no-op，把「模块装载快慢」这一生产
    // 随机项从回路里钉掉，只留我们要测的事务序。
    uiRenderer.ensureUiReady();
    (m.ensureUiReady as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      uiRenderer.ensureUiReady();
    });

    // chat 档的对话 seam 桩（tab 相关行为 = chat-tab.ts runQuickActionPrompt 的
    // await activateScriptTab("chat", { consumeIntent: false })）
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
        m.state.reader.setViewOpen(true);
        order.push("enter-start");
        await enterGate;
        order.push("restore-tab");
        // lifecycle.enterReaderMode 的 tab 相关行为：按持久值恢复所在标签
        //（persist:false —— 恢复不是一次用户切换）
        await m.activateScriptTab("overview", { persist: false });
      }
    });

    // 生产消息序（新形状）：background 只发一条带 chat 负载的 reader-enter
    const sendResponse = vi.fn();
    m.dispatch({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, sendResponse);

    // 即答语义：命令已受理入队即回 ok，不代表进入完成
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true }));
    await vi.waitFor(() => expect(order).toContain("enter-start"));
    // 进入事务被 gate 卡住 ⇒ 对话激活只能排尾，此时还没触碰对话 tab
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();

    // 放行 enterReaderMode 尾段：tab 恢复落地、进入事务收敛
    releaseEnter();
    await vi.waitFor(() => expect(order).toContain("restore-tab"));

    // 事务收敛后 chat 档才激活对话 tab：用户最终停在 AI 对话 tab（恢复的概览
    // 意图先经属主队列落定，随后对话意图覆盖它——最终状态 = 最后意图）
    await vi.waitFor(() => expectTabActive(m.ids, "Chat", true));
    expectTabActive(m.ids, "Chat", true);
    expectTabActive(m.ids, "Subtitle", false);
    expectTabActive(m.ids, "Overview", false);
    // 状态位与 DOM 同源：谓词不再判定字幕 tab 可见
    expect(m.isReadingSubtitleBodyVisible()).toBe(false);
  });

  it("对照（赢序）：enterReaderMode 先收敛、chat 激活后落 ⇒ 停在对话 tab（绿灯）", async () => {
    const order: string[] = [];
    (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
      ensureReaderOverviewTab: vi.fn(),
      enterReaderMode: async () => {
        m.state.reader.setViewOpen(true);
        // 进入事务先把 tab 恢复到持久值（此处概览），随后被 chat 档激活覆盖
        await m.activateScriptTab("overview", { persist: false });
        order.push("enter-done");
      }
    });

    m.dispatch({ type: "reader-enter", readerUrl: "", chat: { prompt: "总结" } }, vi.fn());
    // 进入事务先收敛（信号用事务尾，不用 DOM——命令落地后 DOM 还可能是模板初值）
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
        m.state.reader.setViewOpen(true);
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
