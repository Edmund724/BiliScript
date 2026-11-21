export const BILI_HOST_SELECTORS = Object.freeze({
  playerPrimary: Object.freeze([".bpx-player-container", "#bilibili-player"] as const),
  playerContainers: Object.freeze([
    ".bpx-player-container",
    "#bilibili-player",
    ".player-wrap",
    "#playerWrap"
  ] as const),
  playerContainersWithVideoArea: Object.freeze([
    ".bpx-player-container",
    ".bpx-player-video-area",
    "#bilibili-player",
    "#playerWrap",
    ".player-wrap"
  ] as const),
  playerVideoHosts: Object.freeze([
    ".bpx-player-container",
    ".bpx-player-video-area",
    "#bilibili-player"
  ] as const),
  liveRoomPlayers: Object.freeze([
    "#live-player",
    ".live-player-mounter",
    "#live-player-ctnr"
  ] as const),
  liveRoomVideos: Object.freeze([
    "#live-player video",
    ".live-player-mounter video",
    "video"
  ] as const),
  playerControlContainers: Object.freeze([
    ".bpx-player-control-bottom-right",
    ".bpx-player-control-wrap"
  ] as const),
  playerControlBars: Object.freeze([
    ".bpx-player-control-wrap",
    ".bpx-player-control-entity",
    ".bpx-player-control-bottom"
  ] as const),
  playerSubtitleControlRoots: Object.freeze([
    "#bilibili-player .bpx-player-control-wrap",
    "#playerWrap .bpx-player-control-wrap",
    ".bpx-player-container .bpx-player-control-wrap",
    "#bilibili-player",
    "#playerWrap",
    ".bpx-player-container",
    ".player-wrap"
  ] as const),
  playerWebFullscreen: Object.freeze([
    '.bpx-player-container[data-screen="web"]',
    ".bpx-player-container.bpx-state-web-fullscreen"
  ] as const),
  playerWebFullscreenToggle: Object.freeze([
    ".bpx-player-ctrl-web",
    ".squirtle-video-pagefullscreen"
  ] as const),
  playerIframes: Object.freeze([
    "#bilibili-player iframe",
    ".bpx-player-container iframe",
    "iframe[src*='player.bilibili.com']",
    "iframe[src*='bilibili.com/player']"
  ] as const),
  toolbarHosts: Object.freeze([
    "#arc_toolbar_report",
    ".video-toolbar-container"
  ] as const),
  rightColumnAnchors: Object.freeze([
    ".right-container-inner",
    ".right-container",
    ".playlist-container--right",
    "#reco_list",
    "#viewbox_report",
    ".up-info-container"
  ] as const),
  debugSnapshotNodes: Object.freeze([
    "#app",
    "#playerWrap",
    ".player-wrap",
    "#bilibili-player",
    ".bpx-player-container",
    ".bpx-player-video-area",
    ".bpx-player-primary-area"
  ] as const),
  playerBpxContainer: ".bpx-player-container",
  playerVideoArea: ".bpx-player-video-area",
  playerVideoWrap: ".bpx-player-video-wrap",
  playerControlWrap: ".bpx-player-control-wrap",
  playerControlBottomRight: ".bpx-player-control-bottom-right",
  playerQualityControl: ".bpx-player-ctrl-quality",
  playerVolumeControl: ".bpx-player-ctrl-volume",
  liveRoomExtNodes: ".live-web-player-controller .right-area .ext-nodes"
} as const);

export const PLAYER_PRIMARY_SELECTOR = BILI_HOST_SELECTORS.playerPrimary.join(", ");
export const VIDEO_PLAYER_CONTAINER_SELECTOR = BILI_HOST_SELECTORS.playerContainers.join(", ");
export const PLAYER_VIDEO_HOST_MATCH_SELECTOR = BILI_HOST_SELECTORS.playerVideoHosts.join(", ");
export const LIVE_ROOM_PLAYER_HOST_SELECTOR = BILI_HOST_SELECTORS.liveRoomPlayers.join(", ");
export const LIVE_ROOM_VIDEO_SELECTOR = BILI_HOST_SELECTORS.liveRoomVideos.join(", ");
export const ANY_PLAYER_HOST_SELECTOR = [
  ...BILI_HOST_SELECTORS.playerContainers,
  ...BILI_HOST_SELECTORS.liveRoomPlayers
].join(", ");
export const PLAYBACK_RATE_CONTAINER_SELECTOR = [
  ...BILI_HOST_SELECTORS.playerPrimary,
  BILI_HOST_SELECTORS.playerControlWrap,
  BILI_HOST_SELECTORS.playerControlBottomRight
].join(", ");
export const PLAYER_CONTROL_BAR_SELECTOR = BILI_HOST_SELECTORS.playerControlBars.join(", ");
export const PLAYER_SUBTITLE_CONTROL_ROOTS_SELECTOR =
  BILI_HOST_SELECTORS.playerSubtitleControlRoots.join(", ");
