// extension/live/pcm-capture-core.ts
// 实时伴看音频采集纯内核（零 DOM/扩展 API 依赖）：
// 供 AudioWorkletProcessor 线程与 Vitest 单测共用，负责双路混音、纯麦 VAD 计数释放、
// 分数相位线性插值重采样（-> 16kHz）及 S16LE 分帧批输出。

export const MOSS_UPSTREAM_SAMPLE_RATE = 16000;
export const MOSS_DOWNSTREAM_SAMPLE_RATE = 48000;
export const MOSS_FRAME_DURATION_MS = 20;
export const MOSS_UPSTREAM_FRAME_SAMPLES =
  (MOSS_UPSTREAM_SAMPLE_RATE * MOSS_FRAME_DURATION_MS) / 1000;
export const MOSS_UPSTREAM_FRAME_BYTES = MOSS_UPSTREAM_FRAME_SAMPLES * 2;

export const PCM_WORKLET_BATCH_FRAMES = 2;
export const PCM_WORKLET_BATCH_SAMPLES =
  MOSS_UPSTREAM_FRAME_SAMPLES * PCM_WORKLET_BATCH_FRAMES;
export const PCM_WORKLET_BATCH_BYTES = PCM_WORKLET_BATCH_SAMPLES * 2;

export const PCM_CAPTURE_PROCESSOR_NAME = "biliscript-pcm-capture-processor";
export const PCM_CAPTURE_WORKLET_REL_PATH = "entry/chunks/pcm-capture-worklet.mjs";
export const DEFAULT_WORKLET_QUANTUM_FRAMES = 128;

export const DEFAULT_VAD_RMS_THRESHOLD = 0.015;
export const DEFAULT_VAD_HANGOVER_MS = 2000;
export const DEFAULT_VAD_RELEASE_MS = 300;
export const DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN = 0.15;

const SPEECH_HEARTBEAT_INTERVAL_MS = 200;

export interface PcmCaptureConfig {
  muted: boolean;
  mixVideo: boolean;
  upstreamVideoDuckGain: number;
  vadRmsThreshold: number;
  vadReleaseMs: number;
}

export type PcmCaptureMainToWorkletMessage =
  | ({ type: "config" } & Partial<PcmCaptureConfig>)
  | { type: "stop" };

export type PcmCaptureWorkletToMainMessage =
  | { type: "vad"; active: boolean }
  | { type: "speech" }
  | { type: "pcm"; pcmBuffer: ArrayBuffer; hadSpeech: boolean };

/** 将 [-1, 1] Float32 采样编码为小端序 PCM S16LE 字节流 */
export function encodeFloat32ToPcmS16LE(samples: Float32Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i++) {
    const raw = Number.isFinite(samples[i]) ? samples[i] : 0;
    const clamped = Math.max(-1, Math.min(1, raw));
    const int16 = clamped < 0 ? Math.round(clamped * 0x8000) : Math.floor(clamped * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return new Uint8Array(buffer);
}

/** 将小端序 PCM S16LE 字节流解码为 [-1, 1] Float32 采样 */
export function decodePcmS16LEToFloat32(pcmBuffer: ArrayBufferLike): Float32Array {
  const sampleCount = Math.floor(pcmBuffer.byteLength / 2);
  if (sampleCount <= 0) {
    return new Float32Array(0);
  }
  const view = new DataView(pcmBuffer);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const int16 = view.getInt16(i * 2, true);
    out[i] = int16 / 0x8000;
  }
  return out;
}

/** 单声道 Float32 线性插值重采样（例如浏览器 AudioContext 48kHz -> 16kHz） */
export function resampleMonoFloat32(
  samples: Float32Array,
  srcSampleRate: number,
  targetSampleRate: number = MOSS_UPSTREAM_SAMPLE_RATE
): Float32Array {
  if (samples.length === 0) return new Float32Array(0);
  if (!Number.isFinite(srcSampleRate) || srcSampleRate <= 0 || srcSampleRate === targetSampleRate) {
    return samples;
  }
  const ratio = srcSampleRate / targetSampleRate;
  const outLength = Math.max(0, Math.round(samples.length / ratio));
  if (outLength === 0) return new Float32Array(0);

  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const leftIndex = Math.floor(srcPos);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const frac = srcPos - leftIndex;
    out[i] = samples[leftIndex] * (1 - frac) + samples[rightIndex] * frac;
  }
  return out;
}

export interface Pcm16kFrameChunker {
  push(samples: Float32Array, sampleRate?: number): void;
  reset(): void;
}

/**
 * 将任意块大小的 Float32 音频流按 16kHz 连续相位重采样并按固定采样数（默认 20ms = 320 采样）切帧输出。
 * 跨量子保留小数相位与尾采样，消除 128 采样量子非整除比（48kHz->16kHz 3:1 下 128/3）时的采样率漂移与边界爆音。
 */
