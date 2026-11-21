import { logInfo, logWarn } from "../shared/logging.js";
import type { JsonTransport } from "../bilibili/gateway-core.js";
import { fetchSubtitleBodyJson, type SubtitleTrack } from "../bilibili/video-api.js";
import { validateSubtitleByDuration } from "./duration-validation.js";
import type { DurationValidationResult } from "./duration-validation.js";
import {
  buildSubtitleCandidates,
  clearSubtitleCacheByKey,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "./cache.js";
import {
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  resolveTrackTarget,
  type PreferredSubtitleContext
} from "./selection.js";
import { trackIdentity } from "./source-key.js";

interface SubtitleDurationMismatchError extends Error {
  code: "SUBTITLE_DURATION_MISMATCH";
  details: DurationValidationResult;
}

export interface SubtitleBodyRequest {
  bvid: string;
  cid: string;
  videoDuration: number;
  url: string;
  lang: string;
  subtitleId?: string;
  forceRefresh?: boolean;
  transport: JsonTransport;
  checkActive?: () => void;
  onCacheSaveFailed?: () => void;
}

export type SubtitleBodyExit<T = unknown> = (body: T[]) => unknown;

export interface SubtitleBodyLog {
  cacheHit: string;
  cacheMismatch: string;
}

export interface SubtitleBodyHooks<T = unknown> {
  onBody?: SubtitleBodyExit<T>;
  log?: SubtitleBodyLog;
}

const DEFAULT_BODY_LOG: SubtitleBodyLog = {
  cacheHit: "[BILISCRIPT] using cached subtitle",
  cacheMismatch: "[BILISCRIPT] cached subtitle duration mismatch, clearing cache"
};

export async function loadTrackBody<T = unknown>(
  {
    bvid,
    cid,
    videoDuration,
    url,
    lang,
    subtitleId = "",
    forceRefresh = false,
    transport,
    checkActive,
    onCacheSaveFailed
  }: SubtitleBodyRequest,
  { onBody, log = DEFAULT_BODY_LOG }: SubtitleBodyHooks<T> = {}
): Promise<T[]> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }
  const cacheKey = getSubtitleCacheKey({
    bvid,
    cid,
    identity: trackIdentity(subtitleId, url, lang)
  });

  if (!forceRefresh) {
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, videoDuration);
      if (!cachedCheck.ok) {
        logWarn(log.cacheMismatch, { cacheKey, reason: cachedCheck.reason });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        logInfo(log.cacheHit, { cacheKey, itemCount: cachedBody.length });
        checkActive?.();
        await onBody?.(cachedBody as T[]);
        return cachedBody as T[];
      }
    }
  }

  const body = await fetchSubtitleBodyJson<T>(transport, url);
  checkActive?.();
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。") as SubtitleDurationMismatchError;
    mismatchError.code = "SUBTITLE_DURATION_MISMATCH";
    mismatchError.details = durationCheck;
    throw mismatchError;
  }

  const saveResult = await saveSubtitleToCache(cacheKey, body);
  if (saveResult && saveResult.ok === false) {
    onCacheSaveFailed?.();
  }

  await onBody?.(body);
  return body;
}

export interface SubtitleTrackCandidate {
  id?: string;
  lan?: string;
  lanDoc?: string;
  subtitleUrl?: string;
  source?: string;
}

export interface PreferredNativeSubtitleRequest<TTrack extends SubtitleTrackCandidate = SubtitleTrack> {
  tracks: TTrack[] | null | undefined;
  preferred?: PreferredSubtitleContext;
  bvid: string;
  cid: string;
  videoDuration: number;
  forceRefresh?: boolean;
  transport: JsonTransport;
  checkActive?: () => void;
  onCacheSaveFailed?: () => void;
  log?: SubtitleBodyLog;
}

export interface LoadedNativeSubtitle<TBody = unknown, TTrack extends SubtitleTrackCandidate = SubtitleTrack> {
  tracks: TTrack[];
  track: TTrack;
  body: TBody[];
}

export async function loadPreferredNativeSubtitle<
  TBody = unknown,
  TTrack extends SubtitleTrackCandidate = SubtitleTrack
>({
  tracks,
  preferred,
  bvid,
  cid,
  videoDuration,
  forceRefresh = false,
  transport,
  checkActive,
  onCacheSaveFailed,
  log
}: PreferredNativeSubtitleRequest<TTrack>): Promise<LoadedNativeSubtitle<TBody, TTrack> | null> {
  const normalizedTracks = normalizeSubtitleTracks(tracks as SubtitleTrack[] | null | undefined) as unknown as TTrack[];
  if (normalizedTracks.length === 0) {
    return null;
  }
  const preferredTrack = pickPreferredSubtitle(normalizedTracks as unknown as SubtitleTrack[], preferred);
  const candidates = buildSubtitleCandidates(
    normalizedTracks as unknown as SubtitleTrack[],
    preferredTrack
  ) as unknown as TTrack[];
  if (candidates.length === 0) {
    return null;
  }

  let lastError: unknown = null;
  for (const track of candidates) {
    try {
      const target = resolveTrackTarget(track);
      const body = await loadTrackBody<TBody>(
        {
          bvid,
          cid,
          videoDuration,
          url: target.url,
          lang: target.lang,
          subtitleId: target.id,
          forceRefresh,
          transport,
          checkActive,
          onCacheSaveFailed
        },
        { log }
      );
      return { tracks: normalizedTracks, track, body };
    } catch (error) {
      lastError = error;
      checkActive?.();
    }
  }

  throw lastError || new Error("这个视频暂时没有可用字幕。");
}
