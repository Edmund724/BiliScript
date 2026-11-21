import { state } from "../core/state.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { readerPorts } from "./reader-bus.js";

export function unbindReadingViewVideoSync(): void {
  const prev = state.reader.readingVideoEl;
  if (prev && prev.__biliscriptReadingSyncController) {
    prev.__biliscriptReadingSyncController.abort();
    delete prev.__biliscriptReadingSyncController;
  }
}

export function bindReadingViewVideo(video: HTMLVideoElement | null = getRuntimeVideoElement()): HTMLVideoElement | null {
  if (!video) {
    unbindReadingViewVideoSync();
    state.reader.readingVideoEl = null;
    return null;
  }

  if (state.reader.readingVideoEl === video && video.__biliscriptReadingSyncController) {
    return video;
  }

  unbindReadingViewVideoSync();

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
  video.addEventListener("seeked", syncHandler, { signal });
  video.addEventListener("loadedmetadata", syncHandler, { signal });
  video.__biliscriptReadingSyncController = controller;
  state.reader.readingVideoEl = video;
  return video;
}
