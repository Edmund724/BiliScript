// extension/live/page-media-capture.ts
// 页面侧（Content Script）音频采集模块。
// 伴看：麦克风输入（AEC/ANS/AGC）与视频原声混音，纯麦克风支路本地 VAD，视频音量压低。
// 同传：只取视频原声（不含麦克风），静音也持续推帧。
// 两路共用 MOSS-LIVE 要求的 16kHz 单声道 PCM S16LE 20ms（320 采样 = 640 字节）分帧输出，
// 以及同一条视频音轨管线（captureStream 缓存、状态评估、事件监听）。

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

function defaultCaptureVideoStream(video: HTMLVideoElement): MediaStream | null {
  try {
    const fn =
      (video as unknown as { captureStream?: () => MediaStream }).captureStream ||
      (video as unknown as { mozCaptureStream?: () => MediaStream }).mozCaptureStream;
    return typeof fn === "function" ? fn.call(video) : null;
  } catch {
    return null;
  }
}

// ===== 视频音轨管线（伴看混音与同传纯原声共用） =====

interface VideoAudioPipelineDeps {
  audioCtx: PageAudioContextLike;
  getVideo: () => HTMLVideoElement | null;
  captureStreamFn: (video: HTMLVideoElement) => MediaStream | null;
  /** 是否消费视频原声（伴看受 shareVideoAudio 开关控制；同传恒为 true） */
  isSharing: () => boolean;
  onStatusChange: (status: VideoAudioTrackStatus) => void;
  /** 把视频音源接入各自混音拓扑（伴看进 merger 通道 1；同传直连 processor 通道 0） */
  connectSource: (sourceNode: PageAudioSourceNodeLike) => void;
  isStopped: () => boolean;
}

interface VideoAudioPipeline {
  sync(): void;
  getStatus(): VideoAudioTrackStatus;
  stop(): void;
}

/**
 * 视频原声采集管线：按视频元素缓存 captureStream（只在换片时重新采集，避免每秒
 * 重复 captureStream 产生泄漏），评估音轨状态（已获取 / 未检测到 / 已静音 / 未开启），
 * 状态不可用時只断开音源节点、保留流缓存，恢复后从缓存流重连。
 */
