// 当前播放器的音量闪避：跟随运行时的视频节点，并保留用户最新音量意图。

import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";

export const MOSS_VIDEO_DUCK_RATIO = 0.18;
export const MOSS_VIDEO_DUCK_MIN_VOLUME = 0.05;
export const MOSS_VIDEO_DUCK_TRANSITION_MS = 160;

export interface PageVideoDuckOptions {
  getVideo?: () => HTMLVideoElement | null;
  transitionMs?: number;
  now?: () => number;
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (handle: number) => void;
}

export interface PageVideoDuckSession {
  setDucked(ducked: boolean): void;
  stop(): void;
}

interface VolumeAnimation {
  from: number;
  to: number;
  startedAt: number;
}

function clampVolume(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

export function getDuckedVolume(volume: number): number {
  return Math.max(MOSS_VIDEO_DUCK_MIN_VOLUME, clampVolume(volume) * MOSS_VIDEO_DUCK_RATIO);
}

export function createPageVideoDuck(options: PageVideoDuckOptions = {}): PageVideoDuckSession {
  const getVideo = options.getVideo || getRuntimeVideoElement;
  const transitionMs = Math.max(0, options.transitionMs ?? MOSS_VIDEO_DUCK_TRANSITION_MS);
  const now = options.now || (() => performance.now());
  const requestFrame = options.requestFrame || ((callback) => window.requestAnimationFrame(callback));
  const cancelFrame = options.cancelFrame || ((handle) => window.cancelAnimationFrame(handle));

  let stopped = false;
  let ducked = false;
  let activeVideo: HTMLVideoElement | null = null;
  let baseVolume = 1;
  let lastWrittenVolume: number | null = null;
  let animation: VolumeAnimation | null = null;
  let frameHandle: number | null = null;

  function cancelAnimation(): void {
    if (frameHandle !== null) {
      cancelFrame(frameHandle);
      frameHandle = null;
    }
    animation = null;
  }

  function writeVolume(video: HTMLVideoElement, volume: number): void {
    const nextVolume = clampVolume(volume);
    lastWrittenVolume = nextVolume;
    if (Math.abs(video.volume - nextVolume) > 0.0001) {
      video.volume = nextVolume;
    }
  }

  function detachVideo(): void {
    activeVideo?.removeEventListener("volumechange", handleVolumeChange);
    activeVideo = null;
    lastWrittenVolume = null;
  }

  function finishIfRestored(): void {
    if (!ducked && !animation) {
      detachVideo();
    }
  }

  function animateTo(target: number): void {
    cancelAnimation();
    const video = activeVideo;
    if (!video) return;
    const from = clampVolume(video.volume);
    if (transitionMs === 0 || Math.abs(from - target) <= 0.0001) {
      writeVolume(video, target);
      finishIfRestored();
      return;
    }

    animation = { from, to: target, startedAt: now() };
    frameHandle = requestFrame(onAnimationFrame);
  }

  function handleVolumeChange(): void {
    const video = activeVideo;
    if (stopped || !video) return;
    const currentVolume = clampVolume(video.volume);
    if (lastWrittenVolume !== null && Math.abs(currentVolume - lastWrittenVolume) <= 0.001) {
      return;
    }
    lastWrittenVolume = null;
    baseVolume = currentVolume;
    animateTo(ducked ? getDuckedVolume(baseVolume) : baseVolume);
  }

  function attachVideo(video: HTMLVideoElement): void {
    activeVideo = video;
    baseVolume = clampVolume(video.volume);
    lastWrittenVolume = null;
    video.addEventListener("volumechange", handleVolumeChange);
    animateTo(getDuckedVolume(baseVolume));
  }

  function handleVideoReplacement(): void {
    cancelAnimation();
    detachVideo();
    ducked = false;
  }

  function syncVideoElement(): void {
    if (stopped) return;
    const nextVideo = getVideo();
    if (nextVideo === activeVideo) return;
    if (activeVideo) {
      handleVideoReplacement();
      return;
    }
    if (ducked && nextVideo) {
      attachVideo(nextVideo);
    }
  }

  function onAnimationFrame(time: number): void {
    frameHandle = null;
    const currentAnimation = animation;
    const video = activeVideo;
    if (stopped || !currentAnimation || !video) return;
    if (getVideo() !== video) {
      handleVideoReplacement();
      return;
    }

    const progress = Math.max(0, Math.min(1, (time - currentAnimation.startedAt) / transitionMs));
    const eased = progress * progress * (3 - 2 * progress);
    writeVolume(video, currentAnimation.from + (currentAnimation.to - currentAnimation.from) * eased);
    if (progress < 1) {
      frameHandle = requestFrame(onAnimationFrame);
      return;
    }
    animation = null;
    writeVolume(video, currentAnimation.to);
    finishIfRestored();
  }

  function setDucked(nextDucked: boolean): void {
    if (stopped || ducked === nextDucked) return;
    ducked = nextDucked;
    if (!ducked) {
      if (activeVideo) animateTo(baseVolume);
      return;
    }
    const previousVideo = activeVideo;
    syncVideoElement();
    if (activeVideo && activeVideo === previousVideo) {
      animateTo(getDuckedVolume(baseVolume));
    }
  }

  function handleUrlChange(): void {
    setDucked(false);
  }

  function release(): void {
    if (stopped) return;
    stopped = true;
    ducked = false;
    cancelAnimation();
    if (activeVideo) {
      writeVolume(activeVideo, baseVolume);
    }
    detachVideo();
    observer.disconnect();
    window.removeEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);
  }

  const observer = new MutationObserver(syncVideoElement);
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
  window.addEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);

  return { setDucked, stop: release };
}
