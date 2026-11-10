// extension/live/fullscreen-live-overlay.ts
// 播放器全屏（浏览器全屏与网页全屏）右上角半透明实时伴看浮窗：
// 1. 头部状态胶囊（状态文本、麦克风 VAD 动效）
// 2. 音频快捷设置入口（静音、分享视频声音、语音优先）
// 3. 最小化（-）与关闭隐藏（×）
// 4. 纯语音实时流式对话气泡（通过 live-transcript-merger 共享轮次状态机驱动）
// 5. 播放器容器内拖拽移动（通过 viewport-drag 原语驱动）
// 6. 液体玻璃 12px 窄边缘 SVG 位移与三通道色散镜头（通过 liquid-glass-lens 驱动）
// 7. 无 CC 字幕视频的实时翻译开关（独立 InterpretSessionController）

import { createLiquidGlassLens } from "./liquid-glass-lens.js";
import type { InterpretSessionController } from "./interpret-session-controller.js";
import type { LiveChatController, LiveChatState } from "./live-chat-controller.js";
import { createLiveOverlayTranscriptMerger } from "./live-transcript-merger.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";
import { LIVE_VOICE_SPEED_STEPS, normalizeLiveVoiceSpeed } from "./live-voice-speed.js";
import { bindViewportDrag, type ViewportDragHandle } from "./viewport-drag.js";

export interface FullscreenLiveOverlayDeps {
  getPlayerHost: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  getInterpretController?: () => InterpretSessionController | null;
  shouldShowInterpret?: () => boolean;
  getVolume?: () => number;
  onVolumeChange?: (volume: number) => void;
  onSpeedChange?: (speed: number) => void;
  onStopLive?: () => void;
  onRetryLive?: () => void;
}

export interface FullscreenLiveOverlay {
  show(options?: { forceExpand?: boolean }): void;
  hide(): void;
  toggle(): void;
  restore(): void;
  isVisible(): boolean;
  isMinimized(): boolean;
  syncState(state?: LiveChatState, reconnecting?: boolean, error?: string): void;
  showInterpretNotice(message: string, autoHideMs?: number): void;
  updateVad(active: boolean): void;
  updateTranscript(event: MossLiveTranscriptEvent): void;
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
  let volumeSliderEl: HTMLInputElement | null = null;
  let volumeValueEl: HTMLElement | null = null;
  let speedSliderEl: HTMLInputElement | null = null;
  let speedValueEl: HTMLElement | null = null;
  let shareAudioSwitchEl: HTMLButtonElement | null = null;
  let voicePrioritySwitchEl: HTMLButtonElement | null = null;
  let minBtnEl: HTMLButtonElement | null = null;
  let closeBtnEl: HTMLButtonElement | null = null;
  let failureCardEl: HTMLElement | null = null;
  let failureReasonEl: HTMLElement | null = null;
  let cancelBtnEl: HTMLButtonElement | null = null;
  let retryBtnEl: HTMLButtonElement | null = null;
  let interpretBtnEl: HTMLButtonElement | null = null;
  let interpretNoticeEl: HTMLElement | null = null;
  let interpretNoticeTimer: ReturnType<typeof setTimeout> | null = null;
  let messagesEl: HTMLElement | null = null;
  let scrollBottomBtnEl: HTMLButtonElement | null = null;

  let miniCapsuleEl: HTMLElement | null = null;
  let miniCapsuleDotEl: HTMLElement | null = null;

  let isMin = true;
  let lastFailureError: string | undefined;
  let savedOffset: { right: number; top: number } | null = null;
  let headerDragHandle: ViewportDragHandle | null = null;
  let capsuleDragHandle: ViewportDragHandle | null = null;

  const SCROLL_THRESHOLD = 60;
  let isScrolledToBottom = true;

