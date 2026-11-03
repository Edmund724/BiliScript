// tests/live/offscreen-moss-client.test.ts
// Offscreen MOSS-LIVE 客户端生命周期、握手超时、音频上行/下行播放回执与字幕转发测试

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  OffscreenMossLiveClient,
  type AudioBufferLike,
  type AudioBufferSourceNodeLike,
  type AudioContextLike
} from "../../extension/live/offscreen-moss-client.js";
import {
  MOSS_DOWNSTREAM_SAMPLE_RATE,
  MossBinaryTag,
  buildMinimalSessionUpdatePayload,
  encodeFloat32ToPcmS16LE,
  type MossLiveTranscriptEvent
} from "../../extension/live/moss-live-protocol.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

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

  simulateError(err: any = new Error("Socket error")) {
    this.onerror?.(err);
  }
}

class FakeAudioBuffer implements AudioBufferLike {
  readonly duration: number;
  readonly length: number;
  readonly sampleRate: number;
  private readonly channel0: Float32Array;

  constructor(length: number, sampleRate: number) {
    this.length = length;
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channel0 = new Float32Array(length);
  }

  getChannelData(_channel: number): Float32Array {
    return this.channel0;
  }
}

class FakeAudioBufferSourceNode implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  connected = false;
  startedAt: number | null = null;
  stopped = false;

  connect(_destination: unknown): void {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
  }

  start(when = 0): void {
    this.startedAt = when;
  }

  stop(): void {
    this.stopped = true;
  }

  finishPlayback(): void {
    this.onended?.();
  }
}

