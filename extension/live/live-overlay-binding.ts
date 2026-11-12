// extension/live/live-overlay-binding.ts
// 视频页与直播间共用的实时伴看浮窗、字幕翻译入口与音频偏好协调模块。
// 统一管理：
// 1. 播放器容器宿主查找与 FullscreenLiveOverlay 懒创建
// 2. LiveChatController 的 VAD / 转写 / 重连 / 连接状态显隐与自动接线（bindControllerCallbacks）
// 3. 伴看音频偏好（音量、语音优先、分享视频原声）单点持久化（persistLiveAudioSettings）
// 4. 视频页字幕翻译快捷按钮的连接状态与可用性同步

import { state } from "../core/state.js";
import { persistLiveAudioSettings } from "./live-audio-settings.js";
import {
  createFullscreenLiveOverlay,
  type FullscreenLiveOverlay,
  type FullscreenLiveOverlayDeps
} from "./fullscreen-live-overlay.js";
import type {
  LiveChatController,
  LiveChatControllerDeps,
  LiveChatState,
  LiveReconnectingInfo
} from "./live-chat-controller.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";
import type { LiveFailureKind } from "./live-session-tracker.js";
import type { InterpretSessionController } from "./interpret-session-controller.js";

export const DEFAULT_LIVE_OVERLAY_HOST_SELECTOR =
  ".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap, #live-player, .live-player-mounter, #live-player-ctnr";

export function syncPlayerLiveQuickActionState(active: boolean): void {
  if (typeof document === "undefined") return;
  document.body.toggleAttribute("data-biliscript-live-active", active);
  const btn = document.getElementById("biliscript-player-live-quick-action");
  const wrap = document.getElementById("biliscript-player-live-quick-action-wrap");
  btn?.classList.toggle("is-active", active);
  wrap?.classList.toggle("is-active", active);
  btn?.setAttribute("aria-pressed", String(active));
  if (btn) {
    const label = active ? "实时伴看 (已开启)" : "实时伴看";
    btn.title = label;
    btn.setAttribute("aria-label", label);
  }
}

export function syncPlayerInterpretQuickActionState(
  controller: InterpretSessionController | null,
  shouldShow: boolean
): void {
  const button = document.getElementById("biliscript-player-interpret-quick-action");
  const wrap = document.getElementById("biliscript-player-interpret-quick-action-wrap");
  if (!(button instanceof HTMLButtonElement) || !wrap) return;
  wrap.hidden = !shouldShow;
  button.hidden = !shouldShow;
  if (!shouldShow || !controller) return;

  const interpretState = controller.getState();
  const availability = controller.getAvailability();
  const active = interpretState === "connecting" || interpretState === "connected";
  const unavailable = !availability.ok && !active;
  button.classList.toggle("is-active", interpretState === "connected");
  button.classList.toggle("is-connecting", interpretState === "connecting");
  button.setAttribute("aria-pressed", String(interpretState === "connected"));
  button.setAttribute("aria-busy", String(interpretState === "connecting"));
  button.setAttribute("aria-disabled", String(unavailable));
  if (!availability.ok) {
    button.setAttribute("aria-description", availability.error);
  } else {
    button.removeAttribute("aria-description");
  }
  const label = interpretState === "connecting"
    ? "正在连接实时翻译..."
    : interpretState === "connected"
      ? "关闭实时翻译"
      : "字幕";
  button.title = unavailable && !availability.ok ? availability.error : label;
  button.setAttribute("aria-label", label);
}

export function findDefaultLiveOverlayHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(DEFAULT_LIVE_OVERLAY_HOST_SELECTOR);
}

export interface LiveOverlayControllerHooks {
  onStateChange?: (liveState: LiveChatState, error?: string, failureKind?: LiveFailureKind) => void;
  onReconnecting?: (info: LiveReconnectingInfo) => void;
  onVadStateChange?: (active: boolean) => void;
  onVoicePriorityChange?: (enabled: boolean) => void;
  onShareVideoAudioChange?: (enabled: boolean) => void;
  onVideoAudioStatusChange?: LiveChatControllerDeps["onVideoAudioStatusChange"];
}

