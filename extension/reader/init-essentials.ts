import { state, uiState } from "../core/state.js";
import { getSettings } from "../core/runtime.js";
import { logWarn } from "../shared/logging.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { loadPlayerAi, isPlayerAiLoaded } from "../ai/lazy-player-ai.js";
import {
  applyReadingViewPresentation,
  hydrateReaderStateFromSettings
} from "./lazy-reader-presentation.js";
import { isReaderViewOpen } from "./state.js";
import { ensureReaderDomain } from "./lazy-reader.js";
import { READER_SETTINGS_WATCH_KEYS } from "./presentation-fields.js";

export function syncPlayerAiQuickAction(
  delayMs?: number,
  options?: { resetRetry?: boolean }
): void {
  if (!isPlayerAiLoaded()) {
    return;
  }
  void (async () => {
    try {
      const playerAi = await loadPlayerAi();
      if (options?.resetRetry) {
        playerAi.resetPlayerAiQuickActionRetryCount();
      }
      playerAi.schedulePlayerAiQuickActionSync(delayMs);
    } catch (error) {
      logWarn("[BILISCRIPT] player-ai sync via lazy loader failed", error);
    }
  })();
}

export function installReaderDebugHelpers() {
  const snapshotReader = async (label = "manual") => {
    try {
      const reader = await ensureReaderDomain();
      return reader.createReaderDebugSnapshot(label);
    } catch (error) {
      logWarn("[BILISCRIPT] reader debug snapshot failed (reader domain load failed)", error);
      return null;
    }
  };
  globalThis.__BILISCRIPT_READER_DEBUG_SNAPSHOT__ = snapshotReader;
  globalThis.__BILISCRIPT_DEBUG__ = {
    ...(globalThis.__BILISCRIPT_DEBUG__ || {}),
    snapshotReader
  };
  globalThis.__BILISCRIPT_FORCE_SYNC_PLAYER_AI__ = () => {
    syncPlayerAiQuickAction(0, { resetRetry: true });
  };
}

export function bindSettingsWatcher() {
  if (state.ui.settingsWatcherBound || !chrome.storage?.onChanged) {
    return;
  }
  uiState.setSettingsWatcherBound(true);

  watchStorageKeys(async (changes) => {
    try {
      const next = await getSettings();
      state.setSettings(next);
      if (isReaderViewOpen()) {
        void (async () => {
          try {
            await hydrateReaderStateFromSettings(next);
            await applyReadingViewPresentation();
          } catch (error) {
            logWarn("[BILISCRIPT] failed to apply reader presentation after storage change", error);
          }
        })();
      }
      syncPlayerAiQuickAction();
    } catch (error) {
      logWarn("[BILISCRIPT] failed to refresh settings after storage change", error);
    }
  }, { sync: READER_SETTINGS_WATCH_KEYS, local: READER_SETTINGS_WATCH_KEYS });
}
