import { getFullscreenHost } from "../bilibili/fullscreen.js";
import {
  VIDEO_PLAYER_CONTAINER_SELECTOR,
  findVideoPlayerContainer
} from "../bilibili/host-selectors.js";
import { state } from "../core/state.js";
import { detectActiveSite } from "../shared/site.js";
import { ensureInterpretSubtitleStyles } from "../shared/style-injector.js";
import { findYoutubePlayerHost } from "../youtube/host-adapter.js";

export const VIDEO_PLAYER_HOST_SELECTOR = VIDEO_PLAYER_CONTAINER_SELECTOR;

export type PlayerNoticeConsumer = (message: string, autoHideMs?: number) => void;

export interface PlayerNoticeHost {
  show(message: string, autoHideMs?: number): void;
  dispose(): void;
}

export function findVideoPlayerHost(): HTMLElement | null {
  if (state.clip.site === "youtube" || detectActiveSite() === "youtube") {
    return findYoutubePlayerHost(document);
  }
  return findVideoPlayerContainer();
}

export function createPlayerNoticeHost(
  getHost: () => HTMLElement | null = () => getFullscreenHost() || findVideoPlayerHost()
): PlayerNoticeHost {
  let noticeEl: HTMLElement | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function show(message: string, autoHideMs = 6000): void {
    const host = getHost();
    if (!host) return;
    ensureInterpretSubtitleStyles();
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (!noticeEl) {
      noticeEl = document.createElement("div");
      noticeEl.className = "biliscript-interpret-notice";
      noticeEl.setAttribute("data-biliscript-extension-node", "interpret-notice");
      noticeEl.setAttribute("role", "status");
    }
    if (noticeEl.parentElement !== host) host.appendChild(noticeEl);
    noticeEl.textContent = message;
    if (autoHideMs > 0) {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        noticeEl?.remove();
        noticeEl = null;
      }, autoHideMs);
    }
  }

  function dispose(): void {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeEl?.remove();
    noticeEl = null;
  }

  return { show, dispose };
}

export const sharedPlayerNotice: PlayerNoticeHost = createPlayerNoticeHost();
let noticeConsumer: PlayerNoticeConsumer | null = null;

export function setPlayerNoticeConsumer(handler: PlayerNoticeConsumer | null): void {
  noticeConsumer = handler;
}

export function showPlayerToast(message: string, autoHideMs?: number): void {
  sharedPlayerNotice.show(message, autoHideMs);
}

export function notifyPlayerOrConsumer(message: string, autoHideMs?: number): void {
  if (noticeConsumer) {
    noticeConsumer(message, autoHideMs);
    return;
  }
  sharedPlayerNotice.show(message, autoHideMs);
}

export function disposePlayerToast(): void {
  sharedPlayerNotice.dispose();
}
