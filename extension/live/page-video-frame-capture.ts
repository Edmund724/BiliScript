// 页面当前视频元素的 1fps JPEG 抽帧；单帧在飞，换来源或停止后丢弃迟到编码结果。

import { getRuntimeVideoElement } from "../bilibili/video-probe.js";

export const MOSS_VIDEO_FRAME_INTERVAL_MS = 1000;
export const MOSS_VIDEO_FRAME_MAX_EDGE = 960;
export const MOSS_VIDEO_JPEG_QUALITY = 0.72;

export interface PageVideoFrameCaptureOptions {
  onJpegFrame: (jpegBytes: Uint8Array<ArrayBuffer>) => void;
  getVideo?: () => HTMLVideoElement | null;
  createCanvas?: () => HTMLCanvasElement | null;
}

export interface PageVideoFrameCaptureSession {
  stop(): void;
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

    const { width, height } = getVideoFrameSize(video.videoWidth, video.videoHeight);
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
      }, "image/jpeg", MOSS_VIDEO_JPEG_QUALITY);
    } catch {
      encoding = false;
    }
  }

  const timer = setInterval(captureFrame, MOSS_VIDEO_FRAME_INTERVAL_MS);
  captureFrame();

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      sourceGeneration += 1;
      clearInterval(timer);
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
