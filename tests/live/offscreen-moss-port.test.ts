// tests/live/offscreen-moss-port.test.ts
// Offscreen MOSS-LIVE 端口管理行为、音频/静音转发与异步加载竞态回归测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  attachMossLivePort,
  type MossLiveClientFactory,
  type MossLiveClientInstance
} from "../../extension/live/offscreen-moss-port.js";
import { encodeBase64Bytes } from "../../extension/live/moss-live-protocol.js";

class FakePort {
  disconnected = false;
  messageListeners: ((msg: any) => void)[] = [];
  disconnectListeners: (() => void)[] = [];
  postedMessages: any[] = [];

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

  simulateMessage(msg: any) {
    for (const fn of this.messageListeners) {
      fn(msg);
    }
  }

  disconnect() {
    this.disconnected = true;
    for (const fn of this.disconnectListeners) {
      fn();
    }
  }
}

class FakeMossClient implements MossLiveClientInstance {
  connected = false;
  closed = false;
  options: any;
  receivedAudioFrames: Uint8Array[] = [];
  receivedVideoFrames: Uint8Array[] = [];
  micStates: boolean[] = [];
  videoContexts: unknown[] = [];
  toolResults: unknown[] = [];

  constructor(options: any) {
    this.options = options;
  }

  connect() {
    this.connected = true;
  }

  close() {
    this.closed = true;
    this.connected = false;
  }

  sendAudioPcm(pcmBuffer: ArrayBufferLike): boolean {
    this.receivedAudioFrames.push(new Uint8Array(pcmBuffer));
    return true;
  }

  sendVideoJpeg(jpegBuffer: ArrayBufferLike): boolean {
    this.receivedVideoFrames.push(new Uint8Array(jpegBuffer));
    return true;
  }

  setMicEnabled(enabled: boolean): void {
    this.micStates.push(enabled);
  }

  updateVideoContext(context: unknown): void {
    this.videoContexts.push(context);
  }

