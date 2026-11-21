import { state, uiState } from "./state.js";
import { contentEventBus } from "../shared/content-event-bus.js";

let urlWatcherHistoryPatched = false;
let urlWatcherPollStarted = false;
let urlWatcherPollId: ReturnType<typeof setInterval> | null = null;
let lastObservedHref = "";

const URL_POLL_INTERVAL_MS = 1000;

function emitUrlChange(): void {
  contentEventBus.emit("host:url-change", { url: location.href });
}

function pollUrlChange(): void {
  if (location.href === lastObservedHref) {
    return;
  }
  lastObservedHref = location.href;
  emitUrlChange();
}

function startUrlPolling(): void {
  if (urlWatcherPollId !== null) {
    return;
  }
  urlWatcherPollId = window.setInterval(pollUrlChange, URL_POLL_INTERVAL_MS);
}

function stopUrlPolling(): void {
  if (urlWatcherPollId !== null) {
    clearInterval(urlWatcherPollId);
    urlWatcherPollId = null;
  }
}

function handleUrlWatcherVisibility(): void {
  const hidden = typeof document.hidden === "boolean" ? document.hidden : false;
  if (hidden) {
    stopUrlPolling();
    return;
  }
  pollUrlChange();
  startUrlPolling();
}

export function startUrlWatcher(): void {
  if (state.ui.urlWatcherStarted) {
    return;
  }
  uiState.setUrlWatcherStarted(true);

  if (!urlWatcherHistoryPatched) {
    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;
    history.pushState = function pushState(this: History, ...args: unknown[]): unknown {
      const result = originalPushState.apply(this, args as Parameters<typeof history.pushState>);
      lastObservedHref = location.href;
      emitUrlChange();
      return result;
    };
    history.replaceState = function replaceState(this: History, ...args: unknown[]): unknown {
      const result = originalReplaceState.apply(this, args as Parameters<typeof history.replaceState>);
      lastObservedHref = location.href;
      emitUrlChange();
      return result;
    };
    urlWatcherHistoryPatched = true;
  }

  if (!urlWatcherPollStarted) {
    urlWatcherPollStarted = true;
    lastObservedHref = location.href;
    document.addEventListener("visibilitychange", handleUrlWatcherVisibility);
    const hidden = typeof document.hidden === "boolean" && document.hidden;
    if (!hidden) {
      startUrlPolling();
    }
  }
}
