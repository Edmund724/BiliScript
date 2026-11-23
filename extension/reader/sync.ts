import { state } from "../core/state.js";
import { activeById, getActiveReaderWindow, isReaderDetached } from "../shared/active-host.js";
import { requireActiveById } from "../shared/cross-doc.js";
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
import { showSubtitleNotice } from "./subtitle-notice.js";
import { readerPorts } from "./reader-bus.js";
import { updateReadingTranscribeBanner } from "./transcribe-banner.js";
import { isReaderExplainCardOpen } from "./explain-card.js";
import { closestSubtitleItem, findSubtitleItem, SUBTITLE_ITEM_CLASS } from "./subtitle-item-dom.js";
import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";

let syncScope: DisposableContext | null = null;
let hadSelectionOnPointerDown = false;

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
  if (isReadingSubtitleBodyVisible()) {
    const subtitleIndex = findActiveSubtitleIndex(currentTime);
    const chapterIndex = findActiveChapterIndex(currentTime);
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

  const body = activeById(ids.readingOverviewBody);
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
  const subtitleList = requireActiveById(ids.readingSubtitleList);
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

  let scrollDeferred = false;

  if (shouldScroll) {
    if (subtitleScrollFollow.isManualPaused()) {
      updateReaderFollowState(currentTime);
      state.reader.setActiveSubtitleIndex(subtitleIndex);
      state.reader.setActiveChapterIndex(chapterIndex);
      return;
    }
    let scrollSubtitleNode = subtitleHit.next;
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

  const subtitleList = requireActiveById(ids.readingSubtitleList);
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
  if (isReaderDetached()) {
    getActiveReaderWindow().focus?.();
  }
  syncReadingViewPlayback(true, nextTime);
  return nextTime;
}

export function jumpReadingTarget(seconds: number | string) {
  seekReadingTarget(seconds, { resumePlayback: true, scrollBehavior: "smooth" });
}

export function markSubtitlePointerDownSelection(hasSelection?: boolean) {
  hadSelectionOnPointerDown =
    hasSelection ?? Boolean(getActiveReaderWindow().getSelection()?.toString().trim());
}

export function onReadingSubtitleClick(event: MouseEvent) {
  const hadSelection = hadSelectionOnPointerDown;
  hadSelectionOnPointerDown = false;
  const target = closestSubtitleItem(event.target as Element | null);
  if (!target) {
    return;
  }
  if (hadSelection || getActiveReaderWindow().getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(target.dataset.seconds ?? 0);
}

export function noteManualReaderInteraction(durationMs?: number) {
  subtitleScrollFollow.pauseManual(durationMs);
  updateReaderFollowState();
}

export function resumeReaderFollowPlayback() {
  subtitleScrollFollow.resumeAuto();
  state.reader.setNextScrollBehavior("smooth");
  updateReaderFollowState();
  syncReadingViewPlayback(true);
}

export function resetReaderScrollFollow() {
  subtitleScrollFollow.resetForVideoSwitch();
  const readingView = activeById(ids.readingView);
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
