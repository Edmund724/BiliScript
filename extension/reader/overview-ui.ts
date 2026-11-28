import { state } from "../core/state.js";
import { activeById, getActiveReaderWindow } from "../shared/active-host.js";
import {
  isElementNode,
  requireActiveById,
  resolveNodeWindow,
  writeActiveClipboardText,
} from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";

import { getAsrFailureNotice, requiresAsrSetup } from "../core/asr-failure-notice.js";
import { classifyOverviewSetupError, type OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { formatClock } from "../shared/clock-text.js";
import { resolveChapterSource } from "../shared/chapter-outline.js";
import {
  buildLocalOutlineChapters,
  hasAnyOverviewAiSection,
  normalizeOverviewAiSections
} from "../shared/overview-sections.js";
import { getSiteCapabilities, normalizeSiteId, YOUTUBE_UNIT_CID } from "../shared/site.js";
import { dispatchNoteExport } from "../notes/export-actions.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import { getNoteExportActionVisual, syncNoteExportIconButton } from "../ui/note-export-visual.js";
import { READING_COPY_ICON, READING_PLAY_ICON, READING_RESET_ICON, READING_SHARE_ICON } from "../ui/reading-icons.js";
import { flashCopyFailure, flashCopySuccess } from "../ui/copy-feedback.js";
import { ids } from "./state.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { jumpReadingTarget, syncReadingOverviewActiveChapter } from "./sync.js";
import { withReader } from "../ui/reader-gate.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import { openQuoteShareModal } from "./quote-share-modal.js";
import type { AnalysisChapter, AnalysisQuote } from "../ai/analysis.js";
import type { ReaderOverviewSnapshot } from "./overview-coordinator.js";

export interface OverviewUiActions {
  generate?: () => void;
  retry: () => void;
  cancel: () => void;
  setup: (errorClass: OverviewSetupErrorClass) => void;
  openTranscribeSettings: () => void;
  openOverviewSettings?: () => void;
}

let registeredActions: OverviewUiActions | null = null;
let hadSelectionOnOverviewPointerDown = false;

export function registerOverviewUiActions(actions: OverviewUiActions): void {
  registeredActions = actions;
}

export function markOverviewPointerDownSelection(
  hasSelection = Boolean(getActiveReaderWindow().getSelection()?.toString().trim())
): void {
  hadSelectionOnOverviewPointerDown = hasSelection;
}

export function onReadingOverviewKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const actionTarget = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    "[data-overview-action='share-quote'], [data-overview-action='copy-quote']"
  );
  if (!actionTarget) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  actionTarget.click();
}

export function buildOverviewExportButtonHtml(): string {
  const visual = getNoteExportActionVisual(state.settings?.noteExportTarget);
  return `<button id="${ids.readingOverviewExportBtn}" type="button" class="biliscript-reading-icon-btn" data-overview-action="export-note" data-note-target="${visual.target}" title="${visual.label}" aria-label="${visual.label}" hidden>${visual.icon}</button>`;
}

export function syncOverviewExportButton(options: { visible?: boolean; target?: unknown } = {}): void {
  const button = activeById<HTMLButtonElement>(ids.readingOverviewExportBtn);
  if (!button) {
    return;
  }
  if (typeof options.visible === "boolean") {
    button.hidden = !options.visible;
  }
  syncNoteExportIconButton(button, options.target ?? state.settings?.noteExportTarget);
}

export function buildOverviewTabBodyHtml(): string {
  return `
              <div id="${ids.readingOverviewBody}" class="biliscript-reading-overview">
                <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
                  <div class="biliscript-reading-placeholder-title">概览还未生成</div>
                </div>
              </div>
  `;
}