export function createPcm16kFrameChunker(
  onFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void,
  batchSamples: number = MOSS_UPSTREAM_FRAME_SAMPLES
): Pcm16kFrameChunker {
  const targetSamples =
    Number.isFinite(batchSamples) && batchSamples > 0
      ? Math.round(batchSamples)
      : MOSS_UPSTREAM_FRAME_SAMPLES;
  const ring = new Float32Array(targetSamples);
  let offset = 0;
  let phase = 0;
  let prevSample = 0;
  let hasPrevSample = false;

  function pushSample(sample: number): void {
    ring[offset++] = sample;
    if (offset === targetSamples) {
      offset = 0;
      onFrame(encodeFloat32ToPcmS16LE(ring));
    }
  }

  return {
    push(samples: Float32Array, sampleRate: number = MOSS_UPSTREAM_SAMPLE_RATE): void {
      if (!samples || samples.length === 0) return;

      const validRate =
        Number.isFinite(sampleRate) && sampleRate > 0
          ? sampleRate
          : MOSS_UPSTREAM_SAMPLE_RATE;

      if (validRate === MOSS_UPSTREAM_SAMPLE_RATE) {
        phase = 0;
        hasPrevSample = false;
        let readIndex = 0;
        while (readIndex < samples.length) {
          const needed = targetSamples - offset;
          const available = samples.length - readIndex;
          const copyCount = Math.min(needed, available);
          ring.set(samples.subarray(readIndex, readIndex + copyCount), offset);
          offset += copyCount;
          readIndex += copyCount;
          if (offset === targetSamples) {
            offset = 0;
            onFrame(encodeFloat32ToPcmS16LE(ring));
          }
        }
        return;
      }

      const ratio = validRate / MOSS_UPSTREAM_SAMPLE_RATE;
      const lastIndex = samples.length - 1;

      while (phase <= lastIndex) {
        const leftIndex = Math.floor(phase);
        const frac = phase - leftIndex;
        let sample: number;
        if (leftIndex < 0) {
          const left = hasPrevSample ? prevSample : samples[0];
          sample = left * (1 - frac) + samples[0] * frac;
        } else if (leftIndex >= lastIndex || frac === 0) {
          sample = samples[leftIndex];
        } else {
          sample = samples[leftIndex] * (1 - frac) + samples[leftIndex + 1] * frac;
        }
        pushSample(sample);
        phase += ratio;
      }

      prevSample = samples[lastIndex];
      hasPrevSample = true;
      phase -= samples.length;
    },
    reset(): void {
      offset = 0;
      phase = 0;
      prevSample = 0;
      hasPrevSample = false;
    }
  };
}

export interface PcmCaptureCoreOptions {
  batchSamples?: number;
  sampleRate?: number;
  initialConfig?: Partial<PcmCaptureConfig>;
  onPcmBatch: (pcmBuffer: ArrayBuffer, hadSpeech: boolean) => void;
  onVadChange?: (active: boolean) => void;
  onSpeechHeartbeat?: () => void;
}

export interface PcmCaptureCore {
  setConfig(patch: Partial<PcmCaptureConfig>): void;
  getConfig(): PcmCaptureConfig;
  isVadActive(): boolean;
  processQuantum(
    micChannel?: Float32Array,
    videoChannels?: readonly Float32Array[],
    quantumSampleRate?: number,
    quantumFrames?: number
  ): void;
  reset(): void;
}

function normalizeConfig(
  base: PcmCaptureConfig,
  patch?: Partial<PcmCaptureConfig>
): PcmCaptureConfig {
  if (!patch) return { ...base };
  const rawGain = patch.upstreamVideoDuckGain;
  const rawThreshold = patch.vadRmsThreshold;
  const rawRelease = patch.vadReleaseMs;
  return {
    muted: patch.muted !== undefined ? Boolean(patch.muted) : base.muted,
    mixVideo: patch.mixVideo !== undefined ? Boolean(patch.mixVideo) : base.mixVideo,
    upstreamVideoDuckGain:
      typeof rawGain === "number" && Number.isFinite(rawGain)
        ? Math.max(0, Math.min(1, rawGain))
        : base.upstreamVideoDuckGain,
    vadRmsThreshold:
      typeof rawThreshold === "number" && Number.isFinite(rawThreshold) && rawThreshold >= 0
        ? rawThreshold
        : base.vadRmsThreshold,
    vadReleaseMs:
      typeof rawRelease === "number" && Number.isFinite(rawRelease) && rawRelease >= 0
        ? rawRelease
        : base.vadReleaseMs
  };
}

