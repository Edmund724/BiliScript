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
  delegationSilents: Array<{ delegationId: string; content: string }> = [];
  delegationResults: Array<{ delegationId: string; status: string; content: string }> = [];

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

  sendDelegationSilent(
    delegationId: string,
    content: string,
    transport: LiveWireTransport
  ): boolean {
    this.delegationSilents.push({ delegationId, content });
    return transport.sendJson({ type: "delegation_silent", delegationId, content });
  }

  sendDelegationResult(
    delegationId: string,
    status: "in_progress" | "completed" | "failed",
    content: string,
    transport: LiveWireTransport
  ): boolean {
    this.delegationResults.push({ delegationId, status, content });
    return transport.sendJson({ type: "delegation_result", delegationId, status, content });
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
  it("orchestrates speaking_state, transcript, and deferred context_update through the adapter seam", () => {
    const adapter = new FakeWireAdapter();
    const events: MossLiveServerEvent[] = [];
    const runtime = new OffscreenLiveSessionRuntime(adapter, {
      videoContext: sampleContext,
      onEvent: (ev) => events.push(ev)
    } satisfies OffscreenLiveSessionRuntimeOptions);

    runtime.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "ready", sessionId: "fake-sess-1" }));

    expect(runtime.getState()).toBe("connected");
    expect(runtime.getSessionId()).toBe("fake-sess-1");

    adapter.callbacks!.emitTranscript({ kind: "input.updated", text: "请问" });
    expect(runtime.isSpeaking()).toBe(false);

    adapter.callbacks!.emitTranscript({
      kind: "output.updated",
      text: "正在解答",
      runId: "r1",
      turnId: "t1"
    });
    expect(runtime.isSpeaking()).toBe(true);

    const nextContext: MossLiveSessionContext = {
      ...sampleContext,
      title: "架构加深测试（概览已更新）"
    };
    runtime.updateVideoContext(nextContext);
    expect(adapter.contextUpdates).toHaveLength(0);

    adapter.callbacks!.emitTranscript({
      kind: "response.ended",
      status: "completed",
      runId: "r1",
      turnId: "t1"
    });
    expect(runtime.isSpeaking()).toBe(false);
    expect(
      events
        .filter((ev): ev is Extract<MossLiveServerEvent, { type: "speaking_state" }> => ev.type === "speaking_state")
        .map((ev) => ev.speaking)
    ).toEqual([true, false]);
    expect(adapter.contextUpdates).toEqual([nextContext]);
  });

  it("routes delegation_silent and delegation_result actions through LiveWireProtocolAdapter", () => {
    const adapter = new FakeWireAdapter();
    const runtime = new OffscreenLiveSessionRuntime(adapter, { videoContext: sampleContext });

    runtime.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "ready", sessionId: "fake-sess-2" }));
    ws.sentData.length = 0;

    runtime.handleAction({
      action: "delegation_silent",
      delegationId: "del-1",
      content: "第一段事实"
    });
    runtime.handleAction({
      action: "delegation_result",
      delegationId: "del-1",
      status: "completed",
      content: "最终口播结论"
    });

    expect(adapter.delegationSilents).toEqual([{ delegationId: "del-1", content: "第一段事实" }]);
    expect(adapter.delegationResults).toEqual([
      { delegationId: "del-1", status: "completed", content: "最终口播结论" }
    ]);
    expect(ws.jsonFrames()).toEqual([
      { type: "delegation_silent", delegationId: "del-1", content: "第一段事实" },
      { type: "delegation_result", delegationId: "del-1", status: "completed", content: "最终口播结论" }
    ]);
  });

  it("silences local playback gain on set_output_muted without touching WebSocket or saved volume and restores on unmute", () => {
    const gainNode = { gain: { value: 1 }, connect: vi.fn() };
    const fakeAudioCtx = {
      state: "running",
      currentTime: 0,
      destination: {},
      createGain: () => gainNode,
      createBuffer: (_channels: number, length: number, sampleRate: number) => ({
        duration: length / sampleRate,
        getChannelData: () => new Float32Array(length)
      }),
      createBufferSource: () => ({
        buffer: null,
        playbackRate: { value: 1 },
        onended: null,
        connect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn()
      }),
      resume: vi.fn(async () => {})
    };
    const adapter = new FakeWireAdapter();
    const events: MossLiveServerEvent[] = [];
    const runtime = new OffscreenLiveSessionRuntime(adapter, {
      videoContext: sampleContext,
      createAudioContext: () => fakeAudioCtx as any,
      onEvent: (ev) => events.push(ev)
    });

    runtime.handleAction({ action: "start", volume: 0.75 });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ type: "ready", sessionId: "mute-sess" }));
    adapter.callbacks!.enqueueAudioContext("c1", "r1", "t1");
    adapter.callbacks!.enqueueAudioFrame(new Uint8Array(64).buffer);
    expect(gainNode.gain.value).toBe(0.75);

    ws.sentData.length = 0;
    runtime.handleAction({ action: "set_output_muted", muted: true });
    expect(gainNode.gain.value).toBe(0);
    expect(ws.sentData).toHaveLength(0);

    adapter.callbacks!.applyOutputConfiguration({ volumeDb: 0, speed: 1.25 });
    expect(gainNode.gain.value).toBe(0);
    adapter.callbacks!.emitTranscript({ kind: "output.done", text: "静音下文字正常显示", runId: "r1", turnId: "t1" });
    expect(events).toContainEqual({
      type: "transcript",
      event: { kind: "output.done", text: "静音下文字正常显示", runId: "r1", turnId: "t1" }
    });

    runtime.handleAction({ action: "set_output_muted", muted: false });
    expect(gainNode.gain.value).toBe(0.75);
  });
});

