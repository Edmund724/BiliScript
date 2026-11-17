// 页面当前视频元素的 JPEG 抽帧；单帧在飞，换来源或停止后丢弃迟到编码结果。
// 实时伴看的长边、质量与间隔取自服务端 media.configured.video 回执（会话可重配）。

import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import {
  MOSS_STANDARD_VIDEO_CONFIG,
  type MossVideoCaptureConfig
} from "./moss-video-config.js";

// 一次性画面截取（AI 视觉工具）使用的固定画质，与会话抽帧参数无关。
export const MOSS_VIDEO_FRAME_MAX_EDGE = 960;
export const MOSS_VIDEO_JPEG_QUALITY = 0.72;
export const MIN_LIVE_VIDEO_CAPTURE_INTERVAL_MS = 1000;
export const DEFAULT_VIDEO_SEEK_CAPTURE_DEBOUNCE_MS = 200;

export interface PageVideoFrameCaptureOptions {
  onJpegFrame: (jpegBytes: Uint8Array<ArrayBuffer>) => void;
  getVideo?: () => HTMLVideoElement | null;
  createCanvas?: () => HTMLCanvasElement | null;
  /** 初始抽帧参数；缺省为服务端 standard 默认值。 */
  config?: Partial<MossVideoCaptureConfig>;
  /** 静止/后台状态是否停推周期帧（Gemini Live 启用以防 token 膨胀，MOSS 保留保活心跳）。 */
  pauseWhenStatic?: boolean;
  /** seeked 落定后防抖补帧延迟（毫秒）。 */
  seekDebounceMs?: number;
  /** 可选页面可见性探针（便于单测与宿主覆写）。 */
  isDocumentHidden?: () => boolean;
}

export interface PageVideoFrameCaptureSession {
  stop(): void;
  /** 按服务端回执重配抽帧参数（长边、质量即时生效；间隔变更重新排期）。 */
  configure(config: Partial<MossVideoCaptureConfig>): void;
  /** 当前是否处于暂停/结束/隐藏导致的周期帧停推状态。 */
  isSuspended?(): boolean;
  /** 按当前会话参数抓取单帧快照（不触发周期帧回调，供暂停态离散提问补帧）。 */
  captureSnapshot?(): Promise<Uint8Array<ArrayBuffer> | null>;
}

export interface PageVideoFrameSnapshot {
  jpegBytes: Uint8Array<ArrayBuffer>;
  currentTime: number;
}

export async function capturePageVideoFrame(
  options: Pick<PageVideoFrameCaptureOptions, "getVideo" | "createCanvas"> = {}
): Promise<PageVideoFrameSnapshot> {
  const video = (options.getVideo || getRuntimeVideoElement)();
  if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) {
    throw new Error("当前没有可截取的视频画面");
  }
  const canvas = (options.createCanvas || (() => document.createElement("canvas")))();
  const context = canvas?.getContext("2d");
  if (!canvas || !context) {
    throw new Error("无法创建截图画布");
  }
  const { width, height } = getVideoFrameSize(video.videoWidth, video.videoHeight);
  const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
  canvas.width = width;
  canvas.height = height;
  context.drawImage(video, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", MOSS_VIDEO_JPEG_QUALITY);
  });
  if (!blob) {
    throw new Error("视频画面编码失败");
  }
  const jpegBytes = new Uint8Array(await blob.arrayBuffer());
  if (!jpegBytes.byteLength) {
    throw new Error("视频画面编码为空");
  }
  return { jpegBytes, currentTime };
}

function getVideoSource(video: HTMLVideoElement): string {
  return video.currentSrc || video.src || "";
}

export function getVideoFrameSize(
  videoWidth: number,
  videoHeight: number,
  maxEdge = MOSS_VIDEO_FRAME_MAX_EDGE
): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(videoWidth, videoHeight));
  return {
    width: Math.max(1, Math.round(videoWidth * scale)),
    height: Math.max(1, Math.round(videoHeight * scale))
  };
}

