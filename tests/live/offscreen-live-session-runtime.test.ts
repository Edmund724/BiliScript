// tests/live/offscreen-live-session-runtime.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  OffscreenLiveSessionRuntime,
  type LiveWireProtocolAdapter,
  type LiveWireRuntimeCallbacks,
  type LiveWireSocketOpenContext,
  type LiveWireTransport,
  type OffscreenLiveSessionRuntimeOptions
} from "../../extension/live/offscreen-live-session-runtime.js";
import { OffscreenGeminiLiveClient } from "../../extension/live/offscreen-gemini-live-client.js";
import { OffscreenMossLiveClient } from "../../extension/live/offscreen-moss-client.js";
import type {
  MossLiveServerEvent,
  MossLiveSessionContext,
  MossLiveTranscriptEvent
} from "../../extension/live/moss-live-protocol.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = 0;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  sentData: unknown[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sentData.push(data);
  }

  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.({ data });
  }

  jsonFrames(): any[] {
    return this.sentData
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data));
  }
}

class FakeWireAdapter implements LiveWireProtocolAdapter {
  readonly defaultWsUrl = "wss://fake.live.local/ws";
  readonly handshakeTimeoutMessage = "FakeWireAdapter 握手超时";
  readonly audioSampleRate = 24000;
  readonly enablePlaybackReceipts = false;

  callbacks: LiveWireRuntimeCallbacks | null = null;
  resets: number[] = [];
  contextUpdates: Array<MossLiveSessionContext | null> = [];
  toolResponses: Array<{ callId: string; name: string; result: unknown }> = [];

  onConnectReset(generation: number): void {
    this.resets.push(generation);
  }

  onSocketOpen(context: LiveWireSocketOpenContext): void {
    context.markContextSent(context.videoContext);
    context.sendJson({ type: "hello", sessionId: context.sessionId });
  }

  handleIncomingData(data: unknown, callbacks: LiveWireRuntimeCallbacks): void {
    this.callbacks = callbacks;
    const msg = typeof data === "string" ? JSON.parse(data) : (data as Record<string, any>);
    if (msg.type === "ready") {
      callbacks.completeHandshake({
        sessionId: msg.sessionId,
        emitSessionAttached: Boolean(msg.sessionId)
      });
    }
  }

  sendAudio(
    pcmBase64: string,
    _pcmBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendJson({ type: "audio", pcmBase64 });
  }

  sendVideo(
    jpegBase64: string,
    _jpegBytes: Uint8Array<ArrayBuffer>,
    transport: LiveWireTransport
  ): boolean {
    return transport.sendJson({ type: "video", jpegBase64 });
  }

  onMicStateChanged(
    enabled: boolean,
    _prev: boolean,
    connected: boolean,
    transport: LiveWireTransport
  ): void {
    if (connected) {
      transport.sendJson({ type: "mic", enabled });
    }
  }

  sendContextUpdate(context: MossLiveSessionContext | null, transport: LiveWireTransport): void {
    this.contextUpdates.push(context);
    transport.sendJson({ type: "context_update", context });
  }

  sendToolResponse(
    call: { callId: string; name: string },
    result: unknown,
    transport: LiveWireTransport
  ): boolean {
    this.toolResponses.push({ ...call, result });
    return transport.sendJson({ type: "tool_response", callId: call.callId, result });
  }
}

const sampleContext: MossLiveSessionContext = {
  url: "https://www.bilibili.com/video/BV1runtime/",
  bvid: "BV1runtime",
  cid: "10",
  title: "架构加深测试",
  pageIndex: 1,
  pageCount: 2,
  pageTitle: "Part 1",
  chapters: []
};

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OffscreenLiveSessionRuntime + FakeWireAdapter seam contract", () => {
  it("orchestrates duck_video, speaking_state, and deferred context_update through the adapter seam", () => {
    const adapter = new FakeWireAdapter();
    const events: MossLiveServerEvent[] = [];
    const duckStates: boolean[] = [];
    const runtime = new OffscreenLiveSessionRuntime(adapter, {
      videoContext: sampleContext,
      onEvent: (ev) => events.push(ev),
      onDuckVideo: (active) => duckStates.push(active)
    } satisfies OffscreenLiveSessionRuntimeOptions);

    runtime.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "ready", sessionId: "fake-sess-1" }));

    expect(runtime.getState()).toBe("connected");
    expect(runtime.getSessionId()).toBe("fake-sess-1");

    // 1. User begins speaking -> ducks video
    adapter.callbacks!.emitTranscript({ kind: "input.updated", text: "请问" });
    expect(duckStates).toEqual([true]);

    // 2. Model starts responding -> remains ducked & enters speaking state
    adapter.callbacks!.emitTranscript({
      kind: "output.updated",
      text: "正在解答",
      runId: "r1",
      turnId: "t1"
    });
    expect(runtime.isSpeaking()).toBe(true);

    // 3. Same-video overview refresh arrives while speaking -> deferred until turn completes
    const nextContext: MossLiveSessionContext = {
      ...sampleContext,
      title: "架构加深测试（概览已更新）"
    };
    runtime.updateVideoContext(nextContext);
    expect(adapter.contextUpdates).toHaveLength(0);

    // 4. Turn ends -> releases duck, exits speaking, and flushes pending context
    adapter.callbacks!.emitTranscript({
      kind: "response.ended",
      status: "completed",
      runId: "r1",
      turnId: "t1"
    });
    expect(runtime.isSpeaking()).toBe(false);
    expect(duckStates).toEqual([true, false]);
    expect(adapter.contextUpdates).toEqual([nextContext]);
  });
});

