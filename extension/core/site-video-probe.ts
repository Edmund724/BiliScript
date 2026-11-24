import { state } from "./state.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { getYoutubeVideoElement } from "../youtube/host-adapter.js";

export function getSiteRuntimeVideoElement(
  doc: Document | null = typeof document === "undefined" ? null : document
): HTMLVideoElement | null {
  if (state.clip.site === "youtube") {
    const readingVideoEl = state.reader.readingVideoEl as HTMLVideoElement | null | undefined;
    if (readingVideoEl?.isConnected) {
      return readingVideoEl;
    }
    return doc ? getYoutubeVideoElement(doc) : null;
  }
  return getRuntimeVideoElement();
}
