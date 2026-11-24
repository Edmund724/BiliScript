import { isYoutubeWatchPage } from "../shared/site.js";

export const YOUTUBE_WATCH_FLEXY_SELECTOR = "ytd-watch-flexy";

export const YOUTUBE_ACTION_HOST_SELECTORS = [
  "ytd-watch-flexy #above-the-fold #actions #top-level-buttons-computed",
  "ytd-watch-flexy #actions #top-level-buttons-computed",
  "#above-the-fold #actions #top-level-buttons-computed",
  "#actions #top-level-buttons-computed",
  "ytd-watch-flexy #above-the-fold #actions-inner",
  "ytd-watch-flexy #above-the-fold #actions",
  "ytd-watch-flexy #actions",
  "#above-the-fold #actions-inner",
  "#above-the-fold #actions",
  "ytd-watch-metadata #actions #top-level-buttons-computed",
  "ytd-watch-metadata #actions",
  "#actions",
  "#top-level-buttons-computed"
] as const;

export const YOUTUBE_SECONDARY_SELECTORS = [
  "ytd-watch-flexy #columns #secondary",
  "ytd-watch-flexy #secondary",
  "#columns #secondary",
  "#secondary"
] as const;

export const YOUTUBE_PLAYER_SELECTORS = [
  "ytd-watch-flexy #movie_player",
  "#movie_player",
  "ytd-watch-flexy ytd-player#ytd-player",
  "ytd-watch-flexy ytd-player",
  "ytd-player#ytd-player",
  "ytd-player"
] as const;

export const YOUTUBE_MAIN_VIDEO_SELECTORS = [
  "ytd-watch-flexy #movie_player video.html5-main-video",
  "#movie_player video.html5-main-video",
  "ytd-watch-flexy #movie_player video",
  "#movie_player video",
  "ytd-watch-flexy ytd-player video.html5-main-video",
  "ytd-watch-flexy video.html5-main-video",
  "ytd-watch-flexy video"
] as const;

const YOUTUBE_IGNORED_ANCESTOR_SELECTOR = [
  "ytd-miniplayer",
  ".ytp-miniplayer-ui",
  "ytd-video-preview",
  "#video-preview-container",
  "ytd-thumbnail",
  "ytd-rich-item-renderer",
  "ytd-compact-video-renderer",
  "ytd-grid-video-renderer",
  "ytd-playlist-panel-video-renderer",
  "ytd-reel-video-renderer",
  "ytd-shorts",
  "#shorts-container",
  "[data-biliscript-historical-frame]"
].join(", ");

const MIN_YOUTUBE_SECONDARY_WIDTH = 280;

export type YoutubeAnchorSkipReason =
  | "ok"
  | "missing"
  | "hidden"
  | "theater-or-full-bleed"
  | "below-player"
  | "narrow"
  | "out-of-viewport";

export interface YoutubeScriptAnchorResult {
  anchor: HTMLElement | null;
  rect: DOMRect | null;
  reason: YoutubeAnchorSkipReason;
}

