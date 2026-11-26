import { contentFetchJson, type JsonTransport } from "../bilibili/gateway.js";
import { getOpenerDocument } from "../shared/active-host.js";
import { decodeVideoStorageBvid, normalizeSiteId, type SiteId } from "../shared/site.js";
import {
  capturePageVideoFrame,
  type PageVideoFrameCaptureOptions,
  type PageVideoFrameSnapshot
} from "../live/page-video-frame-capture.js";
import {
  fetchYoutubeVideoWindow,
  type FetchYoutubeVideoWindowOptions,
  type YoutubeVideoWindowPayload
} from "../youtube/audio-source.js";

function buildHistoricalPlayurlUrl(bvid: string, cid: string): string {
  return (
    "https://api.bilibili.com/x/player/playurl" +
    `?bvid=${encodeURIComponent(bvid)}` +
    `&cid=${encodeURIComponent(cid)}` +
    "&qn=16" +
    "&fnval=1" +
    "&platform=html5" +
    "&high_quality=1"
  );
}

const MEDIA_TIMEOUT_MS = 45000;
const SEEK_TOLERANCE_SECONDS = 0.15;
const HIDDEN_VIDEO_STYLE =
  "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;visibility:hidden";

interface PlayurlResponse {
  code?: number;
  message?: string;
  data?: { durl?: Array<{ url?: string }> | null };
}

export interface HistoricalVideoFrameInput {
  site?: SiteId;
  bvid: string;
  cid: string;
  targetTime: number;
}

export interface HistoricalVideoFrameOptions {
  transport?: JsonTransport;
  createVideo?: () => HTMLVideoElement;
  createCanvas?: PageVideoFrameCaptureOptions["createCanvas"];
  fetchYoutubeWindow?: (options: FetchYoutubeVideoWindowOptions) => Promise<YoutubeVideoWindowPayload>;
  createMediaSource?: () => MediaSource;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface HistoricalVideoFrameSnapshot extends PageVideoFrameSnapshot {
  targetTime: number;
}

function abortError(): DOMException {
  return new DOMException("历史帧截取已中止", "AbortError");
}

function prepareHiddenVideo(
  openerDoc: Document,
  createVideo?: () => HTMLVideoElement,
  crossOrigin?: string
): HTMLVideoElement {
  const media = (createVideo ?? (() => openerDoc.createElement("video")))();
  if (crossOrigin) {
    media.crossOrigin = crossOrigin;
  }
  media.muted = true;
  media.defaultMuted = true;
  media.preload = "auto";
  media.playsInline = true;
  media.dataset.biliscriptHistoricalFrame = "";
  media.style.cssText = HIDDEN_VIDEO_STYLE;
  return media;
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

export interface HistoricalVideoFrameSession {
  capture(
    targetTime: number,
    options?: Pick<HistoricalVideoFrameOptions, "timeoutMs" | "signal">
  ): Promise<HistoricalVideoFrameSnapshot[]>;
  close(): void;
}

function appendBufferAsync(
  sourceBuffer: SourceBuffer,
  data: ArrayBuffer,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener("updateend", onDone);
      sourceBuffer.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("写入视频解码缓冲区失败"));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    sourceBuffer.addEventListener("updateend", onDone, { once: true });
    sourceBuffer.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    sourceBuffer.appendBuffer(data);
  });
}

function clampToBufferedRange(video: HTMLVideoElement, timeSec: number): number {
  const ranges = video.buffered;
  if (!ranges || ranges.length === 0) return timeSec;
  let best = timeSec;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ranges.length; i += 1) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (timeSec >= start && timeSec <= end) return timeSec;
    const clamped = timeSec < start ? start : end;
    const dist = Math.abs(clamped - timeSec);
    if (dist < bestDist) {
      bestDist = dist;
      best = clamped;
    }
  }
  return best;
}

async function captureFrameTriplet(
  media: HTMLVideoElement,
  frameTimes: readonly number[],
  timeoutMs: number,
  signal: AbortSignal,
  createCanvas?: PageVideoFrameCaptureOptions["createCanvas"]
): Promise<HistoricalVideoFrameSnapshot[]> {
  const frames: HistoricalVideoFrameSnapshot[] = [];
  for (const frameTime of frameTimes) {
    try {
      const seeked = waitForVideo(
        media,
        "seeked",
        () => Math.abs(media.currentTime - frameTime) <= SEEK_TOLERANCE_SECONDS && media.readyState >= 2,
        timeoutMs,
        signal
      );
      media.currentTime = frameTime;
      await seeked;
      frames.push({
        ...(await capturePageVideoFrame({
          getVideo: () => media,
          createCanvas
        })),
        targetTime: frameTime
      });
    } catch {
      if (signal.aborted) throw abortError();
    }
  }
  return frames;
}

