import {
  fetchVideoMeta,
  fetchSubtitleBundle,
  resolveVideoPageFromMeta
} from "../bilibili/video-api.js";
import { bgFetchJson } from "../bilibili/gateway-core.js";
import {
  extractPageIndexFromUrl,
  buildCanonicalVideoUrl
} from "../bilibili/video-id-shared.js";
import { loadPreferredNativeSubtitle } from "../subtitle/body.js";
import { resolveActiveSubtitleStore } from "../subtitle/store-client.js";
import {
  buildSegmentedTrackMapKey,
  type AiArtifactRecord,
  type RawSubtitleTrackRecord,
  type SegmentedSubtitleTrackRecord,
  type SubtitleIdbStore,
  type SubtitlePageRecord
} from "../subtitle/idb-store.js";
import { buildSegmentationSignature } from "../subtitle/cache.js";
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import { YOUTUBE_UNIT_CID, resolveVideoStorageKey } from "../shared/site.js";
import { getMergedSettings } from "../core/settings-store.js";
import { createFetchedContextPayload } from "../core/context-payload.js";
import { normalizeSubtitleSegmentationStrategy } from "../core/validators.js";
import type { Settings } from "../core/defaults.js";
import type { ChapterItem, SubtitleBodyItem, SubtitleOption } from "../core/state.js";
import {
  ANALYSIS_FINAL_PREFIX,
  L1_INDEX_CACHE_PREFIX,
  isL1VideoIndexCacheRecord,
  isOverviewShape
} from "./l1-chapter-index.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import type { OverviewAnalysis } from "./analysis-validate.js";
import { buildAiContextRef } from "./conversation.js";
import type { AiContext } from "./types.js";

export const YOUTUBE_CACHE_EVICTED = "YOUTUBE_CACHE_EVICTED";
export const YOUTUBE_CACHE_EVICTED_MESSAGE =
  "该 YouTube 视频的本地字幕缓存已被自动清理，历史对话仍可只读查看；如需继续追问，请重新打开原视频页面并加载字幕。";

export type YoutubeCacheEvictedError = Error & { code: typeof YOUTUBE_CACHE_EVICTED };

export function createYoutubeCacheEvictedError(
  message = YOUTUBE_CACHE_EVICTED_MESSAGE
): YoutubeCacheEvictedError {
  const error = new Error(message) as YoutubeCacheEvictedError;
  error.code = YOUTUBE_CACHE_EVICTED;
  return error;
}

export function isYoutubeCacheEvictedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  if (code === YOUTUBE_CACHE_EVICTED) {
    return true;
  }
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.includes(YOUTUBE_CACHE_EVICTED);
}

function resolveQueryPageIndex(ref: AiContext): number {
  const urlPage = extractPageIndexFromUrl(ref.url || "");
  if (urlPage > 1) {
    return urlPage;
  }
  return Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1;
}

function nonEmptyTracks<T extends { items?: SubtitleBodyItem[] }>(
  records: Record<string, T> | undefined
): T[] {
  return Object.values(records || {}).filter(
    (entry) => entry && Array.isArray(entry.items) && entry.items.length > 0
  );
}

function scoreTrackCandidate(
  trackKey: string,
  lang: string | undefined,
  preferredSourceKey: string,
  preferredLang: string
): number {
  if (preferredSourceKey && trackKey === preferredSourceKey) {
    return 3;
  }
  if (preferredLang && String(lang || "").trim().toLowerCase() === preferredLang) {
    return 2;
  }
  return 1;
}

function pickPreferredRawTrack(
  rawTracks: RawSubtitleTrackRecord[],
  preferredSourceKey: string,
  preferredLang: string
): RawSubtitleTrackRecord | null {
  if (rawTracks.length === 0) {
    return null;
  }
  const sorted = [...rawTracks].sort((a, b) => {
    const scoreDiff =
      scoreTrackCandidate(b.trackKey, b.lang, preferredSourceKey, preferredLang) -
      scoreTrackCandidate(a.trackKey, a.lang, preferredSourceKey, preferredLang);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });
  return sorted[0] ?? null;
}