export function createPcmCaptureCore(options: PcmCaptureCoreOptions): PcmCaptureCore {
  const defaultSampleRate =
    typeof options.sampleRate === "number" &&
    Number.isFinite(options.sampleRate) &&
    options.sampleRate > 0
      ? options.sampleRate
      : MOSS_UPSTREAM_SAMPLE_RATE;

  let config = normalizeConfig(
    {
      muted: false,
      mixVideo: false,
      upstreamVideoDuckGain: DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN,
      vadRmsThreshold: DEFAULT_VAD_RMS_THRESHOLD,
      vadReleaseMs: DEFAULT_VAD_RELEASE_MS
    },
    options.initialConfig
  );

  let vadSpeaking = false;
  let silenceSamples = 0;
  let speechHeartbeatSamples = 0;
  let hadSpeechInBatch = false;
  let mixScratch = new Float32Array(128);

  const chunker = createPcm16kFrameChunker((pcmBytes) => {
    const batchHadSpeech = hadSpeechInBatch;
    hadSpeechInBatch = false;
    options.onPcmBatch(pcmBytes.buffer, batchHadSpeech);
  }, options.batchSamples ?? PCM_WORKLET_BATCH_SAMPLES);

  function setVadSpeaking(active: boolean): void {
    if (vadSpeaking === active) return;
    vadSpeaking = active;
    options.onVadChange?.(active);
  }

  function resetVadAndSpeech(): void {
    silenceSamples = 0;
    speechHeartbeatSamples = 0;
    hadSpeechInBatch = false;
    setVadSpeaking(false);
  }

  function updateMicVad(micSamples: Float32Array | undefined, sampleRate: number): void {
    if (config.muted) {
      resetVadAndSpeech();
      return;
    }
    const len = micSamples?.length ?? 0;
    if (len === 0) return;

    let sum = 0;
    for (let i = 0; i < len; i++) {
      const s = micSamples![i];
      sum += s * s;
    }
    const rms = Math.sqrt(sum / len);
    const heartbeatIntervalSamples = Math.max(
      1,
      Math.round((SPEECH_HEARTBEAT_INTERVAL_MS / 1000) * sampleRate)
    );

    if (rms >= config.vadRmsThreshold) {
      silenceSamples = 0;
      hadSpeechInBatch = true;
      if (!vadSpeaking) {
        speechHeartbeatSamples = 0;
        setVadSpeaking(true);
      } else {
        speechHeartbeatSamples += len;
        if (speechHeartbeatSamples >= heartbeatIntervalSamples) {
          speechHeartbeatSamples = 0;
          options.onSpeechHeartbeat?.();
        }
      }
      return;
    }

    if (vadSpeaking) {
      silenceSamples += len;
      speechHeartbeatSamples = 0;
      const releaseSamples = Math.round((config.vadReleaseMs / 1000) * sampleRate);
      if (silenceSamples >= releaseSamples) {
        silenceSamples = 0;
        setVadSpeaking(false);
      }
    }
  }

  function setConfig(patch: Partial<PcmCaptureConfig>): void {
    const prevMuted = config.muted;
    config = normalizeConfig(config, patch);
    if (config.muted !== prevMuted) {
      chunker.reset();
      hadSpeechInBatch = false;
    }
    if (config.muted) {
      resetVadAndSpeech();
    }
  }

  function processQuantum(
    micChannel?: Float32Array,
    videoChannels?: readonly Float32Array[],
    quantumSampleRate: number = defaultSampleRate,
    quantumFrames?: number
  ): void {
    const effectiveRate =
      Number.isFinite(quantumSampleRate) && quantumSampleRate > 0
        ? quantumSampleRate
        : defaultSampleRate;

    if (config.muted) {
      resetVadAndSpeech();
      chunker.reset();
      return;
    }

    updateMicVad(micChannel, effectiveRate);

    const hasVideo = Boolean(config.mixVideo && videoChannels && videoChannels.length > 0);
    const micLen = micChannel?.length ?? 0;
    const videoCh0 = hasVideo ? videoChannels![0] : undefined;
    const videoCh1 = hasVideo && videoChannels!.length > 1 ? videoChannels![1] : undefined;
    const videoLen = Math.max(videoCh0?.length ?? 0, videoCh1?.length ?? 0);
    const fallbackFrames =
      typeof quantumFrames === "number" && Number.isFinite(quantumFrames) && quantumFrames > 0
        ? Math.round(quantumFrames)
        : 0;
    const len = Math.max(micLen, videoLen, fallbackFrames);
    if (len === 0) return;

    if (mixScratch.length !== len) {
      mixScratch = new Float32Array(len);
    }

    const videoGain = vadSpeaking ? config.upstreamVideoDuckGain : 1;
    const hasStereoVideo = Boolean(videoCh0 && videoCh1);

    for (let i = 0; i < len; i++) {
      const micSample = micChannel && i < micLen ? micChannel[i] : 0;
      let rawVideo = 0;
      if (hasVideo) {
        if (hasStereoVideo) {
          const s0 = i < videoCh0!.length ? videoCh0![i] : 0;
          const s1 = i < videoCh1!.length ? videoCh1![i] : 0;
          rawVideo = 0.5 * (s0 + s1);
        } else if (videoCh0 && i < videoCh0.length) {
          rawVideo = videoCh0[i];
        }
      }
      const sum = micSample + rawVideo * videoGain;
      mixScratch[i] = sum > 1 ? 1 : sum < -1 ? -1 : sum;
    }

    chunker.push(mixScratch, effectiveRate);
  }

  function reset(): void {
    chunker.reset();
    resetVadAndSpeech();
  }

  return {
    setConfig,
    getConfig: () => ({ ...config }),
    isVadActive: () => !config.muted && vadSpeaking,
    processQuantum,
    reset
  };
}
