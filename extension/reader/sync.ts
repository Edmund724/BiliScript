// Reader playback↔subtitle synchronization (extracted from reader-impl.js,
// formerly the subtitle-sync.js segment, issue 06+).
//
// Deep module owning the sync timer and the manual/programmatic scroll-pause
// coordination, plus the reader 域唯一定位入口 seekReadingTarget（阅读视图内点击
// 与侧栏时间戳 seek 的共享规范序）。
//
// Layer graph (acyclic; reader-bus 端口组是逆依赖的唯一通道):
//
//   reader-bus.ts  显式回调端口（本域逆依赖的唯一通道，lifecycle 单点注册）
//   LAYOUT    video-bind.js + script-host.js → reader-bus 端口组
//                               module-level closure: scroll-pause variables,
//                               timer variables
//   SYNC      sync.js（本文件）                     → LAYOUT + ports
//                               syncTimer lives here; scroll state machine lives
//                               in ./subtitle-scroll-follow.ts;
//                               video 事件绑定经静态边 import ./video-bind.js
//   LIFECYCLE lifecycle.js                          → SYNC + LAYOUT
//
// LAYOUT must not import this module — its layout/shell functions that need
// sync-domain behavior call it through the explicit reader ports group
// (reader-bus.ts, registered once by lifecycle.js), keeping the dependency graph
// acyclic: SYNC → LAYOUT. 不允许任何 `?.[` 式静默端口调用回潮。
import { state } from "../core/state.js";
import { getReaderElement } from "../shared/dom-utils.js";
import { findActiveSubtitleIndex, findActiveChapterIndex } from "../subtitle/core.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import {
  ids,
  isReadingOverviewBodyVisible,
  isReadingSubtitleBodyVisible
} from "./state.js";
import {
  projectReaderFollowUi,
  subtitleScrollFollow
} from "./subtitle-scroll-follow.js";
import { bindReadingViewVideo, unbindReadingViewVideoSync } from "./video-bind.js";
// 候选02 分层惰性：状态栏文案属常驻微模块，直接 import（不再经 player-host 转发）。
import { showSubtitleNotice } from "./subtitle-notice.js";
// 候选06 端口半边：SYNC → LIFECYCLE 的字幕同步补渲染经 reader-bus 显式端口
//（实现由 lifecycle.js 启动时单点注册，缺失即抛错）。
import { readerPorts } from "./reader-bus.js";
// PR3 转写中间态：250ms tick 顺带收敛转写横幅（相位/进度行脏检查在
// transcribe-banner 内部，稳态零 DOM 写）。transcribe-banner 是零依赖呈现叶子
//（state + shared status-bus），不破坏 SYNC → LAYOUT + ports 的层图。
import { updateReadingTranscribeBanner } from "./transcribe-banner.js";
import { isReaderExplainCardOpen } from "./explain-card.js";
import { closestSubtitleItem, findSubtitleItem, SUBTITLE_ITEM_CLASS } from "./subtitle-item-dom.js";
import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";


// ===== sync-domain private bookkeeping (module-level closure state) =====
let syncScope: DisposableContext | null = null;
let hadSelectionOnPointerDown = false;

// ===== subtitle-sync.js (playback sync) =====

export function startReadingViewSync() {
  syncScope?.dispose();
  const scope = createDisposableContext();
  syncScope = scope;
  scope.setInterval(() => {
    syncReadingViewPlayback();
  }, 250);
}

export function stopReadingViewSync() {
  syncScope?.dispose();
  syncScope = null;
  unbindReadingViewVideoSync();
}

