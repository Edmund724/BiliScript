import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveChatController } from "../../extension/live/live-chat-controller.js";
import {
  DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN,
  DEFAULT_VIDEO_SEND_DISABLED_GAIN,
  DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC,
  DEFAULT_VIDEO_SEND_NORMAL_GAIN,
  DEFAULT_VIDEO_SEND_RESTORE_TIME_CONSTANT_SEC,
  createPageAudioCapture,
  resolveVideoSendGainTarget,
  type PageAudioContextLike,
  type PageAudioGainNodeLike,
  type PageAudioSourceNodeLike,
  type PageAudioWorkletNodeLike
} from "../../extension/live/page-media-capture.js";
import {
  MOSS_UPSTREAM_SAMPLE_RATE,
  PCM_CAPTURE_PROCESSOR_NAME,
  createPcmCaptureCore,
  decodePcmS16LEToFloat32,
  type PcmCaptureConfig,
  type PcmCaptureMainToWorkletMessage,
  type PcmCaptureWorkletToMainMessage
} from "../../extension/live/pcm-capture-core.js";
import {
  attachMossLivePort,
  resetActiveLiveSessionForTests
} from "../../extension/live/offscreen-moss-port.js";
import { OffscreenGeminiLiveClient } from "../../extension/live/offscreen-gemini-live-client.js";
import { OffscreenMossLiveClient } from "../../extension/live/offscreen-moss-client.js";
import type {
  AudioBufferLike,
  AudioBufferSourceNodeLike,
  AudioContextLike
} from "../../extension/live/moss-audio-player.js";
import {
  MossBinaryTag,
  decodeBase64Bytes,
  encodeBase64Bytes,
  encodeFloat32ToPcmS16LE,
  unpackTaggedBinary,
  type LiveProviderType,
  type MossLiveTranscriptEvent,
  type MossLiveVideoContext
} from "../../extension/live/moss-live-protocol.js";
import type {
  PageVideoFrameCaptureOptions,
  PageVideoFrameCaptureSession
} from "../../extension/live/page-video-frame-capture.js";

class FakeMediaStreamTrack {
  enabled = true;
  stopped = false;
  private readonly endedListeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === "ended") this.endedListeners.delete(listener);
  }

  stop(): void {
    this.stopped = true;
  }
}

class FakeMediaStream {
  readonly tracks: FakeMediaStreamTrack[];

  constructor(readonly kind: "mic" | "video", tracks = [new FakeMediaStreamTrack()]) {
    this.tracks = tracks;
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }
}

interface GainTargetRecord {
  target: number;
  startTime: number;
  timeConstant: number;
}

class SpyGainNode implements PageAudioGainNodeLike {
  readonly connections: Array<{ destination: unknown; outputIndex?: number; inputIndex?: number }> = [];
  readonly setTargetCalls: GainTargetRecord[] = [];
  readonly cancelAndHoldCalls: number[] = [];
  readonly valueSets: number[] = [];
  disconnected = false;
  private rawValue = 1;
  private targetValue = 1;

  readonly gain = {
    get value(): number {
      return this.owner.rawValue;
    },
    set value(next: number) {
      this.owner.rawValue = next;
      this.owner.targetValue = next;
      this.owner.valueSets.push(next);
    },
    cancelAndHoldAtTime: (holdTime: number): void => {
      this.cancelAndHoldCalls.push(holdTime);
    },
    setTargetAtTime: (target: number, startTime: number, timeConstant: number): void => {
      this.setTargetCalls.push({ target, startTime, timeConstant });
      this.targetValue = target;
    },
    owner: this
  };

  get effectiveTargetGain(): number {
    return this.targetValue;
  }

