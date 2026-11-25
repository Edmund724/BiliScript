import { state } from "../core/state.js";
import { getAsrFailureNotice } from "../core/asr-failure-notice.js";
import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import {
  detectActiveSite,
  extractYoutubeVideoId,
  YOUTUBE_UNIT_CID,
  type SiteId
} from "../shared/site.js";
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { normalizeSubtitleItems } from "../subtitle/signature.js";
import { fetchYoutubeHotComments, fetchYoutubeVideoBundle } from "../youtube/gateway.js";
import type {
  AgentBridgeComment,
  AgentBridgeContentCommentsResult,
  AgentBridgeContentSubtitlesResult,
  AgentBridgeSubtitleItem,
  AgentBridgeVideo
} from "./protocol.js";

function resolveActiveSite(): SiteId {
  return state.clip.site === "youtube" || detectActiveSite() === "youtube" ? "youtube" : "bilibili";
}

function isCurrentClip(): boolean {
  if (resolveActiveSite() === "youtube") {
    return state.clip.site === "youtube"
      && Boolean(state.clip.bvid)
      && state.clip.bvid === extractYoutubeVideoId(location.href);
  }
  return state.clip.site === "bilibili"
    && Boolean(state.clip.bvid)
    && state.clip.bvid === extractBvid(location.href)
    && state.clip.pageIndex === extractPageIndex(location.href);
}

function buildClipVideoSnapshot(): AgentBridgeVideo {
  const isYoutube = state.clip.site === "youtube";
  const duration = Number(state.clip.videoDuration);
  return {
    site: state.clip.site,
    bvid: state.clip.bvid,
    aid: isYoutube ? "" : state.clip.aid,
    cid: isYoutube ? state.clip.cid || YOUTUBE_UNIT_CID : state.clip.cid,
    title: state.clip.title,
    author: state.clip.author,
    description: state.clip.description,
    uploadDate: state.clip.uploadDate,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : 0,
    page: isYoutube ? 1 : state.clip.pageIndex,
    pageCount: isYoutube ? 1 : state.clip.pageCount
  };
}

function normalizeBridgeComments(
  comments: Array<{ uname: string; like: number; message: string; subMessages?: string[] }>
): AgentBridgeComment[] {
  return comments.map((item) => ({
    uname: String(item.uname || ""),
    like: Number(item.like) || 0,
    message: String(item.message || ""),
    ...(Array.isArray(item.subMessages) && item.subMessages.length
      ? { subMessages: item.subMessages.map((sub) => String(sub || "")) }
      : {})
  }));
}

function readReadySubtitles(): AgentBridgeContentSubtitlesResult | null {
  if (!isCurrentClip() || !state.clip.subtitleBody.length) return null;
  const items: AgentBridgeSubtitleItem[] = normalizeSubtitleItems(state.clip.subtitleBody).map((item) => ({
    from: Number(item.from) || 0,
    to: Number(item.to) || Number(item.from) || 0,
    content: String(item.content || "").trim()
  }));
  if (!items.length) return null;
  const isYoutube = state.clip.site === "youtube";
  return {
    site: state.clip.site,
    bvid: state.clip.bvid,
    cid: isYoutube ? state.clip.cid || YOUTUBE_UNIT_CID : state.clip.cid,
    pageIndex: isYoutube ? 1 : state.clip.pageIndex,
    video: buildClipVideoSnapshot(),
    chapters: state.clip.chapters.map((chapter) => ({
      title: String(chapter.title || ""),
      from: Number(chapter.from) || 0,
      to: Number(chapter.to) || 0,
      source: isYoutube ? "youtube" : "bilibili"
    })),
    subtitle: {
      source: isYoutube ? "youtube" : (state.clip.selectedSubtitleId === "asr" ? "asr" : "bilibili"),
      trackId: state.clip.selectedSubtitleId,
      language: state.clip.selectedSubtitleLang || "unknown",
      items
    }
  };
}

function noSubtitleError(): Error {
  const notice = getAsrFailureNotice(state.clip.noSubtitleReason);
  return new Error([
    "当前视频无可用字幕。",
    notice.cause,
    notice.remedyText,
    state.clip.noSubtitleDetail
  ].filter(Boolean).join(" "));
}

export const WAIT_FOR_SUBTITLES_TIMEOUT_MS = 30_000;

async function waitForSubtitles(timeoutMs = WAIT_FOR_SUBTITLES_TIMEOUT_MS): Promise<AgentBridgeContentSubtitlesResult> {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (true) {
    const ready = readReadySubtitles();
    if (ready) return ready;
    if (!isCurrentClip() || state.clip.subtitleFetchState === "error" || state.clip.subtitleFetchState === "empty") {
      throw noSubtitleError();
    }
    if (Date.now() >= deadline) {
      throw new Error("等待字幕抓取超时，请稍后重试。");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function getAgentBridgeSubtitles(
  options: { timeoutMs?: number } = {}
): Promise<AgentBridgeContentSubtitlesResult> {
  const ready = readReadySubtitles();
  if (ready) return ready;

  if (!isCurrentClip() || state.clip.subtitleFetchState !== "loading") {
    const started = await kickSubtitleFetch((chain) => chain.refreshClip(), {
      awaitVideoMetadata: true
    });
    if (!started) throw new Error("字幕抓取模块加载失败，请刷新视频标签页后重试");
    const completed = readReadySubtitles();
    if (completed) return completed;
    throw noSubtitleError();
  }
  return waitForSubtitles(options.timeoutMs);
}

export async function getAgentBridgeComments(limit = 20): Promise<AgentBridgeContentCommentsResult> {
  if (resolveActiveSite() !== "youtube") {
    return {
      site: "bilibili",
      video: buildClipVideoSnapshot(),
      comments: normalizeBridgeComments(state.clip.hotComments)
    };
  }

  const videoId = extractYoutubeVideoId(location.href) || state.clip.bvid;
  if (!videoId) {
    throw new Error("当前标签页不是有效的 YouTube 视频页");
  }

  let video: AgentBridgeVideo;
  let snapshot = null;
  if (isCurrentClip() && state.clip.title) {
    video = buildClipVideoSnapshot();
  } else {
    const bundle = await fetchYoutubeVideoBundle(videoId);
    snapshot = bundle.meta;
    video = {
      site: "youtube",
      bvid: bundle.meta.videoId || videoId,
      aid: "",
      cid: YOUTUBE_UNIT_CID,
      title: bundle.meta.title || document.title.replace(/\s*-\s*YouTube$/i, "").trim(),
      author: bundle.meta.author || "",
      description: bundle.meta.description || "",
      uploadDate: bundle.meta.publishDate || "",
      duration: Number.isFinite(bundle.meta.duration) && bundle.meta.duration >= 0 ? bundle.meta.duration : 0,
      page: 1,
      pageCount: 1
    };
  }

  if (isCurrentClip() && state.clip.hotComments.length > 0) {
    return {
      site: "youtube",
      video,
      comments: normalizeBridgeComments(state.clip.hotComments.slice(0, Math.max(0, limit)))
    };
  }

  const comments = await fetchYoutubeHotComments(limit, { videoId, snapshot });
  return {
    site: "youtube",
    video,
    comments: normalizeBridgeComments(comments)
  };
}
