import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

beforeEach(() => {
  resetModuleState();
});

function createController() {
  let volume = 1;
  let speed = 1;
  let priority = true;
  let share = false;
  const setVolume = vi.fn((value: number) => { volume = value; });
  const setSpeed = vi.fn((value: number) => { speed = value; });
  const setVoicePriority = vi.fn((value: boolean) => { priority = value; });
  const setShareVideoAudio = vi.fn((value: boolean) => { share = value; });
  const applyAudioSettings = vi.fn((patch: {
    liveVoiceVolume?: number;
    liveVoiceSpeed?: number;
    liveVoicePriority?: boolean;
    liveShareVideoAudio?: boolean;
  }) => {
    if (patch.liveVoiceVolume !== undefined) setVolume(patch.liveVoiceVolume / 100);
    if (patch.liveVoiceSpeed !== undefined) setSpeed(patch.liveVoiceSpeed);
    if (patch.liveVoicePriority !== undefined) setVoicePriority(patch.liveVoicePriority);
    if (patch.liveShareVideoAudio !== undefined) setShareVideoAudio(patch.liveShareVideoAudio);
  });
  return {
    getVolume: () => volume,
    setVolume,
    getSpeed: () => speed,
    setSpeed,
    isVoicePriority: () => priority,
    setVoicePriority,
    isSharingVideoAudio: () => share,
    setShareVideoAudio,
    applyAudioSettings
  };
}

describe("live/live-audio-settings 同源持久化与同步", () => {
  it("同标签页提交只发一次保存，并同步四项控制器与浮窗", async () => {
    const audio = await import("../../extension/live/live-audio-settings.js");
    const { state } = await import("../../extension/core/state.js");
    const controller = createController();
    const onSync = vi.fn();
    const unwatch = audio.watchLiveAudioSettings(() => controller, onSync);
    const sendMessage = vi.spyOn(chrome.runtime, "sendMessage");

    await audio.persistLiveAudioSettings({
      liveVoiceVolume: 65,
      liveVoiceSpeed: 1.25,
      liveVoicePriority: false,
      liveShareVideoAudio: true
    });

    expect(controller.applyAudioSettings).toHaveBeenCalledTimes(1);
    expect(controller.setVolume).toHaveBeenCalledWith(0.65);
    expect(controller.setSpeed).toHaveBeenCalledWith(1.25);
    expect(controller.setVoicePriority).toHaveBeenCalledWith(false);
    expect(controller.setShareVideoAudio).toHaveBeenCalledWith(true);
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(state.settings).toMatchObject({
      liveVoiceVolume: 65,
      liveVoiceSpeed: 1.25,
      liveVoicePriority: false,
      liveShareVideoAudio: true
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({
      type: "save-settings",
      settings: {
        liveVoiceVolume: 65,
        liveVoiceSpeed: 1.25,
        liveVoicePriority: false,
        liveShareVideoAudio: true
      }
    }, expect.any(Function));
    unwatch();
  });

  it("浮窗预览只推控制器不落盘，提交落盘不重复下发，服务端回包落盘且不回弹控制器", async () => {
    const audio = await import("../../extension/live/live-audio-settings.js");
    const { state } = await import("../../extension/core/state.js");
    state.setSettings({ liveVoiceVolume: 100, liveVoiceSpeed: 1 } as any);
    const controller = createController();
    const onSync = vi.fn();
    const unwatch = audio.watchLiveAudioSettings(() => controller, onSync);
    const sendMessage = vi.spyOn(chrome.runtime, "sendMessage");

    await audio.dispatchLiveAudioChange({ liveVoiceVolume: 140 }, { source: "overlay", persist: false });
    expect(controller.setVolume).toHaveBeenCalledWith(1.4);
    expect(sendMessage).not.toHaveBeenCalled();

    await audio.dispatchLiveAudioChange({ liveVoiceVolume: 140 }, { source: "overlay", persist: true });
    expect(controller.setVolume).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      { type: "save-settings", settings: { liveVoiceVolume: 140 } },
      expect.any(Function)
    );

    sendMessage.mockClear();
    controller.applyAudioSettings.mockClear();
    onSync.mockClear();
    await audio.dispatchLiveAudioChange(
      { liveVoiceVolume: 138, liveVoiceSpeed: 1.25 },
      { source: "server", persist: true }
    );
    expect(controller.applyAudioSettings).not.toHaveBeenCalled();
    expect(onSync).toHaveBeenCalledTimes(1);
    expect(state.settings).toMatchObject({ liveVoiceVolume: 138, liveVoiceSpeed: 1.25 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      { type: "save-settings", settings: { liveVoiceVolume: 138, liveVoiceSpeed: 1.25 } },
      expect.any(Function)
    );

    sendMessage.mockClear();
    await audio.dispatchLiveAudioChange(
      { liveVoiceVolume: 138, liveVoiceSpeed: 1.25 },
      { source: "server", persist: true }
    );
    expect(sendMessage).not.toHaveBeenCalled();
    unwatch();
  });

  it("跨标签页变更按整数百分比与离散档位比对防浮点乒乓，退订后不再接收同页或外部变更", async () => {
    const listeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
    vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((listener) => {
      listeners.push(listener);
    });
    const audio = await import("../../extension/live/live-audio-settings.js");
    const { state } = await import("../../extension/core/state.js");
    const controller = createController();
    controller.setVolume(1.375);
    controller.setSpeed(1.25);
    controller.setVolume.mockClear();
    controller.setSpeed.mockClear();
    controller.applyAudioSettings.mockClear();
    const onSync = vi.fn();
    const unwatch = audio.watchLiveAudioSettings(() => controller, onSync);

    for (const listener of listeners) {
      listener({
        liveVoiceVolume: { oldValue: 100, newValue: 138 },
        liveVoiceSpeed: { oldValue: 1, newValue: 1.3 }
      }, "sync");
    }
    expect(controller.applyAudioSettings).not.toHaveBeenCalled();
    expect(controller.setVolume).not.toHaveBeenCalled();
    expect(controller.setSpeed).not.toHaveBeenCalled();
    expect(onSync).toHaveBeenCalledTimes(1);

    for (const listener of listeners) {
      listener({
        liveVoiceVolume: { oldValue: 138, newValue: 999 },
        liveVoiceSpeed: { oldValue: 1.25, newValue: 1.5 },
        liveVoicePriority: { oldValue: true, newValue: false },
        liveShareVideoAudio: { oldValue: false, newValue: true }
      }, "sync");
    }

    expect(controller.setVolume).toHaveBeenCalledWith(2);
    expect(controller.setSpeed).toHaveBeenCalledWith(1.5);
    expect(controller.setVoicePriority).toHaveBeenCalledWith(false);
    expect(controller.setShareVideoAudio).toHaveBeenCalledWith(true);
    expect(state.settings).toMatchObject({
      liveVoiceVolume: 200,
      liveVoiceSpeed: 1.5,
      liveVoicePriority: false,
      liveShareVideoAudio: true
    });
    expect(onSync).toHaveBeenCalledTimes(2);

    for (const listener of listeners) {
      listener({ liveVoiceVolume: { oldValue: 200, newValue: undefined } }, "sync");
    }
    expect(controller.setVolume).toHaveBeenLastCalledWith(1);
    expect(state.settings?.liveVoiceVolume).toBe(100);

    unwatch();
    audio.applyLiveAudioSettings({ liveVoiceVolume: 40 });
    expect(controller.setVolume).toHaveBeenCalledTimes(2);
    expect(state.settings?.liveVoiceVolume).toBe(40);
  });
});