  connect(destination: unknown, outputIndex?: number, inputIndex?: number): void {
    this.connections.push({ destination, outputIndex, inputIndex });
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class SpySourceNode implements PageAudioSourceNodeLike {
  readonly connections: Array<{ destination: unknown; outputIndex?: number; inputIndex?: number }> = [];
  disconnected = false;

  constructor(readonly streamKind: "mic" | "video" | "unknown") {}

  connect(destination: unknown, outputIndex?: number, inputIndex?: number): void {
    this.connections.push({ destination, outputIndex, inputIndex });
  }

  disconnect(): void {
    this.disconnected = true;
  }
}

class SpyCaptureAudioContext implements PageAudioContextLike {
  readonly sampleRate: number;
  currentTime = 0;
  state = "running";
  readonly destination = { label: "audio-destination" };
  closed = false;
  workletStopped = false;
  readonly sources: SpySourceNode[] = [];
  readonly gains: SpyGainNode[] = [];
  workletNode: (PageAudioWorkletNodeLike & {
    connections: Array<{ destination: unknown; outputIndex?: number; inputIndex?: number }>;
  }) | null = null;
  private workletCore: ReturnType<typeof createPcmCaptureCore> | null = null;
  private workletPort: PageAudioWorkletNodeLike["port"] | null = null;

  constructor(sampleRate = MOSS_UPSTREAM_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
  }

  readonly audioWorklet = {
    addModule: async (_moduleURL: string): Promise<void> => {}
  };

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  createMediaStreamSource(stream: MediaStream): PageAudioSourceNodeLike {
    const kind = (stream as unknown as FakeMediaStream).kind ?? "unknown";
    const node = new SpySourceNode(kind);
    this.sources.push(node);
    return node;
  }

  createGain(): PageAudioGainNodeLike {
    const gainNode = new SpyGainNode();
    this.gains.push(gainNode);
    return gainNode;
  }

  createWorkletNode(name: string, options?: AudioWorkletNodeOptions): PageAudioWorkletNodeLike {
    expect(name).toBe(PCM_CAPTURE_PROCESSOR_NAME);
    const initialConfig = options?.processorOptions as Partial<PcmCaptureConfig> | undefined;
    const postToMain = (msg: PcmCaptureWorkletToMainMessage) => {
      if (this.workletStopped) return;
      this.workletPort?.onmessage?.({ data: msg } as MessageEvent<PcmCaptureWorkletToMainMessage>);
    };

    const core = createPcmCaptureCore({
      sampleRate: this.sampleRate,
      initialConfig,
      onVadChange: (active) => postToMain({ type: "vad", active }),
      onBargeInChange: (active) => postToMain({ type: "barge_in", active }),
      onSpeechHeartbeat: () => postToMain({ type: "speech" }),
      onPcmBatch: (pcmBuffer, hadSpeech) => postToMain({ type: "pcm", pcmBuffer, hadSpeech })
    });
    this.workletCore = core;

    const port: PageAudioWorkletNodeLike["port"] = {
      onmessage: null,
      postMessage: (msg: PcmCaptureMainToWorkletMessage) => {
        if (msg.type === "stop") {
          this.workletStopped = true;
          core.reset();
          return;
        }
        if (msg.type === "ai_speaking") {
          core.notifyAiSpeaking(Boolean(msg.speaking));
          return;
        }
        if (msg.type === "config") {
          core.setConfig(msg);
        }
      }
    };
    this.workletPort = port;

    const connections: Array<{ destination: unknown; outputIndex?: number; inputIndex?: number }> = [];
    const node = {
      port,
      connections,
      connect: (destination: unknown, outputIndex?: number, inputIndex?: number) => {
        connections.push({ destination, outputIndex, inputIndex });
      },
      disconnect: () => {}
    };
    this.workletNode = node;
    return node;
  }

  get micSource(): SpySourceNode {
    return this.sources.find((s) => s.streamKind === "mic")!;
  }

  get videoSource(): SpySourceNode {
    return this.sources.find((s) => s.streamKind === "video")!;
  }

  get videoSendGain(): SpyGainNode {
    return this.gains[0];
  }

  get silentGain(): SpyGainNode {
    return this.gains[1];
  }

  emitSamples(micSamples?: Float32Array, videoSamples?: Float32Array): void {
    if (this.workletStopped || !this.workletCore) return;
    const gain = this.videoSendGain ? this.videoSendGain.effectiveTargetGain : 1;
    let attenuatedVideo: Float32Array[] | undefined;
    if (videoSamples) {
      const scaled = new Float32Array(videoSamples.length);
      for (let i = 0; i < videoSamples.length; i++) {
        scaled[i] = videoSamples[i] * gain;
      }
      attenuatedVideo = [scaled];
    }
    this.workletCore.processQuantum(micSamples, attenuatedVideo, this.sampleRate);
  }
}

class FakePlaybackBuffer implements AudioBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly channelData: Float32Array;

  constructor(readonly length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
    this.duration = length / sampleRate;
    this.channelData = new Float32Array(length);
  }

  getChannelData(_channel: number): Float32Array {
    return this.channelData;
  }
}

class FakePlaybackSource implements AudioBufferSourceNodeLike {
  buffer: FakePlaybackBuffer | null = null;
  readonly playbackRate = { value: 1 };
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

class FakePlaybackAudioContext implements AudioContextLike {
  currentTime = 1;
  state = "running";
  readonly destination = {};
  readonly outputGain = {
    gain: { value: 1 },
    connect: (_destination: unknown) => {},
    disconnect: () => {}
  };
  readonly sources: FakePlaybackSource[] = [];
  closed = false;

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  createBuffer(_channels: number, length: number, sampleRate: number): AudioBufferLike {
    return new FakePlaybackBuffer(length, sampleRate);
  }

