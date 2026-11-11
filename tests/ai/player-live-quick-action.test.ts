import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetModuleState } from "../setup.js";

describe("player-ai: 播放器实时伴看快捷按钮与全屏联动", () => {
  let playerContainer: HTMLElement;
  let mockShell: { enterReaderShell: ReturnType<typeof vi.fn> };
  let mockEnsureUiReady: ReturnType<typeof vi.fn>;
  let mockEnsureReaderChatTab: ReturnType<typeof vi.fn>;
  let mockChatTab: {
    ensureChatTabActivated: ReturnType<typeof vi.fn>;
    startLiveCompanion: ReturnType<typeof vi.fn>;
    stopLiveCompanion: ReturnType<typeof vi.fn>;
    ensureFullscreenOverlay: ReturnType<typeof vi.fn>;
    getFullscreenLiveOverlay: ReturnType<typeof vi.fn>;
    getLiveController: ReturnType<typeof vi.fn>;
  };
  let mockLiveSession: {
    startLiveCompanion: ReturnType<typeof vi.fn>;
    stopLiveCompanion: ReturnType<typeof vi.fn>;
    getLiveController: ReturnType<typeof vi.fn>;
    ensureFullscreenOverlay: ReturnType<typeof vi.fn>;
    getFullscreenLiveOverlay: ReturnType<typeof vi.fn>;
    isLiveCompanionActive: ReturnType<typeof vi.fn>;
    syncPlayerInterpretQuickAction: ReturnType<typeof vi.fn>;
    toggleInterpret: ReturnType<typeof vi.fn>;
  };
  let mockOverlay: {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
  };
  let isReaderOpen = false;

  beforeEach(async () => {
    resetModuleState();
    vi.useFakeTimers();

    document.body.innerHTML = "";
    isReaderOpen = false;

    playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    document.body.appendChild(playerContainer);

    mockOverlay = {
      show: vi.fn(),
      hide: vi.fn(),
      restore: vi.fn(),
      isVisible: vi.fn(() => false)
    };

    mockShell = {
      enterReaderShell: vi.fn(async () => {
        isReaderOpen = true;
      })
    };

    mockChatTab = {
      ensureChatTabActivated: vi.fn(async () => {}),
      startLiveCompanion: vi.fn(async () => true),
      stopLiveCompanion: vi.fn(() => {}),
      ensureFullscreenOverlay: vi.fn(() => mockOverlay),
      getFullscreenLiveOverlay: vi.fn(() => mockOverlay),
      getLiveController: vi.fn(() => null)
    };

    mockLiveSession = {
      startLiveCompanion: vi.fn(async () => true),
      stopLiveCompanion: vi.fn(() => {}),
      getLiveController: vi.fn(() => null),
      ensureFullscreenOverlay: vi.fn(() => mockOverlay),
      getFullscreenLiveOverlay: vi.fn(() => mockOverlay),
      isLiveCompanionActive: vi.fn(() => false),
      syncPlayerInterpretQuickAction: vi.fn(),
      toggleInterpret: vi.fn(async () => {})
    };

    mockEnsureUiReady = vi.fn(async () => {});
    mockEnsureReaderChatTab = vi.fn(async () => mockChatTab);

    vi.doMock("../../extension/reader/lazy-shell.js", () => ({
      ensureReaderShell: async () => mockShell
    }));

    vi.doMock("../../extension/reader/lazy-chat-tab.js", () => ({
      ensureReaderChatTab: mockEnsureReaderChatTab,
      isReaderChatTabLoaded: () => false
    }));

    vi.doMock("../../extension/live/live-companion-session.js", () => mockLiveSession);

    vi.doMock("../../extension/reader/state.js", () => ({
      isReaderViewOpen: () => isReaderOpen
    }));

    vi.doMock("../../extension/ui/lazy-ui.js", () => ({
      ensureUiReady: mockEnsureUiReady
    }));

    vi.doMock("../../extension/core/runtime.js", () => ({
      getSettings: async () => ({
        enablePlayerAiQuickAction: true
      })
    }));

    const { state } = await import("../../extension/core/state.js");
    state.setSettings({ enablePlayerAiQuickAction: true } as any);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("../../extension/reader/lazy-shell.js");
    vi.doUnmock("../../extension/reader/lazy-chat-tab.js");
    vi.doUnmock("../../extension/live/live-companion-session.js");
    vi.doUnmock("../../extension/reader/state.js");
    vi.doUnmock("../../extension/ui/lazy-ui.js");
    vi.doUnmock("../../extension/core/runtime.js");
  });

  it("实时伴看按钮独立挂载于底部控制栏清晰度控件左侧，不与 AI 快捷按钮共用 wrap", async () => {
    const controlWrap = document.createElement("div");
    controlWrap.className = "bpx-player-control-wrap";
    const controlBottomRight = document.createElement("div");
    controlBottomRight.className = "bpx-player-control-bottom-right";
    const qualityBtn = document.createElement("div");
    qualityBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-quality";
    qualityBtn.textContent = "1080P 高码率";
    controlBottomRight.appendChild(qualityBtn);
    controlWrap.appendChild(controlBottomRight);
    playerContainer.appendChild(controlWrap);

    const { schedulePlayerAiQuickActionSync, stopPlayerAiQuickAction } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const aiButton = document.getElementById("biliscript-player-ai-quick-action");
    const liveButton = document.getElementById("biliscript-player-live-quick-action");
    const liveWrap = document.getElementById("biliscript-player-live-quick-action-wrap");
    const interpretButton = document.getElementById("biliscript-player-interpret-quick-action");
    const interpretWrap = document.getElementById("biliscript-player-interpret-quick-action-wrap");
    const aiWrap = playerContainer.querySelector(".biliscript-player-ai-wrap");

    expect(aiButton).not.toBeNull();
    expect(liveButton).not.toBeNull();
    expect(liveWrap).not.toBeNull();
    expect(interpretButton).not.toBeNull();
    expect(interpretWrap).not.toBeNull();
    expect(aiWrap).not.toBeNull();

    expect(aiWrap?.children[0]).toBe(aiButton);
    expect(aiWrap?.contains(liveButton)).toBe(false);
    expect(aiWrap?.contains(interpretButton)).toBe(false);

    expect(interpretWrap?.contains(interpretButton)).toBe(true);
    expect(interpretWrap?.nextElementSibling).toBe(liveWrap);
    expect(liveWrap?.contains(liveButton)).toBe(true);
    expect(liveWrap?.nextElementSibling).toBe(qualityBtn);
    expect(liveButton?.getAttribute("aria-label")).toBe("实时伴看");
    expect(interpretButton?.textContent).toBe("实时翻译");

    stopPlayerAiQuickAction();
    expect(document.getElementById("biliscript-player-interpret-quick-action")).toBeNull();
    expect(document.getElementById("biliscript-player-interpret-quick-action-wrap")).toBeNull();
    expect(document.getElementById("biliscript-player-live-quick-action")).toBeNull();
    expect(document.getElementById("biliscript-player-live-quick-action-wrap")).toBeNull();
    expect(document.querySelector(".biliscript-player-ai-wrap")).toBeNull();
  });

  it("点击实时翻译只切换同传，不启动伴看或创建伴看浮窗", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const interpretButton = document.getElementById("biliscript-player-interpret-quick-action") as HTMLButtonElement;
    interpretButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockLiveSession.toggleInterpret).toHaveBeenCalledTimes(1);
    expect(mockLiveSession.startLiveCompanion).not.toHaveBeenCalled();
    expect(mockLiveSession.ensureFullscreenOverlay).not.toHaveBeenCalled();
  });

  it("非全屏下点击伴看按钮：直接启动独立伴看会话，不打开文摘面板，也不初始化 AI 对话 tab", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockShell.enterReaderShell).not.toHaveBeenCalled();
    expect(mockEnsureUiReady).not.toHaveBeenCalled();
    expect(mockEnsureReaderChatTab).not.toHaveBeenCalled();
    expect(mockChatTab.ensureChatTabActivated).not.toHaveBeenCalled();
    expect(mockLiveSession.startLiveCompanion).toHaveBeenCalledTimes(1);
    expect(document.getElementById("biliscript-reading-view")).toBeNull();
    expect(document.getElementById("biliscript-chat-messages")).toBeNull();
  });

  it("player-ai 最外层启动异常进入浮窗失败卡且不泄露凭据", async () => {
    const syncState = vi.fn();
    (mockOverlay as any).syncState = syncState;
    mockLiveSession.startLiveCompanion.mockRejectedValue(new Error("启动失败：AIza-outer-secret"));
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    (document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockLiveSession.startLiveCompanion).toHaveBeenCalledTimes(1);
    expect(mockLiveSession.ensureFullscreenOverlay).toHaveBeenCalledTimes(1);
    expect(mockOverlay.show).toHaveBeenCalledWith({ forceExpand: true });
    expect(syncState).toHaveBeenCalledWith("failure", false, "实时伴看启动失败，请重试", "unknown");
    expect(document.body.textContent).not.toContain("AIza-outer-secret");
  });

  it("全屏下点击伴看按钮：直接启动独立伴看会话，不打开文摘面板，也不初始化 AI 对话 tab", async () => {
    // 模拟 B 站网页全屏
    playerContainer.setAttribute("data-screen", "web");

    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockShell.enterReaderShell).not.toHaveBeenCalled();
    expect(mockEnsureUiReady).not.toHaveBeenCalled();
    expect(mockEnsureReaderChatTab).not.toHaveBeenCalled();
    expect(mockChatTab.ensureChatTabActivated).not.toHaveBeenCalled();
    expect(mockLiveSession.startLiveCompanion).toHaveBeenCalledTimes(1);
  });

  it("伴看开启与关闭时实时伴看快捷按钮同步高亮态（is-active）与无障碍属性", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    const { syncPlayerLiveQuickActionState } = await import("../../extension/live/live-overlay-binding.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    const liveWrap = document.getElementById("biliscript-player-live-quick-action-wrap") as HTMLElement;

    expect(liveButton.classList.contains("is-active")).toBe(false);
    expect(liveWrap.classList.contains("is-active")).toBe(false);
    expect(liveButton.getAttribute("aria-pressed")).toBe("false");
    expect(liveButton.getAttribute("aria-label")).toBe("实时伴看");

    // 开启伴看
    syncPlayerLiveQuickActionState(true);
    expect(liveButton.classList.contains("is-active")).toBe(true);
    expect(liveWrap.classList.contains("is-active")).toBe(true);
    expect(liveButton.getAttribute("aria-pressed")).toBe("true");
    expect(liveButton.getAttribute("aria-label")).toBe("实时伴看 (已开启)");

    // 关闭伴看
    syncPlayerLiveQuickActionState(false);
    expect(liveButton.classList.contains("is-active")).toBe(false);
    expect(liveWrap.classList.contains("is-active")).toBe(false);
    expect(liveButton.getAttribute("aria-pressed")).toBe("false");
    expect(liveButton.getAttribute("aria-label")).toBe("实时伴看");
  });

  it("伴看已处于开启状态下再次点击伴看按钮：调用独立会话 stopLiveCompanion 关闭伴看", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    const { syncPlayerLiveQuickActionState } = await import("../../extension/live/live-overlay-binding.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    // 模拟伴看已开启
    syncPlayerLiveQuickActionState(true);
    expect(liveButton.classList.contains("is-active")).toBe(true);

    // 再次点击
    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockLiveSession.stopLiveCompanion).toHaveBeenCalledTimes(1);
    expect(mockLiveSession.startLiveCompanion).not.toHaveBeenCalled();
  });
});

