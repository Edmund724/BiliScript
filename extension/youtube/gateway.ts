import type { Chapter, SubtitleBodyItem, SubtitleTrack } from "../shared/video-dto.js";
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
  mapYoutubeCaptionTracks,
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
  const cleanVideoId = String(videoId || "").trim();
  let resolvedSnapshot: YoutubeSubtitleSnapshotInput | null =
    snapshot ?? getCachedYoutubeSnapshot(cleanVideoId);
  if (!resolvedSnapshot && cleanVideoId) {
    try {
      const fresh = await readYoutubePageSnapshot({ expectedVideoId: cleanVideoId });
      if (fresh.videoId) {
        snapshotCacheByVideoId.set(fresh.videoId, fresh);
      }
      resolvedSnapshot = fresh;
    } catch {
      resolvedSnapshot = null;
    }
  }
  const result = await fetchYoutubeSubtitleTrackBody({
    trackUrl,
    videoId: cleanVideoId || resolvedSnapshot?.videoId || "",
    languageCode: lang,
    snapshot: resolvedSnapshot
  });
  return result.items;
}
