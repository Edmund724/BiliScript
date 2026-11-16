import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createLiveOverlayBinding,
  createThrottledLiveToggleHandler,
  mountControlBarLiveToggle,
  syncPlayerLiveQuickActionState,
  syncPlayerLiveToggleButton
} from "../../extension/live/live-overlay-binding.js";
import type { LiveChatControllerDeps, LiveChatState } from "../../extension/live/live-chat-controller.js";
import { state } from "../../extension/core/state.js";

function createFakeControllerHarness(initialState: LiveChatState = "idle") {
  let currentState: LiveChatState = initialState;
  let capturedDeps: LiveChatControllerDeps | null = null;
  let muted = false;
  let shareVideoAudio = false;
  let voicePriority = true;
  let speed = 1;
  let volume = 1;
  const calls: string[] = [];

  const refreshTarget = vi.fn(async () => {
    calls.push("refreshTarget");
  });
  const start = vi.fn(async () => {
    calls.push("start");
    currentState = "connecting";
    capturedDeps?.onStateChange?.("connecting");
    return true;
  });
  const stop = vi.fn(async () => {
    calls.push("stop");
    currentState = "idle";
    capturedDeps?.onStateChange?.("idle");
  });
  const toggle = vi.fn(async () => {
    const active = currentState === "connecting" || currentState === "connected";
    await (active ? stop() : start());
  });
  const dispose = vi.fn(() => {
    calls.push("dispose");
  });

  const controller = {
    getState: () => currentState,
    isMuted: () => muted,
    isSharingVideoAudio: () => shareVideoAudio,
    isVoicePriority: () => voicePriority,
    isVoiceRecentlyActive: () => true,
    getSpeed: () => speed,
    getVolume: () => volume,
    setMuted: vi.fn((next: boolean) => {
      muted = next;
    }),
    setVolume: vi.fn((next: number) => {
      volume = next;
    }),
    setSpeed: vi.fn((next: number) => {
      speed = next;
    }),
    setVoicePriority: vi.fn((next: boolean) => {
      voicePriority = next;
    }),
    setShareVideoAudio: vi.fn((next: boolean) => {
      shareVideoAudio = next;
    }),
    refreshTarget,
    start,
    stop,
    toggle,
    dispose
  } as any;

  const createController = vi.fn((deps: LiveChatControllerDeps) => {
    capturedDeps = deps;
    return controller;
  });

  return {
    controller,
    createController,
    getDeps: () => capturedDeps!,
    setState: (next: LiveChatState) => {
      currentState = next;
    },
    emitState: (next: LiveChatState, error?: string, failureKind?: any) => {
      currentState = next;
      capturedDeps?.onStateChange?.(next, error, failureKind);
    },
    calls
  };
}

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("live/live-overlay-binding 共用浮窗挂载、控制器生命周期与音频设置绑定", () => {
  it("懒创建控制器并规范化 4 项初始音频设置，状态/VAD/转写/结束联动浮窗", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    state.setSettings({
      liveVoiceVolume: 80,
      liveVoiceSpeed: 1.25,
      liveVoicePriority: false,
      liveShareVideoAudio: true
    } as any);

    const harness = createFakeControllerHarness();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController,
      createControllerDeps: () => ({ showNotice: vi.fn() })
    });

    expect(binding.getController()).toBeNull();
    expect(binding.getOverlay()).toBeNull();

    await binding.ensureTargetReady();
    expect(harness.createController).toHaveBeenCalledWith(
      expect.objectContaining({
        initialVolume: 0.8,
        initialSpeed: 1.25,
        initialVoicePriority: false,
        initialShareVideoAudio: true
      })
    );
    expect(harness.controller.refreshTarget).toHaveBeenCalledTimes(1);

    harness.emitState("connected");
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(true);
    const overlay = binding.getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay?.isVisible()).toBe(true);
    expect(host.contains(overlay?.getElement() ?? null)).toBe(true);

    harness.getDeps().onVadStateChange?.(true);
    expect(
      overlay?.getElement()?.querySelector(".live-overlay-status-capsule")?.classList.contains("is-talking")
    ).toBe(true);

    harness.getDeps().onTranscript?.({ kind: "input.done", text: "你好" });
    expect(
      overlay?.getElement()?.querySelector(".live-overlay-bubble-user")?.textContent
    ).toBe("你好");

    await binding.stop();
    expect(overlay?.isVisible()).toBe(false);
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(false);
    binding.dispose();
  });

  it("后台状态同步保留迷你态，失败仅自动展开一次并在恢复后回到迷你", () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const harness = createFakeControllerHarness();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController
    });
    binding.ensureController();

    harness.emitState("connected");
    const overlay = binding.getOverlay()!;
    expect(overlay.isMinimized()).toBe(false);
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    harness.emitState("connected");
    expect(overlay.isMinimized()).toBe(true);

    harness.emitState("failure", "网络超时", "network");
    expect(overlay.isMinimized()).toBe(false);
    harness.emitState("failure", "网络超时", "network");
    expect(overlay.isMinimized()).toBe(false);

    harness.emitState("connecting");
    expect(overlay.isMinimized()).toBe(true);
    harness.emitState("failure", "再次失败", "network");
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    harness.emitState("failure", "再次失败", "network");
    expect(overlay.isMinimized()).toBe(true);
    binding.dispose();
  });

  it("音频开关与音量变更持久化，监听 liveProviders 存储变更并刷新目标平台", async () => {
    const storageListeners: Array<(changes: Record<string, any>, area: string) => void> = [];
    const addListener = vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((fn: any) => {
      storageListeners.push(fn);
    });
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);

    const sendMessage = vi.spyOn(chrome.runtime, "sendMessage");
    const harness = createFakeControllerHarness();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController
    });
    binding.ensureController();
    binding.ensureOverlay();

    harness.getDeps().onShareVideoAudioChange?.(true);
    expect(state.settings?.liveShareVideoAudio).toBe(true);
    harness.getDeps().onVoicePriorityChange?.(false);
    expect(state.settings?.liveVoicePriority).toBe(false);

    sendMessage.mockClear();
    expect(binding.ensureOverlay().getElement()).toBeNull();
    harness.emitState("connected");
    const syncSpy = vi.spyOn(binding.getOverlay()!, "syncState");
    harness.getDeps().onVolumeChange?.(80);
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();

    harness.controller.refreshTarget.mockClear();
    storageListeners.forEach((listener) => {
      listener({ liveProviders: { newValue: [] } }, "sync");
    });
    await Promise.resolve();
    expect(harness.controller.refreshTarget).toHaveBeenCalledTimes(1);

    binding.dispose();
    addListener.mockRestore();
  });

  it("start() 与 consumerHooks 统一接线，且已在伴看中再次 start() 直接 restore 浮窗", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    host.setAttribute("data-screen", "web");
    document.body.appendChild(host);

    const harness = createFakeControllerHarness();
    const onBeforeStart = vi.fn();
    const onStateChange = vi.fn();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController
    });
    binding.setConsumerHooks({ onBeforeStart, onStateChange });

    expect(await binding.start()).toBe(true);
    expect(onBeforeStart).toHaveBeenCalledTimes(1);
    expect(harness.controller.start).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith("connecting");

    const overlay = binding.getOverlay()!;
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(false);

    const restoreSpy = vi.spyOn(overlay, "restore");
    expect(await binding.start()).toBe(true);
    expect(harness.controller.start).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    binding.dispose();
  });

  it("首次连接展开连接卡；连接中、已连接和通用失败均可见，失败提供取消与重试", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);

    const harness = createFakeControllerHarness();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController
    });
    binding.ensureController();

    harness.emitState("connecting");
    const overlay = binding.getOverlay()!;
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(false);
    expect(overlay.getElement()?.querySelector(".live-overlay-status-text")?.textContent).toBe("连接中...");

    harness.emitState("failure", "网络握手超时");
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(false);
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(false);

    const failureCard = overlay.getElement()?.querySelector(".live-overlay-failure-card") as HTMLElement | null;
    expect(failureCard?.hidden).toBe(false);
    expect(failureCard?.textContent).toContain("实时伴看启动失败，请重试");

    const retryBtn = failureCard?.querySelector(".live-overlay-retry-btn") as HTMLButtonElement | null;
    const cancelBtn = failureCard?.querySelector(".live-overlay-cancel-btn") as HTMLButtonElement | null;

    retryBtn!.click();
    await vi.waitFor(() => expect(harness.controller.start).toHaveBeenCalledTimes(1));
    expect(overlay.isVisible()).toBe(true);
    expect(failureCard?.hidden).toBe(true);

    harness.emitState("failure", "连接被拒绝");
    expect(failureCard?.hidden).toBe(false);
    cancelBtn!.click();
    expect(harness.controller.stop).toHaveBeenCalledTimes(2);
    expect(overlay.isVisible()).toBe(false);
    binding.dispose();
  });

  it("真实重试链在 stop idle 与 start connecting 后保留失败前迷你偏好，单飞锁拦截并发重试", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);

    const harness = createFakeControllerHarness();
    let resolveStop!: () => void;
    harness.controller.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStop = () => {
            harness.calls.push("stop");
            harness.emitState("idle");
            resolve();
          };
        })
    );

    const hookStates: string[] = [];
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController,
      consumerHooks: {
        onStateChange: (s) => hookStates.push(s)
      }
    });
    binding.ensureController();

    harness.emitState("connected");
    const overlay = binding.getOverlay()!;
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    harness.emitState("failure", "网络超时", "network");
    expect(overlay.isMinimized()).toBe(false);
    hookStates.length = 0;

    const first = binding.retry();
    const second = binding.retry();
    await expect(second).resolves.toBe(false);
    expect(harness.controller.stop).toHaveBeenCalledTimes(1);

    resolveStop();
    await expect(first).resolves.toBe(true);
    expect(hookStates).toEqual(["connecting"]);
    expect(hookStates).not.toContain("idle");
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.getMiniCapsuleElement()?.hidden).toBe(false);
    expect(overlay.getElement()?.hidden).toBe(true);

    harness.emitState("connected");
    expect(overlay.isMinimized()).toBe(true);
    binding.dispose();
  });

  it("类型化失败传递至播放器持久失败卡并把设置目标转发给设置入口", () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const onOpenLiveSettings = vi.fn();
    const harness = createFakeControllerHarness();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController,
      onOpenLiveSettings
    });
    binding.ensureController();

    harness.emitState("failure", "请配置 Gemini Key", "gemini-credential");

    const card = binding.getOverlay()?.getElement()?.querySelector<HTMLElement>(".live-overlay-failure-card");
    expect(card?.getAttribute("data-failure-kind")).toBe("gemini-credential");
    expect(card?.hidden).toBe(false);
    card?.querySelector<HTMLButtonElement>(".live-overlay-settings-btn")?.click();
    expect(onOpenLiveSettings).toHaveBeenCalledWith("gemini-key");
    binding.dispose();
  });

  it("stop(takeover) 触发接管回调，reconnect 遵守继续条件守卫", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const onStopTakeover = vi.fn();
    const harness = createFakeControllerHarness("connected");
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController,
      onStopTakeover
    });
    binding.ensureController();

    await binding.stop("takeover");
    expect(onStopTakeover).toHaveBeenCalledTimes(1);

    expect(await binding.reconnect(() => false)).toBe(false);
    expect(await binding.reconnect(() => true)).toBe(true);
    expect(harness.calls).toEqual(["refreshTarget", "stop", "refreshTarget", "stop", "start"]);
    binding.dispose();
  });

  it("伴看停止只关闭伴看浮窗，不承担同传生命周期；共享按钮原语同步状态与 250ms 节流", async () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const harness = createFakeControllerHarness();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      createController: harness.createController
    });
    binding.ensureController();

    harness.emitState("connected");
    harness.emitState("idle");

    expect(binding.getOverlay()?.isVisible()).toBe(false);
    expect(binding.getOverlay()?.getElement()?.querySelector(".live-overlay-interpret-btn")).toBeNull();
    binding.dispose();

    const wrap = document.createElement("div");
    wrap.id = "biliscript-player-live-quick-action-wrap";
    const btn = document.createElement("button");
    btn.id = "biliscript-player-live-quick-action";
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
    syncPlayerLiveQuickActionState(true);
    expect(btn.classList.contains("is-active")).toBe(true);
    syncPlayerLiveToggleButton({ button: btn, wrap, active: false });
    expect(btn.getAttribute("aria-pressed")).toBe("false");

    const toggleSpy = vi.fn();
    const handler = createThrottledLiveToggleHandler(toggleSpy);
    await handler.handleClick();
    await handler.handleClick();
    expect(toggleSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(260);
    await handler.handleClick();
    expect(toggleSpy).toHaveBeenCalledTimes(2);
    mountControlBarLiveToggle(wrap, host, { fallbackToHost: true });
    expect(host.contains(wrap)).toBe(true);
    vi.useRealTimers();
  });
});
