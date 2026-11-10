// tests/live/live-chat-controller.test.ts
// LiveChatController 状态机、麦克风采集与权限拒绝、静音控制、字幕归并及挂断迟到事件防御测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createLiveChatController,
  type LiveVideoBackendTaskManager
} from "../../extension/live/live-chat-controller.js";
import type { PageAudioCaptureOptions, PageAudioCaptureSession } from "../../extension/live/page-media-capture.js";
import type {
  PageVideoFrameCaptureOptions,
  PageVideoFrameCaptureSession
} from "../../extension/live/page-video-frame-capture.js";
import type { MossVideoCaptureConfig } from "../../extension/live/moss-video-config.js";
import type {
  LiveProviderType,
  MossLiveToolCall,
  MossLiveTranscriptEvent,
  MossLiveVideoContext
} from "../../extension/live/moss-live-protocol.js";

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

  videoAudioShared = true;
  setShareVideoAudio(enabled: boolean): void {
    this.videoAudioShared = enabled;
  }
  isSharingVideoAudio(): boolean { return this.videoAudioShared; }
  getVideoAudioStatus() { return "已获取音轨" as const; }
  isMicVadActive(): boolean { return false; }
  isVoiceRecentlyActive(): boolean { return true; }

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

class FakeVideoCapture implements PageVideoFrameCaptureSession {
  stopped = false;
  config: Partial<MossVideoCaptureConfig> | null = null;
  onJpegFrame: (bytes: Uint8Array<ArrayBuffer>) => void;

  constructor(options: PageVideoFrameCaptureOptions) {
    this.onJpegFrame = options.onJpegFrame;
    this.config = options.config ?? null;
  }

  configure(next: Partial<MossVideoCaptureConfig>): void {
    this.config = { ...this.config, ...next };
  }

  stop(): void {
    this.stopped = true;
  }

