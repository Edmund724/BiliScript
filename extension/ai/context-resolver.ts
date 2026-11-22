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
import { getMergedSettings } from "../core/settings-store.js";
import { createFetchedContextPayload } from "../core/context-payload.js";
import type { SubtitleBodyItem } from "../core/state.js";
import { buildAiContextRef } from "./conversation.js";
import type { AiContext } from "./types.js";

function resolveQueryPageIndex(ref: AiContext): number {
  const urlPage = extractPageIndexFromUrl(ref.url || "");
  if (urlPage > 1) {
    return urlPage;
  }
  return Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1;
}

export async function resolveAiConversationContext(contextRef: unknown): Promise<AiContext> {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
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
  const url = buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url;
  const selectedSubtitleId = String(loaded.track.id || "").trim();
  const selectedSubtitleUrl = String(loaded.track.subtitleUrl || "").trim();
  const subtitleLang = String(loaded.track.lanDoc || loaded.track.lan || "").trim();

  const payload = createFetchedContextPayload({
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

  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const resolvedPage = resolveVideoPageFromMeta(videoMeta, {
    cid: ref.cid,
    pageIndex: resolveQueryPageIndex(ref)
  });
  return {
    url: buildCanonicalVideoUrl(ref.bvid, resolvedPage.pageIndex) || ref.url || "",
    bvid: ref.bvid,
    cid: resolvedPage.cid,
    pageIndex: resolvedPage.pageIndex,
    pageTitle: String(resolvedPage.pageTitle || ref.pageTitle || "").trim()
  };
}
