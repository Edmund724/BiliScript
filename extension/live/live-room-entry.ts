// extension/live/live-room-entry.ts
// 直播间的实时伴看入口：只挂载全屏伴看浮窗与一个开关按钮，不加载文摘面板、字幕与概览。
// 会话身份是房间号，每次进入都是新会话；换房间时先结束旧会话。

import { state } from "../core/state.js";
import { getSettings } from "../core/runtime.js";
import { normalizeLiveVoiceVolume } from "../core/validators.js";
import { ensurePlayerAiStyles } from "../shared/style-injector.js";
import { parseLiveRoomId } from "../bilibili/video-id-shared.js";
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
  toggleButton.classList.toggle("is-active", active);
  toggleButton.setAttribute("aria-pressed", String(active));
  const isFloatingActive = active && toggleButton.classList.contains("is-floating");
  toggleButton.setAttribute("aria-hidden", String(isFloatingActive));
}

function mountToggleButton(): void {
  const host = findPlayerHost() || document.body;
  const modernControls = host.querySelector<HTMLElement>(".live-web-player-controller .right-area .ext-nodes");
  const legacyControls =
    host.querySelector<HTMLElement>(".bpx-player-control-bottom-right") ||
    document.querySelector<HTMLElement>(".bpx-player-control-bottom-right");
  const controls = modernControls || legacyControls;
  const quality = !modernControls && controls?.querySelector(".bpx-player-ctrl-quality") || null;
  const target = quality?.parentElement || controls || host;

  if (!toggleButton) {
    toggleButton = document.createElement("button");
    toggleButton.type = "button";
    toggleButton.className = `${TOGGLE_BUTTON_CLASS} bpx-player-ctrl-btn`;
    toggleButton.setAttribute("data-biliscript-extension-node", "live-room-toggle");
    toggleButton.setAttribute("aria-label", "实时伴看");
    toggleButton.title = "实时伴看";
    toggleButton.innerHTML = buildPlayerLiveQuickActionIconSvg();
    toggleButton.addEventListener("click", () => {
      void controller?.toggle();
    });
  }

  toggleButton.classList.toggle("is-floating", !controls);
  if (quality) {
    if (toggleButton.parentElement !== target || toggleButton.nextElementSibling !== quality) {
      target.insertBefore(toggleButton, quality);
    }
  } else if (controls) {
    if (toggleButton.parentElement !== controls || toggleButton !== controls.firstElementChild) {
      controls.insertBefore(toggleButton, controls.firstElementChild);
    }
  } else if (toggleButton.parentElement !== host) {
    host.appendChild(toggleButton);
  }
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
    onVoicePriorityChange: overlayBinding.handleVoicePriorityChange,
    onShareVideoAudioChange: overlayBinding.handleShareVideoAudioChange,
    getVideoElement: () => document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR),
    getVideoContext: bridge.getVideoContext,
    executeTool: bridge.executeTool,
    showNotice,
    onVadStateChange: overlayBinding.handleVadChange,
    onTranscript: overlayBinding.handleTranscript,
    onReconnecting: overlayBinding.handleReconnecting,
    onStateChange: (liveState) => {
      syncToggleButton(liveState);
      overlayBinding.handleStateChange(liveState);
    }
  });

  mountToggleButton();
  // 播放器节点由 B 站异步水合，挂载点可能被重建；定时自查补回按钮。
  window.setInterval(mountToggleButton, 1000);
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener("navigatesuccess", handleRoomChange);
  window.addEventListener("popstate", handleRoomChange);
}
