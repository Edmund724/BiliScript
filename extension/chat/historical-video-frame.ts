import { buildPlayurlUrl } from "../asr/audio-source.js";
import { contentFetchJson, type JsonTransport } from "../bilibili/gateway.js";
import {
  capturePageVideoFrame,
  type PageVideoFrameCaptureOptions,
  type PageVideoFrameSnapshot
} from "../live/page-video-frame-capture.js";

const MEDIA_TIMEOUT_MS = 45000;
const SEEK_TOLERANCE_SECONDS = 0.15;

interface PlayurlResponse {
  code?: number;
  message?: string;
  data?: { durl?: Array<{ url?: string }> | null };
}

export interface HistoricalVideoFrameInput {
  bvid: string;
  cid: string;
  targetTime: number;
}

export interface HistoricalVideoFrameOptions {
  transport?: JsonTransport;
  createVideo?: () => HTMLVideoElement;
  createCanvas?: PageVideoFrameCaptureOptions["createCanvas"];
  timeoutMs?: number;
}

function waitForVideo(
  video: HTMLVideoElement,
  eventType: "loadedmetadata" | "canplay" | "seeked",
  predicate: () => boolean,
  timeoutMs: number
): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener(eventType, onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const onReady = () => {
      if (!predicate()) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      const mediaError = video.error;
      reject(new Error(`隐藏视频 ${eventType} 失败：${mediaError ? `${mediaError.code} ${mediaError.message}` : "未知媒体错误"}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`等待隐藏视频 ${eventType} 超时；readyState=${video.readyState}，networkState=${video.networkState}`));
    }, timeoutMs);
    video.addEventListener(eventType, onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
  });
}

export async function captureHistoricalVideoFrame(
  { bvid, cid, targetTime }: HistoricalVideoFrameInput,
  options: HistoricalVideoFrameOptions = {}
): Promise<PageVideoFrameSnapshot[]> {
  if (!Number.isFinite(targetTime) || targetTime < 0) {
    throw new Error("目标时间点必须是大于或等于 0 的有限秒数");
  }
  const transport = options.transport ?? contentFetchJson;
  const payload = await transport(buildPlayurlUrl(bvid, cid)) as PlayurlResponse | null;
  if (payload?.code !== 0) {
    throw new Error(payload?.message || "无法获取视频流地址");
  }
  const source = payload.data?.durl?.[0]?.url;
  if (!source) {
    throw new Error("视频接口没有返回可直接截帧的 MP4");
  }

  const video = (options.createVideo ?? (() => document.createElement("video")))();
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.defaultMuted = true;
  video.preload = "auto";
  video.playsInline = true;
  video.dataset.biliscriptHistoricalFrame = "";
  video.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;visibility:hidden";
  const timeoutMs = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  try {
    video.src = source;
    document.body.appendChild(video);
    await waitForVideo(video, "loadedmetadata", () => video.readyState >= 1, timeoutMs);
    if (Number.isFinite(video.duration) && targetTime > video.duration) {
      throw new Error(`目标时间点 ${targetTime} 秒超出视频时长 ${video.duration} 秒`);
    }
    await waitForVideo(video, "canplay", () => video.readyState >= 2, timeoutMs);
    const frames: PageVideoFrameSnapshot[] = [];
    const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : Number.POSITIVE_INFINITY;
    const frameTimes = [targetTime - 2, targetTime, targetTime + 2]
      .map((time) => Math.min(duration, Math.max(0, time)));
    for (const frameTime of frameTimes) {
      try {
        const seeked = waitForVideo(
          video,
          "seeked",
          () => Math.abs(video.currentTime - frameTime) <= SEEK_TOLERANCE_SECONDS && video.readyState >= 2,
          timeoutMs
        );
        video.currentTime = frameTime;
        await seeked;
        frames.push(await capturePageVideoFrame({
          getVideo: () => video,
          createCanvas: options.createCanvas
        }));
      } catch {
        // 单帧失败不阻断其余时间点；仅成功画面进入后续模型请求。
      }
    }
    return frames;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}
