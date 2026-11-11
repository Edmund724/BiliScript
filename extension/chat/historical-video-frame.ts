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
  signal?: AbortSignal;
}

export interface HistoricalVideoFrameSnapshot extends PageVideoFrameSnapshot {
  targetTime: number;
}

function abortError(): DOMException {
  return new DOMException("历史帧截取已中止", "AbortError");
}

function waitForVideo(
  video: HTMLVideoElement,
  eventType: "loadedmetadata" | "canplay" | "seeked",
  predicate: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      video.removeEventListener(eventType, onReady);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("error", onError);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
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
    signal?.addEventListener("abort", onAbort, { once: true });
    video.addEventListener(eventType, onReady);
    video.addEventListener("canplay", onReady);
    video.addEventListener("error", onError);
  });
}

export async function captureHistoricalVideoFrame(
  { bvid, cid, targetTime }: HistoricalVideoFrameInput,
  options: HistoricalVideoFrameOptions = {}
): Promise<HistoricalVideoFrameSnapshot[]> {
  if (!Number.isFinite(targetTime) || targetTime < 0) {
    throw new Error("目标时间点必须是大于或等于 0 的有限秒数");
  }
  const timeoutMs = options.timeoutMs ?? MEDIA_TIMEOUT_MS;
  const controller = new AbortController();
  let video: HTMLVideoElement | null = null;
  let cleaned = false;
  const cleanup = () => {
    if (!video || cleaned) return;
    cleaned = true;
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  };
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) throw abortError();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 唯一监听调用方 signal 的是 onAbort；race 侧的 aborted 只观察内部 controller，
  // 随本次取帧一起回收，不在调用方 signal 上留下第二个匿名监听。
  const aborted = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`历史帧截取超时（${timeoutMs} 毫秒）`));
      controller.abort();
    }, timeoutMs);
  });
  const run = async (): Promise<HistoricalVideoFrameSnapshot[]> => {
    try {
      const transport = options.transport ?? contentFetchJson;
      const payload = await transport(buildPlayurlUrl(bvid, cid)) as PlayurlResponse | null;
      if (controller.signal.aborted) throw abortError();
      if (payload?.code !== 0) {
        throw new Error(payload?.message || "无法获取视频流地址");
      }
      const source = payload.data?.durl?.[0]?.url;
      if (!source) {
        throw new Error("视频接口没有返回可直接截帧的 MP4");
      }

      video = (options.createVideo ?? (() => document.createElement("video")))();
      video.crossOrigin = "anonymous";
      video.muted = true;
      video.defaultMuted = true;
      video.preload = "auto";
      video.playsInline = true;
      video.dataset.biliscriptHistoricalFrame = "";
      video.style.cssText = "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;visibility:hidden";
      video.src = source;
      document.body.appendChild(video);
      await waitForVideo(video, "loadedmetadata", () => video!.readyState >= 1, timeoutMs, controller.signal);
      if (Number.isFinite(video.duration) && targetTime > video.duration) {
        throw new Error(`目标时间点 ${targetTime} 秒超出视频时长 ${video.duration} 秒`);
      }
      await waitForVideo(video, "canplay", () => video!.readyState >= 2, timeoutMs, controller.signal);
      const frames: HistoricalVideoFrameSnapshot[] = [];
      const duration = Number.isFinite(video.duration) ? Math.max(0, video.duration) : Number.POSITIVE_INFINITY;
      const frameTimes = [targetTime - 2, targetTime, targetTime + 2]
        .map((time) => Math.min(duration, Math.max(0, time)));
      for (const frameTime of frameTimes) {
        try {
          const seeked = waitForVideo(
            video!,
            "seeked",
            () => Math.abs(video!.currentTime - frameTime) <= SEEK_TOLERANCE_SECONDS && video!.readyState >= 2,
            timeoutMs,
            controller.signal
          );
          video.currentTime = frameTime;
          await seeked;
          frames.push({
            ...await capturePageVideoFrame({
              getVideo: () => video,
              createCanvas: options.createCanvas
            }),
            targetTime: frameTime
          });
        } catch (error) {
          if (controller.signal.aborted) throw abortError();
          // 单帧失败不阻断其余时间点；仅成功画面进入后续模型请求。
        }
      }
      return frames;
    } finally {
      cleanup();
    }
  };
  try {
    return await Promise.race([run(), aborted, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    cleanup();
  }
}
