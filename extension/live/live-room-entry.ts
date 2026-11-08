// extension/live/live-room-entry.ts
// 直播间的实时伴看入口：只挂载全屏伴看浮窗与一个开关按钮，不加载文摘面板、字幕与概览。
// 会话身份是房间号，每次进入都是新会话；换房间时先结束旧会话。

import { state } from "../core/state.js";
import { getSettings } from "../core/runtime.js";
import { normalizeLiveVoiceVolume } from "../core/validators.js";
import { ensurePlayerAiStyles } from "../shared/style-injector.js";
import { parseLiveRoomId } from "../bilibili/video-id-shared.js";
import {
  applyControlBarPlacement,
  observePlayerContainer,
  resolveControlBarPlacement,
  type PlayerContainerObserverHandle
} from "../bilibili/player-control-mount.js";
import { createLiveChatController, type LiveChatController } from "./live-chat-controller.js";
import { createLiveOverlayBinding } from "./live-overlay-binding.js";
import { createLiveRoomBridge } from "./live-room-bridge.js";
import { buildPlayerLiveQuickActionIconSvg } from "../ui/icons.js";

const PLAYER_HOST_SELECTOR = "#live-player, .live-player-mounter, #live-player-ctnr";
const VIDEO_SELECTOR = "#live-player video, .live-player-mounter video, video";
const TOGGLE_BUTTON_CLASS = "biliscript-live-room-toggle";
const NOTICE_CLASS = "biliscript-live-room-notice";
const NOTICE_DEFAULT_MS = 4000;

let started = false;
let controller: LiveChatController | null = null;
let toggleButton: HTMLButtonElement | null = null;
let containerObserverHandle: PlayerContainerObserverHandle | null = null;
let currentRoomId = "";

function findPlayerHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PLAYER_HOST_SELECTOR);
}

const overlayBinding = createLiveOverlayBinding({
  getPlayerHost: findPlayerHost,
  getLiveController: () => controller
});

function showNotice(message: string, autoHideMs: number = NOTICE_DEFAULT_MS): void {
  const host = findPlayerHost() || document.body;
  host.querySelector(`.${NOTICE_CLASS}`)?.remove();
  const notice = document.createElement("div");
  notice.className = NOTICE_CLASS;
  notice.setAttribute("data-biliscript-extension-node", "live-room-notice");
  notice.textContent = message;
  host.appendChild(notice);
  window.setTimeout(() => notice.remove(), autoHideMs);
}

function syncToggleButton(liveState: string): void {
  if (!toggleButton) return;
  const active = liveState === "connecting" || liveState === "connected";
  if (toggleButton.classList.contains("is-active") !== active) {
    toggleButton.classList.toggle("is-active", active);
  }
  const pressed = String(active);
  if (toggleButton.getAttribute("aria-pressed") !== pressed) {
    toggleButton.setAttribute("aria-pressed", pressed);
  }
}

function mountToggleButton(): void {
  const host = findPlayerHost() || document.body;
  const placement = resolveControlBarPlacement({
    host,
    preferLiveRoomExtNodes: true
  });
  if (!placement) {
    if (toggleButton?.parentElement) {
      toggleButton.remove();
    }
    return;
  }

  if (!toggleButton) {
    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = `${TOGGLE_BUTTON_CLASS} bpx-player-ctrl-btn`;
    toggleButton.setAttribute("data-biliscript-extension-node", "live-room-toggle");
    toggleButton.setAttribute("aria-label", "实时伴看");
    toggleButton.setAttribute("data-tooltip", "实时伴看");
    toggleButton.title = "实时伴看";
    toggleButton.addEventListener("mouseenter", () => {
      toggleButton?.removeAttribute("title");
    });
    toggleButton.addEventListener("mouseleave", () => {
      toggleButton?.setAttribute("title", "实时伴看");
    });
    toggleButton.innerHTML = buildPlayerLiveQuickActionIconSvg();
    toggleButton.addEventListener("click", () => {
      void controller?.toggle();
    });
  }

  applyControlBarPlacement(toggleButton, placement);
  syncToggleButton(controller?.getState() ?? "idle");
}

function handleRoomChange(): void {
  const nextRoomId = parseLiveRoomId();
  if (nextRoomId === currentRoomId) return;
  currentRoomId = nextRoomId;
  void controller?.stop();
  overlayBinding.clearMessages();
  controller?.resetMerger?.();
}

export async function startLiveRoomCompanion(): Promise<void> {
  if (started) return;
  started = true;
  currentRoomId = parseLiveRoomId();

  try {
    state.setSettings(await getSettings());
  } catch {
    // 设置水合失败时沿用默认值；伴看平台与密钥由 SW 在连接时解析。
  }
  ensurePlayerAiStyles();

  const bridge = createLiveRoomBridge();
  controller = createLiveChatController({
    initialVolume: normalizeLiveVoiceVolume(state.settings?.liveVoiceVolume) / 100,
    initialVoicePriority: state.settings?.liveVoicePriority !== false,
    initialShareVideoAudio: state.settings?.liveShareVideoAudio === true,
    getVideoElement: () => document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR),
    getVideoContext: bridge.getVideoContext,
    executeTool: bridge.executeTool,
    showNotice,
    ...overlayBinding.bindControllerCallbacks({
      onStateChange: syncToggleButton
    })
  });

  mountToggleButton();
  containerObserverHandle = observePlayerContainer({
    containerSelector: PLAYER_HOST_SELECTOR,
    onMutations: () => {
      mountToggleButton();
    }
  });
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigatesuccess", handleRoomChange);
  window.addEventListener("popstate", handleRoomChange);
}

export function stopLiveRoomCompanion(): void {
  if (!started) return;
  started = false;
  containerObserverHandle?.disconnect();
  containerObserverHandle = null;
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.removeEventListener("navigatesuccess", handleRoomChange);
  window.removeEventListener("popstate", handleRoomChange);
  void controller?.stop();
  controller = null;
  toggleButton?.remove();
  toggleButton = null;
  currentRoomId = "";
}
