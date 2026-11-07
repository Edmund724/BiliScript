// tests/live/offscreen-moss-port.test.ts
// Offscreen MOSS-LIVE 端口懒加载薄壳、代际竞态保护与客户端动作/事件端到端转发测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  attachMossLivePort,
  resetActiveLiveSessionForTests,
  type MossLiveClientFactory,
  type MossLiveClientInstance
} from "../../extension/live/offscreen-moss-port.js";
import { OffscreenMossLiveClient } from "../../extension/live/offscreen-moss-client.js";
import {
  MossBinaryTag,
  encodeBase64Bytes,
  type MossLiveClientAction,
  type MossLiveServerEvent
} from "../../extension/live/moss-live-protocol.js";

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

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: ((error: any) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sentData: any[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: any) {
    this.sentData.push(data);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: any) {
    this.onmessage?.({ data });
  }
}

class FakeMossSession implements MossLiveClientInstance {
  closed = false;
  actions: MossLiveClientAction[] = [];
  readonly onEvent: (event: MossLiveServerEvent) => void;

  constructor(options: { onEvent: (event: MossLiveServerEvent) => void }) {
    this.onEvent = options.onEvent;
  }

  handleAction(action: MossLiveClientAction): void {
    this.actions.push(action);
    if (action.action === "stop") {
      this.close();
      this.onEvent({ type: "closed" });
    }
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  resetModuleState();
  resetActiveLiveSessionForTests();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("attachMossLivePort", () => {
  it("normal lifecycle: start loads client, forwards actions, and relays server events to port", async () => {
    const port = new FakePort();
    let createdClient: OffscreenMossLiveClient | null = null;

    attachMossLivePort(port as any, {
      loadClient: async () => (opts) => {
        createdClient = new OffscreenMossLiveClient(opts);
        return createdClient;
      }
    });

    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });

    await Promise.resolve();
    await Promise.resolve();

    expect(createdClient).not.toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    ws.simulateMessage(JSON.stringify({ action: "session.updated", data: { error: "" } }));

    expect(port.postedMessages).toContainEqual({ type: "connecting" });
    expect(port.postedMessages).toContainEqual({ type: "connected" });

    ws.simulateMessage(
      JSON.stringify({ action: "input.transcript.updated", data: { text: "正在提问" } })
    );
    expect(port.postedMessages).toContainEqual({
      type: "transcript",
      event: { kind: "input.updated", text: "正在提问" }
    });

    ws.sentData.length = 0;
    const samplePcm = new Uint8Array([1, 2, 3, 4]);
    port.simulateMessage({
      action: "audio",
      pcmBase64: encodeBase64Bytes(samplePcm)
    });
    expect(ws.sentData).toHaveLength(1);
    expect(Array.from(ws.sentData[0] as Uint8Array)).toEqual([MossBinaryTag.AudioPcm, 1, 2, 3, 4]);

    const sampleJpeg = new Uint8Array([0xff, 0xd8, 5, 6, 0xff, 0xd9]);
    port.simulateMessage({
      action: "video",
      jpegBase64: encodeBase64Bytes(sampleJpeg)
    });
    expect(ws.sentData).toHaveLength(2);
    expect(Array.from(ws.sentData[1] as Uint8Array)).toEqual([
      MossBinaryTag.ScreenJpeg,
      0xff,
      0xd8,
      5,
      6,
      0xff,
      0xd9
    ]);

    port.simulateMessage({ action: "mic_state", enabled: false });
    expect(JSON.parse(ws.sentData[2])).toEqual({ action: "mic_state", enabled: false });

    port.simulateMessage({ action: "stop" });
    expect(createdClient!.getState()).toBe("idle");
    expect(port.postedMessages).toContainEqual({ type: "closed" });
  });

  it("relays duck transitions from client and releases once on stop", async () => {
    const port = new FakePort();
    attachMossLivePort(port as any, {
      loadClient: async () => (options) => new OffscreenMossLiveClient(options)
    });
    port.simulateMessage({ action: "start" });
    await Promise.resolve();
    await Promise.resolve();

    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

    ws.simulateMessage(JSON.stringify({ action: "input.transcript.updated", data: { text: "你好" } }));
    ws.simulateMessage(JSON.stringify({ action: "input.transcript.done", data: { text: "你好" } }));
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
      return new FakeMossSession(opts);
    });

    attachMossLivePort(port as any, {
      loadClient: () => loadPromise
    });

    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });
    port.simulateMessage({ action: "stop" });
    expect(port.postedMessages).toContainEqual({ type: "closed" });

    resolveLoader(clientFactory);
    await Promise.resolve();
    await Promise.resolve();

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
      return new FakeMossSession(opts);
    });

    attachMossLivePort(port as any, {
      loadClient: () => loadPromise
    });

    port.simulateMessage({ action: "start", wsUrl: "wss://api.mosi.cn/v1/realtime" });
    port.disconnect();

    resolveLoader(clientFactory);
    await Promise.resolve();
    await Promise.resolve();

    expect(clientFactory).not.toHaveBeenCalled();
    expect(clientCreated).toBe(false);
  });

  it("dispatches by providerType ('gemini-live' vs 'moss-live') and forwards providerType and model on start", async () => {
    const port = new FakePort();
    let createdSession: FakeMossSession | null = null;
    const loadClient = vi.fn(async () => (opts: { onEvent: (ev: MossLiveServerEvent) => void }) => {
      createdSession = new FakeMossSession(opts);
      return createdSession;
    });

    attachMossLivePort(port as any, { loadClient });

    port.simulateMessage({
      action: "start",
      wsUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
      providerType: "gemini-live",
      model: "gemini-3.1-flash-live-preview",
      liveGeminiNativeSearch: true
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(loadClient).toHaveBeenCalledWith("gemini-live");
    expect(createdSession).not.toBeNull();
    expect(createdSession!.actions).toEqual([
      {
        action: "start",
        wsUrl:
          "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
        providerType: "gemini-live",
        model: "gemini-3.1-flash-live-preview",
        liveGeminiNativeSearch: true,
        videoContext: null
      }
    ]);
  });

  it("uses loadGeminiClient when provided and providerType is 'gemini-live'", async () => {
    const port = new FakePort();
    let geminiSession: FakeMossSession | null = null;
    const loadClient = vi.fn(async () => (opts: { onEvent: (ev: MossLiveServerEvent) => void }) => new FakeMossSession(opts));
    const loadGeminiClient = vi.fn(async () => (opts: { onEvent: (ev: MossLiveServerEvent) => void }) => {
      geminiSession = new FakeMossSession(opts);
      return geminiSession;
    });

    attachMossLivePort(port as any, { loadClient, loadGeminiClient });

    port.simulateMessage({
      action: "start",
      wsUrl: "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent",
      providerType: "gemini-live",
      model: "gemini-3.1-flash-live-preview"
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(loadGeminiClient).toHaveBeenCalledTimes(1);
    expect(loadClient).not.toHaveBeenCalled();
    expect(geminiSession).not.toBeNull();
  });
});

describe("attachMossLivePort subtitle tool bridge", () => {
  async function setup() {
    const port = new FakePort();
    let client: OffscreenMossLiveClient | null = null;
    attachMossLivePort(port as any, {
      loadClient: async () => (options) => {
        client = new OffscreenMossLiveClient(options);
        return client;
      }
    });
    port.simulateMessage({
      action: "start",
      videoContext: {
        url: "https://www.bilibili.com/video/BV1/",
        bvid: "BV1",
        cid: "1",
        title: "测试视频",
        pageIndex: 1,
        pageCount: 1,
        pageTitle: "",
        chapters: []
      }
    });
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    return { port, client: client!, ws };
  }

  it("relays context updates and tool call/result in both directions while tracking speaking_state", async () => {
    const { port, client, ws } = await setup();

    const nextContext = {
      url: "https://www.bilibili.com/video/BV2/",
      bvid: "BV2",
      cid: "2",
      title: "第二集",
      pageIndex: 2,
      pageCount: 2,
      pageTitle: "P2",
      chapters: []
    };
    port.simulateMessage({ action: "context_update", videoContext: nextContext });

    ws.sentData.length = 0;
    ws.simulateMessage(
      JSON.stringify({
        action: "tool.call",
        data: { call_id: "call-1", name: "search_video_subtitles", arguments: { query: "字幕" } }
      })
    );

    expect(client.isSpeaking()).toBe(true);
    expect(port.postedMessages).toContainEqual({ type: "speaking_state", speaking: true });
    expect(port.postedMessages).toContainEqual({
      type: "tool_call",
      call: {
        callId: "call-1",
        name: "search_video_subtitles",
        arguments: { query: "字幕" },
        video: { bvid: "BV2", cid: "2", pageIndex: 2 }
      }
    });

    port.simulateMessage({ action: "tool_result", callId: "call-1", result: { ok: true, items: [] } });
    expect(client.isSpeaking()).toBe(false);
    expect(port.postedMessages).toContainEqual({ type: "speaking_state", speaking: false });
    expect(ws.sentData).toHaveLength(0);
  });

  it("relays summarize_video tool call and result between offscreen port and content", async () => {
    const { port, client, ws } = await setup();
    ws.sentData.length = 0;
    port.postedMessages.length = 0;

    ws.simulateMessage(
      JSON.stringify({
        action: "tool.call",
        data: { call_id: "sum-call-1", name: "summarize_video", arguments: {} }
      })
    );

    expect(client.isSpeaking()).toBe(true);
    expect(port.postedMessages).toContainEqual({
      type: "tool_call",
      call: {
        callId: "sum-call-1",
        name: "summarize_video",
        arguments: {},
        video: { bvid: "BV1", cid: "1", pageIndex: 1 }
      }
    });

    const overviewResponse = {
      ok: true,
      coverage: "complete",
      summary: "总结完成",
      chapters: [],
      quotes: []
    };
    port.simulateMessage({ action: "tool_result", callId: "sum-call-1", result: overviewResponse });

    expect(client.isSpeaking()).toBe(false);
    expect(ws.sentData).toHaveLength(0);
  });

  it("returns a timeout error without closing the session when content never answers", async () => {
    vi.useFakeTimers();
    try {
      const { port, client, ws } = await setup();
      ws.sentData.length = 0;
      ws.simulateMessage(
        JSON.stringify({
          action: "tool.call",
          data: { call_id: "call-timeout", name: "search_video_subtitles", arguments: {} }
        })
      );
      expect(client.isSpeaking()).toBe(true);
      vi.advanceTimersByTime(10000);
      expect(client.isSpeaking()).toBe(false);
      expect(ws.sentData).toHaveLength(0);
      expect(port.postedMessages).toContainEqual({
        type: "tool_error",
        error: "页面工具执行超时，请稍后重试"
      });
      expect(client.getState()).toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates previous active live client across ports when a new port starts", async () => {
    const { port: port1, client: client1, ws: ws1 } = await setup();
    expect(client1.getState()).toBe("connected");

    const port2 = new FakePort();
    let client2: OffscreenMossLiveClient | null = null;
    attachMossLivePort(port2 as any, {
      loadClient: async () => (options) => {
        client2 = new OffscreenMossLiveClient(options);
        return client2;
      }
    });

    port2.simulateMessage({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime",
      model: "moss-live-1.0"
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(port1.postedMessages).toContainEqual({ type: "closed", reason: "takeover" });
    expect(client1.disposed || client1.getState() === "closed" || ws1.readyState === FakeWebSocket.CLOSED).toBe(true);

    const ws2 = FakeWebSocket.instances[1];
    ws2.simulateOpen();
    ws2.simulateMessage(JSON.stringify({ action: "session_attached" }));
    expect(client2!.getState()).toBe("connected");
  });
});
