import { state, uiState, clipState, getReaderShellState, triggerSubtitleSessionBoundary } from "../core/state.js";

import { startUrlWatcher } from "../core/url-watcher.js";
import { contentEventBus, getCurrentClipScope } from "../shared/content-event-bus.js";
import { createClipSwitchTransaction } from "./clip-switch-transaction.js";
import {
  getErrorMessage,
  isStaleRunError
} from "../shared/error-helpers.js";

import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { ensureUiReady } from "../ui/lazy-ui.js";

import { isPlayerAiLoaded } from "../ai/lazy-player-ai.js";

import { ensureReaderShell } from "../reader/lazy-shell.js";
import { isReaderViewOpen, enforceNormalPageStateIfNeeded } from "../reader/state.js";
import { requestLiveCompanionStop, requestSubtitleRefresh } from "../reader/reader-bus.js";
import { syncPlayerAiQuickAction } from "../reader/init-essentials.js";
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { logWarn } from "../shared/logging.js";
import { detectSiteFromUrl, getSiteCapabilities } from "../shared/site.js";

import {
  isReaderMode,
  isSupportedVideoPage,
  isAutoOpenEligible,
  supportsReaderModeUrlSync,
  computeCurrentClipSignature
} from "../bilibili/video-id-shared.js";
import type {
  ContentScriptMessage,
  ContentScriptMessageType,
  SendResponse
} from "../shared/messaging-protocol.js";
import { registerContentScriptDispatcher } from "../shared/messaging.js";

export function bindRuntimeEvents() {
  if (state.ui.runtimeEventsBound) {
    return;
  }
  uiState.setRuntimeEventsBound(true);

  registerContentScriptDispatcher(dispatchContentScriptMessage);
  chrome.runtime.onMessage.addListener((rawMessage, _sender, sendResponse: SendResponse) => {
    return dispatchContentScriptMessage(rawMessage, sendResponse);
  });
}

type Msg<T extends ContentScriptMessageType> = Extract<ContentScriptMessage, { type: T }>;

type ContentScriptHandler<K extends ContentScriptMessageType> = (
  message: Msg<K>,
  sendResponse: SendResponse
) => boolean;

type ReaderShellEntryType = "reader-enter" | "reader-restore";

