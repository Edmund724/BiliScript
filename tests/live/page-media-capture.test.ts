// tests/live/page-media-capture.test.ts
// 页面侧麦克风 16kHz PCM 采集、权限拒绝反馈、静音与释放单元测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createPageAudioCapture,
  createVideoAudioCapture,
  formatMediaCaptureError,
  formatMicCaptureError,
  type VideoAudioTrackStatus,
  type PageAudioContextLike
} from "../../extension/live/page-media-capture.js";
import { decodePcmS16LEToFloat32, MOSS_UPSTREAM_FRAME_BYTES, MOSS_UPSTREAM_SAMPLE_RATE } from "../../extension/live/moss-live-protocol.js";

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
  processorConnected = false;
  gainConnected = false;
  gainValue = 1;
  onaudioprocess: ((ev: { inputBuffer: { numberOfChannels?: number; getChannelData(ch: number): Float32Array } }) => void) | null = null;

  constructor(sampleRate = MOSS_UPSTREAM_SAMPLE_RATE) {
    this.sampleRate = sampleRate;
  }

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

  createScriptProcessor(_bufferSize: number, _inChannels: number, _outChannels: number) {
    const self = this;
    return {
      set onaudioprocess(
        fn: ((ev: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void) | null
      ) {
        self.onaudioprocess = fn;
      },
      get onaudioprocess() {
        return self.onaudioprocess;
      },
      connect: (_dest: unknown) => {
        self.processorConnected = true;
      },
      disconnect: () => {
        self.processorConnected = false;
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

  createChannelMerger(_inputs = 2) {
    return {
      connect: () => {},
      disconnect: () => {}
    };
  }

  emitSamples(samples: Float32Array, videoSamples?: Float32Array) {
    this.onaudioprocess?.({
      inputBuffer: {
        numberOfChannels: videoSamples ? 2 : 1,
        getChannelData: (ch: number) => {
          if (ch === 1 && videoSamples) return videoSamples;
          return samples;
        }
      }
    });
  }
}

beforeEach(() => {
  resetModuleState();
  vi.unstubAllGlobals();
});

describe("createPageAudioCapture", () => {
  it("requests 16kHz mono getUserMedia with AEC/ANS/AGC and emits 640-byte 20ms PCM frames", async () => {
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

    // Zero-gain node prevents mic loopback to speakers
    expect(fakeAudioCtx.gainValue).toBe(0);
    expect(capture.isMuted()).toBe(false);

    // Emit 1024 samples @ 48kHz -> ~341 samples @ 16kHz -> 1 frame of 320 samples (640 bytes) + 21 buffered
    fakeAudioCtx.emitSamples(new Float32Array(1024).fill(0.4));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(MOSS_UPSTREAM_FRAME_BYTES);
  });

  it("setMuted(true) disables audio tracks and stops emitting PCM frames until unmuted", async () => {
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

    fakeAudioCtx.emitSamples(new Float32Array(640).fill(0.5));
    expect(frames).toHaveLength(0);

    capture.setMuted(false);
    expect(capture.isMuted()).toBe(false);
    expect(fakeStream.tracks[0].enabled).toBe(true);

    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.5));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(640);
  });

  it("stop() stops all MediaStreamTracks, disconnects audio graph, closes AudioContext, and ignores late callbacks", async () => {
    const fakeStream = new FakeMediaStream();
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];

    const capture = await createPageAudioCapture({
      onPcmFrame: (pcmBytes) => frames.push(pcmBytes),
      getUserMedia: async () => fakeStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    capture.stop();

    expect(fakeStream.tracks[0].stopped).toBe(true);
    expect(fakeAudioCtx.closed).toBe(true);
    expect(fakeAudioCtx.sourceConnected).toBe(false);
    expect(fakeAudioCtx.processorConnected).toBe(false);

    // Late audio callback produces no frames
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
    expect(fakeAudioCtx.processorConnected).toBe(false);
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
    // 1. 麦克风授权弹窗被关闭
    expect(formatMediaCaptureError({ name: "NotAllowedError", message: "Permission prompt dismissed" })).toContain(
      "麦克风授权弹窗被关闭"
    );
    // 2. 麦克风或摄像头权限被拒绝
    expect(formatMediaCaptureError({ name: "NotAllowedError", message: "Permission denied" })).toContain(
      "麦克风或摄像头权限被拒绝"
    );
    // 3. 没有找到可用设备
    expect(formatMediaCaptureError({ name: "NotFoundError", message: "Requested device not found" })).toContain(
      "没有找到可用设备"
    );
    // 4. 设备被其他应用占用
    expect(formatMediaCaptureError({ name: "NotReadableError", message: "Could not start audio source" })).toContain(
      "设备被其他应用占用"
    );
    // 5. 屏幕共享被取消
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

    // Successfully acquired video track
    expect(capture.getVideoAudioStatus()).toBe("已获取音轨");

    // 1. Mic silent (0), video active (0.4): video passes at 100% gain (0.4)
    fakeAudioCtx.emitSamples(
      new Float32Array(320).fill(0),
      new Float32Array(320).fill(0.4)
    );
    expect(frames).toHaveLength(1);
    expect(capture.isMicVadActive()).toBe(false);
    const unduckedSamples = decodePcmS16LEToFloat32(frames[0].buffer);
    expect(unduckedSamples[0]).toBeCloseTo(0.4, 2);

    // 2. Mic speaking (0.2 >= 0.015) and video (0.4): video is ducked to 15% (0.2 + 0.4 * 0.15 = 0.26)
    fakeAudioCtx.emitSamples(
      new Float32Array(320).fill(0.2),
      new Float32Array(320).fill(0.4)
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
});

describe("createVideoAudioCapture (interpret uplink, no mic)", () => {
  function createFakeVideo() {
    const fakeVideoTrack = new FakeMediaStreamTrack();
    const fakeVideoStream = new FakeMediaStream([fakeVideoTrack]);
    const fakeVideo = {
      muted: false,
      volume: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      captureStream: () => fakeVideoStream
    } as unknown as HTMLVideoElement;
    return { fakeVideo, fakeVideoStream };
  }

  it("captures video original audio into 20ms PCM frames without touching getUserMedia", () => {
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];
    const { fakeVideo, fakeVideoStream } = createFakeVideo();
    const getUserMedia = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia
      }
    });

    const capture = createVideoAudioCapture({
      onPcmFrame: (pcm) => frames.push(pcm),
      getVideoElement: () => fakeVideo,
      captureVideoStream: () => fakeVideoStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(capture.getVideoAudioStatus()).toBe("已获取音轨");

    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.4));
    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBe(MOSS_UPSTREAM_FRAME_BYTES);
    const samples = decodePcmS16LEToFloat32(frames[0].buffer);
    expect(samples[0]).toBeCloseTo(0.4, 2);

    capture.stop();
  });

  it("pushes silence frames continuously even with no video element (静音也推)", () => {
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];
    const statuses: VideoAudioTrackStatus[] = [];

    const capture = createVideoAudioCapture({
      onPcmFrame: (pcm) => frames.push(pcm),
      onVideoAudioStatusChange: (status) => statuses.push(status),
      getVideoElement: () => null,
      createAudioContext: () => fakeAudioCtx
    });

    expect(capture.getVideoAudioStatus()).toBe("未检测到音轨");
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0));
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0));
    expect(frames).toHaveLength(2);
    const samples = decodePcmS16LEToFloat32(frames[0].buffer);
    expect(samples.every((s) => s === 0)).toBe(true);

    capture.stop();
  });

  it("keeps pushing silence frames while the video is muted and recovers on unmute", () => {
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];
    const { fakeVideo, fakeVideoStream } = createFakeVideo();

    const capture = createVideoAudioCapture({
      onPcmFrame: (pcm) => frames.push(pcm),
      getVideoElement: () => fakeVideo,
      captureVideoStream: () => fakeVideoStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    fakeVideo.muted = true;
    const volChangeHandler = (fakeVideo.addEventListener as any).mock.calls.find(
      (call: any[]) => call[0] === "volumechange"
    )?.[1];
    volChangeHandler?.();
    expect(capture.getVideoAudioStatus()).toBe("视频已静音");

    // 静音期间仍然推帧（内容为空音）
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0));
    expect(frames).toHaveLength(1);

    fakeVideo.muted = false;
    volChangeHandler?.();
    expect(capture.getVideoAudioStatus()).toBe("已获取音轨");
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.4));
    expect(frames).toHaveLength(2);
    expect(decodePcmS16LEToFloat32(frames[1].buffer)[0]).toBeCloseTo(0.4, 2);

    capture.stop();
  });

  it("stop() disconnects the graph, closes the AudioContext and ignores late callbacks", () => {
    const fakeAudioCtx = new FakeCaptureAudioContext(16000);
    const frames: Uint8Array[] = [];
    const { fakeVideo, fakeVideoStream } = createFakeVideo();

    const capture = createVideoAudioCapture({
      onPcmFrame: (pcm) => frames.push(pcm),
      getVideoElement: () => fakeVideo,
      captureVideoStream: () => fakeVideoStream as unknown as MediaStream,
      createAudioContext: () => fakeAudioCtx
    });

    capture.stop();
    expect(fakeAudioCtx.closed).toBe(true);
    expect(fakeAudioCtx.processorConnected).toBe(false);
    fakeAudioCtx.emitSamples(new Float32Array(320).fill(0.4));
    expect(frames).toHaveLength(0);
  });
});
