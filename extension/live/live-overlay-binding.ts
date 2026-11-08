// extension/live/live-overlay-binding.ts
// 视频页与直播间共用的实时伴看浮窗、全屏生命周期与音频偏好协调模块。
// 统一管理：
// 1. 播放器容器宿主查找与 FullscreenLiveOverlay 懒创建
// 2. LiveChatController 的 VAD / 转写 / 重连 / 连接状态显隐与自动接线（bindControllerCallbacks）
// 3. 视频页全屏模式观察（player-fullscreen）、data-biliscript-fullscreen-mode 属性维护与退全屏恢复
// 4. 伴看音频偏好（音量、语音优先、分享视频原声）单点持久化（persistLiveAudioSettings）

import { isPlayerFullscreen, observeFullscreenChanges } from "../bilibili/fullscreen.js";
import { state } from "../core/state.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { Settings } from "../core/defaults.js";
import {
  createFullscreenLiveOverlay,
  type FullscreenLiveOverlay
} from "./fullscreen-live-overlay.js";
import type {
  LiveChatController,
  LiveChatControllerDeps,
  LiveChatState
} from "./live-chat-controller.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";

export const DEFAULT_LIVE_OVERLAY_HOST_SELECTOR =
  ".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap, #live-player, .live-player-mounter, #live-player-ctnr";

export function findDefaultLiveOverlayHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(DEFAULT_LIVE_OVERLAY_HOST_SELECTOR);
}

export interface LiveAudioSettingsPatch {
  liveVoiceVolume?: number;
  liveVoicePriority?: boolean;
  liveShareVideoAudio?: boolean;
}

export function persistLiveAudioSettings(patch: LiveAudioSettingsPatch): void {
  state.patchSettings(patch as Partial<Settings>);
  void sendRuntimeMessage({
    type: "save-settings",
    settings: patch
  }).catch(() => null);
}

function setFullscreenModeDomAttribute(enabled: boolean): void {
  if (typeof document === "undefined") return;
  if (enabled) {
    document.documentElement?.setAttribute("data-biliscript-fullscreen-mode", "1");
    document.body?.setAttribute("data-biliscript-fullscreen-mode", "1");
  } else {
    document.documentElement?.removeAttribute("data-biliscript-fullscreen-mode");
    document.body?.removeAttribute("data-biliscript-fullscreen-mode");
  }
}

export interface LiveOverlayControllerHooks {
  onStateChange?: (liveState: LiveChatState) => void;
  onVadStateChange?: (active: boolean) => void;
  onVoicePriorityChange?: (enabled: boolean) => void;
  onShareVideoAudioChange?: (enabled: boolean) => void;
}

export type BoundLiveControllerCallbacks = Pick<
  LiveChatControllerDeps,
  | "onVadStateChange"
  | "onTranscript"
  | "onReconnecting"
  | "onStateChange"
  | "onVoicePriorityChange"
  | "onShareVideoAudioChange"
>;

export interface LiveOverlayBindingOptions {
  getPlayerHost?: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  /**
   * 浮窗自动唤起策略：
   * - "always"（默认，用于直播间）：连接中/已连接即展示浮窗
   * - "player-fullscreen"（用于视频播放页）：仅在播放器全屏时自动展示浮窗，并维护全屏状态监听与退全屏回调
   */
  fullscreenMode?: "always" | "player-fullscreen";
  onExitFullscreenWhileLive?: () => void | Promise<void>;
  shouldAutoShow?: () => boolean;
  onBeforeAutoShow?: () => void;
  onVoicePrioritySync?: (enabled: boolean) => void;
  onShareVideoAudioSync?: (enabled: boolean) => void;
  getVolume?: () => number;
  onVolumeSync?: (volumePercent: number) => void;
  createOverlay?: typeof createFullscreenLiveOverlay;
}

export interface LiveOverlayBinding {
  getOverlay(): FullscreenLiveOverlay | null;
  ensureOverlay(): FullscreenLiveOverlay;
  initFullscreenObserver(): void;
  stopFullscreenObserver(): void;
  startOrRestoreCompanion(): Promise<boolean>;
  bindControllerCallbacks(hooks?: LiveOverlayControllerHooks): BoundLiveControllerCallbacks;
  handleVadChange(active: boolean): void;
  handleTranscript(event: MossLiveTranscriptEvent): void;
  handleReconnecting(): void;
  handleStateChange(liveState: LiveChatState): void;
  handleVoicePriorityChange(enabled: boolean): void;
  handleShareVideoAudioChange(enabled: boolean): void;
  clearMessages(): void;
  dispose(): void;
}

