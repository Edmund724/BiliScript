// extension/live/live-companion-session.ts
// 视频页实时会话组装根：伴看与同传各自持有独立控制器，共享浮窗宿主与页面生命周期。
// 播放器快捷按钮与 AI 对话面板均消费伴看控制器；关闭文摘面板不销毁会话；pagehide 统一释放。

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
import { createInterpretSubtitleOverlay } from "./interpret-subtitle-overlay.js";
import {
  createInterpretSessionController,
  type InterpretSessionController
} from "./interpret-session-controller.js";
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
let interpretController: InterpretSessionController | null = null;
let sessionHooks: LiveSessionConsumerHooks | null = null;
let unsubscribeStorageWatcher: (() => void) | null = null;
let unsubscribeInterpretPresenter: (() => void) | null = null;
let pageHideBound = false;

function getPlayerHost(): HTMLElement | null {
  return document.querySelector(".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap");
}

function shouldShowInterpret(): boolean {
  const hasCc = state.clip.subtitles.some((track) =>
    Boolean(track.subtitleUrl) && !String(track.lan || "").startsWith("asr-")
  );
  return !hasCc && (state.clip.subtitleFetchState === "empty" || state.clip.subtitleFetchState === "ready");
}

const interpretSubtitleOverlay = createInterpretSubtitleOverlay({
  getPlayerHost,
  getTargetLang: () => state.settings?.liveInterpretTargetLang || "zh",
  getDisplayMode: () => state.settings?.liveInterpretDisplayMode || "auto"
});

function syncInterpretButton(): void {
  liveOverlayBinding.getOverlay()?.syncState();
}

function ensureInterpretController(): InterpretSessionController {
  if (!interpretController) {
    interpretController = createInterpretSessionController({
      getTargetLang: () => state.settings?.liveInterpretTargetLang || "zh",
      showNotice: (message, autoHideMs) => {
        if (sessionHooks?.showNotice) {
          sessionHooks.showNotice(message, autoHideMs);
        } else {
          liveOverlayBinding.getOverlay()?.showInterpretNotice(message, autoHideMs);
        }
      },
      onTranscript: interpretSubtitleOverlay.handleTranscript,
      clearSubtitles: interpretSubtitleOverlay.clear,
      clearSubtitlesOnSeek: interpretSubtitleOverlay.clearForSeek,
      onStateChange: syncInterpretButton,
      onAvailabilityChange: syncInterpretButton
    });
    bindLifecycleListeners();
    void interpretController.refreshAvailability();
  }
  return interpretController;
}

const liveOverlayBinding = createLiveOverlayBinding({
  getPlayerHost,
  getLiveController: () => liveController,
  getInterpretController: ensureInterpretController,
  shouldShowInterpret
});

function onWindowPageHide(): void {
  disposeLiveCompanionSession();
}

function bindLifecycleListeners(): void {
  setLiveCompanionStopHandler(() => {
    stopLiveCompanion();
  });
  if (!unsubscribeInterpretPresenter) {
    unsubscribeInterpretPresenter = subscribeReaderPresenter((event) => {
      if (event.kind === "reset" || event.kind === "rerender" || event.kind === "subtitle-ready") {
        syncInterpretButton();
      }
    });
  }
  if (!unsubscribeStorageWatcher) {
    unsubscribeStorageWatcher = watchStorageKeys(
      () => {
        void liveController?.refreshTarget();
        void interpretController?.refreshAvailability();
      },
      {
        sync: ["liveProviders", "activeLiveProviderId"],
        local: ["liveProviderKeys"]
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
  unsubscribeInterpretPresenter?.();
  unsubscribeInterpretPresenter = null;
  cancelReaderOverviewSource();
  liveController?.dispose();
  liveController = null;
  interpretController?.dispose();
  interpretController = null;
  interpretSubtitleOverlay.clear();
  interpretSubtitleOverlay.dispose();
  liveOverlayBinding.dispose();
}
