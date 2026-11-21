import { createLiquidGlassLens } from "./liquid-glass-lens.js";
import type { LiveChatController, LiveChatState } from "./live-chat-controller.js";
import type { LiveFailureKind } from "./live-session-tracker.js";
import { createLiveOverlayTranscriptMerger } from "./live-transcript-merger.js";
import type { MossLiveSessionContext, MossLiveTranscriptEvent } from "./moss-live-protocol.js";
import { LIVE_VOICE_SPEED_STEPS, normalizeLiveVoiceSpeed } from "./live-voice-speed.js";
import {
  applyViewportOffset,
  bindViewportDrag,
  type ViewportDragHandle,
  type ViewportDragOffset
} from "./viewport-drag.js";
import { bindAudioPopover, type AudioPopoverHandle } from "./audio-popover.js";
import { getFullscreenHost } from "./fullscreen-host.js";
import {
  BILI_HOST_SELECTORS,
  biliHostAdapter,
  resolveBpxPlayerContainer,
  type HostObserverHandle
} from "../bilibili/host-adapter.js";
import { createDisposableContext } from "../shared/typed-event-bus.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit,
  captureTriggerRect
} from "../ui/trigger-motion.js";

export type LiveSettingsTarget = "live" | "gemini-key";

export interface LiveFailureActions {
  kind: LiveFailureKind;
  reason: string;
  showSettings: boolean;
  settingsLabel: string | null;
  settingsTarget: LiveSettingsTarget;
  settingsPrimary: boolean;
  showRetry: boolean;
  retryLabel: string;
  retryPrimary: boolean;
}

const FAILURE_SETTINGS_LABELS: Partial<Record<LiveFailureKind, string>> = {
  "provider-unconfigured": "设置伴看",
  "key-missing": "填写 Key",
  "key-rejected": "检查 Key",
  "gemini-credential": "配置 Gemini Key",
  "permission-denied": "设置伴看"
};

export function resolveLiveFailureActions(
  failureKind?: LiveFailureKind,
  error?: string
): LiveFailureActions {
  const kind: LiveFailureKind = failureKind || "unknown";
  const settingsLabel = FAILURE_SETTINGS_LABELS[kind] ?? null;
  const showSettings = settingsLabel !== null;
  const settingsTarget: LiveSettingsTarget = kind === "gemini-credential" ? "gemini-key" : "live";
  const settingsPrimary =
    kind === "provider-unconfigured" ||
    kind === "key-missing" ||
    kind === "key-rejected" ||
    kind === "gemini-credential";
  const showRetry = kind !== "provider-unconfigured" && kind !== "key-missing";
  const retryLabel = kind === "permission-denied" ? "重新授权" : "重试";
  const reason =
    kind === "unknown"
      ? "实时伴看启动失败，请重试"
      : error || "伴看连接失败，请重试";
  return {
    kind,
    reason,
    showSettings,
    settingsLabel,
    settingsTarget,
    settingsPrimary,
    showRetry,
    retryLabel,
    retryPrimary: showRetry && !settingsPrimary
  };
}

export interface FullscreenLiveOverlayDeps {
  getPlayerHost: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  getVolume?: () => number;
  onVolumeChange?: (volume: number) => void;
  onSpeedChange?: (speed: number) => void;
  onStopLive?: () => void;
  onRetryLive?: () => void;
  onOpenLiveSettings?: (target: LiveSettingsTarget) => void;
}

