// extension/bilibili/player-control-mount.ts
// B 站播放器控制栏锚点解析、幂等挂载与两段式局部容器 MutationObserver 原语。

import {
  BILI_HOST_SELECTORS,
  PLAYER_PRIMARY_SELECTOR,
  biliHostAdapter,
  querySelectorFallback,
  type HostObserverHandle
} from "./host-adapter.js";

export const DEFAULT_PLAYER_CONTAINER_SELECTOR = PLAYER_PRIMARY_SELECTOR;

const LIVE_ROOM_EXT_NODES_SELECTOR = BILI_HOST_SELECTORS.liveRoomExtNodes;
const QUALITY_LABEL_PATTERN = /清晰度|4K|1080P|720P|480P|360P|超清|高清|高码率/i;

export type ControlBarPlacement =
  | { kind: "before"; parent: HTMLElement; reference: Element }
  | { kind: "prepend"; parent: HTMLElement }
  | { kind: "append"; parent: HTMLElement };

export interface ResolveControlBarPlacementOptions {
  host?: ParentNode | null;
  /** 优先匹配直播间现行控制栏扩展区 `.live-web-player-controller .right-area .ext-nodes` */
  preferLiveRoomExtNodes?: boolean;
  /** 控制栏右侧与清晰度控件均未就绪时，是否回退挂载到 host 根节点末尾 */
  fallbackToHost?: boolean;
  /** 是否允许回退到 document 级查找 `.bpx-player-control-bottom-right`（默认 true） */
  allowDocumentFallback?: boolean;
}

export interface ObservePlayerContainerOptions {
  /** 优先观察的局部播放器容器选择器（默认 `.bpx-player-container, #bilibili-player`） */
  containerSelector?: string | readonly string[];
  /** 局部容器的 MutationObserver 配置（默认 `{ childList: true, subtree: true }`） */
  containerObserveOptions?: MutationObserverInit;
  /** 容器内发生变更（或由 body 回退观察首次发现容器）时的回调 */
  onMutations: (records: MutationRecord[]) => void;
  /** 当前活跃的 MutationObserver 实例切换（含启动、由 body 切局部容器、disconnect）时同步给外部状态槽位 */
  onObserverChange?: (observer: MutationObserver | null) => void;
  /** 可选 AbortSignal，中止时自动退订 */
  signal?: AbortSignal;
}

export type PlayerContainerObserverHandle = HostObserverHandle;

export function findControlBottomRightNode(
  host?: ParentNode | null,
  allowDocumentFallback = true
): HTMLElement | null {
  const fromHost = querySelectorFallback<HTMLElement>(
    BILI_HOST_SELECTORS.playerControlContainers,
    host ?? null
  );
  if (fromHost) {
    return fromHost;
  }
  if (!allowDocumentFallback) {
    return null;
  }
  return querySelectorFallback<HTMLElement>(BILI_HOST_SELECTORS.playerControlContainers, document);
}

export function findQualityControlNode(
  host?: ParentNode | null,
  allowDocumentFallback = true
): Element | null {
  const controlRoots = [
    host?.querySelector(BILI_HOST_SELECTORS.playerControlBottomRight) ?? null,
    host?.querySelector(BILI_HOST_SELECTORS.playerControlWrap) ?? null,
    ...(allowDocumentFallback
      ? [
          document.querySelector(BILI_HOST_SELECTORS.playerControlBottomRight),
          document.querySelector(BILI_HOST_SELECTORS.playerControlWrap)
        ]
      : [])
  ].filter((node): node is Element => Boolean(node));

  for (const root of controlRoots) {
    const direct = root.querySelector(BILI_HOST_SELECTORS.playerQualityControl);
    if (direct) {
      return direct;
    }
    const candidates = Array.from(root.querySelectorAll(".bpx-player-ctrl-btn, button, [role='button']"));
    for (const child of candidates) {
      const text = [
        child.getAttribute("aria-label"),
        child.getAttribute("title"),
        child.getAttribute("data-text"),
        child.textContent,
        typeof child.className === "string" ? child.className : ""
      ].join(" ");
      if (QUALITY_LABEL_PATTERN.test(text)) {
        return child;
      }
    }
  }
  return null;
}

export function resolveControlBarPlacement(
  options: ResolveControlBarPlacementOptions = {}
): ControlBarPlacement | null {
  const {
    host = null,
    preferLiveRoomExtNodes = false,
    fallbackToHost = false,
    allowDocumentFallback = true
  } = options;

  if (preferLiveRoomExtNodes && host) {
    const modernControls = host.querySelector<HTMLElement>(LIVE_ROOM_EXT_NODES_SELECTOR);
    if (modernControls) {
      return { kind: "prepend", parent: modernControls };
    }
  }

  const qualityNode = findQualityControlNode(host, allowDocumentFallback);
  if (qualityNode && qualityNode.parentElement instanceof HTMLElement) {
    return {
      kind: "before",
      parent: qualityNode.parentElement,
      reference: qualityNode
    };
  }

  const bottomRight = findControlBottomRightNode(host, allowDocumentFallback);
  if (bottomRight) {
    return { kind: "prepend", parent: bottomRight };
  }

  if (fallbackToHost && host instanceof HTMLElement) {
    return { kind: "append", parent: host };
  }

  return null;
}

export function isControlBarItemMounted(
  node: Element | null | undefined,
  placement: ControlBarPlacement | null
): boolean {
  if (!node || !node.isConnected || !placement) {
    return false;
  }
  switch (placement.kind) {
    case "before":
      return node.parentElement === placement.parent && node.nextElementSibling === placement.reference;
    case "prepend":
    case "append":
      return node.parentElement === placement.parent;
  }
}

export function applyControlBarPlacement(node: Node, placement: ControlBarPlacement): boolean {
  switch (placement.kind) {
    case "before":
      if (node.parentElement !== placement.parent || node.nextSibling !== placement.reference) {
        placement.parent.insertBefore(node, placement.reference);
        return true;
      }
      return false;
    case "prepend":
      if (node.parentElement !== placement.parent || placement.parent.firstElementChild !== node) {
        placement.parent.insertBefore(node, placement.parent.firstElementChild);
        return true;
      }
      return false;
    case "append":
      if (node.parentElement !== placement.parent) {
        placement.parent.appendChild(node);
        return true;
      }
      return false;
  }
}

/**
 * 两段式播放器容器观察原语（委托 BiliHostAdapter 共享 MutationObserver 调度器）：
 * 1. 若目标播放器容器已在 DOM 中，直接观察该局部容器子树（同容器多方共享单 observer）；
 * 2. 若容器尚未水合，先共用单一 `document.body` 回退观察，发现容器立即收敛到局部容器；
 * 3. 若局部容器在 SPA 换房/换片时被整棵替换脱离文档，自动回退观察并在新容器出现时重绑。
 */
export function observePlayerContainer(
  options: ObservePlayerContainerOptions
): PlayerContainerObserverHandle {
  return biliHostAdapter.observeContainer({
    containerSelector: options.containerSelector ?? DEFAULT_PLAYER_CONTAINER_SELECTOR,
    containerObserveOptions: options.containerObserveOptions,
    onMutations: options.onMutations,
    onObserverChange: options.onObserverChange,
    signal: options.signal
  });
}
