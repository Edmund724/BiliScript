import {
  applyControlBarPlacement,
  isControlBarItemMounted,
  resolveControlBarPlacement,
  type ControlBarPlacement
} from "../bilibili/player-control-mount.js";
import type { LiveChatState } from "./live-chat-controller.js";

export const PLAYER_LIVE_TOGGLE_THROTTLE_MS = 250;

export function resolveLiveToggleLabel(liveState: LiveChatState | string): string {
  if (liveState === "connecting") return "正在连接伴看，点击取消";
  if (liveState === "connected") return "实时伴看 (已开启)";
  return "实时伴看";
}

export interface SyncPlayerLiveToggleButtonOptions {
  button: HTMLElement | null;
  wrap?: HTMLElement | null;
  active: boolean;
  label?: string;
  setDataTooltip?: boolean;
  setTitle?: boolean;
}

export function syncPlayerLiveToggleButton({
  button,
  wrap,
  active,
  label = active ? "实时伴看 (已开启)" : "实时伴看",
  setDataTooltip = false,
  setTitle = true
}: SyncPlayerLiveToggleButtonOptions): void {
  const pressed = String(active);
  if (button) {
    if (button.classList.contains("is-active") !== active) {
      button.classList.toggle("is-active", active);
    }
    if (button.getAttribute("aria-pressed") !== pressed) {
      button.setAttribute("aria-pressed", pressed);
    }
    if (button.getAttribute("aria-label") !== label) {
      button.setAttribute("aria-label", label);
    }
    if (setDataTooltip && button.getAttribute("data-tooltip") !== label) {
      button.setAttribute("data-tooltip", label);
    }
    if (setTitle && button.title !== label) {
      button.title = label;
    } else if (!setTitle && button.hasAttribute("title") && button.title !== label) {
      button.title = label;
    }
  }
  if (wrap && wrap.classList.contains("is-active") !== active) {
    wrap.classList.toggle("is-active", active);
  }
}

export function createThrottledLiveToggleHandler(
  onToggle: () => unknown,
  throttleMs = PLAYER_LIVE_TOGGLE_THROTTLE_MS
): { handleClick(): Promise<void>; reset(): void } {
  let lastClickAt = -throttleMs;
  return {
    async handleClick() {
      const now = Date.now();
      if (now - lastClickAt < throttleMs) return;
      lastClickAt = now;
      await onToggle();
    },
    reset() {
      lastClickAt = -throttleMs;
    }
  };
}

export interface ControlBarLiveTogglePlacementOptions {
  fallbackToHost?: boolean;
  preferLiveRoomExtNodes?: boolean;
}

export function mountControlBarLiveToggle(
  node: HTMLElement,
  host: HTMLElement,
  options: ControlBarLiveTogglePlacementOptions = {}
): ControlBarPlacement | null {
  const placement = resolveControlBarPlacement({ host, ...options });
  if (!placement) {
    node.remove();
    return null;
  }
  applyControlBarPlacement(node, placement);
  return placement;
}

export function isControlBarLiveToggleMounted(
  node: HTMLElement,
  host: HTMLElement,
  options: ControlBarLiveTogglePlacementOptions = {}
): boolean {
  const placement = resolveControlBarPlacement({ host, ...options });
  return isControlBarItemMounted(node, placement);
}

export function syncPlayerLiveQuickActionState(active: boolean): void {
  if (typeof document === "undefined") return;
  document.body.toggleAttribute("data-biliscript-live-active", active);
  const btn = document.getElementById("biliscript-player-live-quick-action");
  const wrap = document.getElementById("biliscript-player-live-quick-action-wrap");
  syncPlayerLiveToggleButton({ button: btn, wrap, active });
}
