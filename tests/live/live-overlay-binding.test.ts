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

    // 状态切到 connected 自动挂载并展示浮窗
    binding.handleStateChange("connected");
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

    // 切回 idle 自动隐藏
    binding.handleStateChange("idle");
    expect(overlay?.isVisible()).toBe(false);
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
});
