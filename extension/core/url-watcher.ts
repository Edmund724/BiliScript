// extension/core/url-watcher.ts
// URL 变化的纯机制层：history.pushState/replaceState 补丁 + href 轮询兜底，
// 检测到变化即同步派发 boc:urlchange 自定义事件。
// 不做任何业务编排：popstate/hashchange/boc:urlchange 的监听注册与 URL 变化
// 编排（重置 clip → 刷字幕 → reader 同步 → player-ai 按钮同步）在组合根
// entry/message-handler.ts（arch-slim-2/09 归位 entry/）的 bindUrlChangeHandler 中。
// 本文件只 import ./state.ts（防重标记），不得依赖 ui/reader/ai/subtitle/
// bilibili 任何域。
//
// 双实例纪律标记：BOC_DUAL_INSTANCE_STATEFUL——本模块含模块级可变状态
// （history 补丁标记、轮询 interval id、lastObservedHref），content 两轮构建下
// 常驻包与懒加载区各一份实例。安全依据：懒侧（reader/chat-tab-core.ts）只引用
// BOC_URL_CHANGE_EVENT 常量，不调用任何状态函数，懒侧实例的补丁标记与轮询 id
// 永不写；若未来懒侧需要 URL 变化通知，走 boc:urlchange 窗口事件，不得直接
// 调用本模块的状态函数（scripts/build-content.js 的双实例守卫对账本标记）。
import { state, uiState } from "./state.js";

export const BOC_URL_CHANGE_EVENT = "boc:urlchange";
let urlWatcherHistoryPatched = false;
let urlWatcherPollStarted = false;
let urlWatcherPollId: ReturnType<typeof setInterval> | null = null;
let lastObservedHref = "";

// href 轮询兜底节拍（原 1200ms 轮询的恢复，见下）。
const URL_POLL_INTERVAL_MS = 1000;

// 单拍轮询体（startUrlPolling 的 interval 回调）：地址变化即同步派发。
function pollUrlChange(): void {
  if (location.href === lastObservedHref) {
    return;
  }
  lastObservedHref = location.href;
  window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
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

// 可见性节流（10-7）：标签页隐藏时轮询无意义（页面不渲染、用户不可见），
// 停掉 interval 省空闲资源；恢复可见时先同步补扫一次——隐藏期间主世界 SPA
// 换片（history 补丁截获不到）不丢，靠这次显式对账派发 boc:urlchange 兜底，
// 再重启轮询。
function handleUrlWatcherVisibility(): void {
  const hidden = typeof document.hidden === "boolean" ? document.hidden : false;
  if (hidden) {
    stopUrlPolling();
    return;
  }
  pollUrlChange();
  startUrlPolling();
}

// URL 变化事件广播（纯机制，无域依赖）。两条检测路径：
// 1. history 补丁：同步、即时，但内容脚本跑在隔离世界，补丁只能截获本世界
//    的调用（扩展自己的 replaceReaderModeUrl）；B 站主世界的 SPA 导航
//   （稍后再看列表内换视频等）走的是主世界自己的 history，补丁不可见，
//    且 pushState 导航不触发 popstate。
// 2. href 轮询兜底：世界无关，覆盖主世界 SPA 导航；事件重复派发无害——
//    消费侧 handleUrlChange 有 clip 签名守卫去重。
// popstate/hashchange 的监听与 handleUrlChange 编排在 entry/message-handler.ts。
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
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    history.replaceState = function replaceState(this: History, ...args: unknown[]): unknown {
      const result = originalReplaceState.apply(this, args as Parameters<typeof history.replaceState>);
      lastObservedHref = location.href;
      window.dispatchEvent(new Event(BOC_URL_CHANGE_EVENT));
      return result;
    };
    urlWatcherHistoryPatched = true;
  }

  if (!urlWatcherPollStarted) {
    urlWatcherPollStarted = true;
    lastObservedHref = location.href;
    document.addEventListener("visibilitychange", handleUrlWatcherVisibility);
    // 启动时已隐藏：轮询暂停，等恢复可见时补扫并重启（见 handleUrlWatcherVisibility）。
    const hidden = typeof document.hidden === "boolean" && document.hidden;
    if (!hidden) {
      startUrlPolling();
    }
  }
}
