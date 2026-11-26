import { BILI_HOST_SELECTORS } from "../bilibili/host-selectors.js";
import { isFestivalPage } from "../bilibili/video-id-shared.js";
import { findReaderPlayerHost } from "../bilibili/video-probe.js";
import { state } from "../core/state.js";
import { CUSTOM_PANEL_WIDTH_MAX, CUSTOM_PANEL_WIDTH_MIN } from "../core/validators.js";
import { activeById, getOpenerDocument, isReaderDetached } from "../shared/active-host.js";
import { detectActiveSite } from "../shared/site.js";
import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";
import {
  findYoutubePlayerHost,
  findYoutubeScriptAnchor,
  getYoutubeWatchFlexy
} from "../youtube/host-adapter.js";
import { bindPanelResizeHandle } from "./panel-resize.js";
import { ids } from "./state.js";

const ANCHOR_SELECTORS = BILI_HOST_SELECTORS.rightColumnAnchors;
const TOP_HEADER_SELECTORS = BILI_HOST_SELECTORS.topHeaderBars;
const FESTIVAL_HEADER_GAP = 8;

const ANCHOR_MIN_WIDTH = 280;
const PANEL_MIN_WIDTH = 300;
export const MIN_PINNED_VIEWPORT_GUTTER = 320;

export function getMaxPinnedPanelWidth(viewportRight = getViewportRightBound()): number {
  const maxByViewport = Math.round(viewportRight - MIN_PINNED_VIEWPORT_GUTTER);
  return Math.max(CUSTOM_PANEL_WIDTH_MIN, Math.min(CUSTOM_PANEL_WIDTH_MAX, maxByViewport));
}

function getCustomPanelWidth(): number | null {
  if (state.settings?.customPanelWidthEnabled !== true) {
    return null;
  }
  const custom = Number(state.settings?.customPanelWidth);
  if (Number.isFinite(custom) && custom >= CUSTOM_PANEL_WIDTH_MIN && custom <= CUSTOM_PANEL_WIDTH_MAX) {
    return Math.round(custom);
  }
  return null;
}

const PLAYER_GAP = 12;
const PINNED_MIN_HEIGHT = 240;
export const PINNED_VIEWPORT_MIN_WIDTH = 1000;
const REANCHOR_INTERVAL_MS = 2000;

function isYoutubeSite(): boolean {
  return state.clip.site === "youtube" || detectActiveSite() === "youtube";
}

function canPinInViewport(viewportWidth = window.innerWidth): boolean {
  return viewportWidth >= PINNED_VIEWPORT_MIN_WIDTH;
}

const SCRIPT_VAR_PREFIX = "--biliscript-script-";
const SCRIPT_VARS = ["left", "top", "width", "height"] as const;
const FLOAT_ATTR = "data-biliscript-script-float";
const FLOAT_WIDTH_VAR = "--biliscript-script-float-width";
const SCROLLING_ATTR = "data-biliscript-script-scrolling";
const SCROLL_IDLE_TIMEOUT_MS = 150;
const YOUTUBE_FLEXY_OBSERVED_ATTRS = [
  "theater",
  "full-bleed-player",
  "fullscreen",
  "is-two-columns_",
  "class",
  "style"
];

let hostScope: DisposableContext | null = null;
let resizeObserver: ResizeObserver | null = null;
let observedAnchor: Element | null = null;
let observedYoutubePlayer: Element | null = null;
let observedYoutubeFlexy: Element | null = null;
let youtubeFlexyObserver: MutationObserver | null = null;
let layoutRafId = 0;
let scrollIdleTimer = 0;
let lastSnapshot: { floating: boolean; values: string[]; floatWidth?: string } | null = null;

let anchorWaitTimer = 0;

export function hasScriptAnchor(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isYoutubeSite()) {
    return Boolean(findScriptAnchor());
  }
  return Boolean(findScriptAnchor() || getPlayerRect());
}

