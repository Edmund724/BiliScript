// extension/live/live-companion-session.ts
// 视频页实时会话组装根：伴看与字幕翻译各自持有独立控制器，共享浮窗宿主与页面生命周期。
// 播放器快捷按钮与 AI 对话面板均消费伴看控制器；关闭文摘面板不销毁会话；pagehide 统一释放。

import { state } from "../core/state.js";
import { normalizeLiveVoiceSpeed, normalizeLiveVoiceVolume } from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
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
import { ensureReaderShell } from "../reader/lazy-shell.js";
import type { FullscreenLiveOverlay, LiveSettingsTarget } from "./fullscreen-live-overlay.js";
import { createInterpretSubtitleOverlay } from "./interpret-subtitle-overlay.js";
import {
  closeInterpretSubtitleMenu,
  syncInterpretSubtitleMenu,
  type InterpretSubtitleMenuChoice
} from "./interpret-subtitle-menu.js";
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
  syncPlayerInterpretQuickActionState,
  type LiveOverlayBinding,
  type LiveOverlayControllerHooks
} from "./live-overlay-binding.js";
import { createLiveToolsBridge } from "./live-tools-bridge.js";
import { persistLiveTextToolRecord } from "./live-text-tool-history-storage.js";
import { watchLiveAudioSettings } from "./live-audio-settings.js";

export interface LiveSessionConsumerHooks {
  showNotice?: (message: string, autoHideMs?: number) => void;
  onBeforeStart?: () => void;
  onStateChange?: LiveOverlayControllerHooks["onStateChange"];
  onReconnecting?: () => void;
}

let liveController: LiveChatController | null = null;
let interpretController: InterpretSessionController | null = null;
let sessionHooks: LiveSessionConsumerHooks | null = null;
let unsubscribeStorageWatcher: (() => void) | null = null;
let unsubscribeAudioSettingsWatcher: (() => void) | null = null;
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

export function syncPlayerInterpretQuickAction(): void {
  bindLifecycleListeners();
  const shouldShow = shouldShowInterpret();
  const controller = shouldShow ? ensureInterpretController() : interpretController;
  syncPlayerInterpretQuickActionState(controller, shouldShow);
  if (!shouldShow) {
    closeInterpretSubtitleMenu();
  } else {
    void syncInterpretSubtitleMenu();
  }
}

function ensureInterpretController(): InterpretSessionController {
  if (!interpretController) {
    interpretController = createInterpretSessionController({
      getTargetLang: () => state.settings?.liveInterpretTargetLang || "zh",
      getDisplayMode: () => state.settings?.liveInterpretDisplayMode || "auto",
      showNotice: (message, autoHideMs) => {
        if (sessionHooks?.showNotice) {
          sessionHooks.showNotice(message, autoHideMs);
        } else {
          interpretSubtitleOverlay.showNotice(message, autoHideMs);
        }
      },
      setSubtitle: interpretSubtitleOverlay.setSubtitle,
      clearSubtitles: interpretSubtitleOverlay.clear,
      clearSubtitlesOnSeek: interpretSubtitleOverlay.clearForSeek,
      onStateChange: syncPlayerInterpretQuickAction,
      onAvailabilityChange: syncPlayerInterpretQuickAction
    });
    bindLifecycleListeners();
    void interpretController.refreshAvailability();
  }
  return interpretController;
}

export async function toggleInterpret(): Promise<void> {
  await ensureInterpretController().toggle();
}

// ===== 播放器「字幕」菜单接线（interpret-subtitle-menu 的 deps 实现）=====

export function getInterpretSessionState(): "idle" | "connecting" | "connected" {
  return interpretController?.getState() ?? "idle";
}

export async function applyInterpretMenuChoice(
  choice: InterpretSubtitleMenuChoice
): Promise<void> {
  const controller = ensureInterpretController();
  if (choice.kind === "off") {
    await controller.stop();
    return;
  }

  const prevLang = String(state.settings?.liveInterpretTargetLang || "zh");
  const langChanged = choice.targetLang !== prevLang;
  const patch = {
    liveInterpretTargetLang: choice.targetLang,
    liveInterpretDisplayMode: (choice.kind === "bilingual" ? "bilingual" : "translation") as
      | "bilingual"
      | "translation"
  };
  state.patchSettings(patch);
  void sendRuntimeMessage({ type: "save-settings", settings: patch }).catch(() => null);

  const sessionState = controller.getState();
  if (sessionState === "idle") {
    // 选语言/开双语即开启会话；平台缺失时 start 内部提示可读错误
    await controller.start();
  } else if (langChanged) {
    // 译文缓存按目标语言键命中，重启直接复用已翻分片
    await controller.stop();
    await controller.start();
  }
  // 同语言仅切显示模式：浮层按新设置即时重算，无需重启
}

const liveOverlayBinding = createLiveOverlayBinding({
  getPlayerHost,
  getLiveController: () => liveController,
  onOpenLiveSettings: (target) => {
    void openLiveCompanionSettings(target);
  }
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
        syncPlayerInterpretQuickAction();
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
  if (!unsubscribeAudioSettingsWatcher) {
    unsubscribeAudioSettingsWatcher = watchLiveAudioSettings(
      () => liveController,
      () => liveOverlayBinding.getOverlay()?.syncState()
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

export async function openLiveCompanionSettings(target: LiveSettingsTarget): Promise<void> {
  if (document.fullscreenElement) {
    await document.exitFullscreen();
  }
  const shell = await ensureReaderShell();
  await shell.enterReaderShell({ readerUrl: "", intent: "open", settingsTarget: target });
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
      ...liveOverlayBinding.bindControllerCallbacks({
        onStateChange: (liveState, error, failureKind) => {
          if (error !== undefined) {
            sessionHooks?.onStateChange?.(liveState, error, failureKind);
          } else {
            sessionHooks?.onStateChange?.(liveState);
          }
        },
        onReconnecting: () => sessionHooks?.onReconnecting?.()
      }),
      showNotice: notifyConsumer,
      getVideoContext: liveToolsBridge.getVideoContext,
      executeTool: liveToolsBridge.executeTool,
      persistTextToolRecord: (record) => persistLiveTextToolRecord(record),
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

export async function retryLiveCompanion(): Promise<boolean> {
  const controller = ensureLiveController();
  await controller.stop();
  return startLiveCompanion();
}

export function restoreLiveCompanionOverlay(): void {
  if (!isLiveCompanionActive()) return;
  liveOverlayBinding.ensureOverlay().restore();
}

export function stopLiveCompanion(): void {
  void liveController?.stop();
}

export function disposeLiveCompanionSession(): void {
  if (unsubscribeStorageWatcher) {
    unsubscribeStorageWatcher();
    unsubscribeStorageWatcher = null;
  }
  unsubscribeAudioSettingsWatcher?.();
  unsubscribeAudioSettingsWatcher = null;
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
  closeInterpretSubtitleMenu();
  interpretSubtitleOverlay.clear();
  interpretSubtitleOverlay.dispose();
  liveOverlayBinding.dispose();
}
