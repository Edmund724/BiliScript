import { clipState } from "../core/state.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { extractYoutubeVideoId } from "../shared/site.js";
import type { Chapter, HotComment, SubtitleBodyItem, SubtitleTrack } from "../shared/video-dto.js";
import { fetchYoutubeHotCommentsFromNext } from "./hot-comments.js";
import {
  captureYoutubeTimedtextPot,
  readYoutubePageSnapshot,
  type ReadYoutubePageSnapshotOptions,
  type YoutubeVideoMetaSnapshot
} from "./main-world-bridge.js";
import {
  YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE,
  YOUTUBE_LIVE_UNSUPPORTED_ERROR_CODE,
  YOUTUBE_NO_SUBTITLES_ERROR_CODE,
  YoutubeSubtitleError,
  fetchYoutubeSubtitleTrackBody,
  hasMatchingYoutubeObservedPot,
  mapYoutubeCaptionTracks,
  normalizeYoutubeTimedtextUrl,
  type YoutubeSubtitleSnapshotInput
} from "./subtitle-fetcher.js";

export {
  YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE,
  YOUTUBE_LIVE_UNSUPPORTED_ERROR_CODE,
  YOUTUBE_NO_SUBTITLES_ERROR_CODE,
  YoutubeSubtitleError
};

export interface YoutubeVideoBundle {
  meta: YoutubeVideoMetaSnapshot;
  tracks: SubtitleTrack[];
  chapters: Chapter[];
}

const snapshotCacheByVideoId = new Map<string, YoutubeVideoMetaSnapshot>();
const coarseTranscriptTrackKeys = new Set<string>();

function buildCoarseTrackKey(videoId: string, trackUrl: string): string {
  const vid = String(videoId || "").trim();
  const normalized = normalizeYoutubeTimedtextUrl(trackUrl);
  if (!vid || !normalized) return "";
  try {
    const parsed = new URL(normalized);
    const lang = (parsed.searchParams.get("lang") || "").trim().toLowerCase();
    const kind = (parsed.searchParams.get("kind") || "").trim().toLowerCase();
    return `${vid}|${lang}|${kind}`;
  } catch {
    return `${vid}|${normalized}`;
  }
}

export function isYoutubeCoarseTranscriptLoaded(videoId: string, trackUrl: string): boolean {
  const key = buildCoarseTrackKey(videoId, trackUrl);
  return key ? coarseTranscriptTrackKeys.has(key) : false;
}

export function clearYoutubeGatewayCacheForTests(): void {
  snapshotCacheByVideoId.clear();
  coarseTranscriptTrackKeys.clear();
}

export function getCachedYoutubeSnapshot(videoId: string): YoutubeVideoMetaSnapshot | null {
  const key = String(videoId || "").trim();
  return key ? (snapshotCacheByVideoId.get(key) ?? null) : null;
}

export async function fetchYoutubeVideoBundle(
  expectedVideoId?: string,
  options: ReadYoutubePageSnapshotOptions = {}
): Promise<YoutubeVideoBundle> {
  const snapshot = await readYoutubePageSnapshot({
    ...options,
    expectedVideoId: expectedVideoId || options.expectedVideoId
  });
  if (snapshot.videoId) {
    snapshotCacheByVideoId.set(snapshot.videoId, snapshot);
  }
  const tracks = mapYoutubeCaptionTracks(snapshot.captionTracks);
  return {
    meta: snapshot,
    tracks,
    chapters: snapshot.chapters
  };
}

function extractVideoIdFromTimedtextUrl(trackUrl: string): string {
  const normalized = normalizeYoutubeTimedtextUrl(trackUrl);
  if (!normalized) {
    return "";
  }
  try {
    return (new URL(normalized).searchParams.get("v") || "").trim();
  } catch {
    return "";
  }
}

const BCP47_LANG_CODE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

function extractKindFromTimedtextUrl(trackUrl: string): string {
  const normalized = normalizeYoutubeTimedtextUrl(trackUrl);
  if (!normalized) return "";
  try {
    return (new URL(normalized).searchParams.get("kind") || "").trim();
  } catch {
    return "";
  }
}

function resolveYoutubeLanguageCode(trackUrl: string, rawLang: string): string {
  const normalized = normalizeYoutubeTimedtextUrl(trackUrl);
  if (normalized) {
    try {
      const fromUrl = (new URL(normalized).searchParams.get("lang") || "").trim();
      if (BCP47_LANG_CODE_RE.test(fromUrl)) {
        return fromUrl;
      }
    } catch {
    }
  }
  const cleanLang = String(rawLang || "").trim();
  return BCP47_LANG_CODE_RE.test(cleanLang) ? cleanLang : "";
}

