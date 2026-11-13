import { state } from "../core/state.js";
import { getAsrFailureNotice } from "../core/asr-failure-notice.js";
import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { normalizeSubtitleItems } from "../subtitle/cache.js";
import type {
  AgentBridgeContentSubtitlesResult,
  AgentBridgeSubtitleItem
} from "./protocol.js";

function isCurrentClip(): boolean {
  return Boolean(state.clip.bvid)
    && state.clip.bvid === extractBvid(location.href)
    && state.clip.pageIndex === extractPageIndex(location.href);
}

function readReadySubtitles(): AgentBridgeContentSubtitlesResult | null {
  if (!isCurrentClip() || !state.clip.subtitleBody.length) return null;
  const items: AgentBridgeSubtitleItem[] = normalizeSubtitleItems(state.clip.subtitleBody).map((item) => ({
    from: Number(item.from) || 0,
    to: Number(item.to) || Number(item.from) || 0,
    content: String(item.content || "").trim()
  }));
  if (!items.length) return null;
  return {
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    pageIndex: state.clip.pageIndex,
    chapters: state.clip.chapters.map((chapter) => ({
      title: String(chapter.title || ""),
      from: Number(chapter.from) || 0,
      to: Number(chapter.to) || 0,
      source: "bilibili"
    })),
    subtitle: {
      source: state.clip.selectedSubtitleId === "asr" ? "asr" : "bilibili",
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

async function waitForSubtitles(): Promise<AgentBridgeContentSubtitlesResult> {
  while (true) {
    const ready = readReadySubtitles();
    if (ready) return ready;
    if (!isCurrentClip() || state.clip.subtitleFetchState === "error" || state.clip.subtitleFetchState === "empty") {
      throw noSubtitleError();
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export async function getAgentBridgeSubtitles(): Promise<AgentBridgeContentSubtitlesResult> {
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
  return waitForSubtitles();
}