export interface FullscreenLiveOverlay {
  show(options?: { forceExpand?: boolean }): void;
  hide(): void;
  toggle(): void;
  restore(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  syncState(state?: LiveChatState, reconnecting?: boolean, error?: string, failureKind?: LiveFailureKind): void;
  showInterpretNotice(message: string, autoHideMs?: number): void;
  updateVad(active: boolean): void;
  updateTranscript(event: MossLiveTranscriptEvent): void;
  showVideoContextSwitch(context: MossLiveSessionContext): void;
  clearMessages(): void;
  getElement(): HTMLElement | null;
  getMiniCapsuleElement(): HTMLElement | null;
  dispose(): void;
}

export function createFullscreenLiveOverlay(deps: FullscreenLiveOverlayDeps): FullscreenLiveOverlay {
  let rootEl: HTMLElement | null = null;
  let statusCapsuleEl: HTMLElement | null = null;
  let statusDotEl: HTMLElement | null = null;
  let statusTextEl: HTMLElement | null = null;
  let micBtnEl: HTMLButtonElement | null = null;
  let audioBtnEl: HTMLButtonElement | null = null;
  let audioPopEl: HTMLElement | null = null;
  let audioPopoverHandle: AudioPopoverHandle | null = null;
  let volumeSliderEl: HTMLInputElement | null = null;
  let volumeValueEl: HTMLElement | null = null;
  let speedSliderEl: HTMLInputElement | null = null;
  let speedValueEl: HTMLElement | null = null;
  let shareAudioSwitchEl: HTMLButtonElement | null = null;
  let shareAudioStatusEl: HTMLElement | null = null;
  let voicePrioritySwitchEl: HTMLButtonElement | null = null;
  let headerSettingsBtnEl: HTMLButtonElement | null = null;
  let minBtnEl: HTMLButtonElement | null = null;
  let closeBtnEl: HTMLButtonElement | null = null;
  let failureCardEl: HTMLElement | null = null;
  let failureReasonEl: HTMLElement | null = null;
  let cancelBtnEl: HTMLButtonElement | null = null;
  let settingsBtnEl: HTMLButtonElement | null = null;
  let retryBtnEl: HTMLButtonElement | null = null;
  let interpretNoticeEl: HTMLElement | null = null;
  let interpretNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let messagesEl: HTMLElement | null = null;
  let scrollBottomBtnEl: HTMLButtonElement | null = null;

  let miniCapsuleEl: HTMLButtonElement | null = null;
  let miniCapsuleDotEl: HTMLElement | null = null;
  let miniCapsuleStatusTextEl: HTMLElement | null = null;
  let miniCapsuleMicTextEl: HTMLElement | null = null;
  let miniCapsuleMicIconEl: SVGSVGElement | null = null;

  let isMin = true;
  let lastSyncedState: LiveChatState = "idle";
  let lastIsReconnecting = false;
  let failureActive = false;
  let restoreMiniAfterFailure = false;
  let lastFailureError: string | undefined;
  let lastFailureKind: LiveFailureKind | undefined;
  let savedOffset: ViewportDragOffset | null = null;
  let headerDragHandle: ViewportDragHandle | null = null;
  let capsuleDragHandle: ViewportDragHandle | null = null;
  let hostResizeObserver: ResizeObserver | null = null;
  let observedHost: HTMLElement | null = null;
  let rootResizeObserver: ResizeObserver | null = null;
  let observedRoot: HTMLElement | null = null;
  const overlayScope = createDisposableContext();
  let mountObserverHandle: HostObserverHandle | null = null;
  let mountSyncQueued = false;
  let disposed = false;

  const SCROLL_THRESHOLD = 60;
  let isScrolledToBottom = true;
  let smoothScrollingToBottom = false;

  function getMountHost(): HTMLElement {
    const fullscreenHost = getFullscreenHost();
    if (fullscreenHost) return fullscreenHost;
    const playerHost = deps.getPlayerHost();
    if (playerHost) {
      return resolveBpxPlayerContainer(playerHost) || playerHost;
    }
    return document.querySelector<HTMLElement>(BILI_HOST_SELECTORS.playerBpxContainer) || document.body;
  }

  function applyOffset(el: HTMLElement, offset: ViewportDragOffset, host = getMountHost()): ViewportDragOffset {
    return applyViewportOffset(el, host, offset);
  }

  function observeHostResize(host: HTMLElement): void {
    if (observedHost === host) return;
    hostResizeObserver?.disconnect();
    hostResizeObserver = null;
    observedHost = host;
    if (typeof ResizeObserver !== "undefined") {
      hostResizeObserver = new ResizeObserver(scheduleMountSync);
      hostResizeObserver.observe(host);
    }
  }

  function observeRootResize(overlay: HTMLElement): void {
    if (observedRoot === overlay) return;
    rootResizeObserver?.disconnect();
    rootResizeObserver = null;
    observedRoot = overlay;
    if (typeof ResizeObserver !== "undefined") {
      rootResizeObserver = new ResizeObserver(() => {
        if (disposed || !rootEl || isMin || !savedOffset) return;
        applyOffset(rootEl, savedOffset);
        audioPopoverHandle?.reposition();
      });
      rootResizeObserver.observe(overlay);
    }
  }

  function syncMountedHost(): void {
    if (disposed || !rootEl || typeof document === "undefined") return;
    const host = getMountHost();
    if (!rootEl.isConnected && !host.isConnected) {
      mountObserverHandle?.disconnect();
      mountObserverHandle = null;
      hostResizeObserver?.disconnect();
      hostResizeObserver = null;
      observedHost = null;
      return;
    }
    observeHostResize(host);

    if (rootEl.parentElement !== host) host.appendChild(rootEl);
    if (miniCapsuleEl && miniCapsuleEl.parentElement !== host) {
      host.appendChild(miniCapsuleEl);
    }
    const positionedEl = isMin ? miniCapsuleEl : rootEl;
    if (savedOffset && positionedEl) {
      applyOffset(positionedEl, savedOffset, host);
    }
    audioPopoverHandle?.syncHost();
    audioPopoverHandle?.reposition();
    if (!rootEl.hidden && !rootEl.classList.contains("is-hidden")) {
      glassLens.sync(rootEl);
    }
  }

  function scheduleMountSync(): void {
    if (disposed || !rootEl || mountSyncQueued) return;
    mountSyncQueued = true;
    queueMicrotask(() => {
      mountSyncQueued = false;
      syncMountedHost();
    });
  }

  function observeMountHost(): void {
    if (mountObserverHandle || disposed || typeof document === "undefined" || !document.body) return;
    mountObserverHandle = biliHostAdapter.observeElement(document.body, {
      observeOptions: { childList: true, subtree: true },
      signal: overlayScope.signal,
      onMutations: scheduleMountSync
    });
  }

  function isVisible(): boolean {
    if (rootEl && !rootEl.hidden && !rootEl.classList.contains("is-hidden")) {
      return true;
    }
    if (miniCapsuleEl && !miniCapsuleEl.hidden && !miniCapsuleEl.classList.contains("is-hidden")) {
      return true;
    }
    return false;
  }

  function isMinimized(): boolean {
    return isMin;
  }

  const glassLens = createLiquidGlassLens({
    getMountHost,
    isMinimized,
    isVisible: () => Boolean(rootEl && !rootEl.hidden && !rootEl.classList.contains("is-hidden"))
  });

  function setScrollBottomButtonHidden(hidden: boolean): void {
    if (!scrollBottomBtnEl) return;
    if (hidden && document.activeElement === scrollBottomBtnEl) {
      minBtnEl?.focus({ preventScroll: true });
    }
    scrollBottomBtnEl.hidden = hidden;
  }

  function updateScrollFollowState(): void {
    if (!messagesEl) return;
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    const atBottom = distFromBottom <= SCROLL_THRESHOLD;
    if (smoothScrollingToBottom) {
      if (atBottom) {
        smoothScrollingToBottom = false;
      } else {
        isScrolledToBottom = true;
        setScrollBottomButtonHidden(true);
        return;
      }
    }
    isScrolledToBottom = atBottom;
    setScrollBottomButtonHidden(atBottom);
  }

  function scrollToBottom(force = false): void {
    if (!messagesEl) return;
    if (force || isScrolledToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      smoothScrollingToBottom = false;
      isScrolledToBottom = true;
      setScrollBottomButtonHidden(true);
    }
  }

  const transcriptMerger = createLiveOverlayTranscriptMerger({
    getMessagesContainer: () => messagesEl,
    scrollToBottom: () => scrollToBottom(),
    isVoiceRecentlyActive: () => deps.getLiveController()?.isVoiceRecentlyActive?.() ?? true
  });

  function ensureMounted(): HTMLElement {
    const host = getMountHost();
    if (rootEl) {
      observeMountHost();
      syncMountedHost();
      return rootEl;
    }

    const existing = host.querySelector("#biliscript-fullscreen-live-overlay") as HTMLElement | null;
    const existingCapsule = host.querySelector(".biliscript-fullscreen-live-mini-capsule") as HTMLButtonElement | null;
    if (existing) {
      rootEl = existing;
      miniCapsuleEl = existingCapsule;
      if (miniCapsuleEl) {
        miniCapsuleDotEl = miniCapsuleEl.querySelector(".live-overlay-status-dot");
        miniCapsuleStatusTextEl = miniCapsuleEl.querySelector(".live-overlay-mini-status-text");
        miniCapsuleMicTextEl = miniCapsuleEl.querySelector(".live-overlay-mini-mic-text");
        miniCapsuleMicIconEl = miniCapsuleEl.querySelector(".live-overlay-mini-mic-icon, svg");
      }
      bindDomReferences(rootEl);
      observeMountHost();
      observeHostResize(host);
      observeRootResize(rootEl);
      return rootEl;
    }

    const overlay = document.createElement("div");
    overlay.id = "biliscript-fullscreen-live-overlay";
    overlay.className = "biliscript-fullscreen-live-overlay is-hidden";
    overlay.setAttribute("data-biliscript-extension-node", "fullscreen-live-overlay");
    overlay.setAttribute("role", "region");
    overlay.setAttribute("aria-label", "实时伴看");
    overlay.hidden = true;
    overlay.setAttribute("inert", "");
    overlay.innerHTML = `
      <div class="live-overlay-header">
        <div class="live-overlay-header-left">
          <div class="live-overlay-status-capsule">
            <span class="live-overlay-status-dot" aria-hidden="true"></span>
            <span class="live-overlay-status-text">正在伴看</span>
          </div>
          <button type="button" class="live-overlay-icon-btn live-overlay-header-settings-btn" title="伴看平台与密钥" aria-label="伴看平台与密钥">
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          </button>
        </div>
        <div class="live-overlay-header-actions">
          <button type="button" class="live-overlay-icon-btn live-overlay-mic-btn" title="麦克风静音" aria-label="麦克风静音" aria-pressed="false">
            <svg aria-hidden="true" focusable="false" class="live-overlay-icon-mic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
            <svg aria-hidden="true" focusable="false" class="live-overlay-icon-mic-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="1" y1="1" x2="23" y2="23"></line>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
          </button>
          <div class="live-overlay-audio-anchor">
            <button type="button" class="live-overlay-icon-btn live-overlay-audio-btn" title="音频设置" aria-label="音频设置" aria-expanded="false" aria-controls="biliscript-live-audio-popover">
              <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              </svg>
            </button>
            <div id="biliscript-live-audio-popover" class="live-overlay-audio-popover" popover="manual" hidden>
              <div class="live-overlay-output-controls">
                <div class="live-overlay-pop-item live-overlay-pop-volume-item">
                  <span>伴看音量</span>
                  <div class="live-overlay-volume-control">
                    <input type="range" class="live-overlay-volume-slider" min="0" max="200" step="1" value="100" style="--live-progress: 50%;" aria-label="伴看音量" aria-valuetext="100%" />
                    <span class="live-overlay-volume-value">100%</span>
                  </div>
                </div>
                <div class="live-overlay-pop-item live-overlay-pop-speed-item">
                  <span>语速</span>
                  <div class="live-overlay-volume-control">
                    <input type="range" class="live-overlay-volume-slider live-overlay-speed-slider" min="0" max="4" step="1" value="2" style="--live-progress: 50%;" aria-label="语速" aria-valuetext="1×" />
                    <span class="live-overlay-volume-value live-overlay-speed-value">1×</span>
                  </div>
                </div>
              </div>
              <div class="live-overlay-pop-item">
                <span>分享视频声音</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-share-switch" aria-label="分享视频声音" aria-description="让 AI 同时听到视频原声与你的麦克风声音" title="让 AI 同时听到视频原声与你的麦克风声音"></button>
              </div>
              <div class="live-overlay-audio-status" role="status" hidden></div>
              <div class="live-overlay-pop-item">
                <span>语音优先</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-priority-switch" aria-label="语音优先" aria-description="你说话或 AI 播报时降低视频音量，结束后恢复" title="你说话或 AI 播报时降低视频音量，结束后恢复"></button>
              </div>
            </div>
          </div>
          <button type="button" class="live-overlay-icon-btn live-overlay-min-btn" title="最小化伴看浮窗" aria-label="最小化伴看浮窗" aria-expanded="true" aria-controls="biliscript-fullscreen-live-overlay">
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button type="button" class="live-overlay-icon-btn live-overlay-close-btn" title="关闭伴看" aria-label="关闭伴看">
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="live-overlay-body">
        <div class="live-overlay-interpret-notice" role="status" hidden></div>
        <div class="live-overlay-failure-card" role="alert" hidden>
          <div class="live-overlay-failure-reason"></div>
          <div class="live-overlay-failure-actions">
            <button type="button" class="live-overlay-action-btn live-overlay-cancel-btn">取消</button>
            <button type="button" class="live-overlay-action-btn live-overlay-settings-btn" data-primary-action="false" hidden>设置伴看</button>
            <button type="button" class="live-overlay-action-btn live-overlay-retry-btn" data-primary-action="true">重试</button>
          </div>
        </div>
        <div class="live-overlay-messages"></div>
        <button type="button" class="live-overlay-scroll-bottom-btn" title="回到底部" aria-label="回到底部" hidden>
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>
    `;

    const miniCapsule = document.createElement("button");
    miniCapsule.type = "button";
    miniCapsule.className = "biliscript-fullscreen-live-mini-capsule is-hidden";
    miniCapsule.setAttribute("title", "展开伴看浮窗");
    miniCapsule.setAttribute("aria-label", "正在伴看，麦克风已开启，展开伴看浮窗");
    miniCapsule.setAttribute("aria-expanded", "false");
    miniCapsule.setAttribute("aria-controls", overlay.id);
    miniCapsule.hidden = true;
    miniCapsule.setAttribute("inert", "");
    miniCapsule.innerHTML = `
      <span class="live-overlay-status-dot" aria-hidden="true"></span>
      <span class="live-overlay-mini-status-text">正在伴看</span>
      <span class="live-overlay-mini-mic-text">麦克风已开启</span>
      <svg aria-hidden="true" focusable="false" class="live-overlay-mini-mic-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" x2="12" y1="19" y2="22"/>
      </svg>
    `;

    host.appendChild(overlay);
    host.appendChild(miniCapsule);
    rootEl = overlay;
    miniCapsuleEl = miniCapsule;
    miniCapsuleDotEl = miniCapsule.querySelector(".live-overlay-status-dot");
    miniCapsuleStatusTextEl = miniCapsule.querySelector(".live-overlay-mini-status-text");
    miniCapsuleMicTextEl = miniCapsule.querySelector(".live-overlay-mini-mic-text");
    miniCapsuleMicIconEl = miniCapsule.querySelector(".live-overlay-mini-mic-icon, svg");

    bindDomReferences(overlay);
    bindEvents(overlay);
    bindCapsuleEvents(miniCapsule);
    glassLens.observeResize(overlay);
    observeMountHost();
    observeHostResize(host);
    observeRootResize(overlay);
    return overlay;
  }

  function bindDomReferences(overlay: HTMLElement): void {
    statusCapsuleEl = overlay.querySelector(".live-overlay-status-capsule");
    statusDotEl = overlay.querySelector(".live-overlay-status-dot");
    statusTextEl = overlay.querySelector(".live-overlay-status-text");
    micBtnEl = overlay.querySelector(".live-overlay-mic-btn");
    audioBtnEl = overlay.querySelector(".live-overlay-audio-btn");
    audioPopEl = overlay.querySelector(".live-overlay-audio-popover");
    volumeSliderEl = overlay.querySelector(".live-overlay-volume-slider:not(.live-overlay-speed-slider)");
    volumeValueEl = overlay.querySelector(".live-overlay-volume-value:not(.live-overlay-speed-value)");
    speedSliderEl = overlay.querySelector(".live-overlay-speed-slider");
    speedValueEl = overlay.querySelector(".live-overlay-speed-value");
    shareAudioSwitchEl = overlay.querySelector(".live-overlay-share-switch");
    shareAudioStatusEl = overlay.querySelector(".live-overlay-audio-status");
    voicePrioritySwitchEl = overlay.querySelector(".live-overlay-priority-switch");
    headerSettingsBtnEl = overlay.querySelector(".live-overlay-header-settings-btn");
    minBtnEl = overlay.querySelector(".live-overlay-min-btn");
    closeBtnEl = overlay.querySelector(".live-overlay-close-btn");
    failureCardEl = overlay.querySelector(".live-overlay-failure-card");
    failureReasonEl = overlay.querySelector(".live-overlay-failure-reason");
    cancelBtnEl = overlay.querySelector(".live-overlay-cancel-btn");
    settingsBtnEl = overlay.querySelector(".live-overlay-settings-btn");
    retryBtnEl = overlay.querySelector(".live-overlay-retry-btn");
    interpretNoticeEl = overlay.querySelector(".live-overlay-interpret-notice");
    messagesEl = overlay.querySelector(".live-overlay-messages");
    scrollBottomBtnEl = overlay.querySelector(".live-overlay-scroll-bottom-btn");
  }

  function bindEvents(overlay: HTMLElement): void {
    const header = overlay.querySelector(".live-overlay-header") as HTMLElement | null;
    headerDragHandle?.dispose();
    if (header) {
      headerDragHandle = bindViewportDrag({
        handleEl: header,
        getTargetEl: () => rootEl,
        getHostEl: getMountHost,
        ignoreSelector: "button, [role='switch'], input, .live-overlay-audio-popover",
        onDragEnd: (offset) => {
          savedOffset = offset;
          audioPopoverHandle?.reposition();
        }
      });
    }

    micBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!isMicControlActive()) return;
      const controller = deps.getLiveController();
      controller?.toggleMute();
      syncMicButton();
    });

    audioPopoverHandle?.dispose();
    if (audioBtnEl && audioPopEl) {
      audioPopoverHandle = bindAudioPopover({
        button: audioBtnEl,
        popover: audioPopEl,
        getOverlayRoot: () => rootEl,
        getMountHost,
        onOpen: syncAudioControls
      });
    }

    const previewVolume = (target: HTMLInputElement): number => {
      const val = Math.max(0, Math.min(200, Math.round(Number(target.value) || 0)));
      syncVolumeDisplay(val);
      deps.getLiveController()?.setVolume(val / 100);
      return val;
    };
    volumeSliderEl?.addEventListener("input", (e) => {
      e.stopPropagation();
      previewVolume(e.target as HTMLInputElement);
    });
    volumeSliderEl?.addEventListener("change", (e) => {
      e.stopPropagation();
      deps.onVolumeChange?.(previewVolume(e.target as HTMLInputElement));
    });

    const onSpeedInput = (e: Event) => {
      e.stopPropagation();
      const target = e.target as HTMLInputElement;
      const index = Math.max(0, Math.min(LIVE_VOICE_SPEED_STEPS.length - 1, Math.round(Number(target.value) || 0)));
      const speed = LIVE_VOICE_SPEED_STEPS[index];
      syncSpeedDisplay(speed);
      deps.getLiveController()?.setSpeed(speed);
      deps.onSpeedChange?.(speed);
    };
    speedSliderEl?.addEventListener("input", onSpeedInput);
    speedSliderEl?.addEventListener("change", onSpeedInput);

    shareAudioSwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      if (controller) {
        controller.setShareVideoAudio(!controller.isSharingVideoAudio());
        syncAudioControls();
      }
    });

    voicePrioritySwitchEl?.addEventListener("click", () => {
      const controller = deps.getLiveController();
      if (controller) {
        controller.setVoicePriority(!controller.isVoicePriority());
        syncAudioControls();
      }
    });

    headerSettingsBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      audioPopoverHandle?.close(false);
      deps.onOpenLiveSettings?.("live");
    });

    minBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      minimize();
    });

    const stopCompanion = () => {
      if (deps.onStopLive) {
        deps.onStopLive();
      } else {
        void deps.getLiveController()?.stop();
      }
      hideCompletely();
    };

    closeBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      stopCompanion();
    });

    cancelBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      stopCompanion();
    });

    settingsBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      deps.onOpenLiveSettings?.(resolveLiveFailureActions(lastFailureKind, lastFailureError).settingsTarget);
    });

    retryBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (deps.onRetryLive) {
        deps.onRetryLive();
      } else {
        void deps.getLiveController()?.start();
      }
    });

    const cancelSmoothScrollToBottom = () => {
      smoothScrollingToBottom = false;
    };
    messagesEl?.addEventListener("scroll", updateScrollFollowState, { passive: true });
    messagesEl?.addEventListener("wheel", cancelSmoothScrollToBottom, { passive: true });
    messagesEl?.addEventListener("pointerdown", cancelSmoothScrollToBottom, { passive: true });
    messagesEl?.addEventListener("touchmove", cancelSmoothScrollToBottom, { passive: true });
    scrollBottomBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (messagesEl && typeof messagesEl.scrollTo === "function") {
        const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
        smoothScrollingToBottom = distFromBottom > SCROLL_THRESHOLD;
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
      } else if (messagesEl) {
        smoothScrollingToBottom = false;
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      isScrolledToBottom = true;
      setScrollBottomButtonHidden(true);
    });
  }

  function bindCapsuleEvents(capsule: HTMLButtonElement): void {
    capsuleDragHandle?.dispose();
    capsuleDragHandle = bindViewportDrag({
      handleEl: capsule,
      getTargetEl: () => miniCapsuleEl,
      getHostEl: getMountHost,
      onClickWithoutDrag: () => restore(),
      onDragEnd: (offset) => {
        savedOffset = offset;
      }
    });
    capsule.addEventListener("click", (event) => {
      if (event.detail === 0) restore();
    });
  }

  function resolveCurrentVolume(): number {
    const c = deps.getLiveController();
    if (c?.getVolume) {
      return Math.round(Math.max(0, Math.min(2, c.getVolume())) * 100);
    }
    if (deps.getVolume) {
      return Math.round(Math.max(0, Math.min(200, deps.getVolume())));
    }
    return 100;
  }

  function syncVolumeDisplay(val: number): void {
    if (volumeSliderEl) {
      volumeSliderEl.value = String(val);
      volumeSliderEl.style.setProperty("--live-progress", `${val / 2}%`);
      volumeSliderEl.setAttribute("aria-valuetext", `${val}%`);
    }
    if (volumeValueEl) {
      volumeValueEl.textContent = `${val}%`;
    }
  }

  function syncSpeedDisplay(value: number): void {
    const speed = normalizeLiveVoiceSpeed(value);
    const index = LIVE_VOICE_SPEED_STEPS.indexOf(speed);
    const text = `${speed}×`;
    if (speedSliderEl) {
      speedSliderEl.value = String(index);
      speedSliderEl.style.setProperty("--live-progress", `${index / (LIVE_VOICE_SPEED_STEPS.length - 1) * 100}%`);
      speedSliderEl.setAttribute("aria-valuetext", text);
    }
    if (speedValueEl) speedValueEl.textContent = text;
  }

  function isMicControlActive(): boolean {
    return lastSyncedState === "connected" && !lastIsReconnecting;
  }

  function syncMiniCapsuleName(): void {
    if (!miniCapsuleEl) return;
    const status = miniCapsuleStatusTextEl?.textContent || "实时伴看";
    const micActive = isMicControlActive();
    const mic = micActive ? (miniCapsuleMicTextEl?.textContent || "麦克风已开启") : "";
    const label = mic ? `${status}，${mic}，展开伴看浮窗` : `${status}，展开伴看浮窗`;
    miniCapsuleEl.setAttribute("aria-label", label);
    miniCapsuleEl.title = label;
  }

  function syncMicButton(): void {
    const micActive = isMicControlActive();
    const isMuted = micActive && (deps.getLiveController()?.isMuted() ?? false);
    if (micBtnEl) {
      micBtnEl.disabled = !micActive;
      micBtnEl.setAttribute("aria-pressed", String(isMuted));
      const label = !micActive
        ? "连接后可用麦克风"
        : isMuted
          ? "取消静音麦克风"
          : "麦克风静音";
      micBtnEl.setAttribute("title", label);
      micBtnEl.setAttribute("aria-label", label);
    }
    if (miniCapsuleMicTextEl) {
      miniCapsuleMicTextEl.hidden = !micActive;
      miniCapsuleMicTextEl.textContent = micActive
        ? (isMuted ? "麦克风已静音" : "麦克风已开启")
        : "";
    }
    if (miniCapsuleMicIconEl) {
      miniCapsuleMicIconEl.toggleAttribute("hidden", !micActive);
      miniCapsuleMicIconEl.style.display = micActive ? "" : "none";
    }
    syncMiniCapsuleName();
  }

  function syncAudioControls(): void {
    syncMicButton();
    const controller = deps.getLiveController();
    if (!controller) return;

    syncVolumeDisplay(resolveCurrentVolume());
    syncSpeedDisplay(controller.getSpeed());

    let missingAudioTrack = false;
    if (shareAudioSwitchEl) {
      const share = controller.isSharingVideoAudio();
      shareAudioSwitchEl.setAttribute("aria-checked", String(share));
      shareAudioSwitchEl.classList.toggle("is-active", share);
      missingAudioTrack = share && controller.getVideoAudioStatus?.() === "未检测到音轨";
    }
    if (shareAudioStatusEl) {
      shareAudioStatusEl.hidden = !missingAudioTrack;
      shareAudioStatusEl.textContent = missingAudioTrack ? "未采到视频音轨；仍可语音伴看" : "";
    }
    if (voicePrioritySwitchEl) {
      const prio = controller.isVoicePriority();
      voicePrioritySwitchEl.setAttribute("aria-checked", String(prio));
      voicePrioritySwitchEl.classList.toggle("is-active", prio);
    }
  }

  function setElementHidden(el: HTMLElement, hidden: boolean): void {
    el.hidden = hidden;
    el.classList.toggle("is-hidden", hidden);
    el.toggleAttribute("inert", hidden);
  }

  function syncExpansionAria(): void {
    miniCapsuleEl?.setAttribute("aria-expanded", String(!isMin));
    minBtnEl?.setAttribute("aria-expanded", String(!isMin));
  }

  function resolveLiveLaunchTrigger(): Element | null {
    return document.querySelector("#biliscript-player-live-quick-action, .biliscript-live-room-toggle");
  }

  function applyPresentation(minimized: boolean, moveFocus = false): void {
    const focused = document.activeElement;
    const focusInRoot = rootEl?.contains(focused) ?? false;
    const focusInCapsule = miniCapsuleEl?.contains(focused) ?? false;
    isMin = minimized;

    if (minimized) {
      const overlayRect = rootEl && !rootEl.hidden ? captureTriggerRect(rootEl) : null;
      if (miniCapsuleEl) {
        const wasHidden = miniCapsuleEl.hidden;
        cancelTriggerExit(miniCapsuleEl);
        setElementHidden(miniCapsuleEl, false);
        if (savedOffset) applyOffset(miniCapsuleEl, savedOffset);
        if (wasHidden) {
          animateTriggerEnter({
            target: miniCapsuleEl,
            trigger: overlayRect ?? resolveLiveLaunchTrigger(),
            fallbackOrigin: "top right",
            fromScale: 0.9,
            durationMs: 180
          });
        }
      }
      if (rootEl) {
        if (!rootEl.hidden) {
          animateTriggerExit({
            target: rootEl,
            trigger: miniCapsuleEl && !miniCapsuleEl.hidden ? miniCapsuleEl : resolveLiveLaunchTrigger(),
            fallbackOrigin: "top right",
            toScale: 0.92,
            durationMs: 140,
            onFinish: () => {
              if (rootEl) {
                setElementHidden(rootEl, true);
                delete rootEl.dataset.popoverOpen;
              }
            }
          });
        } else {
          setElementHidden(rootEl, true);
          delete rootEl.dataset.popoverOpen;
        }
      }
      audioPopoverHandle?.close(false);
    } else {
      const capsuleTrigger =
        miniCapsuleEl && !miniCapsuleEl.hidden
          ? captureTriggerRect(miniCapsuleEl)
          : captureTriggerRect(resolveLiveLaunchTrigger());
      if (rootEl) {
        const wasHidden = rootEl.hidden;
        cancelTriggerExit(rootEl);
        setElementHidden(rootEl, false);
        if (savedOffset) applyOffset(rootEl, savedOffset);
        glassLens.sync(rootEl);
        if (wasHidden) {
          animateTriggerEnter({
            target: rootEl,
            trigger: capsuleTrigger,
            fallbackOrigin: "top right",
            fromScale: 0.92,
            durationMs: 200
          });
        }
      }
      if (miniCapsuleEl) {
        if (!miniCapsuleEl.hidden) {
          animateTriggerExit({
            target: miniCapsuleEl,
            trigger: rootEl && !rootEl.hidden ? rootEl : resolveLiveLaunchTrigger(),
            fallbackOrigin: "top right",
            toScale: 0.92,
            durationMs: 120,
            onFinish: () => {
              if (miniCapsuleEl) setElementHidden(miniCapsuleEl, true);
            }
          });
        } else {
          setElementHidden(miniCapsuleEl, true);
        }
      }
    }
    syncExpansionAria();

    if (moveFocus || (minimized ? focusInRoot : focusInCapsule)) {
      const target = minimized ? miniCapsuleEl : minBtnEl;
      target?.focus({ preventScroll: true });
    }
  }

  function minimize(): void {
    restoreMiniAfterFailure = false;
    applyPresentation(true, true);
    syncState();
  }

  function restore(): void {
    restoreMiniAfterFailure = false;
    show({ forceExpand: true });
    minBtnEl?.focus({ preventScroll: true });
  }

  function show(options?: { forceExpand?: boolean }): void {
    ensureMounted();
    if (options?.forceExpand) isMin = false;
    applyPresentation(isMin);
    syncState();
  }

  function hideCompletely(): void {
    const focused = document.activeElement;
    if (rootEl?.contains(focused) || miniCapsuleEl?.contains(focused)) {
      (focused as HTMLElement).blur();
    }
    const trigger = resolveLiveLaunchTrigger();
    isMin = true;
    lastSyncedState = "idle";
    lastIsReconnecting = false;
    smoothScrollingToBottom = false;
    failureActive = false;
    restoreMiniAfterFailure = false;
    if (rootEl) {
      if (!rootEl.hidden) {
        animateTriggerExit({
          target: rootEl,
          trigger,
          fallbackOrigin: "top right",
          toScale: 0.92,
          durationMs: 140,
          onFinish: () => {
            if (rootEl) {
              setElementHidden(rootEl, true);
              delete rootEl.dataset.popoverOpen;
            }
          }
        });
      } else {
        setElementHidden(rootEl, true);
        delete rootEl.dataset.popoverOpen;
      }
    }
    if (miniCapsuleEl) {
      if (!miniCapsuleEl.hidden) {
        animateTriggerExit({
          target: miniCapsuleEl,
          trigger,
          fallbackOrigin: "top right",
          toScale: 0.92,
          durationMs: 120,
          onFinish: () => {
            if (miniCapsuleEl) setElementHidden(miniCapsuleEl, true);
          }
        });
      } else {
        setElementHidden(miniCapsuleEl, true);
      }
    }
    audioPopoverHandle?.close(false);
    if (scrollBottomBtnEl) scrollBottomBtnEl.hidden = true;
    syncExpansionAria();
  }

  function hide(): void {
    if (lastSyncedState !== "idle") {
      applyPresentation(true);
      syncState();
      return;
    }
    hideCompletely();
  }

  function toggle(): void {
    if (isVisible()) {
      hide();
    } else {
      show();
    }
  }

  function syncState(customState?: LiveChatState, reconnecting?: boolean, error?: string, failureKind?: LiveFailureKind): void {
    if (error !== undefined) {
      lastFailureError = error;
    }
    if (failureKind !== undefined) {
      lastFailureKind = failureKind;
    }
    if (!rootEl) return;
    const controller = deps.getLiveController();
    const state = customState ?? controller?.getState() ?? "idle";
    lastSyncedState = state;
    const isReconnecting = reconnecting ?? Boolean(controller?.isReconnecting?.());
    lastIsReconnecting = isReconnecting;
    const showFailure = state === "failure" && !isReconnecting;
    if (state === "failure") {
      audioPopoverHandle?.close(false);
    }
    if (state !== "failure") {
      lastFailureError = undefined;
      lastFailureKind = undefined;
    }

    if (showFailure && !failureActive) {
      failureActive = true;
      restoreMiniAfterFailure = isMin;
      if (isMin) applyPresentation(false);
    } else if (!showFailure && failureActive) {
      failureActive = false;
      const shouldRestoreMini = restoreMiniAfterFailure;
      restoreMiniAfterFailure = false;
      if (shouldRestoreMini) applyPresentation(true);
    }

    if (miniCapsuleDotEl) {
      miniCapsuleDotEl.className = "live-overlay-status-dot";
      if (isReconnecting) {
        miniCapsuleDotEl.classList.add("is-reconnecting");
      } else if (state === "connecting") {
        miniCapsuleDotEl.classList.add("is-connecting");
      } else if (state === "connected") {
        miniCapsuleDotEl.classList.add("is-connected");
      } else if (state === "failure") {
        miniCapsuleDotEl.classList.add("is-failure");
      }
    }
    if (miniCapsuleStatusTextEl) {
      miniCapsuleStatusTextEl.textContent = isReconnecting
        ? "重连中"
        : state === "connecting"
          ? "连接中"
          : state === "connected"
            ? "正在伴看"
            : state === "failure"
              ? "需要处理"
              : "已就绪";
    }
    syncMiniCapsuleName();

    if (statusTextEl && statusDotEl) {
      statusDotEl.className = "live-overlay-status-dot";
      if (isReconnecting) {
        statusTextEl.textContent = "重连中...";
        statusDotEl.classList.add("is-reconnecting");
      } else if (state === "connecting") {
        statusTextEl.textContent = "连接中...";
        statusDotEl.classList.add("is-connecting");
      } else if (state === "connected") {
        statusTextEl.textContent = "正在伴看";
        statusDotEl.classList.add("is-connected");
      } else if (state === "failure") {
        statusTextEl.textContent = "连接异常";
        statusDotEl.classList.add("is-failure");
      } else {
        statusTextEl.textContent = "已就绪";
      }
    }

    if (failureCardEl) {
      failureCardEl.hidden = !showFailure;
      if (showFailure) {
        const resolved = resolveLiveFailureActions(lastFailureKind, lastFailureError);
        failureCardEl.dataset.failureKind = resolved.kind;
        if (failureReasonEl) {
          failureReasonEl.textContent = resolved.reason;
        }
        if (settingsBtnEl) {
          settingsBtnEl.hidden = !resolved.showSettings;
          settingsBtnEl.textContent = resolved.settingsLabel || "设置伴看";
          settingsBtnEl.dataset.primaryAction = String(resolved.settingsPrimary);
        }
        if (retryBtnEl) {
          retryBtnEl.hidden = !resolved.showRetry;
          retryBtnEl.textContent = resolved.retryLabel;
          retryBtnEl.dataset.primaryAction = String(resolved.retryPrimary);
        }
      } else {
        delete failureCardEl.dataset.failureKind;
      }
    }

    syncAudioControls();
  }

  function updateVad(active: boolean): void {
    if (statusCapsuleEl) {
      statusCapsuleEl.classList.toggle("is-talking", active);
    }
    if (statusDotEl) {
      statusDotEl.classList.toggle("is-talking", active);
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.classList.toggle("is-talking", active);
    }
    if (miniCapsuleDotEl) {
      miniCapsuleDotEl.classList.toggle("is-talking", active);
    }
    if (micBtnEl) {
      const isMuted = deps.getLiveController()?.isMuted() ?? false;
      micBtnEl.classList.toggle("is-talking", active && isMicControlActive() && !isMuted);
    }
  }

  function updateTranscript(event: MossLiveTranscriptEvent): void {
    transcriptMerger.handleEvent(event);
  }

  function clearMessages(): void {
    if (messagesEl) {
      messagesEl.innerHTML = "";
    }
    smoothScrollingToBottom = false;
    isScrolledToBottom = true;
    setScrollBottomButtonHidden(true);
    transcriptMerger.resetActiveTurns?.();
  }

  function showVideoContextSwitch(context: MossLiveSessionContext): void {
    ensureMounted();
    clearMessages();
    const isRoom = "kind" in context;
    const title = isRoom
      ? context.title || `直播间 ${context.roomId}`
      : context.pageTitle || context.title;
    const target = !isRoom && context.pageCount > 1
      ? `P${context.pageIndex}`
      : "";
    const message = `已切换到${target ? ` ${target}` : ""}${title ? `：${title}` : ""}`;
    showInterpretNotice(message, 4000);
    if (miniCapsuleStatusTextEl) {
      miniCapsuleStatusTextEl.textContent = message;
      syncMiniCapsuleName();
    }
  }

  function getElement(): HTMLElement | null {
    return rootEl;
  }

  function showInterpretNotice(message: string, autoHideMs = 6000): void {
    ensureMounted();
    if (!interpretNoticeEl) return;
    if (interpretNoticeTimer !== null) clearTimeout(interpretNoticeTimer);
    interpretNoticeTimer = null;
    interpretNoticeEl.textContent = message;
    interpretNoticeEl.hidden = false;
    if (autoHideMs > 0) {
      interpretNoticeTimer = setTimeout(() => {
        interpretNoticeTimer = null;
        if (interpretNoticeEl) {
          interpretNoticeEl.hidden = true;
          interpretNoticeEl.textContent = "";
        }
        syncState();
      }, autoHideMs);
    }
  }

  overlayScope.addListener(document, "fullscreenchange", scheduleMountSync);
  overlayScope.addListener(document, "webkitfullscreenchange", scheduleMountSync);
  overlayScope.addListener(window, "resize", scheduleMountSync);

  function dispose(): void {
    disposed = true;
    overlayScope.dispose();
    audioPopoverHandle?.dispose();
    audioPopoverHandle = null;
    if (interpretNoticeTimer !== null) clearTimeout(interpretNoticeTimer);
    interpretNoticeTimer = null;
    interpretNoticeEl = null;
    mountObserverHandle?.disconnect();
    mountObserverHandle = null;
    hostResizeObserver?.disconnect();
    hostResizeObserver = null;
    observedHost = null;
    rootResizeObserver?.disconnect();
    rootResizeObserver = null;
    observedRoot = null;
    headerDragHandle?.dispose();
    headerDragHandle = null;
    capsuleDragHandle?.dispose();
    capsuleDragHandle = null;
    glassLens.dispose();
    transcriptMerger.dispose();
    if (miniCapsuleEl) {
      miniCapsuleEl.remove();
      miniCapsuleEl = null;
      miniCapsuleDotEl = null;
      miniCapsuleStatusTextEl = null;
      miniCapsuleMicTextEl = null;
      miniCapsuleMicIconEl = null;
    }
    if (rootEl) {
      rootEl.remove();
      rootEl = null;
    }
  }

  return {
    show,
    hide,
    toggle,
    restore,
    isVisible,
    isMinimized,
    syncState,
    showInterpretNotice,
    updateVad,
    updateTranscript,
    showVideoContextSwitch,
    clearMessages,
    getElement,
    getMiniCapsuleElement: () => miniCapsuleEl,
    dispose
  };
}
