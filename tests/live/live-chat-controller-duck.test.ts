import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveChatController } from "../../extension/live/live-chat-controller.js";
import type { PageVideoDuckSession } from "../../extension/live/page-video-duck.js";

class FakePort {
  disconnected = false;
  readonly postedMessages: unknown[] = [];
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
    this.disconnected = true;
    for (const listener of this.disconnectListeners) listener();
  }

  emit(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }
}

class FakeVideoDuck implements PageVideoDuckSession {
  readonly states: boolean[] = [];
  stopped = false;

  setDucked(ducked: boolean): void {
    this.states.push(ducked);
  }

  stop(): void {
    this.stopped = true;
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("LiveChatController video ducking", () => {
  async function setup() {
    const port = new FakePort();
    const videoDuck = new FakeVideoDuck();
    const createVideoDuck = vi.fn(() => videoDuck);
    const controller = createLiveChatController({
      liveButton: document.createElement("button"),
      connectPort: () => port as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async (message: any) => message.type === "live-session-prepare"
        ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
        : { ok: true }) as any,
      startAudioCapture: async () => ({
        setMuted: () => {},
        isMuted: () => false,
        stop: () => {}
      }),
      startVideoCapture: () => ({ stop: () => {} }),
      createVideoDuck
    });
    await controller.start();
    port.emit({ type: "connected" });
    return { controller, port, videoDuck, createVideoDuck };
  }

  it("forwards duck events and releases resources on hangup while ignoring late events", async () => {
    const { controller, port, videoDuck, createVideoDuck } = await setup();
    port.emit({ type: "duck_video", active: true });
    port.emit({ type: "duck_video", active: false });
    expect(videoDuck.states).toEqual([true, false]);

    await controller.stop();
    expect(videoDuck.stopped).toBe(true);
    port.emit({ type: "duck_video", active: true });
    expect(createVideoDuck).toHaveBeenCalledTimes(1);
    expect(videoDuck.states).toEqual([true, false]);
  });

  it("stops an active duck on connection failure", async () => {
    const { controller, port, videoDuck } = await setup();
    port.emit({ type: "duck_video", active: true });
    port.emit({ type: "error", error: "连接失败" });
    expect(controller.getState()).toBe("failure");
    expect(videoDuck.stopped).toBe(true);
  });
});
