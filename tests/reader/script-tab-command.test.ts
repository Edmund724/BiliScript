import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const settingsPanelMocks = vi.hoisted(() => ({
  renderReaderSettingsPanel: vi.fn(),
  openLiveSettings: vi.fn(),
  openAppearanceSettings: vi.fn()
}));

vi.mock("../../extension/ui/settings-panel.js", () => settingsPanelMocks);

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

    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);
    expect(m.ensureReaderChatTab).not.toHaveBeenCalled();
    expect(ensureOverviewTab).not.toHaveBeenCalled();
  });
});

describe("壳命令 open-settings", () => {
  it("展开设置抽屉并转发伴看定位目标", async () => {
    m.requestUiCommand("open-settings", { target: "gemini-key" });

    expect(m.state.reader.readingSettingsExpanded).toBe(true);
    await vi.waitFor(() => expect(settingsPanelMocks.openLiveSettings).toHaveBeenCalledWith("gemini-key"));
  });

  it("更多显示设置深链到外观分区", async () => {
    m.requestUiCommand("open-settings", { target: "appearance" });

    expect(m.state.reader.readingSettingsExpanded).toBe(true);
    await vi.waitFor(() => expect(settingsPanelMocks.openAppearanceSettings).toHaveBeenCalledTimes(1));
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