export function waitForScriptAnchor(timeoutMs = 2000): Promise<boolean> {
  if (typeof window === "undefined" || !canPinInViewport()) {
    return Promise.resolve(true);
  }
  if (isYoutubeSite()) {
    const initial = findYoutubeScriptAnchor(document, window.innerWidth);
    if (initial.reason !== "missing") {
      return Promise.resolve(initial.reason === "ok");
    }
  }
  if (hasScriptAnchor()) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    const start = Date.now();
    if (anchorWaitTimer) {
      window.clearInterval(anchorWaitTimer);
    }
    anchorWaitTimer = window.setInterval(() => {
      if (isYoutubeSite()) {
        const result = findYoutubeScriptAnchor(document, window.innerWidth);
        if (result.reason !== "missing" || Date.now() - start >= timeoutMs) {
          if (anchorWaitTimer) {
            window.clearInterval(anchorWaitTimer);
            anchorWaitTimer = 0;
          }
          resolve(result.reason === "ok");
        }
        return;
      }
      if (hasScriptAnchor() || Date.now() - start >= timeoutMs) {
        if (anchorWaitTimer) {
          window.clearInterval(anchorWaitTimer);
          anchorWaitTimer = 0;
        }
        resolve(hasScriptAnchor());
      }
    }, 50);
  });
}

export function openScriptHost(): void {
  if (isReaderDetached()) {
    return;
  }
  if (hostScope && !hostScope.isDisposed()) {
    return;
  }
  const scope = createDisposableContext();
  hostScope = scope;
  applyScriptRect();
  bindScriptHostListeners(scope);
  bindPanelResizeHandle(scope, {
    getMaxWidth: () => getMaxPinnedPanelWidth(),
    getSnapWidth: () => getDefaultPinnedPanelWidth(),
    applyLayout: () => applyScriptRect()
  });
  scope.setInterval(checkReanchor, REANCHOR_INTERVAL_MS);
}

export function relayoutScriptHost(): void {
  if (isReaderDetached()) {
    return;
  }
  scheduleScriptLayout();
}

export function closeScriptHost(): void {
  if (anchorWaitTimer) {
    window.clearInterval(anchorWaitTimer);
    anchorWaitTimer = 0;
  }
  hostScope?.dispose();
  hostScope = null;
  resizeObserver = null;
  observedAnchor = null;
  observedYoutubePlayer = null;
  observedYoutubeFlexy = null;
  youtubeFlexyObserver = null;
  layoutRafId = 0;
  scrollIdleTimer = 0;
  endScriptScroll();
  lastSnapshot = null;
  const readingView = activeById(ids.readingView) ?? getOpenerDocument().getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  for (const name of SCRIPT_VARS) {
    readingView.style.removeProperty(SCRIPT_VAR_PREFIX + name);
  }
  readingView.style.removeProperty(FLOAT_WIDTH_VAR);
  readingView.removeAttribute(FLOAT_ATTR);
}

function bindYoutubeWatchFlexyObserver(scope: DisposableContext): void {
  if (typeof MutationObserver === "undefined") {
    return;
  }
  const flexy = getYoutubeWatchFlexy(document);
  if (!flexy) {
    return;
  }
  if (flexy === observedYoutubeFlexy && youtubeFlexyObserver) {
    return;
  }
  if (!youtubeFlexyObserver) {
    youtubeFlexyObserver = new MutationObserver(() => {
      scheduleScriptLayout();
    });
    scope.track(youtubeFlexyObserver);
  } else {
    youtubeFlexyObserver.disconnect();
  }
  observedYoutubeFlexy = flexy;
  youtubeFlexyObserver.observe(flexy, {
    attributes: true,
    attributeFilter: YOUTUBE_FLEXY_OBSERVED_ATTRS
  });
}

function bindScriptHostListeners(scope: DisposableContext): void {
  const youtubeSite = isYoutubeSite();
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (resizeObserver !== observer) {
        return;
      }
      scheduleScriptLayout();
    });
    resizeObserver = observer;
    scope.track(observer);
    if (observedAnchor) {
      resizeObserver.observe(observedAnchor);
    }
    if (youtubeSite) {
      syncYoutubePlayerObservation(findYoutubePlayerHost(document));
    }
  }
  if (youtubeSite) {
    bindYoutubeWatchFlexyObserver(scope);
  }
  scope.addListener(window, "resize", requestScriptLayout);
  scope.addListener(window, "scroll", onScriptScroll, { passive: true });
  scope.addListener(document, "scrollend", endScriptScroll);
}

function requestScriptLayout(): void {
  scheduleScriptLayout();
}

function onScriptScroll(): void {
  markScriptScrolling();
  requestScriptLayout();
}

