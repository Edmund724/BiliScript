import { sleep } from "../shared/utils.js";
import { logWarn } from "../shared/logging.js";
import {
  DUPLICATE_CLASSIC_INJECTION_SENTINEL,
  RECEIVING_END_MISSING_SENTINEL
} from "../shared/content-error-sentinels.js";
import type { ContentScriptMessage } from "../shared/messaging-protocol.js";

function getErrorMessageText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message?: unknown }).message ?? "");
  }
  return "";
}

export function isReceivingEndMissingError(error: unknown): boolean {
  const message = getErrorMessageText(error);
  return (
    message.includes(RECEIVING_END_MISSING_SENTINEL) ||
    /receiving end does not exist/i.test(message)
  );
}

export function isMessagePortClosedError(error: unknown): boolean {
  const message = getErrorMessageText(error);
  return (
    /message port closed/i.test(message) ||
    /message channel closed/i.test(message) ||
    /message manager disconnected/i.test(message) ||
    /disconnected port/i.test(message) ||
    /actor .* destroyed before query/i.test(message)
  );
}

export function isTransientTabMessagingError(error: unknown): boolean {
  return isReceivingEndMissingError(error) || isMessagePortClosedError(error);
}

export function isBenignTabUnavailableError(error: unknown): boolean {
  const message = getErrorMessageText(error);
  return (
    /\bno tab with id\b/i.test(message) ||
    /\binvalid tab id\b/i.test(message) ||
    /\bthe tab was closed\b/i.test(message) ||
    /\btab (?:not found|was closed|was removed)\b/i.test(message) ||
    /\bno frame with id\b/i.test(message) ||
    /\bframe with id \d+ was removed\b/i.test(message) ||
    /\bthe frame was removed\b/i.test(message)
  );
}

export function isTerminalTabError(error: unknown): boolean {
  if (isBenignTabUnavailableError(error)) {
    return true;
  }
  const message = getErrorMessageText(error);
  return (
    /\bcannot access (?:contents of|a )/i.test(message) ||
    /\bmissing host permission\b/i.test(message) ||
    /\bextensions gallery cannot be scripted\b/i.test(message) ||
    /\brestricted (?:frame|url|page|origin)\b/i.test(message) ||
    /\bframe .* error page\b/i.test(message) ||
    /\bpermission denied\b/i.test(message)
  );
}

export interface BackgroundContentOrchestratorDeps {
  probeOnce: (tabId: number) => Promise<string>;
  injectAssets: (tabId: number) => Promise<void>;
  reloadTab: (tabId: number) => Promise<void>;
  waitForTabComplete: (tabId: number, options: { polls: number }) => Promise<boolean>;
  sendMessageToTab: (tabId: number, message: ContentScriptMessage) => Promise<{ ok?: boolean }>;
  isTabReaderModeOff: (tabId: number) => Promise<boolean>;
  canInject: (tabId: number) => boolean;
  expectedVersion: string;
  logWarn?: (message: string, detail?: unknown) => void;
  delay?: (ms: number) => Promise<void>;
  probeAttempts?: number;
  probeRetryDelayMs?: number;
  readyPolls?: number;
  readyPollIntervalMs?: number;
  reloadWaitPolls?: number;
  reloadSettleDelayMs?: number;
  triggerRetries?: number;
  triggerRetryDelayMs?: number;
}

export interface BackgroundContentOrchestrator {
  ensureReaderContentReady: (tabId: number) => Promise<void>;
  probeContentScriptVersion: (tabId: number) => Promise<string>;
  injectReaderContent: (tabId: number) => Promise<void>;
  triggerReaderModeInTab: (
    tabId: number,
    readerUrl?: string,
    chat?: { prompt?: string },
    retries?: number,
    delayMs?: number
  ) => Promise<boolean>;
  triggerReaderModeCloseInTab: (tabId: number, retries?: number, delayMs?: number) => Promise<boolean>;
  triggerReaderModeToggleInTab: (
    tabId: number,
    readerUrl?: string,
    retries?: number,
    delayMs?: number
  ) => Promise<boolean>;
}

