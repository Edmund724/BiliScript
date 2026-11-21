import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetModuleState } from "../setup.js";

describe("player-ai: 播放器实时伴看快捷按钮与全屏联动", () => {
  let playerContainer: HTMLElement;
  let mockLiveSession: {
    startLiveCompanion: ReturnType<typeof vi.fn>;
    stopLiveCompanion: ReturnType<typeof vi.fn>;
    getLiveController: ReturnType<typeof vi.fn>;
    ensureFullscreenOverlay: ReturnType<typeof vi.fn>;
    getFullscreenLiveOverlay: ReturnType<typeof vi.fn>;
    isLiveCompanionActive: ReturnType<typeof vi.fn>;
  };
  let mockApplyInterpretChoice: ReturnType<typeof vi.fn<(choice: any) => Promise<void>>>;
  let mockSyncInterpretQuickAction: ReturnType<typeof vi.fn>;
  let mockOverlay: {
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    isVisible: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    resetModuleState();
    vi.useFakeTimers();

    document.body.innerHTML = "";

    playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    document.body.appendChild(playerContainer);

    mockOverlay = {
      show: vi.fn(),
      hide: vi.fn(),
      restore: vi.fn(),
      isVisible: vi.fn(() => false)
    };

    mockLiveSession = {
      startLiveCompanion: vi.fn(async () => true),
      stopLiveCompanion: vi.fn(() => {}),
      getLiveController: vi.fn(() => null),
      ensureFullscreenOverlay: vi.fn(() => mockOverlay),
      getFullscreenLiveOverlay: vi.fn(() => mockOverlay),
      isLiveCompanionActive: vi.fn(() => false)
    };
    mockApplyInterpretChoice = vi.fn(async () => {});
    mockSyncInterpretQuickAction = vi.fn();

    vi.doMock("../../extension/live/live-companion-session.js", () => mockLiveSession);

    const actualInterpret = await vi.importActual<typeof import("../../extension/live/player-interpret.js")>(
      "../../extension/live/player-interpret.js"
    );
    vi.doMock("../../extension/live/player-interpret.js", () => ({
      ...actualInterpret,
      syncPlayerInterpretQuickAction: mockSyncInterpretQuickAction,
      togglePlayerInterpretMenu: (anchor: HTMLElement) =>
        actualInterpret.toggleInterpretSubtitleMenu(anchor, {
          getSessionState: () => "idle",
          getPreferences: async () => ({ targetLang: "zh", displayMode: "auto" }),
          applyChoice: (choice) => mockApplyInterpretChoice(choice)
        })
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
    document.body.removeAttribute("data-biliscript-live-active");
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.doUnmock("../../extension/live/live-companion-session.js");
    vi.doUnmock("../../extension/live/player-interpret.js");
    vi.doUnmock("../../extension/core/runtime.js");
  });

  it("无 CC 字幕时同传按钮显示为字幕并位于音量左侧，伴看独立挂载于清晰度左侧", async () => {
    const controlWrap = document.createElement("div");
    controlWrap.className = "bpx-player-control-wrap";
    const controlBottomRight = document.createElement("div");
    controlBottomRight.className = "bpx-player-control-bottom-right";
    const rateBtn = document.createElement("div");
    rateBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-playbackrate";
    rateBtn.textContent = "倍速";
    const volumeBtn = document.createElement("div");
    volumeBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-volume";
    const qualityBtn = document.createElement("div");
    qualityBtn.className = "bpx-player-ctrl-btn bpx-player-ctrl-quality";
    qualityBtn.textContent = "1080P 高码率";
    controlBottomRight.append(rateBtn, volumeBtn, qualityBtn);
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
    expect(rateBtn.nextElementSibling).toBe(interpretWrap);
    expect(interpretWrap?.nextElementSibling).toBe(volumeBtn);
    expect(liveWrap?.contains(liveButton)).toBe(true);
    expect(liveWrap?.nextElementSibling).toBe(qualityBtn);
    expect(liveButton?.getAttribute("aria-label")).toBe("实时伴看");
    expect(interpretButton?.textContent).toBe("字幕");
    expect(interpretButton?.title).toBe("字幕");
    expect(interpretButton?.getAttribute("aria-label")).toBe("字幕");
    expect(mockSyncInterpretQuickAction).not.toHaveBeenCalled();

    stopPlayerAiQuickAction();
    expect(mockSyncInterpretQuickAction).not.toHaveBeenCalled();
    expect(document.getElementById("biliscript-player-interpret-quick-action")).toBeNull();
    expect(document.getElementById("biliscript-player-interpret-quick-action-wrap")).toBeNull();
    expect(document.getElementById("biliscript-player-live-quick-action")).toBeNull();
    expect(document.getElementById("biliscript-player-live-quick-action-wrap")).toBeNull();
    expect(document.querySelector(".biliscript-player-ai-wrap")).toBeNull();
  });

  it("点击字幕按钮打开仿原生菜单，不启动伴看或创建伴看浮窗", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const interpretButton = document.getElementById("biliscript-player-interpret-quick-action") as HTMLButtonElement;
    interpretButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockLiveSession.startLiveCompanion).not.toHaveBeenCalled();
    expect(mockLiveSession.ensureFullscreenOverlay).not.toHaveBeenCalled();
    expect(mockApplyInterpretChoice).not.toHaveBeenCalled();

    const menu = document.getElementById("biliscript-interpret-menu");
    expect(menu).not.toBeNull();
    expect(menu?.querySelector(".biliscript-interpret-menu-title")?.textContent).toBe("字幕");
    expect(menu?.querySelector('[data-action="off"]')?.classList.contains("is-selected")).toBe(true);
    expect(menu?.querySelectorAll(".biliscript-interpret-menu-langs [data-lang]")).toHaveLength(14);
    expect(menu?.querySelector('[data-lang="ja"] .biliscript-interpret-menu-item-label')?.textContent).toBe("日本語");
    expect(menu?.querySelector(".biliscript-interpret-menu-bilingual-label")?.textContent).toBe("双语字幕");

    (menu?.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(20);
    expect(mockApplyInterpretChoice).toHaveBeenCalledWith({ kind: "translation", targetLang: "en" });
    expect(mockLiveSession.startLiveCompanion).not.toHaveBeenCalled();

    interpretButton.click();
    await vi.advanceTimersByTimeAsync(20);
    expect(document.getElementById("biliscript-interpret-menu")).toBeNull();
  });

  it("非全屏下点击伴看按钮：直接启动独立伴看会话，不打开文摘面板，也不初始化 AI 对话 tab", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

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
    playerContainer.setAttribute("data-screen", "web");

    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    expect(liveButton).not.toBeNull();

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockLiveSession.startLiveCompanion).toHaveBeenCalledTimes(1);
    expect(document.getElementById("biliscript-reading-view")).toBeNull();
    expect(document.getElementById("biliscript-chat-messages")).toBeNull();
  });

  it("伴看开启与关闭时实时伴看快捷按钮同步高亮态（is-active）与无障碍属性", async () => {
    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    const { syncPlayerLiveQuickActionState } = await import("../../extension/live/player-live-toggle.js");

    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;
    const liveWrap = document.getElementById("biliscript-player-live-quick-action-wrap") as HTMLElement;

    expect(liveButton.classList.contains("is-active")).toBe(false);
    expect(liveWrap.classList.contains("is-active")).toBe(false);
    expect(liveButton.getAttribute("aria-pressed")).toBe("false");
    expect(liveButton.getAttribute("aria-label")).toBe("实时伴看");

    syncPlayerLiveQuickActionState(true);
    expect(liveButton.classList.contains("is-active")).toBe(true);
    expect(liveWrap.classList.contains("is-active")).toBe(true);
    expect(liveButton.getAttribute("aria-pressed")).toBe("true");
    expect(liveButton.getAttribute("aria-label")).toBe("实时伴看 (已开启)");

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

    syncPlayerLiveQuickActionState(true);
    expect(liveButton.classList.contains("is-active")).toBe(true);

    liveButton.click();
    await vi.advanceTimersByTimeAsync(20);

    expect(mockLiveSession.stopLiveCompanion).toHaveBeenCalledTimes(1);
    expect(mockLiveSession.startLiveCompanion).not.toHaveBeenCalled();
  });

  it("AI 按钮提交期间不阻塞伴看按钮；伴看按钮 250ms 节流且连接中保持可点以支持取消", async () => {
    const sendMessage = vi.mocked(chrome.runtime.sendMessage);
    let resolveAiAction!: (res: unknown) => void;
    sendMessage.mockImplementation((message: any, callback?: (res: unknown) => void) => {
      if (message?.type === "player-ai-quick-action") {
        resolveAiAction = (res) => callback?.(res);
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    });

    let liveState: "idle" | "connecting" | "connected" = "idle";
    mockLiveSession.getLiveController.mockImplementation(() => ({ getState: () => liveState }));
    mockLiveSession.isLiveCompanionActive.mockImplementation(() => liveState === "connecting" || liveState === "connected");
    let resolveStart!: (ok: boolean) => void;
    mockLiveSession.startLiveCompanion.mockImplementation(() => {
      liveState = "connecting";
      return new Promise<boolean>((resolve) => {
        resolveStart = resolve;
      });
    });

    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    const aiButton = document.getElementById("biliscript-player-ai-quick-action") as HTMLButtonElement;
    const liveButton = document.getElementById("biliscript-player-live-quick-action") as HTMLButtonElement;

    aiButton.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(aiButton.disabled).toBe(true);
    expect(liveButton.disabled).toBe(false);

    liveButton.click();
    liveButton.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockLiveSession.startLiveCompanion).toHaveBeenCalledTimes(1);
    expect(liveButton.disabled).toBe(false);

    await vi.advanceTimersByTimeAsync(260);
    liveButton.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockLiveSession.stopLiveCompanion).toHaveBeenCalledTimes(1);

    resolveStart(false);
    resolveAiAction({ ok: true });
    await vi.advanceTimersByTimeAsync(20);
  });

  it("网页全屏点击 AI 快捷按钮时先退出网页全屏再发送定位命令", async () => {
    playerContainer.setAttribute("data-screen", "web");
    const webBtn = document.createElement("button");
    webBtn.className = "bpx-player-ctrl-web";
    const order: string[] = [];
    webBtn.addEventListener("click", () => {
      order.push("web-exit");
      playerContainer.setAttribute("data-screen", "normal");
    });
    playerContainer.appendChild(webBtn);

    const sendMessage = vi.mocked(chrome.runtime.sendMessage);
    sendMessage.mockImplementation((message: any, callback?: (res: unknown) => void) => {
      if (message?.type === "player-ai-quick-action") {
        order.push("quick-action");
      }
      callback?.({ ok: true });
      return undefined;
    });

    const { schedulePlayerAiQuickActionSync } = await import("../../extension/ai/player-ai.js");
    schedulePlayerAiQuickActionSync(0);
    await vi.advanceTimersByTimeAsync(20);

    (document.getElementById("biliscript-player-ai-quick-action") as HTMLButtonElement).click();
    await vi.advanceTimersByTimeAsync(20);

    expect(order).toEqual(["web-exit", "quick-action"]);
  });
});