function markScriptScrolling(): void {
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }
  if (readingView.getAttribute(SCROLLING_ATTR) !== "1") {
    readingView.setAttribute(SCROLLING_ATTR, "1");
  }
  if (scrollIdleTimer) {
    if (hostScope) {
      hostScope.clearTimeout(scrollIdleTimer);
    } else {
      window.clearTimeout(scrollIdleTimer);
    }
  }
  scrollIdleTimer = hostScope
    ? hostScope.setTimeout(endScriptScroll, SCROLL_IDLE_TIMEOUT_MS)
    : window.setTimeout(endScriptScroll, SCROLL_IDLE_TIMEOUT_MS);
}

function endScriptScroll(): void {
  if (scrollIdleTimer) {
    if (hostScope) {
      hostScope.clearTimeout(scrollIdleTimer);
    } else {
      window.clearTimeout(scrollIdleTimer);
    }
    scrollIdleTimer = 0;
  }
  (activeById(ids.readingView) ?? getOpenerDocument().getElementById(ids.readingView))?.removeAttribute(
    SCROLLING_ATTR
  );
}

function scheduleScriptLayout(finding?: AnchorFinding): void {
  if (isReaderDetached()) {
    return;
  }
  if (layoutRafId) {
    return;
  }
  let finished = false;
  const run = () => {
    finished = true;
    runScriptLayout(finding);
  };
  const rafId = hostScope
    ? hostScope.requestAnimationFrame(run)
    : window.requestAnimationFrame(run);
  layoutRafId = finished ? 0 : rafId;
}

function runScriptLayout(finding?: AnchorFinding): void {
  layoutRafId = 0;
  if (isReaderDetached() || !document.getElementById(ids.readingView)) {
    return;
  }
  applyScriptRect(finding);
}

function checkReanchor(): void {
  if (!hostScope || hostScope.isDisposed()) {
    return;
  }
  if (isYoutubeSite()) {
    bindYoutubeWatchFlexyObserver(hostScope);
  }
  scheduleScriptLayout(findScriptAnchor() ?? undefined);
}

type AnchorFinding = { anchor: Element; rect: DOMRect } | null;

function findScriptAnchor(): AnchorFinding {
  if (isYoutubeSite()) {
    const found = findYoutubeScriptAnchor(document, window.innerWidth);
    if (found.anchor && found.rect) {
      return { anchor: found.anchor, rect: found.rect };
    }
    return null;
  }
  for (const selector of ANCHOR_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) {
      continue;
    }
    const rect = candidate.getBoundingClientRect();
    if (rect.width >= ANCHOR_MIN_WIDTH && rect.right <= window.innerWidth) {
      return { anchor: candidate, rect };
    }
  }
  return null;
}

function syncYoutubePlayerObservation(player: Element | null): void {
  if (player === observedYoutubePlayer) {
    return;
  }
  if (resizeObserver && observedYoutubePlayer) {
    resizeObserver.unobserve(observedYoutubePlayer);
  }
  observedYoutubePlayer = player;
  if (resizeObserver && player) {
    resizeObserver.observe(player);
  }
}

function observeScriptAnchor(anchor: Element | null): void {
  if (resizeObserver && observedAnchor) {
    resizeObserver.unobserve(observedAnchor);
  }
  observedAnchor = anchor;
  if (resizeObserver && anchor) {
    resizeObserver.observe(anchor);
  }
}

function applyScriptRect(finding?: AnchorFinding): void {
  if (isReaderDetached()) {
    return;
  }
  const readingView = document.getElementById(ids.readingView);
  if (!readingView) {
    return;
  }

  const youtubeSite = isYoutubeSite();
  if (youtubeSite) {
    syncYoutubePlayerObservation(findYoutubePlayerHost(document));
  } else if (observedYoutubePlayer) {
    syncYoutubePlayerObservation(null);
  }

  const found = finding ?? findScriptAnchor();
  const anchor = found?.anchor ?? null;
  if (anchor !== observedAnchor) {
    observeScriptAnchor(anchor);
  }

  const anchorRect = found?.rect;
  const canPin = canPinInViewport();
  if (anchorRect && canPin) {
    const rect = clampAnchorRect(anchorRect);
    applyPinnedRect(readingView, rect);
    return;
  }

  if (canPin && !youtubeSite) {
    const playerRect = getPlayerRect();
    if (playerRect) {
      const right = getViewportRightBound();
      const available = right - (playerRect.right + PLAYER_GAP);
      if (available >= PANEL_MIN_WIDTH) {
        const custom = getCustomPanelWidth();
        const width =
          custom == null ? available : Math.min(custom, getMaxPinnedPanelWidth(right));
        const left = right - width;
        const top = resolvePinnedTop(playerRect.top);
        applyPinnedRect(readingView, {
          left,
          top,
          width,
          height: window.innerHeight - top
        });
        return;
      }
    }
  }

  applyFloating(readingView);
}

