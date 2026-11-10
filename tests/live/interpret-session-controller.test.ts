import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createInterpretSessionController } from "../../extension/live/interpret-session-controller.js";
import type { VideoAudioCaptureSession } from "../../extension/live/page-media-capture.js";

class FakePort {
  postedMessages: any[] = [];
  messageListeners: ((msg: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];
  disconnected = false;

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
    for (const fn of this.disconnectListeners) fn();
  }

  simulateMessage(msg: any) {
    for (const fn of this.messageListeners) fn(msg);
  }
}

beforeEach(() => {
  resetModuleState();
});

describe("InterpretSessionController", () => {
  function setup(overrides: {
    sendRuntimeMessage?: (msg: any) => Promise<any>;
    requestOrigins?: (origins: string[]) => Promise<{ ok: boolean; error?: string }>;
    startAudioCapture?: () => VideoAudioCaptureSession;
  } = {}) {
    const video = document.createElement("video");
    const port = new FakePort();
    const audioCapture: VideoAudioCaptureSession = {
      getVideoAudioStatus: () => "已获取音轨",
      stop: vi.fn()
    };
    const showNotice = vi.fn();
    const onTranscript = vi.fn();
    const clearSubtitles = vi.fn();
    const sendRuntimeMessage = overrides.sendRuntimeMessage || vi.fn(async (msg: any) => {
      if (msg.type === "live-session-prepare") {
        return {
          ok: true,
          provider: {
            id: "moss-1",
            type: "moss-live",
            baseUrl: "https://api.mosi.cn",
            model: "moss-live-1.0"
          }
        };
      }
      return { ok: true };
    });
    const requestOrigins = overrides.requestOrigins || vi.fn(async () => ({ ok: true }));
    const startAudioCapture = overrides.startAudioCapture || vi.fn(() => audioCapture);

    const controller = createInterpretSessionController({
      getVideoElement: () => video,
      getTargetLang: () => "en",
      connectPort: () => port as any,
      sendRuntimeMessage,
      requestOrigins,
      startAudioCapture,
      showNotice,
      onTranscript,
      clearSubtitles
    });

    return {
      controller,
      video,
      port,
      audioCapture,
      showNotice,
      onTranscript,
      clearSubtitles,
      sendRuntimeMessage,
      requestOrigins,
      startAudioCapture
    };
  }

  it("手动启动时使用独立 interpret 通道并推送目标语言，不自动连接", async () => {
    const { controller, port, requestOrigins, sendRuntimeMessage, startAudioCapture } = setup();

    expect(controller.getState()).toBe("idle");
    expect(port.postedMessages).toEqual([]);

    expect(await controller.start()).toBe(true);
    expect(controller.getState()).toBe("connecting");
    expect(requestOrigins).toHaveBeenCalledWith([
      "https://api.mosi.cn",
      "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
    ]);
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      type: "live-session-prepare",
      sessionId: expect.stringMatching(/^interpret-/),
      channel: "interpret"
    });
    expect(startAudioCapture).toHaveBeenCalledTimes(1);
    expect(port.postedMessages).toEqual([{
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=en"
    }]);
  });

  it("1013 或其他启动失败时回到关闭态、释放采集并如实提示", async () => {
    const { controller, port, audioCapture, showNotice, sendRuntimeMessage, clearSubtitles } = setup();

    await controller.start();
    port.simulateMessage({
      type: "error",
      code: 1013,
      reason: "Session limit",
      error: "同声传译连接被服务端关闭（关闭码: 1013，原因: Session limit）"
    });
    await Promise.resolve();

    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
    expect(port.disconnected).toBe(true);
    expect(clearSubtitles).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith(
      expect.stringContaining("1013"),
      6000
    );
    expect(showNotice).toHaveBeenCalledWith(
      expect.stringContaining("Session limit"),
      6000
    );
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      type: "live-session-cleanup",
      sessionId: expect.stringMatching(/^interpret-/),
      channel: "interpret"
    });
  });

  it("远端异常关闭时停止采集、回到关闭态并保留关闭原因", async () => {
    const { controller, port, audioCapture, showNotice } = setup();
    await controller.start();
    port.simulateMessage({ type: "connected" });

    port.simulateMessage({ type: "closed", code: 1006, reason: "connection lost" });

    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith("同传连接已关闭（1006）：connection lost", 6000);
  });

  it("端口消息发送失败时只提示原始错误一次，并忽略迟到的端口事件", async () => {
    const { controller, port, audioCapture, showNotice, sendRuntimeMessage, clearSubtitles } = setup();
    port.postMessage = () => {
      throw new Error("端口发送失败");
    };

    expect(await controller.start()).toBe(false);
    port.simulateMessage({ type: "connected" });

    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
    expect(clearSubtitles).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith("端口发送失败", 6000);
    expect(sendRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(sendRuntimeMessage).toHaveBeenCalledWith({
      type: "live-session-cleanup",
      sessionId: expect.stringMatching(/^interpret-/),
      channel: "interpret"
    });
  });

  it("后台端口意外断开时回到关闭态并提示", async () => {
    const { controller, port, audioCapture, showNotice } = setup();
    await controller.start();

    port.disconnect();

    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
    expect(showNotice).toHaveBeenCalledWith("同传后台通道已断开", 6000);
  });

  it("暂停超过 5 分钟自动关闭，恢复播放会重置计时", async () => {
    vi.useFakeTimers();
    const { controller, video, port, audioCapture, showNotice } = setup();
    let paused = false;
    Object.defineProperty(video, "paused", { configurable: true, get: () => paused });

    await controller.start();
    port.simulateMessage({ type: "connected", sessionId: "server-1" });
    expect(controller.getState()).toBe("connected");

    paused = true;
    video.dispatchEvent(new Event("pause"));
    await vi.advanceTimersByTimeAsync(299_000);
    expect(controller.getState()).toBe("connected");

    paused = false;
    video.dispatchEvent(new Event("play"));
    paused = true;
    video.dispatchEvent(new Event("pause"));
    await vi.advanceTimersByTimeAsync(299_000);
    expect(controller.getState()).toBe("connected");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
    expect(port.postedMessages).toContainEqual({ action: "stop" });
    expect(showNotice).toHaveBeenCalledWith("视频暂停超过 5 分钟，实时翻译已自动关闭", 6000);
    vi.useRealTimers();
  });

  it("seek 立即清空当前字幕，之后继续呈现新回合", async () => {
    const { controller, video, port, clearSubtitles, onTranscript } = setup();
    await controller.start();
    port.simulateMessage({ type: "connected" });
    const first = { kind: "input.updated", text: "before seek", turn: "turn-1" } as const;
    const second = { kind: "input.updated", text: "after seek", turn: "turn-2" } as const;

    port.simulateMessage({ type: "transcript", event: first });
    video.dispatchEvent(new Event("seeking"));
    port.simulateMessage({ type: "transcript", event: second });

    expect(onTranscript).toHaveBeenNthCalledWith(1, first);
    expect(clearSubtitles).toHaveBeenCalledTimes(1);
    expect(onTranscript).toHaveBeenNthCalledWith(2, second);
  });

  it("阅读模式 URL 改写不关闭同传，真正换片才关闭", async () => {
    const { controller, port, audioCapture } = setup();
    await controller.start();
    port.simulateMessage({ type: "connected" });

    history.replaceState({}, "", "/video/BV1test000000/?biliscript_reader=1");
    window.dispatchEvent(new Event("biliscript:urlchange"));
    expect(controller.getState()).toBe("connected");

    history.replaceState({}, "", "/video/BV1test999999/");
    window.dispatchEvent(new Event("biliscript:urlchange"));
    await Promise.resolve();

    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
  });

  it("页面销毁会关闭会话并清理字幕", async () => {
    const { controller, port, clearSubtitles, audioCapture } = setup();
    await controller.start();
    port.simulateMessage({ type: "connected" });

    controller.dispose();

    expect(controller.getState()).toBe("idle");
    expect(audioCapture.stop).toHaveBeenCalledTimes(1);
    expect(clearSubtitles).toHaveBeenCalledTimes(1);
  });

  it("沿用伴看平台选择检查 MOSS Key，并给出不可用原因", async () => {
    const { controller } = setup();

    await controller.refreshAvailability();
    expect(controller.getAvailability()).toEqual({
      ok: false,
      error: "未配置 MOSS-LIVE 平台，请先在设置中添加平台并填写 API Key"
    });

    await chrome.storage.sync.set({
      activeLiveProviderId: "moss-1",
      liveProviders: [{
        id: "moss-1",
        presetId: "moss-live",
        type: "moss-live",
        name: "MOSS",
        baseUrl: "https://api.mosi.cn",
        model: "moss-live-1.0",
        enabled: true
      }]
    });
    await controller.refreshAvailability();
    expect(controller.getAvailability()).toEqual({
      ok: false,
      error: "未配置 MOSS-LIVE 密钥，请先在设置中填写 API Key"
    });

    await chrome.storage.local.set({ liveProviderKeys: { "moss-1": "secret" } });
    await controller.refreshAvailability();
    expect(controller.getAvailability()).toEqual({ ok: true });
  });
});
