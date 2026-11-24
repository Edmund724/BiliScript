import { state, clipState } from "../core/state.js";
import { BILISCRIPT_VERSION, DEFAULT_SETTINGS } from "../core/defaults.js";
import { detectActiveSite, getSiteCapabilities } from "../shared/site.js";

import {
  isReaderMode,
  isSupportedVideoPage,
  isAutoOpenEligible,
  isLiveRoomPage,
  isFestivalPage,
  computeCurrentClipSignature
} from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { logInfo, logWarn } from "../shared/logging.js";

import { loadPlayerAi, isPlayerAiLoaded } from "../ai/lazy-player-ai.js";

import { loadScriptButton } from "../ui/lazy-script-button.js";
import { loadLiveRoom } from "../live/lazy-live-room.js";
import { loadPlaybackRate, isPlaybackRateLoaded } from "../bilibili/lazy-playback-rate.js";

import { ensureUiReady } from "../ui/lazy-ui.js";
import {
  installReaderDebugHelpers,
  bindSettingsWatcher
} from "../reader/init-essentials.js";
import { clearReaderModePageState, bindNormalPageStateGuard } from "../reader/state.js";
import {
  hydrateReaderStateFromSettings,
  applyReadingViewPresentation,
  applyPrePaintReaderTheme
} from "../reader/lazy-reader-presentation.js";
import { ensureReaderDomain } from "../reader/lazy-reader.js";

import { registerContentCapabilities } from "../reader/reader-bus.js";

import { bindRuntimeEvents, bindUrlChangeHandler, startSubtitlePrefetch } from "./message-handler.js";
import { ensureReaderStyles, removeReaderStyles } from "../shared/style-injector.js";
import { registerDebugLogGate } from "../shared/debug-log-gate.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";

globalThis.__BILISCRIPT_CONTENT_SCRIPT_LOADED__ = BILISCRIPT_VERSION;

let playerAiSettingsWatcherBound = false;
let playbackRateSettingsWatcherBound = false;
let quickActionStartupDecided = false;

init();

function isFirefoxExtensionRuntime(): boolean {
  try {
    const url = typeof chrome !== "undefined" ? chrome.runtime?.getURL?.("") : "";
    return typeof url === "string" && url.startsWith("moz-extension://");
  } catch {
    return false;
  }
}

function isSupportedUrl(): boolean {
  if (isReaderMode()) return true;
  return isSupportedVideoPage();
}

function init(): void {
  registerDebugLogGate();
  logInfo(`[BILISCRIPT] content script loaded, version=${BILISCRIPT_VERSION}`);
  const activeSite = detectActiveSite();
  clipState.setSite(activeSite);
  const siteCaps = getSiteCapabilities(activeSite);
  if (isLiveRoomPage()) {
    if (typeof __BILISCRIPT_TARGET__ === "string" && __BILISCRIPT_TARGET__ === "firefox") {
      return;
    } else {
      if (isFirefoxExtensionRuntime() || !siteCaps.supportsLiveCompanion) {
        return;
      }
      loadLiveRoom()
        .then((domain) => domain.startLiveRoomCompanion())
        .catch((error) => {
          logWarn("[BILISCRIPT] live room companion load failed", error);
        });
      return;
    }
  }
  if (!isSupportedUrl() && !isFestivalPage()) {
    return;
  }
  clipState.setCurrentUrl(location.href);
  clipState.setCurrentClipSignature(computeCurrentClipSignature());

  installReaderDebugHelpers();

  const shouldEnterReaderMode = isReaderMode();
  if (shouldEnterReaderMode) {
    void Promise.all([ensureReaderStyles(), applyPrePaintReaderTheme()]).then(() => {
      document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
      document.body.setAttribute("data-biliscript-reader-mode", "1");
    });
  } else {
    removeReaderStyles();
    clearReaderModePageState();
  }

  bindRuntimeEvents();
  bindSettingsWatcher();
  registerContentCapabilities({
    persistSettings: () => {
      sendRuntimeMessage({ type: "save-settings", settings: state.settings }).catch((error) => {
        logWarn("[BILISCRIPT] failed to persist reader settings", error);
      });
    }
  });
  bindNormalPageStateGuard();
  bindUrlChangeHandler();
  if (isSupportedVideoPage()) {
    startSubtitlePrefetch();
  }
  if (siteCaps.supportsPlayerQuickAiButton) {
    bindPlayerAiSettingsWatcher();
  }
  if (siteCaps.supportsExtraPlaybackRates) {
    bindPlaybackRateSettingsWatcher();
  }
  loadScriptButton().catch((error) => {
    logWarn("[BILISCRIPT] script-button module load failed", error);
  });
  if (siteCaps.supportsPlayerQuickAiButton) {
    (async () => {
      try {
        const data = await chrome.storage.sync.get("enablePlayerAiQuickAction");
        quickActionStartupDecided = true;
        const raw = (data as { enablePlayerAiQuickAction?: unknown })?.enablePlayerAiQuickAction;
        const enabled = raw === undefined ? DEFAULT_SETTINGS.enablePlayerAiQuickAction : Boolean(raw);
        state.patchSettings({ enablePlayerAiQuickAction: enabled });
        if (enabled && getSiteCapabilities(state.clip.site).supportsPlayerQuickAiButton) {
          startPlayerAiQuickActionLazy();
        }
      } catch {
      }
    })();
  } else {
    quickActionStartupDecided = true;
  }
  (async () => {
    try {
      const settings = await getSettings();
      state.setSettings(settings);
      const currentCaps = getSiteCapabilities(state.clip.site);
      if (currentCaps.supportsExtraPlaybackRates && settings.enableExtraPlaybackRates) {
        startPlaybackRateLazy();
      }
      if (currentCaps.supportsPlayerQuickAiButton && !quickActionStartupDecided) {
        if (settings.enablePlayerAiQuickAction) {
          startPlayerAiQuickActionLazy();
        } else {
          stopPlayerAiQuickActionLazy();
        }
      }
      const isAutoOpen = Boolean(settings.autoOpenReader && isAutoOpenEligible(location.href));
      if (shouldEnterReaderMode || isAutoOpen) {
        await Promise.all([ensureReaderStyles(), applyPrePaintReaderTheme(settings)]);
        document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
        document.body.setAttribute("data-biliscript-reader-mode", "1");
        try {
          await ensureUiReady({ forceRecreate: true });
          await hydrateReaderStateFromSettings(settings);
          await applyReadingViewPresentation();
          const reader = await ensureReaderDomain();
          await reader.enterReaderMode();
        } catch (error) {
          logWarn("[BILISCRIPT] reader mode direct entry failed", error);
        }
      }
    } catch (error) {
      logWarn("[BILISCRIPT] settings hydration failed", error);
    }
  })();
}

