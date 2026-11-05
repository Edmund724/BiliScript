import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { resolveWebSearchRuntime } from "../../extension/search/search-runtime.js";
import {
  OffscreenGeminiLiveClient,
  type GeminiLiveClientOptions
} from "../../extension/live/offscreen-gemini-live-client.js";

vi.mock("../../extension/search/search-runtime.js", () => ({
  resolveWebSearchRuntime: vi.fn()
}));

const resolveRuntime = vi.mocked(resolveWebSearchRuntime);
import {
  encodeBase64Bytes,
  encodeFloat32ToPcmS16LE,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "../../extension/live/moss-live-protocol.js";
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike
} from "../../extension/live/moss-audio-player.js";

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

  simulateError(error: unknown = new Error("socket error")): void {
    this.onerror?.(error);
  }

  jsonFrames(): any[] {
    return this.sentData.map((data) => JSON.parse(String(data)));
  }
}

class FakeAudioBuffer implements AudioBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  private readonly channel: Float32Array;

  constructor(readonly length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channel = new Float32Array(length);
  }

  getChannelData(_channel: number): Float32Array {
    return this.channel;
  }
}

class FakeAudioSource implements AudioBufferSourceNodeLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stopped = false;
  disconnected = false;

  connect(_destination: unknown): void {}
  disconnect(): void {
    this.disconnected = true;
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
  currentTime = 1;
  state = "running";
  readonly destination = {};
  readonly outputGain = {
    gain: { value: 1 },
    connect: (_destination: unknown) => {},
    disconnect: () => {}
  };
  readonly sources: FakeAudioSource[] = [];
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
    const source = new FakeAudioSource();
    this.sources.push(source);
    return source;
  }

  createGain() {
    return this.outputGain;
  }
}

const videoContext: MossLiveVideoContext = {
  url: "https://www.bilibili.com/video/BV1gemini/",
  bvid: "BV1gemini",
  cid: "100",
  title: "实时语音原理",
  pageIndex: 1,
  pageCount: 2,
  pageTitle: "基础",
  chapters: [{ title: "握手", from: 0, to: 30 }]
};

function createClient(options: Partial<GeminiLiveClientOptions> = {}) {
  const transcripts: MossLiveTranscriptEvent[] = [];
  const events: any[] = [];
  const audioContext = new FakeAudioContext();
  const client = new OffscreenGeminiLiveClient({
    model: "gemini-3.8-live",
    videoContext,
    createAudioContext: () => audioContext,
    onEvent: (event) => events.push(event),
    onTranscript: (event) => transcripts.push(event),
    ...options
  });
  return { client, transcripts, events, audioContext };
}

function connect(client: OffscreenGeminiLiveClient): FakeWebSocket {
  client.connect();
  const ws = FakeWebSocket.instances.at(-1)!;
  ws.simulateOpen();
  ws.simulateMessage(JSON.stringify({ setupComplete: {} }));
  return ws;
}

function serverContent(content: Record<string, unknown>): string {
  return JSON.stringify({ serverContent: content });
}

function audioPart(sampleCount: number, value = 0.2): string {
  return encodeBase64Bytes(encodeFloat32ToPcmS16LE(new Float32Array(sampleCount).fill(value)));
}