describe("Unified runtime behavior across Gemini and MOSS", () => {
  it("emits speaking_state for Gemini Live only during model output turns", () => {
    const events: MossLiveServerEvent[] = [];
    const client = new OffscreenGeminiLiveClient({
      videoContext: sampleContext,
      onEvent: (ev) => events.push(ev)
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
    expect(events.filter((ev) => ev.type === "speaking_state")).toEqual([]);

    ws.simulateMessage(
      JSON.stringify({
        serverContent: {
          outputTranscription: { text: "好的" }
        }
      })
    );
    expect(events.filter((ev) => ev.type === "speaking_state")).toEqual([
      { type: "speaking_state", speaking: true }
    ]);

    ws.simulateMessage(
      JSON.stringify({
        serverContent: {
          turnComplete: true,
          interactionStatus: "IDLE"
        }
      })
    );
    expect(events.filter((ev) => ev.type === "speaking_state")).toEqual([
      { type: "speaking_state", speaking: true },
      { type: "speaking_state", speaking: false }
    ]);
  });

  it("reconnects Gemini Live automatically using sessionResumptionUpdate.newHandle (up to 3 attempts)", () => {
    const events: MossLiveServerEvent[] = [];
    const client = new OffscreenGeminiLiveClient({
      videoContext: sampleContext,
      reconnectDelayMs: 0,
      onEvent: (ev) => events.push(ev)
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
    expect(
      events
        .filter((ev): ev is Extract<MossLiveServerEvent, { type: "session_attached" }> => ev.type === "session_attached")
        .map((ev) => ev.sessionId)
    ).toEqual(["gemini-resume-token-42"]);

    ws1.close(1006, "Network lost");
    expect(
      events
        .filter((ev): ev is Extract<MossLiveServerEvent, { type: "reconnecting" }> => ev.type === "reconnecting")
        .map(({ attempt, maxAttempts, code }) => ({ attempt, maxAttempts, code }))
    ).toEqual([{ attempt: 1, maxAttempts: 3, code: 1006 }]);
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
      onEvent: (ev) => {
        if (ev.type === "transcript") transcripts.push(ev.event);
      }
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
