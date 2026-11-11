// tests/live/offscreen-interpret-client.test.ts
// 同传 offscreen 独立 runtime：握手时序、上行 0x00+PCM 成帧、下行二进制丢弃、
// 1013 可识别错误不重试、其余断线沿用重连上限

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { OffscreenInterpretClient } from "../../extension/live/offscreen-interpret-client.js";
import {
  DEFAULT_MOSS_RECONNECT_DELAY_MS,
  MAX_MOSS_RECONNECT_ATTEMPTS,
  MossBinaryTag,
  encodeBase64Bytes
} from "../../extension/live/moss-live-protocol.js";
import type { MossInterpretServerEvent } from "../../extension/live/moss-interpret-protocol.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
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

  send(data: unknown) {
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

  simulateMessage(data: unknown) {
    this.onmessage?.({ data });
  }

  simulateClose(code: number, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

function createClient(events: MossInterpretServerEvent[] = []) {
  const client = new OffscreenInterpretClient({
    onEvent: (event) => events.push(event)
  });
  return { client, events };
}

function connectedClient(events: MossInterpretServerEvent[] = []) {
  const { client } = createClient(events);
  client.handleAction({
    action: "start",
    wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
  });
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
  ws.simulateOpen();
  ws.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "s-1" } }));
  return { client, ws };
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

describe("OffscreenInterpretClient handshake", () => {
  it("sends attach_session on open, then media.mode(tagged-v1) and media.configure after session_attached", () => {
    const { client, events } = createClient();
    client.handleAction({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
    });

    expect(events).toContainEqual({ type: "connecting" });
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe("wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh");

    ws.simulateOpen();
    expect(JSON.parse(ws.sentData[0] as string)).toEqual({
      action: "attach_session",
      memory_scope: "session",
      delegation: { type: "client" }
    });

    ws.simulateMessage(JSON.stringify({ type: "session_attached", data: { session_id: "s-1" } }));
    expect(JSON.parse(ws.sentData[1] as string)).toEqual({
      action: "media.mode",
      binary_protocol: "tagged-v1"
    });
    expect(JSON.parse(ws.sentData[2] as string)).toEqual({
      action: "media.configure",
      playback: "server",
      audio: { format: "pcm_s16le", sample_rate: 16000, channels: 1 }
    });
    expect(client.getState()).toBe("connected");
    expect(client.getSessionId()).toBe("s-1");
    expect(events).toContainEqual({ type: "connected", sessionId: "s-1" });
  });

  it("resumes with session_id on reconnect start", () => {
    const { client } = createClient();
    client.handleAction({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh",
      sessionId: "s-resume"
    });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    expect(JSON.parse(ws.sentData[0] as string)).toMatchObject({
      action: "attach_session",
      session_id: "s-resume"
    });
  });
});

describe("OffscreenInterpretClient uplink", () => {
  it("frames audio actions as 0x00 + PCM tagged-v1 binary frames when connected", () => {
    const { client, ws } = connectedClient();
    ws.sentData.length = 0;

    const pcm = new Uint8Array([9, 8, 7, 6]);
    client.handleAction({ action: "audio", pcmBase64: encodeBase64Bytes(pcm) });

    expect(ws.sentData).toHaveLength(1);
    expect(Array.from(ws.sentData[0] as Uint8Array)).toEqual([
      MossBinaryTag.AudioPcm,
      9,
      8,
      7,
      6
    ]);
  });

  it("drops audio frames while not connected instead of queueing", () => {
    const { client } = createClient();
    client.handleAction({
      action: "start",
      wsUrl: "wss://api.mosi.cn/v1/realtime/interpret?model=moss-live-1.0&target=zh"
    });
    const ws = FakeWebSocket.instances[0];
    // socket still connecting
    client.handleAction({ action: "audio", pcmBase64: encodeBase64Bytes(new Uint8Array([1])) });
    expect(ws.sentData).toHaveLength(0);
  });
});

