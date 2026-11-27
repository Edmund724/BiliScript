import { state } from "../core/state.js";
import { activeById, onActiveHostChange } from "../shared/active-host.js";
import { formatClock } from "../shared/clock-text.js";
import {
  isNode,
  requireActiveById,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
  scheduleActiveAnimationFrame,
  writeActiveClipboardText,
  type ActiveAnimationFrameHandle,
} from "../shared/cross-doc.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import { addVideoHighlight, type NoteHighlightSource } from "../notes/highlights-store.js";
import { withReader } from "../ui/reader-gate.js";
import {
  animateTriggerExit,
  cancelTriggerExit,
  prefersReducedMotion,
  TRIGGER_ENTER_EASING
} from "../ui/trigger-motion.js";
import { ids } from "./state.js";
import {
  closestSubtitleItem,
  findSubtitleItem,
  getMainLineText,
  getSubtextNode,
  SUBTITLE_SUBTEXT_CLASS
} from "./subtitle-item-dom.js";
import {
  currentHighlightVideoKey,
  syncSubtitleHighlightsCache
} from "./subtitle-highlights-ui.js";

export type SelectionToolbarAction = "highlight" | "explain" | "quote-card" | "copy-timestamp";

interface SelectionSnapshot {
  source: NoteHighlightSource;
  selection: string;
  line: string;
  from: number | null;
  itemIndex: string;
  inReadySubtext: boolean;
}

interface PendingPlacementTarget {
  anchorEl: HTMLElement;
  range: Range;
  snapshot: SelectionSnapshot;
}

export function buildExplainPopHtml(): string {
  return `
            <div id="${ids.readingExplainPop}" class="biliscript-reading-explain-pop" role="toolbar" aria-label="划词快捷操作" hidden>
              <button type="button" class="biliscript-selection-pill-btn" data-selection-action="highlight">高亮存笔记</button>
              <button type="button" class="biliscript-selection-pill-btn biliscript-reading-explain-btn" data-selection-action="explain">AI 解释</button>
              <button type="button" class="biliscript-selection-pill-btn" data-selection-action="quote-card">生成金句卡</button>
              <button type="button" class="biliscript-selection-pill-btn" data-selection-action="copy-timestamp">复制带时间戳</button>
            </div>
  `;
}

export function buildExplainCardHostHtml(): string {
  return `
            <div id="${ids.readingExplainCard}" class="biliscript-reading-explain-card" hidden></div>
  `;
}

export function formatSelectionTimestampCopy(
  selection: string,
  from: number | null,
  withHours: boolean
): string {
  const cleanText = String(selection || "").trim();
  if (!cleanText) {
    return "";
  }
  if (from === null || !Number.isFinite(from) || from < 0) {
    return cleanText;
  }
  return `[${formatClock(from, { hours: withHours ? "always" : "never" })}] ${cleanText}`;
}

