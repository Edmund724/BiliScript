import { extractBvid } from "../bilibili/video-id-shared.js";
import { BILI_HOST_SELECTORS } from "../bilibili/host-selectors.js";
import { getSiteRuntimeVideoElement } from "../core/site-video-probe.js";
import { clipState, state } from "../core/state.js";
import {
  detectActiveSite,
  extractYoutubeVideoId,
  YOUTUBE_UNIT_CID,
  type SiteId
} from "../shared/site.js";
import type { AgentBridgeTabSnapshot } from "./protocol.js";

const YOUTUBE_TITLE_SELECTORS = [
  "ytd-watch-metadata h1 yt-formatted-string",
  "ytd-watch-metadata h1",
  "#title h1 yt-formatted-string",
  "#title h1"
] as const;

function finiteTime(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function readHostTitle(site: SiteId): string {
  const selectors = site === "youtube" ? YOUTUBE_TITLE_SELECTORS : BILI_HOST_SELECTORS.videoTitles;
  for (const selector of selectors) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  if (site === "youtube") {
    return document.title.replace(/\s*-\s*YouTube$/i, "").trim();
  }
  return "";
}

export function collectAgentBridgeTabSnapshot(): Omit<AgentBridgeTabSnapshot, "tabId"> {
  const site: SiteId = clipState.site === "youtube" || detectActiveSite() === "youtube" ? "youtube" : "bilibili";
  const video =
    state.reader.readingVideoEl ??
    getSiteRuntimeVideoElement() ??
    document.querySelector<HTMLVideoElement>("video");
  const bvid =
    site === "youtube"
      ? clipState.bvid || extractYoutubeVideoId(location.href)
      : clipState.bvid || extractBvid(location.href);
  const cid = site === "youtube" ? clipState.cid || YOUTUBE_UNIT_CID : clipState.cid;
  return {
    site,
    bvid,
    cid,
    title: clipState.title || readHostTitle(site) || document.title,
    currentTime: finiteTime(video?.currentTime),
    duration: finiteTime(video?.duration, finiteTime(clipState.videoDuration)),
    subtitlesReady: clipState.subtitleFetchState === "ready" && clipState.subtitleBody.length > 0
  };
}
