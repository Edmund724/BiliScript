// extension/live/page-media-capture.ts
// 页面侧（Content Script）麦克风音频采集与视频原声混音模块。
// 采集用户麦克风输入（开启 AEC/ANS/AGC）并支持混入当前视频原声，
// 对纯麦克风支路进行本地语音活动检测（VAD），实时回报视频音轨状态，
// 并按 MOSS-LIVE 要求的 16kHz 单声道 PCM S16LE 20ms（320 采样 = 640 字节）持续分帧输出。

import { MOSS_UPSTREAM_SAMPLE_RATE, createPcm16kFrameChunker } from "./moss-live-protocol.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";

export type VideoAudioTrackStatus = "已获取音轨" | "未检测到音轨" | "视频已静音" | "未开启";

export const DEFAULT_VAD_RMS_THRESHOLD = 0.015;
export const DEFAULT_VAD_HANGOVER_MS = 2000;
export const DEFAULT_VAD_RELEASE_MS = 300;
export const DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN = 0.15;

export interface PageAudioProcessorNodeLike {
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array; numberOfChannels?: number } }) => void) | null;
  connect(destination: unknown, outputIndex?: number, inputIndex?: number): void;
  disconnect(): void;
}

export interface PageAudioGainNodeLike {
  gain: { value: number };
  connect(destination: unknown, outputIndex?: number, inputIndex?: number): void;
  disconnect(): void;
}

export interface PageAudioSourceNodeLike {
  connect(destination: unknown, outputIndex?: number, inputIndex?: number): void;
  disconnect(): void;
}

export interface PageAudioMergerNodeLike {
  connect(destination: unknown, outputIndex?: number, inputIndex?: number): void;
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
  createChannelMerger?(numberOfInputs?: number): PageAudioMergerNodeLike;
}

export interface PageAudioCaptureOptions {
  onPcmFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void;
  initialMuted?: boolean;
  shareVideoAudio?: boolean;
  upstreamVideoDuckGain?: number;
  vadRmsThreshold?: number;
  vadHangoverMs?: number;
  vadReleaseMs?: number;
  onVideoAudioStatusChange?: (status: VideoAudioTrackStatus) => void;
  onVadStateChange?: (active: boolean) => void;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createAudioContext?: () => PageAudioContextLike | null;
  getVideoElement?: () => HTMLVideoElement | null;
  captureVideoStream?: (video: HTMLVideoElement) => MediaStream | null;
}

export interface PageAudioCaptureSession {
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  setShareVideoAudio(enabled: boolean): void;
  isSharingVideoAudio(): boolean;
  getVideoAudioStatus(): VideoAudioTrackStatus;
  isMicVadActive(): boolean;
  isVoiceRecentlyActive(): boolean;
  stop(): void;
}

/** 将浏览器 getUserMedia / getDisplayMedia 异常转换为统一中文提示 */
export function formatMediaCaptureError(error: unknown): string {
  const errObj = error as { name?: unknown; message?: unknown } | null;
  const name = typeof errObj?.name === "string" ? errObj.name : "";
  const message = typeof errObj?.message === "string" ? errObj.message : String(error || "");
  const combined = `${name} ${message}`.toLowerCase();

  // 1. 麦克风授权弹窗被关闭
  if (
    combined.includes("dismiss") ||
    combined.includes("closed") ||
    (name === "NotAllowedError" && (combined.includes("prompt") || combined.includes("dialog")))
  ) {
    return "麦克风授权弹窗被关闭，请重新点击并允许使用麦克风";
  }

  // 2. 屏幕共享被取消
  if (
    combined.includes("screen capture") ||
    combined.includes("display media") ||
    combined.includes("user cancelled") ||
    (name === "AbortError" && (combined.includes("cancel") || combined.includes("aborted"))) ||
    (name === "NotAllowedError" && combined.includes("cancel"))
  ) {
    return "屏幕共享被取消";
  }

  // 3. 麦克风或摄像头权限被拒绝
  if (
    name === "NotAllowedError" ||
    name === "PermissionDeniedError" ||
    name === "SecurityError" ||
    combined.includes("permission denied") ||
    combined.includes("not allowed") ||
    combined.includes("denied")
  ) {
    return "麦克风或摄像头权限被拒绝（麦克风权限被拒绝），请在浏览器地址栏网站设置中允许权限后重试";
  }

  // 4. 没有找到可用设备
  if (
    name === "NotFoundError" ||
    name === "DevicesNotFoundError" ||
    combined.includes("device not found") ||
    combined.includes("requested device not found") ||
    combined.includes("notfound")
  ) {
    return "没有找到可用设备（未检测到可用的麦克风设备），请检查音频或视频输入设备连接";
  }

  // 5. 设备被其他应用占用
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    combined.includes("could not start audio source") ||
    combined.includes("could not start video source") ||
    combined.includes("not readable") ||
    combined.includes("concurrent") ||
    combined.includes("in use")
  ) {
    return "设备被其他应用占用或麦克风无法读取，请检查设备状态或关闭占用应用后重试";
  }

  return message ? `媒体设备启动失败：${message}` : "媒体设备启动失败";
}

