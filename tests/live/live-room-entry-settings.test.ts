import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { LiveRoomSettingsDeps } from "../../extension/live/live-room-settings.js";
import type { FullscreenLiveOverlayDeps } from "../../extension/live/fullscreen-live-overlay.js";

let overlayDeps: FullscreenLiveOverlayDeps;
let settingsDeps: LiveRoomSettingsDeps;
let controller: {
  refreshTarget: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  getState: ReturnType<typeof vi.fn>;
  toggle: ReturnType<typeof vi.fn>;
};
let closeSettings: ReturnType<typeof vi.fn>;
let openSettings: ReturnType<typeof vi.fn>;
let roomId = "111";

function mountPlayer(): HTMLElement {
  const host = document.createElement("div");
  host.id = "live-player";
  const controllerBar = document.createElement("div");
  controllerBar.className = "live-web-player-controller";
  const rightArea = document.createElement("div");
  rightArea.className = "right-area";
  const controls = document.createElement("div");
  controls.className = "ext-nodes";
  rightArea.appendChild(controls);
  controllerBar.appendChild(rightArea);
  host.appendChild(controllerBar);
  document.body.appendChild(host);
  return host;
}

beforeEach(() => {
  resetModuleState();
  roomId = "111";
  document.body.innerHTML = "";
  controller = {
    refreshTarget: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => true),
    getState: vi.fn(() => "idle"),
    toggle: vi.fn(async () => {})
  };
  closeSettings = vi.fn();
  openSettings = vi.fn(async (_target: string, _getHost: () => HTMLElement | null, deps: LiveRoomSettingsDeps) => {
    settingsDeps = deps;
  });
  vi.doMock("../../extension/bilibili/video-id-shared.js", () => ({
    parseLiveRoomId: () => roomId
  }));
  vi.doMock("../../extension/live/live-chat-controller.js", () => ({
    createLiveChatController: vi.fn(() => controller)
  }));
  vi.doMock("../../extension/live/live-overlay-binding.js", () => ({
    createLiveOverlayBinding: vi.fn((deps: FullscreenLiveOverlayDeps) => {
      overlayDeps = deps;
      return {
        bindControllerCallbacks: (callbacks: unknown) => callbacks,
        clearMessages: vi.fn()
      };
    })
  }));
  vi.doMock("../../extension/live/live-room-settings.js", () => ({
    openLiveRoomSettings: openSettings,
    closeLiveRoomSettings: closeSettings
  }));
});

afterEach(async () => {
  const entry = await import("../../extension/live/live-room-entry.js");
  entry.stopLiveRoomCompanion();
  vi.doUnmock("../../extension/bilibili/video-id-shared.js");
  vi.doUnmock("../../extension/live/live-chat-controller.js");
  vi.doUnmock("../../extension/live/live-overlay-binding.js");
  vi.doUnmock("../../extension/live/live-room-settings.js");
  vi.restoreAllMocks();
});

describe("直播间设置入口与重连", () => {
  it("首次目标平台刷新完成后才挂载启动开关", async () => {
    const host = mountPlayer();
    let resolveRefresh!: () => void;
    controller.refreshTarget.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));
    const entry = await import("../../extension/live/live-room-entry.js");

    const starting = entry.startLiveRoomCompanion();
    await vi.waitFor(() => expect(controller.refreshTarget).toHaveBeenCalledTimes(1));
    expect(host.querySelector(".biliscript-live-room-toggle")).toBeNull();

    resolveRefresh();
    await starting;
    expect(host.querySelector(".biliscript-live-room-toggle")).not.toBeNull();
  });

  it("设置重连先刷新目标再结束旧连接并启动", async () => {
    mountPlayer();
    const entry = await import("../../extension/live/live-room-entry.js");
    await entry.startLiveRoomCompanion();
    overlayDeps.onOpenLiveSettings?.("live");
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));

    await expect(settingsDeps.reconnect()).resolves.toBe(true);

    expect(controller.refreshTarget).toHaveBeenCalledTimes(2);
    expect(controller.stop).toHaveBeenCalledTimes(1);
    expect(controller.start).toHaveBeenCalledTimes(1);
    expect(controller.refreshTarget.mock.invocationCallOrder[1]).toBeLessThan(controller.stop.mock.invocationCallOrder[0]);
    expect(controller.stop.mock.invocationCallOrder[0]).toBeLessThan(controller.start.mock.invocationCallOrder[0]);
  });

  it("换房关闭设置并作废在途的旧房间重连", async () => {
    mountPlayer();
    const entry = await import("../../extension/live/live-room-entry.js");
    await entry.startLiveRoomCompanion();
    overlayDeps.onOpenLiveSettings?.("live");
    await vi.waitFor(() => expect(openSettings).toHaveBeenCalledTimes(1));
    let resolveRefresh!: () => void;
    controller.refreshTarget.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));

    const reconnecting = settingsDeps.reconnect();
    await vi.waitFor(() => expect(controller.refreshTarget).toHaveBeenCalledTimes(2));
    roomId = "222";
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(closeSettings).toHaveBeenCalledTimes(1);
    expect(controller.stop).toHaveBeenCalledTimes(1);
    resolveRefresh();

    await expect(reconnecting).resolves.toBe(false);
    expect(controller.start).not.toHaveBeenCalled();
    expect(controller.stop).toHaveBeenCalledTimes(1);
  });
});