  emitFrame(bytes: Uint8Array<ArrayBuffer>): void {
    this.onJpegFrame(bytes);
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("LiveChatController", () => {
  function setupTest(overrides: {
    getTargetOrigin?: () => string;
    getTargetModel?: () => string;
    getTargetProviderType?: () => LiveProviderType;
    requestOrigins?: (origins: string[]) => Promise<{ ok: boolean; error?: string }>;
    sendRuntimeMessage?: (msg: any) => Promise<any>;
    startAudioCapture?: (opts: PageAudioCaptureOptions) => Promise<PageAudioCaptureSession>;
    startVideoCapture?: (opts: PageVideoFrameCaptureOptions) => PageVideoFrameCaptureSession;
    port?: FakePort;
    onSpeakingChange?: (speaking: boolean) => void;
    onInterruptStateChange?: (active: boolean) => void;
    getVideoContext?: () => MossLiveVideoContext | null;
    executeTool?: (call: MossLiveToolCall) => Promise<unknown> | unknown;
    subscribeVideoContextChanges?: (listener: () => void) => () => void;
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

    let lastVideoCapture: FakeVideoCapture | null = null;
    const startVideoCapture =
      overrides.startVideoCapture ||
      vi.fn((opts: PageVideoFrameCaptureOptions) => {
        lastVideoCapture = new FakeVideoCapture(opts);
        return lastVideoCapture;
      });

    const receivedTranscripts: MossLiveTranscriptEvent[] = [];

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
      onSpeakingChange: overrides.onSpeakingChange,
      showNotice,
      connectPort,
      sendRuntimeMessage,
      requestOrigins,
      startAudioCapture,
      startVideoCapture,
      onTranscript: (ev) => {
        receivedTranscripts.push(ev);
      },
      getTargetOrigin: overrides.getTargetOrigin,
      getTargetModel: overrides.getTargetModel,
      getTargetProviderType: overrides.getTargetProviderType,
      getVideoContext: overrides.getVideoContext,
      executeTool: overrides.executeTool,
      subscribeVideoContextChanges: overrides.subscribeVideoContextChanges
    });

    return {
      controller,
      liveButton,
      muteButton,
      onSpeakingChange: overrides.onSpeakingChange,
      showNotice,
      fakePort,
      connectPort,
      sendRuntimeMessage,
      requestOrigins,
      startAudioCapture,
      startVideoCapture,
      getAudioCapture: () => lastAudioCapture,
      getVideoCapture: () => lastVideoCapture,
      receivedTranscripts,
      isMergerDisposed: () => true
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
    expect(requestOrigins).toHaveBeenCalledWith([
      "https://api.mosi.cn",
      "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
    ]);

    return startPromise;
  });

  it("requests custom origin synchronously from getTargetOrigin without requesting default api.mosi.cn", async () => {
    const requestOrigins = vi.fn(async () => ({ ok: true }));
    const { controller } = setupTest({
      getTargetOrigin: () => "https://custom.live.mosi.cn:8080",
      requestOrigins
    });

    await controller.start();

    expect(requestOrigins).toHaveBeenCalledWith([
      "https://custom.live.mosi.cn:8080",
      "wss://custom.live.mosi.cn:8080/v1/realtime?model=moss-live-1.0"
    ]);
    expect(requestOrigins).not.toHaveBeenCalledWith(["https://api.mosi.cn"]);
  });

  it("requests generativelanguage.googleapis.com origins and posts gemini-live start action when target is gemini-live", async () => {
    const requestOrigins = vi.fn(async () => ({ ok: true }));
    const { controller, fakePort } = setupTest({
      getTargetProviderType: () => "gemini-live",
      getTargetOrigin: () => "https://generativelanguage.googleapis.com",
      getTargetModel: () => "gemini-3.1-flash-live-preview",
      requestOrigins,
      sendRuntimeMessage: async (msg: any) => {
        if (msg.type === "live-session-prepare") {
          return {
            ok: true,
            provider: {
              id: "gemini-live-1",
              type: "gemini-live",
              baseUrl: "https://generativelanguage.googleapis.com",
              model: "gemini-3.1-flash-live-preview"
            }
          };
        }
        return { ok: true };
      }
    });

    const ok = await controller.start();
    expect(ok).toBe(true);
    expect(requestOrigins).toHaveBeenCalledWith([
      "https://generativelanguage.googleapis.com",
      "wss://generativelanguage.googleapis.com"
    ]);
    expect(fakePort.postedMessages).toEqual([
      {
        action: "start",
        wsUrl:
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
        providerType: "gemini-live",
        model: "gemini-3.1-flash-live-preview",
        volume: 1
      }
    ]);
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

  it("handles interrupt with speaking_state and posts interrupt action without disconnecting", async () => {
    const onSpeakingChange = vi.fn();
    const { controller, fakePort } = setupTest({ onSpeakingChange });
    expect(controller.isSpeaking()).toBe(false);

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    expect(controller.getState()).toBe("connected");
    expect(controller.isSpeaking()).toBe(false);

    // AI starts speaking
    fakePort.simulateMessage({ type: "speaking_state", speaking: true });
    expect(onSpeakingChange).toHaveBeenCalledWith(true);
    expect(controller.isSpeaking()).toBe(true);

    // Click interrupt
    fakePort.postedMessages.length = 0;
    controller.interrupt();
    expect(fakePort.postedMessages).toContainEqual({ action: "interrupt" });
    expect(controller.isSpeaking()).toBe(false);
    expect(onSpeakingChange).toHaveBeenCalledWith(false);
    expect(controller.getState()).toBe("connected"); // Still connected!

    // When speaking resumes and then completes naturally
    fakePort.simulateMessage({ type: "speaking_state", speaking: true });
    expect(controller.isSpeaking()).toBe(true);
    fakePort.simulateMessage({ type: "speaking_state", speaking: false });
    expect(controller.isSpeaking()).toBe(false);

    await controller.stop();
    expect(controller.isSpeaking()).toBe(false);
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
      {
        action: "start",
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        providerType: "moss-live",
        model: "moss-live-1.0",
        volume: 1
      }
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

  it("starts video capture only after connection, forwards JPEG as base64, and blocks old-session frames", async () => {
    const { controller, fakePort, startVideoCapture, getVideoCapture } = setupTest();

    await controller.start();
    expect(startVideoCapture).not.toHaveBeenCalled();
    fakePort.simulateMessage({ type: "connected" });
    const firstCapture = getVideoCapture()!;
    expect(startVideoCapture).toHaveBeenCalledTimes(1);

    fakePort.postedMessages.length = 0;
    firstCapture.emitFrame(new Uint8Array([0xff, 0xd8, 7, 0xff, 0xd9]));
    expect(fakePort.postedMessages).toEqual([{ action: "video", jpegBase64: expect.any(String) }]);

    await controller.stop();
    expect(firstCapture.stopped).toBe(true);

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;
    firstCapture.emitFrame(new Uint8Array([1]));
    expect(fakePort.postedMessages).toHaveLength(0);

    getVideoCapture()!.emitFrame(new Uint8Array([2]));
    expect(fakePort.postedMessages).toEqual([{ action: "video", jpegBase64: expect.any(String) }]);
    await controller.stop();
  });

  it("applies low-bandwidth capture from start and reconfigures capture from media.configured, falling back once on error", async () => {
    const sendRuntimeMessage = vi.fn(async (msg: any) => {
      if (msg.type === "live-session-prepare") {
        return {
          ok: true,
          liveLowBandwidth: true,
          provider: {
            id: "moss-1",
            baseUrl: "https://api.mosi.cn",
            model: "moss-live-1.0"
          }
        };
      }
      return { ok: true };
    });
    const { controller, fakePort, showNotice, getVideoCapture } = setupTest({ sendRuntimeMessage });

    await controller.start();
    expect(fakePort.postedMessages).toContainEqual(
      expect.objectContaining({ action: "start", lowBandwidth: true })
    );
    fakePort.simulateMessage({ type: "connected" });

    const capture = getVideoCapture()!;
    expect(capture.config).toMatchObject({ maxLongSide: 384, jpegQuality: 0.5, intervalMs: 2000 });

    fakePort.simulateMessage({
      type: "video_configured",
      video: { maxLongSide: 400, jpegQuality: 0.55, intervalMs: 1500 }
    });
    expect(capture.config).toMatchObject({ maxLongSide: 400, jpegQuality: 0.55, intervalMs: 1500 });

    fakePort.simulateMessage({
      type: "video_configured",
      video: { maxLongSide: 512, jpegQuality: 0.75, intervalMs: 1000 },
      error: "low bandwidth unsupported"
    });
    fakePort.simulateMessage({
      type: "video_configured",
      video: { maxLongSide: 512, jpegQuality: 0.75, intervalMs: 1000 },
      error: "low bandwidth unsupported again"
    });
    expect(capture.config).toMatchObject({ maxLongSide: 512, jpegQuality: 0.75, intervalMs: 1000 });
    const fallbackNotices = showNotice.mock.calls.filter(([text]) =>
      String(text).includes("回退默认画质")
    );
    expect(fallbackNotices).toHaveLength(1);

    await controller.stop();
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

  it("shows web search progress and terminal states without ending the live session", async () => {
    const { controller, fakePort, showNotice } = setupTest();
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });

    fakePort.simulateMessage({
      type: "tool_status",
      event: { tool: "web_search", status: "searching", query: "最新财报" }
    });
    fakePort.simulateMessage({
      type: "tool_status",
      event: { tool: "web_search", status: "done", query: "最新财报", resultCount: 3 }
    });
    fakePort.simulateMessage({
      type: "tool_status",
      event: { tool: "web_search", status: "no_results", query: "不存在的事实" }
    });
    fakePort.simulateMessage({
      type: "tool_status",
      event: { tool: "web_search", status: "failed", query: "超时查询", error: "联网搜索超时" }
    });

    expect(showNotice).toHaveBeenNthCalledWith(1, "正在联网查证：最新财报", 35000);
    expect(showNotice).toHaveBeenNthCalledWith(2, "联网查证完成：最新财报（3 条结果）");
    expect(showNotice).toHaveBeenNthCalledWith(3, "联网查证无结果：不存在的事实", 6000);
    expect(showNotice).toHaveBeenNthCalledWith(4, "联网查证失败：超时查询：联网搜索超时", 6000);
    expect(controller.getState()).toBe("connected");
    await controller.stop();
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

describe("LiveChatController video context and page tools", () => {
  function setupContextTest(overrides: {
    getVideoContext?: () => MossLiveVideoContext | null;
    executeTool?: (call: MossLiveToolCall) => Promise<unknown> | unknown;
    subscribeVideoContextChanges?: (listener: () => void) => () => void;
    videoBackendTaskManager?: LiveVideoBackendTaskManager;
  }) {
    const liveButton = document.createElement("button");
    const fakePort = new FakePort();
    const controller = createLiveChatController({
      liveButton,
      connectPort: () => fakePort as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async (msg: any) => msg.type === "live-session-prepare"
        ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
        : { ok: true }) as any,
      startAudioCapture: async (options) => new FakeAudioCapture(options),
      getVideoContext: overrides.getVideoContext,
      executeTool: overrides.executeTool,
      subscribeVideoContextChanges: overrides.subscribeVideoContextChanges,
      videoBackendTaskManager: overrides.videoBackendTaskManager
    });
    return { controller, fakePort };
  }

  const initialContext: MossLiveVideoContext = {
    url: "https://www.bilibili.com/video/BV1test000000/",
    bvid: "BV1test000000",
    cid: "123",
    title: "旧视频",
    pageIndex: 1,
    pageCount: 1,
    pageTitle: "",
    chapters: []
  };

  it("invalidates context on SPA navigation, restores the settled clip, and unsubscribes on stop", async () => {
    let context: MossLiveVideoContext | null = initialContext;
    let contextListener: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const { controller, fakePort } = setupContextTest({
      getVideoContext: () => context,
      subscribeVideoContextChanges: (listener) => {
        contextListener = listener;
        return unsubscribe;
      }
    });

    await controller.start();
    expect(fakePort.postedMessages[0]).toEqual({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      providerType: "moss-live",
      model: "moss-live-1.0",
      volume: 1,
      videoContext: initialContext
    });
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;

    context = null;
    window.dispatchEvent(new Event("biliscript:urlchange"));
    expect(fakePort.postedMessages).toEqual([
      { action: "context_update", videoContext: null }
    ]);

    const nextContext = { ...initialContext, bvid: "BV1next000000", cid: "456", title: "新视频" };
    context = nextContext;
    contextListener!();
    expect(fakePort.postedMessages.at(-1)).toEqual({ action: "context_update", videoContext: nextContext });

    await controller.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("delivers the overview completed mid-session and ignores duplicate or late updates", async () => {
    const generatingOverview = {
      phase: "generating" as const,
      coverage: "none" as const,
      summary: "",
      chapters: [],
      quotes: [],
      statusText: "全片概览正在生成，尚未完成。"
    };
    const readyOverview = {
      phase: "ready" as const,
      coverage: "complete" as const,
      summary: "全片介绍实时语音链路。",
      chapters: [{ from: 0, to: 120, time: "0:00", title: "开场", summary: "为什么需要实时" }],
      quotes: [],
      statusText: ""
    };
    let context: MossLiveVideoContext | null = { ...initialContext, overview: generatingOverview };
    let contextListener: (() => void) | null = null;
    const { controller, fakePort } = setupContextTest({
      getVideoContext: () => context,
      subscribeVideoContextChanges: (listener) => {
        contextListener = listener;
        return () => {};
      }
    });

    await controller.start();
    expect((fakePort.postedMessages[0] as any).videoContext.overview).toEqual(generatingOverview);
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;

    context = { ...initialContext, overview: readyOverview };
    contextListener!();
    contextListener!();
    expect(fakePort.postedMessages).toEqual([
      { action: "context_update", videoContext: context }
    ]);

    await controller.stop();
    fakePort.postedMessages.length = 0;
    contextListener!();
    expect(fakePort.postedMessages).toHaveLength(0);
  });

  it("runs native delegations through the task manager and caps every callback at 2000 Unicode characters", async () => {
    const runTask = vi.fn<LiveVideoBackendTaskManager["runTask"]>(async (options) => {
      options.onSilentProgress("😀".repeat(2001));
      options.onSpokenResult("后台总结完成");
      return null;
    });
    const manager: LiveVideoBackendTaskManager = {
      runTask,
      cancelTask: vi.fn(() => true),
      cancelAllTasks: vi.fn()
    };
    const { controller, fakePort } = setupContextTest({ videoBackendTaskManager: manager });
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;

    fakePort.simulateMessage({
      type: "delegation_created",
      delegation: {
        delegationId: "del_001",
        objective: "总结全片",
        context: ["近期对话"],
        scope: "time_range",
        timeRange: { startSec: 12, endSec: 48 }
      }
    });
    await vi.waitFor(() => expect(runTask).toHaveBeenCalledTimes(1));

    const options = runTask.mock.calls[0][0];
    expect(options).toMatchObject({
      taskId: "del_001",
      objective: "总结全片",
      context: ["近期对话"],
      scope: "time_range",
      timeRange: { startSec: 12, endSec: 48 }
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(fakePort.postedMessages).toEqual([
      { action: "delegation_silent", delegationId: "del_001", content: "😀".repeat(2000) },
      {
        action: "delegation_result",
        delegationId: "del_001",
        status: "completed",
        content: "后台总结完成"
      }
    ]);
    await controller.stop();
  });

  it("maps delegation errors and applies server cancellation by task id", async () => {
    const runTask = vi.fn<LiveVideoBackendTaskManager["runTask"]>(async (options) => {
      if (options.taskId === "del_failed") options.onError?.("模型请求失败");
      return null;
    });
    const cancelTask = vi.fn(() => true);
    const manager: LiveVideoBackendTaskManager = {
      runTask,
      cancelTask,
      cancelAllTasks: vi.fn()
    };
    const { controller, fakePort } = setupContextTest({ videoBackendTaskManager: manager });
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;

    fakePort.simulateMessage({
      type: "delegation_created",
      delegation: { delegationId: "del_failed", objective: "检索细节", context: [] }
    });
    await vi.waitFor(() => expect(fakePort.postedMessages).toContainEqual({
      action: "delegation_result",
      delegationId: "del_failed",
      status: "failed",
      content: "模型请求失败"
    }));

    fakePort.simulateMessage({ type: "delegation_cancelled", delegationId: "del_failed" });
    expect(cancelTask).toHaveBeenCalledWith("del_failed");
    await controller.stop();
  });

  it("cancels all delegations on video identity changes but not overview-only refreshes", async () => {
    let context: MossLiveVideoContext | null = initialContext;
    let contextListener: (() => void) | null = null;
    const cancelAllTasks = vi.fn();
    const manager: LiveVideoBackendTaskManager = {
      runTask: vi.fn(async () => null),
      cancelTask: vi.fn(() => true),
      cancelAllTasks
    };
    const { controller } = setupContextTest({
      getVideoContext: () => context,
      subscribeVideoContextChanges: (listener) => {
        contextListener = listener;
        return () => {};
      },
      videoBackendTaskManager: manager
    });
    await controller.start();
    cancelAllTasks.mockClear();

    context = {
      ...initialContext,
      overview: {
        phase: "ready",
        coverage: "complete",
        summary: "概览已就绪",
        chapters: [],
        quotes: [],
        statusText: ""
      }
    };
    contextListener!();
    expect(cancelAllTasks).not.toHaveBeenCalled();

    context = { ...initialContext, cid: "456", pageIndex: 2 };
    contextListener!();
    expect(cancelAllTasks).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it("returns tool failures to offscreen without tearing down the connected session", async () => {
    const executeTool = vi.fn(async () => {
      throw new Error("subtitle unavailable");
    });
    const { controller, fakePort } = setupContextTest({ executeTool });
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    const call: MossLiveToolCall = {
      callId: "call-1",
      name: "search_video_subtitles",
      arguments: { query: "字幕" }
    };
    fakePort.simulateMessage({ type: "tool_call", call });

    await vi.waitFor(() => {
      expect(fakePort.postedMessages).toContainEqual({
        action: "tool_result",
        callId: "call-1",
        result: { ok: false, error: "页面工具执行失败：subtitle unavailable" }
      });
    });
    expect(executeTool).toHaveBeenCalledWith(call);
    expect(controller.getState()).toBe("connected");
    expect(fakePort.disconnected).toBe(false);
  });

  it("does not execute late player controls after hangup", async () => {
    const executeTool = vi.fn();
    const { controller, fakePort } = setupContextTest({ executeTool });
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    await controller.stop();
    fakePort.postedMessages.length = 0;

    fakePort.simulateMessage({
      type: "tool_call",
      call: {
        callId: "late-player",
        name: "control_bilibili_player",
        arguments: { command: "seek", time: 40 }
      }
    });
    await Promise.resolve();
    expect(executeTool).not.toHaveBeenCalled();
    expect(fakePort.postedMessages).toHaveLength(0);
  });

  it("forwards mic VAD and video audio status callbacks and provides getters", async () => {
    let capturedOptions: any = null;
    let fakeCapture: any = null;
    const vadStates: boolean[] = [];
    const videoStatuses: string[] = [];
    const fakePort = new FakePort();

    const controller = createLiveChatController({
      connectPort: () => fakePort as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async (msg: any) => msg.type === "live-session-prepare"
        ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
        : { ok: true }) as any,
      startAudioCapture: async (opts) => {
        capturedOptions = opts;
        fakeCapture = new FakeAudioCapture(opts);
        return fakeCapture;
      },
      startVideoCapture: () => new FakeVideoCapture({ onJpegFrame: () => {} }),
      onVadStateChange: (active) => vadStates.push(active),
      onVideoAudioStatusChange: (status) => videoStatuses.push(status)
    });

    expect(controller.getVideoAudioStatus()).toBe("未开启");
    expect(controller.isMicVadActive()).toBe(false);

    await controller.start();
    fakePort.simulateMessage({ type: "connected" });

    expect(controller.isSharingVideoAudio()).toBe(false);
    expect(controller.getVideoAudioStatus()).toBe("未开启");
    controller.setShareVideoAudio(true);
    expect(controller.getVideoAudioStatus()).toBe("已获取音轨");

    // Simulate VAD change from capture
    capturedOptions?.onVadStateChange?.(true);
    expect(vadStates).toEqual([true]);

    // Simulate video audio status change from capture
    capturedOptions?.onVideoAudioStatusChange?.("视频已静音");
    expect(videoStatuses).toEqual(["视频已静音"]);

    // Test video audio toggle
    controller.setShareVideoAudio(false);
    expect(fakeCapture.videoAudioShared).toBe(false);

    await controller.stop();
  });

  describe("MOSS session_id persistence, auto-reconnect notice and close diagnostics", () => {
    it("saves session_id on session_attached and carries it on subsequent start, clears on stop()", async () => {
      const fakePort = new FakePort();
      const showNotice = vi.fn();
      const controller = createLiveChatController({
        connectPort: () => fakePort as any,
        requestOrigins: async () => ({ ok: true }),
        sendRuntimeMessage: (async (msg: any) => msg.type === "live-session-prepare"
          ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
          : { ok: true }) as any,
        startAudioCapture: async (opts) => new FakeAudioCapture(opts),
        startVideoCapture: () => new FakeVideoCapture({ onJpegFrame: () => {} }),
        showNotice
      });

      await controller.start();
      expect(controller.getSavedSessionId?.()).toBeNull();

      // Receive session_attached from server
      fakePort.simulateMessage({ type: "session_attached", sessionId: "sess-moss-persist-99" });
      expect(controller.getSavedSessionId?.()).toBe("sess-moss-persist-99");

      // Stop session (user actively ends companion)
      await controller.stop();
      expect(controller.getSavedSessionId?.()).toBeNull();
    });

    it("displays reconnecting Chinese notice with WebSocket code and reason", async () => {
      const fakePort = new FakePort();
      const showNotice = vi.fn();
      const onReconnecting = vi.fn();
      const liveBtn = document.createElement("button");
      const controller = createLiveChatController({
        liveButton: liveBtn,
        connectPort: () => fakePort as any,
        requestOrigins: async () => ({ ok: true }),
        sendRuntimeMessage: (async (msg: any) => msg.type === "live-session-prepare"
          ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
          : { ok: true }) as any,
        startAudioCapture: async (opts) => new FakeAudioCapture(opts),
        startVideoCapture: () => new FakeVideoCapture({ onJpegFrame: () => {} }),
        showNotice,
        onReconnecting
      });

      await controller.start();
      fakePort.simulateMessage({ type: "connected" });
      expect(controller.getState()).toBe("connected");
      expect(controller.isReconnecting?.()).toBe(false);

      // Port emits reconnecting event
      fakePort.simulateMessage({
        type: "reconnecting",
        attempt: 1,
        maxAttempts: 3,
        code: 1006,
        reason: "Connection reset",
        error: "Relay 连接中断"
      });

      expect(controller.getState()).toBe("connecting");
      expect(controller.isReconnecting?.()).toBe(true);
      expect(onReconnecting).toHaveBeenCalledWith({
        attempt: 1,
        maxAttempts: 3,
        code: 1006,
        reason: "Connection reset",
        error: "Relay 连接中断",
        notice: expect.stringContaining("第 1/3 次")
      });
      expect(showNotice).toHaveBeenCalledWith(
        expect.stringContaining("关闭码: 1006"),
        6000
      );
      expect(showNotice).toHaveBeenCalledWith(
        expect.stringContaining("原因: Connection reset"),
        6000
      );
      expect(showNotice).toHaveBeenCalledWith(
        expect.stringContaining("错误详情: Relay 连接中断"),
        6000
      );
      expect(showNotice).toHaveBeenCalledWith(
        expect.stringContaining("第 1/3 次"),
        6000
      );

      // Reset upon connected
      fakePort.simulateMessage({ type: "connected" });
      expect(controller.getState()).toBe("connected");
      expect(controller.isReconnecting?.()).toBe(false);
    });

    it("displays failure diagnostics with close code, reason, and relay error on closed message", async () => {
      const fakePort = new FakePort();
      const showNotice = vi.fn();
      const controller = createLiveChatController({
        connectPort: () => fakePort as any,
        requestOrigins: async () => ({ ok: true }),
        sendRuntimeMessage: (async (msg: any) => msg.type === "live-session-prepare"
          ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
          : { ok: true }) as any,
        startAudioCapture: async (opts) => new FakeAudioCapture(opts),
        startVideoCapture: () => new FakeVideoCapture({ onJpegFrame: () => {} }),
        showNotice
      });

      await controller.start();
      fakePort.simulateMessage({ type: "connected" });

      fakePort.simulateMessage({
        type: "closed",
        code: 1006,
        reason: "Relay timeout",
        error: "已达最大重连次数 (3 次)"
      });

      expect(controller.getState()).toBe("failure");
      expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("关闭码: 1006"));
      expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("原因: Relay timeout"));
      expect(showNotice).toHaveBeenCalledWith(expect.stringContaining("已达最大重连次数 (3 次)"));
    });
  });

});

describe("LiveChatController 音色选择", () => {
  function installLiveStorage(voiceId: string) {
    const localStore: Record<string, unknown> = { liveProviderKeys: { live_moss: "sk-moss" } };
    const syncStore: Record<string, unknown> = {
      activeLiveProviderId: "live_moss",
      liveProviders: [
        {
          id: "live_moss",
          presetId: "moss-live",
          name: "MOSS Live",
          type: "moss-live",
          baseUrl: "https://api.mosi.cn",
          model: "moss-live-1.0",
          enabled: true,
          ...(voiceId ? { voiceId } : {})
        }
      ]
    };
    const pick = (store: Record<string, unknown>, keys: unknown): Record<string, unknown> => {
      const names = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(store);
      const out: Record<string, unknown> = {};
      for (const key of names) {
        if (key in store) out[key] = store[key];
      }
      return out;
    };
    vi.stubGlobal("chrome", {
      storage: {
        sync: {
          get: vi.fn(async (keys: unknown) => pick(syncStore, keys)),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(syncStore, items))
        },
        local: {
          get: vi.fn(async (keys: unknown) => pick(localStore, keys)),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(localStore, items)),
          remove: vi.fn(async (key: string) => {
            delete localStore[key];
          })
        }
      }
    });
    return { localStore, syncStore };
  }

  function setupVoiceController() {
    const fakePort = new FakePort();
    const showNotice = vi.fn();
    const controller = createLiveChatController({
      liveButton: document.createElement("button"),
      showNotice,
      connectPort: () => fakePort as any,
      requestOrigins: async () => ({ ok: true }),
      sendRuntimeMessage: (async (msg: any) =>
        msg.type === "live-session-prepare"
          ? { ok: true, provider: { baseUrl: "https://api.mosi.cn", model: "moss-live-1.0" } }
          : { ok: true }) as any,
      startAudioCapture: async (options) => new FakeAudioCapture(options)
    });
    return { controller, fakePort, showNotice };
  }

  it("把 provider 的音色带进会话启动消息", async () => {
    installLiveStorage("voice-1");
    const { controller, fakePort } = setupVoiceController();
    await controller.refreshTarget();
    await controller.start();

    expect(fakePort.postedMessages[0]).toMatchObject({
      action: "start",
      voiceId: "voice-1"
    });
  });

  it("通话中改音色直接向 offscreen 下发 change_voice（下一轮回答生效）", async () => {
    const { syncStore } = installLiveStorage("voice-1");
    const { controller, fakePort } = setupVoiceController();
    await controller.refreshTarget();
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });
    fakePort.postedMessages.length = 0;

    syncStore.liveProviders = [
      { ...(syncStore.liveProviders as any[])[0], voiceId: "voice-2" }
    ];
    await controller.refreshTarget();

    expect(fakePort.postedMessages).toEqual([{ action: "change_voice", voiceId: "voice-2" }]);
  });

  it("音色失效时回退默认音色、清掉选择并留下一次性设置提示", async () => {
    const { localStore, syncStore } = installLiveStorage("deleted-voice");
    const { controller, fakePort, showNotice } = setupVoiceController();
    await controller.refreshTarget();
    await controller.start();
    fakePort.simulateMessage({ type: "connected" });

    fakePort.simulateMessage({ type: "voice_fallback", voiceId: "deleted-voice" });

    expect(showNotice).toHaveBeenCalledWith("所选音色已不可用，伴看已回退默认音色", 6000);
    await vi.waitFor(() => {
      expect(localStore.liveVoiceFallbackNotice).toMatchObject({
        providerId: "live_moss",
        voiceId: "deleted-voice"
      });
    });
    await vi.waitFor(() => {
      expect((syncStore.liveProviders as Array<{ voiceId?: string }>)[0]?.voiceId).toBeUndefined();
    });
  });
});
