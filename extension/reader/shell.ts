import { suppressUntil } from "../ai/player-ai-state.js";
import { buildReaderModeUrl, replaceReaderModeUrl } from "../bilibili/reader-url.js";
import {
  isReaderMode,
  stripReaderModeUrl
} from "../bilibili/video-id-shared.js";
import { ensureReaderChatTab } from "./lazy-chat-tab.js";
import { activateScriptTab } from "./script-tab-activation.js";
import { createSerialQueue } from "./serial-queue.js";
import { ensureUiReady } from "../ui/lazy-ui.js";
import { loadPlayerAi, isPlayerAiLoaded } from "../ai/lazy-player-ai.js";
import { ensureReaderDomain } from "./lazy-reader.js";
import { ensureReaderStyles, removeReaderStyles } from "../shared/style-injector.js";
import { applyPrePaintReaderTheme } from "../shared/host-theme.js";
import { logWarn, logWarnAlways } from "../shared/logging.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { state, getReaderShellState, transitionReaderShell } from "../core/state.js";
import { ids, isReaderViewOpen } from "./state.js";
import { isReaderShellIntact } from "./shell-intact.js";
import { requestUiCommand } from "./reader-bus.js";
import type { LiveSettingsTarget } from "../live/fullscreen-live-overlay.js";
import { captureTriggerRect, resolveTriggerElement } from "../ui/trigger-motion.js";

export { isReaderShellIntact };

export type ReaderShellIntent = "open" | "restore" | "chat";

export interface EnterReaderShellOptions {
  readerUrl: string;
  intent: ReaderShellIntent;
  prompt?: string;
  settingsTarget?: LiveSettingsTarget;
}

function resolveReaderEntryUrl(readerUrl: string): string {
  if (readerUrl || isReaderViewOpen()) {
    return readerUrl;
  }
  return buildReaderModeUrl(location.href);
}

interface ReaderEntrySequenceOptions {
  readerUrl: string;
  intent?: ReaderShellIntent;
  beforeEntry?: () => Promise<void>;
  triggerRect?: DOMRect | null;
}

const shellTransactionQueue = createSerialQueue();

function runReaderEntryExclusive(run: () => Promise<void>): Promise<void> {
  return shellTransactionQueue.enqueue(run);
}

function runReaderShellEnterTransaction(
  run: () => Promise<void>,
  onEnterFailed: (error: unknown) => void
): Promise<void> {
  return runReaderEntryExclusive(async () => {
    if (getReaderShellState() === "closed") {
      transitionReaderShell("entering");
    }
    await run();
  }).catch((error) => {
    if (getReaderShellState() === "entering") {
      transitionReaderShell("closed");
      logWarnAlways("[BILISCRIPT] reading shell enter transaction failed, state rolled back to closed", error);
    }
    onEnterFailed(error);
    throw error;
  });
}

async function runReaderEntrySequence(options: ReaderEntrySequenceOptions): Promise<void> {
  await ensureUiReady();
  await options.beforeEntry?.();
  const readerUrl = resolveReaderEntryUrl(options.readerUrl);
  if (readerUrl) {
    replaceReaderModeUrl(readerUrl);
    await ensureReaderStyles();
    applyPrePaintReaderTheme(state.settings);
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    const readingView = document.getElementById(ids.readingView);
    if (readingView) {
      void window.getComputedStyle(readingView).display;
    }
  }
  if (!isReaderViewOpen()) {
    const reader = await ensureReaderDomain();
    await reader.enterReaderMode(
      options.intent === "restore" ? "restore" : "open",
      options.triggerRect ? { triggerRect: options.triggerRect } : undefined
    );
  } else if (options.intent === "open") {
    const reader = await ensureReaderDomain();
    reader.focusReadingView();
  }
}

interface ReaderExitDomain {
  beginClosingReadingView: () => boolean;
  closeReadingView: () => void;
  restoreReadingViewFocus: () => void;
}