function encodeTextFrame(text: string): Uint8Array {
  return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

class TestTextDecoder {
  decode(data: ArrayBufferLike | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
}

class TestBlob {
  private readonly bytes: Uint8Array;

  constructor(parts: unknown[]) {
    this.bytes = encodeTextFrame(parts.join(""));
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const buffer = new ArrayBuffer(this.bytes.byteLength);
    new Uint8Array(buffer).set(this.bytes);
    return buffer;
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("TextDecoder", TestTextDecoder);
  vi.stubGlobal("Blob", TestBlob);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("OffscreenGeminiLiveClient handshake and media", () => {
  it("sends setup on open and waits for setupComplete before connected or media upload", () => {
    const onConnected = vi.fn();
    const { client } = createClient({ onConnected });

    client.handleAction({ action: "start", model: "models/gemini-3.8-live", videoContext });
    const ws = FakeWebSocket.instances[0];
    expect(client.getState()).toBe("connecting");
    expect(ws.binaryType).toBe("arraybuffer");

    client.handleAction({ action: "audio", pcmBase64: "AQID" });
    expect(ws.sentData).toHaveLength(0);
    ws.simulateOpen();

    expect(ws.sentData).toHaveLength(1);
    const setup = ws.jsonFrames()[0].setup;
    expect(setup).toMatchObject({
      model: "models/gemini-3.8-live",
      generationConfig: { responseModalities: ["AUDIO"] },
      inputAudioTranscription: {},
      outputAudioTranscription: {}
    });
    expect(setup.systemInstruction.parts[0].text).toContain("实时语音原理");
    expect(setup.systemInstruction.parts[0].text).toContain("P1 基础");
    expect(client.getState()).toBe("connecting");
    expect(onConnected).not.toHaveBeenCalled();

    ws.simulateMessage(JSON.stringify({ setupComplete: {} }));
    expect(client.getState()).toBe("connected");
    expect(onConnected).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["ArrayBuffer", () => {
      const bytes = encodeTextFrame(JSON.stringify({ setupComplete: {} }));
      const buffer = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buffer).set(bytes);
      return buffer;
    }],
    ["Blob", () => new Blob([JSON.stringify({ setupComplete: {} })])]
  ])("decodes a binary JSON setupComplete frame from %s", async (_name, frame) => {
    const { client } = createClient();
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(frame());
    await Promise.resolve();
    await Promise.resolve();
    expect(client.getState()).toBe("connected");
  });

  it("fails and cleans up on an error frame", () => {
    const onError = vi.fn();
    const { client } = createClient({ onError });
    client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    ws.simulateMessage(JSON.stringify({ error: { code: 401, message: "API key invalid" } }));

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "API key invalid" }));
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });

  it("times out a stalled setup handshake", () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const { client } = createClient({ handshakeTimeoutMs: 1000, onError });
    client.connect();
    FakeWebSocket.instances[0].simulateOpen();
    vi.advanceTimersByTime(1001);

    expect(client.getState()).toBe("failed");
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("握手超时") })
    );
  });

  it("sends base64 PCM and JPEG as realtimeInput and flushes VAD only on mute transition", () => {
    const { client } = createClient();
    const ws = connect(client);
    ws.sentData.length = 0;

    client.handleAction({ action: "audio", pcmBase64: "AQIDBA==" });
    client.handleAction({ action: "video", jpegBase64: "/9j/2Q==" });
    expect(ws.jsonFrames()).toEqual([
      {
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: "AQIDBA==" }]
        }
      },
      {
        realtimeInput: {
          mediaChunks: [{ mimeType: "image/jpeg", data: "/9j/2Q==" }]
        }
      }
    ]);

    client.handleAction({ action: "mic_state", enabled: false });
    client.handleAction({ action: "mic_state", enabled: false });
    client.handleAction({ action: "audio", pcmBase64: "BQYG" });
    expect(ws.jsonFrames()).toHaveLength(3);
    expect(ws.jsonFrames().at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(ws.jsonFrames().filter((frame) => frame.realtimeInput?.audioStreamEnd)).toHaveLength(1);

    client.handleAction({ action: "mic_state", enabled: true });
    client.handleAction({ action: "audio", pcmBase64: "BQYG" });
    expect(ws.jsonFrames().at(-1)).toEqual({
      realtimeInput: {
        mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: "BQYG" }]
      }
    });
  });
});