export interface RectLike {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

function hasTruthyHtmlAttr(el: Element | null, attr: string): boolean {
  if (!el || !el.hasAttribute(attr)) {
    return false;
  }
  const raw = String(el.getAttribute(attr) ?? "").trim().toLowerCase();
  return raw !== "false" && raw !== "0";
}

function isHiddenOrIgnoredHost(el: HTMLElement, allowMiniplayerCheck = true): boolean {
  if (!el.isConnected) {
    return true;
  }
  if (el.closest("[hidden]")) {
    return true;
  }
  if (
    allowMiniplayerCheck &&
    el.closest(
      "ytd-miniplayer, .ytp-miniplayer-ui, ytd-video-preview, #video-preview-container, ytd-reel-video-renderer, ytd-shorts, #shorts-container"
    )
  ) {
    return true;
  }
  return false;
}

function isElementDisplayed(el: HTMLElement): boolean {
  const view = el.ownerDocument?.defaultView || globalThis.window;
  if (!view || typeof view.getComputedStyle !== "function") {
    return true;
  }
  const style = view.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function queryFirstUsableElement(
  doc: Document,
  selectors: readonly string[],
  requireDisplayed = false
): HTMLElement | null {
  for (const selector of selectors) {
    const matches = Array.from(doc.querySelectorAll<HTMLElement>(selector));
    for (const candidate of matches) {
      if (isHiddenOrIgnoredHost(candidate)) {
        continue;
      }
      if (requireDisplayed && !isElementDisplayed(candidate)) {
        continue;
      }
      return candidate;
    }
  }
  return null;
}

export function isYoutubeWatchDocument(doc: Document = document): boolean {
  const href = String(doc?.location?.href || globalThis.location?.href || "");
  return isYoutubeWatchPage(href);
}

export function getYoutubeWatchFlexy(doc: Document = document): HTMLElement | null {
  return doc.querySelector<HTMLElement>(YOUTUBE_WATCH_FLEXY_SELECTOR);
}

export function findYoutubeActionHost(doc: Document = document): HTMLElement | null {
  if (!doc) {
    return null;
  }
  return queryFirstUsableElement(doc, YOUTUBE_ACTION_HOST_SELECTORS, false);
}

export function findYoutubeSecondaryColumn(doc: Document = document): HTMLElement | null {
  if (!doc) {
    return null;
  }
  return queryFirstUsableElement(doc, YOUTUBE_SECONDARY_SELECTORS, false);
}

export function findYoutubePlayerHost(doc: Document = document): HTMLElement | null {
  if (!doc) {
    return null;
  }
  return queryFirstUsableElement(doc, YOUTUBE_PLAYER_SELECTORS, false);
}

export function isYoutubeTheaterOrFullBleed(doc: Document = document): boolean {
  const flexy = getYoutubeWatchFlexy(doc);
  if (
    hasTruthyHtmlAttr(flexy, "theater") ||
    hasTruthyHtmlAttr(flexy, "full-bleed-player") ||
    hasTruthyHtmlAttr(flexy, "fullscreen")
  ) {
    return true;
  }
  if (doc.fullscreenElement) {
    return true;
  }
  const player = findYoutubePlayerHost(doc);
  return Boolean(player?.classList.contains("ytp-fullscreen"));
}

export function isYoutubeSecondaryBelowPlayer(
  secondaryRect: RectLike | null | undefined,
  playerRect: RectLike | null | undefined
): boolean {
  if (!secondaryRect || !playerRect) {
    return false;
  }
  if (playerRect.height <= 0 || playerRect.bottom <= 0) {
    return false;
  }
  return secondaryRect.top >= playerRect.bottom;
}

export function findYoutubeScriptAnchor(
  doc: Document = document,
  viewportWidth?: number
): YoutubeScriptAnchorResult {
  if (!doc) {
    return { anchor: null, rect: null, reason: "missing" };
  }
  if (isYoutubeTheaterOrFullBleed(doc)) {
    return { anchor: null, rect: null, reason: "theater-or-full-bleed" };
  }

  const secondary = findYoutubeSecondaryColumn(doc);
  if (!secondary) {
    return { anchor: null, rect: null, reason: "missing" };
  }
  if (!isElementDisplayed(secondary)) {
    return { anchor: null, rect: null, reason: "hidden" };
  }

  const rect = secondary.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return { anchor: null, rect: null, reason: "hidden" };
  }

  const player = findYoutubePlayerHost(doc);
  const playerRect = player ? player.getBoundingClientRect() : null;
  if (isYoutubeSecondaryBelowPlayer(rect, playerRect)) {
    return { anchor: null, rect: null, reason: "below-player" };
  }

  if (rect.width < MIN_YOUTUBE_SECONDARY_WIDTH) {
    return { anchor: null, rect: null, reason: "narrow" };
  }

  const resolvedViewportWidth =
    typeof viewportWidth === "number" && Number.isFinite(viewportWidth)
      ? viewportWidth
      : Number(doc.defaultView?.innerWidth || globalThis.innerWidth || 0);
  if (rect.left < 0 || rect.right > resolvedViewportWidth) {
    return { anchor: null, rect: null, reason: "out-of-viewport" };
  }

  return { anchor: secondary, rect, reason: "ok" };
}

export function isIgnoredYoutubeVideoCandidate(video: Element | null | undefined): boolean {
  if (!video || String(video.tagName || "").toUpperCase() !== "VIDEO") {
    return true;
  }
  if (video.hasAttribute("data-biliscript-historical-frame")) {
    return true;
  }
  if (video.closest("[hidden]")) {
    return true;
  }
  if (video.closest(YOUTUBE_IGNORED_ANCESTOR_SELECTOR)) {
    return true;
  }
  return false;
}

function scoreYoutubeVideoCandidate(video: HTMLVideoElement): number {
  let score = 0;
  if (video.closest("#movie_player")) {
    score += 1000;
  }
  if (video.closest(YOUTUBE_WATCH_FLEXY_SELECTOR)) {
    score += 400;
  }
  if (video.classList.contains("html5-main-video")) {
    score += 200;
  }
  if (video.readyState > 0) {
    score += 50 + Math.min(video.readyState, 4) * 5;
  }
  if (!video.paused) {
    score += 20;
  }
  const rect = typeof video.getBoundingClientRect === "function" ? video.getBoundingClientRect() : null;
  if (rect && rect.width > 0 && rect.height > 0) {
    score += Math.min(Math.round((rect.width * rect.height) / 1000), 500);
  }
  return score;
}

export function getYoutubeVideoElement(doc: Document = document): HTMLVideoElement | null {
  if (!doc) {
    return null;
  }
  for (const selector of YOUTUBE_MAIN_VIDEO_SELECTORS) {
    const matches = Array.from(doc.querySelectorAll<HTMLVideoElement>(selector));
    for (const candidate of matches) {
      if (isIgnoredYoutubeVideoCandidate(candidate)) {
        continue;
      }
      if (!isElementDisplayed(candidate)) {
        continue;
      }
      return candidate;
    }
  }

  const allVideos = Array.from(doc.querySelectorAll<HTMLVideoElement>("video"));
  let best: HTMLVideoElement | null = null;
  let bestScore = -1;
  for (const candidate of allVideos) {
    if (isIgnoredYoutubeVideoCandidate(candidate) || !isElementDisplayed(candidate)) {
      continue;
    }
    const score = scoreYoutubeVideoCandidate(candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}