export function computeSelectionPopPosition(params: {
  containerRect: { left: number; top: number; width: number; height: number };
  selectionRect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
  popWidth: number;
  popHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
  gap?: number;
}): { left: number; top: number; placedAbove: boolean; originX: number; originY: number } {
  const margin = params.margin ?? 8;
  const gap = params.gap ?? 4;
  const { containerRect, selectionRect, popWidth, popHeight, viewportWidth, viewportHeight } = params;

  const selectionCenter = Math.round(selectionRect.left + selectionRect.width / 2 - containerRect.left);
  const containerMaxLeft = Math.max(margin, Math.round(containerRect.width) - popWidth - margin);

  const viewportMinLeft = Math.max(margin, Math.round(margin - containerRect.left));
  const viewportMaxLeft =
    viewportWidth > 0
      ? Math.min(containerMaxLeft, Math.round(viewportWidth - margin - popWidth - containerRect.left))
      : containerMaxLeft;
  const minLeft = Math.min(viewportMinLeft, containerMaxLeft);
  const maxLeft = Math.max(minLeft, viewportMaxLeft);
  const left = Math.min(Math.max(minLeft, selectionCenter - Math.round(popWidth / 2)), maxLeft);

  const aboveTop = Math.round(selectionRect.top - containerRect.top) - popHeight - gap;
  const belowTop = Math.round(selectionRect.bottom - containerRect.top) + gap;
  const containerMaxTop = Math.max(margin, Math.round(containerRect.height) - popHeight - margin);

  const aboveInContainer = aboveTop >= margin;
  const aboveInViewport = selectionRect.top - popHeight - gap >= margin;
  const belowInContainer = belowTop + popHeight <= containerRect.height - margin;
  const belowInViewport =
    viewportHeight <= 0 || selectionRect.bottom + gap + popHeight <= viewportHeight - margin;

  let top: number;
  let placedAbove: boolean;
  if (aboveInContainer && aboveInViewport) {
    top = aboveTop;
    placedAbove = true;
  } else if (belowInContainer && belowInViewport) {
    top = Math.max(margin, belowTop);
    placedAbove = false;
  } else if (aboveInContainer) {
    top = aboveTop;
    placedAbove = true;
  } else {
    top = Math.min(Math.max(margin, belowTop), containerMaxTop);
    placedAbove = false;
  }

  const originX = Math.max(-24, Math.min(popWidth + 24, selectionCenter - left));
  const originY = placedAbove
    ? Math.round(selectionRect.top - containerRect.top) - top
    : Math.round(selectionRect.bottom - containerRect.top) - top;

  return { left, top, placedAbove, originX, originY };
}

let cleanupExplainHostBindings: (() => void) | null = null;

export function unbindReadingExplainEvents(): void {
  cleanupExplainHostBindings?.();
  cleanupExplainHostBindings = null;
}

