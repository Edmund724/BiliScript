import { setStatus } from "../core/ui-status.js";
import {
  state,
  clipState,
  triggerSubtitleSessionBoundary
} from "../core/state.js";
import type { SubtitleOption } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import {
  ensureRunActive,
  isStaleRunError,
  getErrorMessage,
  toReadableText,
  isRetryableNetworkError,
  retryAsync
} from "../shared/error-helpers.js";
import { logInfo, logWarn, shouldDebugLog } from "../shared/logging.js";
import { isReaderViewOpen } from "../reader/state.js";
import { readVideoTitle, readVideoAuthor, readUploadDate, readVideoDescription, invalidateDerived } from "./core.js";
import { normalizeChapters } from "./chapters.js";
import { normalizeSubtitleTracks, pickPreferredSubtitle, resolveTrackTarget } from "./selection.js";
import { flushSubtitleCache } from "./cache.js";
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

export function initSummarizeChain(): void {
  subscribeSubtitleRefresh(refreshClip);
}

configureCommitUi({
  setStatus
});

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
      cid: state.clip.cid || undefined
    });
  }
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
  clipState.setCurrentClipSignature(computeCurrentClipSignature());
  notifyReaderPresenter({ kind: "reset" });
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
  state.reader.readingVideoEl = null;

  if (isReaderViewOpen()) {
    notifyReaderPresenter({ kind: "rerender" });
  }
}

export async function refreshClip(options?: { forceRefresh?: boolean }): Promise<void> {
  const runId = state.clip.fetchRunId + 1;
  clipState.setFetchRunId(runId);
  try {
    setStatus("正在抓取视频信息...");
    clipState.setSubtitleFetchState("loading");
    if (isReaderViewOpen()) {
      notifyReaderPresenter({ kind: "rerender" });
    }
    state.setSettings(await getSettings());
    ensureRunActive(runId, state.clip.fetchRunId);

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
    clipState.setSubtitles(normalizeSubtitleTracks(subtitleBundle.tracks) as unknown as SubtitleOption[]);
    clipState.setChapters(normalizeChapters(subtitleBundle.chapters) as import("../core/state.js").ChapterItem[]);
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

    const forceRefresh = options?.forceRefresh === true;
    const accessBlocker = resolveBiliSubtitleAccessBlocker(metaResult, subtitleBundle);

    const preferred = await selectSubtitleTrack(runId, accessBlocker);
    if (!preferred) {
      return;
    }

    const candidates = buildSubtitleCandidates(state.clip.subtitles as unknown as SubtitleTrack[], preferred);
    let selected: SubtitleTrack | null = null;

    try {
      selected = await tryLoadSubtitleCandidates(candidates, runId, forceRefresh);
    } catch (error) {
      const message = getErrorMessage(error, "");
      if (!message.includes("HTTP") && (error as { code?: string }).code !== "SUBTITLE_DURATION_MISMATCH") {
        throw error;
      }

      selected = await retryWithFreshBundle({ retryReason: error, preferred, runId, forceRefresh });
    }
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
  const asrFallbackInstance = await loadAsrFallbackOrNull();
  if (asrFallbackInstance?.hasActiveAsrTranscribe({ bvid: state.clip.bvid, cid: state.clip.cid })) {
    setStatus(`抓取失败：${getErrorMessage(error)}，继续等待音频转写…`);
    await asrFallbackInstance.awaitActiveAsrTranscribe({ runId, bvid: state.clip.bvid, cid: state.clip.cid });
    return;
  }
  resetClipState({ keepFetchState: true });
  clipState.setSubtitleFetchState("error");
  if (isReaderViewOpen()) {
    notifyReaderPresenter({ kind: "rerender" });
  }
  if ((error as { code?: string }).code === "SUBTITLE_DURATION_MISMATCH") {
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
    clipState.setNoSubtitleDetail("");
    await commitNoSubtitle({ noSubtitleReason: accessBlocker, runId });
    return;
  }
  const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
  const asrResult = await (await loadActiveAsrFallback()).maybeRunAsrFallback({ runId });
  if (asrResult === "done") {
    return;
  }
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
  clipState.setSubtitles(normalizeSubtitleTracks(bundle.tracks) as unknown as SubtitleOption[]);
  clipState.setChapters(normalizeChapters(bundle.chapters) as import("../core/state.js").ChapterItem[]);
  const retryPreferred = pickPreferredSubtitle(state.clip.subtitles, {
    previousId: preferred.id,
    previousUrl: preferred.subtitleUrl,
    previousLang: preferred.lanDoc || preferred.lan || ""
  });
  if (!retryPreferred) {
    throw retryReason;
  }
  const retryCandidates = buildSubtitleCandidates(state.clip.subtitles as unknown as SubtitleTrack[], retryPreferred);
  return tryLoadSubtitleCandidates(retryCandidates, runId, forceRefresh);
}

const CACHE_SAVE_FAILED_MESSAGE =
  "字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。";

function notifyCacheSaveFailed(): void {
  logWarn(`[BILISCRIPT] ${CACHE_SAVE_FAILED_MESSAGE}`);
}

export async function loadSubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false
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
  await loadTrackBody(
    {
      bvid: state.clip.bvid,
      cid: state.clip.cid,
      videoDuration: state.clip.videoDuration,
      url,
      lang,
      subtitleId,
      forceRefresh,
      transport: contentFetchJson,
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

export async function loadSecondarySubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false
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
    await loadTrackBody(
      {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        videoDuration: state.clip.videoDuration,
        url,
        lang,
        subtitleId,
        forceRefresh,
        transport: contentFetchJson,
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