describe("OffscreenGeminiLiveClient playback and transcripts", () => {
  it("queues 24kHz PCM gaplessly without playback receipts and synchronizes duck/speaking state", () => {
    const duckStates: boolean[] = [];
    const speakingStates: boolean[] = [];
    const { client, transcripts, audioContext } = createClient({
      onDuckVideo: (active) => duckStates.push(active),
      onSpeakingState: (speaking) => speakingStates.push(speaking)
    });
    const ws = connect(client);
    ws.sentData.length = 0;

    ws.simulateMessage(serverContent({ outputTranscription: { text: "我在" } }));
    const output = transcripts.at(-1)! as Extract<MossLiveTranscriptEvent, { kind: "output.updated" }>;
    ws.simulateMessage(serverContent({
      modelTurn: {
        parts: [
          { inlineData: { mimeType: "audio/pcm;rate=24000", data: audioPart(2400) } },
          { inlineData: { mimeType: "audio/pcm;rate=24000", data: audioPart(4800, -0.2) } }
        ]
      }
    }));

    expect(audioContext.sources).toHaveLength(2);
    expect(audioContext.sources[0].buffer?.sampleRate).toBe(24000);
    expect(audioContext.sources[0].startedAt).toBeCloseTo(1, 5);
    expect(audioContext.sources[1].startedAt).toBeCloseTo(1.1, 5);
    expect(duckStates).toEqual([true]);
    expect(speakingStates).toEqual([true]);

    ws.simulateMessage(serverContent({ turnComplete: true }));
    expect(transcripts.slice(-2)).toEqual([
      { kind: "output.done", text: "我在", runId: output.runId, turnId: output.turnId },
      { kind: "response.ended", status: "completed", runId: output.runId, turnId: output.turnId }
    ]);
    expect(duckStates).toEqual([true]);
    expect(client.isSpeaking()).toBe(true);

    audioContext.sources.forEach((source) => source.finishPlayback());
    expect(client.isSpeaking()).toBe(false);
    expect(duckStates).toEqual([true, false]);
    expect(speakingStates).toEqual([true, false]);
    expect(ws.sentData).toHaveLength(0);
  });

  it("accumulates input and output deltas into full-text standard transcript events", () => {
    const { client, transcripts } = createClient();
    const ws = connect(client);

    ws.simulateMessage(serverContent({ inputTranscription: { text: "这个" } }));
    ws.simulateMessage(serverContent({ inputTranscription: { text: "视频" } }));
    ws.simulateMessage(serverContent({ outputTranscription: { text: "核心" } }));
    ws.simulateMessage(serverContent({ outputTranscription: { text: "观点" } }));
    ws.simulateMessage(serverContent({ turnComplete: true }));

    const output = transcripts.find((event) => event.kind === "output.updated")!;
    if (output.kind !== "output.updated") throw new Error("missing output");
    expect(transcripts).toEqual([
      { kind: "input.updated", text: "这个" },
      { kind: "input.updated", text: "这个视频" },
      { kind: "output.updated", text: "核心", runId: output.runId, turnId: output.turnId },
      { kind: "output.updated", text: "核心观点", runId: output.runId, turnId: output.turnId },
      { kind: "input.done", text: "这个视频" },
      { kind: "output.done", text: "核心观点", runId: output.runId, turnId: output.turnId },
      { kind: "response.ended", status: "completed", runId: output.runId, turnId: output.turnId }
    ]);
    expect(output.runId).toBeTruthy();
    expect(output.turnId).toBeTruthy();
  });

  it("closes the previous round before switching to a new input round", () => {
    const { client, transcripts } = createClient();
    const ws = connect(client);

    ws.simulateMessage(serverContent({ inputTranscription: { text: "第一问" } }));
    ws.simulateMessage(serverContent({ outputTranscription: { text: "第一答" } }));
    ws.simulateMessage(serverContent({ inputTranscription: { text: "第二问" } }));

    const outputs = transcripts.filter((event) => event.kind === "output.updated");
    const ended = transcripts.find((event) => event.kind === "response.ended")!;
    expect(ended).toMatchObject({ status: "completed" });
    if (outputs[0]?.kind === "output.updated" && ended.kind === "response.ended") {
      expect(ended).toMatchObject({ runId: outputs[0].runId, turnId: outputs[0].turnId });
    }
    expect(transcripts.at(-1)).toEqual({ kind: "input.updated", text: "第二问" });
  });

  it("stops playback immediately on server interruption and drops late output until new input", () => {
    const duckStates: boolean[] = [];
    const speakingStates: boolean[] = [];
    const { client, transcripts, audioContext } = createClient({
      onDuckVideo: (active) => duckStates.push(active),
      onSpeakingState: (speaking) => speakingStates.push(speaking)
    });
    const ws = connect(client);

    ws.simulateMessage(serverContent({ outputTranscription: { text: "说到一半" } }));
    ws.simulateMessage(serverContent({
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audioPart(2400) } }] }
    }));
    ws.simulateMessage(serverContent({ interrupted: true }));

    expect(audioContext.sources[0].stopped).toBe(true);
    expect(duckStates).toEqual([true, false]);
    expect(speakingStates).toEqual([true, false]);
    expect(transcripts.map((event) => event.kind)).toEqual([
      "output.updated",
      "output.done",
      "response.interrupted"
    ]);

    ws.simulateMessage(serverContent({ outputTranscription: { text: "迟到回答" } }));
    ws.simulateMessage(serverContent({
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audioPart(2400) } }] }
    }));
    expect(audioContext.sources).toHaveLength(1);
    expect(transcripts.some((event) => event.kind === "output.updated" && event.text === "迟到回答")).toBe(false);

    ws.simulateMessage(serverContent({ inputTranscription: { text: "新问题是", finished: true } }));
    ws.simulateMessage(serverContent({ outputTranscription: { text: "新回答" } }));
    expect(transcripts.at(-1)).toMatchObject({ kind: "output.updated", text: "新回答" });
    const ids = transcripts.filter((event) => event.kind === "output.updated");
    if (ids[0]?.kind === "output.updated" && ids.at(-1)?.kind === "output.updated") {
      expect(ids.at(-1)!.turnId).not.toBe(ids[0].turnId);
      expect(ids.at(-1)!.runId).toBe(ids[0].runId);
    }
  });

  it("stops still-playing audio when interruption arrives after turnComplete", () => {
    const duckStates: boolean[] = [];
    const speakingStates: boolean[] = [];
    const { client, audioContext } = createClient({
      onDuckVideo: (active) => duckStates.push(active),
      onSpeakingState: (speaking) => speakingStates.push(speaking)
    });
    const ws = connect(client);
    ws.simulateMessage(serverContent({
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audioPart(4800) } }] }
    }));
    ws.simulateMessage(serverContent({ turnComplete: true }));
    expect(client.isSpeaking()).toBe(true);

    ws.simulateMessage(serverContent({ interrupted: true }));

    expect(audioContext.sources[0].stopped).toBe(true);
    expect(client.isSpeaking()).toBe(false);
    expect(duckStates).toEqual([true, false]);
    expect(speakingStates).toEqual([true, false]);
  });

  it("manually interrupts without a MOSS response.cancel frame and resets local state", () => {
    const { client, transcripts, audioContext, events } = createClient();
    const ws = connect(client);
    ws.simulateMessage(serverContent({ outputTranscription: { text: "正在回答" } }));
    ws.simulateMessage(serverContent({
      modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: audioPart(2400) } }] }
    }));
    ws.sentData.length = 0;

    client.handleAction({ action: "interrupt" });

    expect(ws.sentData).toHaveLength(0);
    expect(audioContext.sources[0].stopped).toBe(true);
    expect(client.isSpeaking()).toBe(false);
    expect(transcripts.map((event) => event.kind)).toEqual([
      "output.updated",
      "output.done",
      "response.interrupted"
    ]);
    expect(events).toContainEqual({ type: "duck_video", active: false });
    expect(events).toContainEqual({ type: "speaking_state", speaking: false });
  });
});