describe("live/live-companion-session: 独立伴看会话所有权、对话按需消费与页面关闭清理", () => {
  let capturedControllerDeps: any = null;

  beforeEach(() => {
    resetModuleState();
    capturedControllerDeps = null;
    document.body.innerHTML = "";
    const playerContainer = document.createElement("div");
    playerContainer.className = "bpx-player-container";
    document.body.appendChild(playerContainer);
    vi.doMock("../../extension/live/live-chat-controller.js", async () => {
      const actual = await vi.importActual<typeof import("../../extension/live/live-chat-controller.js")>(
        "../../extension/live/live-chat-controller.js"
      );
      return {
        ...actual,
        createLiveChatController: vi.fn((deps) => {
          capturedControllerDeps = deps;
          return actual.createLiveChatController(deps);
        })
      };
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.doUnmock("../../extension/live/live-chat-controller.js");
    vi.restoreAllMocks();
  });

  it("独立伴看会话持有控制器与浮窗；关闭 AI 对话会话不销毁伴看，关闭页面（pagehide）彻底清理连接、浮窗与工具任务", async () => {
    const session = await import("../../extension/live/live-companion-session.js");
    const controller = session.ensureLiveController();
    expect(controller).not.toBeNull();

    const startSpy = vi.spyOn(controller, "start").mockImplementation(async () => {
      vi.spyOn(controller, "getState").mockReturnValue("connected");
      capturedControllerDeps?.onStateChange?.("connected");
      return true;
    });
    const stopSpy = vi.spyOn(controller, "stop");
    const disposeSpy = vi.spyOn(controller, "dispose");

    expect(await session.startLiveCompanion()).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);
    const overlay = session.getFullscreenLiveOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay?.isVisible()).toBe(true);
    expect(overlay?.isMinimized()).toBe(false);
    expect(document.getElementById("biliscript-reading-view")).toBeNull();
    expect(document.getElementById("biliscript-chat-messages")).toBeNull();

    const uiRenderer = await import("../../extension/ui/ui-renderer.js");
    uiRenderer.ensureUiReady({ forceRecreate: true });
    const chat = await import("../../extension/reader/chat-tab.js");
    await chat.ensureChatTabActivated();

    expect(chat.getLiveController()).toBe(controller);
    expect(chat.getFullscreenLiveOverlay()).toBe(overlay);

    chat.closeChatSession();
    expect(stopSpy).not.toHaveBeenCalled();
    expect(overlay?.isVisible()).toBe(true);

    stopSpy.mockImplementation(async () => {
      capturedControllerDeps?.onStateChange?.("idle");
    });
    const { requestLiveCompanionStop } = await import("../../extension/reader/reader-bus.js");
    requestLiveCompanionStop("takeover");
    expect(stopSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      const notice = document.querySelector(".bpx-player-container .biliscript-interpret-notice");
      expect(notice?.textContent).toBe("伴看已切换到另一个标签页");
    });
    expect(overlay?.isVisible()).toBe(false);

    document.querySelector(".biliscript-interpret-notice")?.remove();
    session.stopLiveCompanion();
    await vi.waitFor(() => expect(stopSpy).toHaveBeenCalledTimes(2));
    await Promise.resolve();
    expect(document.querySelector(".biliscript-interpret-notice")).toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(document.getElementById("biliscript-fullscreen-live-overlay")).toBeNull();
    expect(document.querySelector(".biliscript-fullscreen-live-mini-capsule")).toBeNull();
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(false);
  });

  it("控制栏同传按钮跟随真实 CC 字幕状态，且不创建伴看浮窗", async () => {
    const session = await import("../../extension/live/live-companion-session.js");
    const interpret = await import("../../extension/live/player-interpret.js");
    const { state } = await import("../../extension/core/state.js");
    const { notifyReaderPresenter } = await import("../../extension/reader/reader-bus.js");
    const wrap = document.createElement("div");
    wrap.id = "biliscript-player-interpret-quick-action-wrap";
    const button = document.createElement("button");
    button.id = "biliscript-player-interpret-quick-action";
    wrap.appendChild(button);
    document.body.appendChild(wrap);

    state.clip.setSubtitleFetchState("loading");
    interpret.syncPlayerInterpretQuickAction();
    expect(button.hidden).toBe(true);

    state.clip.setSubtitleFetchState("empty");
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(wrap.hidden).toBe(false);

    state.clip.setSubtitles([{ id: "cc-1", lan: "zh-CN", subtitleUrl: "https://example.com/cc.json" }]);
    state.clip.setSubtitleFetchState("ready");
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(wrap.hidden).toBe(false);
    expect(button.textContent).toBe("双语");

    state.clip.setSubtitles([{ id: "asr-1", lan: "asr-zh", subtitleUrl: "" }]);
    notifyReaderPresenter({ kind: "subtitle-ready" });
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("字幕");
    expect(session.getFullscreenLiveOverlay()).toBeNull();
    window.dispatchEvent(new Event("pagehide"));
  });
});