  createBufferSource(): AudioBufferSourceNodeLike {
    const source = new FakePlaybackSource();
    this.sources.push(source);
    return source;
  }

  createGain() {
    return this.outputGain;
  }
}

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

class DuplexPortSide {
  private readonly messageListeners: Array<(msg: unknown) => void> = [];
  private readonly disconnectListeners: Array<() => void> = [];
  peer: DuplexPortSide | null = null;

  get onMessage() {
    return {
      addListener: (listener: (msg: unknown) => void) => {
        this.messageListeners.push(listener);
      }
    };
  }

  get onDisconnect() {
    return {
      addListener: (listener: () => void) => {
        this.disconnectListeners.push(listener);
      }
    };
  }

  postMessage(msg: unknown): void {
    const target = this.peer;
    if (!target) return;
    for (const listener of [...target.messageListeners]) {
      listener(msg);
    }
  }

  disconnect(): void {
    for (const listener of [...this.disconnectListeners]) {
      listener();
    }
  }
}

function createDuplexPortPair() {
  const clientSide = new DuplexPortSide();
  const offscreenSide = new DuplexPortSide();
  clientSide.peer = offscreenSide;
  offscreenSide.peer = clientSide;
  return { clientSide, offscreenSide };
}

class TestTextDecoder {
  decode(data: ArrayBufferLike | ArrayBufferView): string {
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
}

const sampleVideoContext: MossLiveVideoContext = {
  url: "https://www.bilibili.com/video/BV1bargein/",
  bvid: "BV1bargein",
  cid: "202",
  title: "全双工打断与原声压低测试",
  pageIndex: 1,
  pageCount: 1,
  pageTitle: "P1",
  chapters: []
};

function geminiAudioPartBase64(sampleCount: number, fillValue: number): string {
  return encodeBase64Bytes(encodeFloat32ToPcmS16LE(new Float32Array(sampleCount).fill(fillValue)));
}

function createVideoStub(videoStream: FakeMediaStream) {
  return {
    muted: false,
    volume: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    captureStream: () => videoStream
  } as unknown as HTMLVideoElement;
}

async function setupEndToEndLiveSession(options: {
  providerType: LiveProviderType;
  shareVideoAudio?: boolean;
  voicePriority?: boolean;
}) {
  const { clientSide, offscreenSide } = createDuplexPortPair();
  const playbackAudioCtx = new FakePlaybackAudioContext();
  let offscreenClient: OffscreenGeminiLiveClient | OffscreenMossLiveClient | null = null;

  attachMossLivePort(offscreenSide as unknown as chrome.runtime.Port, {
    loadClient: async (providerType) => {
      if (providerType === "gemini-live") {
        return (opts) => {
          offscreenClient = new OffscreenGeminiLiveClient({
            ...opts,
            model: "gemini-3.8-live",
            createAudioContext: () => playbackAudioCtx
          });
          return offscreenClient;
        };
      }
      return (opts) => {
        offscreenClient = new OffscreenMossLiveClient({
          ...opts,
          createAudioContext: () => playbackAudioCtx
        });
        return offscreenClient;
      };
    }
  });

  const micStream = new FakeMediaStream("mic");
  const captureAudioCtx = new SpyCaptureAudioContext(MOSS_UPSTREAM_SAMPLE_RATE);
  const videoStream = new FakeMediaStream("video");
  const videoEl = createVideoStub(videoStream);
  const transcripts: MossLiveTranscriptEvent[] = [];
  const isGemini = options.providerType === "gemini-live";

  const controller = createLiveChatController({
    initialShareVideoAudio: options.shareVideoAudio ?? true,
    initialVoicePriority: options.voicePriority ?? false,
    getTargetProviderType: () => options.providerType,
    getTargetOrigin: () =>
      isGemini ? "https://generativelanguage.googleapis.com" : "https://api.mosi.cn",
    getTargetModel: () => (isGemini ? "gemini-3.8-live" : "moss-live-1.0"),
    getVideoElement: () => videoEl,
    getVideoContext: () => sampleVideoContext,
    onTranscript: (ev) => transcripts.push(ev),
    requestOrigins: async () => ({ ok: true }),
    sendRuntimeMessage: (async (msg: { type?: string }) => {
      if (msg.type === "live-session-prepare") {
        return {
          ok: true,
          provider: {
            id: isGemini ? "gemini-live-1" : "moss-live-1",
            type: options.providerType,
            baseUrl: isGemini ? "https://generativelanguage.googleapis.com" : "https://api.mosi.cn",
            model: isGemini ? "gemini-3.8-live" : "moss-live-1.0"
          }
        };
      }
      return { ok: true };
    }) as typeof chrome.runtime.sendMessage,
    connectPort: () => clientSide as unknown as chrome.runtime.Port,
    startAudioCapture: (captureOpts) =>
      createPageAudioCapture({
        ...captureOpts,
        getUserMedia: async () => micStream as unknown as MediaStream,
        createAudioContext: () => captureAudioCtx,
        captureVideoStream: () => videoStream as unknown as MediaStream
      }),
    startVideoCapture: (_videoOpts: PageVideoFrameCaptureOptions): PageVideoFrameCaptureSession => ({
      stop: () => {},
      configure: () => {}
    })
  });

  await controller.start();
  await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const ws = FakeWebSocket.instances[0];
  ws.simulateOpen();
  if (isGemini) {
    ws.simulateMessage(JSON.stringify({ setupComplete: {} }));
  } else {
    ws.simulateMessage(JSON.stringify({ action: "session_attached" }));
    ws.simulateMessage(JSON.stringify({ action: "session.updated", data: { error: "" } }));
  }
  expect(controller.getState()).toBe("connected");

  return {
    controller,
    captureAudioCtx,
    playbackAudioCtx,
    ws,
    transcripts,
    getOffscreenClient: () => offscreenClient!
  };
}

function lastAudioChannelSample(ws: FakeWebSocket, providerType: LiveProviderType): number {
  if (providerType === "gemini-live") {
    const audioFrames = ws.jsonFrames().filter((frame) => frame.realtimeInput?.audio?.data);
    const last = audioFrames.at(-1);
    const pcm = decodeBase64Bytes(last.realtimeInput.audio.data);
    return decodePcmS16LEToFloat32(pcm.buffer)[0];
  }
  const binaryAudio = ws.sentData
    .filter((item): item is Uint8Array => item instanceof Uint8Array)
    .map((buf) => unpackTaggedBinary(buf.buffer))
    .filter((frame) => frame?.tag === MossBinaryTag.AudioPcm);
  const last = binaryAudio.at(-1)!;
  return decodePcmS16LEToFloat32(last.payload.slice().buffer)[0];
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetModuleState();
  resetActiveLiveSessionForTests();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("TextDecoder", TestTextDecoder);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("videoSendGain state transition matrix", () => {
  it.each([
    {
      shareVideoAudio: false,
      aiSpeaking: false,
      userSpeaking: false,
      expectedGain: DEFAULT_VIDEO_SEND_DISABLED_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    },
    {
      shareVideoAudio: false,
      aiSpeaking: false,
      userSpeaking: true,
      expectedGain: DEFAULT_VIDEO_SEND_DISABLED_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    },
    {
      shareVideoAudio: false,
      aiSpeaking: true,
      userSpeaking: false,
      expectedGain: DEFAULT_VIDEO_SEND_DISABLED_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    },
    {
      shareVideoAudio: false,
      aiSpeaking: true,
      userSpeaking: true,
      expectedGain: DEFAULT_VIDEO_SEND_DISABLED_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    },
    {
      shareVideoAudio: true,
      aiSpeaking: false,
      userSpeaking: false,
      expectedGain: DEFAULT_VIDEO_SEND_NORMAL_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_RESTORE_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    },
    {
      shareVideoAudio: true,
      aiSpeaking: false,
      userSpeaking: true,
      expectedGain: DEFAULT_VIDEO_SEND_NORMAL_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_RESTORE_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    },
    {
      shareVideoAudio: true,
      aiSpeaking: true,
      userSpeaking: false,
      expectedGain: DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC,
      expectedAttenuated: true
    },
    {
      shareVideoAudio: true,
      aiSpeaking: true,
      userSpeaking: true,
      expectedGain: DEFAULT_VIDEO_SEND_NORMAL_GAIN,
      expectedTimeConstant: DEFAULT_VIDEO_SEND_RESTORE_TIME_CONSTANT_SEC,
      expectedAttenuated: false
    }
  ])(
    "resolves share=$shareVideoAudio ai=$aiSpeaking user=$userSpeaking -> gain=$expectedGain",
    ({
      shareVideoAudio,
      aiSpeaking,
      userSpeaking,
      expectedGain,
      expectedTimeConstant,
      expectedAttenuated
    }) => {
      const transition = resolveVideoSendGainTarget({
        shareVideoAudio,
        aiSpeaking,
        userSpeaking
      });
      expect(transition).toEqual({
        targetGain: expectedGain,
        timeConstantSec: expectedTimeConstant,
        attenuated: expectedAttenuated
      });
    }
  );
});

describe("Pre-stage split Web Audio topology, 60ms pure-mic debounce, and videoSendGain smoothing", () => {
  it("isolates pure-mic VAD from loud video, ignores <=40ms transients, and smoothly ramps videoSendGain", async () => {
    const micStream = new FakeMediaStream("mic");
    const videoStream = new FakeMediaStream("video");
    const videoEl = createVideoStub(videoStream);
    const captureAudioCtx = new SpyCaptureAudioContext(MOSS_UPSTREAM_SAMPLE_RATE);
    const pcmFrames: Uint8Array[] = [];
    const bargeInEvents: boolean[] = [];

    const capture = await createPageAudioCapture({
      shareVideoAudio: true,
      onPcmFrame: (pcm) => pcmFrames.push(pcm),
      onBargeInSpeechChange: (active) => bargeInEvents.push(active),
      getUserMedia: async () => micStream as unknown as MediaStream,
      createAudioContext: () => captureAudioCtx,
      getVideoElement: () => videoEl,
      captureVideoStream: () => videoStream as unknown as MediaStream
    });

    expect(captureAudioCtx.micSource.connections).toEqual([
      { destination: captureAudioCtx.workletNode, outputIndex: 0, inputIndex: 0 }
    ]);
    expect(captureAudioCtx.videoSource.connections).toEqual([
      { destination: captureAudioCtx.videoSendGain, outputIndex: undefined, inputIndex: undefined }
    ]);
    expect(captureAudioCtx.videoSendGain.connections).toEqual([
      { destination: captureAudioCtx.workletNode, outputIndex: 0, inputIndex: 1 }
    ]);
    expect(captureAudioCtx.workletNode?.connections).toEqual([
      { destination: captureAudioCtx.silentGain, outputIndex: undefined, inputIndex: undefined }
    ]);
    expect(captureAudioCtx.silentGain.gain.value).toBe(0);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_NORMAL_GAIN);
    expect(captureAudioCtx.videoSendGain.setTargetCalls).toEqual([]);

    captureAudioCtx.emitSamples(new Float32Array(640).fill(0), new Float32Array(640).fill(0.6));
    expect(capture.isMicVadActive()).toBe(false);
    expect(capture.isBargeInSpeechActive?.()).toBe(false);
    expect(bargeInEvents).toEqual([]);
    expect(decodePcmS16LEToFloat32(pcmFrames.at(-1)!.buffer)[0]).toBeCloseTo(0.6, 2);

    captureAudioCtx.currentTime = 1.25;
    capture.setAiSpeaking?.(true);
    expect(capture.isAiSpeaking?.()).toBe(true);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN);
    expect(captureAudioCtx.videoSendGain.cancelAndHoldCalls).toEqual([1.25]);
    expect(captureAudioCtx.videoSendGain.setTargetCalls).toEqual([
      {
        target: DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN,
        startTime: 1.25,
        timeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC
      }
    ]);
    expect(captureAudioCtx.videoSendGain.valueSets).toEqual([DEFAULT_VIDEO_SEND_NORMAL_GAIN]);

    captureAudioCtx.emitSamples(new Float32Array(640).fill(0), new Float32Array(640).fill(0.6));
    expect(decodePcmS16LEToFloat32(pcmFrames.at(-1)!.buffer)[0]).toBeCloseTo(0.036, 2);

    captureAudioCtx.emitSamples(new Float32Array(320).fill(0.35), new Float32Array(320).fill(0.5));
    captureAudioCtx.emitSamples(new Float32Array(320).fill(0), new Float32Array(320).fill(0.5));
    expect(bargeInEvents).toEqual([]);
    expect(capture.isBargeInSpeechActive?.()).toBe(false);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN);

    captureAudioCtx.emitSamples(new Float32Array(640).fill(0.35), new Float32Array(640).fill(0.5));
    captureAudioCtx.emitSamples(new Float32Array(320).fill(0), new Float32Array(320).fill(0.5));
    expect(bargeInEvents).toEqual([]);
    expect(capture.isBargeInSpeechActive?.()).toBe(false);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN);

    captureAudioCtx.currentTime = 1.5;
    captureAudioCtx.emitSamples(new Float32Array(960).fill(0.25), new Float32Array(960).fill(0.5));
    expect(bargeInEvents).toEqual([true]);
    expect(capture.isBargeInSpeechActive?.()).toBe(true);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_NORMAL_GAIN);
    expect(captureAudioCtx.videoSendGain.setTargetCalls.at(-1)).toEqual({
      target: DEFAULT_VIDEO_SEND_NORMAL_GAIN,
      startTime: 1.5,
      timeConstant: DEFAULT_VIDEO_SEND_RESTORE_TIME_CONSTANT_SEC
    });

