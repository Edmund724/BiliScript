import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveChatController } from "../../extension/live/live-chat-controller.js";

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
  async function setup() {
    const port = new FakePort();
    const volumeControl = document.createElement("details");
    const controller = createLiveChatController({
      liveButton: document.createElement("button"),
      volumeControl,
      initialVolume: 0.6,
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
    expect(port.postedMessages.at(-1)).toEqual({ action: "set_volume", volume: 1 });

    await controller.stop();
    expect(volumeControl.hidden).toBe(true);
    expect(volumeControl.open).toBe(false);
  });

  it("ignores legacy duck events instead of taking over the page player volume", async () => {
    const { port } = await setup();
    const messageCount = port.postedMessages.length;
    port.emit({ type: "duck_video", active: true });
    port.emit({ type: "duck_video", active: false });
    expect(port.postedMessages).toHaveLength(messageCount);
  });
});
