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

export interface PageVideoFrameCaptureOptions {
  onJpegFrame: (jpegBytes: Uint8Array<ArrayBuffer>) => void;
  getVideo?: () => HTMLVideoElement | null;
  createCanvas?: () => HTMLCanvasElement | null;
  /** 初始抽帧参数；缺省为服务端 standard 默认值。 */
  config?: Partial<MossVideoCaptureConfig>;
}

export interface PageVideoFrameCaptureSession {
  stop(): void;
  /** 按服务端回执重配抽帧参数（长边、质量即时生效；间隔变更重新排期）。 */
  configure(config: Partial<MossVideoCaptureConfig>): void;
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
  let stopped = false;
  let encoding = false;
  let sourceGeneration = 0;
  let activeVideo: HTMLVideoElement | null = null;
  let activeSource = "";
  let lastFrameKey = "";
  let lastJpegBytes: Uint8Array<ArrayBuffer> | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let config: MossVideoCaptureConfig = { ...MOSS_STANDARD_VIDEO_CONFIG, ...options.config };
  let timer: ReturnType<typeof setTimeout> | null = null;

  function selectVideo(): HTMLVideoElement | null {
    const video = getVideo();
    const source = video ? getVideoSource(video) : "";
    if (video !== activeVideo || source !== activeSource) {
      activeVideo = video;
      activeSource = source;
      sourceGeneration += 1;
      lastFrameKey = "";
      lastJpegBytes = null;
    }
    return video;
  }

  async function finishEncoding(
    blob: Blob | null,
    video: HTMLVideoElement,
    source: string,
    generation: number,
    frameKey: string
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
      options.onJpegFrame(bytes);
      lastFrameKey = frameKey;
      lastJpegBytes = bytes;
    } catch {
      // 单帧读取或编码失败不影响后续抽帧。
    } finally {
      encoding = false;
    }
  }

  function captureFrame(): void {
    if (stopped || encoding) return;
    const video = selectVideo();
    if (!video || video.readyState < 2 || video.videoWidth <= 0 || video.videoHeight <= 0) return;

    const source = getVideoSource(video);
    const currentTime = Number.isFinite(video.currentTime) ? video.currentTime : 0;
    const frameKey = `${source}:${currentTime}:${video.videoWidth}x${video.videoHeight}`;
    if (frameKey === lastFrameKey) {
      if (lastJpegBytes) {
        options.onJpegFrame(lastJpegBytes);
      }
      return;
    }

    if (!canvas) canvas = createCanvas();
    if (!canvas) return;

    const { width, height } = getVideoFrameSize(video.videoWidth, video.videoHeight, config.maxLongSide);
    const context = canvas.getContext("2d");
    if (!context) return;

    encoding = true;
    const generation = sourceGeneration;
    try {
      canvas.width = width;
      canvas.height = height;
      context.drawImage(video, 0, 0, width, height);
      canvas.toBlob((blob) => {
        void finishEncoding(blob, video, source, generation, frameKey);
      }, "image/jpeg", config.jpegQuality);
    } catch {
      encoding = false;
    }
  }

  function scheduleNext(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      captureFrame();
      scheduleNext();
    }, config.intervalMs);
  }

  captureFrame();
  scheduleNext();

  return {
    configure(next: Partial<MossVideoCaptureConfig>): void {
      if (stopped) return;
      const previous = config;
      config = { ...config, ...next };
      if (
        config.maxLongSide !== previous.maxLongSide ||
        config.jpegQuality !== previous.jpegQuality
      ) {
        // 画质变化后旧缓存帧尺寸/质量已过期，下一帧强制重编码。
        lastFrameKey = "";
        lastJpegBytes = null;
      }
      if (config.intervalMs !== previous.intervalMs && timer !== null) {
        clearTimeout(timer);
        timer = null;
        scheduleNext();
      }
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      sourceGeneration += 1;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
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
