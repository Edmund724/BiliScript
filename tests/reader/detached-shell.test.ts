import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NORMAL_PAGE_URL,
  READER_MODE_URL,
  resetModuleState,
  setLocationUrl
} from "../setup.js";

class StubChildWindow extends EventTarget {
  closed = false;
  innerWidth: number;
  innerHeight: number;
  document: Document;
  focus = vi.fn();
  private closeTriggersPagehide: boolean;

  constructor(options: { width?: number; height?: number; closeTriggersPagehide?: boolean } = {}) {
    super();
    this.innerWidth = options.width ?? 540;
    this.innerHeight = options.height ?? 720;
    this.closeTriggersPagehide = options.closeTriggersPagehide ?? true;
    this.document = document.implementation.createHTMLDocument("Detached");
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.closeTriggersPagehide) {
      this.dispatchEvent(new Event("pagehide"));
    }
  }
}

const mocks = vi.hoisted(() => ({
  replaceReaderModeUrl: vi.fn(),
  requestUiCommand: vi.fn(),
  dispatchChatTabOutsideClick: vi.fn(),
  closeReaderSettingsMode: vi.fn(),
  stepBackReaderSettings: vi.fn(),
  toggleCommandPalette: vi.fn(),
  runQuickActionPrompt: vi.fn(async () => true),
  ensureChatTabActivated: vi.fn(async () => {}),
  closeChatSession: vi.fn(async () => {}),
  removePlayerAiQuickActionButton: vi.fn(async () => {}),
  isPlayerAiLoaded: vi.fn(() => false),
  hydrateMermaid: vi.fn(),
  waitForScriptAnchor: vi.fn(async () => true)
}));

vi.mock("../../extension/bilibili/reader-url.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/bilibili/reader-url.js")>();
  return {
    ...actual,
    replaceReaderModeUrl: mocks.replaceReaderModeUrl
  };
});

vi.mock("../../extension/reader/reader-bus.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/reader-bus.js")>();
  return {
    ...actual,
    requestUiCommand: mocks.requestUiCommand,
    dispatchChatTabOutsideClick: vi.fn((event: Parameters<typeof actual.dispatchChatTabOutsideClick>[0]) => {
      mocks.dispatchChatTabOutsideClick(event);
      return actual.dispatchChatTabOutsideClick(event);
    })
  };
});

vi.mock("../../extension/reader/settings-mode.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/settings-mode.js")>();
  return {
    ...actual,
    closeReaderSettingsMode: mocks.closeReaderSettingsMode,
    stepBackReaderSettings: mocks.stepBackReaderSettings
  };
});

vi.mock("../../extension/reader/command-palette.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/reader/command-palette.js")>();
  return {
    ...actual,
    toggleCommandPalette: vi.fn(() => {
      mocks.toggleCommandPalette();
    })
  };
});

vi.mock("../../extension/reader/lazy-chat-tab.js", () => ({
  ensureReaderChatTab: vi.fn(async () => ({
    ensureChatTabActivated: mocks.ensureChatTabActivated,
    runQuickActionPrompt: mocks.runQuickActionPrompt,
    closeChatSession: mocks.closeChatSession
  })),
  isReaderChatTabLoaded: vi.fn(() => false)
}));

vi.mock("../../extension/ai/lazy-player-ai.js", () => ({
  loadPlayerAi: vi.fn(async () => ({
    removePlayerAiQuickActionButton: mocks.removePlayerAiQuickActionButton
  })),
  isPlayerAiLoaded: mocks.isPlayerAiLoaded
}));

vi.mock("../../extension/ui/lazy-mermaid.js", () => ({
  hydrateMermaid: mocks.hydrateMermaid
}));

vi.mock("../../extension/reader/script-host.js", async (importActual) => {
  const actual = (await importActual()) as typeof import("../../extension/reader/script-host.js");
  return {
    ...actual,
    openScriptHost: vi.fn(() => actual.openScriptHost()),
    closeScriptHost: vi.fn(() => actual.closeScriptHost()),
    waitForScriptAnchor: mocks.waitForScriptAnchor
  };
});

