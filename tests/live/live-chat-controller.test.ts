// tests/live/live-chat-controller.test.ts
// LiveChatController 状态机、麦克风采集与权限拒绝、静音控制、字幕归并及挂断迟到事件防御测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createLiveChatController
} from "../../extension/live/live-chat-controller.js";
import type { PageAudioCaptureOptions, PageAudioCaptureSession } from "../../extension/live/page-media-capture.js";
import type { LiveTranscriptMerger } from "../../extension/live/live-transcript-merger.js";
import type { MossLiveTranscriptEvent } from "../../extension/live/moss-live-protocol.js";

class FakePort {
  name: string;
  disconnected = false;
  postedMessages: any[] = [];
  messageListeners: ((msg: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];

  constructor(name = "test-port") {
    this.name = name;
  }

  get onMessage() {
    return {
      addListener: (fn: (msg: any) => void) => {
        this.messageListeners.push(fn);
      }
    };
  }

  get onDisconnect() {
    return {
      addListener: (fn: () => void) => {
        this.disconnectListeners.push(fn);
      }
    };
  }

  postMessage(msg: any) {
    this.postedMessages.push(msg);
  }

  disconnect() {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) {
      fn();
    }
  }

  simulateMessage(msg: any) {
    for (const fn of this.messageListeners) {
      fn(msg);
    }
  }
}

class FakeAudioCapture implements PageAudioCaptureSession {
  muted = false;
  stopped = false;
  onPcmFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void;

