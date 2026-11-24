import { state } from "../core/state.js";
import { requireActiveById } from "../shared/cross-doc.js";
import {
  getReadingSubtitleItems,
  getReadingSubtitlePlaceholderText
} from "../subtitle/core.js";
import { escapeHtml } from "../shared/string-utils.js";
import { getAsrFailureNotice, requiresAsrSetup } from "../core/asr-failure-notice.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import {
  SUBTITLE_FIRST_BATCH,
  buildReadingSubtitleItemHtml,
  calibrateReadingSubtitleItemEstimate,
  cancelReadingSubtitleAppend,
  startReadingSubtitleAppendTask
} from "./batched-render.js";
import {
  clearSubtitleItemIndex,
  indexSubtitleItems
} from "./subtitle-item-dom.js";
import { applyReadingViewPresentation } from "./presentation.js";
import { ids } from "./state.js";
import { subtitleScrollFollow } from "./subtitle-scroll-follow.js";
import { projectReaderSettingsMode } from "./settings-mode.js";
import {
  applySubtitleHighlightsToList,
  refreshSubtitleHighlightsFromStore
} from "./subtitle-highlights-ui.js";

export interface ReaderViewProjection {
  readonly id: string;
  project(): void;
}

function projectReadingMetaLine(): void {
  const metaNode = requireActiveById(ids.readingMeta);
  if (!metaNode) {
    return;
  }
  const metaLine = buildReadingMetaLine();
  metaNode.textContent = metaLine;
  metaNode.hidden = !metaLine;
}

function buildReadingMetaLine() {
  const head = [];
  if (state.clip.author) {
    const authorLabel = state.clip.site === "youtube" ? "作者" : "UP主";
    head.push(`${authorLabel}：${state.clip.author}`);
  }
  if (Number(state.clip.pageCount) > 1) {
    const page = `P${Number(state.clip.pageIndex) > 0 ? Number(state.clip.pageIndex) : 1}`;
    const pageTitle = String(state.clip.pageTitle || "").trim();
    head.push(pageTitle ? `${page}：${pageTitle}` : page);
  }
  return head.join("\n");
}

function projectReadingSubtitleList(): void {
  cancelReadingSubtitleAppend();
  const body = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
  const subtitleItems = getReadingSubtitleItems();
  const withHours = shouldShowHoursInNote(state.clip, body);

  const subtitleList = requireActiveById(ids.readingSubtitleList);
  subtitleScrollFollow.guardLayoutReset();
  clearSubtitleItemIndex(subtitleList);
  if (subtitleItems.length === 0) {
    const isEmpty = state.clip.subtitleFetchState === "empty";
    const isError = state.clip.subtitleFetchState === "error";
    const detailHtml =
      isEmpty && state.clip.noSubtitleDetail
        ? `<div class="biliscript-reading-empty-detail">${escapeHtml(state.clip.noSubtitleDetail)}</div>`
        : "";
    const setupAction =
      isEmpty && requiresAsrSetup(state.clip.noSubtitleReason)
        ? `<button type="button" class="biliscript-reading-mini-btn is-primary" data-subtitle-action="asr-setup">前往设置</button>`
        : "";
    const retryAction =
      isError || (isEmpty && getAsrFailureNotice(state.clip.noSubtitleReason)?.remedy === "retry-later")
        ? `<button type="button" class="biliscript-reading-mini-btn" data-subtitle-action="retry-fetch">重新抓取</button>`
        : "";
    const actionsHtml = `${setupAction}${retryAction}`;
    const actionsWrap = actionsHtml
      ? `<div class="biliscript-reading-empty-actions">${actionsHtml}</div>`
      : "";
    subtitleList.innerHTML = `<div class="biliscript-reading-empty">${escapeHtml(
      getReadingSubtitlePlaceholderText()
    )}${detailHtml}${actionsWrap}</div>`;
  } else {
    const firstEnd = Math.min(subtitleItems.length, SUBTITLE_FIRST_BATCH);
    let firstHtml = "";
    for (let i = 0; i < firstEnd; i += 1) {
      firstHtml += buildReadingSubtitleItemHtml(subtitleItems[i], withHours);
    }
    subtitleList.innerHTML = firstHtml;
    indexSubtitleItems(subtitleList, subtitleList.children);
    applySubtitleHighlightsToList(subtitleList);
    void refreshSubtitleHighlightsFromStore();
    calibrateReadingSubtitleItemEstimate(subtitleList);
    if (firstEnd < subtitleItems.length) {
      startReadingSubtitleAppendTask({
        listEl: subtitleList,
        items: subtitleItems,
        cursor: firstEnd,
        withHours
      });
    }
  }
}

export function renderReaderPanels() {
  projectReaderSettingsMode();
  if (state.reader.readingSettingsExpanded) {
    void (async () => {
      const mod = await import("../ui/settings-panel.js").catch(() => null);
      mod?.renderReaderSettingsPanel();
    })();
  }
}

const BASE_PROJECTIONS: readonly ReaderViewProjection[] = [
  { id: "meta-line", project: projectReadingMetaLine },
  { id: "subtitle-list", project: projectReadingSubtitleList },
  { id: "reader-panels", project: renderReaderPanels },
  { id: "presentation", project: applyReadingViewPresentation }
];

export function createViewRender(options: {
  sessionProjections: readonly ReaderViewProjection[];
}): { projections: readonly ReaderViewProjection[]; render(): void } {
  const projections: ReaderViewProjection[] = [...BASE_PROJECTIONS, ...options.sessionProjections];
  function render(): void {
    for (const { project } of projections) {
      project();
    }
    state.reader.setActiveSubtitleIndex(-1);
    state.reader.setActiveChapterIndex(-1);
  }
  return { projections, render };
}
