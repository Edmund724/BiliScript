// tests/live/page-media-capture.test.ts
// 页面侧麦克风 16kHz PCM 采集、权限拒绝反馈、静音与释放单元测试

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  createPageAudioCapture,
  formatMicCaptureError,
  type PageAudioContextLike
} from "../../extension/live/page-media-capture.js";
import { MOSS_UPSTREAM_FRAME_BYTES, MOSS_UPSTREAM_SAMPLE_RATE } from "../../extension/live/moss-live-protocol.js";

class FakeMediaStreamTrack {
  enabled = true;
  stopped = false;
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
  onaudioprocess: ((ev: { inputBuffer: { getChannelData(ch: number): Float32Array } }) => void) | null = null;

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

  emitSamples(samples: Float32Array) {
    this.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples
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
});