export function syncReadingViewPlayback(forceScroll = false, overrideTime?: number) {
  if (!state.reader.readingViewOpen) {
    return;
  }

  const bound = bindReadingViewVideo(getRuntimeVideoElement() || state.reader.readingVideoEl);
  if (!bound) {
    return;
  }

  const currentTime = overrideTime !== undefined ? overrideTime : (Number(bound.currentTime || 0) || 0);
  // 字幕 tab 可见性判定（tick 的滚动/高亮段开关）——判定输入全部来自状态位
  // （isReadingSubtitleBodyVisible），渲染不可见时跳过高亮/滚动 DOM 写。
  if (isReadingSubtitleBodyVisible()) {
    const subtitleIndex = findActiveSubtitleIndex(currentTime);
    const chapterIndex = findActiveChapterIndex(currentTime);
    // 自动滚动开启：目标句变化即触发居中滚动（手动浏览中暂停跟随，点击回位胶囊或点句跳播恢复）。
    // forceScroll 由 seek/恢复跟随路径显式传入。
    const shouldScroll =
      forceScroll ||
      subtitleIndex !== state.reader.readingActiveSubtitleIndex ||
      chapterIndex !== state.reader.readingActiveChapterIndex;

    setActiveReadingItems(subtitleIndex, chapterIndex, shouldScroll, currentTime);
    if (!shouldScroll && state.reader.readingNextScrollBehavior === "auto") {
      state.reader.setNextScrollBehavior("smooth");
    }
  }
  if (isReadingOverviewBodyVisible()) {
    syncReadingOverviewActiveChapter(currentTime);
  }
  updateReaderFollowState(currentTime);
  updateReadingTranscribeBanner();
}

// 上次激活高亮的缓存（字幕与概览章节）：命中且仍在文档树内时跳过 DOM 查询与 classList 写。
const lastActiveItems: { subtitle: ActiveItemCache; overviewChapter: OverviewChapterCache } = {
  subtitle: { index: -1, node: null },
  overviewChapter: { node: null, minTime: 0, maxTime: -1 }
};

interface OverviewChapterCache {
  node: HTMLElement | null;
  minTime: number;
  maxTime: number;
}

interface ActiveItemCache {
  index: number;
  node: HTMLElement | null;
}

export function syncReadingOverviewActiveChapter(
  currentTime: unknown = state.reader.readingVideoEl?.currentTime || 0
): void {
  const seconds = Number(currentTime);
  const time = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  const cached = lastActiveItems.overviewChapter;
  if (cached.node?.isConnected && time >= cached.minTime && time < cached.maxTime) {
    return;
  }

  const body = document.getElementById(ids.readingOverviewBody);
  if (!body) return;
  const cards = Array.from(body.querySelectorAll<HTMLElement>(".biliscript-reading-ov-chapter"));
  let next: HTMLElement | null = null;
  let minTime = 0;
  let maxTime = Number.POSITIVE_INFINITY;

  for (const card of cards) {
    const from = Number(card.dataset.seconds) || 0;
    const to = Number(card.dataset.to) || 0;
    if (time < from) {
      maxTime = Math.min(maxTime, from);
      break;
    }
    if (to > from && time >= to) {
      minTime = Math.max(minTime, to);
      continue;
    }
    next = card;
    minTime = Math.max(minTime, from);
    if (to > from) {
      maxTime = Math.min(maxTime, to);
    }
    break;
  }

  const current =
    cached.node?.isConnected && cached.node.classList.contains("is-active")
      ? cached.node
      : body.querySelector<HTMLElement>(".biliscript-reading-ov-chapter.is-active");
  cached.node = next;
  cached.minTime = minTime;
  cached.maxTime = maxTime;

  if (current === next) return;
  current?.classList.remove("is-active");
  current?.removeAttribute("aria-current");
  if (next) {
    next.classList.add("is-active");
    next.setAttribute("aria-current", "true");
  }
}

function resolveActiveItem(cached: ActiveItemCache, index: number, list: HTMLElement, className: string) {
  if (cached.node?.isConnected && cached.index === index) {
    return { next: cached.node, current: cached.node, unchanged: true };
  }
  const next = findSubtitleItem(list, index);
  const current = cached.node?.isConnected
    ? cached.node
    : list.querySelector<HTMLElement>(`.${className}.is-active`);
  return { next, current, unchanged: false };
}