function createVideoAudioPipeline(deps: VideoAudioPipelineDeps): VideoAudioPipeline {
  let status: VideoAudioTrackStatus = deps.isSharing() ? "未检测到音轨" : "未开启";
  let activeVideoEl: HTMLVideoElement | null = null;
  let activeVideoStream: MediaStream | null = null;
  let activeVideoSourceNode: PageAudioSourceNodeLike | null = null;

  function report(nextStatus: VideoAudioTrackStatus): void {
    if (status === nextStatus) return;
    status = nextStatus;
    try {
      deps.onStatusChange(nextStatus);
    } catch {}
  }

  function disconnectSource(): void {
    if (activeVideoSourceNode) {
      try {
        activeVideoSourceNode.disconnect();
      } catch {}
      activeVideoSourceNode = null;
    }
  }

  function detachVideoAudio(): void {
    disconnectSource();
    activeVideoStream = null;
    activeVideoEl = null;
  }

  function evaluateStatus(): VideoAudioTrackStatus {
    if (!deps.isSharing()) return "未开启";
    const video = deps.getVideo();
    if (!video || !activeVideoStream) return "未检测到音轨";
    const audioTracks = activeVideoStream.getAudioTracks();
    if (audioTracks.length === 0) return "未检测到音轨";
    if (video.muted || video.volume === 0 || audioTracks.every((t) => !t.enabled)) {
      return "视频已静音";
    }
    return "已获取音轨";
  }

  function sync(): void {
    if (deps.isStopped()) return;
    const video = deps.getVideo();
    if (video !== activeVideoEl) {
      detachVideoAudio();
      if (video && deps.isSharing()) {
        activeVideoEl = video;
        const stream = deps.captureStreamFn(video);
        if (stream && stream.getAudioTracks().length > 0) {
          activeVideoStream = stream;
        }
      }
    } else if (video && !activeVideoStream && deps.isSharing()) {
      // 首次采集时音轨未就绪（如 metadata 未加载）：下轮同步重试
      const stream = deps.captureStreamFn(video);
      if (stream && stream.getAudioTracks().length > 0) {
        activeVideoStream = stream;
      }
    }

    const nextStatus = evaluateStatus();
    report(nextStatus);

    if (nextStatus === "已获取音轨") {
      if (!activeVideoSourceNode && activeVideoStream) {
        try {
          const sourceNode = deps.audioCtx.createMediaStreamSource(activeVideoStream);
          deps.connectSource(sourceNode);
          activeVideoSourceNode = sourceNode;
        } catch {
          activeVideoSourceNode = null;
        }
      }
    } else {
      disconnectSource();
    }
  }

  // 绑定视频状态监听
  const onVideoStateChange = () => {
    sync();
  };
  const videoInterval = setInterval(sync, 1000);
  sync();

  const boundVideo = deps.getVideo();
  if (boundVideo) {
    boundVideo.addEventListener("volumechange", onVideoStateChange);
    boundVideo.addEventListener("play", onVideoStateChange);
    boundVideo.addEventListener("pause", onVideoStateChange);
    boundVideo.addEventListener("loadedmetadata", onVideoStateChange);
  }

  return {
    sync,
    getStatus: () => status,
    stop() {
      clearInterval(videoInterval);
      if (boundVideo) {
        boundVideo.removeEventListener("volumechange", onVideoStateChange);
        boundVideo.removeEventListener("play", onVideoStateChange);
        boundVideo.removeEventListener("pause", onVideoStateChange);
        boundVideo.removeEventListener("loadedmetadata", onVideoStateChange);
      }
      detachVideoAudio();
    }
  };
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

  const chunker = createPcm16kFrameChunker((pcmBytes) => {
    if (stopped) return;
    // 当麦克风静音且视频原声未分享或静音时，静默不推帧
    if (muted && (!shareVideoAudio || videoPipeline.getStatus() !== "已获取音轨")) {
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
  const videoPipeline = createVideoAudioPipeline({
    audioCtx,
    getVideo: options.getVideoElement ?? getRuntimeVideoElement,
    captureStreamFn: options.captureVideoStream ?? defaultCaptureVideoStream,
    isSharing: () => shareVideoAudio,
    onStatusChange: (status) => {
      try {
        options.onVideoAudioStatusChange?.(status);
      } catch {}
    },
    connectSource: (sourceNode) => {
      if (merger) {
        sourceNode.connect(merger, 0, 1);
      } else {
        sourceNode.connect(processor);
      }
    },
    isStopped: () => stopped
  });

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    const inputBuffer = event.inputBuffer;
    const micData = inputBuffer.getChannelData(0);

    // 纯麦克风支路语音活动检测（VAD）
    processMicVad(micData);

    const hasVideo =
      shareVideoAudio &&
      videoPipeline.getStatus() === "已获取音轨" &&
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
    videoPipeline.sync();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (vadReleaseTimer) {
      clearTimeout(vadReleaseTimer);
      vadReleaseTimer = null;
    }
    reportVadState(false);
    chunker.reset();
    processor.onaudioprocess = null;

    videoPipeline.stop();

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
    getVideoAudioStatus: () => videoPipeline.getStatus(),
    isMicVadActive: () => !muted && !stopped && vadSpeaking,
    isVoiceRecentlyActive: () => {
      if (muted || stopped) return false;
      return (Date.now() - lastVoiceActivityTimestamp) <= vadHangoverMs;
    },
    stop
  };
}

export interface VideoAudioCaptureOptions {
  onPcmFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void;
  onVideoAudioStatusChange?: (status: VideoAudioTrackStatus) => void;
  getVideoElement?: () => HTMLVideoElement | null;
  captureVideoStream?: (video: HTMLVideoElement) => MediaStream | null;
  createAudioContext?: () => PageAudioContextLike | null;
}

export interface VideoAudioCaptureSession {
  getVideoAudioStatus(): VideoAudioTrackStatus;
  stop(): void;
}

/**
 * 同声传译上行采集：只取视频原声（不采集麦克风），按 16kHz / 20ms 持续分帧输出；
 * 视频静音、暂停或无音轨时推送静音帧，保持上行流不中断（静音也推）。
 */
export function createVideoAudioCapture(options: VideoAudioCaptureOptions): VideoAudioCaptureSession {
  const audioCtx = options.createAudioContext
    ? options.createAudioContext()
    : createDefaultPageAudioContext();
  if (!audioCtx) {
    throw new Error("当前浏览器环境不支持 WebAudio 音频处理");
  }

  if (audioCtx.state === "suspended") {
    void audioCtx.resume?.().catch(() => {});
  }

  let stopped = false;

  const chunker = createPcm16kFrameChunker((pcmBytes) => {
    if (stopped) return;
    // 静音也推：不做任何抑制，保持 20ms 帧持续上行
    options.onPcmFrame(pcmBytes);
  });

  // 节点拓扑：videoSource -> processor -> silentGain -> destination
  // （processor 常连 destination，无视频输入时以静音驱动，保证帧率不间断）
  const processor = audioCtx.createScriptProcessor(1024, 1, 1);
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  processor.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  const videoPipeline = createVideoAudioPipeline({
    audioCtx,
    getVideo: options.getVideoElement ?? getRuntimeVideoElement,
    captureStreamFn: options.captureVideoStream ?? defaultCaptureVideoStream,
    isSharing: () => true,
    onStatusChange: (status) => {
      try {
        options.onVideoAudioStatusChange?.(status);
      } catch {}
    },
    connectSource: (sourceNode) => {
      sourceNode.connect(processor);
    },
    isStopped: () => stopped
  });

  processor.onaudioprocess = (event) => {
    if (stopped) return;
    // 通道 0：已接入视频音轨时为原声，否则为静音；两种情况下都持续推帧
    chunker.push(
      event.inputBuffer.getChannelData(0),
      audioCtx.sampleRate || MOSS_UPSTREAM_SAMPLE_RATE
    );
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    chunker.reset();
    processor.onaudioprocess = null;

    videoPipeline.stop();

    try {
      processor.disconnect();
    } catch {}
    try {
      silentGain.disconnect();
    } catch {}
    void audioCtx?.close?.().catch(() => {});
  }

  return {
    getVideoAudioStatus: () => videoPipeline.getStatus(),
    stop
  };
}
