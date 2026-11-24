import { vi } from "vitest";
import { NORMAL_PAGE_URL, clearSharedSlots, setupEnvironment } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";
import { state } from "../../extension/core/state.js";
import {
  closeReaderSettingsMode,
  registerReaderSettingsBackInterceptor,
  registerReaderSettingsCloseListener
} from "../../extension/reader/settings-mode.js";
import { invalidateReaderSetupFlows } from "../../extension/reader/setup-resume.js";
import { registerDebugGate } from "../../extension/shared/logging.js";
import { dismissConfirmDialog } from "../../extension/ui/confirm-dialog.js";
import { closeAllCustomSelects } from "../../extension/ui/custom-select.js";
import { closeAllModelDropdowns } from "../../extension/ui/model-picker.js";

function resetCoreState(): void {
  state.setSettings({ ...DEFAULT_SETTINGS });
  state.reader.readingShellState = "closed";
  state.reader.setDetachedMode(null);
  state.reader.setTheme("light");
  state.reader.setThemeMode("bilibili");
  state.reader.setPalette("flyme");
  state.reader.setSettingsExpanded(false);
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
  state.reader.setNextScrollBehavior("smooth");
  state.reader.readingVideoEl = null;
  state.reader.readingDocumentClickBound = false;
  state.reader.setViewReady(false);

  state.clip.setCurrentUrl(typeof location !== "undefined" ? location.href : "");
  state.clip.setFetchRunId(0);
  state.clip.setBvid("");
  state.clip.setAid("");
  state.clip.setCid("");
  state.clip.setCidSource("");
  state.clip.setPageIndex(1);
  state.clip.setPageCount(0);
  state.clip.setPageTitle("");
  state.clip.setVideoDuration(0);
  state.clip.setDescription("");
  state.clip.setTitle("");
  state.clip.setAuthor("");
  state.clip.setUploadDate("");
  state.clip.setSubtitles([]);
  state.clip.setSelectedSubtitleId("");
  state.clip.setSelectedSubtitleUrl("");
  state.clip.setSelectedSubtitleLang("");
  state.clip.setSubtitleBody([]);
  state.clip.setSubtitleFetchState("idle");
  state.clip.setNoSubtitleReason(null);
  state.clip.setNoSubtitleDetail("");
  state.clip.clearSecondarySubtitle();
  state.clip.setChapters([]);
  state.clip.setHotComments([]);
  state.clip.setHotCommentsNotice("");
  state.clip.setMarkdown("");
  state.clip.setSrt("");
  state.clip.setTxt("");
  state.clip.setCurrentClipSignature("");

  state.ui.setEventsBound(false);
  state.ui.setRuntimeEventsBound(false);
  state.ui.setSettingsWatcherBound(false);
  state.ui.setNormalPageStateGuardBound(false);
  state.ui.setUrlWatcherStarted(false);
  state.ui.setStatusText("准备就绪，点击“刷新抓取”开始。");
}

function resetChromeRuntime(): void {
  const chromeObj = globalThis.chrome as unknown as {
    runtime?: {
      lastError?: unknown;
      getURL?: unknown;
      sendMessage?: unknown;
    };
    permissions?: unknown;
  };
  if (chromeObj?.runtime) {
    chromeObj.runtime.lastError = null;
    chromeObj.runtime.getURL = vi.fn((path: string) => `chrome-extension://test/${path}`);
    chromeObj.runtime.sendMessage = vi.fn((_message: unknown, callback?: (response?: unknown) => void) => {
      callback?.({ ok: true });
      return undefined;
    });
  }
  if (chromeObj && "permissions" in chromeObj) {
    delete chromeObj.permissions;
  }
}

export function resetUiState(): void {
  vi.useRealTimers();
  setupEnvironment();
  resetChromeRuntime();
  if (typeof history !== "undefined") {
    history.replaceState({}, "", NORMAL_PAGE_URL);
  }

  dismissConfirmDialog();
  closeAllCustomSelects();
  closeAllModelDropdowns();
  closeReaderSettingsMode({ restoreFocus: false });
  registerReaderSettingsBackInterceptor(null);
  registerReaderSettingsCloseListener(null);
  invalidateReaderSetupFlows("all");
  registerDebugGate(() => false);
  resetCoreState();
  clearSharedSlots();

  if (typeof document !== "undefined") {
    document.body.innerHTML = "";
  }
  closeAllCustomSelects();
  closeAllModelDropdowns();

  if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }

  if (typeof window !== "undefined") {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
  }

  if (typeof Element !== "undefined") {
    const rect = Element.prototype.getBoundingClientRect as (() => DOMRect) & { __biliscriptDefaultPatched?: boolean };
    if (!rect.__biliscriptDefaultPatched) {
      const patched = function getBoundingClientRect() {
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450, toJSON: () => ({}) };
      } as (() => DOMRect) & { __biliscriptDefaultPatched?: boolean };
      patched.__biliscriptDefaultPatched = true;
      Element.prototype.getBoundingClientRect = patched;
    }
  }
}

export async function flushMicrotasks(turns = 12): Promise<void> {
  for (let i = 0; i < turns; i++) {
    await Promise.resolve();
  }
}

export async function waitForFast<T>(
  callback: () => T | Promise<T>,
  options?: { timeout?: number; interval?: number }
): Promise<T> {
  for (let i = 0; i < 12; i++) {
    try {
      return await callback();
    } catch {
      await Promise.resolve();
    }
  }
  return vi.waitFor(callback, { interval: 1, ...options });
}
