// extension/live/page-media-capture.ts
// 页面侧（Content Script）音频采集模块（AudioWorklet 线程隔离版）。
// 伴看：麦克风输入（AEC/ANS/AGC）与视频原声接入双输入 AudioWorkletNode，
// 混音、纯麦克风支路本地 VAD、视频上行压低、16kHz 重采样与 40ms（1280B）S16LE 编码全部在音频线程执行；
// 主线程仅经 Transferable ArrayBuffer 接收分帧并透传状态。

import {
  DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN,
  DEFAULT_VAD_HANGOVER_MS,
  DEFAULT_VAD_RELEASE_MS,
  DEFAULT_VAD_RMS_THRESHOLD,
  MOSS_UPSTREAM_SAMPLE_RATE,
  PCM_CAPTURE_PROCESSOR_NAME,
  PCM_CAPTURE_WORKLET_REL_PATH,
  type PcmCaptureConfig,
  type PcmCaptureMainToWorkletMessage,
  type PcmCaptureWorkletToMainMessage
} from "./pcm-capture-core.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";

export type VideoAudioTrackStatus = "已获取音轨" | "未检测到音轨" | "视频已静音" | "未开启";

export {
  DEFAULT_VAD_RMS_THRESHOLD,
  DEFAULT_VAD_HANGOVER_MS,
  DEFAULT_VAD_RELEASE_MS,
  DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN
};

export interface PageAudioWorkletPortLike {
  onmessage: ((event: MessageEvent<PcmCaptureWorkletToMainMessage>) => void) | null;
  postMessage(message: PcmCaptureMainToWorkletMessage): void;
}

export interface PageAudioWorkletNodeLike {
  readonly port: PageAudioWorkletPortLike;
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

export interface PageAudioContextLike {
  readonly sampleRate: number;
  readonly state?: string;
  readonly destination: unknown;
  readonly audioWorklet?: {
    addModule(moduleURL: string): Promise<void>;
  };
  resume?(): Promise<void>;
  close?(): Promise<void>;
  createMediaStreamSource(stream: MediaStream): PageAudioSourceNodeLike;
  createWorkletNode?(name: string, options?: AudioWorkletNodeOptions): PageAudioWorkletNodeLike;
  createGain(): PageAudioGainNodeLike;
}

export interface PageAudioCaptureOptions {
  onPcmFrame: (pcmBytes: Uint8Array<ArrayBuffer>) => void;
  initialMuted?: boolean;
  shareVideoAudio?: boolean;
  upstreamVideoDuckGain?: number;
  vadRmsThreshold?: number;
  vadHangoverMs?: number;
  vadReleaseMs?: number;
  workletModuleUrl?: string;
  onVideoAudioStatusChange?: (status: VideoAudioTrackStatus) => void;
  onVadStateChange?: (active: boolean) => void;
  onMicrophoneError?: (error: Error) => void;
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
  const Ctor = (
    globalThis as unknown as { AudioContext?: new (opts?: AudioContextOptions) => PageAudioContextLike }
  ).AudioContext;
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

function resolveWorkletModuleUrl(explicitUrl?: string): string {
  if (explicitUrl) return explicitUrl;
  if (typeof chrome !== "undefined" && typeof chrome.runtime?.getURL === "function") {
    return chrome.runtime.getURL(PCM_CAPTURE_WORKLET_REL_PATH);
  }
  throw new Error("当前扩展环境无法解析 AudioWorklet 模块路径");
}

function defaultCaptureVideoStream(video: HTMLVideoElement): MediaStream | null {
  try {
    const fn = (video as unknown as { captureStream?: () => MediaStream }).captureStream;
    return typeof fn === "function" ? fn.call(video) : null;
  } catch {
    return null;
  }
}

// ===== 视频音轨管线（伴看混音） =====

interface VideoAudioPipelineDeps {
  audioCtx: PageAudioContextLike;
  getVideo: () => HTMLVideoElement | null;
  captureStreamFn: (video: HTMLVideoElement) => MediaStream | null;
  isSharing: () => boolean;
  onStatusChange: (status: VideoAudioTrackStatus) => void;
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
 * 状态不可用时只断开音源节点、保留流缓存，恢复后从缓存流重连。
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

function stopStreamTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {}
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
    stopStreamTracks(micStream);
    throw new Error("当前浏览器环境不支持 WebAudio 音频处理");
  }

  let muted = Boolean(options.initialMuted);
  let shareVideoAudio = options.shareVideoAudio ?? false;
  const vadThreshold = options.vadRmsThreshold ?? DEFAULT_VAD_RMS_THRESHOLD;
  const vadHangoverMs = options.vadHangoverMs ?? DEFAULT_VAD_HANGOVER_MS;
  const vadReleaseMs = options.vadReleaseMs ?? DEFAULT_VAD_RELEASE_MS;
  const upstreamVideoDuckGain =
    typeof options.upstreamVideoDuckGain === "number" &&
    Number.isFinite(options.upstreamVideoDuckGain)
      ? Math.max(0, Math.min(1, options.upstreamVideoDuckGain))
      : DEFAULT_UPSTREAM_VIDEO_DUCK_GAIN;