describe("OffscreenInterpretClient downlink", () => {
  it("forwards transcript events with turn / run_id / source_turn identity", () => {
    const events: MossInterpretServerEvent[] = [];
    const { ws } = connectedClient(events);
    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({ type: "input.transcript.updated", data: { text: "hello", turn: "t-1" } })
    );
    ws.simulateMessage(
      JSON.stringify({
        type: "output.transcript.updated",
        data: { text: "你好", run_id: "r-1", source_turn: "t-1" }
      })
    );
    ws.simulateMessage(
      JSON.stringify({
        type: "response.ended",
        data: { status: "completed", run_id: "r-1", source_turn: "t-1" }
      })
    );

    expect(events).toContainEqual({
      type: "transcript",
      event: { kind: "input.updated", text: "hello", turn: "t-1" }
    });
    expect(events).toContainEqual({
      type: "transcript",
      event: { kind: "output.updated", text: "你好", runId: "r-1", sourceTurn: "t-1" }
    });
    expect(events).toContainEqual({
      type: "transcript",
      event: { kind: "response.ended", status: "completed", runId: "r-1", sourceTurn: "t-1" }
    });
  });

  it("discards binary downlink frames without queueing or emitting anything", () => {
    const events: MossInterpretServerEvent[] = [];
    const { client, ws } = connectedClient(events);
    ws.sentData.length = 0;
    const before = events.length;

    ws.simulateMessage(new ArrayBuffer(8));
    ws.simulateMessage(new Uint8Array([1, 2, 3]).buffer);

    expect(events.length).toBe(before);
    expect(ws.sentData).toHaveLength(0);
    expect(client.getState()).toBe("connected");
  });

  it("forwards session.closing and server error events", () => {
    const events: MossInterpretServerEvent[] = [];
    const { ws } = connectedClient(events);

    ws.simulateMessage(JSON.stringify({ type: "session.closing", data: { reason: "draining" } }));
    expect(events).toContainEqual({ type: "session_closing", reason: "draining" });

    ws.simulateMessage(
      JSON.stringify({ type: "error", data: { code: "session_limit", message: "并发已满" } })
    );
    expect(events).toContainEqual({
      type: "error",
      error: "并发已满",
      code: "session_limit"
    });
  });
});

describe("OffscreenInterpretClient close handling", () => {
  it("reports close code 1013 as an identifiable error with reason and never retries", () => {
    vi.useFakeTimers();
    try {
      const events: MossInterpretServerEvent[] = [];
      const { client, ws } = connectedClient(events);

      ws.simulateClose(1013, "Session limit reached");

      expect(events).toContainEqual({
        type: "error",
        error: expect.stringContaining("1013"),
        code: 1013,
        reason: "Session limit reached"
      });
      expect(client.getState()).toBe("failed");
      vi.advanceTimersByTime(DEFAULT_MOSS_RECONNECT_DELAY_MS * 10);
      expect(FakeWebSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconnects other drops up to the shared cap, then closes with diagnostics", () => {
    vi.useFakeTimers();
    try {
      const events: MossInterpretServerEvent[] = [];
      const { client, ws } = connectedClient(events);

      ws.simulateClose(1006, "abnormal");
      expect(events).toContainEqual({
        type: "reconnecting",
        attempt: 1,
        maxAttempts: MAX_MOSS_RECONNECT_ATTEMPTS,
        code: 1006,
        reason: "abnormal",
        error: undefined
      });

      // 重连始终未完成握手（无 session_attached）：尝试次数只增不减直至耗尽。
      for (let i = 0; i < MAX_MOSS_RECONNECT_ATTEMPTS; i++) {
        vi.advanceTimersByTime(DEFAULT_MOSS_RECONNECT_DELAY_MS);
        const next = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
        next.simulateOpen();
        expect(client.getState()).toBe("connecting");
        next.simulateClose(1006, "abnormal");
      }

      expect(client.getState()).toBe("closed");
      expect(FakeWebSocket.instances).toHaveLength(1 + MAX_MOSS_RECONNECT_ATTEMPTS);
      const closed = events.filter((event) => event.type === "closed").pop();
      expect(closed).toMatchObject({
        code: 1006,
        error: expect.stringContaining(`已达最大重连次数 (${MAX_MOSS_RECONNECT_ATTEMPTS} 次)`)
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats 1000 as a clean close without reconnect", () => {
    const events: MossInterpretServerEvent[] = [];
    const { client, ws } = connectedClient(events);
    ws.simulateClose(1000, "bye");
    expect(client.getState()).toBe("closed");
    expect(events).toContainEqual({ type: "closed", code: 1000, reason: "bye", error: undefined });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("stop closes the socket, clears state and emits closed", () => {
    const events: MossInterpretServerEvent[] = [];
    const { client, ws } = connectedClient(events);
    client.handleAction({ action: "stop" });
    expect(client.getState()).toBe("idle");
    expect(client.getSessionId()).toBeNull();
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
    expect(events).toContainEqual({ type: "closed" });
  });
});
