import { contentFetchJson, type JsonTransport } from "../bilibili/gateway.js";
import { getOpenerDocument } from "../shared/active-host.js";
import { contentEventBus } from "../shared/content-event-bus.js";
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
export const IDLE_VIDEO_DISPOSE_MS = 20_000;
export const DEDUP_EPSILON_SEC = 0.25;
export const YT_PRE_PAD_MS = 600;
export const YT_POST_PAD_MS = 600;
export const YT_MAX_CLUSTER_GAP_MS = 10_000;
export const YT_MAX_CLUSTER_SPAN_MS = 20_000;
export const YT_MAX_CLUSTERS_PER_CALL = 6;
export const MAX_CLAMP_DRIFT_SECONDS = 2.5;
const SEEK_TOLERANCE_SECONDS = 0.15;
const HIDDEN_VIDEO_STYLE =
  "position:fixed;left:-10000px;top:0;width:640px;height:360px;pointer-events:none;visibility:hidden";

interface PlayurlResponse {
  code?: number;
  message?: string;
  data?: { durl?: Array<{ url?: string }> | null };
}

export interface HistoricalFrameRequestSpec {
  times: readonly number[];
  spanSeconds?: number;
  maxFrames?: number;
}

export interface ExpandedFrameTarget {
  anchorTime: number;
  targetTime: number;
}

export interface ExpandFrameTargetsResult {
  targets: ExpandedFrameTarget[];
  truncatedTargets: ExpandedFrameTarget[];
}

export interface YoutubeCaptureCluster {
  startMs: number;
  endMs: number;
  targets: ExpandedFrameTarget[];
}

export interface ClusterYoutubeFrameWindowsOptions {
  maxClusters?: number;
}

export interface HistoricalVideoFrameSessionInput {
  site?: SiteId;
  bvid: string;
  cid: string;
}

export interface HistoricalVideoFrameInput extends HistoricalVideoFrameSessionInput {
  targetTime?: number;
  times?: readonly number[];
  spanSeconds?: number;
  maxFrames?: number;
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
  anchorTime?: number;
  targetTime: number;
}

interface InternalExpandedTarget extends ExpandedFrameTarget {
  isCenter: boolean;
}

function dedupeInternalTargets(items: InternalExpandedTarget[]): ExpandedFrameTarget[] {
  const sorted = items.slice().sort((a, b) => {
    if (a.targetTime !== b.targetTime) return a.targetTime - b.targetTime;
    if (a.isCenter !== b.isCenter) return a.isCenter ? -1 : 1;
    return a.anchorTime - b.anchorTime;
  });
  const deduped: InternalExpandedTarget[] = [];
  for (const item of sorted) {
    const last = deduped[deduped.length - 1];
    if (last && item.targetTime - last.targetTime < DEDUP_EPSILON_SEC) {
      if (!last.isCenter && item.isCenter) {
        deduped[deduped.length - 1] = item;
      }
      continue;
    }
    deduped.push(item);
  }
  return deduped.map(({ anchorTime, targetTime }) => ({ anchorTime, targetTime }));
}

export function expandAndDedupeFrameTargets(
  spec: HistoricalFrameRequestSpec,
  duration?: number
): ExpandFrameTargetsResult {
  if (!spec || !Array.isArray(spec.times) || spec.times.length === 0) {
    throw new Error("目标时间点列表不能为空");
  }
  const spanSeconds = spec.spanSeconds === undefined ? 0 : spec.spanSeconds;
  if (typeof spanSeconds !== "number" || !Number.isFinite(spanSeconds) || spanSeconds < 0) {
    throw new Error("邻域跨度必须是大于或等于 0 的有限秒数");
  }
  if (
    spec.maxFrames !== undefined &&
    (typeof spec.maxFrames !== "number" || !Number.isFinite(spec.maxFrames) || spec.maxFrames < 0)
  ) {
    throw new Error("最大帧数上限必须是大于或等于 0 的有限数字");
  }
  const hasDuration = typeof duration === "number" && Number.isFinite(duration) && duration > 0;
  const maxTime = hasDuration ? duration : Number.POSITIVE_INFINITY;
  const expanded: InternalExpandedTarget[] = [];
  for (const anchorTime of spec.times) {
    if (typeof anchorTime !== "number" || !Number.isFinite(anchorTime) || anchorTime < 0) {
      throw new Error("目标时间点必须是大于或等于 0 的有限秒数");
    }
    if (hasDuration && anchorTime > duration) {
      throw new Error(`目标时间点 ${anchorTime} 秒超出视频时长 ${duration.toFixed(1)} 秒`);
    }
    if (spanSeconds > 0) {
      const before = Math.min(maxTime, Math.max(0, anchorTime - spanSeconds));
      const after = Math.min(maxTime, Math.max(0, anchorTime + spanSeconds));
      expanded.push({ anchorTime, targetTime: before, isCenter: false });
      expanded.push({ anchorTime, targetTime: anchorTime, isCenter: true });
      expanded.push({ anchorTime, targetTime: after, isCenter: false });
    } else {
      expanded.push({ anchorTime, targetTime: anchorTime, isCenter: true });
    }
  }
  const deduped = dedupeInternalTargets(expanded);
  if (spec.maxFrames !== undefined) {
    const limit = Math.floor(spec.maxFrames);
    if (deduped.length > limit) {
      return {
        targets: deduped.slice(0, limit),
        truncatedTargets: deduped.slice(limit)
      };
    }
  }
  return { targets: deduped, truncatedTargets: [] };
}