export const PLAYER_WEB_FULLSCREEN_SELECTOR = BILI_HOST_SELECTORS.playerWebFullscreen.join(", ");
export const PLAYER_WEB_FULLSCREEN_TOGGLE_SELECTOR =
  BILI_HOST_SELECTORS.playerWebFullscreenToggle.join(", ");
export const TOOLBAR_HOST_SELECTOR = BILI_HOST_SELECTORS.toolbarHosts.join(", ");

export type QuerySelectorRoot = {
  querySelector(selectors: string): Element | null;
};

export function querySelectorFallback<T extends Element = HTMLElement>(
  selectors: readonly string[],
  root: QuerySelectorRoot | null = typeof document !== "undefined" ? document : null,
  predicate?: (element: T) => boolean
): T | null {
  if (!root) {
    return null;
  }
  for (const selector of selectors) {
    const candidate = root.querySelector(selector) as T | null;
    if (candidate && (!predicate || predicate(candidate))) {
      return candidate;
    }
  }
  return null;
}

export function closestFallback<T extends Element = HTMLElement>(
  element: Element | null | undefined,
  selectors: readonly string[]
): T | null {
  if (!element) {
    return null;
  }
  for (const selector of selectors) {
    const matched = element.closest<T>(selector);
    if (matched) {
      return matched;
    }
  }
  return null;
}

export function findVideoPlayerContainer(
  root: ParentNode | null = typeof document !== "undefined" ? document : null,
  predicate?: (element: HTMLElement) => boolean
): HTMLElement | null {
  return querySelectorFallback<HTMLElement>(BILI_HOST_SELECTORS.playerContainers, root, predicate);
}

export function findPlayerHostWithVideoArea(
  root: ParentNode | null = typeof document !== "undefined" ? document : null,
  predicate?: (element: HTMLElement) => boolean
): HTMLElement | null {
  return querySelectorFallback<HTMLElement>(
    BILI_HOST_SELECTORS.playerContainersWithVideoArea,
    root,
    predicate
  );
}

export function findPlayerHostFromVideo(
  video: Element | null | undefined,
  options: { includeWrapFallbacks?: boolean } = {}
): Element | null {
  if (!video) {
    return null;
  }
  const chain = options.includeWrapFallbacks
    ? BILI_HOST_SELECTORS.playerContainersWithVideoArea
    : BILI_HOST_SELECTORS.playerVideoHosts;
  return closestFallback<Element>(video, chain) || video.parentElement;
}

export function findLiveRoomPlayerHost(
  root: ParentNode | null = typeof document !== "undefined" ? document : null
): HTMLElement | null {
  return querySelectorFallback<HTMLElement>(BILI_HOST_SELECTORS.liveRoomPlayers, root);
}

export function findAnyPlayerHost(
  root: ParentNode | null = typeof document !== "undefined" ? document : null
): HTMLElement | null {
  return (
    findVideoPlayerContainer(root) ||
    findLiveRoomPlayerHost(root)
  );
}

export function resolveBpxPlayerContainer(
  base: HTMLElement | null | undefined,
  options: { checkClosest?: boolean } = {}
): HTMLElement | null {
  if (!base) {
    return null;
  }
  if (base.matches?.(BILI_HOST_SELECTORS.playerBpxContainer)) {
    return base;
  }
  const inner = base.querySelector<HTMLElement>(BILI_HOST_SELECTORS.playerBpxContainer);
  if (inner) {
    return inner;
  }
  if (options.checkClosest) {
    const ancestor = base.closest<HTMLElement>(BILI_HOST_SELECTORS.playerBpxContainer);
    if (ancestor) {
      return ancestor;
    }
  }
  return base;
}

export function isPlayerHostElement(host: Element | null | undefined): boolean {
  if (!host) {
    return false;
  }
  return Boolean(
    host.matches?.(PLAYER_VIDEO_HOST_MATCH_SELECTOR) ||
      host.querySelector?.(BILI_HOST_SELECTORS.playerVideoArea)
  );
}