export type BoundLiveControllerCallbacks = Pick<
  LiveChatControllerDeps,
  | "onVadStateChange"
  | "onTranscript"
  | "onVideoContextSwitch"
  | "onReconnecting"
  | "onStateChange"
  | "onVolumeChange"
  | "onSpeedChange"
  | "onVoicePriorityChange"
  | "onShareVideoAudioChange"
  | "onVideoAudioStatusChange"
>;

export interface LiveOverlayBindingOptions {
  getPlayerHost?: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  shouldAutoShow?: () => boolean;
  onBeforeAutoShow?: () => void;
  onVoicePrioritySync?: (enabled: boolean) => void;
  onShareVideoAudioSync?: (enabled: boolean) => void;
  getVolume?: () => number;
  onVolumeSync?: (volumePercent: number) => void;
  onSpeedSync?: (speed: number) => void;
  onOpenLiveSettings?: FullscreenLiveOverlayDeps["onOpenLiveSettings"];
  createOverlay?: typeof createFullscreenLiveOverlay;
}

export interface LiveOverlayBinding {
  getOverlay(): FullscreenLiveOverlay | null;
  ensureOverlay(): FullscreenLiveOverlay;
  startOrRestoreCompanion(): Promise<boolean>;
  bindControllerCallbacks(hooks?: LiveOverlayControllerHooks): BoundLiveControllerCallbacks;
  handleVadChange(active: boolean): void;
  handleTranscript(event: MossLiveTranscriptEvent): void;
  handleReconnecting(): void;
  handleStateChange(liveState: LiveChatState, error?: string, failureKind?: LiveFailureKind): void;
  handleVoicePriorityChange(enabled: boolean): void;
  handleShareVideoAudioChange(enabled: boolean): void;
  clearMessages(): void;
  dispose(): void;
}

