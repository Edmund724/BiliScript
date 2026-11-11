import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const mocks = vi.hoisted(() => ({
  exitReaderShell: vi.fn(),
  renderReaderSettingsPanel: vi.fn(),
  openLiveSettings: vi.fn(),
  updateReaderPreferences: vi.fn(),
  ensureReaderOverviewTab: vi.fn(),
  ensureChatTabActivated: vi.fn()
}));

vi.mock("../../extension/reader/shell.js", () => ({
  exitReaderShell: mocks.exitReaderShell
}));
vi.mock("../../extension/ui/settings-panel.js", () => ({
  renderReaderSettingsPanel: mocks.renderReaderSettingsPanel,
  openLiveSettings: mocks.openLiveSettings
}));
vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(),
  isReaderChatTabLoaded: vi.fn(() => false)
}));
vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn()
}));

let state: typeof import("../../extension/core/state.js").state;
let ids: typeof import("../../extension/reader/state.js").ids;
let readerState: typeof import("../../extension/reader/state.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let activation: typeof import("../../extension/reader/script-tab-activation.js");
let ensureReaderDomain: typeof import("../../extension/reader/lazy-reader.js").ensureReaderDomain;
let ensureReaderChatTab: typeof import("../../extension/reader/lazy-chat-tab.js").ensureReaderChatTab;

function element(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function openFromGear(): void {
  const gear = element(ids.readingSettingsBtn);
  gear.focus();
  gear.click();
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.mocked(chrome.storage.local.set).mockReset().mockResolvedValue(undefined);
  mocks.exitReaderShell.mockResolvedValue(undefined);
  mocks.ensureChatTabActivated.mockResolvedValue(undefined);

  const coreState = await import("../../extension/core/state.js");
  readerState = await import("../../extension/reader/state.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  activation = await import("../../extension/reader/script-tab-activation.js");
  const viewRender = await import("../../extension/reader/view-render.js");
  const lazyReader = await import("../../extension/reader/lazy-reader.js");
  const lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  state = coreState.state;
  ids = readerState.ids;
  ensureReaderDomain = lazyReader.ensureReaderDomain;
  ensureReaderChatTab = lazyChat.ensureReaderChatTab;
  vi.mocked(ensureReaderDomain).mockResolvedValue({
    renderReaderPanels: viewRender.renderReaderPanels,
    updateReaderPreferences: mocks.updateReaderPreferences,
    ensureReaderOverviewTab: mocks.ensureReaderOverviewTab
  } as unknown as Awaited<ReturnType<typeof ensureReaderDomain>>);
  vi.mocked(ensureReaderChatTab).mockResolvedValue({
    ensureChatTabActivated: mocks.ensureChatTabActivated
  } as unknown as Awaited<ReturnType<typeof ensureReaderChatTab>>);

  uiRenderer.ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("设置子页导航", () => {
  it("保留全局顶栏，设置内容使用独立返回行并投影齿轮与灰化状态", () => {
    const header = document.querySelector<HTMLElement>(".biliscript-reading-header")!;
    const back = element(ids.readingSettingsBackBtn);
    expect(header.querySelectorAll(".biliscript-reading-actions > button")).toHaveLength(3);
    expect(back.closest(".biliscript-reading-header")).toBeNull();
    expect(back.closest(".biliscript-reading-actions")).toBeNull();
    expect(back.textContent).toBe("← 返回");

    openFromGear();

    expect(element(ids.readingSettingsPanel).hidden).toBe(false);
    expect(element(ids.readingScriptPanel).getAttribute("data-biliscript-settings-open")).toBe("1");
    expect(element(ids.readingSettingsBtn).classList.contains("is-active")).toBe(true);
    expect(element(ids.readingSettingsBtn).getAttribute("aria-pressed")).toBe("true");
    expect(document.activeElement).toBe(back);

    const css = readFileSync(join(process.cwd(), "extension/entry/styles/reader-settings-shell.css"), "utf8");
    expect(css).toMatch(/data-biliscript-settings-open="1"[^\{]*\.biliscript-reading-header\s*\{[^}]*opacity:\s*0\.65/s);
  });

  it.each(["back", "gear"])("%s 普通退出只恢复原 Tab，不触发内容激活、偏好写入或面板关闭", (exitVia) => {
    readerState.setReaderActiveScriptTab("overview");
    uiRenderer.setReaderScriptTab("overview");
    openFromGear();
    vi.mocked(chrome.storage.local.set).mockClear();
    mocks.ensureReaderOverviewTab.mockClear();
    mocks.ensureChatTabActivated.mockClear();

    if (exitVia === "back") {
      element(ids.readingSettingsBackBtn).click();
    } else {
      element(ids.readingSettingsBtn).click();
    }

    expect(state.reader.readingSettingsExpanded).toBe(false);
    expect(element(ids.readingSettingsPanel).hidden).toBe(true);
    expect(readerState.getReaderActiveScriptTab()).toBe("overview");
    expect(element(ids.readingTabBodyOverview).classList.contains("is-active")).toBe(true);
    expect(document.activeElement).toBe(element(ids.readingSettingsBtn));
    expect(mocks.ensureReaderOverviewTab).not.toHaveBeenCalled();
    expect(mocks.ensureChatTabActivated).not.toHaveBeenCalled();
    expect(vi.mocked(chrome.storage.local.set)).not.toHaveBeenCalled();
    expect(mocks.exitReaderShell).not.toHaveBeenCalled();
  });

  it("顶栏非按钮区域退出设置，主题与全局关闭不落入背景规则", async () => {
    openFromGear();
    document.querySelector<HTMLElement>(".biliscript-reading-header-copy")!.click();
    expect(state.reader.readingSettingsExpanded).toBe(false);

    openFromGear();
    element(ids.readingThemeSelect).click();
    expect(state.reader.readingSettingsExpanded).toBe(true);
    await vi.waitFor(() => {
      expect(mocks.updateReaderPreferences).toHaveBeenCalledWith({ readerTheme: "dark" }, { persist: true });
    });
    expect(mocks.exitReaderShell).not.toHaveBeenCalled();

    element(ids.readingCloseBtn).click();
    expect(mocks.exitReaderShell).toHaveBeenCalledTimes(1);
    expect(state.reader.readingSettingsExpanded).toBe(true);
  });

  it("保留三个 Tab 滚动位置、对话草稿及同一面板生命周期内的设置滚动位置", () => {
    readerState.setReaderActiveScriptTab("chat");
    uiRenderer.setReaderScriptTab("chat");
    element(ids.readingTabBodySubtitle).scrollTop = 31;
    element(ids.readingTabBodyOverview).scrollTop = 52;
    element(ids.readingTabBodyChat).scrollTop = 73;
    element(ids.readingSettingsPanel).scrollTop = 91;
    const input = element(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "未发送草稿";

    openFromGear();
    element(ids.readingSettingsBackBtn).click();

    expect(element(ids.readingTabBodySubtitle).scrollTop).toBe(31);
    expect(element(ids.readingTabBodyOverview).scrollTop).toBe(52);
    expect(element(ids.readingTabBodyChat).scrollTop).toBe(73);
    expect(input.value).toBe("未发送草稿");

    openFromGear();
    expect(element(ids.readingSettingsPanel).scrollTop).toBe(91);
  });

  it("退出后焦点回到来源控件，来源失效时回落到原活动 Tab", () => {
    readerState.setReaderActiveScriptTab("chat");
    uiRenderer.setReaderScriptTab("chat");
    const source = document.createElement("button");
    source.id = ids.readingChatOpenSettings;
    element(ids.readingTabBodyChat).appendChild(source);
    source.focus();
    uiRenderer.openReaderSettingsPanel();
    element(ids.readingSettingsBackBtn).click();
    expect(document.activeElement).toBe(source);

    openFromGear();
    element(ids.readingSettingsBtn).remove();
    element(ids.readingSettingsBackBtn).click();
    expect(document.activeElement).toBe(element(ids.readingTabChat));
  });

  it("程序化激活内容 Tab 时先同步退出设置，再执行内容激活", async () => {
    openFromGear();
    mocks.ensureReaderOverviewTab.mockImplementation(() => {
      expect(state.reader.readingSettingsExpanded).toBe(false);
      expect(element(ids.readingSettingsPanel).hidden).toBe(true);
      expect(element(ids.readingTabBodyOverview).hidden).toBe(false);
    });

    await activation.activateScriptTab("overview");

    expect(readerState.getReaderActiveScriptTab()).toBe("overview");
    expect(mocks.ensureReaderOverviewTab).toHaveBeenCalledTimes(1);
    expect(mocks.exitReaderShell).not.toHaveBeenCalled();
  });
});