let state: typeof import("../../extension/core/state.js").state;
let getReaderShellState: typeof import("../../extension/core/state.js").getReaderShellState;
let contentEventBus: typeof import("../../extension/shared/content-event-bus.js").contentEventBus;
let activeHost: typeof import("../../extension/shared/active-host.js");
let styleInjector: typeof import("../../extension/shared/style-injector.js");
let detachedWindow: typeof import("../../extension/reader/detached-window.js");
let shell: typeof import("../../extension/reader/shell.js");
let presentation: typeof import("../../extension/reader/presentation.js");
let readerState: typeof import("../../extension/reader/state.js");
let scriptHost: typeof import("../../extension/reader/script-host.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let clipTxMod: typeof import("../../extension/entry/clip-switch-transaction.js");
let videoShared: typeof import("../../extension/bilibili/video-id-shared.js");

function getReadingView(doc: Document = activeHost.getActiveReaderDocument()): HTMLElement | null {
  return doc.getElementById(readerState.ids.readingView);
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(NORMAL_PAGE_URL);
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).documentPictureInPicture;
  vi.clearAllMocks();
  mocks.isPlayerAiLoaded.mockReturnValue(false);

  const coreState = await import("../../extension/core/state.js");
  state = coreState.state;
  getReaderShellState = coreState.getReaderShellState;
  contentEventBus = (await import("../../extension/shared/content-event-bus.js")).contentEventBus;
  activeHost = await import("../../extension/shared/active-host.js");
  styleInjector = await import("../../extension/shared/style-injector.js");
  detachedWindow = await import("../../extension/reader/detached-window.js");
  shell = await import("../../extension/reader/shell.js");
  presentation = await import("../../extension/reader/presentation.js");
  readerState = await import("../../extension/reader/state.js");
  scriptHost = await import("../../extension/reader/script-host.js");
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  clipTxMod = await import("../../extension/entry/clip-switch-transaction.js");
  videoShared = await import("../../extension/bilibili/video-id-shared.js");
});