describe("Unified runtime behavior across Gemini and MOSS", () => {
  it("emits duck_video for Gemini Live during user input and model output turns", () => {
    const duckStates: boolean[] = [];
    const client = new OffscreenGeminiLiveClient({
      videoContext: sampleContext,
      onDuckVideo: (active) => duckStates.push(active)
    });

    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ setupComplete: {} }));

    ws.simulateMessage(
      JSON.stringify({
        serverContent: {
          inputTranscription: { text: "总结一下" }
        }
      })
    );
    expect(duckStates).toEqual([true]);

    ws.simulateMessage(
      JSON.stringify({
        serverContent: {
          outputTranscription: { text: "好的" }
        }
      })
    );
    expect(duckStates).toEqual([true]);

    ws.simulateMessage(
      JSON.stringify({
        serverContent: {
          turnComplete: true,
          interactionStatus: "IDLE"
        }
      })
    );
    expect(duckStates).toEqual([true, false]);
  });

  it("reconnects Gemini Live automatically using sessionResumptionUpdate.newHandle (up to 3 attempts)", () => {
    const reconnecting: Array<{ attempt: number; maxAttempts: number; code?: number }> = [];
    const attachedHandles: string[] = [];
    const client = new OffscreenGeminiLiveClient({
      videoContext: sampleContext,
      reconnectDelayMs: 0,
      onSessionAttached: (handle) => attachedHandles.push(handle),
      onReconnecting: (attempt, maxAttempts, info) =>
        reconnecting.push({ attempt, maxAttempts, code: info?.code })
    });

    client.connect();
    const ws1 = FakeWebSocket.instances[0];
    ws1.simulateOpen();
    expect(ws1.jsonFrames()[0].setup.sessionResumption).toEqual({});

    ws1.simulateMessage(JSON.stringify({ setupComplete: {} }));
    ws1.simulateMessage(
      JSON.stringify({
        sessionResumptionUpdate: {
          resumable: true,
          newHandle: "gemini-resume-token-42"
        }
      })
    );

    expect(client.getSessionId()).toBe("gemini-resume-token-42");
    expect(attachedHandles).toEqual(["gemini-resume-token-42"]);

    // Unexpected connection drop triggers reconnect with saved handle
    ws1.close(1006, "Network lost");
    expect(reconnecting).toEqual([{ attempt: 1, maxAttempts: 3, code: 1006 }]);
    expect(client.getReconnectAttempts()).toBe(1);

    const ws2 = FakeWebSocket.instances[1];
    expect(ws2).toBeDefined();
    ws2.simulateOpen();
    expect(ws2.jsonFrames()[0].setup.sessionResumption).toEqual({
      handle: "gemini-resume-token-42"
    });

    ws2.simulateMessage(JSON.stringify({ setupComplete: {} }));
    expect(client.getState()).toBe("connected");
    expect(client.getReconnectAttempts()).toBe(0);
  });

  it("keeps the MOSS socket, interrupts the old turn, and drops its late output on a video switch", () => {
    const transcripts: MossLiveTranscriptEvent[] = [];
    const client = new OffscreenMossLiveClient({
      videoContext: sampleContext,
      onTranscript: (event) => transcripts.push(event)
    });

    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

    ws.simulateMessage(
      JSON.stringify({
        action: "output.transcript.updated",
        data: { text: "旧视频回答", run_id: "r1", turn_id: "t1" }
      })
    );
    expect(client.isSpeaking()).toBe(true);

    ws.sentData.length = 0;
    const updatedContext: MossLiveSessionContext = {
      ...sampleContext,
      cid: "99",
      pageIndex: 2,
      pageTitle: "P2"
    };
    client.updateVideoContext(updatedContext);

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toBe("connected");
    expect(client.isSpeaking()).toBe(false);
    const contextFrames = ws.jsonFrames().filter((frame) => frame.action === "session.update");
    expect(contextFrames).toHaveLength(1);
    expect(contextFrames[0].session.instructions).toContain("CID：99");

    ws.simulateMessage(JSON.stringify({
      action: "output.transcript.updated",
      data: { text: "旧视频迟到回答", run_id: "r1", turn_id: "t1" }
    }));
    ws.simulateMessage(JSON.stringify({
      action: "response.ended",
      data: { status: "completed", run_id: "r1", turn_id: "t1" }
    }));
    expect(transcripts.map((event) => event.kind)).toEqual([
      "output.updated",
      "response.interrupted"
    ]);
    expect(ws.jsonFrames().filter((frame) => frame.action === "session.update")).toHaveLength(1);
  });
});