export function createHistoricalVideoFrameSession(
  { site, bvid, cid }: Omit<HistoricalVideoFrameInput, "targetTime">,
  options: HistoricalVideoFrameOptions = {}
): HistoricalVideoFrameSession {
  const resolvedSite = normalizeSiteId(site);
  let video: HTMLVideoElement | null = null;
  let closed = false;
  let activeController: AbortController | null = null;

  const disposeVideo = (target: HTMLVideoElement | null, objectUrl?: string): void => {
    if (target) {
      target.pause();
      target.removeAttribute("src");
      target.load();
      target.remove();
    }
    if (objectUrl) {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
      }
    }
  };

  const close = (): void => {
    closed = true;
    activeController?.abort();
    disposeVideo(video);
    video = null;
  };

  const captureYoutubeFrames = async (
    targetTime: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<HistoricalVideoFrameSnapshot[]> => {
    const fetchWindow = options.fetchYoutubeWindow ?? fetchYoutubeVideoWindow;
    const videoId = decodeVideoStorageBvid(bvid);
    const wantStartMs = Math.max(0, Math.floor((targetTime - 2) * 1000));
    const wantEndMs = Math.ceil((targetTime + 2) * 1000);
    const payload = await fetchWindow({
      videoId,
      startMs: wantStartMs,
      endMs: wantEndMs,
      timeoutMs,
      signal
    });
    if (signal.aborted) throw abortError();
    if (payload.durationMs > 0 && targetTime > payload.durationMs / 1000) {
      throw new Error(`目标时间点 ${targetTime} 秒超出视频时长 ${(payload.durationMs / 1000).toFixed(1)} 秒`);
    }

    const mediaSource = options.createMediaSource
      ? options.createMediaSource()
      : new MediaSource();
    const openerDoc = getOpenerDocument();
    const media = prepareHiddenVideo(openerDoc, options.createVideo);
    const objectUrl = URL.createObjectURL(mediaSource);

    try {
      const sourceOpen = new Promise<void>((resolve, reject) => {
        if (mediaSource.readyState === "open") {
          resolve();
          return;
        }
        const onOpen = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          mediaSource.removeEventListener("sourceopen", onOpen);
          reject(abortError());
        };
        mediaSource.addEventListener("sourceopen", onOpen, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
      });

      media.src = objectUrl;
      openerDoc.body.appendChild(media);
      await sourceOpen;
      if (signal.aborted) throw abortError();

      const sourceBuffer = mediaSource.addSourceBuffer(payload.mimeType);
      await appendBufferAsync(sourceBuffer, payload.initSegment, signal);
      for (const seg of payload.mediaSegments) {
        await appendBufferAsync(sourceBuffer, seg, signal);
      }
      if (mediaSource.readyState === "open" && !sourceBuffer.updating) {
        try {
          mediaSource.endOfStream();
        } catch {
        }
      }

      const duration =
        Number.isFinite(media.duration) && media.duration > 0
          ? media.duration
          : payload.durationMs > 0
            ? payload.durationMs / 1000
            : Number.POSITIVE_INFINITY;
      const frameTimes = [targetTime - 2, targetTime, targetTime + 2].map((time) =>
        clampToBufferedRange(media, Math.min(duration, Math.max(0, time)))
      );
      return await captureFrameTriplet(media, frameTimes, timeoutMs, signal, options.createCanvas);
    } finally {
      disposeVideo(media, objectUrl);
    }
  };

  const captureBilibiliFrames = async (
    targetTime: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<HistoricalVideoFrameSnapshot[]> => {
    if (!video) {
      const transport = options.transport ?? contentFetchJson;
      const payload = (await transport(buildHistoricalPlayurlUrl(bvid, cid))) as PlayurlResponse | null;
      if (signal.aborted) throw abortError();
      if (payload?.code !== 0) {
        throw new Error(payload?.message || "无法获取视频流地址");
      }
      const source = payload.data?.durl?.[0]?.url;
      if (!source) {
        throw new Error("视频接口没有返回可直接截帧的 MP4");
      }

      const openerDoc = getOpenerDocument();
      video = prepareHiddenVideo(openerDoc, options.createVideo, "anonymous");
      video.src = source;
      openerDoc.body.appendChild(video);
      await waitForVideo(video, "loadedmetadata", () => video!.readyState >= 1, timeoutMs, signal);
    }
    const media = video;
    if (Number.isFinite(media.duration) && targetTime > media.duration) {
      throw new Error(`目标时间点 ${targetTime} 秒超出视频时长 ${media.duration} 秒`);
    }
    const duration = Number.isFinite(media.duration) ? Math.max(0, media.duration) : Number.POSITIVE_INFINITY;
    const frameTimes = [targetTime - 2, targetTime, targetTime + 2].map((time) =>
      Math.min(duration, Math.max(0, time))
    );
    return await captureFrameTriplet(media, frameTimes, timeoutMs, signal, options.createCanvas);
  };

  const capture = async (
    targetTime: number,
    captureOptions: Pick<HistoricalVideoFrameOptions, "timeoutMs" | "signal"> = {}
  ): Promise<HistoricalVideoFrameSnapshot[]> => {
    if (!Number.isFinite(targetTime) || targetTime < 0) {
      throw new Error("目标时间点必须是大于或等于 0 的有限秒数");
    }
    if (closed || captureOptions.signal?.aborted) throw abortError();
    if (activeController) throw new Error("历史帧会话已有截取进行中");
    const timeoutMs = captureOptions.timeoutMs ?? options.timeoutMs ?? MEDIA_TIMEOUT_MS;
    const controller = new AbortController();
    activeController = controller;
    const onAbort = () => controller.abort();
    captureOptions.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | null = null;
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
    });
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`历史帧截取超时（${timeoutMs} 毫秒）`));
        controller.abort();
      }, timeoutMs);
    });
    const run = async (): Promise<HistoricalVideoFrameSnapshot[]> =>
      resolvedSite === "youtube"
        ? captureYoutubeFrames(targetTime, timeoutMs, controller.signal)
        : captureBilibiliFrames(targetTime, timeoutMs, controller.signal);
    try {
      return await Promise.race([run(), aborted, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      captureOptions.signal?.removeEventListener("abort", onAbort);
      if (activeController === controller) activeController = null;
    }
  };

  return { capture, close };
}

export async function captureHistoricalVideoFrame(
  { site, bvid, cid, targetTime }: HistoricalVideoFrameInput,
  options: HistoricalVideoFrameOptions = {}
): Promise<HistoricalVideoFrameSnapshot[]> {
  const session = createHistoricalVideoFrameSession({ site, bvid, cid }, options);
  try {
    return await session.capture(targetTime, options);
  } finally {
    session.close();
  }
}