async function startPlaybackRateLazy(): Promise<void> {
  if (!getSiteCapabilities(state.clip.site).supportsExtraPlaybackRates) {
    return;
  }
  try {
    const domain = await loadPlaybackRate();
    domain.startPlaybackRateButtons();
  } catch (error) {
    logWarn("[BILISCRIPT] playback-rate module load failed", error);
  }
}

async function stopPlaybackRateLazy(): Promise<void> {
  if (!isPlaybackRateLoaded()) {
    return;
  }
  try {
    const domain = await loadPlaybackRate();
    domain.stopPlaybackRateButtons();
  } catch (error) {
    logWarn("[BILISCRIPT] playback-rate stop failed", error);
  }
}

function bindPlaybackRateSettingsWatcher(): void {
  if (playbackRateSettingsWatcherBound) {
    return;
  }
  playbackRateSettingsWatcherBound = true;
  watchStorageKeys((changes) => {
    const change = changes["enableExtraPlaybackRates"];
    if (!change) {
      return;
    }
    const enabled = Boolean(change.newValue);
    state.patchSettings({ enableExtraPlaybackRates: enabled });
    if (enabled && getSiteCapabilities(state.clip.site).supportsExtraPlaybackRates) {
      startPlaybackRateLazy();
    } else {
      stopPlaybackRateLazy();
    }
  }, { sync: ["enableExtraPlaybackRates"] });
}

function bindPlayerAiSettingsWatcher(): void {
  if (playerAiSettingsWatcherBound) {
    return;
  }
  playerAiSettingsWatcherBound = true;
  watchStorageKeys((changes) => {
    const change = changes["enablePlayerAiQuickAction"];
    if (!change) {
      return;
    }
    const enabled = Boolean(change.newValue);
    state.patchSettings({ enablePlayerAiQuickAction: enabled });
    if (enabled && getSiteCapabilities(state.clip.site).supportsPlayerQuickAiButton) {
      startPlayerAiQuickActionLazy();
    } else {
      stopPlayerAiQuickActionLazy();
    }
  }, { sync: ["enablePlayerAiQuickAction"] });
}

async function startPlayerAiQuickActionLazy(): Promise<void> {
  if (!getSiteCapabilities(state.clip.site).supportsPlayerQuickAiButton) {
    return;
  }
  try {
    const playerAi = await loadPlayerAi();
    playerAi.startPlayerAiQuickAction();
  } catch (error) {
    logWarn("[BILISCRIPT] player-ai module load failed (quick action not started)", error);
  }
}

async function stopPlayerAiQuickActionLazy(): Promise<void> {
  if (!isPlayerAiLoaded()) {
    return;
  }
  try {
    const playerAi = await loadPlayerAi();
    playerAi.stopPlayerAiQuickAction();
  } catch (error) {
    logWarn("[BILISCRIPT] player-ai stop after lazy load failed", error);
  }
}
