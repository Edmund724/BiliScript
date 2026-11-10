// extension/live/live-companion-session.ts
// 视频页独立实时伴看会话属主：统一持有 LiveChatController、LiveOverlayBinding 与 LiveToolsBridge。
// 播放器快捷按钮与 AI 对话面板均消费本模块，关闭文摘面板不销毁伴看会话；页面卸载（pagehide）时统一释放。

import { state } from "../core/state.js";
import { normalizeLiveVoiceSpeed, normalizeLiveVoiceVolume } from "../core/validators.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import {
  setLiveCompanionStopHandler,
  subscribeReaderPresenter
} from "../reader/reader-bus.js";
import {
  cancelReaderOverviewSource,
  ensureReaderOverviewSource,
  getReaderOverviewSource,
  subscribeReaderOverviewSource
} from "../reader/live-overview-source.js";
import type { FullscreenLiveOverlay } from "./fullscreen-live-overlay.js";
import {
  createLiveChatController,
  type LiveChatController
} from "./live-chat-controller.js";
import {
  createLiveOverlayBinding,
  type LiveOverlayBinding
} from "./live-overlay-binding.js";
import { createLiveToolsBridge } from "./live-tools-bridge.js";

export interface LiveSessionConsumerHooks {
  showNotice?: (message: string, autoHideMs?: number) => void;
  onBeforeStart?: () => void;
}

let liveController: LiveChatController | null = null;
let sessionHooks: LiveSessionConsumerHooks | null = null;
let unsubscribeStorageWatcher: (() => void) | null = null;
let pageHideBound = false;

const liveOverlayBinding = createLiveOverlayBinding({
  getPlayerHost: () =>
    document.querySelector(".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap"),
  getLiveController: () => liveController
});

function onWindowPageHide(): void {
  disposeLiveCompanionSession();
}

function bindLifecycleListeners(): void {
  setLiveCompanionStopHandler(() => {
    stopLiveCompanion();
  });
  if (!unsubscribeStorageWatcher) {
    unsubscribeStorageWatcher = watchStorageKeys(
      () => {
        void liveController?.refreshTarget();
      },
      {
        sync: ["liveProviders", "activeLiveProviderId"]
      }
    );
  }
  if (!pageHideBound && typeof window !== "undefined") {
    window.addEventListener("pagehide", onWindowPageHide);
    pageHideBound = true;
  }
}

export function setLiveSessionHooks(hooks: LiveSessionConsumerHooks | null): void {
  sessionHooks = hooks;
}

export function ensureLiveController(): LiveChatController {
  if (!liveController) {
    const notifyConsumer = (message: string, autoHideMs?: number) => {
      sessionHooks?.showNotice?.(message, autoHideMs);
    };
    const liveToolsBridge = createLiveToolsBridge({
      showNotice: notifyConsumer,
      getOverview: () => getReaderOverviewSource(),
      ensureOverview: (options) => ensureReaderOverviewSource(options)
    });
    liveController = createLiveChatController({
      initialVolume: normalizeLiveVoiceVolume(state.settings?.liveVoiceVolume) / 100,
      initialSpeed: normalizeLiveVoiceSpeed(state.settings?.liveVoiceSpeed),
      initialVoicePriority: state.settings?.liveVoicePriority !== false,
      initialShareVideoAudio: state.settings?.liveShareVideoAudio === true,
      ...liveOverlayBinding.bindControllerCallbacks(),
      showNotice: notifyConsumer,
      getVideoContext: liveToolsBridge.getVideoContext,
      executeTool: liveToolsBridge.executeTool,
      subscribeVideoContextChanges: (listener) => {
        const unsubscribePresenter = subscribeReaderPresenter((event) => {
          if (
            event.kind === "reset" ||
            event.kind === "rerender" ||
            event.kind === "subtitle-ready"
          ) {
            listener();
          }
        });
        const unsubscribeOverview = subscribeReaderOverviewSource(listener);
        return () => {
          unsubscribePresenter();
          unsubscribeOverview();
        };
      }
    });
    bindLifecycleListeners();
    void liveController.refreshTarget();
  }
  return liveController;
}

export function getLiveController(): LiveChatController | null {
  return liveController;
}

export function getLiveOverlayBinding(): LiveOverlayBinding {
  return liveOverlayBinding;
}

export function getFullscreenLiveOverlay(): FullscreenLiveOverlay | null {
  return liveOverlayBinding.getOverlay();
}

export function ensureFullscreenOverlay(): FullscreenLiveOverlay {
  ensureLiveController();
  return liveOverlayBinding.ensureOverlay();
}

export function isLiveCompanionActive(): boolean {
  const s = liveController?.getState();
  return s === "connecting" || s === "connected";
}

export async function startLiveCompanion(): Promise<boolean> {
  ensureLiveController();
  sessionHooks?.onBeforeStart?.();
  return liveOverlayBinding.startOrRestoreCompanion();
}

export function stopLiveCompanion(): void {
  void liveController?.stop();
}

export function disposeLiveCompanionSession(): void {
  if (unsubscribeStorageWatcher) {
    unsubscribeStorageWatcher();
    unsubscribeStorageWatcher = null;
  }
  if (pageHideBound && typeof window !== "undefined") {
    window.removeEventListener("pagehide", onWindowPageHide);
    pageHideBound = false;
  }
  setLiveCompanionStopHandler(null);
  cancelReaderOverviewSource();
  liveController?.dispose();
  liveController = null;
  liveOverlayBinding.dispose();
}