class FakeAudioContext implements AudioContextLike {
  currentTime = 0;
  state = "running";
  destination = {};
  sources: FakeAudioBufferSourceNode[] = [];
  closed = false;

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    return new FakeAudioBuffer(length, sampleRate);
  }

  createBufferSource(): AudioBufferSourceNodeLike {
    const source = new FakeAudioBufferSourceNode();
    this.sources.push(source);
    return source;
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OffscreenMossLiveClient", () => {
  it("connects, sends attach_session upon open, and does not fire onConnected yet", () => {
    const onConnected = vi.fn();
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onConnected,
      onError
    });

    client.connect();
    expect(client.getState()).toBe("connecting");

    const ws = (client as any).ws as FakeWebSocket;
    expect(ws).toBeDefined();
    expect(ws.binaryType).toBe("arraybuffer");

    ws.simulateOpen();

    // attach_session sent immediately on open
    expect(ws.sentData).toHaveLength(1);
    expect(JSON.parse(ws.sentData[0])).toEqual({
      action: "attach_session",
      memory_scope: "session"
    });

    // not connected yet (session_attached required)
    expect(client.getState()).toBe("connecting");
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("transitions to connected, sends tagged-v1 media.mode and session.update upon receiving session_attached, and mic_state on session.updated", () => {
    const onConnected = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onConnected
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

    expect(client.getState()).toBe("connected");
    expect(onConnected).toHaveBeenCalledTimes(1);

    // Verify protocol handshake messages sent
    expect(ws.sentData).toHaveLength(3);
    expect(JSON.parse(ws.sentData[1])).toEqual({
      action: "media.mode",
      binary_protocol: "tagged-v1"
    });
    expect(JSON.parse(ws.sentData[2])).toEqual(buildMinimalSessionUpdatePayload());

    // Server confirms session.updated -> client enables mic_state
    ws.simulateMessage(JSON.stringify({ action: "session.updated", data: { error: "" } }));
    expect(ws.sentData).toHaveLength(4);
    expect(JSON.parse(ws.sentData[3])).toEqual({
      action: "mic_state",
      enabled: true
    });
  });

  it("fails when server sends error action (top-level or nested data.error)", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    ws.simulateMessage(JSON.stringify({ action: "error", message: "鉴权失败：密钥无效" }));

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("鉴权失败：密钥无效")
    }));
  });

  it("fails when session.updated contains data.error", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    ws.simulateMessage(JSON.stringify({
      action: "session.updated",
      data: { error: "unsupported sample rate" }
    }));

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("unsupported sample rate")
    }));
  });

  it("fails when socket encounters error", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;

    ws.simulateError();

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("WebSocket 连接失败或握手鉴权被拒绝")
    }));
  });

  it("fails when socket closes during connecting state", () => {
    const onError = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onError
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;

    ws.close(1006, "Connection refused");

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining("1006")
    }));
  });

  it("notifies onClosed when socket closes cleanly after connected", () => {
    const onClosed = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onClosed
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    expect(client.getState()).toBe("connected");

    ws.close(1000, "Normal closure");

    expect(client.getState()).toBe("closed");
    expect(onClosed).toHaveBeenCalledWith({ code: 1000, reason: "Normal closure" });
  });

  it("close() shuts down socket, transitions to idle, and ignores subsequent server messages", () => {
    const onConnected = vi.fn();
    const onError = vi.fn();
    const onClosed = vi.fn();
    const client = new OffscreenMossLiveClient({
      wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
      onConnected,
      onError,
      onClosed
    });

    client.connect();
    const ws = (client as any).ws as FakeWebSocket;
    ws.simulateOpen();

    client.close();
    expect(client.getState()).toBe("idle");

    // Late session_attached or error arrives from wire
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    ws.simulateError();
    ws.close(1006, "Abnormal closure");

    expect(onConnected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(onClosed).not.toHaveBeenCalled();
  });

  describe("handshake timeout and socket replacement", () => {
    it("times out if server remains silent and does not send session_attached within handshakeTimeoutMs", () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        handshakeTimeoutMs: 5000,
        onError
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();

      expect(client.getState()).toBe("connecting");

      // Advance clock past 5000ms
      vi.advanceTimersByTime(5001);

      expect(client.getState()).toBe("failed");
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({
        message: expect.stringContaining("MOSS-LIVE 会话附着握手超时")
      }));
    });

    it("clears handshake timeout once session_attached arrives", () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const onConnected = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        handshakeTimeoutMs: 5000,
        onConnected,
        onError
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();

      // Handshake succeeds at 2000ms
      vi.advanceTimersByTime(2000);
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

      expect(client.getState()).toBe("connected");
      expect(onConnected).toHaveBeenCalledTimes(1);

      // Advance clock well beyond original 5000ms timeout
      vi.advanceTimersByTime(10000);

      // Must remain connected and timeout must not fire
      expect(client.getState()).toBe("connected");
      expect(onError).not.toHaveBeenCalled();
    });

    it("regression: handshake timeout from an earlier replaced socket does not fail a newer attached socket", () => {
      vi.useFakeTimers();
      const onError = vi.fn();
      const onConnected = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        handshakeTimeoutMs: 5000,
        onConnected,
        onError
      });

      // Socket 1 starts connecting at t=0
      client.connect();
      const ws1 = (client as any).ws as FakeWebSocket;
      ws1.simulateOpen();

      // At t=2000, reconnect is called (replacing socket 1 with socket 2)
      vi.advanceTimersByTime(2000);
      client.connect();
      const ws2 = (client as any).ws as FakeWebSocket;
      ws2.simulateOpen();

      // Socket 2 receives session_attached at t=3000
      vi.advanceTimersByTime(1000);
      ws2.simulateMessage(JSON.stringify({ action: "session_attached" }));

      expect(client.getState()).toBe("connected");
      expect(onConnected).toHaveBeenCalledTimes(1);

      // Advance clock past t=5000 (socket 1's original timeout would have fired here)
      vi.advanceTimersByTime(3000);

      // Client must remain connected, socket 1's stale timer was ignored
      expect(client.getState()).toBe("connected");
      expect(onError).not.toHaveBeenCalled();
    });

    it("regression: fail() invalidates socket generation, ignoring late session_attached/error/close after failure, while allowing later explicit connect()", () => {
      const onError = vi.fn();
      const onConnected = vi.fn();
      const onClosed = vi.fn();
      const client = new OffscreenMossLiveClient({
        wsUrl: "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0",
        onConnected,
        onError,
        onClosed
      });

      client.connect();
      const ws1 = (client as any).ws as FakeWebSocket;
      ws1.simulateOpen();

      // Simulate failure (e.g. server error or socket error)
      ws1.simulateError(new Error("Initial connection error"));

      expect(client.getState()).toBe("failed");
      expect(onError).toHaveBeenCalledTimes(1);

      // Now late events arrive from ws1
      ws1.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws1.simulateError(new Error("Late error"));
      ws1.close(1006, "Late close");

      // State MUST remain failed, onConnected MUST NOT be called, onError must not be called again
      expect(client.getState()).toBe("failed");
      expect(onConnected).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onClosed).not.toHaveBeenCalled();

      // Explicit later connect() must work normally
      client.connect();
      expect(client.getState()).toBe("connecting");

      const ws2 = (client as any).ws as FakeWebSocket;
      expect(ws2).not.toBe(ws1);
      ws2.simulateOpen();
      ws2.simulateMessage(JSON.stringify({ action: "session_attached" }));

      expect(client.getState()).toBe("connected");
      expect(onConnected).toHaveBeenCalledTimes(1);
    });
  });

  describe("upstream audio, mic_state & transcript forwarding", () => {
    it("sends 0x00 tagged audio frames when mic is enabled and suppresses frames when muted", () => {
      const client = new OffscreenMossLiveClient();
      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.simulateMessage(JSON.stringify({ action: "session.updated", data: { error: "" } }));

      ws.sentData.length = 0;

      const pcm640 = new Uint8Array(640).fill(0x11);
      expect(client.sendAudioPcm(pcm640.buffer)).toBe(true);
      expect(ws.sentData).toHaveLength(1);
      const sentFrame = ws.sentData[0] as Uint8Array;
      expect(sentFrame.byteLength).toBe(641);
      expect(sentFrame[0]).toBe(MossBinaryTag.AudioPcm);

      // Mute microphone
      client.setMicEnabled(false);
      expect(ws.sentData).toHaveLength(2);
      expect(JSON.parse(ws.sentData[1])).toEqual({
        action: "mic_state",
        enabled: false
      });

      // Audio frames while muted must be suppressed
      expect(client.sendAudioPcm(pcm640.buffer)).toBe(false);
      expect(ws.sentData).toHaveLength(2);

      // Unmute microphone
      client.setMicEnabled(true);
      expect(ws.sentData).toHaveLength(3);
      expect(JSON.parse(ws.sentData[2])).toEqual({
        action: "mic_state",
        enabled: true
      });
      expect(client.sendAudioPcm(pcm640.buffer)).toBe(true);
      expect(ws.sentData).toHaveLength(4);
    });

    it("forwards input/output transcript and response.ended events to onTranscript", () => {
      const transcripts: MossLiveTranscriptEvent[] = [];
      const client = new OffscreenMossLiveClient({
        onTranscript: (ev) => transcripts.push(ev)
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));

      ws.simulateMessage(
        JSON.stringify({ action: "input.transcript.updated", data: { text: "你好" } })
      );
      ws.simulateMessage(
        JSON.stringify({ action: "input.transcript.done", data: { text: "你好助手" } })
      );
      ws.simulateMessage(
        JSON.stringify({
          action: "output.transcript.updated",
          data: { text: "我在", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(
        JSON.stringify({
          action: "output.transcript.done",
          data: { text: "我在听，请讲。", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(
        JSON.stringify({
          action: "response.ended",
          data: { status: "completed", run_id: "r1", turn_id: "t1" }
        })
      );

      expect(transcripts).toEqual([
        { kind: "input.updated", text: "你好" },
        { kind: "input.done", text: "你好助手" },
        { kind: "output.updated", text: "我在", runId: "r1", turnId: "t1" },
        { kind: "output.done", text: "我在听，请讲。", runId: "r1", turnId: "t1" },
        { kind: "response.ended", status: "completed", runId: "r1", turnId: "t1" }
      ]);
    });
  });

  describe("downstream 48kHz PCM gapless playback & receipts", () => {
    it("schedules consecutive 48kHz audio chunks gaplessly and sends playback.chunk.completed and playback.completed in strict order", () => {
      const fakeAudioCtx = new FakeAudioContext();
      fakeAudioCtx.currentTime = 1.0;

      const client = new OffscreenMossLiveClient({
        createAudioContext: () => fakeAudioCtx
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      // Chunk 1: 4800 samples @ 48kHz = 0.1s
      const pcmChunk1 = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.25));
      // Chunk 2: 9600 samples @ 48kHz = 0.2s
      const pcmChunk2 = encodeFloat32ToPcmS16LE(new Float32Array(9600).fill(-0.25));

      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.context",
          data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(pcmChunk1.buffer);

      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.context",
          data: { chunk_id: "c2", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(pcmChunk2.buffer);

      // Server announces audio stream finished for turn t1 while both chunks are still playing
      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.done",
          data: { run_id: "r1", turn_id: "t1" }
        })
      );

      // Verify gapless scheduling on FakeAudioContext
      expect(fakeAudioCtx.sources).toHaveLength(2);
      expect(fakeAudioCtx.sources[0].buffer?.sampleRate).toBe(MOSS_DOWNSTREAM_SAMPLE_RATE);
      expect(fakeAudioCtx.sources[0].startedAt).toBeCloseTo(1.0, 5);
      expect(fakeAudioCtx.sources[1].startedAt).toBeCloseTo(1.1, 5); // 1.0 + 0.1s duration

      // No receipts sent before playback finishes
      expect(ws.sentData).toHaveLength(0);

      // Chunk 1 finishes playing -> only playback.chunk.completed for c1 (turn not done yet)
      fakeAudioCtx.sources[0].finishPlayback();
      expect(ws.sentData).toHaveLength(1);
      expect(JSON.parse(ws.sentData[0])).toEqual({
        action: "playback.chunk.completed",
        chunk_id: "c1",
        run_id: "r1",
        turn_id: "t1"
      });

      // Chunk 2 finishes playing -> sends playback.chunk.completed for c2 AND playback.completed for turn
      fakeAudioCtx.sources[1].finishPlayback();
      expect(ws.sentData).toHaveLength(3);
      expect(JSON.parse(ws.sentData[1])).toEqual({
        action: "playback.chunk.completed",
        chunk_id: "c2",
        run_id: "r1",
        turn_id: "t1"
      });
      expect(JSON.parse(ws.sentData[2])).toEqual({
        action: "playback.completed",
        run_id: "r1",
        turn_id: "t1"
      });
    });

    it("sends playback.completed when response.audio.done arrives AFTER all chunks already finished playing", () => {
      const fakeAudioCtx = new FakeAudioContext();
      const client = new OffscreenMossLiveClient({
        createAudioContext: () => fakeAudioCtx
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      const pcmChunk = encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.1));
      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.context",
          data: { chunk_id: "c1", run_id: "r2", turn_id: "t2" }
        })
      );
      ws.simulateMessage(pcmChunk.buffer);

      // Chunk finishes playing BEFORE response.audio.done arrives
      fakeAudioCtx.sources[0].finishPlayback();
      expect(ws.sentData).toHaveLength(1);
      expect(JSON.parse(ws.sentData[0])).toEqual({
        action: "playback.chunk.completed",
        chunk_id: "c1",
        run_id: "r2",
        turn_id: "t2"
      });

      // Now response.audio.done arrives -> immediately triggers playback.completed
      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.done",
          data: { run_id: "r2", turn_id: "t2" }
        })
      );
      expect(ws.sentData).toHaveLength(2);
      expect(JSON.parse(ws.sentData[1])).toEqual({
        action: "playback.completed",
        run_id: "r2",
        turn_id: "t2"
      });
    });

    it("stops active audio sources and sends playback.stopped with played_audio_ms on response.audio.stop", () => {
      const fakeAudioCtx = new FakeAudioContext();
      fakeAudioCtx.currentTime = 0;

      const client = new OffscreenMossLiveClient({
        createAudioContext: () => fakeAudioCtx
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      // Chunk 1: 4800 samples = 100ms
      const pcmChunk1 = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2));
      // Chunk 2: 9600 samples = 200ms
      const pcmChunk2 = encodeFloat32ToPcmS16LE(new Float32Array(9600).fill(0.2));

      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.context",
          data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(pcmChunk1.buffer);

      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.context",
          data: { chunk_id: "c2", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(pcmChunk2.buffer);

      // Chunk 1 finishes at t = 0.1s; chunk 2 plays halfway to t = 0.15s (50ms into chunk 2)
      fakeAudioCtx.currentTime = 0.1;
      fakeAudioCtx.sources[0].finishPlayback();
      fakeAudioCtx.currentTime = 0.15;

      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.stop",
          data: { run_id: "r1", turn_id: "t1" }
        })
      );

      expect(fakeAudioCtx.sources[1].stopped).toBe(true);
      expect(ws.sentData).toHaveLength(2);
      expect(JSON.parse(ws.sentData[1])).toEqual({
        action: "playback.stopped",
        run_id: "r1",
        turn_id: "t1",
        played_audio_ms: 150
      });
    });

    it("pairs audio frames that arrive before metadata and waits for actual playback before completion receipts", () => {
      const fakeAudioCtx = new FakeAudioContext();
      const client = new OffscreenMossLiveClient({ createAudioContext: () => fakeAudioCtx });
      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      const pcmChunk1 = encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.1));
      const pcmChunk2 = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2));
      ws.simulateMessage(pcmChunk1.buffer);
      ws.simulateMessage(pcmChunk2.buffer);
      expect(fakeAudioCtx.sources).toHaveLength(0);

      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c2", run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.done",
        data: { run_id: "r1", turn_id: "t1" }
      }));

      expect(fakeAudioCtx.sources).toHaveLength(2);
      expect(ws.sentData).toHaveLength(0);
      fakeAudioCtx.sources[0].finishPlayback();
      fakeAudioCtx.sources[1].finishPlayback();
      expect(ws.sentData.map((data) => JSON.parse(data))).toEqual([
        { action: "playback.chunk.completed", chunk_id: "c1", run_id: "r1", turn_id: "t1" },
        { action: "playback.chunk.completed", chunk_id: "c2", run_id: "r1", turn_id: "t1" },
        { action: "playback.completed", run_id: "r1", turn_id: "t1" }
      ]);
    });

    it("deduplicates repeated chunk metadata, audio frames, and audio.done", () => {
      const fakeAudioCtx = new FakeAudioContext();
      const client = new OffscreenMossLiveClient({ createAudioContext: () => fakeAudioCtx });
      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      const context = JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
      });
      const done = JSON.stringify({
        action: "response.audio.done",
        data: { run_id: "r1", turn_id: "t1" }
      });
      const pcmChunk = encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.1));
      ws.simulateMessage(context);
      ws.simulateMessage(context);
      ws.simulateMessage(pcmChunk.buffer);
      ws.simulateMessage(pcmChunk.buffer);
      ws.simulateMessage(done);
      ws.simulateMessage(done);

      expect(fakeAudioCtx.sources).toHaveLength(1);
      expect(ws.sentData).toHaveLength(0);
      fakeAudioCtx.sources[0].finishPlayback();
      fakeAudioCtx.sources[0].finishPlayback();
      expect(ws.sentData.map((data) => JSON.parse(data))).toEqual([
        { action: "playback.chunk.completed", chunk_id: "c1", run_id: "r1", turn_id: "t1" },
        { action: "playback.completed", run_id: "r1", turn_id: "t1" }
      ]);
    });

    it("stops immediately on response.interrupted, reports accurate progress once, and drops late audio", () => {
      const fakeAudioCtx = new FakeAudioContext();
      const transcripts: MossLiveTranscriptEvent[] = [];
      const client = new OffscreenMossLiveClient({
        createAudioContext: () => fakeAudioCtx,
        onTranscript: (event) => transcripts.push(event)
      });
      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      const pcmChunk = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(pcmChunk.buffer);
      fakeAudioCtx.currentTime = 0.05;
      ws.simulateMessage(JSON.stringify({
        action: "response.interrupted",
        data: { run_id: "r1", turn_id: "t1" }
      }));

      expect(fakeAudioCtx.sources[0].stopped).toBe(true);
      expect(transcripts).toEqual([{ kind: "response.interrupted", runId: "r1", turnId: "t1" }]);
      expect(ws.sentData).toHaveLength(0);

      const stop = JSON.stringify({
        action: "response.audio.stop",
        data: { run_id: "r1", turn_id: "t1" }
      });
      ws.simulateMessage(stop);
      ws.simulateMessage(stop);
      fakeAudioCtx.sources[0].finishPlayback();
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "late", run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(pcmChunk.buffer);
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.done",
        data: { run_id: "r1", turn_id: "t1" }
      }));

      expect(fakeAudioCtx.sources).toHaveLength(1);
      expect(ws.sentData.map((data) => JSON.parse(data))).toEqual([
        { action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 50 }
      ]);
    });

    it("keeps consecutive interruptions and a subsequent turn isolated from stale completion events", () => {
      const fakeAudioCtx = new FakeAudioContext();
      const client = new OffscreenMossLiveClient({ createAudioContext: () => fakeAudioCtx });
      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      const pcm100ms = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(pcm100ms.buffer);
      fakeAudioCtx.currentTime = 0.05;
      ws.simulateMessage(JSON.stringify({
        action: "response.interrupted",
        data: { run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.stop",
        data: { run_id: "r1", turn_id: "t1" }
      }));

      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c2", run_id: "r2", turn_id: "t2" }
      }));
      ws.simulateMessage(pcm100ms.buffer);
      fakeAudioCtx.currentTime = 0.08;
      ws.simulateMessage(JSON.stringify({
        action: "response.interrupted",
        data: { run_id: "r2", turn_id: "t2" }
      }));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.stop",
        data: { run_id: "r2", turn_id: "t2" }
      }));

      const pcm50ms = encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.3));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.context",
        data: { chunk_id: "c3", run_id: "r3", turn_id: "t3" }
      }));
      ws.simulateMessage(pcm50ms.buffer);
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.done",
        data: { run_id: "r3", turn_id: "t3" }
      }));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.done",
        data: { run_id: "r1", turn_id: "t1" }
      }));
      ws.simulateMessage(JSON.stringify({
        action: "response.audio.done",
        data: { run_id: "r2", turn_id: "t2" }
      }));
      fakeAudioCtx.sources[2].finishPlayback();

      expect(fakeAudioCtx.sources[0].stopped).toBe(true);
      expect(fakeAudioCtx.sources[1].stopped).toBe(true);
      expect(ws.sentData.map((data) => JSON.parse(data))).toEqual([
        { action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 50 },
        { action: "playback.stopped", run_id: "r2", turn_id: "t2", played_audio_ms: 30 },
        { action: "playback.chunk.completed", chunk_id: "c3", run_id: "r3", turn_id: "t3" },
        { action: "playback.completed", run_id: "r3", turn_id: "t3" }
      ]);
    });

    it("stops all playing sources on close() and suppresses late onended callbacks", () => {
      const fakeAudioCtx = new FakeAudioContext();
      const client = new OffscreenMossLiveClient({
        createAudioContext: () => fakeAudioCtx
      });

      client.connect();
      const ws = (client as any).ws as FakeWebSocket;
      ws.simulateOpen();
      ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
      ws.sentData.length = 0;

      const pcmChunk = encodeFloat32ToPcmS16LE(new Float32Array(4800).fill(0.2));
      ws.simulateMessage(
        JSON.stringify({
          action: "response.audio.context",
          data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" }
        })
      );
      ws.simulateMessage(pcmChunk.buffer);

      expect(fakeAudioCtx.sources).toHaveLength(1);

      client.close();
      expect(fakeAudioCtx.sources[0].stopped).toBe(true);
      expect(fakeAudioCtx.closed).toBe(true);

      // Even if browser fires late onended, no receipts are sent
      fakeAudioCtx.sources[0].finishPlayback();
      expect(ws.sentData).toHaveLength(0);
    });
  });
});