  sendToolResult(callId: string, result: unknown): boolean {
    this.toolResults.push({ callId, result });
    return true;
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("attachMossLivePort", () => {
  it("normal lifecycle: start creates client, calls connect, and relays client events + audio/mic/transcript to/from port", async () => {
    const port = new FakePort();
    let createdClient: FakeMossClient | null = null;
    const clientFactory: MossLiveClientFactory = vi.fn((opts) => {
      createdClient = new FakeMossClient(opts);
      return createdClient;
    });

    attachMossLivePort(port as any, {
      loadClient: async () => clientFactory
    });

    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    // Allow promise microtasks to run
    await Promise.resolve();
    await Promise.resolve();

    expect(clientFactory).toHaveBeenCalledTimes(1);
    expect(createdClient).not.toBeNull();
    expect(createdClient!.connected).toBe(true);

    // Relays client events to port
    createdClient!.options.onConnected();
    expect(port.postedMessages).toContainEqual({ type: "connected" });

    // Relays transcript events to port
    createdClient!.options.onTranscript?.({ kind: "input.updated", text: "正在提问" });
    expect(port.postedMessages).toContainEqual({
      type: "transcript",
      event: { kind: "input.updated", text: "正在提问" }
    });

    createdClient!.options.onToolStatus?.({
      tool: "web_search",
      status: "searching",
      query: "最新财报"
    });
    expect(port.postedMessages).toContainEqual({
      type: "tool_status",
      event: { tool: "web_search", status: "searching", query: "最新财报" }
    });

    // Relays base64 audio from port to client.sendAudioPcm
    const samplePcm = new Uint8Array([1, 2, 3, 4]);
    port.simulateMessage({
      action: "audio",
      pcmBase64: encodeBase64Bytes(samplePcm)
    });
    expect(createdClient!.receivedAudioFrames).toHaveLength(1);
    expect(Array.from(createdClient!.receivedAudioFrames[0])).toEqual([1, 2, 3, 4]);

    const sampleJpeg = new Uint8Array([0xff, 0xd8, 5, 6, 0xff, 0xd9]);
    port.simulateMessage({
      action: "video",
      jpegBase64: encodeBase64Bytes(sampleJpeg)
    });
    expect(createdClient!.receivedVideoFrames).toHaveLength(1);
    expect(Array.from(createdClient!.receivedVideoFrames[0])).toEqual(Array.from(sampleJpeg));

    // Relays mic_state from port to client.setMicEnabled
    port.simulateMessage({ action: "mic_state", enabled: false });
    expect(createdClient!.micStates).toEqual([false]);

    // Stop cleans up client and notifies port
    const staleOptions = createdClient!.options;
    port.simulateMessage({ action: "stop" });
    expect(createdClient!.closed).toBe(true);
    expect(port.postedMessages).toContainEqual({ type: "closed" });

    // Late transcript and tool status after stop are ignored
    const countBefore = port.postedMessages.length;
    staleOptions.onTranscript?.({ kind: "output.done", text: "迟到消息", runId: "r1", turnId: "t1" });
    staleOptions.onToolStatus?.({ tool: "web_search", status: "done", query: "迟到查询" });
    expect(port.postedMessages).toHaveLength(countBefore);
  });

  it("relays duck transitions and releases once on stop", async () => {
    const port = new FakePort();
    let client: FakeMossClient | null = null;
    attachMossLivePort(port as any, {
      loadClient: async () => (options) => {
        client = new FakeMossClient(options);
        return client;
      }
    });
    port.simulateMessage({ action: "start" });
    await Promise.resolve();
    await Promise.resolve();

    client!.options.onDuckVideo(true);
    client!.options.onDuckVideo(true);
    expect(port.postedMessages.filter((message) => message.type === "duck_video")).toEqual([
      { type: "duck_video", active: true }
    ]);

    port.simulateMessage({ action: "stop" });
    expect(port.postedMessages.filter((message) => message.type === "duck_video")).toEqual([
      { type: "duck_video", active: true },
      { type: "duck_video", active: false }
    ]);
  });

  it("regression: when stop() occurs while loadClient() is pending, continuation creates no socket", async () => {
    const port = new FakePort();
    let resolveLoader!: (factory: MossLiveClientFactory) => void;
    const loadPromise = new Promise<MossLiveClientFactory>((resolve) => {
      resolveLoader = resolve;
    });

    let clientCreated = false;
    const clientFactory: MossLiveClientFactory = vi.fn((opts) => {
      clientCreated = true;
      return new FakeMossClient(opts);
    });

    attachMossLivePort(port as any, {
      loadClient: () => loadPromise
    });

    // 1. Port receives start, but loader is pending
    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    // 2. Before loader finishes, user triggers stop
    port.simulateMessage({ action: "stop" });
    expect(port.postedMessages).toContainEqual({ type: "closed" });

    // 3. Now loader completes
    resolveLoader(clientFactory);
    await Promise.resolve();
    await Promise.resolve();

    // 关键断言：因为代际已失效且已处于 stop 态，绝不得创建客户端或调用 connect
    expect(clientFactory).not.toHaveBeenCalled();
    expect(clientCreated).toBe(false);
  });

  it("regression: when port disconnects while loadClient() is pending, continuation creates no socket", async () => {
    const port = new FakePort();
    let resolveLoader!: (factory: MossLiveClientFactory) => void;
    const loadPromise = new Promise<MossLiveClientFactory>((resolve) => {
      resolveLoader = resolve;
    });

    let clientCreated = false;
    const clientFactory: MossLiveClientFactory = vi.fn((opts) => {
      clientCreated = true;
      return new FakeMossClient(opts);
    });

    attachMossLivePort(port as any, {
      loadClient: () => loadPromise
    });

    // 1. Port receives start, but loader is pending
    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    // 2. Before loader finishes, port disconnects
    port.disconnect();

    // 3. Now loader completes
    resolveLoader(clientFactory);
    await Promise.resolve();
    await Promise.resolve();

    // 关键断言：端口已断开，disposed 守卫必须拦截，不得连接任何 socket
    expect(clientFactory).not.toHaveBeenCalled();
    expect(clientCreated).toBe(false);
  });
});


describe("attachMossLivePort subtitle tool bridge", () => {
  async function setup() {
    const port = new FakePort();
    let client: FakeMossClient | null = null;
    attachMossLivePort(port as any, {
      loadClient: async () => (options) => {
        client = new FakeMossClient(options);
        return client;
      }
    });
    port.simulateMessage({ action: "start", videoContext: { bvid: "BV1", cid: "1" } });
    await Promise.resolve();
    await Promise.resolve();
    return { port, client: client! };
  }

  it("relays context updates and tool call/result in both directions", async () => {
    const { port, client } = await setup();
    expect(client.options.videoContext).toEqual({ bvid: "BV1", cid: "1" });

    const nextContext = { bvid: "BV2", cid: "2" };
    port.simulateMessage({ action: "context_update", videoContext: nextContext });
    expect(client.videoContexts).toEqual([nextContext]);

    const call = { callId: "call-1", name: "search_video_subtitles", arguments: { query: "字幕" } };
    client.options.onToolCall(call);
    expect(port.postedMessages).toContainEqual({ type: "tool_call", call });

    port.simulateMessage({ action: "tool_result", callId: "call-1", result: { ok: true, items: [] } });
    expect(client.toolResults).toEqual([{ callId: "call-1", result: { ok: true, items: [] } }]);
    expect(client.closed).toBe(false);
  });

  it("returns a timeout error without closing the session when content never answers", async () => {
    vi.useFakeTimers();
    try {
      const { client } = await setup();
      client.options.onToolCall({ callId: "call-timeout", name: "search_video_subtitles", arguments: {} });
      vi.advanceTimersByTime(10000);
      expect(client.toolResults).toEqual([{
        callId: "call-timeout",
        result: { ok: false, error: "页面工具执行超时，请稍后重试" }
      }]);
      expect(client.closed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
