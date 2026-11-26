import {
  ANY_PLAYER_HOST_SELECTOR,
  findAnyPlayerHost
} from "../bilibili/host-selectors.js";
import { state } from "../core/state.js";
import { normalizeLiveVoiceSpeed, normalizeLiveVoiceVolume } from "../core/validators.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { persistLiveAudioSettings, watchLiveAudioSettings } from "./live-audio-settings.js";
import { syncPlayerLiveQuickActionState } from "./player-live-toggle.js";
import {
  createFullscreenLiveOverlay,
  type FullscreenLiveOverlay,
  type FullscreenLiveOverlayDeps
} from "./fullscreen-live-overlay.js";
import {
  createLiveChatController,
  type LiveChatController,
  type LiveChatControllerDeps,
  type LiveChatState,
  type LiveReconnectingInfo
} from "./live-chat-controller.js";
import type { MossLiveSessionContext, MossLiveTranscriptEvent } from "./moss-live-protocol.js";
import type { LiveFailureKind } from "./live-session-tracker.js";

export const DEFAULT_LIVE_OVERLAY_HOST_SELECTOR = ANY_PLAYER_HOST_SELECTOR;

export function findDefaultLiveOverlayHost(): HTMLElement | null {
  return findAnyPlayerHost();
}

export interface LiveOverlayConsumerHooks {
  showNotice?: (message: string, autoHideMs?: number) => void;
  onBeforeStart?: () => void;
  onStateChange?: (liveState: LiveChatState, error?: string, failureKind?: LiveFailureKind) => void;
  onReconnecting?: (info: LiveReconnectingInfo) => void;
  onVadStateChange?: (active: boolean) => void;
  onVoicePriorityChange?: (enabled: boolean) => void;
  onShareVideoAudioChange?: (enabled: boolean) => void;
  onVideoAudioStatusChange?: LiveChatControllerDeps["onVideoAudioStatusChange"];
}

type BoundLiveControllerCallbackKey =
  | "onVadStateChange"
  | "onTranscript"
  | "onVideoContextSwitch"
  | "onReconnecting"
  | "onStateChange"
  | "onVolumeChange"
  | "onSpeedChange"
  | "onVoicePriorityChange"
  | "onShareVideoAudioChange"
  | "onVideoAudioStatusChange";

type BoundLiveControllerCallbacks = Pick<LiveChatControllerDeps, BoundLiveControllerCallbackKey>;

export type LiveOverlayControllerExtraDeps = Omit<
  LiveChatControllerDeps,
  | "initialVolume"
  | "initialSpeed"
  | "initialVoicePriority"
  | "initialShareVideoAudio"
  | BoundLiveControllerCallbackKey
>;

export interface LiveOverlayBindingOptions {
  getPlayerHost?: () => HTMLElement | null;
  onOpenLiveSettings?: FullscreenLiveOverlayDeps["onOpenLiveSettings"];
  createController?: (deps: LiveChatControllerDeps) => LiveChatController;
  createControllerDeps?: () => LiveOverlayControllerExtraDeps;
  consumerHooks?: LiveOverlayConsumerHooks | null;
  onStopTakeover?: () => void;
}

export interface LiveOverlayBinding {
  ensureController(): LiveChatController;
  ensureTargetReady(): Promise<LiveChatController>;
  getController(): LiveChatController | null;
  getOverlay(): FullscreenLiveOverlay | null;
  ensureOverlay(): FullscreenLiveOverlay;
  isActive(): boolean;
  setConsumerHooks(hooks: LiveOverlayConsumerHooks | null): void;
  start(): Promise<boolean>;
  stop(reason?: "takeover"): Promise<void>;
  toggle(): Promise<boolean>;
  retry(): Promise<boolean>;
  reconnect(shouldContinue?: () => boolean): Promise<boolean>;
  restoreOverlay(): void;
  clearOverlay(): void;
  dispose(): void;
}

