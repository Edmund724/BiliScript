import { createLazyLoader } from "../shared/lazy-import.js";

interface PlaybackRateDomain {
  startPlaybackRateButtons(): void;
  stopPlaybackRateButtons(): void;
}

const loader = createLazyLoader<PlaybackRateDomain>(() => import("./playback-rate.js"));

export function loadPlaybackRate(): Promise<PlaybackRateDomain> {
  return loader.load();
}

export function isPlaybackRateLoaded(): boolean {
  return loader.isLoaded();
}
