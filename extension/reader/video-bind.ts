import { state } from "../core/state.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { detectActiveSite } from "../shared/site.js";
import { getYoutubeVideoElement, isIgnoredYoutubeVideoCandidate } from "../youtube/host-adapter.js";
import { readerPorts } from "./reader-bus.js";

function isYoutubeSiteActive(): boolean {
  return state.clip.site === "youtube" || detectActiveSite() === "youtube";
}

function resolveBoundVideoTarget(candidate?: HTMLVideoElement | null): HTMLVideoElement | null {
  if (!isYoutubeSiteActive()) {
    return candidate === undefined ? getRuntimeVideoElement() : candidate;
  }
  if (candidate === undefined) {
    return getYoutubeVideoElement(document);
  }
  if (!candidate || isIgnoredYoutubeVideoCandidate(candidate)) {
    return getYoutubeVideoElement(document);
  }
  const mainVideo = getYoutubeVideoElement(document);
  if (mainVideo && mainVideo !== candidate && !candidate.closest("#movie_player")) {
    return mainVideo;
  }
  return candidate;
}

export function unbindReadingViewVideoSync(): void {
  const prev = state.reader.readingVideoEl;
  if (prev && prev.__biliscriptReadingSyncController) {
    prev.__biliscriptReadingSyncController.abort();
    delete prev.__biliscriptReadingSyncController;
  }
  state.reader.readingVideoEl = null;
}

export function bindReadingViewVideo(video?: HTMLVideoElement | null): HTMLVideoElement | null {
  const target = resolveBoundVideoTarget(video);
  if (!target) {
    unbindReadingViewVideoSync();
    return null;
  }

  if (state.reader.readingVideoEl === target && target.__biliscriptReadingSyncController) {
    return target;
  }

  unbindReadingViewVideoSync();
  if (target.__biliscriptReadingSyncController) {
    target.__biliscriptReadingSyncController.abort();
    delete target.__biliscriptReadingSyncController;
  }

  const syncHandler = (event: Event) => {
    if (state.reader.readingViewOpen) {
      if (event?.type === "seeked") {
        state.reader.setNextScrollBehavior("auto");
      }
      readerPorts.syncReadingViewPlayback();
    }
  };
  const controller = new AbortController();
  const { signal } = controller;
  target.addEventListener("seeked", syncHandler, { signal });
  target.addEventListener("loadedmetadata", syncHandler, { signal });
  target.addEventListener("durationchange", syncHandler, { signal });
  target.__biliscriptReadingSyncController = controller;
  state.reader.readingVideoEl = target;
  return target;
}
