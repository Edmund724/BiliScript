import { clipState, state } from "../core/state.js";
import type { AgentBridgeTabSnapshot } from "./protocol.js";

function finiteTime(value: unknown, fallback = 0): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function collectAgentBridgeTabSnapshot(): Omit<AgentBridgeTabSnapshot, "tabId"> {
  const video = state.reader.readingVideoEl ?? document.querySelector<HTMLVideoElement>("video");
  return {
    bvid: clipState.bvid,
    cid: clipState.cid,
    title: clipState.title || document.title,
    currentTime: finiteTime(video?.currentTime),
    duration: finiteTime(video?.duration, finiteTime(clipState.videoDuration)),
    subtitlesReady: clipState.subtitleFetchState === "ready" && clipState.subtitleBody.length > 0
  };
}