    captureAudioCtx.currentTime = 1.75;
    capture.setShareVideoAudio(false);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_DISABLED_GAIN);
    expect(captureAudioCtx.videoSendGain.setTargetCalls.at(-1)).toEqual({
      target: DEFAULT_VIDEO_SEND_DISABLED_GAIN,
      startTime: 1.75,
      timeConstant: DEFAULT_VIDEO_SEND_DUCK_TIME_CONSTANT_SEC
    });

    captureAudioCtx.currentTime = 2.0;
    capture.setAiSpeaking?.(false);
    capture.setShareVideoAudio(true);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_NORMAL_GAIN);

    captureAudioCtx.emitSamples(new Float32Array(320).fill(0), new Float32Array(320).fill(0.5));
    captureAudioCtx.currentTime = 2.1;
    capture.setAiSpeaking?.(true);
    expect(capture.isBargeInSpeechActive?.()).toBe(false);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN);

    captureAudioCtx.currentTime = 2.3;
    capture.setAiSpeaking?.(false);
    expect(capture.getVideoSendGainTarget?.()).toBe(DEFAULT_VIDEO_SEND_NORMAL_GAIN);

    capture.stop();
    expect(captureAudioCtx.videoSendGain.disconnected).toBe(true);
  });

  it("debounces 60~80ms consecutive speech at 48kHz Web Audio 128-sample quanta", () => {
    const bargeInEvents: boolean[] = [];
    const core = createPcmCaptureCore({
      sampleRate: 48000,
      onPcmBatch: () => {},
      onBargeInChange: (active) => bargeInEvents.push(active)
    });

    core.processQuantum(new Float32Array(1920).fill(0.25), undefined, 48000);
    expect(bargeInEvents).toEqual([]);
    expect(core.isBargeInActive()).toBe(false);

    core.processQuantum(new Float32Array(960).fill(0), undefined, 48000);
    expect(bargeInEvents).toEqual([]);

    core.processQuantum(new Float32Array(2816).fill(0.25), undefined, 48000);
    expect(bargeInEvents).toEqual([]);
    core.processQuantum(new Float32Array(128).fill(0.25), undefined, 48000);
    expect(bargeInEvents).toEqual([true]);
    expect(core.isBargeInActive()).toBe(true);
  });
});