export function bindReadingExplainEvents(): void {
  unbindReadingExplainEvents();

  const readingExplainPop = requireActiveById(ids.readingExplainPop);
  const popContainer =
    (readingExplainPop.parentElement as HTMLElement | null) ?? requireActiveById(ids.readingScriptPanel);
  const subtitleList = requireActiveById(ids.readingSubtitleList);
  const overviewBody = activeById(ids.readingOverviewBody);

  let pendingSelection: SelectionSnapshot | null = null;
  let pendingTarget: PendingPlacementTarget | null = null;
  let lastPlacedTarget: PendingPlacementTarget | null = null;
  let showFrameHandle: ActiveAnimationFrameHandle | null = null;
  let measureFrameHandle: ActiveAnimationFrameHandle | null = null;
  let feedbackTimer: ReturnType<typeof setTimeout> | null = null;

  const POP_WIDTH_FALLBACK = 286;
  const POP_HEIGHT_FALLBACK = 34;
  let popWidth = POP_WIDTH_FALLBACK;
  let popHeight = POP_HEIGHT_FALLBACK;
  let popSizeMeasured = false;
  let lastSelectionRect: DOMRect | null = null;

  const clearFeedbackTimer = () => {
    if (feedbackTimer !== null) {
      clearTimeout(feedbackTimer);
      feedbackTimer = null;
    }
  };

  const resetActionButtonLabels = () => {
    const labels: Record<SelectionToolbarAction, string> = {
      highlight: "高亮存笔记",
      explain: "AI 解释",
      "quote-card": "生成金句卡",
      "copy-timestamp": "复制带时间戳"
    };
    readingExplainPop.querySelectorAll<HTMLButtonElement>("[data-selection-action]").forEach((btn) => {
      const action = btn.dataset.selectionAction as SelectionToolbarAction | undefined;
      if (action && labels[action]) {
        btn.textContent = labels[action];
      }
      btn.classList.remove("is-feedback");
    });
  };

  const cancelPopFrames = () => {
    if (showFrameHandle) {
      showFrameHandle.cancel();
      showFrameHandle = null;
    }
    if (measureFrameHandle) {
      measureFrameHandle.cancel();
      measureFrameHandle = null;
    }
    pendingTarget = null;
  };

  const hideExplainPop = () => {
    cancelPopFrames();
    clearFeedbackTimer();
    popSizeMeasured = false;
    lastPlacedTarget = null;
    if (readingExplainPop.hidden && !pendingSelection) {
      return;
    }
    delete readingExplainPop.dataset.itemIndex;
    delete readingExplainPop.dataset.source;
    delete readingExplainPop.dataset.placement;
    pendingSelection = null;
    const savedRect = lastSelectionRect;
    lastSelectionRect = null;
    if (readingExplainPop.hidden) {
      return;
    }
    animateTriggerExit({
      target: readingExplainPop,
      trigger: savedRect,
      fallbackOrigin: "bottom center",
      toScale: 0.92,
      durationMs: 110,
      onFinish: () => {
        readingExplainPop.hidden = true;
        resetActionButtonLabels();
      }
    });
  };

  const explainAnchorRect = (range: Range, fallbackEl: HTMLElement): DOMRect => {
    const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
    if (rect && (rect.width || rect.height || rect.top || rect.left)) {
      return rect;
    }
    return fallbackEl.getBoundingClientRect();
  };

  const placeExplainPop = (target: PendingPlacementTarget) => {
    const containerRect = popContainer.getBoundingClientRect();
    const rect = explainAnchorRect(target.range, target.anchorEl);
    const width = popWidth || POP_WIDTH_FALLBACK;
    const height = popHeight || POP_HEIGHT_FALLBACK;

    const activeWin = resolveNodeWindow(readingExplainPop);
    const placed = computeSelectionPopPosition({
      containerRect,
      selectionRect: rect,
      popWidth: width,
      popHeight: height,
      viewportWidth: activeWin ? activeWin.innerWidth : 0,
      viewportHeight: activeWin ? activeWin.innerHeight : 0
    });

    const wasHidden = readingExplainPop.hidden || readingExplainPop.hasAttribute("data-biliscript-closing");
    cancelTriggerExit(readingExplainPop);
    clearFeedbackTimer();
    resetActionButtonLabels();
    lastSelectionRect = rect;
    pendingSelection = target.snapshot;
    lastPlacedTarget = target;
    readingExplainPop.dataset.itemIndex = target.snapshot.itemIndex;
    readingExplainPop.dataset.source = target.snapshot.source;
    readingExplainPop.dataset.placement = placed.placedAbove ? "above" : "below";
    readingExplainPop.style.left = `${placed.left}px`;
    readingExplainPop.style.top = `${placed.top}px`;
    readingExplainPop.style.transformOrigin = `${Math.round(placed.originX)}px ${Math.round(placed.originY)}px`;
    readingExplainPop.hidden = false;
    if (wasHidden && !prefersReducedMotion(readingExplainPop) && typeof readingExplainPop.animate === "function") {
      try {
        readingExplainPop.animate(
          [
            { opacity: 0, scale: "0.92" },
            { opacity: 1, scale: "1" }
          ],
          { duration: 150, easing: TRIGGER_ENTER_EASING, fill: "none" }
        );
      } catch {}
    }
  };

  const runExplainPopFrame = () => {
    showFrameHandle = null;
    const target = pendingTarget;
    pendingTarget = null;
    if (!target) {
      return;
    }
    placeExplainPop(target);
    if (!popSizeMeasured && !measureFrameHandle) {
      measureFrameHandle = scheduleActiveAnimationFrame(() => {
        measureFrameHandle = null;
        if (readingExplainPop.hidden) {
          return;
        }
        const prevWidth = popWidth;
        const prevHeight = popHeight;
        popWidth = readingExplainPop.offsetWidth || POP_WIDTH_FALLBACK;
        popHeight = readingExplainPop.offsetHeight || POP_HEIGHT_FALLBACK;
        popSizeMeasured = true;
        if ((popWidth !== prevWidth || popHeight !== prevHeight) && lastPlacedTarget) {
          placeExplainPop(lastPlacedTarget);
        }
      }, resolveNodeWindow(readingExplainPop));
    }
  };

  const showExplainPopForTarget = (target: PendingPlacementTarget) => {
    pendingTarget = {
      anchorEl: target.anchorEl,
      range: target.range.cloneRange(),
      snapshot: target.snapshot
    };
    if (!showFrameHandle) {
      showFrameHandle = scheduleActiveAnimationFrame(
        runExplainPopFrame,
        resolveNodeWindow(readingExplainPop)
      );
    }
  };

  const elementFromNode = (node: Node | null | undefined): Element | null => {
    if (!node) {
      return null;
    }
    return node.nodeType === 3 ? node.parentElement : (node as Element);
  };

  const resolveSubtitleSelection = (
    range: Range,
    startEl: Element | null,
    endEl: Element | null,
    text: string
  ): PendingPlacementTarget | null => {
    const startItem = closestSubtitleItem(startEl);
    const endItem = closestSubtitleItem(endEl);
    if (!startItem || !endItem || startItem !== endItem || !subtitleList.contains(startItem)) {
      return null;
    }

    const touchesTime = Boolean(
      startEl?.closest(".biliscript-reading-time") ||
      endEl?.closest(".biliscript-reading-time") ||
      (startItem === endItem &&
        (() => {
          const timeEl = startItem.querySelector<HTMLElement>(".biliscript-reading-time");
          return Boolean(timeEl && typeof range.intersectsNode === "function" && range.intersectsNode(timeEl));
        })())
    );
    if (touchesTime) {
      return null;
    }

    const startSub = startEl?.closest<HTMLElement>(`.${SUBTITLE_SUBTEXT_CLASS}`) ?? null;
    const endSub = endEl?.closest<HTMLElement>(`.${SUBTITLE_SUBTEXT_CLASS}`) ?? null;
    const subEl = startItem === endItem ? getSubtextNode(startItem) : null;
    const subNotReady = Boolean(subEl && subEl.dataset.state !== "ready");
    const touchesInvalidSubtext =
      Boolean((startSub && startSub.dataset.state !== "ready") || (endSub && endSub.dataset.state !== "ready")) ||
      Boolean(subNotReady && subEl && typeof range.intersectsNode === "function" && range.intersectsNode(subEl));
    if (touchesInvalidSubtext) {
      return null;
    }

    const inReadySubtext = Boolean(
      (startSub && startSub.dataset.state === "ready") || (endSub && endSub.dataset.state === "ready")
    );
    const mainLine = getMainLineText(startItem).trim();
    const subLine = inReadySubtext ? getSubtextNode(startItem)?.textContent?.trim() || "" : "";
    const line =
      startItem === endItem
        ? mainLine && subLine
          ? `${mainLine}（${subLine}）`
          : mainLine
        : text;
    const fromSeconds = Number(startItem.dataset.seconds);
    return {
      anchorEl: startItem,
      range,
      snapshot: {
        source: "subtitle",
        selection: text,
        line: line || text,
        from: Number.isFinite(fromSeconds) && fromSeconds >= 0 ? fromSeconds : 0,
        itemIndex: startItem.dataset.index || "",
        inReadySubtext
      }
    };
  };

  const resolveOverviewSelection = (
    range: Range,
    startEl: Element | null,
    endEl: Element | null,
    text: string
  ): PendingPlacementTarget | null => {
    const currentOverviewBody = overviewBody ?? activeById(ids.readingOverviewBody);
    if (!currentOverviewBody || currentOverviewBody.closest("[hidden]")) {
      return null;
    }
    if (!startEl || !endEl || !currentOverviewBody.contains(startEl) || !currentOverviewBody.contains(endEl)) {
      return null;
    }
    const disallowed = ".biliscript-reading-ov-strip, .biliscript-reading-ov-footer, .biliscript-reading-placeholder, .biliscript-reading-ov-quote-actions, .biliscript-reading-time";
    if (startEl.closest(disallowed) || endEl.closest(disallowed)) {
      return null;
    }
    const anchorBlock =
      startEl.closest<HTMLElement>(
        ".biliscript-reading-ov-chapter, .biliscript-reading-ov-quote, .biliscript-reading-ov-summary"
      ) ?? null;
    if (!anchorBlock || !currentOverviewBody.contains(anchorBlock)) {
      return null;
    }

    const rawSeconds = anchorBlock.dataset.seconds;
    const parsedSeconds = rawSeconds !== undefined && rawSeconds !== "" ? Number(rawSeconds) : NaN;
    const from = Number.isFinite(parsedSeconds) && parsedSeconds >= 0 ? parsedSeconds : null;
    const blockText =
      anchorBlock.querySelector<HTMLElement>(".biliscript-reading-ov-quote-text")?.textContent?.trim() ||
      anchorBlock.querySelector<HTMLElement>(".biliscript-reading-ov-chapter-copy")?.textContent?.trim() ||
      anchorBlock.textContent?.trim() ||
      text;

    return {
      anchorEl: anchorBlock,
      range,
      snapshot: {
        source: "overview",
        selection: text,
        line: blockText,
        from,
        itemIndex: "",
        inReadySubtext: false
      }
    };
  };

  const syncExplainPopWithSelection = () => {
    if (state.reader.readingSettingsExpanded) {
      hideExplainPop();
      return;
    }
    const selection = resolveNodeWindow(readingExplainPop).getSelection?.();
    const text = selection?.toString().trim() || "";
    if (!selection || !text || selection.rangeCount === 0) {
      hideExplainPop();
      return;
    }
    const range = selection.getRangeAt(0);
    const startEl = elementFromNode(range.startContainer);
    const endEl = elementFromNode(range.endContainer);

    const target =
      resolveSubtitleSelection(range, startEl, endEl, text) ??
      resolveOverviewSelection(range, startEl, endEl, text);
    if (!target) {
      hideExplainPop();
      return;
    }
    showExplainPopForTarget(target);
  };

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && !readingExplainPop.hidden) {
      event.preventDefault();
      hideExplainPop();
    }
  };

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (readingExplainPop.hidden) {
      return;
    }
    if (isNode(event.target) && readingExplainPop.contains(event.target)) {
      return;
    }
    hideExplainPop();
  };

  const onWindowResize = () => {
    if (!readingExplainPop.hidden) {
      hideExplainPop();
    }
  };

  let boundDoc: Document | null = null;
  let boundWin: Window | null = null;

  const unbindHostListeners = () => {
    safeRemoveListener(boundDoc, "selectionchange", syncExplainPopWithSelection);
    safeRemoveListener(boundDoc, "keydown", onDocumentKeyDown);
    safeRemoveListener(boundDoc, "pointerdown", onDocumentPointerDown);
    safeRemoveListener(boundWin, "resize", onWindowResize);
    boundDoc = null;
    boundWin = null;
  };

  const bindHostListeners = (doc: Document, win: Window) => {
    unbindHostListeners();
    boundDoc = doc;
    boundWin = win;
    doc.addEventListener("selectionchange", syncExplainPopWithSelection);
    doc.addEventListener("keydown", onDocumentKeyDown);
    doc.addEventListener("pointerdown", onDocumentPointerDown);
    win.addEventListener("resize", onWindowResize);
  };

  bindHostListeners(resolveNodeDocument(readingExplainPop), resolveNodeWindow(readingExplainPop));
  const stopHostWatch = onActiveHostChange((ctx) => {
    cancelPopFrames();
    hideExplainPop();
    let connected = false;
    try {
      connected = Boolean(readingExplainPop.isConnected);
    } catch {
      connected = false;
    }
    if (connected) {
      bindHostListeners(ctx.doc, ctx.win);
    } else {
      unbindHostListeners();
    }
  });
  cleanupExplainHostBindings = () => {
    stopHostWatch();
    unbindHostListeners();
    cancelPopFrames();
    clearFeedbackTimer();
  };

  readingExplainPop.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  subtitleList.addEventListener("scroll", hideExplainPop, { passive: true });
  overviewBody?.addEventListener("scroll", hideExplainPop, { passive: true });
  requireActiveById(ids.readingTabBodyOverview).addEventListener("scroll", hideExplainPop, { passive: true });

  const flashButtonAndClose = (btn: HTMLButtonElement, message: string) => {
    clearFeedbackTimer();
    btn.textContent = message;
    btn.classList.add("is-feedback");
    resolveNodeWindow(readingExplainPop).getSelection?.()?.removeAllRanges();
    feedbackTimer = setTimeout(() => {
      feedbackTimer = null;
      hideExplainPop();
    }, 450);
  };

  readingExplainPop.addEventListener("click", (event) => {
    const btn = (event.target as HTMLElement | null)?.closest<HTMLButtonElement>(
      "[data-selection-action], .biliscript-reading-explain-btn"
    );
    if (!btn) {
      return;
    }
    const action = (btn.dataset.selectionAction ||
      (btn.classList.contains("biliscript-reading-explain-btn") ? "explain" : "")) as
      | SelectionToolbarAction
      | "";
    const snapshot = pendingSelection;
    if (!action || !snapshot) {
      hideExplainPop();
      return;
    }

    if (action === "explain") {
      const itemIndex = snapshot.itemIndex !== "" ? Number(snapshot.itemIndex) : -1;
      const itemNode =
        snapshot.source === "subtitle" && Number.isFinite(itemIndex) && itemIndex >= 0
          ? findSubtitleItem(subtitleList, itemIndex)
          : null;
      let line = snapshot.line;
      let from = snapshot.from ?? 0;
      if (itemNode) {
        const mainLine = getMainLineText(itemNode).trim();
        const subLine = snapshot.inReadySubtext ? getSubtextNode(itemNode)?.textContent?.trim() || "" : "";
        line = mainLine && subLine ? `${mainLine}（${subLine}）` : mainLine || line;
        from = Number(itemNode.dataset.seconds || 0) || 0;
      }
      if (!line) {
        hideExplainPop();
        return;
      }
      const payload = {
        selection: snapshot.selection,
        line,
        from,
        index: itemNode ? itemIndex : -1
      };
      resolveNodeWindow(readingExplainPop).getSelection?.()?.removeAllRanges();
      hideExplainPop();
      withReader("open explain card", (reader) => reader.openReaderExplainCard(payload));
      return;
    }

    if (action === "quote-card") {
      const content = snapshot.selection;
      resolveNodeWindow(readingExplainPop).getSelection?.()?.removeAllRanges();
      hideExplainPop();
      withReader("open quote share modal", (reader) =>
        reader.openQuoteShareModal({ content, triggerEl: btn })
      );
      return;
    }

    if (action === "copy-timestamp") {
      const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
      const withHours = shouldShowHoursInNote(state.clip, body);
      const copyText = formatSelectionTimestampCopy(snapshot.selection, snapshot.from, withHours);
      void (async () => {
        try {
          await writeActiveClipboardText(copyText, resolveNodeWindow(readingExplainPop));
          flashButtonAndClose(btn, "已复制 ✓");
        } catch {
          flashButtonAndClose(btn, "复制失败");
        }
      })();
      return;
    }

    if (action === "highlight") {
      const videoKey = currentHighlightVideoKey();
      const parsedIdx = snapshot.itemIndex !== "" ? Number(snapshot.itemIndex) : undefined;
      const subtitleIndex =
        snapshot.source === "subtitle" && parsedIdx !== undefined && Number.isInteger(parsedIdx) && parsedIdx >= 0
          ? parsedIdx
          : undefined;
      void (async () => {
        const res = await addVideoHighlight(videoKey, {
          text: snapshot.selection,
          from: snapshot.from,
          source: snapshot.source,
          subtitleIndex
        });
        if (videoKey) {
          syncSubtitleHighlightsCache(videoKey, res.items);
        }
        flashButtonAndClose(btn, res.added ? "已存笔记 ✓" : "已在笔记中");
      })();
    }
  });

  const readingExplainCard = requireActiveById(ids.readingExplainCard);
  readingExplainCard.addEventListener("click", (event) => {
    withReader("explain card click", (reader) => reader.onReaderExplainCardClick(event as MouseEvent));
  });
}
