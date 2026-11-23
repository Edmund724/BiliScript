const freeze = Object.freeze;
const join = (list: readonly string[]) => list.join(", ");

const BPX = ".bpx-player-container";
const BILI_PLAYER = "#bilibili-player";
const CTRL_WRAP = ".bpx-player-control-wrap";
const VIDEO_AREA = ".bpx-player-video-area";
const PLAYER_WRAP = ".player-wrap";
const PLAYER_WRAP_ID = "#playerWrap";

export const BILI_HOST_SELECTORS = freeze({
  playerPrimary: freeze([BPX, BILI_PLAYER] as const),
  playerContainers: freeze([BPX, BILI_PLAYER, PLAYER_WRAP, PLAYER_WRAP_ID] as const),
  playerContainersWithVideoArea: freeze([BPX, VIDEO_AREA, BILI_PLAYER, PLAYER_WRAP_ID, PLAYER_WRAP] as const),
  playerVideoHosts: freeze([BPX, VIDEO_AREA, BILI_PLAYER] as const),
  liveRoomPlayers: freeze(["#live-player", ".live-player-mounter", "#live-player-ctnr"] as const),
  liveRoomVideos: freeze(["#live-player video", ".live-player-mounter video", "video"] as const),
  playerControlContainers: freeze([".bpx-player-control-bottom-right", CTRL_WRAP] as const),
  playerControlBars: freeze([CTRL_WRAP, ".bpx-player-control-entity", ".bpx-player-control-bottom"] as const),
  playerSubtitleControlRoots: freeze([
    `${BILI_PLAYER} ${CTRL_WRAP}`,
    `${PLAYER_WRAP_ID} ${CTRL_WRAP}`,
    `${BPX} ${CTRL_WRAP}`,
    BILI_PLAYER,
    PLAYER_WRAP_ID,
    BPX,
    PLAYER_WRAP
  ] as const),
  playerWebFullscreen: freeze([
    `${BPX}[data-screen="web"]`,
    `${BPX}.bpx-state-web-fullscreen`
  ] as const),
  playerWebFullscreenToggle: freeze([".bpx-player-ctrl-web", ".squirtle-video-pagefullscreen"] as const),
  playerIframes: freeze([
    `${BILI_PLAYER} iframe`,
    `${BPX} iframe`,
    "iframe[src*='player.bilibili.com']",
    "iframe[src*='bilibili.com/player']"
  ] as const),
  toolbarHosts: freeze(["#arc_toolbar_report", ".video-toolbar-container", ".video-toolbar-content"] as const),
  topHeaderBars: freeze([".bili-header__bar", ".bili-header", "#biliMainHeader"] as const),
  rightColumnAnchors: freeze([
    ".right-container-inner",
    ".right-container",
    ".playlist-container--right",
    "#reco_list",
    "#viewbox_report",
    ".up-info-container",
    ".grid-right",
    ".video-sections"
  ] as const),
  videoTitles: freeze(["h1.video-title", ".video-toobar_title", ".video-toolbar_title"] as const),
  debugSnapshotNodes: freeze([
    "#app",
    PLAYER_WRAP_ID,
    PLAYER_WRAP,
    BILI_PLAYER,
    BPX,
    VIDEO_AREA,
    ".bpx-player-primary-area"
  ] as const),
  playerBpxContainer: BPX,
  playerVideoArea: VIDEO_AREA,
  playerVideoWrap: ".bpx-player-video-wrap",
  playerControlWrap: CTRL_WRAP,
  playerControlBottomRight: ".bpx-player-control-bottom-right",
  playerQualityControl: ".bpx-player-ctrl-quality",
  playerVolumeControl: ".bpx-player-ctrl-volume",
  liveRoomExtNodes: ".live-web-player-controller .right-area .ext-nodes"
} as const);

export const PLAYER_PRIMARY_SELECTOR = join(BILI_HOST_SELECTORS.playerPrimary);
export const VIDEO_PLAYER_CONTAINER_SELECTOR = join(BILI_HOST_SELECTORS.playerContainers);
export const PLAYER_VIDEO_HOST_MATCH_SELECTOR = join(BILI_HOST_SELECTORS.playerVideoHosts);
export const LIVE_ROOM_PLAYER_HOST_SELECTOR = join(BILI_HOST_SELECTORS.liveRoomPlayers);
export const LIVE_ROOM_VIDEO_SELECTOR = join(BILI_HOST_SELECTORS.liveRoomVideos);
export const ANY_PLAYER_HOST_SELECTOR = join([
  ...BILI_HOST_SELECTORS.playerContainers,
  ...BILI_HOST_SELECTORS.liveRoomPlayers
]);
export const PLAYBACK_RATE_CONTAINER_SELECTOR = join([
  ...BILI_HOST_SELECTORS.playerPrimary,
  BILI_HOST_SELECTORS.playerControlWrap,
  BILI_HOST_SELECTORS.playerControlBottomRight
]);
export const PLAYER_CONTROL_BAR_SELECTOR = join(BILI_HOST_SELECTORS.playerControlBars);
export const PLAYER_SUBTITLE_CONTROL_ROOTS_SELECTOR = join(BILI_HOST_SELECTORS.playerSubtitleControlRoots);
export const PLAYER_WEB_FULLSCREEN_SELECTOR = join(BILI_HOST_SELECTORS.playerWebFullscreen);
export const PLAYER_WEB_FULLSCREEN_TOGGLE_SELECTOR = join(BILI_HOST_SELECTORS.playerWebFullscreenToggle);
export const TOOLBAR_HOST_SELECTOR = join(BILI_HOST_SELECTORS.toolbarHosts);

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
