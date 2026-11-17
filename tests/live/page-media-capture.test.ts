// tests/live/page-media-capture.test.ts
// 页面侧 AudioWorklet 采集与 DSP 纯内核（混音、VAD、重采样、1280B 批量分帧）单元测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createPageAudioCapture,
  formatMediaCaptureError,
  formatMicCaptureError,
  type PageAudioContextLike,
  type PageAudioWorkletNodeLike,
  type VideoAudioTrackStatus
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

class FakeMediaStreamTrack {
  enabled = true;
  stopped = false;
  private endedListeners = new Set<() => void>();

  addEventListener(type: string, listener: () => void) {
    if (type === "ended") this.endedListeners.add(listener);
  }

  removeEventListener(type: string, listener: () => void) {
    if (type === "ended") this.endedListeners.delete(listener);
  }

  end() {
    for (const listener of [...this.endedListeners]) listener();
  }

  stop() {
    this.stopped = true;
  }
}

class FakeMediaStream {
  tracks: FakeMediaStreamTrack[];
  constructor(tracks = [new FakeMediaStreamTrack()]) {
    this.tracks = tracks;
  }
  getAudioTracks() {
    return this.tracks;
  }
  getTracks() {
    return this.tracks;
  }
}

class FakeCaptureAudioContext implements PageAudioContextLike {
  sampleRate: number;
  state = "running";
  destination = {};
  closed = false;
  sourceConnected = false;
  workletConnected = false;
  gainConnected = false;
  gainValue = 1;
  addedModuleUrls: string[] = [];
  postedToWorklet: PcmCaptureMainToWorkletMessage[] = [];
  workletStopped = false;
  addModuleError: Error | null = null;
  private workletCore: ReturnType<typeof createPcmCaptureCore> | null = null;
  private workletPort: PageAudioWorkletNodeLike["port"] | null = null;

  constructor(sampleRate = MOSS_UPSTREAM_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
  }

  readonly audioWorklet = {
    addModule: async (moduleURL: string): Promise<void> => {
      this.addedModuleUrls.push(moduleURL);
      if (this.addModuleError) {
        throw this.addModuleError;
      }
    }
  };