function pickSegmentedTrackForSource(
  pageRecord: SubtitlePageRecord,
  segmentedTracks: SegmentedSubtitleTrackRecord[],
  trackKey: string,
  lang: string | undefined,
  settings: Partial<Settings>
): SegmentedSubtitleTrackRecord | null {
  const strategy = normalizeSubtitleSegmentationStrategy(settings.subtitleSegmentationStrategy);
  const segSig = buildSegmentationSignature({ strategy, lang });
  const exactKey = buildSegmentedTrackMapKey(trackKey, segSig);
  const exact = pageRecord.segmentedTracks?.[exactKey];
  if (exact && Array.isArray(exact.items) && exact.items.length > 0) {
    return exact;
  }
  const matching = segmentedTracks
    .filter((entry) => entry.trackKey === trackKey)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
  return matching[0] ?? null;
}

function extractValidArtifactPayload<T>(
  payload: unknown,
  field: string,
  validate: (value: unknown) => value is T
): T | null {
  if (validate(payload)) {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const nested = (payload as Record<string, unknown>)[field];
    if (validate(nested)) {
      return nested;
    }
  }
  return null;
}

function pickBestArtifact<T>(
  records: AiArtifactRecord[],
  storageCid: string,
  preferredMarker: string,
  field: string,
  validate: (value: unknown) => value is T
): T | null {
  const sorted = records
    .filter((record) => !record.cid || record.cid === storageCid)
    .sort((a, b) => {
      const aMatch = preferredMarker && String(a.key || "").includes(preferredMarker) ? 1 : 0;
      const bMatch = preferredMarker && String(b.key || "").includes(preferredMarker) ? 1 : 0;
      if (aMatch !== bMatch) {
        return bMatch - aMatch;
      }
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
  for (const record of sorted) {
    const valid = extractValidArtifactPayload(record.payload, field, validate);
    if (valid) {
      return valid;
    }
  }
  return null;
}

async function loadYoutubeCachedArtifacts(
  store: SubtitleIdbStore,
  storageBvid: string,
  storageCid: string,
  sourceKey: string
): Promise<{ l1Index: L1VideoIndexCacheRecord | null; analysisFinal: OverviewAnalysis | null }> {
  const preferredMarker = sourceKey ? `${storageBvid}_${storageCid}_${sourceKey}_` : "";
  try {
    const [l1Records, analysisRecords] = await Promise.all([
      store.listAiArtifactsByFamilyBvid(L1_INDEX_CACHE_PREFIX, storageBvid),
      store.listAiArtifactsByFamilyBvid(ANALYSIS_FINAL_PREFIX, storageBvid)
    ]);
    return {
      l1Index: pickBestArtifact(l1Records, storageCid, preferredMarker, "index", isL1VideoIndexCacheRecord),
      analysisFinal: pickBestArtifact(analysisRecords, storageCid, preferredMarker, "analysis", isOverviewShape)
    };
  } catch {
    return { l1Index: null, analysisFinal: null };
  }
}

async function resolveYoutubeCachedContext(ref: AiContext): Promise<AiContext> {
  const settings = await getMergedSettings();
  const store = resolveActiveSubtitleStore();
  const rawVideoId = String(ref.bvid || "").trim();
  const storageKey = resolveVideoStorageKey("youtube", rawVideoId, YOUTUBE_UNIT_CID);
  const pageRecord = await store.getPageRecord(storageKey.bvid, storageKey.cid);
  if (!pageRecord) {
    throw createYoutubeCacheEvictedError();
  }

  const hasPreferredRef = Boolean(ref.selectedSubtitleId || ref.selectedSubtitleUrl || ref.subtitleLang);
  const preferredSourceKey = hasPreferredRef
    ? buildSubtitleSourceKey(ref.selectedSubtitleId, ref.selectedSubtitleUrl, ref.subtitleLang)
    : "";
  const preferredLang = String(ref.subtitleLang || "").trim().toLowerCase();
  const rawTracks = nonEmptyTracks(pageRecord.rawTracks);
  const segmentedTracks = nonEmptyTracks(pageRecord.segmentedTracks);
  const chosenRaw = pickPreferredRawTrack(rawTracks, preferredSourceKey, preferredLang);

  let subtitleBody: SubtitleBodyItem[] = [];
  let matchedTrackKey = "";
  let matchedLang = "";

  if (chosenRaw) {
    matchedTrackKey = chosenRaw.trackKey;
    matchedLang = String(chosenRaw.lang || "").trim();
    const chosenSegmented = pickSegmentedTrackForSource(
      pageRecord,
      segmentedTracks,
      chosenRaw.trackKey,
      chosenRaw.lang || ref.subtitleLang,
      settings
    );
    if (chosenSegmented) {
      const touched = await store.getSegmentedTrack(
        storageKey.bvid,
        storageKey.cid,
        chosenSegmented.trackKey,
        chosenSegmented.segmentationSig
      );
      subtitleBody = Array.isArray(touched) && touched.length > 0 ? touched : chosenSegmented.items;
    } else {
      const touched = await store.getRawTrack(storageKey.bvid, storageKey.cid, chosenRaw.trackKey);
      subtitleBody = Array.isArray(touched) && touched.length > 0 ? touched : chosenRaw.items;
    }
  } else if (segmentedTracks.length > 0) {
    const sortedSeg = [...segmentedTracks].sort((a, b) => {
      const aMatch = preferredSourceKey && a.trackKey === preferredSourceKey ? 1 : 0;
      const bMatch = preferredSourceKey && b.trackKey === preferredSourceKey ? 1 : 0;
      if (aMatch !== bMatch) {
        return bMatch - aMatch;
      }
      return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
    });
    const chosenSegmented = sortedSeg[0];
    if (chosenSegmented) {
      matchedTrackKey = chosenSegmented.trackKey;
      const touched = await store.getSegmentedTrack(
        storageKey.bvid,
        storageKey.cid,
        chosenSegmented.trackKey,
        chosenSegmented.segmentationSig
      );
      subtitleBody = Array.isArray(touched) && touched.length > 0 ? touched : chosenSegmented.items;
    }
  }

  if (subtitleBody.length === 0) {
    throw createYoutubeCacheEvictedError();
  }

  const subtitleLang = String(ref.subtitleLang || matchedLang || "").trim();
  const rawTrackId = matchedTrackKey.startsWith("id_") ? matchedTrackKey.slice(3) : "";
  const selectedSubtitleId = String(ref.selectedSubtitleId || rawTrackId || "").trim();
  const selectedSubtitleUrl = String(ref.selectedSubtitleUrl || "").trim();
  const artifactSourceKey = matchedTrackKey || preferredSourceKey;
  const { l1Index, analysisFinal } = await loadYoutubeCachedArtifacts(
    store,
    storageKey.bvid,
    storageKey.cid,
    artifactSourceKey
  );

  const subtitleOptions: SubtitleOption[] = rawTracks.map((track) => {
    const id = track.trackKey.startsWith("id_") ? track.trackKey.slice(3) : track.trackKey;
    const lan = String(track.lang || subtitleLang || "").trim();
    return {
      id,
      lan,
      lanDoc: lan,
      subtitleUrl: id === selectedSubtitleId ? selectedSubtitleUrl : "",
      site: "youtube"
    };
  });

  let chapters: ChapterItem[] = [];
  if (Array.isArray(ref.chapters) && ref.chapters.length > 0) {
    chapters = ref.chapters;
  } else if (analysisFinal && Array.isArray(analysisFinal.chapters) && analysisFinal.chapters.length > 0) {
    chapters = analysisFinal.chapters;
  } else if (l1Index && Array.isArray(l1Index.chapters) && l1Index.chapters.length > 0) {
    chapters = l1Index.chapters as ChapterItem[];
  }

  const payload = createFetchedContextPayload({
    site: "youtube",
    bvid: rawVideoId,
    cid: YOUTUBE_UNIT_CID,
    aid: String(ref.aid || "").trim(),
    title: String(ref.title || "").trim(),
    author: String(ref.author || "").trim(),
    uploadDate: String(ref.uploadDate || "").trim(),
    url: buildCanonicalVideoUrl(rawVideoId, 1, "youtube") || String(ref.url || "").trim(),
    pageIndex: 1,
    pageCount: 1,
    pageTitle: String(ref.pageTitle || "").trim(),
    duration: Number(ref.videoDuration) > 0 ? Number(ref.videoDuration) : 0,
    subtitleBody,
    selectedSubtitleId,
    selectedSubtitleUrl,
    subtitleLang,
    subtitleOptions,
    chapters,
    settings
  });

  return {
    ...payload,
    ...(l1Index ? { l1Index } : {}),
    isVideoContext: true
  };
}

export async function resolveAiConversationContext(contextRef: unknown): Promise<AiContext> {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      site: ref.site,
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  if (ref.site === "youtube") {
    return resolveYoutubeCachedContext(ref);
  }

  const settings = await getMergedSettings();
  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const resolvedPage = resolveVideoPageFromMeta(videoMeta, {
    cid: ref.cid,
    pageIndex: resolveQueryPageIndex(ref)
  });
  const cid = resolvedPage.cid;
  if (!cid) {
    throw new Error("无法定位原视频分P");
  }
  const aid = String(videoMeta.aid || ref.aid || "").trim();
  const pageIndex = resolvedPage.pageIndex;
  const videoDuration = resolvedPage.duration;
  const subtitleBundle = await fetchSubtitleBundle(bgFetchJson, { bvid: ref.bvid, cid, aid });
  const loaded = await loadPreferredNativeSubtitle<SubtitleBodyItem>({
    tracks: subtitleBundle.tracks,
    preferred: {
      previousId: ref.selectedSubtitleId,
      previousUrl: ref.selectedSubtitleUrl,
      previousLang: ref.subtitleLang
    },
    bvid: ref.bvid,
    cid,
    videoDuration,
    transport: bgFetchJson
  });
  if (!loaded) {
    throw new Error("原视频暂时没有可用字幕");
  }

  const title = String(videoMeta.title || ref.title || "").trim();
  const author = String(videoMeta.author || ref.author || "").trim();
  const uploadDate = String(videoMeta.uploadDate || ref.uploadDate || "").trim();
  const pageTitle = String(resolvedPage.pageTitle || ref.pageTitle || "").trim();
  const url = buildCanonicalVideoUrl(ref.bvid, pageIndex, "bilibili") || ref.url;
  const selectedSubtitleId = String(loaded.track.id || "").trim();
  const selectedSubtitleUrl = String(loaded.track.subtitleUrl || "").trim();
  const subtitleLang = String(loaded.track.lanDoc || loaded.track.lan || "").trim();

  const payload = createFetchedContextPayload({
    site: "bilibili",
    bvid: ref.bvid,
    cid,
    aid,
    title,
    author,
    uploadDate,
    url,
    pageIndex,
    pageCount: resolvedPage.pageCount,
    pageTitle,
    duration: videoDuration,
    subtitleBody: loaded.body,
    selectedSubtitleId,
    selectedSubtitleUrl,
    subtitleLang,
    subtitleOptions: loaded.tracks,
    chapters: subtitleBundle.chapters,
    settings
  });
  return { ...payload, isVideoContext: true };
}

export async function resolveAiConversationPageRef(contextRef: unknown): Promise<{
  url: string;
  bvid: string;
  cid: string;
  pageIndex: number;
  pageTitle: string;
}> {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      url: ref.url || "",
      bvid: ref.bvid || "",
      cid: ref.cid || "",
      pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
      pageTitle: ref.pageTitle || ""
    };
  }

  if (ref.site === "youtube") {
    return {
      url: buildCanonicalVideoUrl(ref.bvid, 1, "youtube") || ref.url || "",
      bvid: ref.bvid,
      cid: YOUTUBE_UNIT_CID,
      pageIndex: 1,
      pageTitle: String(ref.pageTitle || "").trim()
    };
  }

  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const resolvedPage = resolveVideoPageFromMeta(videoMeta, {
    cid: ref.cid,
    pageIndex: resolveQueryPageIndex(ref)
  });
  return {
    url: buildCanonicalVideoUrl(ref.bvid, resolvedPage.pageIndex, "bilibili") || ref.url || "",
    bvid: ref.bvid,
    cid: resolvedPage.cid,
    pageIndex: resolvedPage.pageIndex,
    pageTitle: String(resolvedPage.pageTitle || ref.pageTitle || "").trim()
  };
}