describe("OffscreenGeminiLiveClient context update", () => {
  it("injects changed video context without reconnecting and deduplicates unchanged context", () => {
    const { client } = createClient();
    const ws = connect(client);
    ws.sentData.length = 0;
    const nextContext = {
      ...videoContext,
      cid: "200",
      pageIndex: 2,
      pageTitle: "进阶",
      title: "实时语音原理（下）"
    };

    client.handleAction({ action: "context_update", videoContext: nextContext });
    client.handleAction({ action: "context_update", videoContext: nextContext });

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(client.getState()).toBe("connected");
    expect(ws.sentData).toHaveLength(1);
    const frame = ws.jsonFrames()[0];
    expect(frame.clientContent.turnComplete).toBe(false);
    expect(frame.clientContent.turns).toHaveLength(1);
    expect(frame.clientContent.turns[0].role).toBe("user");
    expect(frame.clientContent.turns[0].parts[0].text).toContain("P2 进阶");
    expect(frame.clientContent.turns[0].parts[0].text).toContain("CID：200");
  });

  it("uses the latest pre-handshake context in setup and stop closes the session cleanly", () => {
    const { client } = createClient();
    client.connect();
    const ws = FakeWebSocket.instances[0];
    client.handleAction({
      action: "context_update",
      videoContext: { ...videoContext, cid: "300", pageIndex: 2, pageTitle: "新版" }
    });
    ws.simulateOpen();

    expect(ws.jsonFrames()[0].setup.systemInstruction.parts[0].text).toContain("CID：300");
    ws.simulateMessage(JSON.stringify({ setupComplete: {} }));
    client.handleAction({ action: "stop" });
    expect(client.getState()).toBe("idle");
    expect(ws.readyState).toBe(FakeWebSocket.CLOSED);
  });
  it("pushes a completed overview into instructions mid-session and deduplicates it", () => {
    const { client } = createClient();
    const ws = connect(client);
    ws.sentData.length = 0;
    const withOverview = {
      ...videoContext,
      overview: {
        phase: "ready" as const,
        coverage: "complete" as const,
        summary: "全片介绍实时语音链路。",
        chapters: [{ from: 0, to: 120, time: "0:00", title: "开场", summary: "为什么需要实时" }],
        quotes: [],
        statusText: ""
      }
    };

    client.handleAction({ action: "context_update", videoContext: withOverview });
    client.handleAction({ action: "context_update", videoContext: withOverview });

    expect(ws.sentData).toHaveLength(1);
    const text = ws.jsonFrames()[0].clientContent.turns[0].parts[0].text;
    expect(text).toContain("全片概览状态：ready（覆盖：complete）");
    expect(text).toContain("全片简介：全片介绍实时语音链路。");
    expect(text).toContain("0:00 开场：为什么需要实时");
  });
});

