// 壳命令「set-tab」回归（tab 持久化的恢复路径）：2026-10 用户决议——刷新/新视频/
// 手动进入阅读模式都恢复上次所在标签，恢复动作经壳命令 set-tab 触达 ui 壳。
//
// 与点击 tab 按钮同款做二级激活（否则恢复出来的对话/概览是空壳）：
//   chat      → 激活对话组合根（ensureReaderChatTab.ensureChatTabActivated）
//   overview  → 触发概览渲染/生成兜底（reader.ensureReaderOverviewTab）
// 非法载荷（未知标签/缺 payload）回落 subtitle，且不触发任何二级激活。
//
// 覆盖的失败方式：
//   1. 命令名/载荷不被识别 → 静默丢弃（tab 停在初始字幕，状态位与 DOM 一致）；
//   2. 恢复 chat 只切 DOM 不激活 → 面板空壳（断言激活被调用）；
//   3. 恢复 overview 不触发生成 → 概览诚实空态卡死（断言 ensureReaderOverviewTab）；
//   4. 切 tab 不写持久化 → 下次进入又回字幕（断言 storage.local 写入）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(),
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));
vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return { ...actual, replaceReaderModeUrl: vi.fn() };
});

type Modules = {
  requestUiCommand: typeof import("../../extension/reader/reader-bus.js").requestUiCommand;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  getReaderActiveScriptTab: typeof import("../../extension/reader/state.js").getReaderActiveScriptTab;
  ids: typeof import("../../extension/reader/state.js").ids;
  uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
};

let m: Modules;
let chatActivated: ReturnType<typeof vi.fn>;
let ensureOverviewTab: ReturnType<typeof vi.fn>;

function tabButton(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(m.ids[`readingTab${name}`]) as HTMLElement;
}

function tabBody(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(m.ids[`readingTabBody${name}`]) as HTMLElement;
}

function expectTabActive(name: "Subtitle" | "Overview" | "Chat", active: boolean) {
  expect(tabBody(name).classList.contains("is-active"), `${name} body is-active`).toBe(active);
  expect(tabBody(name).hasAttribute("hidden"), `${name} body hidden`).toBe(!active);
  expect(tabButton(name).classList.contains("is-active"), `${name} button is-active`).toBe(active);
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  vi.mocked(chrome.storage.local.set).mockReset().mockResolvedValue(undefined);

  const readerBus = await import("../../extension/reader/reader-bus.js");
  const lazyChatTab = await import("../../extension/reader/lazy-chat-tab.js");
  const lazyReader = await import("../../extension/reader/lazy-reader.js");
  const readerState = await import("../../extension/reader/state.js");
  const uiRenderer = await import("../../extension/ui/ui-renderer.js");

  m = {
    requestUiCommand: readerBus.requestUiCommand,
    ensureReaderChatTab: lazyChatTab.ensureReaderChatTab,
    ensureReaderDomain: lazyReader.ensureReaderDomain,
    getReaderActiveScriptTab: readerState.getReaderActiveScriptTab,
    ids: readerState.ids,
    uiRenderer
  };

  // 壳就绪：建面板 DOM 并注册壳命令订阅者（set-tab / set-tab:chat 的 handler）
  uiRenderer.ensureUiReady({ forceRecreate: true });

  chatActivated = vi.fn(async () => {});
  (m.ensureReaderChatTab as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    ensureChatTabActivated: chatActivated,
    runQuickActionPrompt: vi.fn(async () => true),
    closeChatSession: vi.fn()
  }));
  ensureOverviewTab = vi.fn();
  (m.ensureReaderDomain as ReturnType<typeof vi.fn>).mockResolvedValue({
    enterReaderMode: vi.fn(async () => {}),
    closeReadingView: vi.fn(),
    ensureReaderOverviewTab: ensureOverviewTab
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("壳命令 set-tab（tab 恢复路径）", () => {
  it("恢复概览：切到概览 tab 并触发概览渲染/生成（二级激活与点击同款）", async () => {
    m.requestUiCommand("set-tab", { tab: "overview" });

    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expect(m.getReaderActiveScriptTab()).toBe("overview");
    await vi.waitFor(() => expect(ensureOverviewTab).toHaveBeenCalledTimes(1));
    expect(chatActivated).not.toHaveBeenCalled();
  });

  it("恢复对话：切到对话 tab 并激活对话组合根", async () => {
    m.requestUiCommand("set-tab", { tab: "chat" });

    expectTabActive("Chat", true);
    expect(m.getReaderActiveScriptTab()).toBe("chat");
    await vi.waitFor(() => expect(chatActivated).toHaveBeenCalledTimes(1));
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });

  it("恢复字幕：只切 tab，无二级激活", () => {
    m.requestUiCommand("set-tab", { tab: "subtitle" });

    expectTabActive("Subtitle", true);
    expect(m.getReaderActiveScriptTab()).toBe("subtitle");
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });

  it("非法载荷（未知标签/缺 payload）不动当前标签，也不激活二级链路", () => {
    m.requestUiCommand("set-tab", { tab: "overview" });
    expectTabActive("Overview", true);

    m.requestUiCommand("set-tab", { tab: "ghost" });
    m.requestUiCommand("set-tab", {});
    m.requestUiCommand("set-tab", null);

    expectTabActive("Overview", true);
    expect(m.getReaderActiveScriptTab()).toBe("overview");
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
  });

  it("切 tab 写穿持久化（键 = readerActiveScriptTab）", () => {
    m.requestUiCommand("set-tab", { tab: "overview" });

    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
      readerActiveScriptTab: "overview"
    });
  });
});
