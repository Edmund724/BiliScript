import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const mocks = vi.hoisted(() => ({
  detachReaderShell: vi.fn(async () => true),
  redockReaderShell: vi.fn(async () => true),
  exitReaderShell: vi.fn(async () => {}),
  closeReaderSettingsMode: vi.fn(),
  stepBackReaderSettings: vi.fn(),
  hasReaderSettingsOverlayOpen: vi.fn(() => false),
  toggleCommandPalette: vi.fn(),
  dispatchChatTabOutsideClick: vi.fn()
}));

vi.mock("../../extension/reader/shell.js", () => ({
  detachReaderShell: mocks.detachReaderShell,
  redockReaderShell: mocks.redockReaderShell,
  exitReaderShell: mocks.exitReaderShell
}));

vi.mock("../../extension/reader/settings-mode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/settings-mode.js")>();
  return {
    ...actual,
    closeReaderSettingsMode: mocks.closeReaderSettingsMode,
    stepBackReaderSettings: mocks.stepBackReaderSettings,
    hasReaderSettingsOverlayOpen: mocks.hasReaderSettingsOverlayOpen
  };
});

vi.mock("../../extension/reader/lazy-reader.js", () => ({
  ensureReaderDomain: vi.fn(async () => ({
    toggleCommandPalette: mocks.toggleCommandPalette,
    renderReaderPanels: vi.fn(),
    updateReaderPreferences: vi.fn(),
    stopReadingViewSync: vi.fn()
  }))
}));

vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/reader-bus.js")>();
  return {
    ...actual,
    dispatchChatTabOutsideClick: mocks.dispatchChatTabOutsideClick
  };
});

import { state, transitionReaderShell } from "../../extension/core/state.js";
import { ids } from "../../extension/reader/state.js";
import { isReaderDetached, resetActiveReaderHost, setActiveReaderHost } from "../../extension/shared/active-host.js";
import {
  DETACHED_NOTICE_ID,
  DETACH_BTN_ID,
  ensureUiReady,
  refreshDetachButton,
  setReaderScriptTab
} from "../../extension/ui/ui-renderer.js";

class StubWin extends EventTarget {
  closed = false;
  document: Document;
  constructor() {
    super();
    this.document = document.implementation.createHTMLDocument("Detached");
  }
}

beforeEach(() => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.body.innerHTML = "";
  vi.clearAllMocks();
  ensureUiReady({ forceRecreate: true });
});