export function clusterYoutubeFrameWindows(
  targets: readonly ExpandedFrameTarget[],
  options: ClusterYoutubeFrameWindowsOptions = {}
): YoutubeCaptureCluster[] {
  if (targets.length === 0) return [];
  const maxClusters = options.maxClusters ?? YT_MAX_CLUSTERS_PER_CALL;
  const sorted = targets.slice().sort((a, b) => a.targetTime - b.targetTime);
  const clusters: YoutubeCaptureCluster[] = [];
  for (const target of sorted) {
    const pointMs = Math.round(target.targetTime * 1000);
    const winStartMs = Math.max(0, Math.floor(target.targetTime * 1000) - YT_PRE_PAD_MS);
    const winEndMs = Math.ceil(target.targetTime * 1000) + YT_POST_PAD_MS;
    const current = clusters[clusters.length - 1];
    if (current) {
      const prevTarget = current.targets[current.targets.length - 1];
      const prevPointMs = Math.round(prevTarget.targetTime * 1000);
      const gapMs = pointMs - prevPointMs;
      const mergedEndMs = Math.max(current.endMs, winEndMs);
      const mergedSpanMs = mergedEndMs - current.startMs;
      if (gapMs <= YT_MAX_CLUSTER_GAP_MS && mergedSpanMs <= YT_MAX_CLUSTER_SPAN_MS) {
        current.endMs = mergedEndMs;
        current.targets.push(target);
        continue;
      }
    }
    clusters.push({
      startMs: winStartMs,
      endMs: winEndMs,
      targets: [target]
    });
  }
  if (clusters.length > maxClusters) {
    throw new Error(
      `单次 YouTube 历史截帧最多支持 ${maxClusters} 个分散时间窗口（当前需要 ${clusters.length} 个），请分批请求`
    );
  }
  return clusters;
}

export function clampTargetToBufferedWithDriftGuard(
  video: HTMLVideoElement,
  targetTime: number,
  maxDriftSeconds = MAX_CLAMP_DRIFT_SECONDS
): number | null {
  const ranges = video.buffered;
  if (!ranges || ranges.length === 0) return targetTime;
  let best = targetTime;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < ranges.length; i += 1) {
    const start = ranges.start(i);
    const end = ranges.end(i);
    if (targetTime >= start && targetTime <= end) return targetTime;
    const clamped = targetTime < start ? start : end;
    const dist = Math.abs(clamped - targetTime);
    if (dist < bestDist) {
      bestDist = dist;
      best = clamped;
    }
  }
  if (bestDist > maxDriftSeconds) {
    return null;
  }
  return best;
}

function normalizeCaptureSpec(request: number | HistoricalFrameRequestSpec): HistoricalFrameRequestSpec {
  if (typeof request === "number") {
    return { times: [request], spanSeconds: 0 };
  }
  return {
    times: request.times,
    spanSeconds: request.spanSeconds ?? 0,
    maxFrames: request.maxFrames
  };
}

function clampClusterTargetsToDuration(
  targets: readonly ExpandedFrameTarget[],
  duration?: number
): ExpandedFrameTarget[] {
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return targets.slice();
  }
  const internal: InternalExpandedTarget[] = targets.map((target) => {
    const isCenter = Math.abs(target.targetTime - target.anchorTime) < 1e-9;
    return {
      anchorTime: target.anchorTime,
      targetTime: Math.min(duration, Math.max(0, target.targetTime)),
      isCenter
    };
  });
  return dedupeInternalTargets(internal);
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
  media.preload = "metadata";
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
    request: number | HistoricalFrameRequestSpec,
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