describe("live/live-companion-session: 独立伴看会话所有权、对话按需消费与页面关闭清理", () => {
  beforeEach(() => {
    resetModuleState();
    document.body.innerHTML = "";
    const playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    document.body.appendChild(playerContainer);
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("独立伴看会话持有控制器与浮窗；关闭 AI 对话会话不销毁伴看，关闭页面（pagehide）彻底清理连接、浮窗与工具任务", async () => {
    const session = await import("../../extension/live/live-companion-session.js");
    const controller = session.ensureLiveController();
    expect(controller).not.toBeNull();

    const startSpy = vi.spyOn(controller, "start").mockImplementation(async () => {
      vi.spyOn(controller, "getState").mockReturnValue("connected");
      session.getLiveOverlayBinding().handleStateChange("connected");
      return true;
    });
    const stopSpy = vi.spyOn(controller, "stop");
    const disposeSpy = vi.spyOn(controller, "dispose");

    // 1. 面板未打开时直接启动伴看：展开播放器内连接卡，不创建文摘面板或对话 DOM
    expect(await session.startLiveCompanion()).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const overlay = session.getFullscreenLiveOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay?.isVisible()).toBe(true);
    expect(overlay?.isMinimized()).toBe(false);
    expect(document.getElementById("biliscript-reading-view")).toBeNull();
    expect(document.getElementById("biliscript-chat-messages")).toBeNull();

    // 2. 打开文摘面板并初始化对话 tab：消费同一个独立伴看控制器与浮窗，关闭对话会话不中断伴看
    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    const chat = await import("../../extension/reader/chat-tab.js");
    await chat.ensureChatTabActivated();

    expect(chat.getLiveController()).toBe(controller);
    expect(chat.getFullscreenLiveOverlay()).toBe(overlay);

    chat.closeChatSession();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(overlay?.isVisible()).toBe(true);

    // 2.5 即使 AI 对话未加载或已关闭，跨标签页接管请求（reader-bus requestLiveCompanionStop）仍可停止独立伴看
    const { requestLiveCompanionStop } = await import("../../extension/reader/reader-bus.js");
    requestLiveCompanionStop();
    expect(stopSpy).toHaveBeenCalledTimes(1);

    // 3. 页面关闭（pagehide）：清理伴看连接、移除浮窗 DOM 并取消遗留工具任务
    window.dispatchEvent(new Event("pagehide"));
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById("biliscript-fullscreen-live-overlay")).toBeNull();
    expect(document.querySelector(".biliscript-fullscreen-live-mini-capsule")).toBeNull();
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(false);
  });

  it("控制栏同传按钮跟随真实 CC 字幕状态，且不创建伴看浮窗", async () => {
    const session = await import("../../extension/live/live-companion-session.js");
    const { state } = await import("../../extension/core/state.js");
    const { notifyReaderPresenter } = await import("../../extension/reader/reader-bus.js");
    const wrap = document.createElement("div");
    wrap.id = "biliscript-player-interpret-quick-action-wrap";
    const button = document.createElement("button");
    button.id = "biliscript-player-interpret-quick-action";
    wrap.appendChild(button);
    document.body.appendChild(wrap);
    session.ensureLiveController();

    session.syncPlayerInterpretQuickAction();
    expect(button.hidden).toBe(true);

    state.clip.setSubtitleFetchState("empty");
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(wrap.hidden).toBe(false);

    state.clip.setSubtitles([{ id: "cc-1", lan: "zh-CN", subtitleUrl: "https://example.com/cc.json" }]);
    state.clip.setSubtitleFetchState("ready");
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(true);
    expect(wrap.hidden).toBe(true);

    state.clip.setSubtitles([{ id: "asr-1", lan: "asr-zh", subtitleUrl: "" }]);
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(session.getFullscreenLiveOverlay()).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
  });
});