function getViewportRightBound(): number {
  return document.documentElement.clientWidth || window.innerWidth;
}

function clampTopIntoViewport(rawTop: number): number {
  return Math.max(
    0,
    Math.min(Math.max(rawTop, 0), window.innerHeight - PINNED_MIN_HEIGHT)
  );
}

function findFestivalHeaderBottom(): number | null {
  if (!isFestivalPage()) {
    return null;
  }
  for (const selector of TOP_HEADER_SELECTORS) {
    const candidate = document.querySelector(selector);
    if (!candidate) {
      continue;
    }
    const rect = candidate.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      return rect.bottom;
    }
  }
  return null;
}

function resolvePinnedTop(rawTop: number): number {
  const headerBottom = findFestivalHeaderBottom();
  const effectiveTop =
    headerBottom === null ? rawTop : Math.min(rawTop, headerBottom + FESTIVAL_HEADER_GAP);
  return clampTopIntoViewport(effectiveTop);
}

function getDefaultPinnedPanelWidth(): number | null {
  if (!canPinInViewport()) {
    return null;
  }
  const right = getViewportRightBound();
  const found = findScriptAnchor();
  if (found?.rect) {
    const left = Math.min(found.rect.left, right - CUSTOM_PANEL_WIDTH_MIN);
    return Math.round(right - left);
  }
  if (!isYoutubeSite()) {
    const playerRect = getPlayerRect();
    if (playerRect) {
      const available = right - (playerRect.right + PLAYER_GAP);
      if (available >= PANEL_MIN_WIDTH) {
        return Math.round(available);
      }
    }
  }
  return null;
}

function clampAnchorRect(rect: DOMRect): { left: number; top: number; width: number; height: number } {
  const right = getViewportRightBound();
  const custom = getCustomPanelWidth();
  const top = resolvePinnedTop(rect.top);
  if (custom != null) {
    const width = Math.min(custom, getMaxPinnedPanelWidth(right));
    return { left: right - width, top, width, height: window.innerHeight - top };
  }
  const left = Math.min(rect.left, right - CUSTOM_PANEL_WIDTH_MIN);
  return { left, top, width: right - left, height: window.innerHeight - top };
}

function getPlayerRect(): DOMRect | null {
  const video = document.querySelector("video");
  const host = findReaderPlayerHost(video);
  if (!host) {
    return null;
  }
  const rect = host.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return rect;
}

function applyPinnedRect(
  readingView: HTMLElement,
  rect: { left: number; top: number; width: number; height: number }
): void {
  const values = [
    `${Math.round(rect.left)}px`,
    `${Math.round(rect.top)}px`,
    `${Math.round(rect.width)}px`,
    `${Math.round(rect.height)}px`
  ];
  if (lastSnapshot && !lastSnapshot.floating && lastSnapshot.values.join() === values.join()) {
    return;
  }
  lastSnapshot = { floating: false, values };
  readingView.removeAttribute(FLOAT_ATTR);
  readingView.style.removeProperty(FLOAT_WIDTH_VAR);
  SCRIPT_VARS.forEach((name, index) => {
    readingView.style.setProperty(SCRIPT_VAR_PREFIX + name, values[index]);
  });
}

function applyFloating(readingView: HTMLElement): void {
  const custom = getCustomPanelWidth();
  const floatWidth = custom == null ? "" : `${custom}px`;
  if (lastSnapshot?.floating && lastSnapshot.floatWidth === floatWidth) {
    return;
  }
  lastSnapshot = { floating: true, values: [], floatWidth };
  for (const name of SCRIPT_VARS) {
    readingView.style.removeProperty(SCRIPT_VAR_PREFIX + name);
  }
  if (floatWidth) {
    readingView.style.setProperty(FLOAT_WIDTH_VAR, floatWidth);
  } else {
    readingView.style.removeProperty(FLOAT_WIDTH_VAR);
  }
  readingView.setAttribute(FLOAT_ATTR, "1");
}