describe("OffscreenGeminiLiveClient tools, web_search, and native search toggle", () => {
  it("declares 3 Bilibili page tools + web_search when liveGeminiNativeSearch is false (default)", () => {
    const { client } = createClient();
    const ws = connect(client);
    const setup = ws.jsonFrames()[0].setup;

    expect(setup.tools).toHaveLength(1);
    expect(setup.tools[0]).not.toHaveProperty("googleSearch");
    const names = setup.tools[0].functionDeclarations.map((fn: { name: string }) => fn.name);
    expect(names).toEqual([
      "control_bilibili_player",
      "get_subtitles_around_time",
      "search_video_subtitles",
      "web_search"
    ]);
  });

  it("declares googleSearch and 3 Bilibili page tools (without web_search) when liveGeminiNativeSearch is true", () => {
    const { client } = createClient();
    client.handleAction({
      action: "start",
      model: "gemini-3.8-live",
      videoContext,
      liveGeminiNativeSearch: true
    });
    const ws = FakeWebSocket.instances[0];
    ws.simulateOpen();
    const setup = ws.jsonFrames()[0].setup;

    expect(setup.tools).toHaveLength(2);
    expect(setup.tools[0]).toEqual({ googleSearch: {} });
    const names = setup.tools[1].functionDeclarations.map((fn: { name: string }) => fn.name);
    expect(names).toEqual([
      "control_bilibili_player",
      "get_subtitles_around_time",
      "search_video_subtitles"
    ]);
    expect(names).not.toContain("web_search");
  });

  it("handles concurrent page tool and web_search calls in a single toolCall frame and wraps toolResponse.functionResponses", async () => {
    const toolCalls: any[] = [];
    const toolStatuses: any[] = [];
    const executeWebSearch = vi.fn(async (query: string) => ({
      output: `已检索：${query}`,
      resultCount: 2,
      platform: "Exa"
    }));
    const { client } = createClient({
      executeWebSearch,
      onToolCall: (call) => toolCalls.push(call),
      onToolStatus: (status) => toolStatuses.push(status)
    });
    const ws = connect(client);
    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({
        toolCall: {
          functionCalls: [
            {
              id: "call-sub-1",
              name: "search_video_subtitles",
              args: { query: "握手", max_results: 5 }
            },
            {
              id: "call-web-1",
              name: "web_search",
              args: { query: "Gemini Live BidiGenerateContent" }
            }
          ]
        }
      })
    );

    expect(client.isSpeaking()).toBe(true);
    expect(toolCalls).toEqual([
      {
        callId: "call-sub-1",
        name: "search_video_subtitles",
        arguments: { query: "握手", max_results: 5 },
        video: { bvid: "BV1gemini", cid: "100", pageIndex: 1 }
      }
    ]);
    expect(toolStatuses[0]).toEqual({
      tool: "web_search",
      status: "searching",
      query: "Gemini Live BidiGenerateContent"
    });

    await vi.waitFor(() => {
      expect(toolStatuses).toHaveLength(2);
    });
    expect(toolStatuses[1]).toEqual({
      tool: "web_search",
      status: "done",
      query: "Gemini Live BidiGenerateContent",
      resultCount: 2,
      platform: "Exa"
    });
    expect(executeWebSearch).toHaveBeenCalledWith(
      "Gemini Live BidiGenerateContent",
      expect.any(AbortSignal),
      0
    );
    expect(client.isSpeaking()).toBe(true);

    client.handleAction({
      action: "tool_result",
      callId: "call-sub-1",
      result: { ok: true, matches: [{ from: 5, time: "00:05", content: "握手" }] }
    });
    expect(client.isSpeaking()).toBe(false);

    expect(ws.jsonFrames()).toEqual([
      {
        toolResponse: {
          functionResponses: [
            {
              id: "call-web-1",
              name: "web_search",
              response: { result: "已检索：Gemini Live BidiGenerateContent" }
            }
          ]
        }
      },
      {
        toolResponse: {
          functionResponses: [
            {
              id: "call-sub-1",
              name: "search_video_subtitles",
              response: {
                result: { ok: true, matches: [{ from: 5, time: "00:05", content: "握手" }] }
              }
            }
          ]
        }
      }
    ]);
  });

  it("reuses the 7-platform web_search fallback chain and emits no_results / failed statuses", async () => {
    const toolStatuses: any[] = [];
    const executeSearch = vi
      .fn()
      .mockResolvedValueOnce({
        results: [
          {
            title: "B 站伴看文档",
            url: "https://example.com/doc",
            snippet: "Gemini Live 工具调用规范"
          }
        ],
        platform: "DuckDuckGo",
        downgradedFrom: "Exa"
      })
      .mockResolvedValueOnce({
        results: [],
        platform: "DuckDuckGo"
      });
    resolveRuntime.mockResolvedValue({
      runtime: { maxToolCalls: 5, executeSearch }
    });

    const { client } = createClient({
      onToolStatus: (status) => toolStatuses.push(status)
    });
    const ws = connect(client);
    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: "call-fallback", name: "web_search", args: { query: "B站伴看" } },
            { id: "call-nores", name: "web_search", args: { query: "无结果词" } },
            { id: "call-empty", name: "web_search", args: { query: "   " } }
          ]
        }
      })
    );

    await vi.waitFor(() => {
      expect(ws.jsonFrames()).toHaveLength(3);
    });

    expect(toolStatuses).toContainEqual({
      tool: "web_search",
      status: "failed",
      query: "",
      error: "搜索关键词为空或工具参数无效"
    });
    expect(toolStatuses).toContainEqual({
      tool: "web_search",
      status: "done",
      query: "B站伴看",
      resultCount: 1,
      platform: "DuckDuckGo"
    });
    expect(toolStatuses).toContainEqual({
      tool: "web_search",
      status: "no_results",
      query: "无结果词",
      resultCount: 0,
      platform: "DuckDuckGo"
    });
    const fallbackResp = ws
      .jsonFrames()
      .find((f) => f.toolResponse?.functionResponses?.[0]?.id === "call-fallback");
    expect(fallbackResp?.toolResponse.functionResponses[0].response.result).toContain(
      "首选 Exa 未成功"
    );
    expect(fallbackResp?.toolResponse.functionResponses[0].response.result).toContain(
      "B 站伴看文档"
    );
  });

  it("times out a stalled page tool call, sends an error toolResponse, and ignores late tool_result", () => {
    vi.useFakeTimers();
    const toolErrors: string[] = [];
    const { client } = createClient({
      pageToolTimeoutMs: 500,
      onToolError: (err) => toolErrors.push(err)
    });
    const ws = connect(client);
    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({
        toolCall: {
          functionCalls: [
            {
              id: "call-timeout",
              name: "control_bilibili_player",
              args: { command: "pause" }
            }
          ]
        }
      })
    );
    expect(client.isSpeaking()).toBe(true);

    vi.advanceTimersByTime(501);

    expect(client.isSpeaking()).toBe(false);
    expect(toolErrors).toEqual(["页面工具执行超时，请稍后重试"]);
    expect(ws.jsonFrames()).toEqual([
      {
        toolResponse: {
          functionResponses: [
            {
              id: "call-timeout",
              name: "control_bilibili_player",
              response: {
                result: { ok: false, error: "页面工具执行超时，请稍后重试" }
              }
            }
          ]
        }
      }
    ]);

    client.handleAction({
      action: "tool_result",
      callId: "call-timeout",
      result: { ok: true }
    });
    expect(ws.jsonFrames()).toHaveLength(1);
  });

  it("cancels specific in-flight web_search and page tool calls on toolCallCancellation.ids", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null = null;
    const executeWebSearch = vi.fn(
      (_query: string, signal: AbortSignal) =>
        new Promise<{ output: string; resultCount: number }>((resolve) => {
          capturedSignal = signal;
          signal.addEventListener("abort", () => {
            resolve({ output: "aborted", resultCount: 0 });
          });
        })
    );
    const { client } = createClient({
      pageToolTimeoutMs: 1000,
      executeWebSearch
    });
    const ws = connect(client);
    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: "cancel-web", name: "web_search", args: { query: "取消搜索" } },
            { id: "cancel-page", name: "get_subtitles_around_time", args: { current_time: 10 } },
            { id: "keep-page", name: "control_bilibili_player", args: { command: "play" } }
          ]
        }
      })
    );

    expect(capturedSignal).toBeTruthy();
    expect(capturedSignal!.aborted).toBe(false);

    ws.simulateMessage(
      JSON.stringify({
        toolCallCancellation: {
          ids: ["cancel-web", "cancel-page"]
        }
      })
    );

    expect(capturedSignal!.aborted).toBe(true);
    await Promise.resolve();
    vi.advanceTimersByTime(500);

    client.handleAction({
      action: "tool_result",
      callId: "cancel-page",
      result: { ok: true }
    });
    expect(ws.jsonFrames()).toHaveLength(0);

    client.handleAction({
      action: "tool_result",
      callId: "keep-page",
      result: { ok: true, playing: true }
    });
    expect(ws.jsonFrames()).toEqual([
      {
        toolResponse: {
          functionResponses: [
            {
              id: "keep-page",
              name: "control_bilibili_player",
              response: { result: { ok: true, playing: true } }
            }
          ]
        }
      }
    ]);
    expect(client.isSpeaking()).toBe(false);
  });

  it("aborts in-flight tool calls and timers when interrupted or closed", () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null = null;
    const executeWebSearch = vi.fn(
      (_query: string, signal: AbortSignal) =>
        new Promise<{ output: string; resultCount: number }>(() => {
          capturedSignal = signal;
        })
    );
    const { client } = createClient({
      pageToolTimeoutMs: 1000,
      executeWebSearch
    });
    const ws = connect(client);
    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({
        toolCall: {
          functionCalls: [
            { id: "int-web", name: "web_search", args: { query: "被打断搜索" } },
            { id: "int-page", name: "control_bilibili_player", args: { command: "pause" } }
          ]
        }
      })
    );
    expect(client.isSpeaking()).toBe(true);

    ws.simulateMessage(serverContent({ interrupted: true }));

    expect(capturedSignal!.aborted).toBe(true);
    expect(client.isSpeaking()).toBe(false);
    vi.advanceTimersByTime(1500);
    expect(ws.jsonFrames()).toHaveLength(0);
  });
});