export function createLiveOverlayBinding(options: LiveOverlayBindingOptions): LiveOverlayBinding {
  const getPlayerHost = options.getPlayerHost ?? findDefaultLiveOverlayHost;
  const createOverlayFn = options.createOverlay ?? createFullscreenLiveOverlay;
  const fullscreenMode = options.fullscreenMode ?? "always";
  let overlay: FullscreenLiveOverlay | null = null;
  let overlayManuallyClosed = false;
  let unobserveFullscreen: (() => void) | null = null;

  function isControllerLive(): boolean {
    const liveState = options.getLiveController()?.getState();
    return liveState === "connecting" || liveState === "connected";
  }

  function initFullscreenObserver(): void {
    if (fullscreenMode !== "player-fullscreen" || unobserveFullscreen) return;
    unobserveFullscreen = observeFullscreenChanges((isFullscreen) => {
      const isLive = isControllerLive();
      if (isFullscreen) {
        setFullscreenModeDomAttribute(true);
        if (isLive && !overlayManuallyClosed) {
          ensureOverlay().show();
        }
      } else {
        setFullscreenModeDomAttribute(false);
        overlayManuallyClosed = false;
        overlay?.hide();
        if (isLive) {
          void options.onExitFullscreenWhileLive?.();
        }
      }
    });
  }

  function stopFullscreenObserver(): void {
    if (unobserveFullscreen) {
      unobserveFullscreen();
      unobserveFullscreen = null;
    }
    if (fullscreenMode === "player-fullscreen") {
      setFullscreenModeDomAttribute(false);
    }
  }

  function handleVolumeChange(volumePercent: number): void {
    options.onVolumeSync?.(volumePercent);
    persistLiveAudioSettings({ liveVoiceVolume: volumePercent });
  }

  function ensureOverlay(): FullscreenLiveOverlay {
    if (fullscreenMode === "player-fullscreen") {
      initFullscreenObserver();
    }
    if (!overlay) {
      overlay = createOverlayFn({
        getPlayerHost,
        getLiveController: options.getLiveController,
        getVolume: options.getVolume ?? (() => state.settings?.liveVoiceVolume ?? 100),
        onVolumeChange: handleVolumeChange,
        onStopLive: () => {
          void options.getLiveController()?.stop();
        }
      });
    }
    return overlay;
  }

  function shouldAutoShowOverlay(): boolean {
    if (options.shouldAutoShow) {
      return options.shouldAutoShow();
    }
    if (fullscreenMode === "player-fullscreen") {
      return isPlayerFullscreen() && !overlayManuallyClosed;
    }
    return true;
  }

  function handleVadChange(active: boolean): void {
    overlay?.updateVad(active);
  }

  function handleTranscript(event: MossLiveTranscriptEvent): void {
    overlay?.updateTranscript(event);
  }

  function handleReconnecting(): void {
    overlay?.syncState(options.getLiveController()?.getState(), true);
  }

  function handleStateChange(liveState: LiveChatState): void {
    overlay?.syncState(liveState);
    if (liveState === "connected" || liveState === "connecting") {
      if (shouldAutoShowOverlay()) {
        if (fullscreenMode === "player-fullscreen") {
          initFullscreenObserver();
          setFullscreenModeDomAttribute(true);
        }
        options.onBeforeAutoShow?.();
        ensureOverlay().show();
      }
    } else {
      overlay?.hide();
    }
  }

  function handleVoicePriorityChange(enabled: boolean): void {
    options.onVoicePrioritySync?.(enabled);
    persistLiveAudioSettings({ liveVoicePriority: enabled });
  }

  function handleShareVideoAudioChange(enabled: boolean): void {
    options.onShareVideoAudioSync?.(enabled);
    persistLiveAudioSettings({ liveShareVideoAudio: enabled });
  }

  async function startOrRestoreCompanion(): Promise<boolean> {
    const controller = options.getLiveController();
    if (!controller) return false;
    overlayManuallyClosed = false;

    const alreadyLive = isControllerLive();
    const started = alreadyLive ? true : await controller.start();
    if (!started) return false;

    if (fullscreenMode === "always" || isPlayerFullscreen()) {
      if (fullscreenMode === "player-fullscreen") {
        initFullscreenObserver();
        setFullscreenModeDomAttribute(true);
      }
      const targetOverlay = ensureOverlay();
      if (alreadyLive) {
        targetOverlay.restore();
      } else {
        targetOverlay.show();
      }
    }
    return true;
  }

  function bindControllerCallbacks(
    hooks?: LiveOverlayControllerHooks
  ): BoundLiveControllerCallbacks {
    return {
      onVadStateChange: (active) => {
        hooks?.onVadStateChange?.(active);
        handleVadChange(active);
      },
      onTranscript: handleTranscript,
      onReconnecting: handleReconnecting,
      onStateChange: (liveState) => {
        hooks?.onStateChange?.(liveState);
        handleStateChange(liveState);
      },
      onVoicePriorityChange: (enabled) => {
        hooks?.onVoicePriorityChange?.(enabled);
        handleVoicePriorityChange(enabled);
      },
      onShareVideoAudioChange: (enabled) => {
        hooks?.onShareVideoAudioChange?.(enabled);
        handleShareVideoAudioChange(enabled);
      }
    };
  }

  function clearMessages(): void {
    overlay?.clearMessages();
  }

  function dispose(): void {
    stopFullscreenObserver();
    overlay?.dispose();
    overlay = null;
  }

  return {
    getOverlay: () => overlay,
    ensureOverlay,
    initFullscreenObserver,
    stopFullscreenObserver,
    startOrRestoreCompanion,
    bindControllerCallbacks,
    handleVadChange,
    handleTranscript,
    handleReconnecting,
    handleStateChange,
    handleVoicePriorityChange,
    handleShareVideoAudioChange,
    clearMessages,
    dispose
  };
}