export function createPageVideoFrameCapture(
  options: PageVideoFrameCaptureOptions
): PageVideoFrameCaptureSession {
  const getVideo = options.getVideo || getRuntimeVideoElement;
  const createCanvas = options.createCanvas || (() => document.createElement("canvas"));
  const pauseWhenStatic = Boolean(options.pauseWhenStatic);
  const seekDebounceMs =
    typeof options.seekDebounceMs === "number" && Number.isFinite(options.seekDebounceMs) && options.seekDebounceMs >= 0
      ? options.seekDebounceMs
      : DEFAULT_VIDEO_SEEK_CAPTURE_DEBOUNCE_MS;
  const isHidden = (): boolean =>
    options.isDocumentHidden
      ? Boolean(options.isDocumentHidden())
      : typeof document !== "undefined" && Boolean(document.hidden);

  let stopped = false;
  let encoding = false;
  let pendingSeekCapture = false;
  let sourceGeneration = 0;
  let activeVideo: HTMLVideoElement | null = null;
  let activeSource = "";
  let lastFrameKey = "";
  let lastJpegBytes: Uint8Array<ArrayBuffer> | null = null;
  let lastCaptureAt = 0;
  let canvas: HTMLCanvasElement | null = null;
  let config: MossVideoCaptureConfig = { ...MOSS_STANDARD_VIDEO_CONFIG, ...options.config };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seekTimer: ReturnType<typeof setTimeout> | null = null;
  let boundVideoListenersTarget: HTMLVideoElement | null = null;
  let visibilityListenerBound = false;

  function getEffectiveIntervalMs(): number {
    return pauseWhenStatic
      ? Math.max(MIN_LIVE_VIDEO_CAPTURE_INTERVAL_MS, config.intervalMs)
      : config.intervalMs;
  }

  function isVideoReady(video: HTMLVideoElement | null): video is HTMLVideoElement {
    return Boolean(video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0);
  }

  function isPeriodicSuspended(video: HTMLVideoElement | null): boolean {
    return pauseWhenStatic && (!video || Boolean(video.paused) || Boolean(video.ended) || isHidden());
  }

  function clearPeriodicTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function clearSeekTimer(): void {
    if (seekTimer !== null) {
      clearTimeout(seekTimer);
      seekTimer = null;
    }
  }

  function computeFrameKey(video: HTMLVideoElement, source: string): string {
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    return `${source}:${currentTime}:${video.videoWidth}x${video.videoHeight}`;
  }

  function encodeVideoToBlob(
    video: HTMLVideoElement,
    onBlob: (blob: Blob | null) => void
  ): boolean {
    if (!canvas) canvas = createCanvas();
    if (!canvas) return false;
    const { width, height } = getVideoFrameSize(video.videoWidth, video.videoHeight, config.maxLongSide);
    const context = canvas.getContext("2d");
    if (!context) return false;
    canvas.width = width;
    canvas.height = height;
    context.drawImage(video, 0, 0, width, height);
    canvas.toBlob(onBlob, "image/jpeg", config.jpegQuality);
    return true;
  }

  function onVideoActive(): void {
    if (stopped) return;
    const video = selectVideo();
    if (isPeriodicSuspended(video)) return;
    const intervalMs = getEffectiveIntervalMs();
    const elapsed = lastCaptureAt > 0 ? Date.now() - lastCaptureAt : intervalMs;
    clearPeriodicTimer();
    if (elapsed >= intervalMs) {
      captureFrame("periodic");
      scheduleNext();
      return;
    }
    scheduleNext(Math.max(1, intervalMs - elapsed));
  }

  function onVideoPausedOrEnded(): void {
    if (stopped || !pauseWhenStatic) return;
    clearPeriodicTimer();
  }

  function onDocumentVisibilityChange(): void {
    if (stopped || !pauseWhenStatic) return;
    if (isHidden()) {
      clearPeriodicTimer();
      clearSeekTimer();
      pendingSeekCapture = false;
      return;
    }
    onVideoActive();
  }

  function onVideoSeeked(): void {
    if (stopped || !pauseWhenStatic || isHidden()) return;
    clearSeekTimer();
    seekTimer = setTimeout(() => {
      seekTimer = null;
      if (stopped || isHidden()) return;
      if (encoding) {
        pendingSeekCapture = true;
        return;
      }
      captureFrame("seek");
      const video = selectVideo();
      if (!isPeriodicSuspended(video)) {
        clearPeriodicTimer();
        scheduleNext();
      }
    }, seekDebounceMs);
  }

  function unbindVideoEvents(): void {
    const target = boundVideoListenersTarget;
    boundVideoListenersTarget = null;
    if (target && typeof target.removeEventListener === "function") {
      target.removeEventListener("play", onVideoActive);
      target.removeEventListener("playing", onVideoActive);
      target.removeEventListener("pause", onVideoPausedOrEnded);
      target.removeEventListener("ended", onVideoPausedOrEnded);
      target.removeEventListener("seeked", onVideoSeeked);
    }
  }

  function bindVideoEvents(video: HTMLVideoElement | null): void {
    if (!pauseWhenStatic) return;
    if (boundVideoListenersTarget === video) return;
    unbindVideoEvents();
    if (video && typeof video.addEventListener === "function") {
      boundVideoListenersTarget = video;
      video.addEventListener("play", onVideoActive);
      video.addEventListener("playing", onVideoActive);
      video.addEventListener("pause", onVideoPausedOrEnded);
      video.addEventListener("ended", onVideoPausedOrEnded);
      video.addEventListener("seeked", onVideoSeeked);
    }
  }

  if (pauseWhenStatic && typeof document !== "undefined" && typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", onDocumentVisibilityChange);
    visibilityListenerBound = true;
  }

  function selectVideo(): HTMLVideoElement | null {
    const video = getVideo();
    const source = video ? getVideoSource(video) : "";
    if (video !== activeVideo || source !== activeSource) {
      activeVideo = video;
      activeSource = source;
      sourceGeneration += 1;
      lastFrameKey = "";
      lastJpegBytes = null;
      bindVideoEvents(video);
    }
    return video;
  }

  async function finishEncoding(
    blob: Blob | null,
    video: HTMLVideoElement,
    source: string,
    generation: number,
    frameKey: string,
    reason: "periodic" | "seek"
  ): Promise<void> {
    try {
      if (!blob) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const currentVideo = getVideo();
      if (
        stopped ||
        generation !== sourceGeneration ||
        currentVideo !== video ||
        (currentVideo ? getVideoSource(currentVideo) : "") !== source ||
        bytes.byteLength === 0
      ) {
        return;
      }
      if (reason === "periodic" && isPeriodicSuspended(currentVideo)) {
        return;
      }
      if (reason === "seek" && isHidden()) {
        return;
      }
      lastFrameKey = frameKey;
      lastJpegBytes = bytes;
      lastCaptureAt = Date.now();
      options.onJpegFrame(bytes);
    } catch {
      // 单帧读取或编码失败不影响后续抽帧。
    } finally {
      encoding = false;
      if (pendingSeekCapture && !stopped && !isHidden()) {
        pendingSeekCapture = false;
        captureFrame("seek");
      }
    }
  }

  function captureFrame(reason: "periodic" | "seek" = "periodic"): void {
    if (stopped || encoding) return;
    const video = selectVideo();
    if (!isVideoReady(video)) return;
    if (reason === "periodic" && isPeriodicSuspended(video)) return;
    if (reason === "seek" && isHidden()) return;

    const source = getVideoSource(video);
    const frameKey = computeFrameKey(video, source);
    if (frameKey === lastFrameKey) {
      if (!pauseWhenStatic && lastJpegBytes) {
        lastCaptureAt = Date.now();
        options.onJpegFrame(lastJpegBytes);
      }
      return;
    }

    encoding = true;
    const generation = sourceGeneration;
    try {
      const started = encodeVideoToBlob(video, (blob) => {
        void finishEncoding(blob, video, source, generation, frameKey, reason);
      });
      if (!started) {
        encoding = false;
      }
    } catch {
      encoding = false;
    }
  }

  function scheduleNext(delayMs = getEffectiveIntervalMs()): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      const video = selectVideo();
      if (!isPeriodicSuspended(video)) {
        captureFrame("periodic");
        scheduleNext();
        return;
      }
      // 无 addEventListener 的纯对象桩仍需低频巡检状态变化；真实 DOM 节点由 play/visibility 事件唤醒。
      if (video && typeof video.addEventListener !== "function") {
        scheduleNext();
      }
    }, delayMs);
  }

  const initialVideo = selectVideo();
  if (!isPeriodicSuspended(initialVideo)) {
    captureFrame("periodic");
    scheduleNext();
  } else if (initialVideo && typeof initialVideo.addEventListener !== "function") {
    scheduleNext();
  }

  return {
    configure(next: Partial<MossVideoCaptureConfig>): void {
      if (stopped) return;
      const previous = config;
      const previousInterval = getEffectiveIntervalMs();
      config = { ...config, ...next };
      if (
        config.maxLongSide !== previous.maxLongSide ||
        config.jpegQuality !== previous.jpegQuality
      ) {
        // 画质变化后旧缓存帧尺寸/质量已过期，下一帧强制重编码。
        lastFrameKey = "";
        lastJpegBytes = null;
      }
      if (getEffectiveIntervalMs() !== previousInterval && timer !== null) {
        clearPeriodicTimer();
        scheduleNext();
      }
    },
    isSuspended(): boolean {
      return isPeriodicSuspended(selectVideo());
    },
    async captureSnapshot(): Promise<Uint8Array<ArrayBuffer> | null> {
      if (stopped) return null;
      const video = selectVideo();
      if (!isVideoReady(video)) return null;
      const source = getVideoSource(video);
      const frameKey = computeFrameKey(video, source);
      if (frameKey === lastFrameKey && lastJpegBytes) {
        return lastJpegBytes;
      }
      const generation = sourceGeneration;
      const blob = await new Promise<Blob | null>((resolve) => {
        try {
          if (!encodeVideoToBlob(video, resolve)) {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
      if (!blob) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const currentVideo = getVideo();
      if (
        stopped ||
        generation !== sourceGeneration ||
        currentVideo !== video ||
        (currentVideo ? getVideoSource(currentVideo) : "") !== source ||
        bytes.byteLength === 0
      ) {
        return null;
      }
      lastFrameKey = frameKey;
      lastJpegBytes = bytes;
      return bytes;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      pendingSeekCapture = false;
      sourceGeneration += 1;
      clearPeriodicTimer();
      clearSeekTimer();
      unbindVideoEvents();
      if (visibilityListenerBound && typeof document !== "undefined" && typeof document.removeEventListener === "function") {
        document.removeEventListener("visibilitychange", onDocumentVisibilityChange);
        visibilityListenerBound = false;
      }
      activeVideo = null;
      activeSource = "";
      lastFrameKey = "";
      lastJpegBytes = null;
      if (canvas) {
        canvas.width = 0;
        canvas.height = 0;
        canvas = null;
      }
    }
  };
}
