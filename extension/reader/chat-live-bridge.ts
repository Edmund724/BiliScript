import {
  ensureLiveController,
  getLiveController,
  isLiveCompanionActive,
  openLiveCompanionSettings,
  restoreLiveCompanionOverlay,
  retryLiveCompanion,
  setLiveSessionHooks,
  startLiveCompanion,
  stopLiveCompanion
} from "../live/live-companion-session.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import { createChatLiveStatus } from "./chat-live-status.js";
import type { ReaderChatComposerDeps } from "./chat-tab-composer.js";
import { requestUiCommand } from "./reader-bus.js";

export interface CreateChatLiveBridgeDeps {
  liveStatusRoot: HTMLElement | null;
  getTimestampNavDeps: () => TimestampNavDeps;
  showNotice: (message: string, autoHideMs?: number) => void;
  stopSpeech: () => void;
  isTurnActive: () => boolean;
  stopActiveStream: () => void;
  updateSendBtnState: () => void;
  hideHistoryPopover: () => void;
  hideMoreMenu: () => void;
}

export interface ChatLiveBridge {
  openChatSettings: (target?: "asr" | "appearance") => void;
  getComposerLiveProps: () => Pick<ReaderChatComposerDeps, "getLiveState" | "onStartLive">;
  isActive: () => boolean;
  refreshTarget: () => Promise<void>;
  bindHooksIfSupported: () => void;
  initEvents: () => void;
  closeSession: () => void;
}

export function createChatLiveBridge(deps: CreateChatLiveBridgeDeps): ChatLiveBridge {
  const liveStatus = createChatLiveStatus({
    root: deps.liveStatusRoot,
    getState: () => getLiveController()?.getState() ?? "idle",
    isReconnecting: () => getLiveController()?.isReconnecting?.() ?? false,
    getLastError: () => getLiveController()?.getLastError(),
    getLastFailureKind: () => getLiveController()?.getLastFailureKind(),
    getTimestampNavDeps: deps.getTimestampNavDeps,
    getTextToolRecords: () => getLiveController()?.getTextToolRecords?.() ?? [],
    subscribeTextToolRecords: (listener) => getLiveController()?.subscribeTextToolRecords?.(listener) ?? (() => {}),
    onRetryTextToolRecord: (callId) => {
      getLiveController()?.retryTextToolRecord?.(callId);
    },
    onContinueTextToolRecord: (callId) => {
      getLiveController()?.dismissTextToolRecord?.(callId);
    },
    onRetry: () => {
      void retryLiveCompanion();
    },
    onStop: stopLiveCompanion,
    onRestore: restoreLiveCompanionOverlay,
    onOpenSettings: (target) => {
      deps.hideHistoryPopover();
      void openLiveCompanionSettings(target);
    }
  });

  function openChatSettings(target?: "asr" | "appearance"): void {
    deps.stopSpeech();
    deps.hideHistoryPopover();
    deps.hideMoreMenu();
    requestUiCommand("open-settings", target ? { target } : undefined);
  }

  function bindLiveConsumerHooks(): void {
    setLiveSessionHooks({
      showNotice: (message, autoHideMs) => deps.showNotice(message, autoHideMs || 4000),
      onBeforeStart: () => {
        deps.stopSpeech();
        if (deps.isTurnActive()) {
          deps.stopActiveStream();
        }
      },
      onStateChange: (liveState, error, failureKind) => {
        liveStatus.sync(liveState, error, failureKind);
        deps.updateSendBtnState();
      },
      onReconnecting: () => {
        liveStatus.sync();
        deps.updateSendBtnState();
      }
    });
    liveStatus.setOpen(true);
    deps.updateSendBtnState();
  }

  function getComposerLiveProps(): Pick<ReaderChatComposerDeps, "getLiveState" | "onStartLive"> {
    if (!supportsLiveCompanion()) {
      return {};
    }
    return {
      getLiveState: () => getLiveController()?.getState() ?? "idle",
      onStartLive: () => {
        void startLiveCompanion();
      }
    };
  }

  function isActive(): boolean {
    return supportsLiveCompanion() && isLiveCompanionActive();
  }

  function refreshTarget(): Promise<void> {
    if (!supportsLiveCompanion()) {
      return Promise.resolve();
    }
    return getLiveController()?.refreshTarget() ?? Promise.resolve();
  }

  function bindHooksIfSupported(): void {
    if (supportsLiveCompanion()) {
      bindLiveConsumerHooks();
    }
  }

  function initEvents(): void {
    if (supportsLiveCompanion()) {
      ensureLiveController();
      bindLiveConsumerHooks();
    }
  }

  function closeSession(): void {
    liveStatus.setOpen(false);
    setLiveSessionHooks(null);
  }

  return {
    openChatSettings,
    getComposerLiveProps,
    isActive,
    refreshTarget,
    bindHooksIfSupported,
    initEvents,
    closeSession
  };
}
