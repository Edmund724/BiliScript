import { setStatus } from "../core/ui-status.js";
import {
  state,
  clipState,
  triggerSubtitleSessionBoundary
} from "../core/state.js";
import type { SubtitleBodyItem } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import {
  YOUTUBE_UNIT_CID,
  detectActiveSite,
  extractYoutubeVideoId,
  getSiteCapabilities,
  type SiteId
} from "../shared/site.js";
import { getSettings } from "../core/runtime.js";
import {
  ensureRunActive,
  isStaleRunError,
  getErrorMessage,
  toReadableText,
  retryAsync
} from "../shared/error-helpers.js";
import { logInfo, logWarn, shouldDebugLog } from "../shared/logging.js";
import { isReaderViewOpen } from "../reader/state.js";
import { readVideoTitle, readVideoAuthor, readUploadDate, readVideoDescription, invalidateDerived } from "./core.js";
import { normalizeChapters } from "./chapters.js";
import {
  ASR_SUBTITLE_TRACK_ID,
  createAsrPseudoTrack,
  findTrackByRef,
  isAsrSubtitleTrack,
  isLoadableNativeTrack,
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  resolveTrackTarget
} from "./selection.js";
import {
  clearSubtitleCacheByKey,
  findCachedAsrSubtitleTrack,
  flushSubtitleCache
} from "./cache.js";
import { validateSubtitleByDuration } from "./duration-validation.js";
import { buildAsrSubtitleLabel } from "./labels.js";
import { buildSubtitleCandidates } from "./signature.js";
import { normalizeSubtitleUrlForCache } from "../bilibili/native-payload.js";
import { resolvePageContext } from "../reader/page-context.js";
import { notifyReaderPresenter, subscribeSubtitleRefresh } from "../reader/reader-bus.js";
import { acceptSubtitle, acceptSecondarySubtitle, commitNoSubtitle, configureCommitUi } from "./commit.js";
import {
  fetchVideoMeta as gatewayFetchVideoMeta,
  fetchSubtitleBundle as gatewayFetchSubtitleBundle,
  readRuntimeVideoDuration,
  contentFetchJson
} from "../bilibili/gateway.js";
import type { SubtitleTrack, VideoMeta } from "../bilibili/gateway.js";
import {
  resolveBiliSubtitleAccessBlocker,
  type BiliSubtitleAccessBlocker
} from "../bilibili/video-api.js";
import { loadTrackBody } from "./body.js";
import { slot } from "./slot.js";
import { clearTurnCapturedFrameCache } from "../notes/turn-frame-cache.js";

export function initSummarizeChain(): void {
  subscribeSubtitleRefresh(refreshClip);
}

configureCommitUi({
  setStatus
});

const YOUTUBE_CAPTIONS_UNAVAILABLE_CODE = "YOUTUBE_CAPTIONS_UNAVAILABLE";

function isYoutubeCaptionsUnavailableError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      (error as { code?: unknown }).code === YOUTUBE_CAPTIONS_UNAVAILABLE_CODE
  );
}