function handleReaderShellEnter(
  message: Msg<ReaderShellEntryType>,
  sendResponse: SendResponse
): boolean {
  (async () => {
    try {
      const shell = await ensureReaderShell();
      const chat = message.type === "reader-enter" ? message.chat : undefined;
      await shell.enterReaderShell({
        readerUrl: String(message.readerUrl || ""),
        intent: message.type === "reader-restore" ? "restore" : chat ? "chat" : "open",
        prompt: chat?.prompt,
        chatMode: chat?.mode,
        chatTurnKind: chat?.turnKind
      });
      sendResponse({ ok: true });
    } catch (error) {
      logWarn("[BILISCRIPT] reading shell enter failed", error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

function handleLiveSessionTakeover(
  _message: Msg<"live-session-takeover">,
  sendResponse: SendResponse
): boolean {
  try {
    requestLiveCompanionStop("takeover");
    sendResponse({ ok: true });
  } catch {
    sendResponse({ ok: false });
  }
  return false;
}

function handleReaderClose(_message: Msg<"reader-close">, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const shell = await ensureReaderShell();
      await shell.exitReaderShell();
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

function handleReaderToggle(message: Msg<"reader-toggle">, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const shell = await ensureReaderShell();
      const shellState = getReaderShellState();
      const shouldClose = isReaderViewOpen() || shellState === "entering";
      if (shouldClose) {
        await shell.exitReaderShell();
        sendResponse({ ok: true, open: false });
      } else {
        await shell.enterReaderShell({
          readerUrl: String(message.readerUrl || ""),
          intent: "open"
        });
        sendResponse({ ok: true, open: true });
      }
    } catch (error) {
      logWarn("[BILISCRIPT] reading shell toggle failed", error);
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

function isAgentBridgeSupportedForActiveSite(): boolean {
  return getSiteCapabilities(state.clip.site).supportsAgentBridge;
}

function handleAgentBridgeSnapshot(_message: Msg<"agent-bridge-snapshot">, sendResponse: SendResponse): boolean {
  if (!isAgentBridgeSupportedForActiveSite()) {
    sendResponse({ ok: false, error: "当前站点不支持 Agent 桥接" });
    return false;
  }
  void (async () => {
    try {
      const { collectAgentBridgeTabSnapshot } = await import("../agent-bridge/content.js");
      sendResponse({ ok: true, snapshot: collectAgentBridgeTabSnapshot() });
    } catch (error) {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

function handleAgentBridgeSubtitles(_message: Msg<"agent-bridge-subtitles">, sendResponse: SendResponse): boolean {
  if (!isAgentBridgeSupportedForActiveSite()) {
    sendResponse({ ok: false, error: "当前站点不支持 Agent 桥接" });
    return false;
  }
  void (async () => {
    try {
      const { getAgentBridgeSubtitles } = await import("../agent-bridge/content-subtitles.js");
      sendResponse({ ok: true, result: await getAgentBridgeSubtitles() });
    } catch (error) {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

function handleAgentBridgeComments(_message: Msg<"agent-bridge-comments">, sendResponse: SendResponse): boolean {
  if (!isAgentBridgeSupportedForActiveSite()) {
    sendResponse({ ok: false, error: "当前站点不支持 Agent 桥接" });
    return false;
  }
  void (async () => {
    try {
      const { getAgentBridgeComments } = await import("../agent-bridge/content-subtitles.js");
      sendResponse({ ok: true, result: await getAgentBridgeComments() });
    } catch (error) {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

function handleAgentBridgeFrame(message: Msg<"agent-bridge-frame">, sendResponse: SendResponse): boolean {
  if (!isAgentBridgeSupportedForActiveSite()) {
    sendResponse({ ok: false, error: "当前站点不支持 Agent 桥接" });
    return false;
  }
  void (async () => {
    try {
      const { captureAgentBridgeFrames } = await import("../agent-bridge/frame.js");
      sendResponse({ ok: true, result: await captureAgentBridgeFrames(message) });
    } catch (error) {
      sendResponse({ ok: false, error: getErrorMessage(error) });
    }
  })();
  return true;
}

const contentMessageHandlerTable = {
  "reader-enter": handleReaderShellEnter,
  "reader-restore": handleReaderShellEnter,
  "reader-close": handleReaderClose,
  "reader-toggle": handleReaderToggle,
  "live-session-takeover": handleLiveSessionTakeover,
  "agent-bridge-snapshot": handleAgentBridgeSnapshot,
  "agent-bridge-subtitles": handleAgentBridgeSubtitles,
  "agent-bridge-comments": handleAgentBridgeComments,
  "agent-bridge-frame": handleAgentBridgeFrame
} satisfies { [K in ContentScriptMessageType]: ContentScriptHandler<K> };

const contentMessageHandlers = new Map<
  string,
  (message: ContentScriptMessage, sendResponse: SendResponse) => boolean
>(
  Object.entries(contentMessageHandlerTable) as Array<
    [string, (message: ContentScriptMessage, sendResponse: SendResponse) => boolean]
  >
);

export function dispatchContentScriptMessage(rawMessage: unknown, sendResponse: SendResponse): boolean {
  if (!rawMessage || typeof rawMessage !== "object") {
    return false;
  }
  const messageType = (rawMessage as { type?: unknown }).type;
  const handler = typeof messageType === "string" ? contentMessageHandlers.get(messageType) : undefined;
  if (!handler) {
    return false;
  }
  return handler(rawMessage as ContentScriptMessage, sendResponse);
}

async function ensureSubtitlePrefetch(): Promise<void> {
  await kickSubtitleFetch(() => requestSubtitleRefresh(), {
    skipIfInHandOrInFlight: true,
    awaitVideoMetadata: true,
    signal: getCurrentClipScope().signal,
    onChainLoadFailed: (error) =>
      logWarn("[BILISCRIPT] subtitle prefetch (summarize chain load) failed", { error }),
    continueAfterChainLoadFailed: true,
    onRefreshFailed: (error) => logWarn("[BILISCRIPT] subtitle prefetch failed", { error })
  });
}

export function startSubtitlePrefetch(): void {
  void ensureSubtitlePrefetch().catch((error) => {
    logWarn("[BILISCRIPT] subtitle prefetch failed", error);
  });
}

function reportAutoRefreshFailure(error: unknown): void {
  if (!isStaleRunError(error)) {
    logWarn("[BILISCRIPT] auto refresh failed", error);
  }
}

let urlChangeHandlerBound = false;

export function bindUrlChangeHandler() {
  if (urlChangeHandlerBound) {
    return;
  }
  urlChangeHandlerBound = true;

  const transaction = createClipSwitchTransaction({
    readUrl: () => location.href,
    computeSignature: computeCurrentClipSignature,
    readSignature: () => state.clip.currentClipSignature,
    writeIdentity: (url, signature) => {
      clipState.setSite(detectSiteFromUrl(url));
      clipState.setCurrentUrl(url);
      clipState.setCurrentClipSignature(signature);
    },
    readRunId: () => clipState.fetchRunId,
    writeRunId: (runId) => {
      clipState.setFetchRunId(runId);
      void triggerSubtitleSessionBoundary("clip-switch");
    },
    enforceNormalPageStateIfNeeded,
    isReaderViewOpen,
    isReaderMode: (url: string) => supportsReaderModeUrlSync(url) && isReaderMode(url),
    isSupportedVideoPage,
    shouldAutoOpen: (url: string) => Boolean(state.settings?.autoOpenReader && isAutoOpenEligible(url)),
    isPlayerAiLoaded: () => getSiteCapabilities(state.clip.site).supportsPlayerQuickAiButton && isPlayerAiLoaded(),
    ensureUiReady,
    resetClipState: async () => {
      const chain = await ensureSummarizeChain();
      chain.resetClipState();
    },
    syncPlayerAiQuickAction,
    enterReaderShellOnUrlNavigation: async (nextUrl) => {
      const shell = await ensureReaderShell();
      await shell.enterReaderShellOnUrlNavigation({ readerUrl: nextUrl });
    },
    refreshReaderClip: async () => {
      void kickSubtitleFetch((chain) => chain.refreshClip(), {
        awaitVideoMetadata: true,
        signal: getCurrentClipScope().signal,
        onChainLoadFailed: reportAutoRefreshFailure,
        onRefreshFailed: reportAutoRefreshFailure
      });
    },
    exitReaderShell: async () => {
      const shell = await ensureReaderShell();
      await shell.exitReaderShell();
    },
    startSubtitlePrefetch,
    logWarn
  });

  const handleUrlChange = () => transaction.handleUrlChange();
  window.addEventListener("popstate", handleUrlChange);
  window.addEventListener("hashchange", handleUrlChange);
  contentEventBus.on("host:url-change", handleUrlChange);
  startUrlWatcher();
}