export function createBackgroundContentOrchestrator(deps: BackgroundContentOrchestratorDeps): BackgroundContentOrchestrator {
  const {
    probeOnce,
    injectAssets,
    reloadTab,
    waitForTabComplete,
    sendMessageToTab,
    isTabReaderModeOff,
    canInject,
    expectedVersion,
    logWarn: depsLogWarn = logWarn,
    delay = sleep,
    probeAttempts = 3,
    probeRetryDelayMs = 100,
    readyPolls = 5,
    readyPollIntervalMs = 150,
    reloadWaitPolls = 40,
    reloadSettleDelayMs = 120,
    triggerRetries = 12,
    triggerRetryDelayMs = 300
  } = deps;

  async function probeContentScriptVersion(tabId: number): Promise<string> {
    for (let attempt = 0; attempt < probeAttempts; attempt++) {
      try {
        const version = await probeOnce(tabId);
        if (version) {
          return version;
        }
      } catch (error) {
        if (isTerminalTabError(error)) {
          throw error;
        }
        if (!isTransientTabMessagingError(error)) {
          depsLogWarn("[BILISCRIPT] probeContentScriptVersion failed", error);
        }
      }
      if (attempt < probeAttempts - 1) {
        await delay(probeRetryDelayMs);
      }
    }
    return "";
  }

  async function injectReaderContent(tabId: number): Promise<void> {
    try {
      await injectAssets(tabId);
    } catch (error) {
      const message = String((error as Error)?.message || "");
      if (!message.includes(DUPLICATE_CLASSIC_INJECTION_SENTINEL)) {
        throw error;
      }
    }
  }

  async function pollContentReady(tabId: number): Promise<boolean> {
    for (let attempt = 0; attempt < readyPolls; attempt++) {
      if (attempt > 0) {
        await delay(readyPollIntervalMs);
      }
      const version = await probeContentScriptVersion(tabId);
      if (version === expectedVersion) {
        return true;
      }
    }
    return false;
  }

  async function ensureReaderContentReady(tabId: number): Promise<void> {
    if (!canInject(tabId)) {
      return;
    }

    const loadedVersion = await probeContentScriptVersion(tabId);
    if (loadedVersion === expectedVersion) {
      return;
    }

    await injectReaderContent(tabId);
    if (await pollContentReady(tabId)) {
      return;
    }

    if (loadedVersion && loadedVersion !== expectedVersion) {
      await reloadTab(tabId);
      const ready = await waitForTabComplete(tabId, { polls: reloadWaitPolls });
      if (!ready) {
        throw new Error("扩展更新后页面未及时恢复，请刷新浏览器网页重试");
      }
      await delay(reloadSettleDelayMs);
      await injectReaderContent(tabId);
      if (await pollContentReady(tabId)) {
        return;
      }
    }

    throw new Error("扩展脚本未能和当前页面同步，请刷新浏览器网页重试");
  }

  async function triggerReaderMessageWithRecovery(
    tabId: number,
    payload: Extract<ContentScriptMessage, { type: "reader-enter" | "reader-toggle" }>,
    retries = triggerRetries,
    delayMs = triggerRetryDelayMs
  ): Promise<boolean> {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) {
        await delay(delayMs);
      }

      try {
        const response = await sendMessageToTab(tabId, payload);
        if (response?.ok) {
          return true;
        }
      } catch (error) {
        if (isReceivingEndMissingError(error)) {
          await ensureReaderContentReady(tabId);
          continue;
        }
        if (isMessagePortClosedError(error)) {
          continue;
        }
        depsLogWarn(`[BILISCRIPT] ${payload.type} message failed`, error);
        throw error;
      }
    }

    return false;
  }

  async function triggerReaderModeInTab(
    tabId: number,
    readerUrl = "",
    chat?: { prompt?: string },
    retries = triggerRetries,
    delayMs = triggerRetryDelayMs
  ): Promise<boolean> {
    const payload: Extract<ContentScriptMessage, { type: "reader-enter" }> = {
      type: "reader-enter",
      readerUrl
    };
    if (chat) {
      payload.chat = chat;
    }
    return triggerReaderMessageWithRecovery(tabId, payload, retries, delayMs);
  }

  async function triggerReaderModeCloseInTab(
    tabId: number,
    retries = triggerRetries,
    delayMs = triggerRetryDelayMs
  ): Promise<boolean> {
    for (let attempt = 0; attempt < retries; attempt += 1) {
      if (attempt > 0) {
        await delay(delayMs);
      }

      let transientError: unknown = null;
      try {
        const response = await sendMessageToTab(tabId, {
          type: "reader-close"
        });
        if (response?.ok) {
          return true;
        }
      } catch (error) {
        if (!isTransientTabMessagingError(error)) {
          depsLogWarn("[BILISCRIPT] reader-close message failed", error);
          throw error;
        }
        transientError = error;
      }

      if (await isTabReaderModeOff(tabId)) {
        return true;
      }
      if (transientError) {
        depsLogWarn("[BILISCRIPT] reader-close transient error while reader mode still active", transientError);
      }
    }

    return false;
  }

  async function triggerReaderModeToggleInTab(
    tabId: number,
    readerUrl = "",
    retries = triggerRetries,
    delayMs = triggerRetryDelayMs
  ): Promise<boolean> {
    return triggerReaderMessageWithRecovery(
      tabId,
      {
        type: "reader-toggle",
        readerUrl
      },
      retries,
      delayMs
    );
  }

  return {
    ensureReaderContentReady,
    probeContentScriptVersion,
    injectReaderContent,
    triggerReaderModeInTab,
    triggerReaderModeCloseInTab,
    triggerReaderModeToggleInTab
  };
}