export async function tryLoadSubtitleCandidates(
  candidates: SubtitleTrack[],
  runId: number,
  forceRefresh: boolean
): Promise<SubtitleTrack> {
  let lastError: unknown = null;
  for (const item of candidates || []) {
    try {
      logInfo("[BILISCRIPT] try subtitle track", {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      });
      const target = resolveTrackTarget(item);
      await loadSubtitle(
        target.url,
        target.lang,
        runId,
        target.id,
        forceRefresh
      );
      return item;
    } catch (error) {
      lastError = error;
      const reasonCode = toReadableText((error as { code?: unknown }).code, "");
      const reasonMessage = getErrorMessage(error, "unknown");
      const meta = {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        reason: reasonCode || reasonMessage
      };
      if (reasonCode === "SUBTITLE_DURATION_MISMATCH") {
        logInfo(`[BILISCRIPT] subtitle track skipped ${JSON.stringify(meta)}`);
      } else {
        logWarn(`[BILISCRIPT] subtitle track rejected ${JSON.stringify(meta)}`);
      }
      ensureRunActive(runId, state.clip.fetchRunId);
      if (isYoutubeCaptionsUnavailableError(error)) {
        throw error;
      }
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("这个视频暂时没有可用字幕。");
}

export function resetClipState({ keepFetchState = false }: { keepFetchState?: boolean } = {}): void {
  if (!keepFetchState && (state.clip.bvid || state.clip.cid)) {
    void flushSubtitleCache({
      bvid: state.clip.bvid || undefined,
      cid: state.clip.cid || undefined,
      site: state.clip.site
    });
  }
  clipState.setSite(detectActiveSite());
  clipState.setBvid("");
  clipState.setAid("");
  clipState.setCid("");
  clipState.setCidSource("");
  clipState.setPageIndex(1);
  clipState.setPageCount(0);
  clipState.setPageTitle("");
  clipState.setVideoDuration(0);
  clipState.setDescription("");
  clipState.setTitle("");
  clipState.setAuthor("");
  clipState.setUploadDate("");
  clipState.setSubtitles([]);
  slot.clearAllForVideoSwitch({ keepFetchState });
  clipState.setChapters([]);
  clipState.setHotComments([]);
  clipState.setHotCommentsNotice("");
  invalidateDerived();
  clearTurnCapturedFrameCache();
  clipState.setCurrentClipSignature(computeCurrentClipSignature());
  notifyReaderPresenter({ kind: "reset" });
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
  state.reader.readingVideoEl = null;

  if (isReaderViewOpen()) {
    notifyReaderPresenter({ kind: "rerender" });
  }
}

async function resolveRetainedAsrTrack({
  runId,
  sameClip,
  prevAsrTrack,
  accessBlocker
}: {
  runId: number;
  sameClip: boolean;
  prevAsrTrack: SubtitleTrack | null;
  accessBlocker: BiliSubtitleAccessBlocker | null;
}): Promise<SubtitleTrack | null> {
  if (accessBlocker) {
    return null;
  }
  if (sameClip && prevAsrTrack) {
    return createAsrPseudoTrack(
      String(prevAsrTrack.lanDoc || prevAsrTrack.lan || buildAsrSubtitleLabel(state.settings?.asrLanguage)),
      String(prevAsrTrack.lan || "asr-zh")
    );
  }
  const cachedAsr = await findCachedAsrSubtitleTrack({
    bvid: state.clip.bvid,
    cid: state.clip.cid
  });
  ensureRunActive(runId, state.clip.fetchRunId);
  if (!cachedAsr) {
    return null;
  }
  const durationCheck = validateSubtitleByDuration(cachedAsr.body, state.clip.videoDuration);
  if (!durationCheck.ok) {
    logWarn("[BILISCRIPT] cached asr subtitle duration mismatch during clip refresh, clearing cache", {
      cacheKey: cachedAsr.cacheKey,
      reason: (durationCheck as { reason?: string }).reason
    });
    await clearSubtitleCacheByKey(cachedAsr.cacheKey);
    ensureRunActive(runId, state.clip.fetchRunId);
    return null;
  }
  return createAsrPseudoTrack(buildAsrSubtitleLabel(cachedAsr.lang || state.settings?.asrLanguage));
}

async function loadNativeCandidatesWithRetry({
  candidates,
  preferred,
  runId,
  forceRefresh
}: {
  candidates: SubtitleTrack[];
  preferred: SubtitleTrack;
  runId: number;
  forceRefresh: boolean;
}): Promise<SubtitleTrack | null> {
  try {
    return await tryLoadSubtitleCandidates(candidates, runId, forceRefresh);
  } catch (error) {
    if (isYoutubeCaptionsUnavailableError(error)) {
      throw error;
    }
    const message = getErrorMessage(error, "");
    if (!message.includes("HTTP") && (error as { code?: string }).code !== "SUBTITLE_DURATION_MISMATCH") {
      throw error;
    }
    return retryWithFreshBundle({ retryReason: error, preferred, runId, forceRefresh });
  }
}

async function loadRetainedAsrTrack({
  runId,
  track,
  forceRefresh,
  fallbackBody,
  hasNativeTracks
}: {
  runId: number;
  track: SubtitleTrack;
  forceRefresh: boolean;
  fallbackBody: SubtitleBodyItem[] | null;
  hasNativeTracks: boolean;
}): Promise<boolean> {
  const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
  const asrFallback = await loadActiveAsrFallback();
  const result = await asrFallback.loadAsrTrack({
    runId,
    sourceLabel: track.lanDoc || track.lan || "",
    allowTranscribe: false,
    fallbackBody: !forceRefresh && fallbackBody ? fallbackBody : undefined
  });
  ensureRunActive(runId, state.clip.fetchRunId);
  if (result === "done") {
    return true;
  }
  if (hasNativeTracks) {
    return false;
  }
  await finishNoSubtitle(runId, null);
  return false;
}

function readGenericVideoDuration(site: SiteId): number {
  if (site !== "youtube") {
    return readRuntimeVideoDuration();
  }
  if (typeof document !== "undefined") {
    const videos = Array.from(document.querySelectorAll("video"));
    for (const video of videos) {
      if (video.closest("[data-biliscript-historical-frame], ytd-miniplayer, [class*='mini-player']")) {
        continue;
      }
      const duration = Number(video.duration);
      if (Number.isFinite(duration) && duration > 0) {
        return duration;
      }
    }
  }
  return readRuntimeVideoDuration();
}

async function refreshYoutubeClip({
  runId,
  prevBvid,
  prevCid,
  forceRefresh
}: {
  runId: number;
  prevBvid: string;
  prevCid: string;
  forceRefresh: boolean;
}): Promise<void> {
  const videoId = extractYoutubeVideoId(location.href);
  if (!videoId) {
    throw new Error("当前页面不是标准 YouTube 视频地址，无法抓取字幕。");
  }
  clipState.setSite("youtube");
  clipState.setBvid(videoId);
  clipState.setAid("");

  const youtubeGateway = await import("../youtube/gateway.js");
  const ytBundle = await youtubeGateway.fetchYoutubeVideoBundle(videoId);
  ensureRunActive(runId, state.clip.fetchRunId);

  if (ytBundle.meta.isLiveNow) {
    throw new youtubeGateway.YoutubeSubtitleError(
      "暂不支持 YouTube 直播中视频的字幕抓取，请等待直播结束后查看回放。",
      youtubeGateway.YOUTUBE_LIVE_UNSUPPORTED_ERROR_CODE
    );
  }

  const nextCid = YOUTUBE_UNIT_CID;
  if (prevBvid && prevCid && (prevBvid !== videoId || prevCid !== nextCid)) {
    await triggerSubtitleSessionBoundary("clip-switch");
    ensureRunActive(runId, state.clip.fetchRunId);
  }

  clipState.setCid(nextCid);
  clipState.setCidSource("youtube-unit");
  clipState.setPageIndex(1);
  clipState.setPageCount(1);
  clipState.setPageTitle("");
  clipState.setTitle(ytBundle.meta.title || readVideoTitle());
  clipState.setAuthor(ytBundle.meta.author || readVideoAuthor());
  clipState.setUploadDate(ytBundle.meta.publishDate || readUploadDate());
  clipState.setDescription(ytBundle.meta.description || readVideoDescription());
  clipState.setCurrentClipSignature(computeCurrentClipSignature());

  const snapshotDuration = Number(ytBundle.meta.duration || 0);
  clipState.setVideoDuration(
    snapshotDuration > 0 ? snapshotDuration : readGenericVideoDuration("youtube")
  );
  if (!(state.clip.videoDuration > 0)) {
    throw new Error("无法获取当前视频时长，已停止抓取以避免串到错误字幕。");
  }

  if (isReaderViewOpen()) {
    notifyReaderPresenter({ kind: "rerender" });
  }

  setStatus("正在获取可用字幕...");
  const nativeTracks = normalizeSubtitleTracks(ytBundle.tracks);
  clipState.setSubtitles(nativeTracks);
  clipState.setChapters(normalizeChapters(ytBundle.chapters));

  if (nativeTracks.length === 0) {
    await finishNoSubtitle(runId, null);
    return;
  }

  const preferred = await selectSubtitleTrack(runId, null);
  if (!preferred) {
    return;
  }

  const nativeCandidates = buildSubtitleCandidates(
    state.clip.subtitles.filter(isLoadableNativeTrack),
    preferred
  );
  if (nativeCandidates.length === 0) {
    await finishNoSubtitle(runId, null);
    return;
  }

  try {
    const selected = await tryLoadSubtitleCandidates(nativeCandidates, runId, forceRefresh);
    ensureRunActive(runId, state.clip.fetchRunId);
    if (selected) {
      logInfo("[BILISCRIPT] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
  } catch (error) {
    if (isStaleRunError(error)) {
      throw error;
    }
    const code = (error as { code?: unknown })?.code;
    if (
      code === youtubeGateway.YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE ||
      code === "SUBTITLE_DURATION_MISMATCH" ||
      getErrorMessage(error, "").includes("字幕文件为空")
    ) {
      clipState.setNoSubtitleDetail("");
      await commitNoSubtitle({ noSubtitleReason: "youtube-captions-unavailable", runId });
      return;
    }
    throw error;
  }
}

export async function refreshClip(options?: { forceRefresh?: boolean }): Promise<void> {
  const runId = state.clip.fetchRunId + 1;
  clipState.setFetchRunId(runId);
  const activeSite = detectActiveSite();
  clipState.setSite(activeSite);
  const prevBvid = state.clip.bvid;
  const prevCid = state.clip.cid;
  const prevSubtitles = state.clip.subtitles || [];
  const prevAsrTrack = prevSubtitles.find((track) => isAsrSubtitleTrack(track)) ?? null;
  const prevSelectedTrack =
    findTrackByRef(prevSubtitles, {
      id: state.clip.selectedSubtitleId,
      url: state.clip.selectedSubtitleUrl
    }) ?? {
      id: state.clip.selectedSubtitleId,
      lan: state.clip.selectedSubtitleLang,
      subtitleUrl: state.clip.selectedSubtitleUrl
    };
  const prevSelectedWasAsr = isAsrSubtitleTrack(prevSelectedTrack);
  const prevAsrBody: SubtitleBodyItem[] | null =
    prevSelectedWasAsr && state.clip.subtitleBody.length > 0
      ? state.clip.subtitleBody.map((item) => ({ ...item }))
      : null;

  try {
    setStatus("正在抓取视频信息...");
    clipState.setSubtitleFetchState("loading");
    if (isReaderViewOpen()) {
      notifyReaderPresenter({ kind: "rerender" });
    }
    state.setSettings(await getSettings());
    ensureRunActive(runId, state.clip.fetchRunId);

    const forceRefresh = options?.forceRefresh === true;
    if (activeSite === "youtube") {
      await refreshYoutubeClip({ runId, prevBvid, prevCid, forceRefresh });
      return;
    }

    const metaResult = await resolveClipMeta(runId);

    if (isReaderViewOpen()) {
      notifyReaderPresenter({ kind: "rerender" });
    }

    setStatus("正在获取可用字幕...");
    const subtitleBundle = await retryAsync(
      () => gatewayFetchSubtitleBundle(contentFetchJson, {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        aid: state.clip.aid
      }),
      3,
      500
    );
    ensureRunActive(runId, state.clip.fetchRunId);

    const accessBlocker = resolveBiliSubtitleAccessBlocker(metaResult, subtitleBundle);
    const sameClip = Boolean(prevBvid && prevCid && prevBvid === state.clip.bvid && prevCid === state.clip.cid);
    const nativeTracks = normalizeSubtitleTracks(subtitleBundle.tracks);
    const retainedAsrTrack = getSiteCapabilities(activeSite).supportsAsr
      ? await resolveRetainedAsrTrack({
          runId,
          sameClip,
          prevAsrTrack,
          accessBlocker
        })
      : null;
    const mergedTracks: SubtitleTrack[] =
      nativeTracks.length > 0
        ? retainedAsrTrack
          ? [...nativeTracks, retainedAsrTrack]
          : nativeTracks
        : retainedAsrTrack
          ? [retainedAsrTrack]
          : [];

    clipState.setSubtitles(mergedTracks);
    clipState.setChapters(normalizeChapters(subtitleBundle.chapters));
    if (shouldDebugLog()) {
      logInfo(
        "[BILISCRIPT] chapters",
        state.clip.chapters.map((item) => ({
          from: item.from,
          to: item.to,
          title: item.title
        }))
      );
      logInfo(
        "[BILISCRIPT] subtitle tracks",
        state.clip.subtitles.map((item) => ({
          id: item.id,
          lan: item.lan,
          lanDoc: item.lanDoc,
          url: item.subtitleUrl
        }))
      );
    }

    const preferred = await selectSubtitleTrack(runId, accessBlocker);
    if (!preferred) {
      return;
    }

    if (isAsrSubtitleTrack(preferred)) {
      const asrLoaded = await loadRetainedAsrTrack({
        runId,
        track: preferred,
        forceRefresh,
        fallbackBody: !forceRefresh && sameClip ? prevAsrBody : null,
        hasNativeTracks: nativeTracks.length > 0
      });
      if (!asrLoaded && nativeTracks.length > 0) {
        clipState.setSubtitles(nativeTracks);
        const nativePreferred = pickPreferredSubtitle(nativeTracks, {
          previousUrl: state.clip.selectedSubtitleUrl,
          previousLang: state.clip.selectedSubtitleLang
        });
        if (!nativePreferred) {
          await finishNoSubtitle(runId, accessBlocker);
          return;
        }
        const nativeCandidates = buildSubtitleCandidates(nativeTracks, nativePreferred);
        const selected = await loadNativeCandidatesWithRetry({
          candidates: nativeCandidates,
          preferred: nativePreferred,
          runId,
          forceRefresh
        });
        ensureRunActive(runId, state.clip.fetchRunId);
        if (selected) {
          logInfo("[BILISCRIPT] selected subtitle track", {
            id: selected.id,
            lan: selected.lan,
            lanDoc: selected.lanDoc
          });
        }
      }
      return;
    }

    const nativeCandidates = buildSubtitleCandidates(
      state.clip.subtitles.filter(isLoadableNativeTrack),
      preferred
    );
    const selected = await loadNativeCandidatesWithRetry({
      candidates: nativeCandidates,
      preferred,
      runId,
      forceRefresh
    });
    ensureRunActive(runId, state.clip.fetchRunId);
    if (selected) {
      logInfo("[BILISCRIPT] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
  } catch (error) {
    await handleClipFetchError(error, runId);
  }
}

async function resolveClipMeta(runId: number): Promise<VideoMeta> {
  const prevBvid = state.clip.bvid;
  const prevCid = state.clip.cid;
  clipState.setBvid(extractBvid(location.href));
  if (!state.clip.bvid) {
    throw new Error("当前页面不是标准 BV 视频地址，无法抓取字幕。");
  }

  const meta = await retryAsync(() => gatewayFetchVideoMeta(contentFetchJson, state.clip.bvid), 2, 250);
  ensureRunActive(runId, state.clip.fetchRunId);

  logInfo("[BILISCRIPT] raw meta data", {
    meta,
    defaultCid: meta.defaultCid,
    pagesCount: (meta.pages || []).length
  });

  clipState.setAid(meta.aid || "");
  clipState.setTitle(meta.title || readVideoTitle());
  clipState.setAuthor(meta.author || readVideoAuthor());
  clipState.setUploadDate(meta.uploadDate || readUploadDate());
  clipState.setDescription(meta.description || readVideoDescription());
  clipState.setPageCount(Array.isArray(meta.pages) ? meta.pages.length : 0);
  clipState.setCurrentClipSignature(computeCurrentClipSignature());

  const pageContext = resolvePageContext(location.href, meta);
  const resolvedPageIndex = pageContext.pageIndex;
  const nextCid = String(pageContext.cid || "");
  if (prevBvid && prevCid && (prevBvid !== state.clip.bvid || prevCid !== nextCid)) {
    await triggerSubtitleSessionBoundary("clip-switch");
    ensureRunActive(runId, state.clip.fetchRunId);
  }
  clipState.setPageIndex(resolvedPageIndex);
  clipState.setPageTitle(pageContext.pageTitle);
  clipState.setCid(nextCid);
  clipState.setCidSource(pageContext.cidSource);
  clipState.setVideoDuration(Number(pageContext.duration || 0));
  if (!(state.clip.videoDuration > 0)) {
    clipState.setVideoDuration(readRuntimeVideoDuration());
  }
  if (!(state.clip.videoDuration > 0)) {
    throw new Error("无法获取当前视频时长，已停止抓取以避免串到错误字幕。");
  }

  logInfo("[BILISCRIPT] resolved video ids", {
    url: location.href,
    aid: state.clip.aid,
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    cidSource: state.clip.cidSource,
    pageIndex: resolvedPageIndex,
    videoDuration: state.clip.videoDuration
  });
  return meta;
}

async function selectSubtitleTrack(
  runId: number,
  accessBlocker: BiliSubtitleAccessBlocker | null = null
): Promise<SubtitleTrack | null> {
  if (state.clip.subtitles.length === 0) {
    await finishNoSubtitle(runId, accessBlocker);
    return null;
  }

  const preferred = pickPreferredSubtitle(state.clip.subtitles, {
    previousId: state.clip.selectedSubtitleId,
    previousUrl: state.clip.selectedSubtitleUrl,
    previousLang: state.clip.selectedSubtitleLang
  });

  if (!preferred) {
    await finishNoSubtitle(runId, accessBlocker);
    return null;
  }
  return preferred;
}

async function handleClipFetchError(error: unknown, runId: number): Promise<void> {
  if (isStaleRunError(error)) {
    return;
  }
  if (getSiteCapabilities(state.clip.site).supportsAsr) {
    const asrFallbackInstance = await loadAsrFallbackOrNull();
    if (asrFallbackInstance?.hasActiveAsrTranscribe({ bvid: state.clip.bvid, cid: state.clip.cid })) {
      setStatus(`抓取失败：${getErrorMessage(error)}，继续等待音频转写…`);
      await asrFallbackInstance.awaitActiveAsrTranscribe({ runId, bvid: state.clip.bvid, cid: state.clip.cid });
      return;
    }
  }
  const errorCode = (error as { code?: string })?.code;
  resetClipState({ keepFetchState: true });
  clipState.setSubtitleFetchState("error");
  if (isReaderViewOpen()) {
    notifyReaderPresenter({ kind: "rerender" });
  }
  if (errorCode === "YOUTUBE_LIVE_UNSUPPORTED") {
    const liveMsg = (error as Error)?.message || "暂不支持 YouTube 直播中视频的字幕抓取。";
    setStatus(liveMsg);
    if (isReaderViewOpen()) {
      notifyReaderPresenter({ kind: "notice", text: liveMsg });
    }
    return;
  }
  if (errorCode === "SUBTITLE_DURATION_MISMATCH") {
    setStatus("抓取失败：未找到与当前视频时长匹配的字幕轨，可能该视频无可用字幕。");
    return;
  }
  setStatus(`抓取失败：${getErrorMessage(error)}`);
}

async function finishNoSubtitle(
  runId: number,
  accessBlocker: BiliSubtitleAccessBlocker | null = null
): Promise<void> {
  if (accessBlocker) {
    clipState.setSubtitles([]);
    clipState.setNoSubtitleDetail("");
    await commitNoSubtitle({ noSubtitleReason: accessBlocker, runId });
    return;
  }
  if (!getSiteCapabilities(state.clip.site).supportsAsr) {
    clipState.setSubtitles([]);
    clipState.setNoSubtitleDetail("");
    await commitNoSubtitle({
      noSubtitleReason: state.clip.site === "youtube" ? "youtube-no-subtitles" : null,
      runId
    });
    return;
  }
  const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
  const asrResult = await (await loadActiveAsrFallback()).maybeRunAsrFallback({ runId });
  if (asrResult === "done") {
    return;
  }
  clipState.setSubtitles([]);
  await commitNoSubtitle({ runId });
}

async function retryWithFreshBundle({
  retryReason,
  preferred,
  runId,
  forceRefresh
}: {
  retryReason: unknown;
  preferred: SubtitleTrack;
  runId: number;
  forceRefresh: boolean;
}): Promise<SubtitleTrack> {
  const bundle = await retryAsync(
    () =>
      gatewayFetchSubtitleBundle(contentFetchJson, {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        aid: state.clip.aid
      }),
    2,
    500
  );
  ensureRunActive(runId, state.clip.fetchRunId);
  const existingAsr = (state.clip.subtitles || []).find((track) => isAsrSubtitleTrack(track));
  const freshNative = normalizeSubtitleTracks(bundle.tracks);
  clipState.setSubtitles(existingAsr ? [...freshNative, existingAsr] : freshNative);
  clipState.setChapters(normalizeChapters(bundle.chapters));
  const retryPreferred = pickPreferredSubtitle(freshNative, {
    previousId: preferred.id,
    previousUrl: preferred.subtitleUrl,
    previousLang: preferred.lanDoc || preferred.lan || ""
  });
  if (!retryPreferred) {
    throw retryReason;
  }
  const retryCandidates = buildSubtitleCandidates(freshNative, retryPreferred);
  return tryLoadSubtitleCandidates(retryCandidates, runId, forceRefresh);
}

const CACHE_SAVE_FAILED_MESSAGE =
  "字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。";

function notifyCacheSaveFailed(): void {
  logWarn(`[BILISCRIPT] ${CACHE_SAVE_FAILED_MESSAGE}`);
}

export interface LoadSubtitleOptions {
  preferTimedtextPot?: boolean;
}

function createTrackBodyLoader(
  site: SiteId,
  videoId: string,
  url: string,
  lang: string,
  options?: LoadSubtitleOptions
): (() => Promise<SubtitleBodyItem[]>) | undefined {
  if (site !== "youtube") {
    return undefined;
  }
  return async () =>
    (await import("../youtube/gateway.js")).fetchYoutubeSubtitleBody({
      videoId,
      trackUrl: url,
      lang,
      ...(options?.preferTimedtextPot ? { preferTimedtextPot: true } : {})
    });
}

export async function isYoutubeCoarseTranscriptLoaded(videoId: string, url: string): Promise<boolean> {
  if (state.clip.site !== "youtube") {
    return false;
  }
  const { isYoutubeCoarseTranscriptLoaded: checkCoarse } = await import("../youtube/gateway.js");
  return checkCoarse(videoId, url);
}

export async function loadSubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false,
  options?: LoadSubtitleOptions
): Promise<void> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }
  const nextId = subtitleId ? String(subtitleId) : "";
  const prevId = String(state.clip.selectedSubtitleId || "");
  const prevUrl = String(state.clip.selectedSubtitleUrl || "");
  const isDifferentTrack =
    state.clip.subtitleFetchState === "ready" &&
    Boolean(state.clip.bvid && state.clip.cid) &&
    ((Boolean(nextId && prevId) && nextId !== prevId) ||
      normalizeSubtitleUrlForCache(url) !== normalizeSubtitleUrlForCache(prevUrl));
  if (isDifferentTrack) {
    await triggerSubtitleSessionBoundary("source-track-switch");
    if (runId !== undefined) {
      ensureRunActive(runId, state.clip.fetchRunId);
    }
  }
  const activeSite = state.clip.site;
  const activeVideoId = state.clip.bvid;
  const effectiveForceRefresh =
    forceRefresh ||
    (activeSite === "youtube" &&
      Boolean(options?.preferTimedtextPot) &&
      (await isYoutubeCoarseTranscriptLoaded(activeVideoId, url)));
  await loadTrackBody<SubtitleBodyItem>(
    {
      site: activeSite,
      bvid: activeVideoId,
      cid: state.clip.cid,
      videoDuration: state.clip.videoDuration,
      url,
      lang,
      subtitleId,
      forceRefresh: effectiveForceRefresh,
      transport: contentFetchJson,
      fetchBody: createTrackBodyLoader(activeSite, activeVideoId, url, lang, options),
      checkActive: runId !== undefined ? () => ensureRunActive(runId, state.clip.fetchRunId) : undefined,
      onCacheSaveFailed: notifyCacheSaveFailed
    },
    {
      log: {
        cacheHit: "[BILISCRIPT] using cached subtitle",
        cacheMismatch: "[BILISCRIPT] cached subtitle duration mismatch, clearing cache"
      },
      onBody: (body) =>
        acceptSubtitle({
          body,
          selectedSubtitleId: subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId,
          selectedSubtitleUrl: url,
          selectedSubtitleLang: lang,
          runId
        })
    }
  );
}

export interface LoadAsrSubtitleOptions {
  runId?: number;
  sourceLabel?: string;
  allowTranscribe?: boolean;
}

export async function loadAsrSubtitle({
  runId = state.clip.fetchRunId,
  sourceLabel = "",
  allowTranscribe = true
}: LoadAsrSubtitleOptions = {}): Promise<void> {
  if (!getSiteCapabilities(state.clip.site).supportsAsr) {
    throw new Error("当前站点不支持语音转写字幕。");
  }
  if (runId !== undefined) {
    ensureRunActive(runId, state.clip.fetchRunId);
  }
  const prevId = String(state.clip.selectedSubtitleId || "");
  const isDifferentTrack =
    state.clip.subtitleFetchState === "ready" &&
    Boolean(state.clip.bvid && state.clip.cid) &&
    prevId !== ASR_SUBTITLE_TRACK_ID;
  if (isDifferentTrack) {
    await triggerSubtitleSessionBoundary("source-track-switch");
    if (runId !== undefined) {
      ensureRunActive(runId, state.clip.fetchRunId);
    }
  }
  const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
  const asrFallback = await loadActiveAsrFallback();
  const result = await asrFallback.loadAsrTrack({
    runId,
    sourceLabel,
    allowTranscribe
  });
  if (runId !== undefined) {
    ensureRunActive(runId, state.clip.fetchRunId);
  }
  if (result === "done") {
    return;
  }
  if (result === "skip") {
    throw new Error("未配置语音转写服务且无本地缓存，无法切换到语音转写字幕。");
  }
  if (result === "empty") {
    throw new Error("语音转写未识别到有效字幕内容。");
  }
  throw new Error("语音转写字幕加载失败。");
}

export async function loadSecondarySubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false,
  options?: LoadSubtitleOptions
): Promise<void> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }
  if (runId !== undefined) {
    ensureRunActive(runId, state.clip.fetchRunId);
  }
  slot.markSecondaryLoading({ id: subtitleId ? String(subtitleId) : "", url });
  if (isReaderViewOpen()) {
    notifyReaderPresenter({ kind: "rerender" });
  }

  try {
    const activeSite = state.clip.site;
    const activeVideoId = state.clip.bvid;
    await loadTrackBody<SubtitleBodyItem>(
      {
        site: activeSite,
        bvid: activeVideoId,
        cid: state.clip.cid,
        videoDuration: state.clip.videoDuration,
        url,
        lang,
        subtitleId,
        forceRefresh,
        transport: contentFetchJson,
        fetchBody: createTrackBodyLoader(activeSite, activeVideoId, url, lang, options),
        checkActive: runId !== undefined ? () => ensureRunActive(runId, state.clip.fetchRunId) : undefined,
        onCacheSaveFailed: notifyCacheSaveFailed
      },
      {
        log: {
          cacheHit: "[BILISCRIPT] using cached secondary subtitle",
          cacheMismatch: "[BILISCRIPT] cached secondary subtitle duration mismatch, clearing cache"
        },
        onBody: (body) =>
          acceptSecondarySubtitle({
            body,
            subtitleId: subtitleId ? String(subtitleId) : "",
            subtitleUrl: url,
            runId
          })
      }
    );
  } catch (error) {
    if (!isStaleRunError(error)) {
      slot.markSecondaryError();
      if (isReaderViewOpen()) {
        notifyReaderPresenter({ kind: "rerender" });
      }
    }
    throw error;
  }
}

async function loadAsrFallbackOrNull() {
  try {
    const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
    return await loadActiveAsrFallback();
  } catch (asrLoadError) {
    logWarn("[BILISCRIPT] asr fallback module load failed; treat as no active transcribe", asrLoadError);
    return null;
  }
}
