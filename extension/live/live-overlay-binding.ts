// extension/live/live-overlay-binding.ts
// 视频页与直播间共用的实时伴看浮窗挂载与控制器联动绑定器。
// 统一管理：
// 1. 播放器容器宿主查找与 FullscreenLiveOverlay 懒创建
// 2. LiveChatController 的 VAD / 转写 / 重连 / 连接状态显隐联动
// 3. 浮窗音频快捷开关（语音优先、分享视频原声）的设置同步与持久化

import { state } from "../core/state.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import {
  createFullscreenLiveOverlay,
  type FullscreenLiveOverlay
} from "./fullscreen-live-overlay.js";
import type { LiveChatController, LiveChatState } from "./live-chat-controller.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";

export const DEFAULT_LIVE_OVERLAY_HOST_SELECTOR =
  ".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap, #live-player, .live-player-mounter, #live-player-ctnr";

export function findDefaultLiveOverlayHost(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(DEFAULT_LIVE_OVERLAY_HOST_SELECTOR);
}

export interface LiveOverlayBindingOptions {
  getPlayerHost?: () => HTMLElement | null;
  getLiveController: () => LiveChatController | null;
  getChatHistory?: () => Array<{ role: string; content: string }>;
  onClearHistory?: () => Promise<void> | void;
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
  let overlay: FullscreenLiveOverlay | null = null;

  function handleVolumeChange(volumePercent: number): void {
    options.onVolumeSync?.(volumePercent);
    state.patchSettings({ liveVoiceVolume: volumePercent });
    void sendRuntimeMessage({
      type: "save-settings",
      settings: { liveVoiceVolume: volumePercent }
    }).catch(() => null);
  }

  function ensureOverlay(): FullscreenLiveOverlay {
    if (!overlay) {
      overlay = createOverlayFn({
        getPlayerHost,
        getLiveController: options.getLiveController,
        getChatHistory: options.getChatHistory,
        getVolume: options.getVolume ?? (() => state.settings?.liveVoiceVolume ?? 100),
        onVolumeChange: handleVolumeChange,
        onStopLive: () => {
          void options.getLiveController()?.stop();
        },
        onClearHistory: options.onClearHistory
      });
    }
    return overlay;
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
      const canShow = options.shouldAutoShow ? options.shouldAutoShow() : true;
      if (canShow) {
        options.onBeforeAutoShow?.();
        ensureOverlay().show();
      }
    } else {
      overlay?.hide();
    }
  }

  function handleVoicePriorityChange(enabled: boolean): void {
    options.onVoicePrioritySync?.(enabled);
    state.patchSettings({ liveVoicePriority: enabled });
    void sendRuntimeMessage({
      type: "save-settings",
      settings: { liveVoicePriority: enabled }
    }).catch(() => null);
  }

  function handleShareVideoAudioChange(enabled: boolean): void {
    options.onShareVideoAudioSync?.(enabled);
    state.patchSettings({ liveShareVideoAudio: enabled });
    void sendRuntimeMessage({
      type: "save-settings",
      settings: { liveShareVideoAudio: enabled }
    }).catch(() => null);
  }

  function clearMessages(): void {
    overlay?.clearMessages();
  }

  function dispose(): void {
    overlay?.dispose();
    overlay = null;
  }

  return {
    getOverlay: () => overlay,
    ensureOverlay,
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
