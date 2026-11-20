// extension/bilibili/host-selectors.ts
// B 站页面宿主 DOM 选择器单一事实源与降级查找纯函数。
//
// 本模块零可变状态、无副作用，可被常驻包（bilibili/video-probe）与懒加载区共用。

export const BILI_HOST_SELECTORS = Object.freeze({
  /** 优先播放器容器（视频播放页核心容器） */
  playerPrimary: Object.freeze([".bpx-player-container", "#bilibili-player"] as const),
  /** 视频播放器容器完整降级链 */
  playerContainers: Object.freeze([
    ".bpx-player-container",
    "#bilibili-player",
    ".player-wrap",
    "#playerWrap"
  ] as const),
  /** 播放器容器含 video-area 的降级链（快捷操作与视频探针用） */
  playerContainersWithVideoArea: Object.freeze([
    ".bpx-player-container",
    ".bpx-player-video-area",
    "#bilibili-player",
    "#playerWrap",
    ".player-wrap"
  ] as const),
  /** 视频探针识别播放器内 <video> 的宿主祖先链 */
  playerVideoHosts: Object.freeze([
    ".bpx-player-container",
    ".bpx-player-video-area",
    "#bilibili-player"
  ] as const),
  /** 直播间播放器容器降级链 */
  liveRoomPlayers: Object.freeze([
    "#live-player",
    ".live-player-mounter",
    "#live-player-ctnr"
  ] as const),
  /** 直播间视频元素降级链 */
  liveRoomVideos: Object.freeze([
    "#live-player video",
    ".live-player-mounter video",
    "video"
  ] as const),
  /** 播放器控制栏挂载容器降级链 */
  playerControlContainers: Object.freeze([
    ".bpx-player-control-bottom-right",
    ".bpx-player-control-wrap"
  ] as const),
  /** 播放器控制条显隐监控候选 */
  playerControlBars: Object.freeze([
    ".bpx-player-control-wrap",
    ".bpx-player-control-entity",
    ".bpx-player-control-bottom"
  ] as const),
  /** 播放器内字幕控件搜索根 */
  playerSubtitleControlRoots: Object.freeze([
    "#bilibili-player .bpx-player-control-wrap",
    "#playerWrap .bpx-player-control-wrap",
    ".bpx-player-container .bpx-player-control-wrap",
    "#bilibili-player",
    "#playerWrap",
    ".bpx-player-container",
    ".player-wrap"
  ] as const),
  /** 播放器网页全屏态选择器 */
  playerWebFullscreen: Object.freeze([
    '.bpx-player-container[data-screen="web"]',
    ".bpx-player-container.bpx-state-web-fullscreen"
  ] as const),
  /** 播放器网页全屏切换按钮 */
  playerWebFullscreenToggle: Object.freeze([
    ".bpx-player-ctrl-web",
    ".squirtle-video-pagefullscreen"
  ] as const),
  /** 播放器内嵌 iframe 降级链 */
  playerIframes: Object.freeze([
    "#bilibili-player iframe",
    ".bpx-player-container iframe",
    "iframe[src*='player.bilibili.com']",
    "iframe[src*='bilibili.com/player']"
  ] as const),
  /** 播放页工具栏宿主（文摘按钮锚点） */
  toolbarHosts: Object.freeze([
    "#arc_toolbar_report",
    ".video-toolbar-container"
  ] as const),
  /** 播放页右栏贴栏定位锚点降级链 */
  rightColumnAnchors: Object.freeze([
    ".right-container-inner",
    ".right-container",
    ".playlist-container--right",
    "#reco_list",
    "#viewbox_report",
    ".up-info-container"
  ] as const),
  /** 调试快照采集的播放器与页面节点清单 */
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

/** 按优先级降级链查找首个匹配且通过谓词的 DOM 元素。 */
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

/** 按优先级降级链沿祖先查找最近的匹配容器。 */
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

/** 按降级链查找视频播放器容器（`.bpx-player-container` → `#bilibili-player` → `.player-wrap` → `#playerWrap`）。 */
export function findVideoPlayerContainer(
  root: ParentNode | null = typeof document !== "undefined" ? document : null,
  predicate?: (element: HTMLElement) => boolean
): HTMLElement | null {
  return querySelectorFallback<HTMLElement>(BILI_HOST_SELECTORS.playerContainers, root, predicate);
}

/** 按降级链查找含 `.bpx-player-video-area` 在内的播放器宿主（供 AI 快捷操作等使用）。 */
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

/** 从 `<video>` 向上解析其所属播放器宿主容器。 */
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

/** 按降级链查找直播间播放器宿主容器。 */
export function findLiveRoomPlayerHost(
  root: ParentNode | null = typeof document !== "undefined" ? document : null
): HTMLElement | null {
  return querySelectorFallback<HTMLElement>(BILI_HOST_SELECTORS.liveRoomPlayers, root);
}

/** 按降级链查找任意播放器宿主容器（视频页 + 直播间）。 */
export function findAnyPlayerHost(
  root: ParentNode | null = typeof document !== "undefined" ? document : null
): HTMLElement | null {
  return (
    findVideoPlayerContainer(root) ||
    findLiveRoomPlayerHost(root)
  );
}

/** 从给定基节点解析 `.bpx-player-container`（自身 → 子树 → 祖先 → 原节点）。 */
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

/** 判断节点是否为 B 站播放器核心宿主或包含 video-area。 */
export function isPlayerHostElement(host: Element | null | undefined): boolean {
  if (!host) {
    return false;
  }
  return Boolean(
    host.matches?.(PLAYER_VIDEO_HOST_MATCH_SELECTOR) ||
      host.querySelector?.(BILI_HOST_SELECTORS.playerVideoArea)
  );
}
