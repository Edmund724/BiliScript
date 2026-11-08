import { describe, expect, it, vi, beforeEach } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveOverlayBinding } from "../../extension/live/live-overlay-binding.js";
import { state } from "../../extension/core/state.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

describe("live/live-overlay-binding 共用浮窗挂载与控制器绑定", () => {
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

    // 首次启动：调用 controller.start 并展示浮窗
    currentState = "idle";
    expect(await binding.startOrRestoreCompanion()).toBe(true);
    expect(startFn).toHaveBeenCalledTimes(1);
    const overlay = binding.getOverlay()!;
    expect(overlay.isVisible()).toBe(true);

    // 已在伴看中再次触发：不重复调 start，直接 restore 浮窗
    const restoreSpy = vi.spyOn(overlay, "restore");
    expect(await binding.startOrRestoreCompanion()).toBe(true);
    expect(startFn).toHaveBeenCalledTimes(1);
    expect(restoreSpy).toHaveBeenCalledTimes(1);

    binding.dispose();
  });
});
