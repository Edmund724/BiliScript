import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createLiveChatController } from "../../extension/live/live-chat-controller.js";
import {
  createPageAudioCapture,
  type PageAudioContextLike,
  type PageAudioWorkletNodeLike
} from "../../extension/live/page-media-capture.js";
import {
  MOSS_UPSTREAM_SAMPLE_RATE,
  PCM_CAPTURE_PROCESSOR_NAME,
  PCM_WORKLET_BATCH_BYTES,
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
import {
  MossBinaryTag,
  decodeBase64Bytes,
  unpackTaggedBinary,
  type LiveProviderType,
  type MossLiveVideoContext
} from "../../extension/live/moss-live-protocol.js";
import {
  MOSS_LOW_BANDWIDTH_VIDEO_CONFIG,
  type MossVideoCaptureConfig
} from "../../extension/live/moss-video-config.js";
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

  constructor(tracks = [new FakeMediaStreamTrack()]) {
    this.tracks = tracks;
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }
}

class FakeCaptureAudioContext implements PageAudioContextLike {
  readonly sampleRate: number;
  state = "running";
  readonly destination = {};
  closed = false;
  workletStopped = false;
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

  createMediaStreamSource(_stream: MediaStream) {
    return {
      connect: (_dest: unknown) => {},
      disconnect: () => {}
    };
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
        if (msg.type === "config") {
          core.setConfig(msg);
        }
      }
    };
    this.workletPort = port;

    return {
      port,
      connect: (_dest: unknown) => {},
      disconnect: () => {}
    };
  }

  createGain() {
    return {
      gain: { value: 1 },
      connect: (_dest: unknown) => {},
      disconnect: () => {}
    };
  }

  emitSamples(
    samples?: Float32Array,
    videoSamples?: Float32Array | Float32Array[],
    quantumFrames?: number
  ): void {
    if (this.workletStopped || !this.workletCore) return;
    const videoChannels = Array.isArray(videoSamples)
      ? videoSamples
      : videoSamples
        ? [videoSamples]
        : undefined;
    this.workletCore.processQuantum(samples, videoChannels, this.sampleRate, quantumFrames);
  }

  simulateLateWorkletPcm(pcmBuffer: ArrayBuffer, hadSpeech = true): void {
    if (this.workletStopped) return;
    this.workletPort?.onmessage?.({
      data: { type: "pcm", pcmBuffer, hadSpeech }
    } as MessageEvent<PcmCaptureWorkletToMainMessage>);
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

  binaryFrames(): Uint8Array[] {
    return this.sentData.filter((data): data is Uint8Array => data instanceof Uint8Array);
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

class SpyVideoCapture implements PageVideoFrameCaptureSession {
  config: Partial<MossVideoCaptureConfig> | null;

  constructor(options: PageVideoFrameCaptureOptions) {
    this.config = options.config ?? null;
  }

  configure(next: Partial<MossVideoCaptureConfig>): void {
    this.config = { ...this.config, ...next };
  }

  stop(): void {}
}

const sampleVideoContext: MossLiveVideoContext = {
  url: "https://www.bilibili.com/video/BV1audio/",
  bvid: "BV1audio",
  cid: "101",
  title: "伴看上行音频测试",
  pageIndex: 1,
  pageCount: 1,
  pageTitle: "P1",
  chapters: []
};

async function setupEndToEndLivePipeline(options: {
  providerType: LiveProviderType;
  liveLowBandwidth?: boolean;
  shareVideoAudio?: boolean;
}) {
  const { clientSide, offscreenSide } = createDuplexPortPair();
  attachMossLivePort(offscreenSide as unknown as chrome.runtime.Port, {
    loadClient: async (providerType) => {
      if (providerType === "gemini-live") {
        return (opts) => new OffscreenGeminiLiveClient({ ...opts, model: "gemini-3.8-live" });
      }
      return (opts) => new OffscreenMossLiveClient(opts);
    }
  });

  const micStream = new FakeMediaStream();
  const audioCtx = new FakeCaptureAudioContext(MOSS_UPSTREAM_SAMPLE_RATE);
  const videoTrack = new FakeMediaStreamTrack();
  const videoStream = new FakeMediaStream([videoTrack]);
  const videoEl = {
    muted: false,
    volume: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    captureStream: () => videoStream
  } as unknown as HTMLVideoElement;

  let videoCapture: SpyVideoCapture | null = null;
  let micVadActive = false;
  const isGemini = options.providerType === "gemini-live";
  const providerRecord = {
    id: isGemini ? "gemini-live-1" : "moss-live-1",
    type: options.providerType,
    baseUrl: isGemini ? "https://generativelanguage.googleapis.com" : "https://api.mosi.cn",
    model: isGemini ? "gemini-3.8-live" : "moss-live-1.0",
    enabled: true,
    hasSavedKey: true
  };

  const controller = createLiveChatController({
    initialShareVideoAudio: Boolean(options.shareVideoAudio),
    getVideoElement: () => videoEl,
    getVideoContext: () => sampleVideoContext,
    onVadStateChange: (active) => {
      micVadActive = active;
    },
    requestOrigins: async () => ({ ok: true }),
    sendRuntimeMessage: (async (msg: { type?: string }) => {
      if (msg.type === "live-providers-list") {
        return { ok: true, providers: [providerRecord] };
      }
      if (msg.type === "get-settings") {
        return { ok: true, settings: { activeLiveProviderId: providerRecord.id } };
      }
      if (msg.type === "live-session-prepare") {
        return {
          ok: true,
          liveLowBandwidth: Boolean(options.liveLowBandwidth),
          provider: providerRecord
        };
      }
      return { ok: true };
    }) as typeof chrome.runtime.sendMessage,
    connectPort: () => clientSide as unknown as chrome.runtime.Port,
    startAudioCapture: (captureOpts) =>
      createPageAudioCapture({
        ...captureOpts,
        getUserMedia: async () => micStream as unknown as MediaStream,
        createAudioContext: () => audioCtx,
        captureVideoStream: () => videoStream as unknown as MediaStream
      }),
    startVideoCapture: (videoOpts) => {
      videoCapture = new SpyVideoCapture(videoOpts);
      return videoCapture;
    }
  });

  await controller.refreshTarget();
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
    audioCtx,
    micStream,
    ws,
    isMicVadActive: () => micVadActive,
    getVideoCapture: () => videoCapture!
  };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetModuleState();
  resetActiveLiveSessionForTests();
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("实时伴看上行音频连续性与闭麦状态机全链路验证", () => {
  it("① 静音输入、本地 VAD 低能量及 liveLowBandwidth: true 时，16kHz PCM 静音帧持续连续发出", async () => {
    const { controller, audioCtx, ws, isMicVadActive, getVideoCapture } = await setupEndToEndLivePipeline({
      providerType: "gemini-live",
      liveLowBandwidth: true
    });

    expect(getVideoCapture().config).toEqual(MOSS_LOW_BANDWIDTH_VIDEO_CONFIG);
    ws.sentData.length = 0;

    audioCtx.emitSamples(new Float32Array(640).fill(0));
    expect(isMicVadActive()).toBe(false);

    audioCtx.emitSamples(new Float32Array(640).fill(0.25));
    expect(isMicVadActive()).toBe(true);
    audioCtx.emitSamples(new Float32Array(5120).fill(0.001));
    expect(isMicVadActive()).toBe(false);

    audioCtx.emitSamples(undefined, undefined, 128);
    audioCtx.emitSamples(undefined, undefined, 128);
    audioCtx.emitSamples(undefined, undefined, 128);
    audioCtx.emitSamples(undefined, undefined, 128);
    audioCtx.emitSamples(undefined, undefined, 128);

    const audioFrames = ws.jsonFrames();
    expect(audioFrames).toHaveLength(11);
    expect(audioFrames[0]).toEqual({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=16000", data: expect.any(String) }
      }
    });
    expect(decodeBase64Bytes(audioFrames[0].realtimeInput.audio.data).byteLength).toBe(
      PCM_WORKLET_BATCH_BYTES
    );
    expect(decodeBase64Bytes(audioFrames[10].realtimeInput.audio.data)).toEqual(
      new Uint8Array(PCM_WORKLET_BATCH_BYTES)
    );
    expect(decodePcmS16LEToFloat32(decodeBase64Bytes(audioFrames[1].realtimeInput.audio.data).buffer)[0]).toBeCloseTo(
      0.25,
      2
    );

    await controller.stop();
  });

  it("② Gemini Live 切换闭麦精确触发一次 audioStreamEnd: true、拦截在途采样，Unmute 后不重连恢复发送", async () => {
    const { controller, audioCtx, micStream, ws } = await setupEndToEndLivePipeline({
      providerType: "gemini-live",
      shareVideoAudio: true
    });
    ws.sentData.length = 0;

    audioCtx.emitSamples(new Float32Array(640).fill(0.3), new Float32Array(640).fill(0.4));
    expect(ws.jsonFrames()).toHaveLength(1);
    expect(ws.jsonFrames()[0].realtimeInput.audio).toBeDefined();

    controller.setMuted(true);
    controller.setMuted(true);
    expect(controller.isMuted()).toBe(true);
    expect(micStream.tracks[0].enabled).toBe(false);

    const afterMuteFrames = ws.jsonFrames().slice(1);
    expect(afterMuteFrames).toEqual([{ realtimeInput: { audioStreamEnd: true } }]);

    audioCtx.emitSamples(new Float32Array(640).fill(0.5), new Float32Array(640).fill(0.4));
    audioCtx.simulateLateWorkletPcm(new Uint8Array(PCM_WORKLET_BATCH_BYTES).fill(0x2a).buffer, true);
    expect(ws.jsonFrames()).toHaveLength(2);

    controller.setMuted(false);
    expect(controller.isMuted()).toBe(false);
    expect(micStream.tracks[0].enabled).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(1);

    audioCtx.emitSamples(new Float32Array(640).fill(0));
    expect(ws.jsonFrames()).toHaveLength(3);
    expect(ws.jsonFrames()[2]).toEqual({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=16000", data: expect.any(String) }
      }
    });
    expect(decodeBase64Bytes(ws.jsonFrames()[2].realtimeInput.audio.data)).toEqual(
      new Uint8Array(PCM_WORKLET_BATCH_BYTES)
    );

    await controller.stop();
  });

  it("③ MOSS Live 切换闭麦触发单次 mic_state: false 并停发 0x00 二进制帧，Unmute 后平滑恢复", async () => {
    const { controller, audioCtx, ws } = await setupEndToEndLivePipeline({
      providerType: "moss-live",
      shareVideoAudio: true
    });
    ws.sentData.length = 0;

    audioCtx.emitSamples(new Float32Array(640).fill(0.2));
    expect(ws.binaryFrames()).toHaveLength(2);
    expect(unpackTaggedBinary(ws.binaryFrames()[0].buffer)?.tag).toBe(MossBinaryTag.AudioPcm);

    controller.setMuted(true);
    controller.setMuted(true);
    expect(ws.jsonFrames()).toEqual([{ action: "mic_state", enabled: false }]);

    audioCtx.emitSamples(new Float32Array(640).fill(0.4), new Float32Array(640).fill(0.4));
    audioCtx.simulateLateWorkletPcm(new Uint8Array(PCM_WORKLET_BATCH_BYTES).fill(0x33).buffer, true);
    expect(ws.binaryFrames()).toHaveLength(2);

    controller.setMuted(false);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(ws.jsonFrames()).toEqual([
      { action: "mic_state", enabled: false },
      { action: "mic_state", enabled: true }
    ]);

    audioCtx.emitSamples(new Float32Array(640).fill(0));
    expect(ws.binaryFrames()).toHaveLength(4);
    expect(unpackTaggedBinary(ws.binaryFrames()[2].buffer)?.tag).toBe(MossBinaryTag.AudioPcm);
    expect(unpackTaggedBinary(ws.binaryFrames()[3].buffer)?.tag).toBe(MossBinaryTag.AudioPcm);

    await controller.stop();
  });
});