afterEach(() => {
  resetActiveReaderHost();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ui-renderer 固定 4 按钮顶栏与 Active Host 监听重绑", () => {
  it("顶栏固定 4 个无边框图标按钮且顺序为 [弹出/归位] [主题] [设置] [退出]", () => {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(".biliscript-reading-actions > button")
    );
    expect(buttons.map((b) => b.id)).toEqual([
      DETACH_BTN_ID,
      ids.readingThemeSelect,
      ids.readingSettingsBtn,
      ids.readingCloseBtn
    ]);
    expect(buttons.every((b) => b.classList.contains("biliscript-reading-icon-btn"))).toBe(true);
    expect(buttons.every((b) => !b.hidden)).toBe(true);
    expect(document.getElementById(DETACHED_NOTICE_ID)?.hidden).toBe(true);
  });

  it("refreshDetachButton 与点击分发根据独立窗口状态及模式切换显隐", async () => {
    const btn = document.getElementById(DETACH_BTN_ID) as HTMLButtonElement;
    const closeBtn = document.getElementById(ids.readingCloseBtn) as HTMLButtonElement;
    expect(btn.title).toBe("弹出独立窗口");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.hidden).toBe(false);
    expect(closeBtn.hidden).toBe(false);

    btn.click();
    expect(mocks.detachReaderShell).toHaveBeenCalledTimes(1);

    const childWin = new StubWin();
    childWin.document.body.appendChild(
      childWin.document.adoptNode(document.getElementById(ids.readingView)!)
    );
    state.reader.setDetachedMode("pip");
    setActiveReaderHost(childWin.document, childWin as unknown as Window);

    const movedBtn = childWin.document.getElementById(DETACH_BTN_ID) as HTMLButtonElement;
    const movedCloseBtn = childWin.document.getElementById(ids.readingCloseBtn) as HTMLButtonElement;
    const movedThemeBtn = childWin.document.getElementById(ids.readingThemeSelect) as HTMLButtonElement;
    const movedSettingsBtn = childWin.document.getElementById(ids.readingSettingsBtn) as HTMLButtonElement;
    expect(movedBtn.title).toBe("归位回页面");
    expect(movedBtn.getAttribute("aria-label")).toBe("归位回页面");
    expect(movedBtn.getAttribute("aria-pressed")).toBe("true");
    expect(movedBtn.hidden).toBe(true);
    expect(movedCloseBtn.hidden).toBe(true);
    expect(movedThemeBtn.hidden).toBe(false);
    expect(movedSettingsBtn.hidden).toBe(false);

    state.reader.setDetachedMode("popup");
    refreshDetachButton(true);
    expect(movedBtn.hidden).toBe(false);
    expect(movedCloseBtn.hidden).toBe(true);

    movedBtn.click();
    expect(mocks.redockReaderShell).toHaveBeenCalledTimes(1);

    state.reader.setDetachedMode(null);
    refreshDetachButton(false);
    expect(movedBtn.title).toBe("弹出独立窗口");
    expect(movedBtn.hidden).toBe(false);
    expect(movedCloseBtn.hidden).toBe(false);
  });

  it("文档级 click/keydown 通过 onActiveHostChange 重绑且不残留旧宿主或旧闭包", async () => {
    transitionReaderShell("open");
    state.reader.setSettingsExpanded(true);

    const childWin = new StubWin();
    const readingView = document.getElementById(ids.readingView)!;
    childWin.document.body.appendChild(childWin.document.adoptNode(readingView));
    setActiveReaderHost(childWin.document, childWin as unknown as Window);

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    childWin.document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    childWin.document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childWin.document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    setReaderScriptTab("overview");
    expect(
      childWin.document.getElementById(ids.readingTabOverview)?.classList.contains("is-active")
    ).toBe(true);

    resetActiveReaderHost();
    document.body.appendChild(document.adoptNode(childWin.document.getElementById(ids.readingView)!));
    ensureUiReady({ forceRecreate: true });
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();

    childWin.document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);
  });

  it("跨 realm 的 iframe 子文档按钮 SVG path 点击不误关设置，点击顶栏空白仍关闭设置", () => {
    transitionReaderShell("open");
    state.reader.setSettingsExpanded(true);

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const childWin = iframe.contentWindow! as Window & { Element: typeof Element; MouseEvent: typeof MouseEvent };

    const readingView = document.getElementById(ids.readingView)!;
    childDoc.body.appendChild(childDoc.adoptNode(readingView));
    setActiveReaderHost(childDoc, childWin);

    const detachBtn = childDoc.getElementById(DETACH_BTN_ID)!;
    const detachPath = childDoc.createElementNS("http://www.w3.org/2000/svg", "path");
    detachBtn.appendChild(detachPath);
    expect(detachPath instanceof Element).toBe(false);
    expect(detachPath instanceof childWin.Element).toBe(true);

    detachPath.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    const themeBtn = childDoc.getElementById(ids.readingThemeSelect)!;
    const themePath = childDoc.createElementNS("http://www.w3.org/2000/svg", "path");
    themeBtn.appendChild(themePath);
    expect(themePath instanceof Element).toBe(false);
    themePath.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    const header = childDoc.querySelector<HTMLElement>(".biliscript-reading-header")!;
    header.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    iframe.remove();
  });

  it("空 #biliscript-root 缺失阅读视图时 ensureUiReady() 重建视图且不重复绑定宿主监听", () => {
    const view = document.getElementById(ids.readingView)!;
    view.remove();
    expect(document.getElementById(ids.root)).not.toBeNull();
    expect(document.getElementById(ids.readingView)).toBeNull();

    ensureUiReady();

    const rebuiltRoot = document.getElementById(ids.root)!;
    const rebuiltView = document.getElementById(ids.readingView)!;
    expect(rebuiltRoot).not.toBeNull();
    expect(rebuiltView).not.toBeNull();
    expect(rebuiltRoot.contains(rebuiltView)).toBe(true);

    transitionReaderShell("open");
    state.reader.setSettingsExpanded(true);
    mocks.closeReaderSettingsMode.mockClear();
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.stepBackReaderSettings.mockClear();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);
  });

  it("独立窗口态视图完好时 ensureUiReady() 保留独立窗口视图而不重复在页内建壳", () => {
    const childWin = new StubWin();
    const readingView = document.getElementById(ids.readingView)!;
    childWin.document.body.appendChild(childWin.document.adoptNode(readingView));
    setActiveReaderHost(childWin.document, childWin as unknown as Window);

    ensureUiReady();

    expect(document.getElementById(ids.root)).not.toBeNull();
    expect(document.getElementById(ids.readingView)).toBeNull();
    expect(childWin.document.getElementById(ids.readingView)).toBe(readingView);
  });

  it("跨 realm iframe 独立化后正确切换顶栏按钮与单次响应文档监听，ensureUiReady(forceRecreate: false) 保持监听完好", async () => {
    transitionReaderShell("open");
    state.reader.setSettingsExpanded(true);

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const childWin = iframe.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
      KeyboardEvent: typeof KeyboardEvent;
    };

    const readingView = document.getElementById(ids.readingView)!;
    childDoc.body.appendChild(childDoc.adoptNode(readingView));
    setActiveReaderHost(childDoc, childWin);

    const detachBtn = childDoc.getElementById(DETACH_BTN_ID) as HTMLButtonElement;
    expect(detachBtn.title).toBe("归位回页面");
    expect(detachBtn.getAttribute("aria-label")).toBe("归位回页面");
    expect(detachBtn.getAttribute("aria-pressed")).toBe("true");

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    childDoc.body.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(new childWin.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(
      new childWin.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    ensureUiReady({ forceRecreate: false });
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    expect(document.getElementById(ids.root)).not.toBeNull();
    expect(document.getElementById(ids.readingView)).toBeNull();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    childDoc.body.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(new childWin.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(
      new childWin.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    iframe.remove();
  });

  it("空 #biliscript-root 重建后再跨 realm 独立化仍正确更新顶栏按钮与单次触发子文档监听", async () => {
    document.getElementById(ids.readingView)!.remove();
    ensureUiReady();

    transitionReaderShell("open");
    state.reader.setSettingsExpanded(true);

    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const childWin = iframe.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
      KeyboardEvent: typeof KeyboardEvent;
    };

    const rebuiltView = document.getElementById(ids.readingView)!;
    childDoc.body.appendChild(childDoc.adoptNode(rebuiltView));
    setActiveReaderHost(childDoc, childWin);

    const detachBtn = childDoc.getElementById(DETACH_BTN_ID) as HTMLButtonElement;
    expect(detachBtn.title).toBe("归位回页面");
    expect(detachBtn.getAttribute("aria-pressed")).toBe("true");

    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();

    childDoc.body.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(new childWin.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(
      new childWin.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    iframe.remove();
  });

  it("独立窗口态视图缺失时 ensureUiReady() 复位脱离态并在页内重建完整面板", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const childWin = iframe.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
    };

    const readingView = document.getElementById(ids.readingView)!;
    childDoc.body.appendChild(childDoc.adoptNode(readingView));
    state.reader.setDetachedMode("pip");
    setActiveReaderHost(childDoc, childWin);

    childDoc.getElementById(ids.readingView)!.remove();
    expect(isReaderDetached()).toBe(true);
    expect(document.getElementById(ids.readingView)).toBeNull();

    expect(() => ensureUiReady()).not.toThrow();

    expect(isReaderDetached()).toBe(false);
    expect(state.reader.readingDetached).toBe(false);
    expect(state.reader.readingDetachedMode).toBeNull();

    const rebuiltRoot = document.getElementById(ids.root)!;
    const rebuiltView = document.getElementById(ids.readingView)!;
    expect(rebuiltRoot.contains(rebuiltView)).toBe(true);
    const detachBtn = document.getElementById(DETACH_BTN_ID) as HTMLButtonElement;
    expect(detachBtn.title).toBe("弹出独立窗口");
    expect(detachBtn.getAttribute("aria-pressed")).toBe("false");

    transitionReaderShell("open");
    state.reader.setSettingsExpanded(true);
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    childDoc.body.dispatchEvent(new childWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    iframe.remove();
  });
});