describe("End-to-end 0ms optimistic barge-in & server seal idempotency (Gemini Live)", () => {
  function serverContent(content: Record<string, unknown>): string {
    return JSON.stringify({ serverContent: content });
  }

  it("stops playback at 0ms, drops late old-turn chunks even after new interimInputTranscription, and aligns idempotently with interrupted:true", async () => {
    const { controller, captureAudioCtx, playbackAudioCtx, ws, transcripts, getOffscreenClient } =
      await setupEndToEndLiveSession({
        providerType: "gemini-live",
        shareVideoAudio: true,
        voicePriority: false
      });

    ws.simulateMessage(
      serverContent({
        outputTranscription: { text: "这一段的原理是" },
        modelTurn: {
          parts: [
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.2) } },
            { inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.25) } }
          ]
        }
      })
    );

    expect(controller.isSpeaking()).toBe(true);
    expect(playbackAudioCtx.sources).toHaveLength(2);
    expect(playbackAudioCtx.sources[0].stopped).toBe(false);
    expect(captureAudioCtx.videoSendGain.effectiveTargetGain).toBe(DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN);

    captureAudioCtx.emitSamples(new Float32Array(640).fill(0), new Float32Array(640).fill(0.6));
    expect(lastAudioChannelSample(ws, "gemini-live")).toBeCloseTo(0.036, 2);
    expect(playbackAudioCtx.sources[0].stopped).toBe(false);
    expect(controller.isSpeaking()).toBe(true);

    captureAudioCtx.emitSamples(new Float32Array(640).fill(0.3), new Float32Array(640).fill(0.5));
    captureAudioCtx.emitSamples(new Float32Array(320).fill(0), new Float32Array(320).fill(0.5));
    expect(playbackAudioCtx.sources[0].stopped).toBe(false);
    expect(controller.isSpeaking()).toBe(true);

    captureAudioCtx.emitSamples(new Float32Array(960).fill(0.25), new Float32Array(960).fill(0.5));

    expect(playbackAudioCtx.sources[0].stopped).toBe(true);
    expect(playbackAudioCtx.sources[1].stopped).toBe(true);
    expect(controller.isSpeaking()).toBe(false);
    expect(getOffscreenClient().isSpeaking()).toBe(false);
    expect(getOffscreenClient().getInterruptEpoch()).toBe(1);
    expect(captureAudioCtx.videoSendGain.effectiveTargetGain).toBe(DEFAULT_VIDEO_SEND_NORMAL_GAIN);
    expect(transcripts.filter((t) => t.kind === "response.interrupted")).toHaveLength(1);
    const interruptedTurnId = (
      transcripts.find((t) => t.kind === "response.interrupted") as Extract<
        MossLiveTranscriptEvent,
        { kind: "response.interrupted" }
      >
    ).turnId;

    ws.simulateMessage(
      serverContent({
        outputTranscription: { text: "在途半个字" },
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.3) } }]
        }
      })
    );
    expect(playbackAudioCtx.sources).toHaveLength(2);

    ws.simulateMessage(serverContent({ interimInputTranscription: { text: "等一下" } }));

    ws.simulateMessage(
      serverContent({
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.35) } }]
        }
      })
    );
    expect(playbackAudioCtx.sources).toHaveLength(2);
    expect(transcripts.some((t) => t.kind === "output.updated" && t.text.includes("在途半个字"))).toBe(
      false
    );

    ws.simulateMessage(serverContent({ interrupted: true }));
    expect(transcripts.filter((t) => t.kind === "response.interrupted")).toHaveLength(1);
    expect(getOffscreenClient().isSpeaking()).toBe(false);

    ws.simulateMessage(serverContent({ inputTranscription: { text: "先讲重点" } }));
    ws.simulateMessage(
      serverContent({
        outputTranscription: { text: "重点是三点" },
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.45) } }]
        }
      })
    );
    expect(playbackAudioCtx.sources).toHaveLength(3);
    expect(playbackAudioCtx.sources[2].stopped).toBe(false);
    expect(controller.isSpeaking()).toBe(true);
    const newOutput = transcripts.at(-1) as Extract<
      MossLiveTranscriptEvent,
      { kind: "output.updated" }
    >;
    expect(newOutput).toMatchObject({ kind: "output.updated", text: "重点是三点" });
    expect(newOutput.turnId).not.toBe(interruptedTurnId);

    await controller.stop();
  });

  it("seals an interrupted Gemini turn idempotently when the server closes it with turnComplete:true instead of interrupted:true", async () => {
    const { controller, captureAudioCtx, playbackAudioCtx, ws, transcripts } =
      await setupEndToEndLiveSession({
        providerType: "gemini-live",
        shareVideoAudio: true,
        voicePriority: true
      });

    ws.simulateMessage(
      serverContent({
        outputTranscription: { text: "旧回答" },
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.2) } }]
        }
      })
    );
    expect(playbackAudioCtx.sources).toHaveLength(1);

    captureAudioCtx.emitSamples(new Float32Array(960).fill(0.25));
    expect(playbackAudioCtx.sources[0].stopped).toBe(true);
    expect(transcripts.filter((t) => t.kind === "response.interrupted")).toHaveLength(1);

    ws.simulateMessage(serverContent({ interimInputTranscription: { text: "新问题" } }));
    ws.simulateMessage(
      serverContent({
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.3) } }]
        }
      })
    );
    ws.simulateMessage(serverContent({ turnComplete: true }));
    expect(playbackAudioCtx.sources).toHaveLength(1);
    expect(transcripts.some((t) => t.kind === "response.ended")).toBe(false);

    ws.simulateMessage(
      serverContent({
        outputTranscription: { text: "新回答" },
        modelTurn: {
          parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: geminiAudioPartBase64(2400, 0.4) } }]
        }
      })
    );
    expect(playbackAudioCtx.sources).toHaveLength(2);
    expect(playbackAudioCtx.sources[1].stopped).toBe(false);

    await controller.stop();
  });
});