export function createLiveOverlayBinding(options: LiveOverlayBindingOptions = {}): LiveOverlayBinding {
  const getPlayerHost = options.getPlayerHost ?? findDefaultLiveOverlayHost;
  const createControllerFn = options.createController ?? createLiveChatController;
  let controller: LiveChatController | null = null;
  let overlay: FullscreenLiveOverlay | null = null;
  let consumerHooks: LiveOverlayConsumerHooks | null = options.consumerHooks ?? null;
  let unsubscribeStorageWatcher: (() => void) | null = null;
  let unsubscribeAudioSettingsWatcher: (() => void) | null = null;
  let initialRefreshPromise: Promise<void> | null = null;
  let lastLiveState: LiveChatState = "idle";
  let retryInProgress = false;

  function isControllerLive(): boolean {
    const liveState = controller?.getState();
    return liveState === "connecting" || liveState === "connected";
  }

  function handleVolumeChange(volumePercent: number): void {
    persistLiveAudioSettings({ liveVoiceVolume: volumePercent });
  }

  function handleSpeedChange(speed: number): void {
    if (state.settings?.liveVoiceSpeed !== speed) {
      persistLiveAudioSettings({ liveVoiceSpeed: speed });
    }
  }

  function handleVoicePriorityChange(enabled: boolean): void {
    if (state.settings?.liveVoicePriority !== enabled) {
      persistLiveAudioSettings({ liveVoicePriority: enabled });
    }
  }

  function handleShareVideoAudioChange(enabled: boolean): void {
    if (state.settings?.liveShareVideoAudio !== enabled) {
      persistLiveAudioSettings({ liveShareVideoAudio: enabled });
    }
  }

  function ensureOverlay(): FullscreenLiveOverlay {
    if (!overlay) {
      overlay = createFullscreenLiveOverlay({
        getPlayerHost,
        getLiveController: () => controller,
        getVolume: () => state.settings?.liveVoiceVolume ?? 100,
        onVolumeChange: handleVolumeChange,
        onSpeedChange: handleSpeedChange,
        onOpenLiveSettings: options.onOpenLiveSettings,
        onStopLive: () => {
          void stop();
        },
        onRetryLive: () => {
          void retry();
        }
      });
    }
    return overlay;
  }

  function handleVideoContextSwitch(context: MossLiveSessionContext | null): void {
    if (context) {
      overlay?.showVideoContextSwitch(context);
    } else {
      overlay?.clearMessages();
    }
  }

  function handleStateChange(
    liveState: LiveChatState,
    error?: string,
    failureKind?: LiveFailureKind
  ): void {
    if (retryInProgress && liveState === "idle") {
      return;
    }
    if (error !== undefined || failureKind !== undefined) {
      consumerHooks?.onStateChange?.(liveState, error, failureKind);
    } else {
      consumerHooks?.onStateChange?.(liveState);
    }
    const active = liveState === "connected" || liveState === "connecting";
    const shouldShowOverlay = active || liveState === "failure";
    syncPlayerLiveQuickActionState(active);
    if (shouldShowOverlay) {
      const targetOverlay = ensureOverlay();
      const forceExpand = (lastLiveState === "idle" && !retryInProgress) || !targetOverlay.isVisible();
      targetOverlay.show({ forceExpand });
      targetOverlay.syncState(liveState, false, error, failureKind);
    } else {
      overlay?.syncState(liveState, false, undefined);
      if (!retryInProgress) overlay?.hide();
    }
    lastLiveState = liveState;
  }

  function bindControllerCallbacks(): BoundLiveControllerCallbacks {
    return {
      onVadStateChange: (active) => {
        consumerHooks?.onVadStateChange?.(active);
        overlay?.updateVad(active);
      },
      onTranscript: (event: MossLiveTranscriptEvent) => {
        overlay?.updateTranscript(event);
      },
      onVideoContextSwitch: handleVideoContextSwitch,
      onReconnecting: (info) => {
        consumerHooks?.onReconnecting?.(info);
        overlay?.syncState(controller?.getState(), true);
      },
      onStateChange: handleStateChange,
      onVolumeChange: () => {
        overlay?.syncState();
      },
      onSpeedChange: (speed) => {
        handleSpeedChange(speed);
        overlay?.syncState();
      },
      onVoicePriorityChange: (enabled) => {
        consumerHooks?.onVoicePriorityChange?.(enabled);
        handleVoicePriorityChange(enabled);
      },
      onShareVideoAudioChange: (enabled) => {
        consumerHooks?.onShareVideoAudioChange?.(enabled);
        handleShareVideoAudioChange(enabled);
      },
      onVideoAudioStatusChange: (status) => {
        consumerHooks?.onVideoAudioStatusChange?.(status);
        overlay?.syncState();
      }
    };
  }

  function bindWatchers(): void {
    if (!unsubscribeStorageWatcher) {
      unsubscribeStorageWatcher = watchStorageKeys(
        (changes, areaName) => {
          const isAiCredentialChange = areaName === "sync"
            ? Object.prototype.hasOwnProperty.call(changes, "aiProviders")
            : Object.prototype.hasOwnProperty.call(changes, "aiProviderKeys");
          const isLiveChange = areaName === "sync"
            ? Object.prototype.hasOwnProperty.call(changes, "liveProviders") ||
              Object.prototype.hasOwnProperty.call(changes, "activeLiveProviderId")
            : Object.prototype.hasOwnProperty.call(changes, "liveProviderKeys");
          if (
            !isLiveChange &&
            isAiCredentialChange &&
            controller?.getLastFailureKind?.() !== "gemini-credential"
          ) {
            return;
          }
          void controller?.refreshTarget();
        },
        {
          sync: ["liveProviders", "activeLiveProviderId", "aiProviders"],
          local: ["liveProviderKeys", "aiProviderKeys"]
        }
      );
    }
    if (!unsubscribeAudioSettingsWatcher) {
      unsubscribeAudioSettingsWatcher = watchLiveAudioSettings(
        () => controller,
        () => overlay?.syncState()
      );
    }
  }

  function ensureController(): LiveChatController {
    if (!controller) {
      const extraDeps = options.createControllerDeps?.() ?? {};
      const created = createControllerFn({
        initialVolume: normalizeLiveVoiceVolume(state.settings?.liveVoiceVolume) / 100,
        initialSpeed: normalizeLiveVoiceSpeed(state.settings?.liveVoiceSpeed),
        initialVoicePriority: state.settings?.liveVoicePriority !== false,
        initialShareVideoAudio: state.settings?.liveShareVideoAudio === true,
        ...extraDeps,
        ...bindControllerCallbacks()
      });
      controller = created;
      bindWatchers();
      initialRefreshPromise = Promise.resolve(created.refreshTarget()).catch(() => {});
    }
    return controller;
  }

  async function ensureTargetReady(): Promise<LiveChatController> {
    const current = ensureController();
    await initialRefreshPromise;
    return current;
  }

  async function startSelectedController(current: LiveChatController): Promise<boolean> {
    const alreadyLive = isControllerLive();
    const wasVisible = overlay?.isVisible() ?? false;
    const started = alreadyLive ? true : await current.start();
    if (!started) {
      if (current.getState() === "failure") {
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

  async function start(): Promise<boolean> {
    const current = ensureController();
    consumerHooks?.onBeforeStart?.();
    return startSelectedController(current);
  }

  async function stop(reason?: "takeover"): Promise<void> {
    const current = controller;
    if (!current) return;
    await current.stop();
    if (reason === "takeover" && controller === current) {
      options.onStopTakeover?.();
    }
  }

  async function toggle(): Promise<boolean> {
    if (isControllerLive()) {
      await stop();
      return false;
    }
    return start();
  }

  async function retry(): Promise<boolean> {
    if (retryInProgress) return false;
    const current = ensureController();
    consumerHooks?.onBeforeStart?.();
    retryInProgress = true;
    try {
      await current.stop();
      return await startSelectedController(current);
    } finally {
      retryInProgress = false;
    }
  }

  async function reconnect(shouldContinue?: () => boolean): Promise<boolean> {
    const current = controller;
    if (!current || (shouldContinue && !shouldContinue())) return false;
    await current.refreshTarget();
    if (controller !== current || (shouldContinue && !shouldContinue())) return false;
    await current.stop();
    if (controller !== current || (shouldContinue && !shouldContinue())) return false;
    return current.start();
  }

  function restoreOverlay(): void {
    if (!isControllerLive()) return;
    ensureOverlay().restore();
  }

  function clearOverlay(): void {
    overlay?.clearMessages();
  }

  function dispose(): void {
    unsubscribeStorageWatcher?.();
    unsubscribeStorageWatcher = null;
    unsubscribeAudioSettingsWatcher?.();
    unsubscribeAudioSettingsWatcher = null;
    const current = controller;
    controller = null;
    initialRefreshPromise = null;
    if (current) {
      if (typeof current.dispose === "function") {
        current.dispose();
      } else {
        void current.stop();
      }
    }
    syncPlayerLiveQuickActionState(false);
    overlay?.dispose();
    overlay = null;
    lastLiveState = "idle";
    retryInProgress = false;
    consumerHooks = null;
  }

  return {
    ensureController,
    ensureTargetReady,
    getController: () => controller,
    getOverlay: () => overlay,
    ensureOverlay,
    isActive: isControllerLive,
    setConsumerHooks(hooks) {
      consumerHooks = hooks;
    },
    start,
    stop,
    toggle,
    retry,
    reconnect,
    restoreOverlay,
    clearOverlay,
    dispose
  };
}
