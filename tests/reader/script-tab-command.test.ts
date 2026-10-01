// 文摘面板标签「投影命令 + 恢复链」回归（工单：标签激活属主收口）。
//
// 收口后壳侧只剩一条命令：
//   project-tab → 纯 DOM 三通道投影（+ 对话分区表挂载）；不写状态位、不落盘、
//                 不做二级激活（未知/缺失 payload 静默忽略，不动当前投影）；
//   旧 "set-tab" / "set-tab:chat" 随命令退役（不再注册，发送方静默丢弃）。
//
// 「切标签并激活」的完整语义（状态位 → 持久化 → 投影 → 二级激活）在 reader 域
// 属主 reader/script-tab-activation（单测见 tests/reader/script-tab-activation.test.ts）；
// 本文件锁它的两个消费面：
//   1. 恢复链：lifecycle.enterReaderMode 按持久值恢复上次所在标签——chat 激活
//      对话组合根（ensureChatTabActivated）/ overview 触达概览渲染生成
//      （ensureReaderOverviewTab）；persist:false 表示恢复不写回存储；
//   2. 投影落点：属主的 project-tab 命令经真实 ui-renderer 写出的 DOM 三通道。
//
// 覆盖的失败方式：
//   1. 命令名/载荷不被识别 → 静默丢弃（tab 停在当前投影）；
//   2. 恢复 chat 只投影不激活 → 面板空壳（断言激活被调用且 consumeIntent 透传）；
//   3. 恢复 overview 不触发生成 → 概览诚实空态卡死（断言 ensureReaderOverviewTab）；
//   4. 恢复写回存储 → 每次打开都改写用户上次位置（断言 persist:false 不落盘）。

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
  activateScriptTab: typeof import("../../extension/reader/script-tab-activation.js").activateScriptTab;
  ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;
  ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
  isReadingSubtitleBodyVisible: typeof import("../../extension/reader/state.js").isReadingSubtitleBodyVisible;
  state: typeof import("../../extension/core/state.js").state;
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
  const activation = await import("../../extension/reader/script-tab-activation.js");
  const lazyChatTab = await import("../../extension/reader/lazy-chat-tab.js");
  const lazyReader = await import("../../extension/reader/lazy-reader.js");
  const readerState = await import("../../extension/reader/state.js");
  const coreState = await import("../../extension/core/state.js");
  const uiRenderer = await import("../../extension/ui/ui-renderer.js");

  m = {
    requestUiCommand: readerBus.requestUiCommand,
    activateScriptTab: activation.activateScriptTab,
    ensureReaderChatTab: lazyChatTab.ensureReaderChatTab,
    ensureReaderDomain: lazyReader.ensureReaderDomain,
    isReadingSubtitleBodyVisible: readerState.isReadingSubtitleBodyVisible,
    state: coreState.state,
    ids: readerState.ids,
    uiRenderer
  };

  // 壳就绪：建面板 DOM 并注册壳命令订阅者（project-tab / open-settings 的 handler）
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

describe("壳命令 project-tab（纯 DOM 投影）", () => {
  it("投影三通道：概览 tab 激活，其余收起；不做二级激活", () => {
    m.requestUiCommand("project-tab", { tab: "overview" });

    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expectTabActive("Chat", false);
    expect(ensureOverviewTab).not.toHaveBeenCalled();
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
  });

  it("投影是纯 DOM：不写状态位、不落盘（两者都收口在属主）", () => {
    m.state.reader.setViewOpen(true);

    m.requestUiCommand("project-tab", { tab: "overview" });

    expectTabActive("Overview", true);
    // 谓词读唯一状态位：投影不碰它，故仍按字幕 tab 判定
    expect(m.isReadingSubtitleBodyVisible()).toBe(true);
    expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled();
  });

  it("非法载荷（未知标签/缺 payload）不动当前投影，也不激活二级链路", () => {
    m.requestUiCommand("project-tab", { tab: "overview" });
    expectTabActive("Overview", true);

    m.requestUiCommand("project-tab", { tab: "ghost" });
    m.requestUiCommand("project-tab", {});
    m.requestUiCommand("project-tab", null);

    expectTabActive("Overview", true);
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });

  it("旧命令已退役：set-tab / set-tab:chat 不再动投影，也不激活二级链路", () => {
    m.requestUiCommand("set-tab", { tab: "overview" });
    m.requestUiCommand("set-tab:chat", { consumeIntent: false });

    // 模板初值：字幕 tab
    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });
});

describe("恢复链（属主 activateScriptTab，lifecycle.enterReaderMode 的持久值回灌）", () => {
  it("恢复概览：投影到概览 tab 并触发概览渲染/生成（二级激活与点击同款）", async () => {
    await m.activateScriptTab("overview", { persist: false });

    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expect(ensureOverviewTab).toHaveBeenCalledTimes(1);
    expect(chatActivated).not.toHaveBeenCalled();
  });

  it("恢复对话：投影到对话 tab 并激活对话组合根（consumeIntent 默认 true）", async () => {
    await m.activateScriptTab("chat", { persist: false });

    expectTabActive("Chat", true);
    expect(chatActivated).toHaveBeenCalledWith({ consumeIntent: true });
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });

  it("恢复字幕：只投影，无二级激活", async () => {
    await m.activateScriptTab("subtitle", { persist: false });

    expectTabActive("Subtitle", true);
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });

  it("恢复不写穿持久化（persist:false）；用户切换（默认）写穿同键", async () => {
    await m.activateScriptTab("overview", { persist: false });
    expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled();

    await m.activateScriptTab("overview");
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
      readerActiveScriptTab: "overview"
    });
  });
});