export function bindReadingOverviewEvents(): void {
  const readingOverviewBody = requireActiveById(ids.readingOverviewBody);
  readingOverviewBody.addEventListener("pointerdown", () => {
    markOverviewPointerDownSelection();
  });
  readingOverviewBody.addEventListener("keydown", (event) => {
    onReadingOverviewKeyDown(event);
  });
  readingOverviewBody.addEventListener("click", (event) => {
    withReader("overview click", (reader) => reader.onReadingOverviewClick(event));
  });
  const exportBtn = activeById<HTMLButtonElement>(ids.readingOverviewExportBtn);
  exportBtn?.addEventListener("click", (event) => {
    withReader("overview export click", (reader) => reader.onReadingOverviewClick(event));
  });
}

function getClipBody(): { from: number; to: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

export function updateGeneratingStripText(text: string): boolean {
  const node = activeById(ids.readingOverviewBody)?.querySelector(
    ".biliscript-reading-ov-strip.is-generating .biliscript-reading-ov-strip-text"
  );
  if (node) {
    const nextText = text || "正在生成概览…";
    if (node.textContent !== nextText) {
      node.textContent = nextText;
    }
    return true;
  }
  return false;
}

export function renderReadingOverview(snapshot: ReaderOverviewSnapshot): void {
  const body = activeById(ids.readingOverviewBody);
  if (!body) {
    return;
  }
  body.innerHTML = buildOverviewBodyHtml(snapshot);
  syncOverviewExportButton({
    visible: snapshot.phase === "ready" || snapshot.phase === "partial"
  });
  syncReadingOverviewActiveChapter();
}

function buildOverviewBodyHtml(snapshot: ReaderOverviewSnapshot): string {
  const hotNotice = String(state.clip.hotCommentsNotice || "").trim();
  const hotNoticeStrip = hotNotice
    ? `<div class="biliscript-reading-ov-strip"><span class="biliscript-reading-ov-strip-text">${escapeHtml(hotNotice)}</span></div>`
    : "";
  switch (snapshot.phase) {
    case "empty":
      return buildEmptyStateHtml(snapshot);
    case "generating":
      return buildGeneratingStrip(snapshot) + buildResultSectionsHtml(snapshot);
    case "partial":
      return hotNoticeStrip + buildPartialStrip(snapshot) + buildResultSectionsHtml(snapshot);
    case "error":
      return buildErrorStrip(snapshot);
    case "cancelled":
      return buildCancelledStrip();
    case "ready":
      return hotNoticeStrip + buildResultSectionsHtml(snapshot);
    case "idle":
    default:
      return hotNoticeStrip + buildIdleStateHtml(snapshot);
  }
}

function getLocalOutlineChapters(): AnalysisChapter[] {
  const site = normalizeSiteId(state.clip.site ?? (state.clip.cid === YOUTUBE_UNIT_CID ? "youtube" : undefined));
  const supportsHotComments = getSiteCapabilities(site).supportsHotComments;
  const chapterSource = resolveChapterSource(
    state.clip.description,
    supportsHotComments ? state.clip.hotComments : [],
    state.clip.chapters
  );
  return buildLocalOutlineChapters(chapterSource, state.clip.videoDuration, getClipBody());
}

function buildIdleStateHtml(snapshot: ReaderOverviewSnapshot): string {
  const sections = normalizeOverviewAiSections(snapshot.sections);
  const hasAnyAi = hasAnyOverviewAiSection(sections);
  const localChapters = getLocalOutlineChapters();

  if (!hasAnyAi) {
    if (localChapters.length > 0) {
      const withHours = shouldShowHoursInNote(state.clip, getClipBody());
      const chapterBlocks = localChapters.map((item) => chapterCardHtml(item, withHours)).join("");
      return `
        <section class="biliscript-reading-ov-section">
          <div class="biliscript-reading-ov-h">章节</div>
          ${chapterBlocks}
        </section>
      `;
    }
    return `
      <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
        <div class="biliscript-reading-placeholder-title">已关闭全部 AI 概览内容</div>
        <div class="biliscript-reading-empty-actions">
          <button type="button" class="biliscript-reading-mini-btn is-primary" data-overview-action="open-overview-settings">前往设置</button>
        </div>
      </div>
    `;
  }

  if (localChapters.length > 0) {
    const withHours = shouldShowHoursInNote(state.clip, getClipBody());
    const chapterBlocks = localChapters.map((item) => chapterCardHtml(item, withHours)).join("");
    return `
      <div class="biliscript-reading-ov-strip">
        <span class="biliscript-reading-ov-strip-text">AI 概览未生成</span>
        <button type="button" class="biliscript-reading-mini-btn is-primary" data-overview-action="generate">生成 AI 概览</button>
      </div>
      <section class="biliscript-reading-ov-section">
        <div class="biliscript-reading-ov-h">章节</div>
        ${chapterBlocks}
      </section>
    `;
  }

  return `
    <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
      <div class="biliscript-reading-placeholder-title">概览还未生成</div>
      <div class="biliscript-reading-empty-actions">
        <button type="button" class="biliscript-reading-mini-btn is-primary" data-overview-action="generate">生成概览</button>
      </div>
    </div>
  `;
}

function buildEmptyStateHtml(snapshot: ReaderOverviewSnapshot): string {
  const autoGenerate = snapshot.autoGenerate !== false;
  if (isReaderTranscribing()) {
    return `
      <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
        <div class="biliscript-reading-placeholder-title">${autoGenerate ? "概览等字幕就绪后自动生成" : "字幕转写中，就绪后可手动生成概览"}</div>
      </div>
    `;
  }
  if (state.clip.subtitleFetchState === "loading") {
    return `
      <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
        <div class="biliscript-reading-placeholder-title">${autoGenerate ? "字幕抓取中，就绪后自动生成概览" : "字幕抓取中，就绪后可手动生成概览"}</div>
      </div>
    `;
  }
  let title = "该视频没有可用字幕";
  let copy = "视频概览需基于字幕生成。";
  let manualAsrAction = "";
  let settingsAction = "";
  if (state.clip.noSubtitleReason) {
    const reason = state.clip.noSubtitleReason;
    const notice = getAsrFailureNotice(reason);
    title = notice.cause || title;
    copy = notice.remedyText || copy;
    if (
      reason === "youtube-no-subtitles" ||
      reason === "youtube-captions-unavailable" ||
      reason === "asr-disabled"
    ) {
      manualAsrAction = `
        <button type="button" class="biliscript-reading-mini-btn is-primary" data-overview-action="manual-asr">使用语音转写</button>`;
    }
    if (requiresAsrSetup(reason)) {
      settingsAction = `
        <button type="button" class="biliscript-reading-mini-btn${manualAsrAction ? "" : " is-primary"}" data-overview-action="open-transcribe-settings">前往设置</button>`;
    }
  }
  const actionsHtml = manualAsrAction || settingsAction
    ? `<div class="biliscript-reading-empty-actions">${manualAsrAction}${settingsAction}</div>`
    : "";
  return `
    <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
      <div class="biliscript-reading-placeholder-title">${escapeHtml(title)}</div>
      <p class="biliscript-reading-placeholder-copy">${escapeHtml(copy)}</p>
      ${actionsHtml}
    </div>
  `;
}

function buildGeneratingStrip(snapshot: ReaderOverviewSnapshot): string {
  const text = snapshot.stripText || "正在生成概览…";
  return `
    <div class="biliscript-reading-ov-strip is-generating" role="status" aria-live="polite">
      <span class="biliscript-reading-ov-strip-text">${escapeHtml(text)}</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="cancel">取消</button>
    </div>
    <div class="biliscript-reading-ov-track" aria-hidden="true"><div class="biliscript-reading-ov-fill"></div></div>
  `;
}

function buildCancelledStrip(): string {
  return `
    <div class="biliscript-reading-ov-strip">
      <span class="biliscript-reading-ov-strip-text">已取消概览生成。</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重新生成</button>
    </div>
  `;
}

function buildPartialStrip(snapshot: ReaderOverviewSnapshot): string {
  const failedCount = snapshot.analysis?.failedRanges?.length || 0;
  const summaryFailed = snapshot.analysis?.summaryFailed === true;
  const messages: string[] = [];
  if (failedCount) {
    messages.push(`有 ${failedCount} 个分段生成失败，对应区间的章节与金句未生成。`);
  }
  if (summaryFailed) {
    messages.push("全片简介未生成。");
  }
  return `
    <div class="biliscript-reading-ov-strip is-partial" role="status" aria-live="polite">
      <span class="biliscript-reading-ov-strip-text">${messages.join(" ")}</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry-failed">${failedCount ? "重试失败区间" : "重试简介"}</button>
    </div>
  `;
}

function buildErrorStrip(snapshot: ReaderOverviewSnapshot): string {
  const errorClass = classifyOverviewSetupError(snapshot.errorText);
  const actionButton = errorClass
    ? `<button type="button" class="biliscript-reading-mini-btn is-primary" data-overview-action="setup" data-setup-class="${errorClass}">去设置</button>`
    : `<button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重试</button>`;
  return `
    <div class="biliscript-reading-ov-strip is-error" role="alert">
      <span class="biliscript-reading-ov-strip-text">概览生成失败：${escapeHtml(snapshot.errorText || "未知错误")}</span>
      ${actionButton}
    </div>
  `;
}

function buildResultSectionsHtml(snapshot: ReaderOverviewSnapshot): string {
  const analysis = snapshot.analysis;
  if (!analysis) {
    if (snapshot.phase === "generating") {
      return `
        <div class="biliscript-reading-placeholder is-generating">
          <p class="biliscript-reading-placeholder-copy">简介、章节与金句会出现在这里；期间可先在「字幕」页阅读。</p>
        </div>
      `;
    }
    return "";
  }

  const sections = normalizeOverviewAiSections(snapshot.sections);
  const withHours = shouldShowHoursInNote(state.clip, getClipBody());
  const chapters = (Array.isArray(analysis.chapters) ? analysis.chapters : []).filter(
    (item) => item && String(item.title || "").trim()
  );
  const quotes = (Array.isArray(analysis.quotes) ? analysis.quotes : []).filter(
    (item) => item && String(item?.content || "").trim()
  );
  const summary = String(analysis.summary || "").trim();
  const showSummary = sections.summary || Boolean(summary);
  const summarySection = showSummary
    ? `
    <section class="biliscript-reading-ov-section">
      <p class="biliscript-reading-ov-summary${summary ? "" : " is-empty"}">${escapeHtml(summary || "简介暂未生成")}</p>
    </section>
  `
    : "";
  const chapterBadge = sections.chapters && snapshot.aiChapters ? '<span class="biliscript-reading-ov-badge">AI 生成</span>' : "";
  const showQuotes = sections.quotes || quotes.length > 0;
  const quotesEmptyNote = quotes.length === 0 ? '<div class="biliscript-reading-ov-empty">没有可用的金句。</div>' : "";
  const quotesSection = showQuotes
    ? `
    <section class="biliscript-reading-ov-section">
      <div class="biliscript-reading-ov-h">金句<span class="biliscript-reading-ov-badge">AI 精选</span></div>
      ${quotesEmptyNote}${quotes.map((item) => quoteCardHtml(item, withHours)).join("")}
    </section>
  `
    : "";

  const footerHtml = snapshot.phase === "ready" && hasAnyOverviewAiSection(sections)
    ? `
    <div class="biliscript-reading-ov-footer">
      <button type="button" class="biliscript-reading-ov-regen-btn" data-overview-action="refresh">
        ${READING_RESET_ICON}<span>重新生成概览</span>
      </button>
    </div>`
    : "";

  const showChapters = sections.chapters || chapters.length > 0;
  let chaptersSection = "";
  if (showChapters) {
    if (chapters.length === 0) {
      chaptersSection = `
      <section class="biliscript-reading-ov-section">
        <div class="biliscript-reading-ov-h">章节</div>
        <div class="biliscript-reading-ov-empty">没有可用的章节。</div>
      </section>
    `;
    } else {
      const chapterBlocks = chapters.map((item) => chapterCardHtml(item, withHours)).join("");
      const missingCount = sections.chapters ? chapters.filter((item) => item.missingSummary).length : 0;
      const missingStrip = missingCount
        ? `
    <div class="biliscript-reading-ov-strip is-partial">
      <span class="biliscript-reading-ov-strip-text">有 ${missingCount} 个章节缺少小结。</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重新生成</button>
    </div>`
        : "";
      chaptersSection = `
    <section class="biliscript-reading-ov-section">
      <div class="biliscript-reading-ov-h">章节${chapterBadge}</div>
      ${missingStrip}${chapterBlocks}
    </section>
  `;
    }
  }

  return `
    ${summarySection}
    ${chaptersSection}
    ${quotesSection}
    ${footerHtml}
  `;
}

function chapterCardHtml(item: AnalysisChapter, withHours: boolean): string {
  const from = Number(item.from) || 0;
  const to = Number(item.to) || 0;
  const desc = String(item.summary || "").trim();
  const descHtml = desc
    ? `<span class="biliscript-reading-ov-chapter-desc">${escapeHtml(desc)}</span>`
    : item.missingSummary
      ? `<span class="biliscript-reading-ov-chapter-desc is-missing">本章概括缺失</span>`
      : "";
  return `
    <button type="button" class="biliscript-reading-ov-chapter" data-seconds="${from}" data-to="${to}">
      <span class="biliscript-reading-time">${escapeHtml(formatClock(from, { hours: withHours ? "always" : "never" }))}</span>
      <span class="biliscript-reading-ov-chapter-copy">
        <span class="biliscript-reading-ov-chapter-title">${escapeHtml(String(item.title))}</span>
        ${descHtml}
      </span>
    </button>
  `;
}

function quoteCardHtml(item: AnalysisQuote, withHours: boolean): string {
  const from = Number(item?.from) || 0;
  const content = String(item?.content || "").trim();
  if (!content) {
    return "";
  }
  return `
    <button type="button" class="biliscript-reading-ov-quote" data-seconds="${from}">
      <span class="biliscript-reading-ov-quote-text">${escapeHtml(content)}</span>
      <span class="biliscript-reading-ov-quote-foot">
        <span class="biliscript-reading-ov-quote-seek">
          <span class="biliscript-reading-ov-quote-play" aria-hidden="true">${READING_PLAY_ICON}</span>
          <span class="biliscript-reading-time">${escapeHtml(formatClock(from, { hours: withHours ? "always" : "never" }))}</span>
        </span>
        <span class="biliscript-reading-ov-quote-actions">
          <span class="biliscript-reading-ov-quote-share" role="button" tabindex="0" data-overview-action="share-quote" data-quote="${escapeHtml(content)}" aria-label="分享金句卡片" title="分享金句卡片">${READING_SHARE_ICON}</span>
          <span class="biliscript-reading-ov-quote-copy" role="button" tabindex="0" data-overview-action="copy-quote" data-quote="${escapeHtml(content)}" data-seconds="${from}" aria-label="复制该金句" title="复制该金句">${READING_COPY_ICON}</span>
        </span>
      </span>
    </button>
  `;
}

export function onReadingOverviewClick(event: MouseEvent, actions?: OverviewUiActions): void {
  const hadSelection = hadSelectionOnOverviewPointerDown;
  hadSelectionOnOverviewPointerDown = false;
  const currentActions = actions || registeredActions;
  const eventTarget = isElementNode(event.target) ? event.target : null;
  const target = eventTarget?.closest<HTMLElement>("[data-overview-action]");
  if (target) {
    const action = target.dataset.overviewAction || "";
    if (action === "generate") {
      if (currentActions?.generate) {
        currentActions.generate();
      } else {
        currentActions?.retry();
      }
      return;
    }
    if (action === "retry-failed" || action === "retry" || action === "refresh") {
      currentActions?.retry();
      return;
    }
    if (action === "export-note") {
      void exportOverviewNote(target);
      return;
    }
    if (action === "cancel") {
      currentActions?.cancel();
      return;
    }
    if (action === "setup") {
      const errorClass = target.dataset.setupClass;
      if (
        errorClass === "no-provider" ||
        errorClass === "missing-key" ||
        errorClass === "no-model"
      ) {
        currentActions?.setup(errorClass);
      }
      return;
    }
    if (action === "manual-asr") {
      void ensureSummarizeChain()
        .then((chain) =>
          chain.loadAsrSubtitle({
            runId: state.clip.fetchRunId,
            allowTranscribe: true
          })
        )
        .catch((error) => {
          const msg = String((error as Error)?.message || error || "");
          if (msg.includes("未配置语音转写服务")) {
            currentActions?.openTranscribeSettings();
          }
        });
      return;
    }
    if (action === "open-transcribe-settings") {
      currentActions?.openTranscribeSettings();
      return;
    }
    if (action === "open-overview-settings") {
      currentActions?.openOverviewSettings?.();
      return;
    }
    if (action === "copy-quote") {
      void copyQuoteToClipboard(target);
      return;
    }
    if (action === "share-quote") {
      const quote = target.dataset.quote || "";
      openQuoteShareModal({ content: quote, triggerEl: target });
      return;
    }
    return;
  }

  const seekTarget = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    ".biliscript-reading-ov-chapter, .biliscript-reading-ov-quote"
  );
  if (!seekTarget) {
    return;
  }
  if (hadSelection || getActiveReaderWindow().getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(seekTarget.dataset.seconds ?? 0);
}

async function exportOverviewNote(button: HTMLElement): Promise<void> {
  if (button.dataset.exporting === "1") {
    return;
  }
  button.dataset.exporting = "1";
  const btn = button as HTMLButtonElement;
  btn.disabled = true;
  button.classList.add("is-loading");
  button.setAttribute("aria-busy", "true");
  const visual = getNoteExportActionVisual(state.settings?.noteExportTarget);
  try {
    const result = await dispatchNoteExport();
    if (result.ok) {
      const successVisual = getNoteExportActionVisual(result.target ?? visual.target);
      flashCopySuccess(button, {
        originalSvg: successVisual.icon,
        originalLabel: successVisual.label,
        copiedLabel: successVisual.successLabel
      });
    } else {
      flashCopyFailure(button, {
        originalLabel: visual.label,
        failedLabel: visual.failedLabel
      });
    }
  } catch {
    flashCopyFailure(button, {
      originalLabel: visual.label,
      failedLabel: visual.failedLabel
    });
  } finally {
    delete button.dataset.exporting;
    btn.disabled = false;
    button.classList.remove("is-loading");
    button.removeAttribute("aria-busy");
  }
}

async function copyQuoteToClipboard(quoteEl: HTMLElement): Promise<void> {
  const seconds = Number(quoteEl.dataset.seconds) || 0;
  const content = quoteEl.dataset.quote || "";
  const hours = shouldShowHoursInNote(state.clip, getClipBody()) ? "always" : "never";
  const text = `${formatClock(seconds, { hours })} 「${content}」`;
  if (!content) {
    flashCopyFailure(quoteEl, { originalLabel: "复制该金句" });
    return;
  }

  try {
    await writeActiveClipboardText(text, resolveNodeWindow(quoteEl));
    flashCopySuccess(quoteEl, { originalSvg: READING_COPY_ICON, originalLabel: "复制该金句" });
  } catch {
    flashCopyFailure(quoteEl, { originalLabel: "复制该金句" });
  }
}
