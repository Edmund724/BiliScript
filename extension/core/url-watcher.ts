// extension/core/url-watcher.ts
// URL 变化的纯机制层：history.pushState/replaceState 补丁 + href 轮询兜底，
// 检测到变化即同步向 shared/content-event-bus 发布 "host:url-change" 强类型事件。
// 不做任何业务编排：popstate/hashchange 与 "host:url-change" 的编排在组合根
// entry/message-handler.ts 的 bindUrlChangeHandler 中。
// 本文件只依赖 ./state.ts 与 shared/content-event-bus.ts，不进入懒加载区。

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