  function getMountHost(): HTMLElement {
    const fullscreenElement =
      document.fullscreenElement ||
      (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
    if (fullscreenElement instanceof HTMLElement) {
      return fullscreenElement;
    }
    const playerHost = deps.getPlayerHost();
    if (playerHost) {
      const bpxContainer = playerHost.matches(".bpx-player-container")
        ? playerHost
        : playerHost.querySelector<HTMLElement>(".bpx-player-container");
      return bpxContainer || playerHost;
    }
    return document.querySelector<HTMLElement>(".bpx-player-container") || document.body;
  }

  function applyOffset(el: HTMLElement, offset: { right: number; top: number }): void {
    const host = getMountHost();
    const hostRect = host.getBoundingClientRect();
    const rect = el.getBoundingClientRect();

    let clampedRight = Math.max(0, offset.right);
    let clampedTop = Math.max(0, offset.top);

    if (hostRect.width > 0 && rect.width > 0) {
      const maxRight = Math.max(0, hostRect.width - rect.width);
      clampedRight = Math.min(clampedRight, maxRight);
    }
    if (hostRect.height > 0 && rect.height > 0) {
      const maxTop = Math.max(0, hostRect.height - rect.height);
      clampedTop = Math.min(clampedTop, maxTop);
    }

    el.style.right = `${clampedRight}px`;
    el.style.top = `${clampedTop}px`;
    el.style.left = "auto";
    el.style.bottom = "auto";
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

  function updateScrollFollowState(): void {
    if (!messagesEl) return;
    const distFromBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    const atBottom = distFromBottom <= SCROLL_THRESHOLD;
    isScrolledToBottom = atBottom;
    if (scrollBottomBtnEl) {
      scrollBottomBtnEl.hidden = atBottom;
    }
  }

  function scrollToBottom(force = false): void {
    if (!messagesEl) return;
    if (force || isScrolledToBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
      isScrolledToBottom = true;
      if (scrollBottomBtnEl) {
        scrollBottomBtnEl.hidden = true;
      }
    }
  }

  const transcriptMerger = createLiveOverlayTranscriptMerger({
    getMessagesContainer: () => messagesEl,
    scrollToBottom: () => scrollToBottom(),
    isVoiceRecentlyActive: () => deps.getLiveController()?.isVoiceRecentlyActive?.() ?? true
  });

  function ensureMounted(): HTMLElement {
    const host = getMountHost();
    if (rootEl && rootEl.isConnected) {
      if (rootEl.parentElement !== host) {
        host.appendChild(rootEl);
      }
      if (miniCapsuleEl && miniCapsuleEl.parentElement !== host) {
        host.appendChild(miniCapsuleEl);
      }
      return rootEl;
    }

    const existing = host.querySelector("#biliscript-fullscreen-live-overlay") as HTMLElement | null;
    const existingCapsule = host.querySelector(".biliscript-fullscreen-live-mini-capsule") as HTMLElement | null;
    if (existing) {
      rootEl = existing;
      miniCapsuleEl = existingCapsule;
      if (miniCapsuleEl) {
        miniCapsuleDotEl = miniCapsuleEl.querySelector(".live-overlay-status-dot");
      }
      bindDomReferences(rootEl);
      return rootEl;
    }

    const overlay = document.createElement("div");
    overlay.id = "biliscript-fullscreen-live-overlay";
    overlay.className = "biliscript-fullscreen-live-overlay";
    overlay.setAttribute("data-biliscript-extension-node", "fullscreen-live-overlay");
    overlay.innerHTML = `
      <div class="live-overlay-header">
        <div class="live-overlay-status-capsule">
          <span class="live-overlay-status-dot"></span>
          <span class="live-overlay-status-text">正在陪看</span>
        </div>
        <div class="live-overlay-header-actions">
          <button type="button" class="live-overlay-icon-btn live-overlay-mic-btn" title="麦克风静音" aria-label="麦克风静音" aria-pressed="false">
            <svg class="live-overlay-icon-mic" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
            <svg class="live-overlay-icon-mic-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="1" y1="1" x2="23" y2="23"></line>
              <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"></path>
              <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
              <line x1="12" y1="19" x2="12" y2="22"></line>
            </svg>
          </button>
          <div class="live-overlay-audio-anchor">
            <button type="button" class="live-overlay-icon-btn live-overlay-audio-btn" title="音频设置" aria-label="音频设置">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
              </svg>
            </button>
            <div class="live-overlay-audio-popover" hidden>
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
                <button type="button" role="switch" class="live-overlay-switch live-overlay-share-switch" aria-label="分享视频声音" title="分享视频声音"></button>
              </div>
              <div class="live-overlay-pop-item">
                <span>语音优先</span>
                <button type="button" role="switch" class="live-overlay-switch live-overlay-priority-switch" aria-label="语音优先" title="语音优先"></button>
              </div>
            </div>
          </div>
          <button type="button" class="live-overlay-icon-btn live-overlay-min-btn" title="最小化" aria-label="最小化">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="5" y1="12" x2="19" y2="12"></line>
            </svg>
          </button>
          <button type="button" class="live-overlay-icon-btn live-overlay-close-btn" title="关闭伴看" aria-label="关闭伴看">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="live-overlay-body">
        <button type="button" class="live-overlay-action-btn live-overlay-interpret-btn" aria-label="实时翻译" aria-pressed="false" aria-disabled="false" hidden>实时翻译</button>
        <div class="live-overlay-interpret-notice" role="status" hidden></div>
        <div class="live-overlay-failure-card" hidden>
          <div class="live-overlay-failure-reason"></div>
          <div class="live-overlay-failure-actions">
            <button type="button" class="live-overlay-action-btn live-overlay-cancel-btn">取消</button>
            <button type="button" class="live-overlay-action-btn live-overlay-retry-btn">重试</button>
          </div>
        </div>
        <div class="live-overlay-messages"></div>
        <button type="button" class="live-overlay-scroll-bottom-btn" title="回到底部" aria-label="回到底部" hidden>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="6 9 12 15 18 9"></polyline>
          </svg>
        </button>
      </div>
    `;

    const miniCapsule = document.createElement("div");
    miniCapsule.className = "biliscript-fullscreen-live-mini-capsule is-hidden";
    miniCapsule.setAttribute("role", "button");
    miniCapsule.setAttribute("tabindex", "0");
    miniCapsule.setAttribute("title", "点击还原伴看浮窗");
    miniCapsule.setAttribute("aria-label", "点击还原伴看浮窗");
    miniCapsule.hidden = true;
    miniCapsule.innerHTML = `
      <span class="live-overlay-status-dot"></span>
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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

    bindDomReferences(overlay);
    bindEvents(overlay);
    bindCapsuleEvents(miniCapsule);
    glassLens.observeResize(overlay);
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
    voicePrioritySwitchEl = overlay.querySelector(".live-overlay-priority-switch");
    minBtnEl = overlay.querySelector(".live-overlay-min-btn");
    closeBtnEl = overlay.querySelector(".live-overlay-close-btn");
    failureCardEl = overlay.querySelector(".live-overlay-failure-card");
    failureReasonEl = overlay.querySelector(".live-overlay-failure-reason");
    cancelBtnEl = overlay.querySelector(".live-overlay-cancel-btn");
    retryBtnEl = overlay.querySelector(".live-overlay-retry-btn");
    interpretBtnEl = overlay.querySelector(".live-overlay-interpret-btn");
    interpretNoticeEl = overlay.querySelector(".live-overlay-interpret-notice");
    messagesEl = overlay.querySelector(".live-overlay-messages");
    scrollBottomBtnEl = overlay.querySelector(".live-overlay-scroll-bottom-btn");
  }

  function syncInterpretButton(): void {
    if (!interpretBtnEl) return;
    const shouldShow = deps.shouldShowInterpret?.() === true;
    const controller = shouldShow ? deps.getInterpretController?.() : null;
    interpretBtnEl.hidden = !shouldShow || !controller;
    if (!controller) return;

    const interpretState = controller.getState();
    const availability = controller.getAvailability();
    const active = interpretState === "connecting" || interpretState === "connected";
    const unavailable = !availability.ok && !active;
    if (interpretState === "connecting" && interpretNoticeEl) {
      if (interpretNoticeTimer !== null) clearTimeout(interpretNoticeTimer);
      interpretNoticeTimer = null;
      interpretNoticeEl.hidden = true;
      interpretNoticeEl.textContent = "";
    }
    interpretBtnEl.classList.toggle("is-active", interpretState === "connected");
    interpretBtnEl.classList.toggle("is-connecting", interpretState === "connecting");
    interpretBtnEl.setAttribute("aria-pressed", String(interpretState === "connected"));
    interpretBtnEl.setAttribute("aria-busy", String(interpretState === "connecting"));
    interpretBtnEl.setAttribute("aria-disabled", String(unavailable));
    if (!availability.ok) {
      interpretBtnEl.setAttribute("aria-description", availability.error);
    } else {
      interpretBtnEl.removeAttribute("aria-description");
    }
    interpretBtnEl.title = unavailable && !availability.ok
      ? availability.error
      : interpretState === "connecting"
        ? "正在连接实时翻译..."
        : interpretState === "connected"
          ? "关闭实时翻译"
          : "开启实时翻译";
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
        }
      });
    }

    micBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      const controller = deps.getLiveController();
      controller?.toggleMute();
      syncMicButton();
    });

    interpretBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (interpretBtnEl?.getAttribute("aria-disabled") === "true") return;
      void deps.getInterpretController?.()?.toggle();
    });

    audioBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!audioPopEl) return;
      const willOpen = audioPopEl.hidden;
      audioPopEl.hidden = !willOpen;
      if (rootEl) {
        if (willOpen) {
          rootEl.dataset.popoverOpen = "1";
        } else {
          delete rootEl.dataset.popoverOpen;
        }
      }
      if (willOpen) {
        syncAudioControls();
      }
    });

    audioPopEl?.addEventListener("click", (e) => {
      e.stopPropagation();
    });

    const onVolumeInput = (e: Event) => {
      e.stopPropagation();
      const target = e.target as HTMLInputElement;
      const val = Math.max(0, Math.min(200, Math.round(Number(target.value) || 0)));
      syncVolumeDisplay(val);
      deps.getLiveController()?.setVolume(val / 100);
      deps.onVolumeChange?.(val);
    };
    volumeSliderEl?.addEventListener("input", onVolumeInput);
    volumeSliderEl?.addEventListener("change", onVolumeInput);

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
      const interpretState = deps.getInterpretController?.()?.getState();
      if (interpretState === "connecting" || interpretState === "connected") {
        syncState("idle");
      } else {
        hide();
      }
    };

    closeBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      stopCompanion();
    });

    cancelBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      stopCompanion();
    });

    retryBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (deps.onRetryLive) {
        deps.onRetryLive();
      } else {
        void deps.getLiveController()?.start();
      }
    });

    messagesEl?.addEventListener("scroll", updateScrollFollowState, { passive: true });
    scrollBottomBtnEl?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (messagesEl && typeof messagesEl.scrollTo === "function") {
        messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: "smooth" });
      } else if (messagesEl) {
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
      isScrolledToBottom = true;
      if (scrollBottomBtnEl) {
        scrollBottomBtnEl.hidden = true;
      }
    });
  }

  function bindCapsuleEvents(capsule: HTMLElement): void {
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
    capsule.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        restore();
      }
    });
  }

  function resolveCurrentVolume(): number {
    if (deps.getVolume) {
      return Math.round(Math.max(0, Math.min(200, deps.getVolume())));
    }
    const c = deps.getLiveController();
    if (c?.getVolume) {
      return Math.round(Math.max(0, Math.min(2, c.getVolume())) * 100);
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

  function syncMicButton(): void {
    const controller = deps.getLiveController();
    if (!controller || !micBtnEl) return;
    const isMuted = controller.isMuted();
    micBtnEl.setAttribute("aria-pressed", String(isMuted));
    micBtnEl.setAttribute("title", isMuted ? "取消静音麦克风" : "麦克风静音");
    micBtnEl.setAttribute("aria-label", isMuted ? "取消静音麦克风" : "麦克风静音");
  }

  function syncAudioControls(): void {
    const controller = deps.getLiveController();
    if (!controller) return;

    syncMicButton();
    syncVolumeDisplay(resolveCurrentVolume());
    syncSpeedDisplay(controller.getSpeed());

    if (shareAudioSwitchEl) {
      const share = controller.isSharingVideoAudio();
      shareAudioSwitchEl.setAttribute("aria-checked", String(share));
      shareAudioSwitchEl.classList.toggle("is-active", share);
    }
    if (voicePrioritySwitchEl) {
      const prio = controller.isVoicePriority();
      voicePrioritySwitchEl.setAttribute("aria-checked", String(prio));
      voicePrioritySwitchEl.classList.toggle("is-active", prio);
    }
  }

  function minimize(): void {
    isMin = true;
    if (rootEl) {
      rootEl.hidden = true;
      rootEl.classList.add("is-hidden");
      delete rootEl.dataset.popoverOpen;
    }
    if (audioPopEl) {
      audioPopEl.hidden = true;
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.hidden = false;
      miniCapsuleEl.classList.remove("is-hidden");
      if (savedOffset) {
        applyOffset(miniCapsuleEl, savedOffset);
      }
    }
    syncState();
  }

  function restore(): void {
    isMin = false;
    if (miniCapsuleEl) {
      miniCapsuleEl.hidden = true;
      miniCapsuleEl.classList.add("is-hidden");
    }
    show({ forceExpand: true });
  }

  function show(options?: { forceExpand?: boolean }): void {
    const el = ensureMounted();
    if (options?.forceExpand) {
      isMin = false;
    }
    if (isMin) {
      el.hidden = true;
      el.classList.add("is-hidden");
      if (miniCapsuleEl) {
        miniCapsuleEl.hidden = false;
        miniCapsuleEl.classList.remove("is-hidden");
        if (savedOffset) {
          applyOffset(miniCapsuleEl, savedOffset);
        }
      }
    } else {
      el.hidden = false;
      el.classList.remove("is-hidden");
      if (miniCapsuleEl) {
        miniCapsuleEl.hidden = true;
        miniCapsuleEl.classList.add("is-hidden");
      }
      if (savedOffset) {
        applyOffset(el, savedOffset);
      }
      glassLens.sync(el);
    }
    syncState();
  }

  function hide(): void {
    isMin = true;
    if (rootEl) {
      rootEl.hidden = true;
      rootEl.classList.add("is-hidden");
      delete rootEl.dataset.popoverOpen;
    }
    if (miniCapsuleEl) {
      miniCapsuleEl.hidden = true;
      miniCapsuleEl.classList.add("is-hidden");
    }
    if (audioPopEl) {
      audioPopEl.hidden = true;
    }
    if (scrollBottomBtnEl) {
      scrollBottomBtnEl.hidden = true;
    }
  }

  function toggle(): void {
    if (isVisible()) {
      hide();
    } else {
      show();
    }
  }

  function syncState(customState?: LiveChatState, reconnecting?: boolean, error?: string): void {
    if (error !== undefined) {
      lastFailureError = error;
    }
    if (!rootEl) return;
    syncInterpretButton();
    const controller = deps.getLiveController();
    const state = customState ?? controller?.getState() ?? "idle";
    const isReconnecting = reconnecting ?? Boolean(controller?.isReconnecting?.());
    if (state !== "failure") {
      lastFailureError = undefined;
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

    if (!statusTextEl || !statusDotEl) return;

    statusDotEl.className = "live-overlay-status-dot";

    if (isReconnecting) {
      statusTextEl.textContent = "重连中...";
      statusDotEl.classList.add("is-reconnecting");
    } else if (state === "connecting") {
      statusTextEl.textContent = "连接中...";
      statusDotEl.classList.add("is-connecting");
    } else if (state === "connected") {
      statusTextEl.textContent = "正在陪看";
      statusDotEl.classList.add("is-connected");
    } else if (state === "failure") {
      statusTextEl.textContent = "连接异常";
      statusDotEl.classList.add("is-failure");
    } else {
      statusTextEl.textContent = "已就绪";
    }

    if (failureCardEl) {
      const showFailure = state === "failure" && !isReconnecting;
      failureCardEl.hidden = !showFailure;
      if (showFailure && failureReasonEl) {
        failureReasonEl.textContent = lastFailureError || "伴看连接失败，请重试";
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
      micBtnEl.classList.toggle("is-talking", active && !isMuted);
    }
  }

  function updateTranscript(event: MossLiveTranscriptEvent): void {
    transcriptMerger.handleEvent(event);
  }

  function clearMessages(): void {
    if (messagesEl) {
      messagesEl.innerHTML = "";
    }
    transcriptMerger.resetActiveTurns?.();
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
      }, autoHideMs);
    }
  }

  function dispose(): void {
    if (interpretNoticeTimer !== null) clearTimeout(interpretNoticeTimer);
    interpretNoticeTimer = null;
    interpretNoticeEl = null;
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
    clearMessages,
    getElement,
    getMiniCapsuleElement: () => miniCapsuleEl,
    dispose
  };
}