  async resume(): Promise<void> {
    this.state = "running";
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  createMediaStreamSource(_stream: MediaStream) {
    return {
      connect: (_dest: unknown) => {
        this.sourceConnected = true;
      },
      disconnect: () => {
        this.sourceConnected = false;
      }
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
        this.postedToWorklet.push(msg);
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
      connect: (_dest: unknown) => {
        this.workletConnected = true;
      },
      disconnect: () => {
        this.workletConnected = false;
      }
    };
  }

  createGain() {
    const self = this;
    const gainParam = {
      get value() {
        return self.gainValue;
      },
      set value(v: number) {
        self.gainValue = v;
      }
    };
    return {
      gain: gainParam,
      connect: (_dest: unknown) => {
        self.gainConnected = true;
      },
      disconnect: () => {
        self.gainConnected = false;
      }
    };
  }

  emitSamples(samples?: Float32Array, videoSamples?: Float32Array | Float32Array[], quantumFrames?: number) {
    if (this.workletStopped || !this.workletCore) return;
    const videoChannels = Array.isArray(videoSamples)
      ? videoSamples
      : videoSamples
        ? [videoSamples]
        : undefined;
    this.workletCore.processQuantum(samples, videoChannels, this.sampleRate, quantumFrames);
  }

  simulateWorkletMessage(msg: PcmCaptureWorkletToMainMessage) {
    if (this.workletStopped) return;
    this.workletPort?.onmessage?.({ data: msg } as MessageEvent<PcmCaptureWorkletToMainMessage>);
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
  resetModuleState();
});

function feedQuanta(
  core: ReturnType<typeof createPcmCaptureCore>,
  quantaCount: number,
  sampleRate: number,
  micFill: number,
  videoLeftFill?: number,
  videoRightFill?: number
): void {
  const videoChannels =
    videoLeftFill !== undefined && videoRightFill !== undefined
      ? [new Float32Array(128).fill(videoLeftFill), new Float32Array(128).fill(videoRightFill)]
      : undefined;
  for (let i = 0; i < quantaCount; i++) {
    core.processQuantum(new Float32Array(128).fill(micFill), videoChannels, sampleRate);
  }
}

describe("createPcmCaptureCore (AudioWorklet DSP pure core)", () => {
  it("resamples 48kHz 128-sample quanta continuously into exact 40ms (1280-byte) batches", () => {
    const batches: Array<{ buffer: ArrayBuffer; hadSpeech: boolean }> = [];
    const core = createPcmCaptureCore({
      sampleRate: 48000,
      onPcmBatch: (buffer, hadSpeech) => batches.push({ buffer, hadSpeech })
    });

    // 15 quanta * 128 samples = 1920 samples @ 48kHz = exact 40ms (640 samples @ 16kHz = 1280B)
    feedQuanta(core, 14, 48000, 0.25);
    expect(batches).toHaveLength(0);

    core.processQuantum(new Float32Array(128).fill(0.25), undefined, 48000);
    expect(batches).toHaveLength(1);
    expect(batches[0].buffer.byteLength).toBe(PCM_WORKLET_BATCH_BYTES);
    expect(batches[0].hadSpeech).toBe(true);

    const decoded = decodePcmS16LEToFloat32(batches[0].buffer);
    expect(decoded.length).toBe(640);
    expect(decoded[0]).toBeCloseTo(0.25, 2);
    expect(decoded[639]).toBeCloseTo(0.25, 2);
  });

  it("downmixes stereo video audio, ducks video to 0.15 during mic VAD, and releases via sample count", () => {
    const batches: ArrayBuffer[] = [];
    const vadStates: boolean[] = [];
    const heartbeats: number[] = [];

    const core = createPcmCaptureCore({
      sampleRate: 16000,
      initialConfig: {
        mixVideo: true,
        vadReleaseMs: 300,
        upstreamVideoDuckGain: 0.15
      },
      onPcmBatch: (buffer) => batches.push(buffer),
      onVadChange: (active) => vadStates.push(active),
      onSpeechHeartbeat: () => heartbeats.push(1)
    });

    // 1. Silent mic, stereo video (0.2 and 0.6 -> average 0.4 at 100% gain)
    // 5 quanta * 128 = 640 samples = 40ms batch
    feedQuanta(core, 5, 16000, 0, 0.2, 0.6);
    expect(vadStates).toEqual([]);
    expect(batches).toHaveLength(1);
    expect(decodePcmS16LEToFloat32(batches[0])[0]).toBeCloseTo(0.4, 2);

    // 2. Mic speaking (0.2 >= 0.015) + stereo video (avg 0.4) -> ducked to 0.2 + 0.4 * 0.15 = 0.26
    // 1st quantum activates VAD (heartbeat counter starts at 0); 25 additional quanta * 128 = 3200 samples (200ms) trigger heartbeat
    feedQuanta(core, 26, 16000, 0.2, 0.2, 0.6);
    expect(vadStates).toEqual([true]);
    expect(heartbeats).toEqual([1]);
    const duckedSamples = decodePcmS16LEToFloat32(batches[1]);
    expect(duckedSamples[0]).toBeCloseTo(0.26, 2);

    // 3. Silence below vadReleaseMs (300ms @ 16kHz = 4800 samples): 37 * 128 = 4736 < 4800
    feedQuanta(core, 37, 16000, 0.001);
    expect(core.isVadActive()).toBe(true);

    // 38th quantum (4864 >= 4800) releases VAD without setTimeout
    core.processQuantum(new Float32Array(128).fill(0.001), undefined, 16000);
    expect(core.isVadActive()).toBe(false);
    expect(vadStates).toEqual([true, false]);
  });

  it("drops output and resets buffered samples when muted without mixVideo", () => {
    const batches: ArrayBuffer[] = [];
    const core = createPcmCaptureCore({
      sampleRate: 16000,
      onPcmBatch: (buffer) => batches.push(buffer)
    });

    // Partial buffer (384 < 640)
    feedQuanta(core, 3, 16000, 0.5);
    expect(batches).toHaveLength(0);

    core.setConfig({ muted: true });
    core.processQuantum(new Float32Array(640).fill(0.5), undefined, 16000);
    expect(batches).toHaveLength(0);

    // Unmute: stale 384 samples were dropped, so 256 new samples do not flush yet
    core.setConfig({ muted: false });
    core.processQuantum(new Float32Array(256).fill(0.5), undefined, 16000);
    expect(batches).toHaveLength(0);
    core.processQuantum(new Float32Array(384).fill(0.5), undefined, 16000);
    expect(batches).toHaveLength(1);
  });

  it("continuously outputs 1280-byte zero PCM frames on silence, after VAD release, and when micChannel is empty with quantumFrames = 128", () => {
    const batches: ArrayBuffer[] = [];
    const core = createPcmCaptureCore({
      sampleRate: 16000,
      initialConfig: { vadReleaseMs: 300 },
      onPcmBatch: (buffer) => batches.push(buffer)
    });

    // 1. 说话激活 VAD（1 帧）
    core.processQuantum(new Float32Array(640).fill(0.25), undefined, 16000);
    expect(core.isVadActive()).toBe(true);
    expect(batches).toHaveLength(1);

    // 2. 低能量静音触发 VAD 释放（4800 采样 = 300ms -> 5120 采样跨过释放门槛，共输出 8 帧）
    core.processQuantum(new Float32Array(640).fill(0), undefined, 16000);
    core.processQuantum(new Float32Array(4480).fill(0), undefined, 16000);
    expect(core.isVadActive()).toBe(false);
    expect(batches).toHaveLength(9);

    // 3. VAD 释放后的纯静音输入依然继续产帧
    core.processQuantum(new Float32Array(640).fill(0), undefined, 16000);
    expect(batches).toHaveLength(10);

    // 4. WebAudio 传入空通道（micChannel=undefined）但 quantumFrames=128 时，5 个量子产出 1 帧全零 1280B PCM
    core.processQuantum(undefined, undefined, 16000, 128);
    core.processQuantum(undefined, undefined, 16000, 128);
    core.processQuantum(undefined, undefined, 16000, 128);
    core.processQuantum(undefined, undefined, 16000, 128);
    core.processQuantum(undefined, undefined, 16000, 128);

    expect(batches).toHaveLength(11);
    expect(batches[10].byteLength).toBe(PCM_WORKLET_BATCH_BYTES);
    expect(new Uint8Array(batches[10])).toEqual(new Uint8Array(PCM_WORKLET_BATCH_BYTES));
  });
});

describe("createPageAudioCapture", () => {
  it("loads the WAR AudioWorklet module via chrome.runtime.getURL and emits 1280-byte 40ms PCM frames", async () => {
    const fakeStream = new FakeMediaStream();
    const getUserMedia = vi.fn().mockResolvedValue(fakeStream);
    const fakeAudioCtx = new FakeCaptureAudioContext(48000);
    const frames: Uint8Array[] = [];

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcmBytes) => {
        frames.push(pcmBytes);
      },
      getUserMedia,
      createAudioContext: () => fakeAudioCtx
    });

    expect(getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: MOSS_UPSTREAM_SAMPLE_RATE,
        channelCount: 1
      }
    });
    expect(fakeAudioCtx.addedModuleUrls).toEqual([
      "chrome-extension://test/entry/chunks/pcm-capture-worklet.mjs"
    ]);
    expect(fakeAudioCtx.gainValue).toBe(0);
    expect(capture.isMuted()).toBe(false);

    // 1920 samples @ 48kHz -> 640 samples @ 16kHz -> 1280-byte batch
    fakeAudioCtx.emitSamples(new Float32Array(1920).fill(0.4));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(PCM_WORKLET_BATCH_BYTES);
    capture.stop();
  });

  it("releases microphone tracks and closes AudioContext if audioWorklet.addModule fails", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(48000);
    fakeAudioCtx.addModuleError = new DOMException("CSP blocked worklet", "AbortError");

    await expect(
      createPageAudioCapture({
        onPcmFrame: () => {},
        getUserMedia: async () => fakeStream as unknown as MediaStream,
        createAudioContext: () => fakeAudioCtx
      })
    ).rejects.toThrow("CSP blocked worklet");

    expect(fakeStream.tracks[0].stopped).toBe(true);
    expect(fakeAudioCtx.closed).toBe(true);
  });

  it("setMuted(true) disables audio tracks, updates worklet config, and suppresses frames until unmuted", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcmBytes) => frames.push(pcmBytes),
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    capture.setMuted(true);
    expect(capture.isMuted()).toBe(true);
    expect(fakeStream.tracks[0].enabled).toBe(false);
    expect(fakeAudioCtx.postedToWorklet.at(-1)).toMatchObject({ type: "config", muted: true });

    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.5));
    expect(frames).toHaveLength(0);

    capture.setMuted(false);
    expect(capture.isMuted()).toBe(false);
    expect(fakeStream.tracks[0].enabled).toBe(true);

    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.5));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(PCM_WORKLET_BATCH_BYTES);
    capture.stop();
  });

  it("stop() posts stop to worklet, stops all tracks, disconnects nodes, closes AudioContext, and ignores late callbacks", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcmBytes) => frames.push(pcmBytes),
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    capture.stop();

    expect(fakeAudioCtx.postedToWorklet.at(-1)).toEqual({ type: "stop" });
    expect(fakeStream.tracks[0].stopped).toBe(true);
    expect(fakeAudioCtx.closed).toBe(true);
    expect(fakeAudioCtx.sourceConnected).toBe(false);
    expect(fakeAudioCtx.workletConnected).toBe(false);

    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.5));
    expect(frames).toHaveLength(0);
  });

  it("reports an ended microphone track once and releases capture resources", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const onMicrophoneError = vi.fn();
    const frames: Uint8Array[] = [];

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcmBytes) => frames.push(pcmBytes),
      onMicrophoneError,
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    fakeStream.tracks[0].end();
    fakeStream.tracks[0].end();

    expect(onMicrophoneError).toHaveBeenCalledTimes(1);
    expect(onMicrophoneError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(fakeAudioCtx.closed).toBe(true);
    expect(fakeAudioCtx.sourceConnected).toBe(false);
    expect(fakeAudioCtx.workletConnected).toBe(false);
    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.5));
    expect(frames).toHaveLength(0);
    capture.stop();
    expect(onMicrophoneError).toHaveBeenCalledTimes(1);
  });

  it("does not report microphone failure when stop removes ended listeners", async () => {
    const fakeStream = new FakeMediaStream();
    const onMicrophoneError = vi.fn();
    const capture = await createPageAudioCapture({
      onPcmFrame: () => {},
      onMicrophoneError,
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => new FakeCaptureAudioContext(16000)
    });

    capture.stop();
    fakeStream.tracks[0].end();

    expect(onMicrophoneError).not.toHaveBeenCalled();
  });

  it("surfaces clear actionable Chinese errors on permission denial or missing mic device", async () => {
    const deniedErr = Object.assign(new Error("Permission denied"), { name: "NotAllowedError" });
    await expect(
      createPageAudioCapture({
        onPcmFrame: () => {},
        getUserMedia: async () => {
          throw deniedErr;
        }
      })
    ).rejects.toThrow("麦克风权限被拒绝");

    const notFoundErr = Object.assign(new Error("Requested device not found"), { name: "NotFoundError" });
    await expect(
      createPageAudioCapture({
        onPcmFrame: () => {},
        getUserMedia: async () => {
          throw notFoundErr;
        }
      })
    ).rejects.toThrow("未检测到可用的麦克风设备");

    expect(formatMicCaptureError({ name: "NotReadableError", message: "Could not start audio source" })).toContain(
      "麦克风无法读取"
    );
  });

  it("covers all 5 media and permission error scenarios with actionable Chinese messages", () => {
    expect(formatMediaCaptureError({ name: "NotAllowedError", message: "Permission prompt dismissed" })).toContain(
      "麦克风授权弹窗被关闭"
    );
    expect(formatMediaCaptureError({ name: "NotAllowedError", message: "Permission denied" })).toContain(
      "麦克风或摄像头权限被拒绝"
    );
    expect(formatMediaCaptureError({ name: "NotFoundError", message: "Requested device not found" })).toContain(
      "没有找到可用设备"
    );
    expect(formatMediaCaptureError({ name: "NotReadableError", message: "Could not start audio source" })).toContain(
      "设备被其他应用占用"
    );
    expect(formatMediaCaptureError({ name: "AbortError", message: "Screen capture user cancelled" })).toContain(
      "屏幕共享被取消"
    );
  });

  it("detects voice activity on pure mic branch with hangover sliding window and visual feedback", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const vadStates: boolean[] = [];

    const capture = await createPageAudioCapture({
      onPcmFrame: () => {},
      onVadStateChange: (active) => vadStates.push(active),
      vadHangoverMs: 1500,
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    expect(capture.isMicVadActive()).toBe(false);
    expect(capture.isVoiceRecentlyActive()).toBe(false);

    // Emit silent mic samples
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.002));
    expect(capture.isMicVadActive()).toBe(false);
    expect(capture.isVoiceRecentlyActive()).toBe(false);
    expect(vadStates).toHaveLength(0);

    // Emit speech mic samples (RMS >= 0.015)
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.05));
    expect(capture.isMicVadActive()).toBe(true);
    expect(capture.isVoiceRecentlyActive()).toBe(true);
    expect(vadStates).toEqual([true]);

    // Speech pauses: isVoiceRecentlyActive remains true within hangover window
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.001));
    expect(capture.isVoiceRecentlyActive()).toBe(true);

    // Muting mic resets VAD immediately
    capture.setMuted(true);
    expect(capture.isMicVadActive()).toBe(false);
    expect(capture.isVoiceRecentlyActive()).toBe(false);

    capture.stop();
  });

  it("monitors video audio track status and mixes video audio with mic into PCM output", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];
    const statuses: VideoAudioTrackStatus[] = [];

    const fakeVideoTrack = new FakeMediaStreamTrack();
    const fakeVideoStream = new FakeMediaStream([fakeVideoTrack]);
    const fakeVideo = {
      muted: false,
      volume: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      captureStream: () => fakeVideoStream
    } as unknown as HTMLVideoElement;

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcm) => frames.push(pcm),
      onVideoAudioStatusChange: (st) => statuses.push(st),
      shareVideoAudio: true,
      getVideoElement: () => fakeVideo,
      captureVideoStream: () => fakeVideoStream as unknown as MediaStream,
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    expect(capture.getVideoAudioStatus()).toBe("已获取音轨");

    // 1. Mic silent (0), video active (0.4): video passes at 100% gain (0.4)
    fakeAudioCtx.emitSamples(
      new Float32Array(640).fill(0),
      new Float32Array(640).fill(0.4)
    );
    expect(frames).toHaveLength(1);
    expect(capture.isMicVadActive()).toBe(false);
    const unduckedSamples = decodePcmS16LEToFloat32(frames[0].buffer);
    expect(unduckedSamples[0]).toBeCloseTo(0.4, 2);

    // 2. Mic speaking (0.2 >= 0.015) and video (0.4): video is ducked to 15% (0.2 + 0.4 * 0.15 = 0.26)
    fakeAudioCtx.emitSamples(
      new Float32Array(640).fill(0.2),
      new Float32Array(640).fill(0.4)
    );
    expect(frames).toHaveLength(2);
    expect(capture.isMicVadActive()).toBe(true);
    const duckedSamples = decodePcmS16LEToFloat32(frames[1].buffer);
    expect(duckedSamples[0]).toBeCloseTo(0.26, 2);

    // Video is muted -> reports "视频已静音"
    fakeVideo.muted = true;
    const volChangeHandler = (fakeVideo.addEventListener as any).mock.calls.find(
      (call: any[]) => call[0] === "volumechange"
    )?.[1];
    volChangeHandler?.();
    expect(capture.getVideoAudioStatus()).toBe("视频已静音");

    // Video sharing disabled -> reports "未开启"
    capture.setShareVideoAudio(false);
    expect(capture.getVideoAudioStatus()).toBe("未开启");
    expect(capture.isSharingVideoAudio()).toBe(false);

    capture.stop();
  });

  it("blocks muted in-flight worklet PCM frames even when shareVideoAudio is enabled, and resumes after unmute", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];

    const fakeVideoTrack = new FakeMediaStreamTrack();
    const fakeVideoStream = new FakeMediaStream([fakeVideoTrack]);
    const fakeVideo = {
      muted: false,
      volume: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      captureStream: () => fakeVideoStream
    } as unknown as HTMLVideoElement;

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcm) => frames.push(pcm),
      shareVideoAudio: true,
      getVideoElement: () => fakeVideo,
      captureVideoStream: () => fakeVideoStream as unknown as MediaStream,
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    expect(capture.getVideoAudioStatus()).toBe("已获取音轨");

    // 开麦期间正常产出
    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.2), new Float32Array(640).fill(0.4));
    expect(frames).toHaveLength(1);

    // 闭麦后立即停推，且对 Worklet 端口迟到的在途 pcm 消息及新量子采样全面拦截
    capture.setMuted(true);
    fakeAudioCtx.simulateWorkletMessage({
      type: "pcm",
      pcmBuffer: new Uint8Array(PCM_WORKLET_BATCH_BYTES).fill(0x55).buffer,
      hadSpeech: true
    });
    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.3), new Float32Array(640).fill(0.4));
    expect(frames).toHaveLength(1);

    // 取消静音后恢复正常推帧
    capture.setMuted(false);
    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0), new Float32Array(640).fill(0.4));
    expect(frames).toHaveLength(2);
    expect(decodePcmS16LEToFloat32(frames[1].buffer)[0]).toBeCloseTo(0.4, 2);

    capture.stop();
  });
});
