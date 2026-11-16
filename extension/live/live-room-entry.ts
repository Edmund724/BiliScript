// extension/live/live-room-entry.ts
// 直播间的实时伴看入口：只挂载全屏伴看浮窗与一个开关按钮，不加载文摘面板、字幕与概览。
// 会话身份是房间号，每次进入都是新会话；换房间时先结束旧会话。

import { state } from "../core/state.js";
import { getSettings } from "../core/runtime.js";
import { ensurePlayerAiStyles } from "../shared/style-injector.js";
import { parseLiveRoomId } from "../bilibili/video-id-shared.js";
import {
  observePlayerContainer,
  type PlayerContainerObserverHandle
} from "../bilibili/player-control-mount.js";
import {
  createLiveOverlayBinding,
  createThrottledLiveToggleHandler,
  mountControlBarLiveToggle,
  resolveLiveToggleLabel,
  syncPlayerLiveToggleButton
} from "./live-overlay-binding.js";
import type { MossLiveRoomContext, MossLiveToolCall } from "./moss-live-protocol.js";
import { buildPlayerLiveQuickActionIconSvg } from "../ui/icons.js";

export interface LiveRoomBridgeDeps {
  getUrl?: () => string;
  getTitle?: () => string;
  getAnchorName?: () => string;
}

export interface LiveRoomBridge {
  getVideoContext(): MossLiveRoomContext | null;
  executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>>;
}

const PLAYER_HOST_SELECTOR = "#live-player, .live-player-mounter, #live-player-ctnr";
const VIDEO_SELECTOR = "#live-player video, .live-player-mounter video, video";
const TOGGLE_BUTTON_CLASS = "biliscript-live-room-toggle";
const NOTICE_CLASS = "biliscript-live-room-notice";
const NOTICE_DEFAULT_MS = 4000;
const ANCHOR_NAME_SELECTORS = [
  ".room-owner-username",
  ".header-info-ctnr .room-owner-username",
  ".upper-row .room-owner-username"
];

function readDocumentTitle(): string {
  return String(document.title || "")
    .replace(/\s*[-_|]\s*哔哩哔哩直播.*$/, "")
    .trim();
}

function readAnchorName(): string {
  for (const selector of ANCHOR_NAME_SELECTORS) {
    const text = document.querySelector(selector)?.textContent?.trim();
    if (text) return text;
  }
  return "";
}

export function createLiveRoomBridge(deps: LiveRoomBridgeDeps = {}): LiveRoomBridge {
  const getUrl = deps.getUrl ?? (() => location.href);
  const getTitle = deps.getTitle ?? readDocumentTitle;
  const getAnchorName = deps.getAnchorName ?? readAnchorName;

  function getVideoContext(): MossLiveRoomContext | null {
    const url = getUrl();
    const roomId = parseLiveRoomId(url);
    if (!roomId) return null;
    return {
      kind: "live-room",
      url,
      roomId,
      title: getTitle(),
      anchorName: getAnchorName()
    };
  }

  async function executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>> {
    throw new Error(`直播间不支持页面工具：${String(call?.name || "未知").trim()}`);
  }

  return { getVideoContext, executeTool };
}

let started = false;
let toggleButton: HTMLButtonElement | null = null;
let containerObserverHandle: PlayerContainerObserverHandle | null = null;
let currentRoomId = "";
let settingsRequestId = 0;
let settingsModule: typeof import("./live-room-settings.js") | null = null;

function findPlayerHost(): HTMLElement | null {
  return document.querySelector<HTMLElement>(PLAYER_HOST_SELECTOR);
}

function closeLiveRoomSettings(): void {
  settingsRequestId += 1;
  settingsModule?.closeLiveRoomSettings();
}

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

const overlayBinding = createLiveOverlayBinding({
  getPlayerHost: findPlayerHost,
  createControllerDeps: () => {
    const bridge = createLiveRoomBridge();
    return {
      getVideoElement: () => document.querySelector<HTMLVideoElement>(VIDEO_SELECTOR),
      getVideoContext: bridge.getVideoContext,
      executeTool: bridge.executeTool,
      showNotice
    };
  },
  onOpenLiveSettings: (target) => {
    const requestId = ++settingsRequestId;
    const roomId = currentRoomId;
    void import("./live-room-settings.js")
      .then(async (settings) => {
        if (requestId !== settingsRequestId || roomId !== currentRoomId) return;
        settingsModule = settings;
        await settings.openLiveRoomSettings(target, findPlayerHost, {
          getState: () => overlayBinding.getController()?.getState() ?? "idle",
          reconnect: () => overlayBinding.reconnect(() => roomId === currentRoomId)
        });
      })
      .catch(() => {
        if (requestId === settingsRequestId && roomId === currentRoomId) {
          showNotice("伴看设置加载失败，请重试");
        }
      });
  }
});

const toggleHandler = createThrottledLiveToggleHandler(() => overlayBinding.toggle());

function syncToggleButton(liveState: string): void {
  if (!toggleButton) return;
  const active = liveState === "connecting" || liveState === "connected";
  syncPlayerLiveToggleButton({
    button: toggleButton,
    active,
    label: resolveLiveToggleLabel(liveState),
    setDataTooltip: true,
    setTitle: false
  });
}

function mountToggleButton(): void {
  const host = findPlayerHost() || document.body;
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
      toggleButton?.setAttribute(
        "title",
        resolveLiveToggleLabel(overlayBinding.getController()?.getState() ?? "idle")
      );
    });
    toggleButton.innerHTML = buildPlayerLiveQuickActionIconSvg();
    toggleButton.addEventListener("click", () => {
      void toggleHandler.handleClick();
    });
  }

  const placement = mountControlBarLiveToggle(toggleButton, host, {
    preferLiveRoomExtNodes: true
  });
  if (!placement) return;
  syncToggleButton(overlayBinding.getController()?.getState() ?? "idle");
}

function handleRoomChange(): void {
  const nextRoomId = parseLiveRoomId();
  if (nextRoomId === currentRoomId) return;
  currentRoomId = nextRoomId;
  closeLiveRoomSettings();
  void overlayBinding.stop();
  overlayBinding.clearOverlay();
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

  overlayBinding.setConsumerHooks({ onStateChange: syncToggleButton });
  await overlayBinding.ensureTargetReady();
  if (!started) return;

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
  closeLiveRoomSettings();
  overlayBinding.dispose();
  toggleButton?.remove();
  toggleButton = null;
  toggleHandler.reset();
  currentRoomId = "";
}
