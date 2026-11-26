// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createLiveChatController,
  type LiveVideoBackendTaskManager
} from "../../extension/live/live-chat-controller.js";

class FakePort {
  readonly postedMessages: any[] = [];
  private readonly messageListeners: ((message: any) => void)[] = [];
  private readonly disconnectListeners: (() => void)[] = [];

  get onMessage() {
    return {
      addListener: (listener: (message: any) => void) => this.messageListeners.push(listener)
    };
  }

  get onDisconnect() {
    return {
      addListener: (listener: () => void) => this.disconnectListeners.push(listener)
    };
  }

  postMessage(message: unknown): void {
    this.postedMessages.push(message);
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("LiveChatController AI volume", () => {
  async function setup(options: {
    initialSpeed?: number;
    onServerOutputConfigured?: (patch: { liveVoiceVolume?: number; liveVoiceSpeed?: number }) => void;
  } = {}) {
    const port = new FakePort();
    const controller = createLiveChatController({
      initialVolume: 0.6,
      initialSpeed: options.initialSpeed,
      onServerOutputConfigured: options.onServerOutputConfigured,
      connectPort: () => port as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async (message: any) => message.type === "live-session-prepare"
        ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
        : { ok: true }) as any,
      startAudioCapture: async () => ({
        setMuted: () => {},
        isMuted: () => false,
        stop: () => {},
        setShareVideoAudio: () => {},
        isSharingVideoAudio: () => true,
        getVideoAudioStatus: () => "已获取音轨",
        isMicVadActive: () => false,
        isVoiceRecentlyActive: () => true
      }),
      startVideoCapture: () => ({ stop: () => {}, configure: () => {} })
    });
    await controller.start();
    port.emit({ type: "connected" });
    return { controller, port };
  }

  it("starts with the saved volume and forwards real-time changes", async () => {
    const onServerOutputConfigured = vi.fn();
    const { controller, port } = await setup({ onServerOutputConfigured });
    expect(port.postedMessages[0]).toMatchObject({ action: "start", volume: 0.6 });
    expect(controller.getState()).toBe("connected");

    controller.applyAudioSettings({
      liveVoiceVolume: 35,
      liveVoiceSpeed: 1.25,
      liveVoicePriority: false,
      liveShareVideoAudio: true
    });
    expect(port.postedMessages.slice(-2)).toEqual([
      { action: "set_volume", volume: 0.35 },
      { action: "set_speed", speed: 1.25 }
    ]);
    expect(controller.isVoicePriority()).toBe(false);
    expect(controller.isSharingVideoAudio()).toBe(true);
    expect(onServerOutputConfigured).not.toHaveBeenCalled();

    controller.setVolume(2);
    expect(port.postedMessages.at(-1)).toEqual({ action: "set_volume", volume: 2 });

    await controller.stop();
    expect(controller.getState()).toBe("idle");
  });

  it("adopts server-confirmed output volume and speed and emits quantized integer percent", async () => {
    const onServerOutputConfigured = vi.fn();
    const { controller, port } = await setup({ onServerOutputConfigured });
    port.emit({ type: "output_configured", volume: 1.375, speed: 1.25 });
    expect(controller.getVolume()).toBe(1.38);
    expect(controller.getSpeed()).toBe(1.25);
    expect(onServerOutputConfigured).toHaveBeenCalledWith({
      liveVoiceVolume: 138,
      liveVoiceSpeed: 1.25
    });
  });

  it("clamps the legacy 2x setting to the new 1.5x maximum", async () => {
    const { controller, port } = await setup({ initialSpeed: 2 });
    expect(controller.getSpeed()).toBe(1.5);
    expect(port.postedMessages[0]).toMatchObject({ action: "start", speed: 1.5 });
  });
});

describe("LiveChatController voice priority and ducking", () => {
  function createMockVideo(initialVolume = 0.8, paused = false) {
    const video = {
      volume: initialVolume,
      muted: false,
      paused,
      pause: vi.fn(),
      play: vi.fn(async () => {})
    } as unknown as HTMLVideoElement;
    return video;
  }

  async function setupWithVideo(options: {
    initialVolume?: number;
    initialVoicePriority?: boolean;
    initialShareVideoAudio?: boolean;
    videoVolume?: number;
    videoPaused?: boolean;
    videoBackendTaskManager?: LiveVideoBackendTaskManager;
  } = {}) {
    const port = new FakePort();
    const video = createMockVideo(options.videoVolume ?? 0.8, options.videoPaused ?? false);
    let vadCallback: ((active: boolean) => void) | null = null;
    let statusCallback: ((status: any) => void) | null = null;
    let shareVideoAudioState = options.initialShareVideoAudio ?? true;
    let videoAudioStatus = "已获取音轨";

    const controller = createLiveChatController({
      initialVolume: options.initialVolume ?? 1,
      initialVoicePriority: options.initialVoicePriority ?? true,
      initialShareVideoAudio: options.initialShareVideoAudio ?? true,
      getVideoElement: () => video,
      connectPort: () => port as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async (message: any) => message.type === "live-session-prepare"
        ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
        : { ok: true }) as any,
      startAudioCapture: async (captureOpts) => {
        vadCallback = captureOpts.onVadStateChange || null;
        statusCallback = captureOpts.onVideoAudioStatusChange || null;
        return {
          setMuted: () => {},
          isMuted: () => false,
          stop: () => {},
          setShareVideoAudio: (enabled: boolean) => {
            shareVideoAudioState = enabled;
            if (!enabled) statusCallback?.("未开启");
          },
          isSharingVideoAudio: () => shareVideoAudioState,
          getVideoAudioStatus: () => videoAudioStatus as any,
          isMicVadActive: () => false,
          isVoiceRecentlyActive: () => true
        };
      },
      startVideoCapture: () => ({ stop: () => {}, configure: () => {} }),
      videoBackendTaskManager: options.videoBackendTaskManager
    });

    await controller.start();
    port.emit({ type: "connected" });

    return {
      controller,
      port,
      video,
      emitVad: (active: boolean) => vadCallback?.(active),
      emitStatus: (status: any) => {
        videoAudioStatus = status;
        statusCallback?.(status);
      }
    };
  }

  function createCompletedSummaryManager(): LiveVideoBackendTaskManager {
    return {
      runTask: vi.fn(async (options) => {
        options.onSpokenResult("后台总结完成");
        return null;
      }),
      cancelTask: vi.fn(() => true),
      cancelAllTasks: vi.fn()
    };
  }

  async function emitCompletedSummary(port: FakePort): Promise<void> {
    port.emit({
      type: "delegation_created",
      delegation: { delegationId: "summary-1", objective: "总结全片", context: [] }
    });
    await vi.waitFor(() => expect(port.postedMessages).toContainEqual({
      action: "delegation_result",
      delegationId: "summary-1",
      status: "completed",
      content: "后台总结完成"
    }));
  }

  it("pauses the original video during a backend summary and resumes it on completion", async () => {
    const videoBackendTaskManager = createCompletedSummaryManager();
    const { port, video } = await setupWithVideo({ videoVolume: 0.8, videoBackendTaskManager });
    await emitCompletedSummary(port);

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.pause).toHaveBeenCalledTimes(1);
    expect(video.volume).toBeCloseTo(0.16, 5);

    port.emit({ type: "speaking_state", speaking: false });
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("resumes summary-paused playback when the user interrupts", async () => {
    const videoBackendTaskManager = createCompletedSummaryManager();
    const { controller, port, video } = await setupWithVideo({ videoBackendTaskManager });
    await emitCompletedSummary(port);
    port.emit({ type: "speaking_state", speaking: true });

    controller.interrupt();
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("does not resume a video that was already paused before the summary", async () => {
    const videoBackendTaskManager = createCompletedSummaryManager();
    const { port, video } = await setupWithVideo({ videoPaused: true, videoBackendTaskManager });
    await emitCompletedSummary(port);
    port.emit({ type: "speaking_state", speaking: true });
    port.emit({ type: "speaking_state", speaking: false });

    expect(video.pause).not.toHaveBeenCalled();
    expect(video.play).not.toHaveBeenCalled();
  });

  it("waits for the next response when a summary completes during an existing reply", async () => {
    const videoBackendTaskManager = createCompletedSummaryManager();
    const { port, video } = await setupWithVideo({ videoBackendTaskManager });
    port.emit({ type: "speaking_state", speaking: true });
    await emitCompletedSummary(port);
    expect(video.pause).not.toHaveBeenCalled();

    port.emit({ type: "speaking_state", speaking: false });
    port.emit({ type: "speaking_state", speaking: true });
    expect(video.pause).toHaveBeenCalledTimes(1);
  });

  it("ducks video volume when user mic VAD detects speech and restores on silence", async () => {
    const { video, emitVad } = await setupWithVideo({ videoVolume: 0.8 });
    expect(video.volume).toBeCloseTo(0.8, 5);

    emitVad(true);
    expect(video.volume).toBeCloseTo(0.16, 5);

    emitVad(false);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("ducks video volume when Agent is speaking and restores when speaking ends", async () => {
    const { port, video } = await setupWithVideo({ videoVolume: 1.0 });
    expect(video.volume).toBeCloseTo(1.0, 5);

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.volume).toBeCloseTo(0.2, 5);

    port.emit({ type: "speaking_state", speaking: false });
    expect(video.volume).toBeCloseTo(1.0, 5);
  });

  it("keeps video ducked while overlapping user VAD and Agent speech occur, restoring only when both finish", async () => {
    const { port, video, emitVad } = await setupWithVideo({ videoVolume: 0.5 });

    emitVad(true);
    expect(video.volume).toBeCloseTo(0.1, 5);

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.volume).toBeCloseTo(0.1, 5);

    emitVad(false);
    expect(video.volume).toBeCloseTo(0.1, 5);

    port.emit({ type: "speaking_state", speaking: false });
    expect(video.volume).toBeCloseTo(0.5, 5);
  });

  it("does not duck video volume when voice priority is disabled, and restores if toggled off while ducked", async () => {
    const { controller, port, video, emitVad } = await setupWithVideo({ videoVolume: 0.6 });

    emitVad(true);
    expect(video.volume).toBeCloseTo(0.12, 5);

    controller.setVoicePriority(false);
    expect(controller.isVoicePriority()).toBe(false);
    expect(video.volume).toBeCloseTo(0.6, 5);

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.volume).toBeCloseTo(0.6, 5);
  });

  it("restores video volume when user is muted during active VAD", async () => {
    const { controller, video, emitVad } = await setupWithVideo({ videoVolume: 0.8 });

    emitVad(true);
    expect(video.volume).toBeCloseTo(0.16, 5);

    controller.setMuted(true);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("restores video volume immediately when interrupt is triggered during agent speech", async () => {
    const { controller, port, video } = await setupWithVideo({ videoVolume: 0.8 });

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.volume).toBeCloseTo(0.16, 5);

    controller.interrupt();
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("restores video volume when companion is stopped or disposed", async () => {
    const { controller, port, video } = await setupWithVideo({ videoVolume: 0.8 });

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.volume).toBeCloseTo(0.16, 5);

    await controller.stop();
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("updates base video volume proportionally while ducked and restores to the new volume", async () => {
    const { controller, port, video } = await setupWithVideo({ videoVolume: 0.8 });

    port.emit({ type: "speaking_state", speaking: true });
    expect(video.volume).toBeCloseTo(0.16, 5);
    expect(controller.getVideoBaseVolume()).toBeCloseTo(0.8, 5);

    expect(controller.setVideoBaseVolume(0.5)).toBeCloseTo(0.5, 5);
    expect(controller.getVideoBaseVolume()).toBeCloseTo(0.5, 5);
    expect(video.volume).toBeCloseTo(0.1, 5);

    port.emit({ type: "speaking_state", speaking: false });
    expect(video.volume).toBeCloseTo(0.5, 5);
  });

  it("supports toggling shareVideoAudio and tracks status", async () => {
    const onStatusChange = vi.fn();
    const port = new FakePort();
    const controller = createLiveChatController({
      initialShareVideoAudio: true,
      onVideoAudioStatusChange: onStatusChange,
      connectPort: () => port as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async () => ({ ok: true })) as any,
      startAudioCapture: async (opts) => {
        let shared = true;
        return {
          setMuted: () => {},
          isMuted: () => false,
          stop: () => {},
          setShareVideoAudio: (enabled: boolean) => {
            shared = enabled;
            if (!enabled) opts.onVideoAudioStatusChange?.("未开启");
          },
          isSharingVideoAudio: () => shared,
          getVideoAudioStatus: () => (shared ? "已获取音轨" : "未开启"),
          isMicVadActive: () => false,
          isVoiceRecentlyActive: () => true
        };
      },
      startVideoCapture: () => ({ stop: () => {}, configure: () => {} })
    });

    expect(controller.isSharingVideoAudio()).toBe(true);
    await controller.start();
    port.emit({ type: "connected" });

    controller.setShareVideoAudio(false);
    expect(controller.isSharingVideoAudio()).toBe(false);
    expect(controller.getVideoAudioStatus()).toBe("未开启");
    expect(onStatusChange).toHaveBeenCalledWith("未开启");
  });
});