function setActiveReadingItems(
  subtitleIndex: number,
  chapterIndex: number,
  shouldScroll = false,
  currentTime?: number
) {
  const subtitleList = getReaderElement(ids.readingSubtitleList);
  // 官方章节索引只用于字幕跟随；概览高亮由 syncReadingOverviewActiveChapter 按概览章界独立计算并缓存。
  const subtitleHit = resolveActiveItem(lastActiveItems.subtitle, subtitleIndex, subtitleList, SUBTITLE_ITEM_CLASS);

  if (!subtitleHit.unchanged) {
    if (subtitleHit.current && subtitleHit.current !== subtitleHit.next) {
      subtitleHit.current.classList.remove("is-active");
    }
    if (subtitleHit.next) {
      subtitleHit.next.classList.add("is-active");
    }
    lastActiveItems.subtitle.index = subtitleIndex;
    lastActiveItems.subtitle.node = subtitleHit.next;
  }

  // 滚动落位失败且补渲染仍在途（被单帧上限截断）时不给 active 索引记账：
  // 下一拍（非 force）shouldScroll 因索引差继续为真，条目随 rAF 上屏后自动补滚动。
  let scrollDeferred = false;

  if (shouldScroll) {
    if (subtitleScrollFollow.isManualPaused()) {
      updateReaderFollowState(currentTime);
      state.reader.setActiveSubtitleIndex(subtitleIndex);
      state.reader.setActiveChapterIndex(chapterIndex);
      return;
    }
    let scrollSubtitleNode = subtitleHit.next;
    // 字幕列表分批渲染后，跳转/跟随的目标条目可能还没追加上屏。
    // 先同步补渲染到目标 index 再取节点滚动，保证「跳不过去」不发生。
    if (!scrollSubtitleNode && subtitleIndex >= 0) {
      scrollDeferred = readerPorts.flushReadingSubtitleToIndex(subtitleIndex) === false;
      scrollSubtitleNode = findSubtitleItem(subtitleList, subtitleIndex);
      if (scrollSubtitleNode) {
        if (subtitleHit.current && subtitleHit.current !== scrollSubtitleNode) {
          subtitleHit.current.classList.remove("is-active");
        }
        scrollSubtitleNode.classList.add("is-active");
        lastActiveItems.subtitle.index = subtitleIndex;
        lastActiveItems.subtitle.node = scrollSubtitleNode;
        scrollDeferred = false;
      }
    }
    if (scrollSubtitleNode) {
      if (!isReaderExplainCardOpen()) {
        scrollReadingSubtitleItemIntoView(scrollSubtitleNode);
      }
    }
  }

  if (!scrollDeferred) {
    state.reader.setActiveSubtitleIndex(subtitleIndex);
  }
  state.reader.setActiveChapterIndex(chapterIndex);
}

// 列表容器或条目不可见时的兜底滚动：对隐藏节点 scrollIntoView 无操作，
// 不产生程序化滚动窗口之外的效果。
function scrollReadingItemIntoViewFallback(node: HTMLElement) {
  const token = subtitleScrollFollow.beginProgrammaticScroll({ behavior: "smooth" });
  const scrollResult = node.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest"
  });
  subtitleScrollFollow.attachProgrammaticScrollPromise(token, scrollResult);
}

function scrollReadingSubtitleItemIntoView(node: HTMLElement) {
  if (!node) {
    return;
  }

  // 字幕列表常驻右侧面板「字幕」标签页自身滚动容器内：
  // 列表容器不可见或条目尚未上屏时退回 scrollIntoView；
  // 容器内容未溢出时条目已完整可见，不滚动宿主页 window。
  const subtitleList = getReaderElement(ids.readingSubtitleList);
  const listRect = subtitleList.getBoundingClientRect();
  const itemRect = node.getBoundingClientRect();
  if (!(listRect.height > 0) || !(itemRect.height > 0)) {
    scrollReadingItemIntoViewFallback(node);
    return;
  }

  const behavior = state.reader.readingNextScrollBehavior === "auto" ? "auto" : "smooth";
  state.reader.setNextScrollBehavior("smooth");
  if (subtitleList.scrollHeight <= subtitleList.clientHeight + 8) {
    return;
  }

  const maxScrollTop = Math.max(0, subtitleList.scrollHeight - subtitleList.clientHeight);
  const centeredTop =
    subtitleList.scrollTop + (itemRect.top - listRect.top) - Math.max(0, (listRect.height - itemRect.height) / 2);
  const targetScrollTop = Math.min(maxScrollTop, Math.max(0, Math.round(centeredTop)));
  const token = subtitleScrollFollow.beginProgrammaticScroll({
    behavior,
    startTop: subtitleList.scrollTop,
    targetTop: targetScrollTop
  });
  const scrollResult = subtitleList.scrollTo?.({
    top: targetScrollTop,
    behavior
  });
  subtitleScrollFollow.attachProgrammaticScrollPromise(token, scrollResult);
}