  constructor(options: PageAudioCaptureOptions) {
    this.onPcmFrame = options.onPcmFrame;
    this.muted = Boolean(options.initialMuted);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  isMuted(): boolean {
    return this.muted;
  }

  stop(): void {
    this.stopped = true;
  }

  emitFrame(bytes: Uint8Array<ArrayBuffer>): void {
    if (!this.stopped && !this.muted) {
      this.onPcmFrame(bytes);
    }
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("LiveChatController", () => {
  function setupTest(overrides: {
    getTargetOrigin?: () => string;
    requestOrigins?: (origins: string[]) => Promise<{ ok: boolean; error?: string }>;
    sendRuntimeMessage?: (msg: any) => Promise<any>;
    startAudioCapture?: (opts: PageAudioCaptureOptions) => Promise<PageAudioCaptureSession>;
    port?: FakePort;
  } = {}) {
    const liveButton = document.createElement("button");
    const muteButton = document.createElement("button");
    muteButton.hidden = true;
    const showNotice = vi.fn();
    const fakePort = overrides.port || new FakePort();
    const connectPort = vi.fn(() => fakePort as any);

    let lastAudioCapture: FakeAudioCapture | null = null;
    const startAudioCapture =
      overrides.startAudioCapture ||
      vi.fn(async (opts: PageAudioCaptureOptions) => {
        lastAudioCapture = new FakeAudioCapture(opts);
        return lastAudioCapture;
      });

    const receivedTranscripts: MossLiveTranscriptEvent[] = [];
    let mergerDisposed = false;
    const createTranscriptMerger = vi.fn((): LiveTranscriptMerger => {
      mergerDisposed = false;
      return {
        handleEvent: (ev) => {
          if (!mergerDisposed) {
            receivedTranscripts.push(ev);
          }
        },
        dispose: () => {
          mergerDisposed = true;
        }
      };
    });

    const requestOrigins = overrides.requestOrigins || vi.fn(async () => ({ ok: true }));
    const sendRuntimeMessage = overrides.sendRuntimeMessage || vi.fn(async (msg: any) => {
      if (msg.type === "live-session-prepare") {
        return {
          ok: true,
          provider: {
            id: "moss-1",
            baseUrl: "https://api.mosi.cn",
            model: "moss-live-1.0"
          }
        };
      }
      if (msg.type === "live-session-cleanup") {
        return { ok: true };
      }
      return { ok: true };
    });

    const controller = createLiveChatController({
      liveButton,
      muteButton,
      showNotice,
      connectPort,
      sendRuntimeMessage,
      requestOrigins,
      startAudioCapture,
      createTranscriptMerger,
      getTargetOrigin: overrides.getTargetOrigin
    });

    return {
      controller,
      liveButton,
      muteButton,
      showNotice,
      fakePort,
      connectPort,
      sendRuntimeMessage,
      requestOrigins,
      startAudioCapture,
      getAudioCapture: () => lastAudioCapture,
      receivedTranscripts,
      isMergerDisposed: () => mergerDisposed
    };
  }

  it("initializes with idle state and appropriate attributes", () => {
    const { controller, liveButton, muteButton } = setupTest();

    expect(controller.getState()).toBe("idle");
    expect(liveButton.dataset.state).toBe("idle");
    expect(liveButton.getAttribute("aria-pressed")).toBe("false");
    expect(liveButton.getAttribute("aria-busy")).toBe("false");
    expect(liveButton.title).toContain("开启实时伴看");
    expect(muteButton.hidden).toBe(true);
  });

  it("initiates permission request synchronously from start before any await tick", () => {
    let permCalled = false;
    const requestOrigins = vi.fn(async () => {
      permCalled = true;
      return { ok: true };
    });

    const { controller } = setupTest({ requestOrigins });

    // Call start synchronously
    const startPromise = controller.start();

    // Must be invoked synchronously in the same call frame (preserves user gesture)
    expect(permCalled).toBe(true);
    expect(requestOrigins).toHaveBeenCalledWith(["https://api.mosi.cn"]);

    return startPromise;
  });

  it("requests custom origin synchronously from getTargetOrigin without requesting default api.mosi.cn", async () => {
    const requestOrigins = vi.fn(async () => ({ ok: true }));
    const { controller } = setupTest({
      getTargetOrigin: () => "https://custom.live.mosi.cn:8080",
      requestOrigins
    });

    await controller.start();

    expect(requestOrigins).toHaveBeenCalledWith(["https://custom.live.mosi.cn:8080"]);
    expect(requestOrigins).not.toHaveBeenCalledWith(["https://api.mosi.cn"]);
  });

  it("surfaces actionable re-save-in-settings error when background check detects revoked permission", async () => {
    const { controller, liveButton, showNotice } = setupTest({
      sendRuntimeMessage: async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return {
            ok: false,
            error: "未授予平台域名权限（https://custom.live.mosi.cn），请在设置中重新保存该平台以授予权限"
          };
        }
        return { ok: true };
      }
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith(
      "未授予平台域名权限（https://custom.live.mosi.cn），请在设置中重新保存该平台以授予权限"
    );
  });

  it("handles user denial of host permissions with actionable failure state", async () => {
    const { controller, liveButton, showNotice } = setupTest({
      requestOrigins: async () => ({
        ok: false,
        error: "用户拒绝授予 host_permissions：未授权 https://api.mosi.cn/*"
      })
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("未授权 https://api.mosi.cn/*"));
  });

  it("handles microphone permission denial with clear feedback and cleans up session rule", async () => {
    const { controller, liveButton, showNotice, connectPort, sendRuntimeMessage } = setupTest({
      startAudioCapture: async () => {
        throw new Error("麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风后重试");
      }
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith("麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风后重试");
    expect(connectPort).not.toHaveBeenCalled();
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });

  it("handles preparation failure (e.g. missing API key) without opening microphone", async () => {
    const { controller, liveButton, showNotice, startAudioCapture } = setupTest({
      sendRuntimeMessage: async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return { ok: false, error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key" };
        }
        return { ok: true };
      }
    });

    const ok = await controller.start();

    expect(ok).toBe(false);
    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(showNotice).toHaveBeenCalledWith("未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key");
    expect(startAudioCapture).not.toHaveBeenCalled();
  });

  it("transitions to connecting, posts start to port, switches to connected, and streams mic audio frames", async () => {
    const { controller, liveButton, muteButton, fakePort, getAudioCapture } = setupTest();

    const startPromise = controller.start();
    expect(controller.getState()).toBe("connecting");
    expect(liveButton.classList.contains("is-connecting")).toBe(true);

    const ok = await startPromise;
    expect(ok).toBe(true);

    // Posted start message to port
    expect(fakePort.postedMessages).toEqual([
      { action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0" }
    ]);

    // Simulate connected event
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");
    expect(liveButton.classList.contains("is-connected")).toBe(true);
    expect(liveButton.getAttribute("aria-pressed")).toBe("true");
    expect(muteButton.hidden).toBe(false);

    // Emit 20ms PCM frame from microphone capture -> forwarded over port as base64
    const capture = getAudioCapture()!;
    expect(capture).not.toBeNull();
    capture.emitFrame(new Uint8Array([10, 20, 30, 40]));

    expect(fakePort.postedMessages).toHaveLength(2);
    expect(fakePort.postedMessages[1]).toEqual({
      action: "audio",
      pcmBase64: expect.any(String)
    });
  });

  it("toggles microphone mute, syncs mic_state over port, and suppresses upstream audio while muted", async () => {
    const { controller, muteButton, fakePort, getAudioCapture } = setupTest();

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;

    expect(controller.isMuted()).toBe(false);
    expect(muteButton.getAttribute("aria-pressed")).toBe("false");

    // Mute
    controller.toggleMute();
    expect(controller.isMuted()).toBe(true);
    expect(getAudioCapture()?.isMuted()).toBe(true);
    expect(muteButton.classList.contains("is-muted")).toBe(true);
    expect(muteButton.getAttribute("aria-pressed")).toBe("true");
    expect(fakePort.postedMessages).toEqual([{ action: "mic_state", enabled: false }]);

    // Emitting frame while muted produces no port messages
    getAudioCapture()!.emitFrame(new Uint8Array([1, 2, 3, 4]));
    expect(fakePort.postedMessages).toHaveLength(1);

    // Unmute
    controller.toggleMute();
    expect(controller.isMuted()).toBe(false);
    expect(getAudioCapture()?.isMuted()).toBe(false);
    expect(muteButton.classList.contains("is-muted")).toBe(false);
    expect(fakePort.postedMessages).toEqual([
      { action: "mic_state", enabled: false },
      { action: "mic_state", enabled: true }
    ]);
  });

  it("forwards transcript events to merger while active and blocks late transcript events after hangup", async () => {
    const { controller, fakePort, receivedTranscripts, isMergerDisposed, getAudioCapture } = setupTest();

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });

    fakePort.simulateMessage({
      type: "transcript",
      event: { kind: "input.done", text: "你好" }
    });
    fakePort.simulateMessage({
      type: "transcript",
      event: { kind: "output.done", text: "你好，我在！", runId: "r1", turnId: "t1" }
    });

    expect(receivedTranscripts).toHaveLength(2);

    // Hangup (stop)
    await controller.stop();
    expect(getAudioCapture()?.stopped).toBe(true);
    expect(isMergerDisposed()).toBe(true);

    // Late transcript arrives from port after hangup -> strictly ignored
    fakePort.simulateMessage({
      type: "transcript",
      event: { kind: "output.done", text: "挂断后的迟到回复", runId: "r2", turnId: "t2" }
    });
    expect(receivedTranscripts).toHaveLength(2);
  });

  it("transitions to failure, stops capture, disposes merger, and cleans up rule on port error message", async () => {
    const { controller, liveButton, muteButton, fakePort, showNotice, sendRuntimeMessage, getAudioCapture, isMergerDisposed } =
      setupTest();

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");

    fakePort.simulateMessage({ type: "error", error: "WebSocket 连接失败" });

    expect(controller.getState()).toBe("failure");
    expect(liveButton.classList.contains("is-failure")).toBe(true);
    expect(muteButton.hidden).toBe(true);
    expect(getAudioCapture()?.stopped).toBe(true);
    expect(isMergerDisposed()).toBe(true);
    expect(showNotice).toHaveBeenCalledWith("WebSocket 连接失败");
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });

  it("stop() closes connection, stops mic capture, calls cleanup, and resets to idle", async () => {
    const { controller, liveButton, muteButton, fakePort, sendRuntimeMessage, getAudioCapture } = setupTest();

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });

    await controller.stop();

    expect(controller.getState()).toBe("idle");
    expect(liveButton.dataset.state).toBe("idle");
    expect(liveButton.classList.contains("is-connected")).toBe(false);
    expect(muteButton.hidden).toBe(true);
    expect(getAudioCapture()?.stopped).toBe(true);
    expect(fakePort.postedMessages).toContainEqual({ action: "stop" });
    expect(fakePort.disconnected).toBe(true);
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });

  it("rejects late events from stopped session (generation check)", async () => {
    const { controller, liveButton, fakePort } = setupTest();

    await controller.start();
    // Stop session while still in connecting
    await controller.stop();
    expect(controller.getState()).toBe("idle");

    // Late connected event arrives from old port
    fakePort.simulateMessage({ type: "connected" });

    // Should still be idle, NOT flipped to connected
    expect(controller.getState()).toBe("idle");
    expect(liveButton.classList.contains("is-connected")).toBe(false);
  });

  it("regression: when stop() races in-flight live-session-prepare, stale return cleans up session rule", async () => {
    let resolvePrepare!: (val: any) => void;
    const preparePromise = new Promise((resolve) => {
      resolvePrepare = resolve;
    });

    const { controller, sendRuntimeMessage } = setupTest({
      sendRuntimeMessage: vi.fn(async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return preparePromise;
        }
        return { ok: true };
      })
    });

    const startPromise = controller.start();
    expect(controller.getState()).toBe("connecting");

    // User calls stop while prepare is in-flight
    await controller.stop();
    expect(controller.getState()).toBe("idle");

    // Now background prepare resolves
    resolvePrepare({
      ok: true,
      provider: { id: "moss-1", baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" }
    });

    const ok = await startPromise;
    expect(ok).toBe(false);
    expect(controller.getState()).toBe("idle");
    // Verify cleanup was invoked for the stale prepare completion so rule does not leak
    expect(sendRuntimeMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "live-session-cleanup" }));
  });
});
