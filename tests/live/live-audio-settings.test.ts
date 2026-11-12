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
  return {
    getVolume: () => volume,
    setVolume: vi.fn((value: number) => { volume = value; }),
    getSpeed: () => speed,
    setSpeed: vi.fn((value: number) => { speed = value; }),
    isVoicePriority: () => priority,
    setVoicePriority: vi.fn((value: boolean) => { priority = value; }),
    isSharingVideoAudio: () => share,
    setShareVideoAudio: vi.fn((value: boolean) => { share = value; })
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

  it("跨标签页变更归一化后即时应用，退订后不再接收同页或外部变更", async () => {
    const listeners: Array<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void> = [];
    vi.spyOn(chrome.storage.onChanged, "addListener").mockImplementation((listener) => {
      listeners.push(listener);
    });
    const audio = await import("../../extension/live/live-audio-settings.js");
    const { state } = await import("../../extension/core/state.js");
    const controller = createController();
    const onSync = vi.fn();
    const unwatch = audio.watchLiveAudioSettings(() => controller, onSync);

    for (const listener of listeners) {
      listener({
        liveVoiceVolume: { oldValue: 100, newValue: 999 },
        liveVoiceSpeed: { oldValue: 1, newValue: 1.3 },
        liveVoicePriority: { oldValue: true, newValue: false },
        liveShareVideoAudio: { oldValue: false, newValue: true }
      }, "sync");
    }

    expect(controller.setVolume).toHaveBeenCalledWith(2);
    expect(controller.setSpeed).toHaveBeenCalledWith(1.25);
    expect(controller.setVoicePriority).toHaveBeenCalledWith(false);
    expect(controller.setShareVideoAudio).toHaveBeenCalledWith(true);
    expect(state.settings).toMatchObject({
      liveVoiceVolume: 200,
      liveVoiceSpeed: 1.25,
      liveVoicePriority: false,
      liveShareVideoAudio: true
    });
    expect(onSync).toHaveBeenCalledTimes(1);

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