afterEach(async () => {
  try {
    detachedWindow?.closeDetachedWindowHost(true);
  } catch {
  }
  try {
    await shell?.exitReaderShell();
  } catch {
  }
  delete (globalThis as Record<string, unknown>).documentPictureInPicture;
  document.head.innerHTML = "";
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("M2 独立窗口 Shell 生命周期与路由", () => {
  it("detachReaderShell 迁移面板与滚动位置至独立窗口，暂停 script-host 并保持 #biliscript-root 在页内", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 760 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await styleInjector.ensureReaderStyles();

    const openerRoot = document.getElementById(readerState.ids.root)!;
    const subtitleList = document.getElementById(readerState.ids.readingSubtitleList)!;
    subtitleList.scrollTop = 184;

    const ok = await shell.detachReaderShell();

    expect(ok).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(state.reader.readingDetached).toBe(true);
    expect(state.reader.readingDetachedMode).toBe("pip");
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(shell.isReaderShellIntact()).toBe(true);
    expect(scriptHost.closeScriptHost).toHaveBeenCalled();

    expect(document.getElementById(readerState.ids.root)).toBe(openerRoot);
    expect(openerRoot.contains(document.getElementById(readerState.ids.readingView))).toBe(false);

    const movedView = getReadingView(pipWin.document)!;
    expect(movedView).not.toBeNull();
    expect(movedView.ownerDocument).toBe(pipWin.document);
    expect(movedView.getAttribute("data-biliscript-detached")).toBe("1");
    expect(pipWin.document.documentElement.getAttribute("data-biliscript-reader-mode")).toBe("1");
    expect(pipWin.document.documentElement.getAttribute("data-biliscript-detached")).toBe("1");
    expect(pipWin.document.body.getAttribute("data-biliscript-reading-active")).toBe("1");
    expect(pipWin.document.head.querySelectorAll('link[data-biliscript-style="1"]').length).toBe(0);
    expect(pipWin.document.head.querySelectorAll('style[data-biliscript-style="1"]').length).toBeGreaterThan(0);
    expect(pipWin.document.getElementById(readerState.ids.readingSubtitleList)!.scrollTop).toBe(184);
    expect(pipWin.focus).toHaveBeenCalled();
    expect(pipWin.document.getElementById(uiRenderer.DETACH_BTN_ID)!.getAttribute("aria-pressed")).toBe("true");
    expect(pipWin.document.getElementById(uiRenderer.DETACH_BTN_ID)!.title).toBe("归位回页面");
    expect((pipWin.document.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(true);
    expect((pipWin.document.getElementById(readerState.ids.readingCloseBtn) as HTMLButtonElement).hidden).toBe(true);
  });

  it("弹窗被拦截时 detachReaderShell 保持面板留在页内并展示非阻塞提示", async () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    state.setSettings({ ...state.settings, detachedWindowMode: "popup" });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    const ok = await shell.detachReaderShell();

    expect(ok).toBe(false);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(state.reader.readingDetached).toBe(false);
    expect(
      document.getElementById(readerState.ids.root)!.contains(document.getElementById(readerState.ids.readingView))
    ).toBe(true);

    const notice = document.getElementById(uiRenderer.DETACHED_NOTICE_ID)!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("阻止");
  });

  it("redockReaderShell 归位面板、清理镜像样式、恢复 script-host 与滚动位置并保持打开", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 760 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await styleInjector.ensureReaderStyles();
    await shell.detachReaderShell();

    const detachedSub = pipWin.document.getElementById(readerState.ids.readingSubtitleList)!;
    detachedSub.scrollTop = 312;
    vi.mocked(scriptHost.openScriptHost).mockClear();

    const ok = await shell.redockReaderShell();

    expect(ok).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(state.reader.readingDetached).toBe(false);
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(shell.isReaderShellIntact()).toBe(true);
    expect(pipWin.closed).toBe(true);
    expect(pipWin.document.head.querySelectorAll('style[data-biliscript-style="1"]').length).toBe(0);

    const openerView = document.getElementById(readerState.ids.readingView)!;
    expect(document.getElementById(readerState.ids.root)!.contains(openerView)).toBe(true);
    expect(openerView.getAttribute("data-biliscript-detached")).toBeNull();
    expect(document.getElementById(readerState.ids.readingSubtitleList)!.scrollTop).toBe(312);
    expect(scriptHost.openScriptHost).toHaveBeenCalledTimes(1);
    expect(document.getElementById(uiRenderer.DETACH_BTN_ID)!.getAttribute("aria-pressed")).toBe("false");
    expect(document.getElementById(uiRenderer.DETACH_BTN_ID)!.title).toBe("弹出独立窗口");
    expect((document.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((document.getElementById(readerState.ids.readingCloseBtn) as HTMLButtonElement).hidden).toBe(false);
  });

  it("子窗口外部 pagehide 关闭时同步抢救面板回 #biliscript-root 并完整归位回页内", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 760 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await styleInjector.ensureReaderStyles();
    await shell.detachReaderShell();
    pipWin.document.getElementById(readerState.ids.readingSubtitleList)!.scrollTop = 275;
    vi.mocked(scriptHost.openScriptHost).mockClear();

    pipWin.closed = true;
    pipWin.dispatchEvent(new Event("pagehide"));

    expect(
      document.getElementById(readerState.ids.root)!.contains(document.getElementById(readerState.ids.readingView))
    ).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(state.reader.readingDetached).toBe(false);
    expect(scriptHost.openScriptHost).toHaveBeenCalledTimes(1);

    await vi.waitFor(() => {
      expect(getReaderShellState()).toBe("open");
      expect(readerState.isReaderViewOpen()).toBe(true);
      expect(shell.isReaderShellIntact()).toBe(true);
    });
    const view = document.getElementById(readerState.ids.readingView)!;
    expect(view.hidden).toBe(false);
    expect(view.classList.contains("open")).toBe(true);
    expect(view.getAttribute("data-biliscript-detached")).toBeNull();
    expect(document.getElementById(readerState.ids.readingSubtitleList)!.scrollTop).toBe(275);
    expect((document.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((document.getElementById(readerState.ids.readingCloseBtn) as HTMLButtonElement).hidden).toBe(false);
    expect(pipWin.document.head.querySelectorAll('style[data-biliscript-style="1"]').length).toBe(0);
  });

  it("原位模式切换迁移 DOM/样式并在被拦截时保留原窗口且显示非阻塞提示", async () => {
    const pipWin = new StubChildWindow({ width: 560, height: 700 });
    const popupWin = new StubChildWindow({ width: 560, height: 700 });
    const requestWindow = vi.fn(async () => pipWin as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", { requestWindow });
    vi.spyOn(window, "open").mockImplementation(() => popupWin as unknown as Window);

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await styleInjector.ensureReaderStyles();
    await shell.detachReaderShell();
    pipWin.document.getElementById(readerState.ids.readingSubtitleList)!.scrollTop = 220;

    const switchedToPopup = await activeHost.requestDetachedModeSwitch("popup");
    expect(switchedToPopup).toBe(true);
    expect(pipWin.closed).toBe(true);
    expect(popupWin.closed).toBe(false);
    expect(state.reader.readingDetachedMode).toBe("popup");
    expect(activeHost.getActiveReaderDocument()).toBe(popupWin.document);
    expect((popupWin.document.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement).hidden).toBe(false);
    expect((popupWin.document.getElementById(readerState.ids.readingCloseBtn) as HTMLButtonElement).hidden).toBe(true);
    expect(popupWin.document.getElementById(readerState.ids.readingSubtitleList)!.scrollTop).toBe(220);
    expect(pipWin.document.head.querySelectorAll('style[data-biliscript-style="1"]').length).toBe(0);
    expect(popupWin.document.head.querySelectorAll('link[data-biliscript-style="1"]').length).toBe(0);
    expect(popupWin.document.head.querySelectorAll('style[data-biliscript-style="1"]').length).toBeGreaterThan(0);

    requestWindow.mockRejectedValueOnce(new Error("blocked"));
    const switchedBackBlocked = await shell.switchDetachedWindowMode("pip");
    expect(switchedBackBlocked).toBe(false);
    expect(popupWin.closed).toBe(false);
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(detachedWindow.getDetachedWindowHost()?.document).toBe(popupWin.document);

    const notice = popupWin.document.getElementById(uiRenderer.DETACHED_NOTICE_ID)!;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain("下次弹出时生效");
  });

  it("并发 detach/switch/redock 在 shellTransactionQueue 上串行收敛", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    const popupWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });
    vi.spyOn(window, "open").mockImplementation(() => popupWin as unknown as Window);

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });

    const [d, s, r] = await Promise.all([
      shell.detachReaderShell(),
      shell.switchDetachedWindowMode("popup"),
      shell.redockReaderShell()
    ]);

    expect(d).toBe(true);
    expect(s).toBe(true);
    expect(r).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(
      document.getElementById(readerState.ids.root)!.contains(document.getElementById(readerState.ids.readingView))
    ).toBe(true);
  });

  it("独立窗口态执行 exitReaderShell 直接关闭窗口、归还隐藏面板并跳过退场动画等待", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();
    expect(activeHost.isReaderDetached()).toBe(true);

    await shell.exitReaderShell();

    expect(pipWin.closed).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(readerState.isReaderViewOpen()).toBe(false);
    const view = document.getElementById(readerState.ids.readingView)!;
    expect(document.getElementById(readerState.ids.root)!.contains(view)).toBe(true);
    expect(view.hidden).toBe(true);
    expect(view.getAttribute("data-biliscript-detached")).toBeNull();
  });

  it("独立窗口态同步主题/色板/排版变量/发光/降透/头部按钮且 B 站探测保持在 opener", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    state.reader.setTheme("dark");
    state.reader.setThemeMode("dark");
    state.reader.setPalette("editorial");
    state.setSettings({
      ...state.settings,
      readerFontSizeScale: 120,
      chatLineHeight: 170,
      chatParagraphSpacing: 16,
      chatInputGlow: false,
      reduceTransparency: true
    });

    presentation.applyReadingViewPresentation();

    expect(pipWin.document.documentElement.dataset.biliscriptReaderTheme).toBe("dark");
    expect(pipWin.document.documentElement.dataset.biliscriptReaderPalette).toBe("editorial");
    expect(pipWin.document.body.dataset.biliscriptReaderTheme).toBe("dark");
    expect(pipWin.document.body.dataset.biliscriptReaderPalette).toBe("editorial");
    expect(pipWin.document.documentElement.dataset.chatInputGlow).toBe("0");
    expect(pipWin.document.documentElement.dataset.biliscriptReduceTransparency).toBe("1");
    expect(pipWin.document.documentElement.style.getPropertyValue("--biliscript-reader-font-scale")).toBe("1.2");
    expect(pipWin.document.documentElement.style.getPropertyValue("--biliscript-chat-line-height")).toBe("1.7");
    expect(pipWin.document.documentElement.style.getPropertyValue("--biliscript-chat-paragraph-spacing")).toBe("16px");
    expect(pipWin.document.getElementById(readerState.ids.readingThemeSelect)!.title).toBe("主题：深色");
    expect(mocks.hydrateMermaid).toHaveBeenCalledWith(
      pipWin.document.getElementById(readerState.ids.readingView),
      { force: true }
    );
    expect(activeHost.getOpenerDocument()).toBe(document);
  });

  it("独立窗口态外部入口：open 仅聚焦窗口，chat 聚焦并执行提问且不摘除快速按钮，restore 为空操作", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });
    mocks.isPlayerAiLoaded.mockReturnValue(true);

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();
    mocks.removePlayerAiQuickActionButton.mockClear();
    mocks.replaceReaderModeUrl.mockClear();
    pipWin.focus.mockClear();

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    expect(pipWin.focus).toHaveBeenCalledTimes(1);
    expect(mocks.removePlayerAiQuickActionButton).not.toHaveBeenCalled();
    expect(mocks.replaceReaderModeUrl).not.toHaveBeenCalled();
    expect(activeHost.isReaderDetached()).toBe(true);

    await shell.enterReaderShell({ readerUrl: "", intent: "chat", prompt: "总结这期视频" });
    expect(pipWin.focus).toHaveBeenCalledTimes(2);
    expect(mocks.runQuickActionPrompt).toHaveBeenCalledWith("总结这期视频");
    expect(mocks.removePlayerAiQuickActionButton).not.toHaveBeenCalled();
    expect(activeHost.isReaderDetached()).toBe(true);

    pipWin.focus.mockClear();
    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });
    expect(pipWin.focus).not.toHaveBeenCalled();
    expect(activeHost.isReaderDetached()).toBe(true);
  });

  it("独立窗口态 script-host 保持暂停，不写锚定变量", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    const movedView = pipWin.document.getElementById(readerState.ids.readingView)!;
    scriptHost.openScriptHost();
    scriptHost.relayoutScriptHost();

    expect(movedView.style.getPropertyValue("--biliscript-script-left")).toBe("");
    expect(movedView.getAttribute("data-biliscript-script-float")).toBeNull();
  });

  it("SPA 切 P/切视频保持独立窗口打开且 ensureUiReady 不重复建壳，离开视频页时退出", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    let currentUrl = READER_MODE_URL;
    let currentSig = "BV1test000000:1";
    let runId = 0;
    const refreshReaderClip = vi.fn(async () => {});
    const enterReaderShellOnUrlNavigation = vi.fn(async () => {});

    const tx = clipTxMod.createClipSwitchTransaction({
      readUrl: () => currentUrl,
      computeSignature: () => (currentUrl.includes("BV1other00001") ? "BV1other00001:1" : currentUrl.includes("t.bilibili.com") ? "" : "BV1test000000:1"),
      readSignature: () => currentSig,
      writeIdentity: (u, s) => {
        currentUrl = u;
        currentSig = s;
      },
      readRunId: () => runId,
      writeRunId: (id) => {
        runId = id;
      },
      enforceNormalPageStateIfNeeded: vi.fn(),
      isReaderViewOpen: readerState.isReaderViewOpen,
      isReaderMode: videoShared.isReaderMode,
      isSupportedVideoPage: videoShared.isSupportedVideoPage,
      shouldAutoOpen: () => true,
      isPlayerAiLoaded: () => false,
      ensureUiReady: async () => {
        uiRenderer.ensureUiReady();
      },
      resetClipState: vi.fn(),
      syncPlayerAiQuickAction: vi.fn(),
      enterReaderShellOnUrlNavigation,
      refreshReaderClip,
      exitReaderShell: shell.exitReaderShell,
      startSubtitlePrefetch: vi.fn(),
      logWarn: vi.fn()
    });

    currentUrl = "https://www.bilibili.com/video/BV1other00001/";
    tx.handleUrlChange();

    await vi.waitFor(() => {
      expect(refreshReaderClip).toHaveBeenCalledTimes(1);
    });
    expect(enterReaderShellOnUrlNavigation).not.toHaveBeenCalled();
    expect(
      document.getElementById(readerState.ids.root)!.querySelectorAll(`#${readerState.ids.readingView}`)
    ).toHaveLength(0);
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(pipWin.closed).toBe(false);

    currentUrl = "https://t.bilibili.com/";
    tx.handleUrlChange();

    await vi.waitFor(() => {
      expect(readerState.isReaderViewOpen()).toBe(false);
    });
    expect(pipWin.closed).toBe(true);
  });

  it("reader-gate.css 全屏规则豁免独立窗口且无多余溢出/裸写滚动条", () => {
    const gateCss = readFileSync(join(process.cwd(), "extension/entry/styles/reader-gate.css"), "utf8");
    expect(gateCss).toContain('#biliscript-reading-view:not([data-biliscript-detached="1"])');
    expect(gateCss).toContain('html[data-biliscript-detached="1"]');
    expect(gateCss).toContain("--biliscript-script-width: 100vw;");
    expect(gateCss).toContain("width: 100vw;");
    expect(gateCss).toContain("height: 100vh;");
    expect(gateCss).toContain("overflow: hidden;");

    styleInjector.syncStylesToDocument(document);
  });

  it("switchDetachedWindowMode 在等待几何尺寸期间触发子窗口 pagehide 时取消切换且不打开幽灵窗口", async () => {
    const popupWin = new StubChildWindow({ width: 0, height: 0 });
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    const pipRequest = vi.fn(async () => pipWin as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", { requestWindow: pipRequest });
    vi.spyOn(window, "open").mockImplementation(() => popupWin as unknown as Window);
    state.setSettings({ ...state.settings, detachedWindowMode: "popup" });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    let resolveStorage!: (value: Record<string, unknown>) => void;
    let storageStarted = false;
    vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          storageStarted = true;
          resolveStorage = resolve;
        }) as unknown as Promise<Record<string, unknown>>
    );

    const switchPromise = shell.switchDetachedWindowMode("pip");
    await vi.waitFor(() => {
      expect(storageStarted).toBe(true);
    });
    popupWin.close();
    resolveStorage({});

    expect(await switchPromise).toBe(false);
    expect(pipRequest).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getReaderShellState()).toBe("open");
      expect(readerState.isReaderViewOpen()).toBe(true);
      expect(activeHost.isReaderDetached()).toBe(false);
    });
    const openerView = document.getElementById(readerState.ids.readingView)!;
    expect(document.getElementById(readerState.ids.root)!.contains(openerView)).toBe(true);
    expect(openerView.hidden).toBe(false);
    expect(openerView.classList.contains("open")).toBe(true);
  });

  it("requestWindow 期间触发子窗口 pagehide 且切换被拦截时不将面板重迁回已关闭子窗口", async () => {
    const popupWin = new StubChildWindow({ width: 540, height: 720 });
    vi.spyOn(window, "open").mockImplementation(() => popupWin as unknown as Window);
    state.setSettings({ ...state.settings, detachedWindowMode: "popup" });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();
    const originalView = popupWin.document.getElementById(readerState.ids.readingView)!;

    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => {
        popupWin.close();
        throw new Error("blocked");
      })
    });

    const switched = await shell.switchDetachedWindowMode("pip");

    expect(switched).toBe(false);
    expect(originalView.ownerDocument).toBe(document);
    expect(document.getElementById(readerState.ids.root)!.contains(originalView)).toBe(true);
    expect(state.reader.readingDetached).toBe(false);
    expect(activeHost.isReaderDetached()).toBe(false);

    await vi.waitFor(() => {
      expect(getReaderShellState()).toBe("open");
      expect(readerState.isReaderViewOpen()).toBe(true);
      expect(originalView.hidden).toBe(false);
    });
  });

  it("独立窗口态阅读视图节点被移除后执行 exitReaderShell 仍能干净收尾退出", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    const onClosed = vi.fn();
    const unsubscribe = contentEventBus.on("reader:closed", onClosed);
    pipWin.document.getElementById(readerState.ids.readingView)!.remove();

    await expect(shell.exitReaderShell()).resolves.toBeUndefined();
    unsubscribe();

    expect(getReaderShellState()).toBe("closed");
    expect(readerState.isReaderViewOpen()).toBe(false);
    expect(pipWin.closed).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  it("独立窗口态面板损坏时 enterReaderShell restore 会自愈关闭并重新在页内打开", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    const movedView = pipWin.document.getElementById(readerState.ids.readingView)!;
    movedView.hidden = true;
    expect(shell.isReaderShellIntact()).toBe(false);

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });

    expect(getReaderShellState()).toBe("open");
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(pipWin.closed).toBe(true);
    expect(shell.isReaderShellIntact()).toBe(true);
    expect(
      document.getElementById(readerState.ids.root)!.contains(document.getElementById(readerState.ids.readingView))
    ).toBe(true);
  });

  it("独立窗口态阅读视图被移除后，enterReaderShell restore 能自愈重建视图并页内重开", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    pipWin.document.getElementById(readerState.ids.readingView)!.remove();
    expect(shell.isReaderShellIntact()).toBe(false);

    await expect(
      shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" })
    ).resolves.toBeUndefined();

    expect(getReaderShellState()).toBe("open");
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(pipWin.closed).toBe(true);
    expect(shell.isReaderShellIntact()).toBe(true);
    const rebuiltView = document.getElementById(readerState.ids.readingView);
    expect(rebuiltView).not.toBeNull();
    expect(document.getElementById(readerState.ids.root)!.contains(rebuiltView)).toBe(true);
  });

  it("独立窗口态阅读视图被移除并 exitReaderShell 后，再次 enterReaderShell open 能重建视图并打开", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    pipWin.document.getElementById(readerState.ids.readingView)!.remove();
    await shell.exitReaderShell();
    expect(getReaderShellState()).toBe("closed");

    await expect(
      shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" })
    ).resolves.toBeUndefined();

    expect(getReaderShellState()).toBe("open");
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(shell.isReaderShellIntact()).toBe(true);
    const rebuiltView = document.getElementById(readerState.ids.readingView);
    expect(rebuiltView).not.toBeNull();
    expect(document.getElementById(readerState.ids.root)!.contains(rebuiltView)).toBe(true);
  });

  it("跨 realm 独立窗口内元素聚焦时，exitReaderShell 先 blur 再归还节点并恢复宿主焦点", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const childWin = new StubChildWindow({ width: 540, height: 720 });
    childWin.document = childDoc;
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => childWin as unknown as Window)
    });

    const returnBtn = document.createElement("button");
    returnBtn.id = "test-return-focus-btn";
    document.body.appendChild(returnBtn);
    returnBtn.focus();

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    const movedView = childDoc.getElementById(readerState.ids.readingView)!;
    const childInput = childDoc.createElement("input");
    movedView.appendChild(childInput);
    expect(childInput instanceof HTMLElement).toBe(false);
    childInput.focus();
    expect(childDoc.activeElement).toBe(childInput);
    const blurSpy = vi.spyOn(childInput, "blur");

    await shell.exitReaderShell();

    expect(blurSpy).toHaveBeenCalledTimes(1);
    expect(getReaderShellState()).toBe("closed");
    expect(document.activeElement).toBe(returnBtn);
    iframe.remove();
  });

  it("跨 realm 独立窗口内元素聚焦时，外部 pagehide 归位不触发退出焦点恢复且保持阅读视图开启并聚焦", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const childWin = new StubChildWindow({ width: 540, height: 720 });
    childWin.document = childDoc;
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => childWin as unknown as Window)
    });

    const returnBtn = document.createElement("button");
    returnBtn.id = "test-external-close-return-btn";
    document.body.appendChild(returnBtn);
    returnBtn.focus();

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    const movedView = childDoc.getElementById(readerState.ids.readingView)!;
    const childInput = childDoc.createElement("input");
    movedView.appendChild(childInput);
    childInput.focus();
    const blurSpy = vi.spyOn(childInput, "blur");

    childWin.closed = true;
    childWin.dispatchEvent(new Event("pagehide"));

    expect(blurSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getReaderShellState()).toBe("open");
      expect(readerState.isReaderViewOpen()).toBe(true);
      expect(activeHost.isReaderDetached()).toBe(false);
    });
    expect(document.activeElement).not.toBe(returnBtn);
    iframe.remove();
  });

  it("redockReaderShell 归位时不触发关闭焦点恢复，且保持阅读视图打开并聚焦", async () => {
    const pipWin = new StubChildWindow({ width: 540, height: 720 });
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => pipWin as unknown as Window)
    });

    const returnBtn = document.createElement("button");
    returnBtn.id = "test-redock-return-btn";
    document.body.appendChild(returnBtn);
    returnBtn.focus();

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    const movedView = pipWin.document.getElementById(readerState.ids.readingView)!;
    const childInput = pipWin.document.createElement("input");
    movedView.appendChild(childInput);
    childInput.focus();
    const blurSpy = vi.spyOn(childInput, "blur");

    const ok = await shell.redockReaderShell();

    expect(ok).toBe(true);
    expect(blurSpy).not.toHaveBeenCalled();
    expect(readerState.isReaderViewOpen()).toBe(true);
    expect(document.activeElement).not.toBe(returnBtn);
  });

  it("pendingDetachedExternalClose 期间排队的 detachReaderShell 直接返回 false 且不打开新窗口", async () => {
    const pipWin1 = new StubChildWindow({ width: 0, height: 0 });
    const pipWin2 = new StubChildWindow({ width: 540, height: 720 });
    const requestWindow = vi
      .fn()
      .mockResolvedValueOnce(pipWin1 as unknown as Window)
      .mockResolvedValueOnce(pipWin2 as unknown as Window);
    vi.stubGlobal("documentPictureInPicture", { requestWindow });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    await shell.detachReaderShell();

    let resolveStorage!: (value: Record<string, unknown>) => void;
    let storageStarted = false;
    vi.spyOn(chrome.storage.local, "get").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          storageStarted = true;
          resolveStorage = resolve;
        }) as unknown as Promise<Record<string, unknown>>
    );

    const switchPromise = shell.switchDetachedWindowMode("popup");
    await vi.waitFor(() => {
      expect(storageStarted).toBe(true);
    });

    const queuedDetach = shell.detachReaderShell();
    pipWin1.close();
    resolveStorage({});

    expect(await switchPromise).toBe(false);
    expect(await queuedDetach).toBe(false);
    expect(requestWindow).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(getReaderShellState()).toBe("open");
      expect(readerState.isReaderViewOpen()).toBe(true);
      expect(activeHost.isReaderDetached()).toBe(false);
    });
    expect(document.getElementById(readerState.ids.readingView)!.hidden).toBe(false);
  });

  it("跨 realm iframe 独立窗口态 detachReaderShell 与完整态 ensureUiReady 正确切换按钮并单次响应子文档监听", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const iframeWin = iframe.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
      KeyboardEvent: typeof KeyboardEvent;
    };
    const childWin = new StubChildWindow({ width: 540, height: 720 });
    childWin.document = childDoc;
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => childWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    expect(await shell.detachReaderShell()).toBe(true);

    const detachBtn = childDoc.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement;
    const closeBtn = childDoc.getElementById(readerState.ids.readingCloseBtn) as HTMLButtonElement;
    expect(detachBtn.title).toBe("归位回页面");
    expect(detachBtn.getAttribute("aria-pressed")).toBe("true");
    expect(detachBtn.hidden).toBe(true);
    expect(closeBtn.hidden).toBe(true);

    state.reader.setSettingsExpanded(true);
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    childDoc.body.dispatchEvent(new iframeWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(new iframeWin.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(
      new iframeWin.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    uiRenderer.ensureUiReady({ forceRecreate: false });
    state.reader.setSettingsExpanded(true);
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();
    expect(mocks.closeReaderSettingsMode).not.toHaveBeenCalled();

    childDoc.body.dispatchEvent(new iframeWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    state.reader.setSettingsExpanded(true);
    childDoc.dispatchEvent(new iframeWin.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc.dispatchEvent(
      new iframeWin.KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    await shell.exitReaderShell();
    iframe.remove();
  });

  it("空根重建（restore 与 exit+open）后再次进入跨 realm iframe 独立窗口，按钮状态与子文档监听均单次生效", async () => {
    const pipWin0 = new StubChildWindow({ width: 540, height: 720 });
    const iframe1 = document.createElement("iframe");
    document.body.appendChild(iframe1);
    const childDoc1 = iframe1.contentDocument!;
    const iframeWin1 = iframe1.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
      KeyboardEvent: typeof KeyboardEvent;
    };
    const childWin1 = new StubChildWindow({ width: 540, height: 720 });
    childWin1.document = childDoc1;

    const iframe2 = document.createElement("iframe");
    document.body.appendChild(iframe2);
    const childDoc2 = iframe2.contentDocument!;
    const iframeWin2 = iframe2.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
      KeyboardEvent: typeof KeyboardEvent;
    };
    const childWin2 = new StubChildWindow({ width: 540, height: 720 });
    childWin2.document = childDoc2;

    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi
        .fn()
        .mockResolvedValueOnce(pipWin0 as unknown as Window)
        .mockResolvedValueOnce(childWin1 as unknown as Window)
        .mockResolvedValueOnce(childWin2 as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    expect(await shell.detachReaderShell()).toBe(true);

    pipWin0.document.getElementById(readerState.ids.readingView)!.remove();
    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "restore" });
    expect(await shell.detachReaderShell()).toBe(true);

    const btn1 = childDoc1.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement;
    expect(btn1.title).toBe("归位回页面");
    expect(btn1.getAttribute("aria-pressed")).toBe("true");

    state.reader.setSettingsExpanded(true);
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();

    childDoc1.body.dispatchEvent(new iframeWin1.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    state.reader.setSettingsExpanded(true);
    childDoc1.dispatchEvent(new iframeWin1.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc1.dispatchEvent(
      new iframeWin1.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    childDoc1.getElementById(readerState.ids.readingView)!.remove();
    await shell.exitReaderShell();
    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    expect(await shell.detachReaderShell()).toBe(true);

    const btn2 = childDoc2.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement;
    expect(btn2.title).toBe("归位回页面");
    expect(btn2.getAttribute("aria-pressed")).toBe("true");

    state.reader.setSettingsExpanded(true);
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    childDoc1.body.dispatchEvent(new iframeWin1.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();

    childDoc2.body.dispatchEvent(new iframeWin2.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    state.reader.setSettingsExpanded(true);
    childDoc2.dispatchEvent(new iframeWin2.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    childDoc2.dispatchEvent(
      new iframeWin2.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })
    );
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    await shell.exitReaderShell();
    iframe1.remove();
    iframe2.remove();
  });

  it("Probe R3-6：独立窗口态视图被移除且未先 exit/restore 时调用 ensureUiReady 关闭残留宿主并重建页内面板", async () => {
    const iframe = document.createElement("iframe");
    document.body.appendChild(iframe);
    const childDoc = iframe.contentDocument!;
    const iframeWin = iframe.contentWindow! as Window & {
      MouseEvent: typeof MouseEvent;
    };
    const childWin = new StubChildWindow({ width: 540, height: 720 });
    childWin.document = childDoc;
    vi.stubGlobal("documentPictureInPicture", {
      requestWindow: vi.fn(async () => childWin as unknown as Window)
    });

    await shell.enterReaderShell({ readerUrl: READER_MODE_URL, intent: "open" });
    expect(await shell.detachReaderShell()).toBe(true);

    childDoc.getElementById(readerState.ids.readingView)!.remove();
    expect(activeHost.isReaderDetached()).toBe(true);
    expect(state.reader.readingDetached).toBe(true);

    expect(() => uiRenderer.ensureUiReady()).not.toThrow();

    expect(childWin.closed).toBe(true);
    expect(activeHost.isReaderDetached()).toBe(false);
    expect(state.reader.readingDetached).toBe(false);
    expect(state.reader.readingDetachedMode).toBeNull();

    const rebuiltRoot = document.getElementById(readerState.ids.root)!;
    const rebuiltView = document.getElementById(readerState.ids.readingView)!;
    expect(rebuiltRoot).not.toBeNull();
    expect(rebuiltView).not.toBeNull();
    expect(rebuiltRoot.contains(rebuiltView)).toBe(true);
    const detachBtn = document.getElementById(uiRenderer.DETACH_BTN_ID) as HTMLButtonElement;
    expect(detachBtn.title).toBe("弹出独立窗口");
    expect(detachBtn.getAttribute("aria-pressed")).toBe("false");

    state.reader.setSettingsExpanded(true);
    mocks.dispatchChatTabOutsideClick.mockClear();
    mocks.closeReaderSettingsMode.mockClear();
    mocks.stepBackReaderSettings.mockClear();
    mocks.toggleCommandPalette.mockClear();

    childDoc.body.dispatchEvent(new iframeWin.MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).not.toHaveBeenCalled();

    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(mocks.dispatchChatTabOutsideClick).toHaveBeenCalledTimes(1);
    expect(mocks.closeReaderSettingsMode).toHaveBeenCalledTimes(1);

    state.reader.setSettingsExpanded(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(mocks.stepBackReaderSettings).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
    await vi.waitFor(() => {
      expect(mocks.toggleCommandPalette).toHaveBeenCalledTimes(1);
    });

    await shell.exitReaderShell();
    iframe.remove();
  });
});