describe("End-to-end 0ms optimistic barge-in & split-frame alignment (MOSS-LIVE)", () => {
  it("keeps split audio.context/binary PCM frames 1:1 aligned across 0ms barge-in, drops in-flight chunks, and ignores duplicate server interrupt/stop", async () => {
    const { controller, captureAudioCtx, playbackAudioCtx, ws, transcripts, getOffscreenClient } =
      await setupEndToEndLiveSession({
        providerType: "moss-live",
        shareVideoAudio: true,
        voicePriority: false
      });

    ws.sentData.length = 0;

    ws.simulateMessage(
      JSON.stringify({ action: "output.transcript.updated", data: { text: "先听第一句", run_id: "r1", turn_id: "t1" } })
    );
    ws.simulateMessage(
      JSON.stringify({ action: "response.audio.context", data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" } })
    );
    ws.simulateMessage(encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.15)).buffer);
    ws.simulateMessage(
      JSON.stringify({ action: "response.audio.context", data: { chunk_id: "c2", run_id: "r1", turn_id: "t1" } })
    );

    expect(playbackAudioCtx.sources).toHaveLength(1);
    expect(controller.isSpeaking()).toBe(true);
    expect(captureAudioCtx.videoSendGain.effectiveTargetGain).toBe(DEFAULT_VIDEO_SEND_AI_SPEAKING_GAIN);

    captureAudioCtx.emitSamples(new Float32Array(960).fill(0.25), new Float32Array(960).fill(0.4));
    expect(playbackAudioCtx.sources[0].stopped).toBe(true);
    expect(controller.isSpeaking()).toBe(false);
    expect(getOffscreenClient().isSpeaking()).toBe(false);
    expect(captureAudioCtx.videoSendGain.effectiveTargetGain).toBe(DEFAULT_VIDEO_SEND_NORMAL_GAIN);
    expect(transcripts.filter((t) => t.kind === "response.interrupted")).toHaveLength(1);
    expect(
      ws.jsonFrames().filter((frame) => frame.action === "playback.stopped")
    ).toHaveLength(1);

    ws.simulateMessage(encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.88)).buffer);
    ws.simulateMessage(
      JSON.stringify({ action: "response.audio.context", data: { chunk_id: "c3", run_id: "r1", turn_id: "t1" } })
    );
    ws.simulateMessage(encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.77)).buffer);
    ws.simulateMessage(
      JSON.stringify({ action: "output.transcript.updated", data: { text: "迟到尾巴", run_id: "r1", turn_id: "t1" } })
    );
    expect(playbackAudioCtx.sources).toHaveLength(1);

    ws.simulateMessage(JSON.stringify({ action: "response.interrupted", data: { run_id: "r1", turn_id: "t1" } }));
    ws.simulateMessage(JSON.stringify({ action: "response.audio.stop", data: { run_id: "r1", turn_id: "t1" } }));
    ws.simulateMessage(JSON.stringify({ action: "response.audio.done", data: { run_id: "r1", turn_id: "t1" } }));
    ws.simulateMessage(
      JSON.stringify({ action: "response.ended", data: { status: "completed", run_id: "r1", turn_id: "t1" } })
    );

    expect(transcripts.filter((t) => t.kind === "response.interrupted")).toHaveLength(1);
    expect(transcripts.some((t) => t.kind === "response.ended")).toBe(false);
    expect(
      ws.jsonFrames().filter((frame) => frame.action === "playback.stopped")
    ).toHaveLength(1);

    ws.simulateMessage(
      JSON.stringify({ action: "response.audio.context", data: { chunk_id: "c4", run_id: "r2", turn_id: "t2" } })
    );
    ws.simulateMessage(encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.42)).buffer);
    expect(playbackAudioCtx.sources).toHaveLength(2);
    expect(playbackAudioCtx.sources[1].stopped).toBe(false);
    expect(playbackAudioCtx.sources[1].buffer?.channelData[0]).toBeCloseTo(0.42, 2);

    await controller.stop();
  });

  it("pre-seals a text-only active turn on 0ms barge-in so its late arriving audio chunks never start playing", async () => {
    const { controller, captureAudioCtx, playbackAudioCtx, ws, transcripts } =
      await setupEndToEndLiveSession({
        providerType: "moss-live",
        shareVideoAudio: false
      });

    ws.simulateMessage(
      JSON.stringify({ action: "output.transcript.updated", data: { text: "准备开口", run_id: "r1", turn_id: "t1" } })
    );
    expect(controller.isSpeaking()).toBe(true);

    captureAudioCtx.emitSamples(new Float32Array(960).fill(0.25));
    expect(controller.isSpeaking()).toBe(false);
    expect(transcripts.filter((t) => t.kind === "response.interrupted")).toHaveLength(1);

    ws.simulateMessage(
      JSON.stringify({ action: "response.audio.context", data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" } })
    );
    ws.simulateMessage(encodeFloat32ToPcmS16LE(new Float32Array(2400).fill(0.3)).buffer);
    expect(playbackAudioCtx.sources).toHaveLength(0);
    expect(controller.isSpeaking()).toBe(false);

    await controller.stop();
  });
});