async function captureExpandedTargets(
  media: HTMLVideoElement,
  targets: readonly ExpandedFrameTarget[],
  timeoutMs: number,
  signal: AbortSignal,
  createCanvas?: PageVideoFrameCaptureOptions["createCanvas"]
): Promise<HistoricalVideoFrameSnapshot[]> {
  const frames: HistoricalVideoFrameSnapshot[] = [];
  for (const target of targets) {
    try {
      const seeked = waitForVideo(
        media,
        "seeked",
        () => Math.abs(media.currentTime - target.targetTime) <= SEEK_TOLERANCE_SECONDS && media.readyState >= 2,
        timeoutMs,
        signal
      );
      media.currentTime = target.targetTime;
      await seeked;
      frames.push({
        ...(await capturePageVideoFrame({
          getVideo: () => media,
          createCanvas
        })),
        anchorTime: target.anchorTime,
        targetTime: target.targetTime
      });
    } catch {
      if (signal.aborted) throw abortError();
    }
  }
  return frames;
}

export function createHistoricalVideoFrameSession(
  { site, bvid, cid }: HistoricalVideoFrameSessionInput,
  options: HistoricalVideoFrameOptions = {}
): HistoricalVideoFrameSession {
  const resolvedSite = normalizeSiteId(site);
  let video: HTMLVideoElement | null = null;
  let closed = false;
  let activeController: AbortController | null = null;
  let idleDisposeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearIdleDisposeTimer = (): void => {
    if (idleDisposeTimer !== null) {
      clearTimeout(idleDisposeTimer);
      idleDisposeTimer = null;
    }
  };

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

  const disposeSessionVideo = (): void => {
    clearIdleDisposeTimer();
    disposeVideo(video);
    video = null;
  };

  const scheduleIdleDispose = (): void => {
    clearIdleDisposeTimer();
    if (!video || closed) {
      return;
    }
    idleDisposeTimer = setTimeout(() => {
      idleDisposeTimer = null;
      disposeSessionVideo();
    }, IDLE_VIDEO_DISPOSE_MS);
  };

  const stopClipSwitchWatch = contentEventBus.on("clip:switch-start", () => {
    disposeSessionVideo();
  });

  const close = (): void => {
    closed = true;
    stopClipSwitchWatch();
    activeController?.abort();
    disposeSessionVideo();
  };

  const captureYoutubeFrames = async (
    spec: HistoricalFrameRequestSpec,
    initialTargets: readonly ExpandedFrameTarget[],
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<HistoricalVideoFrameSnapshot[]> => {
    const clusters = clusterYoutubeFrameWindows(initialTargets);
    if (clusters.length === 0) return [];
    const fetchWindow = options.fetchYoutubeWindow ?? fetchYoutubeVideoWindow;
    const videoId = decodeVideoStorageBvid(bvid);
    const openerDoc = getOpenerDocument();

    interface ActiveMediaBuffer {
      media: HTMLVideoElement;
      mediaSource: MediaSource;
      sourceBuffer: SourceBuffer | null;
      objectUrl: string;
      mimeType: string;
      targets: ExpandedFrameTarget[];
    }

    const activeSlot: { current: ActiveMediaBuffer | null } = { current: null };
    let knownDuration: number | undefined;
    const allFrames: HistoricalVideoFrameSnapshot[] = [];

    const openMediaBuffer = async (mimeType: string): Promise<ActiveMediaBuffer> => {
      const mediaSource = options.createMediaSource
        ? options.createMediaSource()
        : new MediaSource();
      const media = prepareHiddenVideo(openerDoc, options.createVideo);
      const objectUrl = URL.createObjectURL(mediaSource);
      const buffer: ActiveMediaBuffer = {
        media,
        mediaSource,
        sourceBuffer: null,
        objectUrl,
        mimeType,
        targets: []
      };
      activeSlot.current = buffer;

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
      buffer.sourceBuffer = mediaSource.addSourceBuffer(mimeType);
      return buffer;
    };

    const flushActiveBuffer = async (): Promise<void> => {
      const current = activeSlot.current;
      if (!current) return;
      activeSlot.current = null;
      try {
        if (
          current.mediaSource.readyState === "open" &&
          current.sourceBuffer &&
          !current.sourceBuffer.updating
        ) {
          try {
            current.mediaSource.endOfStream();
          } catch {
          }
        }
        const duration =
          Number.isFinite(current.media.duration) && current.media.duration > 0
            ? current.media.duration
            : knownDuration;
        const durationClamped = clampClusterTargetsToDuration(current.targets, duration);
        const rawSeekTargets: InternalExpandedTarget[] = [];
        for (const target of durationClamped) {
          const clampedTime = clampTargetToBufferedWithDriftGuard(
            current.media,
            target.targetTime,
            MAX_CLAMP_DRIFT_SECONDS
          );
          if (clampedTime === null) {
            continue;
          }
          rawSeekTargets.push({
            anchorTime: target.anchorTime,
            targetTime: clampedTime,
            isCenter: Math.abs(target.targetTime - target.anchorTime) < 1e-9
          });
        }
        const seekTargets = dedupeInternalTargets(rawSeekTargets);
        const captured = await captureExpandedTargets(
          current.media,
          seekTargets,
          timeoutMs,
          signal,
          options.createCanvas
        );
        allFrames.push(...captured);
      } finally {
        disposeVideo(current.media, current.objectUrl);
      }
    };

    try {
      for (const cluster of clusters) {
        const payload = await fetchWindow({
          videoId,
          startMs: cluster.startMs,
          endMs: cluster.endMs,
          timeoutMs,
          signal
        });
        if (signal.aborted) throw abortError();
        if (payload.durationMs > 0 && knownDuration === undefined) {
          knownDuration = payload.durationMs / 1000;
          expandAndDedupeFrameTargets(spec, knownDuration);
        }
        if (activeSlot.current && activeSlot.current.mimeType !== payload.mimeType) {
          await flushActiveBuffer();
        }
        let targetBuffer = activeSlot.current;
        if (!targetBuffer) {
          targetBuffer = await openMediaBuffer(payload.mimeType);
          await appendBufferAsync(targetBuffer.sourceBuffer!, payload.initSegment, signal);
        }
        for (const seg of payload.mediaSegments) {
          await appendBufferAsync(targetBuffer.sourceBuffer!, seg, signal);
        }
        targetBuffer.targets.push(...cluster.targets);
      }
      await flushActiveBuffer();
      if (allFrames.length === 0) {
        throw new Error("目标时间点附近分片缺失，未截取到可用画面");
      }
      return allFrames;
    } finally {
      const leftover = activeSlot.current;
      if (leftover) {
        activeSlot.current = null;
        disposeVideo(leftover.media, leftover.objectUrl);
      }
    }
  };

  const captureBilibiliFrames = async (
    spec: HistoricalFrameRequestSpec,
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
      const created = prepareHiddenVideo(openerDoc, options.createVideo, "anonymous");
      created.src = source;
      openerDoc.body.appendChild(created);
      video = created;
      try {
        await waitForVideo(created, "loadedmetadata", () => created.readyState >= 1, timeoutMs, signal);
      } catch (error) {
        if (video === created) {
          disposeSessionVideo();
        } else {
          disposeVideo(created);
        }
        throw error;
      }
    }
    const media = video;
    const duration = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : undefined;
    const { targets } = expandAndDedupeFrameTargets(spec, duration);
    return await captureExpandedTargets(media, targets, timeoutMs, signal, options.createCanvas);
  };

  const capture = async (
    request: number | HistoricalFrameRequestSpec,
    captureOptions: Pick<HistoricalVideoFrameOptions, "timeoutMs" | "signal"> = {}
  ): Promise<HistoricalVideoFrameSnapshot[]> => {
    const spec = normalizeCaptureSpec(request);
    const initial = expandAndDedupeFrameTargets(spec);
    if (closed || captureOptions.signal?.aborted) throw abortError();
    if (activeController) throw new Error("历史帧会话已有截取进行中");
    clearIdleDisposeTimer();
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
        ? captureYoutubeFrames(spec, initial.targets, timeoutMs, controller.signal)
        : captureBilibiliFrames(spec, timeoutMs, controller.signal);
    try {
      return await Promise.race([run(), aborted, timedOut]);
    } finally {
      if (timer) clearTimeout(timer);
      captureOptions.signal?.removeEventListener("abort", onAbort);
      if (activeController === controller) activeController = null;
      if (!closed && video) {
        scheduleIdleDispose();
      }
    }
  };

  return { capture, close };
}

export async function captureHistoricalVideoFrame(
  { site, bvid, cid, targetTime, times, spanSeconds, maxFrames }: HistoricalVideoFrameInput,
  options: HistoricalVideoFrameOptions = {}
): Promise<HistoricalVideoFrameSnapshot[]> {
  const session = createHistoricalVideoFrameSession({ site, bvid, cid }, options);
  const request: HistoricalFrameRequestSpec = {
    times: times !== undefined ? times : targetTime !== undefined ? [targetTime] : [],
    spanSeconds: spanSeconds ?? 0,
    maxFrames
  };
  try {
    return await session.capture(request, options);
  } finally {
    session.close();
  }
}