export function createLiveOverlayBinding(options: LiveOverlayBindingOptions): LiveOverlayBinding {
  const getPlayerHost = options.getPlayerHost ?? findDefaultLiveOverlayHost;
  const createOverlayFn = options.createOverlay ?? createFullscreenLiveOverlay;
  let overlay: FullscreenLiveOverlay | null = null;
  let lastLiveState: LiveChatState = "idle";
  let retryInProgress = false;

  function isControllerLive(): boolean {
    const liveState = options.getLiveController()?.getState();
    return liveState === "connecting" || liveState === "connected";
  }

  function handleVolumeChange(volumePercent: number): void {
    options.onVolumeSync?.(volumePercent);
    persistLiveAudioSettings({ liveVoiceVolume: volumePercent });
  }

  function handleSpeedChange(speed: number): void {
    options.onSpeedSync?.(speed);
    if (state.settings?.liveVoiceSpeed !== speed) {
      persistLiveAudioSettings({ liveVoiceSpeed: speed });
    }
  }

  function ensureOverlay(): FullscreenLiveOverlay {
    if (!overlay) {
      overlay = createOverlayFn({
        getPlayerHost,
        getLiveController: options.getLiveController,
        getVolume: options.getVolume ?? (() => state.settings?.liveVoiceVolume ?? 100),
        onVolumeChange: handleVolumeChange,
        onSpeedChange: handleSpeedChange,
        onOpenLiveSettings: options.onOpenLiveSettings,
        onStopLive: () => {
          void options.getLiveController()?.stop();
        },
        onRetryLive: () => {
          const controller = options.getLiveController();
          if (!controller) return;
          retryInProgress = true;
          void (async () => {
            try {
              await controller.stop();
              await controller.start();
            } finally {
              retryInProgress = false;
            }
          })();
        }
      });
    }
    return overlay;
  }

  function shouldAutoShowOverlay(): boolean {
    if (options.shouldAutoShow) {
      return options.shouldAutoShow();
    }
    return true;
  }

  function handleVadChange(active: boolean): void {
    overlay?.updateVad(active);
  }

  function handleTranscript(event: MossLiveTranscriptEvent): void {
    overlay?.updateTranscript(event);
  }

  function handleVideoContextSwitch(context: import("./moss-live-protocol.js").MossLiveSessionContext | null): void {
    if (context) {
      overlay?.showVideoContextSwitch(context);
    } else {
      overlay?.clearMessages();
    }
  }

  function handleReconnecting(): void {
    overlay?.syncState(options.getLiveController()?.getState(), true);
  }

  function handleStateChange(liveState: LiveChatState, error?: string, failureKind?: LiveFailureKind): void {
    const active = liveState === "connected" || liveState === "connecting";
    const shouldShowOverlay = active || liveState === "failure";
    syncPlayerLiveQuickActionState(active);
    if (shouldShowOverlay) {
      if (shouldAutoShowOverlay()) {
        options.onBeforeAutoShow?.();
        const targetOverlay = ensureOverlay();
        const forceExpand = (lastLiveState === "idle" && !retryInProgress) || !targetOverlay.isVisible();
        targetOverlay.show({ forceExpand });
        targetOverlay.syncState(liveState, false, error, failureKind);
      } else {
        overlay?.syncState(liveState, false, error, failureKind);
      }
    } else {
      overlay?.syncState(liveState, false, undefined);
      if (!retryInProgress) overlay?.hide();
    }
    lastLiveState = liveState;
  }

  function handleVoicePriorityChange(enabled: boolean): void {
    options.onVoicePrioritySync?.(enabled);
    if (state.settings?.liveVoicePriority !== enabled) {
      persistLiveAudioSettings({ liveVoicePriority: enabled });
    }
  }

  function handleShareVideoAudioChange(enabled: boolean): void {
    options.onShareVideoAudioSync?.(enabled);
    if (state.settings?.liveShareVideoAudio !== enabled) {
      persistLiveAudioSettings({ liveShareVideoAudio: enabled });
    }
  }

  async function startOrRestoreCompanion(): Promise<boolean> {
    const controller = options.getLiveController();
    if (!controller) return false;

    const alreadyLive = isControllerLive();
    const wasVisible = overlay?.isVisible() ?? false;
    const started = alreadyLive ? true : await controller.start();
    if (!started) {
      if (controller.getState() === "failure" && shouldAutoShowOverlay()) {
        const targetOverlay = ensureOverlay();
        targetOverlay.show({ forceExpand: true });
        targetOverlay.syncState("failure");
      }
      return false;
    }

    const targetOverlay = ensureOverlay();
    if (alreadyLive) {
      targetOverlay.restore();
    } else {
      targetOverlay.show({ forceExpand: !wasVisible || !targetOverlay.isVisible() });
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
      onVideoContextSwitch: handleVideoContextSwitch,
      onReconnecting: (info) => {
        hooks?.onReconnecting?.(info);
        handleReconnecting();
      },
      onStateChange: (liveState, error, failureKind) => {
        if (error !== undefined) {
          hooks?.onStateChange?.(liveState, error, failureKind);
        } else {
          hooks?.onStateChange?.(liveState);
        }
        handleStateChange(liveState, error, failureKind);
      },
      onVolumeChange: (volumePercent) => {
        options.onVolumeSync?.(volumePercent);
        overlay?.syncState();
      },
      onSpeedChange: (speed) => {
        handleSpeedChange(speed);
        overlay?.syncState();
      },
      onVoicePriorityChange: (enabled) => {
        hooks?.onVoicePriorityChange?.(enabled);
        handleVoicePriorityChange(enabled);
      },
      onShareVideoAudioChange: (enabled) => {
        hooks?.onShareVideoAudioChange?.(enabled);
        handleShareVideoAudioChange(enabled);
      },
      onVideoAudioStatusChange: (status) => {
        hooks?.onVideoAudioStatusChange?.(status);
        overlay?.syncState();
      }
    };
  }

  function clearMessages(): void {
    overlay?.clearMessages();
  }

  function dispose(): void {
    syncPlayerLiveQuickActionState(false);
    overlay?.dispose();
    overlay = null;
  }

  return {
    getOverlay: () => overlay,
    ensureOverlay,
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