export async function fetchYoutubeSubtitleBody({
  videoId = "",
  trackUrl,
  lang = "",
  snapshot,
  preferTimedtextPot = false
}: {
  videoId?: string;
  trackUrl: string;
  lang?: string;
  snapshot?: YoutubeSubtitleSnapshotInput | null;
  preferTimedtextPot?: boolean;
}): Promise<SubtitleBodyItem[]> {
  const cleanVideoId = String(videoId || "").trim() || extractVideoIdFromTimedtextUrl(trackUrl);
  const trackKind = extractKindFromTimedtextUrl(trackUrl);
  const languageCode = resolveYoutubeLanguageCode(trackUrl, lang);
  let resolvedSnapshot: YoutubeSubtitleSnapshotInput | null = snapshot ?? null;
  let usedCachedWithPot = false;

  if (!resolvedSnapshot) {
    const cachedSnapshot = getCachedYoutubeSnapshot(cleanVideoId);
    const cachedHasPot = Boolean(
      cachedSnapshot &&
        hasMatchingYoutubeObservedPot(
          cachedSnapshot.observedTimedtextUrls,
          cleanVideoId || cachedSnapshot.videoId,
          languageCode,
          trackKind
        )
    );
    if (cachedSnapshot && cachedHasPot) {
      resolvedSnapshot = cachedSnapshot;
      usedCachedWithPot = true;
    } else if (cleanVideoId) {
      try {
        const fresh = await readYoutubePageSnapshot({ expectedVideoId: cleanVideoId });
        if (fresh.videoId) {
          snapshotCacheByVideoId.set(fresh.videoId, fresh);
        }
        resolvedSnapshot = fresh;
      } catch {
        resolvedSnapshot = cachedSnapshot;
      }
    } else {
      resolvedSnapshot = cachedSnapshot;
    }
  }

  const effectiveVideoId = cleanVideoId || resolvedSnapshot?.videoId || "";
  const capturePot =
    !snapshot && effectiveVideoId
      ? () =>
          captureYoutubeTimedtextPot({
            expectedVideoId: effectiveVideoId,
            languageCode,
            kind: trackKind
          })
      : undefined;

  try {
    const result = await fetchYoutubeSubtitleTrackBody({
      trackUrl,
      videoId: effectiveVideoId,
      languageCode,
      snapshot: resolvedSnapshot,
      preferTimedtextPot,
      capturePot
    });
    if (result.capturedTimedtextUrls && result.capturedTimedtextUrls.length > 0 && effectiveVideoId) {
      const cached = snapshotCacheByVideoId.get(effectiveVideoId);
      if (cached) {
        const merged = Array.from(
          new Set([...cached.observedTimedtextUrls, ...result.capturedTimedtextUrls])
        );
        snapshotCacheByVideoId.set(effectiveVideoId, { ...cached, observedTimedtextUrls: merged });
      }
    }
    const coarseKey = buildCoarseTrackKey(effectiveVideoId, trackUrl);
    if (coarseKey) {
      if (result.tier === "get_panel") {
        coarseTranscriptTrackKeys.add(coarseKey);
      } else {
        coarseTranscriptTrackKeys.delete(coarseKey);
      }
    }
    return result.items;
  } catch (error) {
    if (!snapshot && usedCachedWithPot && cleanVideoId) {
      snapshotCacheByVideoId.delete(cleanVideoId);
    }
    throw error;
  }
}

export async function fetchYoutubeHotComments(
  count = 20,
  options: { videoId?: string; snapshot?: YoutubeVideoMetaSnapshot | null } = {}
): Promise<HotComment[]> {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  if (!safeCount) {
    return [];
  }

  const cleanVideoId = String(options.videoId || "").trim() || extractYoutubeVideoId();
  let resolvedSnapshot: YoutubeVideoMetaSnapshot | null = options.snapshot ?? null;
  if (!resolvedSnapshot) {
    const cached = getCachedYoutubeSnapshot(cleanVideoId);
    if (cached && (cached.commentsContinuation || cached.commentsDisabled)) {
      resolvedSnapshot = cached;
    } else if (cleanVideoId) {
      try {
        const fresh = await readYoutubePageSnapshot({ expectedVideoId: cleanVideoId });
        if (fresh.videoId) {
          snapshotCacheByVideoId.set(fresh.videoId, fresh);
        }
        resolvedSnapshot = fresh;
      } catch {
        resolvedSnapshot = cached;
      }
    } else {
      resolvedSnapshot = cached;
    }
  }

  if (
    !resolvedSnapshot ||
    resolvedSnapshot.commentsDisabled ||
    !resolvedSnapshot.commentsContinuation ||
    !resolvedSnapshot.innertubeContext
  ) {
    return [];
  }

  return fetchYoutubeHotCommentsFromNext({
    innertubeContext: resolvedSnapshot.innertubeContext,
    innertubeApiKey: resolvedSnapshot.innertubeApiKey,
    commentsContinuation: resolvedSnapshot.commentsContinuation,
    limit: safeCount
  });
}

export async function fetchYoutubeHotCommentsWithLedger(
  videoId = ""
): Promise<{ comments: HotComment[]; note?: string }> {
  try {
    const comments = await fetchYoutubeHotComments(20, { videoId });
    clipState.setHotComments(comments);
    return { comments };
  } catch (error) {
    clipState.setHotComments([]);
    return { comments: [], note: getErrorMessage(error) };
  }
}