export function formatMicCaptureError(error: unknown): string {
  return formatMediaCaptureError(error);
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

  let micStream: MediaStream;
  try {
    micStream = await getUserMediaFn({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: MOSS_UPSTREAM_SAMPLE_RATE,
        channelCount: 1
      }
    });
  } catch (error) {
    throw new Error(formatMediaCaptureError(error));
  }

  const audioCtx = options.createAudioContext
    ? options.createAudioContext()
    : createDefaultPageAudioContext();

  if (!audioCtx) {
    for (const track of micStream.getTracks()) {
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
  let shareVideoAudio = options.shareVideoAudio ?? false;
  let currentVideoAudioStatus: VideoAudioTrackStatus = shareVideoAudio ? "未检测到音轨" : "未开启";

  // VAD 状态机
  let lastVoiceActivityTimestamp = 0;
  let vadSpeaking = false;
  let vadReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  const vadThreshold = options.vadRmsThreshold ?? DEFAULT_VAD_RMS_THRESHOLD;
  const vadHangoverMs = options.vadHangoverMs ?? DEFAULT_VAD_HANGOVER_MS;
  const vadReleaseMs = options.vadReleaseMs ?? DEFAULT_VAD_RELEASE_MS;
  const upstreamVideoDuckGain =
    typeof options.upstreamVideoDuckGain === "number" &&
    Number.isFinite(options.upstreamVideoDuckGain)
      ? Math.max(0, Math.min(1, options.upstreamVideoDuckGain))
      : DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN;

  function reportVadState(active: boolean): void {
    if (vadSpeaking === active) return;
    vadSpeaking = active;
    try {
      options.onVadStateChange?.(active);
    } catch {}
  }

  function processMicVad(micSamples: Float32Array): void {
    if (stopped || muted) {
      if (vadReleaseTimer) {
        clearTimeout(vadReleaseTimer);
        vadReleaseTimer = null;
      }
      reportVadState(false);
      return;
    }
    let sum = 0;
    const len = micSamples.length;
    for (let i = 0; i < len; i++) {
      sum += micSamples[i] * micSamples[i];
    }
    const rms = Math.sqrt(sum / len);
    const now = Date.now();
    if (rms >= vadThreshold) {
      lastVoiceActivityTimestamp = now;
      if (vadReleaseTimer) {
        clearTimeout(vadReleaseTimer);
        vadReleaseTimer = null;
      }
      reportVadState(true);
    } else if (vadSpeaking && !vadReleaseTimer) {
      vadReleaseTimer = setTimeout(() => {
        vadReleaseTimer = null;
        if (vadSpeaking) {
          reportVadState(false);
        }
      }, vadReleaseMs);
    }
  }

  function setVideoAudioStatus(status: VideoAudioTrackStatus): void {
    if (currentVideoAudioStatus === status) return;
    currentVideoAudioStatus = status;
    try {
      options.onVideoAudioStatusChange?.(status);
    } catch {}
  }

  const chunker = createPcm16kFrameChunker((pcmBytes) => {
    if (stopped) return;
    // 当麦克风静音且视频原声未分享或静音时，静默不推帧
    if (muted && (!shareVideoAudio || currentVideoAudioStatus !== "已获取音轨")) {
      return;
    }
    options.onPcmFrame(pcmBytes);
  });

  for (const track of micStream.getAudioTracks()) {
    track.enabled = !muted;
  }

  // 节点拓扑：
  // 1. micSource (micStream) -> channel 0
  // 2. videoSource (videoStream) -> channel 1 (if available)
  // 3. merger (2 channels) -> processor (2 in, 1 out) -> silentGain -> destination
  const micSource = audioCtx.createMediaStreamSource(micStream);
  const processor = audioCtx.createScriptProcessor(1024, 2, 1);
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;

  const merger = audioCtx.createChannelMerger ? audioCtx.createChannelMerger(2) : null;
  if (merger) {
    micSource.connect(merger, 0, 0);
    merger.connect(processor);
  } else {
    micSource.connect(processor);
  }

  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  // 视频原声采集与监听
  const getVideo = options.getVideoElement ?? getRuntimeVideoElement;
  const captureStreamFn =
    options.captureVideoStream ??
    ((video: HTMLVideoElement): MediaStream | null => {
      try {
        const fn =
          (video as unknown as { captureStream?: () => MediaStream }).captureStream ||
          (video as unknown as { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
        return typeof fn === "function" ? fn.call(video) : null;
      } catch {
        return null;
      }
    });

  let activeVideoEl: HTMLVideoElement | null = null;
  let activeVideoStream: MediaStream | null = null;
  let activeVideoSourceNode: PageAudioSourceNodeLike | null = null;

  function detachVideoAudio(): void {
    if (activeVideoSourceNode) {
      try {
        activeVideoSourceNode.disconnect();
      } catch {}
      activeVideoSourceNode = null;
    }
    activeVideoStream = null;
    activeVideoEl = null;
  }

  function evaluateVideoAudioStatus(): VideoAudioTrackStatus {
    if (!shareVideoAudio) return "未开启";
    const video = getVideo();
    if (!video) return "未检测到音轨";
    const stream = activeVideoStream || captureStreamFn(video);
    const audioTracks = stream ? stream.getAudioTracks() : [];
    if (audioTracks.length === 0) return "未检测到音轨";
    if (video.muted || video.volume === 0 || audioTracks.every((t) => !t.enabled)) {
      return "视频已静音";
    }
    return "已获取音轨";
  }

  function syncVideoAudioPipeline(): void {
    if (stopped) return;
    const nextStatus = evaluateVideoAudioStatus();
    setVideoAudioStatus(nextStatus);

    if (!shareVideoAudio || nextStatus === "未开启" || nextStatus === "未检测到音轨") {
      detachVideoAudio();
      return;
    }

    const video = getVideo();
    if (!video) {
      detachVideoAudio();
      return;
    }

    if (video !== activeVideoEl) {
      detachVideoAudio();
      activeVideoEl = video;
      const stream = captureStreamFn(video);
      if (stream && stream.getAudioTracks().length > 0) {
        activeVideoStream = stream;
        try {
          const sourceNode = audioCtx!.createMediaStreamSource(stream);
          if (merger) {
            sourceNode.connect(merger, 0, 1);
          } else {
            sourceNode.connect(processor);
          }
          activeVideoSourceNode = sourceNode;
        } catch {
          activeVideoSourceNode = null;
        }
      }
    }
  }

  // 绑定视频状态监听
  const onVideoStateChange = () => {
    syncVideoAudioPipeline();
  };
  const videoInterval = setInterval(syncVideoAudioPipeline, 1000);
  syncVideoAudioPipeline();

  const currentVideo = getVideo();
  if (currentVideo) {
    currentVideo.addEventListener("volumechange", onVideoStateChange);
    currentVideo.addEventListener("play", onVideoStateChange);
    currentVideo.addEventListener("pause", onVideoStateChange);
    currentVideo.addEventListener("loadedmetadata", onVideoStateChange);
  }

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const inputBuffer = event.inputBuffer;
    const micData = inputBuffer.getChannelData(0);

    // 纯麦克风支路语音活动检测（VAD）
    processMicVad(micData);

    const hasVideo =
      shareVideoAudio &&
      currentVideoAudioStatus === "已获取音轨" &&
      typeof inputBuffer.numberOfChannels === "number" &&
      inputBuffer.numberOfChannels > 1;
    const videoData = hasVideo ? inputBuffer.getChannelData(1) : null;

    if (muted && !hasVideo) {
      return;
    }

    const len = micData.length;
    const mixed = new Float32Array(len);
    const videoGain = !muted && vadSpeaking ? upstreamVideoDuckGain : 1;
    for (let i = 0; i < len; i++) {
      const micSample = muted ? 0 : micData[i];
      const videoSample = hasVideo && videoData ? videoData[i] * videoGain : 0;
      // 混音限幅归一化
      const sum = micSample + videoSample;
      mixed[i] = sum > 1 ? 1 : sum < -1 ? -1 : sum;
    }
    chunker.push(mixed, audioCtx.sampleRate || MOSS_UPSTREAM_SAMPLE_RATE);
  };

  function setMuted(nextMuted: boolean): void {
    if (stopped) return;
    muted = Boolean(nextMuted);
    chunker.reset();
    for (const track of micStream.getAudioTracks()) {
      track.enabled = !muted;
    }
    if (muted) {
      if (vadReleaseTimer) {
        clearTimeout(vadReleaseTimer);
        vadReleaseTimer = null;
      }
      reportVadState(false);
    }
  }

  function setShareVideoAudio(enabled: boolean): void {
    if (stopped) return;
    shareVideoAudio = Boolean(enabled);
    syncVideoAudioPipeline();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(videoInterval);
    if (vadReleaseTimer) {
      clearTimeout(vadReleaseTimer);
      vadReleaseTimer = null;
    }
    reportVadState(false);
    chunker.reset();
    processor.onaudioprocess = null;

    if (currentVideo) {
      currentVideo.removeEventListener("volumechange", onVideoStateChange);
      currentVideo.removeEventListener("play", onVideoStateChange);
      currentVideo.removeEventListener("pause", onVideoStateChange);
      currentVideo.removeEventListener("loadedmetadata", onVideoStateChange);
    }
    detachVideoAudio();

    try {
      micSource.disconnect();
    } catch {}
    try {
      merger?.disconnect();
    } catch {}
    try {
      processor.disconnect();
    } catch {}
    try {
      silentGain.disconnect();
    } catch {}
    for (const track of micStream.getTracks()) {
      try {
        track.stop();
      } catch {}
    }
    void audioCtx?.close?.().catch(() => {});
  }

  return {
    setMuted,
    isMuted: () => muted,
    setShareVideoAudio,
    isSharingVideoAudio: () => shareVideoAudio,
    getVideoAudioStatus: () => currentVideoAudioStatus,
    isMicVadActive: () => !muted && !stopped && vadSpeaking,
    isVoiceRecentlyActive: () => {
      if (muted || stopped) return false;
      return (Date.now() - lastVoiceActivityTimestamp) <= vadHangoverMs;
    },
    stop
  };
}
