import { clipState, state } from "../core/state.js";
import { BILI_HOST_SELECTORS } from "../bilibili/host-selectors.js";
import type { AgentBridgeTabSnapshot } from "./protocol.js";

function finiteTime(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function readHostTitle(): string {
  for (const selector of BILI_HOST_SELECTORS.videoTitles) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return "";
}

export function collectAgentBridgeTabSnapshot(): Omit<AgentBridgeTabSnapshot, "tabId"> {
  const video = state.reader.readingVideoEl ?? document.querySelector<HTMLVideoElement>("video");
  return {
    bvid: clipState.bvid,
    cid: clipState.cid,
    title: clipState.title || readHostTitle() || document.title,
    currentTime: finiteTime(video?.currentTime),
    duration: finiteTime(video?.duration, finiteTime(clipState.videoDuration)),
    subtitlesReady: clipState.subtitleFetchState === "ready" && clipState.subtitleBody.length > 0
  };
}