function waitForReaderExitTransition(readingView: HTMLElement): Promise<void> {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let timeout = 0;
    const finish = () => {
      window.clearTimeout(timeout);
      readingView.removeEventListener("transitionend", onTransitionEnd);
      resolve();
    };
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === readingView && event.propertyName === "scale") {
        finish();
      }
    };
    readingView.addEventListener("transitionend", onTransitionEnd);
    timeout = window.setTimeout(finish, 400);
  });
}

async function closeReaderViewAfterTransition(reader: ReaderExitDomain): Promise<void> {
  const readingView = document.getElementById(ids.readingView);
  const shouldWait = reader.beginClosingReadingView();
  if (shouldWait && readingView) {
    await waitForReaderExitTransition(readingView);
  }
  reader.closeReadingView();
}

async function restoreSelfHealBeforeEntry(): Promise<void> {
  if (!isReaderViewOpen() || isReaderShellIntact()) {
    return;
  }
  try {
    const reader = await ensureReaderDomain();
    await closeReaderViewAfterTransition(reader);
  } catch (error) {
    logWarn("[BILISCRIPT] reading view restore: close failed", error);
  }
}

async function removePlayerAiQuickButtonQuietly(): Promise<void> {
  try {
    const playerAi = await loadPlayerAi();
    await playerAi.removePlayerAiQuickActionButton();
  } catch {
  }
}

export function enterReaderShell(options: EnterReaderShellOptions): Promise<void> {
  const { intent } = options;
  const readerUrl = String(options.readerUrl || "").trim();
  const prompt = String(options.prompt || "").trim();
  const onFailed = (error: unknown): void => {
    logWarn(
      intent === "open"
        ? "[BILISCRIPT] reading mode trigger failed"
        : intent === "restore"
          ? "[BILISCRIPT] reading view restore failed"
          : "[BILISCRIPT] reading chat trigger failed",
      error
    );
  };

  const launchTriggerRect = captureTriggerRect(
    resolveTriggerElement() ??
      document.getElementById("biliscript-script-button") ??
      document.getElementById("biliscript-player-ai-quick-action")
  );

  suppressUntil(Date.now() + 2500);

  if (intent !== "restore" && isPlayerAiLoaded()) {
    void removePlayerAiQuickButtonQuietly();
  }
  return runReaderShellEnterTransaction(async () => {
    await runReaderEntrySequence({
      readerUrl,
      intent,
      beforeEntry: intent === "restore" ? restoreSelfHealBeforeEntry : undefined,
      triggerRect: launchTriggerRect
    });
    if (intent === "chat") {
      if (prompt) {
        const chat = await ensureReaderChatTab();
        await chat.runQuickActionPrompt(prompt);
      } else {
        await activateScriptTab("chat", { consumeIntent: false });
      }
    }
    if (options.settingsTarget) {
      requestUiCommand("open-settings", { target: options.settingsTarget });
    }
  }, onFailed);
}

export interface EnterReaderShellOnUrlNavigationOptions {
  readerUrl: string;
  onEnterFailed?: (error: unknown) => void;
}

export function enterReaderShellOnUrlNavigation(
  options: EnterReaderShellOnUrlNavigationOptions
): Promise<void> {
  const onEnterFailed = (error: unknown): void => {
    if (options.onEnterFailed) {
      options.onEnterFailed(error);
    } else {
      logWarn("[BILISCRIPT] reading view start failed", error);
    }
  };
  return runReaderShellEnterTransaction(async () => {
    await runReaderEntrySequence({ readerUrl: options.readerUrl });
  }, onEnterFailed);
}

export function exitReaderShell(): Promise<void> {
  return runReaderEntryExclusive(async () => {
    if (getReaderShellState() !== "closed") {
      transitionReaderShell("exiting");
    }
    if (isReaderMode()) {
      replaceReaderModeUrl(stripReaderModeUrl(location.href));
    }
    const reader = await ensureReaderDomain();
    await closeReaderViewAfterTransition(reader);
    removeReaderStyles();
    contentEventBus.emit("reader:closed");
    reader.restoreReadingViewFocus();
  }).catch((error) => {
    if (getReaderShellState() === "exiting") {
      transitionReaderShell("open");
      logWarnAlways("[BILISCRIPT] reading shell exit transaction failed, state rolled back to open", error);
    }
    throw error;
  });
}
