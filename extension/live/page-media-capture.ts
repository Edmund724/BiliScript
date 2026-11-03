// extension/live/page-media-capture.ts
// 页面侧（Content Script）麦克风音频采集模块。
// 采集用户麦克风输入，开启浏览器原生 AEC/ANS/AGC，
// 并按 MOSS-LIVE 要求的 16kHz 单声道 PCM S16LE 20ms（320 采样 = 640 字节）持续分帧输出。

import { MOSS_UPSTREAM_SAMPLE_RATE, createPcm16kFrameChunker } from "./moss-live-protocol.js";

export interface PageAudioProcessorNodeLike {
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null;
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface PageAudioGainNodeLike {
  gain: { value: number };
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface PageAudioSourceNodeLike {
  connect(destination: unknown): void;
  disconnect(): void;
}

export interface PageAudioContextLike {
  readonly sampleRate: number;
  readonly state?: string;
  readonly destination: unknown;
  resume?(): Promise<void>;
  close?(): Promise<void>;
  createMediaStreamSource(stream: MediaStream): PageAudioSourceNodeLike;
  createScriptProcessor(
    bufferSize: number,
    numberOfInputChannels: number,
    numberOfOutputChannels: number
  ): PageAudioProcessorNodeLike;
  createGain(): PageAudioGainNodeLike;
}

export interface PageAudioCaptureOptions {
  onPcmFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void;
  initialMuted?: boolean;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => PageAudioContextLike | null;
}

export interface PageAudioCaptureSession {
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  stop(): void;
}

/** 将浏览器 getUserMedia 异常转换为清晰可操作的中文提示 */
export function formatMicCaptureError(error: unknown): string {
  const errObj = error as { name?: unknown; message?: unknown } | null;
  const name = typeof errObj?.name === "string" ? errObj.name : "";
  const message = typeof errObj?.message === "string" ? errObj.message : String(error || "");
  const combined = `${name} ${message}`.toLowerCase();

  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    combined.includes("permission denied") ||
    combined.includes("not allowed")
  ) {
    return "麦克风权限被拒绝，请在浏览器地址栏允许访问麦克风后重试";
  }

  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    combined.includes("device not found") ||
    combined.includes("requested device not found")
  ) {
    return "未检测到可用的麦克风设备，请检查音频输入设备连接";
  }

  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    combined.includes("could not start audio source") ||
    combined.includes("not readable")
  ) {
    return "麦克风无法读取或正被其他应用占用，请检查设备状态后重试";
  }

  return message ? `麦克风启动失败：${message}` : "麦克风启动失败";
}

function createDefaultPageAudioContext(): PageAudioContextLike | null {
  const Ctor =
    (globalThis as unknown as { AudioContext?: new (opts?: AudioContextOptions) => PageAudioContextLike })
      .AudioContext ||
    (globalThis as unknown as { webkitAudioContext?: new (opts?: AudioContextOptions) => PageAudioContextLike })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor({ sampleRate: MOSS_UPSTREAM_SAMPLE_RATE });
  } catch {
    try {
      return new Ctor();
    } catch {
      return null;
    }
  }
}

export async function createPageAudioCapture(
  options: PageAudioCaptureOptions
): Promise<PageAudioCaptureSession> {
  const getUserMediaFn =
    options.getUserMedia ??
    (typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia
      ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
      : null);

  if (!getUserMediaFn) {
    throw new Error("当前页面环境不支持麦克风采集");
  }

  let stream: MediaStream;
  try {
    stream = await getUserMediaFn({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: MOSS_UPSTREAM_SAMPLE_RATE,
        channelCount: 1
      }
    });
  } catch (error) {
    throw new Error(formatMicCaptureError(error));
  }

  const audioCtx = options.createAudioContext
    ? options.createAudioContext()
    : createDefaultPageAudioContext();

  if (!audioCtx) {
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    throw new Error("当前浏览器环境不支持 WebAudio 音频处理");
  }

  if (audioCtx.state === "suspended") {
    void audioCtx.resume?.().catch(() => {});
  }

  let stopped = false;
  let muted = Boolean(options.initialMuted);

  const chunker = createPcm16kFrameChunker((pcmBytes) => {
    if (stopped || muted) return;
    options.onPcmFrame(pcmBytes);
  });

  for (const track of stream.getAudioTracks()) {
    track.enabled = !muted;
  }

  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(1024, 1, 1);
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;

  processor.onaudioprocess = (event) => {
    if (stopped || muted) return;
    const channelData = event.inputBuffer.getChannelData(0);
    chunker.push(channelData, audioCtx.sampleRate || MOSS_UPSTREAM_SAMPLE_RATE);
  };

  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  function setMuted(nextMuted: boolean): void {
    if (stopped) return;
    muted = Boolean(nextMuted);
    chunker.reset();
    for (const track of stream.getAudioTracks()) {
      track.enabled = !muted;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    chunker.reset();
    processor.onaudioprocess = null;
    try {
      source.disconnect();
    } catch {}
    try {
      processor.disconnect();
    } catch {}
    try {
      silentGain.disconnect();
    } catch {}
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    void audioCtx?.close?.().catch(() => {});
  }

  return {
    setMuted,
    isMuted: () => muted,
    stop
  };
}
