import { clipState } from "../core/state.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { extractYoutubeVideoId } from "../shared/site.js";
import type { Chapter, HotComment, SubtitleBodyItem, SubtitleTrack } from "../shared/video-dto.js";
import { fetchYoutubeHotCommentsFromNext } from "./hot-comments.js";
import {
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

export function clearYoutubeGatewayCacheForTests(): void {
  snapshotCacheByVideoId.clear();
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

export async function fetchYoutubeSubtitleBody({
  videoId = "",
  trackUrl,
  lang = "",
  snapshot
}: {
  videoId?: string;
  trackUrl: string;
  lang?: string;
  snapshot?: YoutubeSubtitleSnapshotInput | null;
}): Promise<SubtitleBodyItem[]> {
  const cleanVideoId = String(videoId || "").trim() || extractVideoIdFromTimedtextUrl(trackUrl);
  let resolvedSnapshot: YoutubeSubtitleSnapshotInput | null = snapshot ?? null;
  let usedCachedWithPot = false;

  if (!resolvedSnapshot) {
    const cachedSnapshot = getCachedYoutubeSnapshot(cleanVideoId);
    const cachedHasPot = Boolean(
      cachedSnapshot &&
        hasMatchingYoutubeObservedPot(
          cachedSnapshot.observedTimedtextUrls,
          cleanVideoId || cachedSnapshot.videoId,
          lang
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

  try {
    const result = await fetchYoutubeSubtitleTrackBody({
      trackUrl,
      videoId: cleanVideoId || resolvedSnapshot?.videoId || "",
      languageCode: lang,
      snapshot: resolvedSnapshot
    });
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