  let workletNode: PageAudioWorkletNodeLike;
  try {
    if (!audioCtx.audioWorklet || typeof audioCtx.audioWorklet.addModule !== "function") {
      throw new Error("当前浏览器环境不支持 AudioWorklet 音频处理");
    }
    const workletUrl = resolveWorkletModuleUrl(options.workletModuleUrl);
    await audioCtx.audioWorklet.addModule(workletUrl);

    const nodeOptions: AudioWorkletNodeOptions = {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: {
        muted,
        mixVideo: false,
        upstreamVideoDuckGain,
        vadRmsThreshold: vadThreshold,
        vadReleaseMs
      } satisfies PcmCaptureConfig
    };

    if (audioCtx.createWorkletNode) {
      workletNode = audioCtx.createWorkletNode(PCM_CAPTURE_PROCESSOR_NAME, nodeOptions);
    } else if (typeof AudioWorkletNode !== "undefined") {
      workletNode = new AudioWorkletNode(
        audioCtx as unknown as AudioContext,
        PCM_CAPTURE_PROCESSOR_NAME,
        nodeOptions
      ) as unknown as PageAudioWorkletNodeLike;
    } else {
      throw new Error("当前浏览器环境不支持 AudioWorkletNode");
    }
  } catch (error) {
    stopStreamTracks(micStream);
    void audioCtx.close?.().catch(() => {});
    throw error;
  }

  if (audioCtx.state === "suspended") {
    void audioCtx.resume?.().catch(() => {});
  }

  let stopped = false;
  let lastVoiceActivityTimestamp = 0;
  let vadSpeaking = false;

  function reportVadState(active: boolean): void {
    if (vadSpeaking === active) return;
    vadSpeaking = active;
    try {
      options.onVadStateChange?.(active);
    } catch {}
  }

  function handleMicrophoneEnded(): void {
    if (stopped) return;
    stop();
    try {
      options.onMicrophoneError?.(new Error("麦克风连接已中断，请检查设备或浏览器权限后重试"));
    } catch {}
  }

  const micAudioTracks = micStream.getAudioTracks();
  for (const track of micAudioTracks) {
    track.enabled = !muted;
    track.addEventListener("ended", handleMicrophoneEnded);
  }

  // 节点拓扑：
  // 1. micSource (micStream) -> workletNode input 0
  // 2. videoSource (videoStream) -> workletNode input 1
  // 3. workletNode output 0 -> silentGain (gain=0) -> destination
  const micSource = audioCtx.createMediaStreamSource(micStream);
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;

  micSource.connect(workletNode, 0, 0);
  workletNode.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  let videoPipeline!: VideoAudioPipeline;

  function syncWorkletConfig(): void {
    if (stopped) return;
    const mixVideo = Boolean(shareVideoAudio && videoPipeline.getStatus() === "已获取音轨");
    try {
      workletNode.port.postMessage({
        type: "config",
        muted,
        mixVideo,
        upstreamVideoDuckGain,
        vadRmsThreshold: vadThreshold,
        vadReleaseMs
      });
    } catch {}
  }

  videoPipeline = createVideoAudioPipeline({
    audioCtx,
    getVideo: options.getVideoElement ?? getRuntimeVideoElement,
    captureStreamFn: options.captureVideoStream ?? defaultCaptureVideoStream,
    isSharing: () => shareVideoAudio,
    onStatusChange: (status) => {
      syncWorkletConfig();
      try {
        options.onVideoAudioStatusChange?.(status);
      } catch {}
    },
    connectSource: (sourceNode) => {
      sourceNode.connect(workletNode, 0, 1);
    },
    isStopped: () => stopped
  });

  syncWorkletConfig();

  workletNode.port.onmessage = (event: MessageEvent<PcmCaptureWorkletToMainMessage>) => {
    if (stopped) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "vad") {
      if (muted) {
        reportVadState(false);
        return;
      }
      if (msg.active) {
        lastVoiceActivityTimestamp = Date.now();
      }
      reportVadState(Boolean(msg.active));
      return;
    }

    if (msg.type === "speech") {
      if (!muted) {
        lastVoiceActivityTimestamp = Date.now();
      }
      return;
    }

    if (msg.type === "pcm") {
      if (msg.hadSpeech && !muted) {
        lastVoiceActivityTimestamp = Date.now();
      }
      // 当麦克风静音且视频原声未分享或静音时，静默不推帧
      if (muted && (!shareVideoAudio || videoPipeline.getStatus() !== "已获取音轨")) {
        return;
      }
      const pcmBytes = new Uint8Array(msg.pcmBuffer);
      if (pcmBytes.byteLength > 0) {
        options.onPcmFrame(pcmBytes);
      }
    }
  };

  function setMuted(nextMuted: boolean): void {
    if (stopped) return;
    muted = Boolean(nextMuted);
    for (const track of micStream.getAudioTracks()) {
      track.enabled = !muted;
    }
    if (muted) {
      lastVoiceActivityTimestamp = 0;
      reportVadState(false);
    }
    syncWorkletConfig();
  }

  function setShareVideoAudio(enabled: boolean): void {
    if (stopped) return;
    shareVideoAudio = Boolean(enabled);
    videoPipeline.sync();
    syncWorkletConfig();
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    lastVoiceActivityTimestamp = 0;
    reportVadState(false);

    try {
      workletNode.port.postMessage({ type: "stop" });
    } catch {}
    workletNode.port.onmessage = null;

    videoPipeline.stop();

    try {
      micSource.disconnect();
    } catch {}
    try {
      workletNode.disconnect();
    } catch {}
    try {
      silentGain.disconnect();
    } catch {}
    for (const track of micAudioTracks) {
      track.removeEventListener("ended", handleMicrophoneEnded);
    }
    stopStreamTracks(micStream);
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
      if (vadSpeaking) return true;
      return lastVoiceActivityTimestamp > 0 && Date.now() - lastVoiceActivityTimestamp <= vadHangoverMs;
    },
    stop
  };
}
