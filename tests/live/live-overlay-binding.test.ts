import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createLiveOverlayBinding,
  syncPlayerInterpretQuickActionState
} from "../../extension/live/live-overlay-binding.js";
import { state } from "../../extension/core/state.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("live/live-overlay-binding 共用浮窗挂载与控制器绑定", () => {
  it("控制栏同传按钮同步显隐、连接状态与配置不可用原因", () => {
    const wrap = document.createElement("div");
    wrap.id = "biliscript-player-interpret-quick-action-wrap";
    const button = document.createElement("button");
    button.id = "biliscript-player-interpret-quick-action";
    wrap.appendChild(button);
    document.body.appendChild(wrap);
    let interpretState = "idle";
    let availability = { ok: false, error: "未配置 MOSS-LIVE 密钥" };
    const controller = {
      getState: () => interpretState,
      getAvailability: () => availability
    } as any;

    syncPlayerInterpretQuickActionState(controller, false);
    expect(wrap.hidden).toBe(true);
    expect(button.hidden).toBe(true);

    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("aria-description")).toBe(availability.error);
    expect(button.title).toBe(availability.error);
    expect(button.getAttribute("aria-label")).toBe("字幕");

    availability = { ok: true } as any;
    interpretState = "idle";
    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.title).toBe("字幕");
    expect(button.getAttribute("aria-label")).toBe("字幕");

    interpretState = "connecting";
    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.getAttribute("aria-disabled")).toBe("false");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.classList.contains("is-connecting")).toBe(true);

    interpretState = "connected";
    syncPlayerInterpretQuickActionState(controller, true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("关闭实时翻译");
    expect(button.classList.contains("is-active")).toBe(true);
  });

  it("懒创建浮窗并同步状态、VAD、转写与停止伴看", () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);

    const stopFn = vi.fn(async () => {});
    const mockController: any = {
      getState: () => "connected",
      isMuted: () => false,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      isVoiceRecentlyActive: () => true,
      getSpeed: () => 1,
      stop: stopFn
    };

    const binding = createLiveOverlayBinding({
      getLiveController: () => mockController
    });

    expect(binding.getOverlay()).toBeNull();

    // 状态切到 connected 自动挂载并展示浮窗并标记伴看激活
    binding.handleStateChange("connected");
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(true);
    const overlay = binding.getOverlay();
    expect(overlay).not.toBeNull();
    expect(overlay?.isVisible()).toBe(true);
    expect(host.contains(overlay?.getElement() ?? null)).toBe(true);

    // VAD 与转写联动
    binding.handleVadChange(true);
    expect(
      overlay?.getElement()?.querySelector(".live-overlay-status-capsule")?.classList.contains("is-talking")
    ).toBe(true);

    binding.handleTranscript({ kind: "input.done", text: "你好" });
    expect(
      overlay?.getElement()?.querySelector(".live-overlay-bubble-user")?.textContent
    ).toBe("你好");

    // 切回 idle 自动隐藏并移除激活标记
    binding.handleStateChange("idle");
    expect(overlay?.isVisible()).toBe(false);
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(false);
  });

  it("后台状态同步保留迷你态，失败仅自动展开一次并在恢复后回到迷你", () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    let currentState: "idle" | "connecting" | "connected" | "failure" = "idle";
    const controller = {
      getState: () => currentState,
      isMuted: () => false,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      getSpeed: () => 1
    };
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => controller as any
    });

    currentState = "connected";
    binding.handleStateChange("connected");
    const overlay = binding.getOverlay()!;
    expect(overlay.isMinimized()).toBe(false);
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    binding.handleStateChange("connected");
    expect(overlay.isMinimized()).toBe(true);

    currentState = "failure";
    binding.handleStateChange("failure", "网络超时", "network");
    expect(overlay.isMinimized()).toBe(false);
    binding.handleStateChange("failure", "网络超时", "network");
    expect(overlay.isMinimized()).toBe(false);

    currentState = "connecting";
    binding.handleStateChange("connecting");
    expect(overlay.isMinimized()).toBe(true);
    currentState = "failure";
    binding.handleStateChange("failure", "再次失败", "network");
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    binding.handleStateChange("failure", "再次失败", "network");
    expect(overlay.isMinimized()).toBe(true);
    binding.dispose();
  });

  it("shouldAutoShow 为 false 时不自动弹出浮窗，且音频开关变更自动持久化到 state.settings", () => {
    const binding = createLiveOverlayBinding({
      getLiveController: () => null,
      shouldAutoShow: () => false
    });

    binding.handleStateChange("connected");
    expect(binding.getOverlay()).toBeNull();

    binding.handleShareVideoAudioChange(true);
    expect(state.settings?.liveShareVideoAudio).toBe(true);

    binding.handleVoicePriorityChange(false);
    expect(state.settings?.liveVoicePriority).toBe(false);
  });

  it("bindControllerCallbacks 统一接线控制器事件，且 startOrRestoreCompanion 在已连接下直接 restore 浮窗", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    host.setAttribute("data-screen", "web");
    document.body.appendChild(host);

    let currentState: "idle" | "connected" = "idle";
    const startFn = vi.fn(async () => {
      currentState = "connected";
      return true;
    });
    const mockController: any = {
      getState: () => currentState,
      isMuted: () => false,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      isVoiceRecentlyActive: () => true,
      getSpeed: () => 1,
      start: startFn,
      stop: vi.fn(async () => {})
    };

    const onStateHook = vi.fn();
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => mockController
    });

    const callbacks = binding.bindControllerCallbacks({
      onStateChange: onStateHook
    });
    callbacks.onStateChange?.("connected");
    expect(onStateHook).toHaveBeenCalledWith("connected");

    // 首次启动：调用 controller.start 并展开连接卡
    currentState = "idle";
    expect(await binding.startOrRestoreCompanion()).toBe(true);
    expect(startFn).toHaveBeenCalledTimes(1);
    const overlay = binding.getOverlay()!;
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(false);

    // 已在伴看中再次触发：不重复调 start，直接 restore 浮窗
    const restoreSpy = vi.spyOn(overlay, "restore");
    expect(await binding.startOrRestoreCompanion()).toBe(true);
    expect(startFn).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledTimes(1);

    binding.dispose();
  });

  it("首次连接展开连接卡；连接中、已连接和通用失败均可见，失败提供取消与重试", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);

    let currentState: "idle" | "connecting" | "connected" | "failure" = "idle";
    const startFn = vi.fn(async () => {
      currentState = "connecting";
      callbacks.onStateChange?.("connecting");
      return true;
    });
    const stopFn = vi.fn(async () => {
      currentState = "idle";
      callbacks.onStateChange?.("idle");
    });

    const mockController: any = {
      getState: () => currentState,
      isMuted: () => false,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      isVoiceRecentlyActive: () => true,
      getSpeed: () => 1,
      start: startFn,
      stop: stopFn
    };

    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => mockController
    });
    const callbacks = binding.bindControllerCallbacks();

    // 1. 首次进入 connecting：显示展开的连接卡
    callbacks.onStateChange?.("connecting");
    const overlay = binding.getOverlay()!;
    expect(overlay).not.toBeNull();
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(false);
    expect(overlay.getElement()?.querySelector(".live-overlay-status-text")?.textContent).toBe("连接中...");

    // 2. 进入 failure：保持可见并展开，显示错误原因及取消/重试按钮
    currentState = "failure";
    callbacks.onStateChange?.("failure", "网络握手超时");
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(false);
    expect(document.body.hasAttribute("data-biliscript-live-active")).toBe(false);

    const failureCard = overlay.getElement()?.querySelector(".live-overlay-failure-card") as HTMLElement | null;
    expect(failureCard).not.toBeNull();
    expect(failureCard?.hidden).toBe(false);
    expect(failureCard?.textContent).toContain("实时伴看启动失败，请重试");

    const retryBtn = failureCard?.querySelector(".live-overlay-retry-btn") as HTMLButtonElement | null;
    const cancelBtn = failureCard?.querySelector(".live-overlay-cancel-btn") as HTMLButtonElement | null;
    expect(retryBtn).not.toBeNull();
    expect(cancelBtn).not.toBeNull();

    // 3. 点击重试：先完整停止，再调用 controller.start() 重新进入 connecting
    retryBtn!.click();
    await vi.waitFor(() => expect(startFn).toHaveBeenCalledTimes(1));
    expect(overlay.isVisible()).toBe(true);
    expect(failureCard?.hidden).toBe(true);

    // 4. 再次失败后点击取消：调用 controller.stop() 回到 idle 并隐藏浮窗
    currentState = "failure";
    callbacks.onStateChange?.("failure", "连接被拒绝");
    expect(failureCard?.hidden).toBe(false);
    cancelBtn!.click();
    expect(stopFn).toHaveBeenCalledTimes(2);
    expect(overlay.isVisible()).toBe(false);
  });

  it("重试先完整停止并清理旧会话，再重新建立连接", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const calls: string[] = [];
    let currentState = "failure";
    const controller = {
      getState: () => currentState,
      isMuted: () => false,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      getSpeed: () => 1,
      stop: vi.fn(async () => {
        calls.push("stop");
        currentState = "idle";
      }),
      start: vi.fn(async () => {
        calls.push("start");
        currentState = "connecting";
        return true;
      })
    };
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => controller as any
    });
    binding.handleStateChange("failure", "网络超时", "network");

    binding.getOverlay()?.getElement()?.querySelector<HTMLButtonElement>(".live-overlay-retry-btn")?.click();

    await vi.waitFor(() => expect(calls).toEqual(["stop", "start"]));
    binding.dispose();
  });

  it("真实重试链在 stop idle 与 start connecting 后保留失败前迷你偏好", async () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const calls: string[] = [];
    let currentState: "idle" | "connecting" | "connected" | "failure" = "connected";
    const controller = {
      getState: () => currentState,
      isMuted: () => false,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      getSpeed: () => 1,
      stop: vi.fn(async () => {
        calls.push("stop");
        currentState = "idle";
        callbacks.onStateChange?.("idle");
      }),
      start: vi.fn(async () => {
        calls.push("start");
        currentState = "connecting";
        callbacks.onStateChange?.("connecting");
        return true;
      })
    };
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => controller as any
    });
    const callbacks = binding.bindControllerCallbacks();
    callbacks.onStateChange?.("connected");
    const overlay = binding.getOverlay()!;
    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-min-btn")!.click();
    currentState = "failure";
    callbacks.onStateChange?.("failure", "网络超时", "network");
    expect(overlay.isMinimized()).toBe(false);

    overlay.getElement()!.querySelector<HTMLButtonElement>(".live-overlay-retry-btn")!.click();

    await vi.waitFor(() => expect(calls).toEqual(["stop", "start"]));
    expect(overlay.isVisible()).toBe(true);
    expect(overlay.isMinimized()).toBe(true);
    expect(overlay.getMiniCapsuleElement()?.hidden).toBe(false);
    expect(overlay.getElement()?.hidden).toBe(true);

    currentState = "connected";
    callbacks.onStateChange?.("connected");
    expect(overlay.isMinimized()).toBe(true);
    binding.dispose();
  });

  it("propagates a typed failure into the persistent player failure card", () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => ({
        getState: () => "failure",
        isMuted: () => false,
        isSharingVideoAudio: () => false,
        isVoicePriority: () => true,
        getSpeed: () => 1
      }) as any
    });

    binding.handleStateChange("failure", "请配置 Gemini Key", "gemini-credential");

    const card = binding.getOverlay()?.getElement()?.querySelector<HTMLElement>(".live-overlay-failure-card");
    expect(card?.getAttribute("data-failure-kind")).toBe("gemini-credential");
    expect(card?.hidden).toBe(false);
    binding.dispose();
  });

  it("浮窗 change 只持久化一次，控制器音量回包只同步不重复保存", () => {
    const sendMessage = vi.spyOn(chrome.runtime, "sendMessage");
    const onVolumeSync = vi.fn();
    const syncState = vi.fn();
    let overlayDeps: any;
    const binding = createLiveOverlayBinding({
      getLiveController: () => null,
      onVolumeSync,
      createOverlay: ((deps: any) => {
        overlayDeps = deps;
        return { syncState };
      }) as any
    });
    binding.ensureOverlay();

    overlayDeps.onVolumeChange(65);
    expect(state.settings?.liveVoiceVolume).toBe(65);
    expect(onVolumeSync).toHaveBeenCalledWith(65);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      {
        type: "save-settings",
        settings: { liveVoiceVolume: 65 }
      },
      expect.any(Function)
    );

    sendMessage.mockClear();
    binding.bindControllerCallbacks().onVolumeChange?.(80);
    expect(onVolumeSync).toHaveBeenCalledWith(80);
    expect(syncState).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("把浮窗设置目标转发给视频页设置入口", () => {
    const onOpenLiveSettings = vi.fn();
    let overlayDeps: any;
    const binding = createLiveOverlayBinding({
      getLiveController: () => null,
      onOpenLiveSettings,
      createOverlay: ((deps: any) => {
        overlayDeps = deps;
        return {};
      }) as any
    });

    binding.ensureOverlay();
    overlayDeps.onOpenLiveSettings("gemini-key");

    expect(onOpenLiveSettings).toHaveBeenCalledWith("gemini-key");
  });

  it("伴看停止只关闭伴看浮窗，不承担同传生命周期", () => {
    const host = document.createElement("div");
    host.className = "bpx-player-container";
    document.body.appendChild(host);
    const binding = createLiveOverlayBinding({
      getPlayerHost: () => host,
      getLiveController: () => null
    });

    binding.handleStateChange("connected");
    binding.handleStateChange("idle");

    expect(binding.getOverlay()?.isVisible()).toBe(false);
    expect(binding.getOverlay()?.getElement()?.querySelector(".live-overlay-interpret-btn")).toBeNull();
    binding.dispose();
  });
});
