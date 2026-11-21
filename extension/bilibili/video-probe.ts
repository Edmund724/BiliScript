// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import { state } from "../core/state.js";
import { findPlayerHostFromVideo, isPlayerHostElement } from "./host-selectors.js";

export function findReaderPlayerHost(video: Element | null | undefined): Element | null {
  return findPlayerHostFromVideo(video);
}

function isIgnoredReaderVideoCandidate(video: Element | null | undefined): boolean {
  if (!video) {
    return true;
  }
  const host = findReaderPlayerHost(video);
  const blockedSelector = [
    "[data-biliscript-historical-frame]",
    ".bpx-player-mini-warp",
    ".bpx-player-mini-close",
    ".bpx-player-ending-panel",
    ".bpx-player-ending-related",
    "[class*='mini-player']",
    "[class*='picture-in-picture']",
    "[class*='adcard']",
    ".ad-report",
    "[class*='ad-report']",
    ".video-page-card-small",
    ".video-page-special-card-small",
    ".feed-card",
    ".bili-video-card"
  ].join(", ");
  return Boolean(video.closest(blockedSelector) || host?.closest?.(blockedSelector));
}

let cachedVideoRef: WeakRef<HTMLVideoElement> | null = null;

export function getRuntimeVideoElement(): HTMLVideoElement | null {
  if (cachedVideoRef) {
    const cached = cachedVideoRef.deref();
    if (cached?.isConnected && !isIgnoredReaderVideoCandidate(cached)) {
      return cached;
    }
  }

  const readingVideoEl = state.reader.readingVideoEl as HTMLVideoElement | null | undefined;
  if (readingVideoEl?.isConnected) {
    const currentHost = findReaderPlayerHost(readingVideoEl);
    const currentRect = readingVideoEl.getBoundingClientRect();
    if (
      currentHost?.isConnected &&
      currentRect.width > 120 &&
      currentRect.height > 68 &&
      !isIgnoredReaderVideoCandidate(readingVideoEl)
    ) {
      cachedVideoRef = new WeakRef(readingVideoEl);
      return readingVideoEl;
    }
  }

  const candidates = Array.from(document.querySelectorAll("video")).filter(
    (item) => item.isConnected && !isIgnoredReaderVideoCandidate(item)
  );
  if (candidates.length === 0) {
    return null;
  }

  const visible = candidates
    .map((item) => {
      const rect = item.getBoundingClientRect();
      const host = findReaderPlayerHost(item);
      const inPlayer = isPlayerHostElement(host);
      const area = Math.max(0, rect.width) * Math.max(0, rect.height);
      const score =
        area +
        (inPlayer ? 1000000 : 0) +
        (!item.paused ? 20000 : 0) +
        Number(item.readyState || 0) * 2000 +
        (item.currentSrc ? 10000 : 0) +
        (item === readingVideoEl ? 500 : 0);
      return { item, rect, score };
    })
    .filter(({ rect }) => rect.width > 240 && rect.height > 120)
    .sort((a, b) => b.score - a.score)[0];

  const result = visible?.item || candidates[0] || null;
  if (result) {
    cachedVideoRef = new WeakRef(result);
  }
  return result;
}

export function waitForVideoMetadata(timeoutMs = 5000, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const start = Date.now();
    let timer = 0;
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        window.clearTimeout(timer);
        timer = 0;
      }
      signal?.removeEventListener("abort", finish);
      resolve();
    };

    if (signal) {
      signal.addEventListener("abort", finish, { once: true });
    }

    const check = () => {
      if (settled) {
        return;
      }
      const video = getRuntimeVideoElement();
      const duration = Number(video?.duration);
      const ready = video && Number.isFinite(duration) && duration > 0;
      if (ready || Date.now() - start >= timeoutMs) {
        finish();
        return;
      }
      timer = window.setTimeout(check, 150);
    };
    check();
  });
}