// ===== seek 深入口 =====
//
// reader 域的唯一定位入口：阅读视图内点击章节/字幕时间戳与侧栏时间戳 seek 一律收敛到这里。
// 规范序锁死（不得重排）：
//   1) subtitleScrollFollow.resumeAuto()          清手动滚动暂停
//   2) setNextScrollBehavior + 跟随状态            设程序化跟随并隐藏回位胶囊
//   3) video.currentTime = nextTime               赋值定位（触发的事件落在干净状态上）
//   4) resumePlayback 且暂停中才 play             播放策略参数化
//   5) syncReadingViewPlayback(true, nextTime)    立即同步高亮/居中滚动
export function seekReadingTarget(
  seconds: number | string,
  { resumePlayback = false, scrollBehavior = "auto" as "auto" | "smooth" } = {}
) {
  const video = bindReadingViewVideo();
  if (!video) {
    showSubtitleNotice("当前页面没有找到可联动的视频播放器。");
    return null;
  }

  const raw = Number(seconds);
  const nextTime = Math.max(0, Number.isFinite(raw) ? raw : 0);
  subtitleScrollFollow.resumeAuto();
  state.reader.setNextScrollBehavior(scrollBehavior);
  updateReaderFollowState(nextTime);
  video.currentTime = nextTime;
  if (resumePlayback && video.paused) {
    video.play().catch(() => {});
  }
  syncReadingViewPlayback(true, nextTime);
  return nextTime;
}

// 阅读视图内点击跳转：自动播放策略（resumePlayback:true）委托给 seek 深入口，采用平滑居中滚动。
export function jumpReadingTarget(seconds: number | string) {
  seekReadingTarget(seconds, { resumePlayback: true, scrollBehavior: "smooth" });
}

export function markSubtitlePointerDownSelection(hasSelection?: boolean) {
  hadSelectionOnPointerDown = hasSelection ?? Boolean(window.getSelection()?.toString().trim());
}

export function onReadingSubtitleClick(event: MouseEvent) {
  const hadSelection = hadSelectionOnPointerDown;
  hadSelectionOnPointerDown = false;
  const target = closestSubtitleItem(event.target as Element | null);
  if (!target) {
    return;
  }
  // Don't jump if user is selecting text
  if (hadSelection || window.getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds ?? 0);
}

export function noteManualReaderInteraction(durationMs?: number) {
  subtitleScrollFollow.pauseManual(durationMs);
  updateReaderFollowState();
}

// 回位胶囊点击回调：清除手动暂停态，强制采用平滑滚动居中回到当前高亮字幕（不改播放进度）。
export function resumeReaderFollowPlayback() {
  subtitleScrollFollow.resumeAuto();
  state.reader.setNextScrollBehavior("smooth");
  updateReaderFollowState();
  syncReadingViewPlayback(true);
}

// 切集 / 换视频 / 视图关闭时的跟随状态复位：清空手动暂停、指针拖拽与在途程序化滚动代次。
export function resetReaderScrollFollow() {
  subtitleScrollFollow.resetForVideoSwitch();
  const readingView = document.getElementById(ids.readingView);
  if (
    state.reader.readingViewOpen ||
    readingView?.getAttribute("data-biliscript-reader-follow") === "manual"
  ) {
    updateReaderFollowState();
  }
}

export function updateReaderFollowState(currentTime?: number) {
  projectReaderFollowUi(subtitleScrollFollow.getMode(), currentTime);
}
