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
  async function setup(options: { initialSpeed?: number } = {}) {
    const port = new FakePort();
    const volumeControl = document.createElement("details");
    const controller = createLiveChatController({
      liveButton: document.createElement("button"),
      volumeControl,
      initialVolume: 0.6,
      initialSpeed: options.initialSpeed,
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
      startVideoCapture: () => ({ stop: () => {} })
    });
    await controller.start();
    port.emit({ type: "connected" });
    return { controller, port, volumeControl };
  }

  it("starts with the saved volume and forwards real-time changes", async () => {
    const { controller, port, volumeControl } = await setup();
    expect(port.postedMessages[0]).toMatchObject({ action: "start", volume: 0.6 });
    expect(volumeControl.hidden).toBe(false);

    volumeControl.open = true;
    controller.setVolume(0.35);
    expect(port.postedMessages.at(-1)).toEqual({ action: "set_volume", volume: 0.35 });

    controller.setVolume(2);
    expect(port.postedMessages.at(-1)).toEqual({ action: "set_volume", volume: 2 });

    await controller.stop();
    expect(volumeControl.hidden).toBe(true);
    expect(volumeControl.open).toBe(false);
  });

  it("adopts server-confirmed output volume and speed", async () => {
    const { controller, port } = await setup();
    port.emit({ type: "output_configured", volume: 1.5, speed: 1.25 });
    expect(controller.getVolume()).toBe(1.5);
    expect(controller.getSpeed()).toBe(1.25);
  });

  it("clamps the legacy 2x setting to the new 1.5x maximum", async () => {
    const { controller, port } = await setup({ initialSpeed: 2 });
    expect(controller.getSpeed()).toBe(1.5);
    expect(port.postedMessages[0]).toMatchObject({ action: "start", speed: 1.5 });
  });

  it("ignores legacy duck events instead of taking over the page player volume", async () => {
    const { port } = await setup();
    const messageCount = port.postedMessages.length;
    port.emit({ type: "duck_video", active: true });
    port.emit({ type: "duck_video", active: false });
    expect(port.postedMessages).toHaveLength(messageCount);
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
      liveButton: document.createElement("button"),
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
      startVideoCapture: () => ({ stop: () => {} }),
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
    const { controller, video, emitVad } = await setupWithVideo({ videoVolume: 0.8 });
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.8, 5);

    emitVad(true);
    expect(controller.isDucked()).toBe(true);
    expect(video.volume).toBeCloseTo(0.16, 5);

    emitVad(false);
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("ducks video volume when Agent is speaking and restores when speaking ends", async () => {
    const { controller, port, video } = await setupWithVideo({ videoVolume: 1.0 });
    expect(controller.isDucked()).toBe(false);

    port.emit({ type: "speaking_state", speaking: true });
    expect(controller.isDucked()).toBe(true);
    expect(video.volume).toBeCloseTo(0.2, 5);

    port.emit({ type: "speaking_state", speaking: false });
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(1.0, 5);
  });

  it("keeps video ducked while overlapping user VAD and Agent speech occur, restoring only when both finish", async () => {
    const { controller, port, video, emitVad } = await setupWithVideo({ videoVolume: 0.5 });

    // User starts talking
    emitVad(true);
    expect(controller.isDucked()).toBe(true);
    expect(video.volume).toBeCloseTo(0.1, 5);

    // Agent also starts talking
    port.emit({ type: "speaking_state", speaking: true });
    expect(controller.isDucked()).toBe(true);
    expect(video.volume).toBeCloseTo(0.1, 5);

    // User stops talking, but Agent still speaking
    emitVad(false);
    expect(controller.isDucked()).toBe(true);
    expect(video.volume).toBeCloseTo(0.1, 5);

    // Agent finishes speaking -> now fully restored
    port.emit({ type: "speaking_state", speaking: false });
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.5, 5);
  });

  it("does not duck video volume when voice priority is disabled, and restores if toggled off while ducked", async () => {
    const { controller, port, video, emitVad } = await setupWithVideo({ videoVolume: 0.6 });

    // Duck first
    emitVad(true);
    expect(controller.isDucked()).toBe(true);
    expect(video.volume).toBeCloseTo(0.12, 5);

    // User turns off voice priority -> restores immediately
    controller.setVoicePriority(false);
    expect(controller.isVoicePriority()).toBe(false);
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.6, 5);

    // Subsequent Agent speech does not duck
    port.emit({ type: "speaking_state", speaking: true });
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.6, 5);
  });

  it("restores video volume when user is muted during active VAD", async () => {
    const { controller, video, emitVad } = await setupWithVideo({ videoVolume: 0.8 });

    emitVad(true);
    expect(controller.isDucked()).toBe(true);

    controller.setMuted(true);
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("restores video volume immediately when interrupt is triggered during agent speech", async () => {
    const { controller, port, video } = await setupWithVideo({ videoVolume: 0.8 });

    port.emit({ type: "speaking_state", speaking: true });
    expect(controller.isDucked()).toBe(true);

    controller.interrupt();
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("restores video volume when companion is stopped or disposed", async () => {
    const { controller, port, video } = await setupWithVideo({ videoVolume: 0.8 });

    port.emit({ type: "speaking_state", speaking: true });
    expect(controller.isDucked()).toBe(true);

    await controller.stop();
    expect(controller.isDucked()).toBe(false);
    expect(video.volume).toBeCloseTo(0.8, 5);
  });

  it("supports toggling shareVideoAudio and tracks status", async () => {
    const onStatusChange = vi.fn();
    const port = new FakePort();
    const controller = createLiveChatController({
      liveButton: document.createElement("button"),
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
      startVideoCapture: () => ({ stop: () => {} })
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
