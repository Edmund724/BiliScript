// 概览 tab 的呈现与交互（arch-slim-2/06 占位 + 点击委托；arch-review-batch3/02 承接 HTML 拼装与事件分派）。
// 协调逻辑（相位机/并发闸门/wait ticker/去重）收在 reader/overview-coordinator.ts。
//
// 纪律：
//  1. 呈现单向依赖快照：renderReadingOverview 改吃 ReaderOverviewSnapshot 快照，不直读协调器模块级变量；
//  2. 依赖方向单向：呈现层不得反向 import 协调器，动作通过 registerOverviewUiActions 或入参注入；
//  3. 宿主整块重建：reader 域装载后的渲染一律由 renderReadingOverview 整块重建内容，容器不换。

import { state } from "../core/state.js";
import { byId } from "../shared/dom-utils.js";
import { escapeHtml } from "../shared/string-utils.js";
import { splitOutlineChapterTitle, type ChapterSourceKind } from "../shared/chapter-outline.js";
import { getAsrFailureNotice } from "../core/asr-failure-notice.js";
import { formatClock } from "../shared/clock-text.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { setMessage } from "../core/ui-status.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import { READING_COPY_ICON, READING_PLAY_ICON, READING_SHARE_ICON } from "../ui/reading-icons.js";
import { flashCopySuccess } from "../ui/copy-feedback.js";
import { ids } from "./state.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { jumpReadingTarget } from "./sync.js";
import { withReader } from "../ui/reader-gate.js";
import { openQuoteShareModal } from "./quote-share-modal.js";
import type { AnalysisChapter, AnalysisQuote } from "../ai/analysis.js";
import type { ReaderOverviewSnapshot } from "./overview-coordinator.js";

export interface OverviewUiActions {
  retry: () => void;
  cancel: () => void;
}

let registeredActions: OverviewUiActions | null = null;

export function registerOverviewUiActions(actions: OverviewUiActions): void {
  registeredActions = actions;
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
  // ===== PR4 概览 tab：章节/金句点击跳播 + 重试/笔记按钮 =====
  // 事件委托挂概览渲染宿主（内容被状态机整块重建，容器不换）；逻辑经 ui/reader-gate
  // 装载后转发，与章节 rail / 字幕句点击同款接线。
  const readingOverviewBody = byId(ids.readingOverviewBody);
  readingOverviewBody.addEventListener("click", (event) => {
    withReader("overview click", (reader) => reader.onReadingOverviewClick(event));
  });
}

function getClipBody(): { from: number; to: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

/**
 * 就地更新生成中状态条文案（tick 专用，不整块重渲以避免丢失选区与滚动位置）。
 * 若状态条节点不存在则返回 false，通知调用方整块补渲。
 */
export function updateGeneratingStripText(text: string): boolean {
  const node = document
    .getElementById(ids.readingOverviewBody)
    ?.querySelector(".biliscript-reading-ov-strip-text");
  if (node) {
    if (text) {
      node.textContent = text;
    }
    return true;
  }
  return false;
}

/**
 * 将快照投影到 DOM 渲染宿主中。
 */
export function renderReadingOverview(snapshot: ReaderOverviewSnapshot): void {
  const body = document.getElementById(ids.readingOverviewBody);
  if (!body) {
    return;
  }
  body.innerHTML = buildOverviewBodyHtml(snapshot);
}

function buildOverviewBodyHtml(snapshot: ReaderOverviewSnapshot): string {
  switch (snapshot.phase) {
    case "empty":
      return buildEmptyStateHtml();
    case "generating":
      return buildGeneratingStrip(snapshot) + buildResultSectionsHtml(snapshot);
    case "partial":
      return buildPartialStrip(snapshot) + buildResultSectionsHtml(snapshot);
    case "error":
      return buildErrorStrip(snapshot);
    case "cancelled":
      return buildCancelledStrip();
    case "ready":
      return buildResultSectionsHtml(snapshot);
    case "idle":
    default:
      return `
        <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
          <div class="biliscript-reading-placeholder-title">概览还未生成</div>
        </div>
      `;
  }
}

// 无字幕诚实空态（07 票决议：无字幕不触发、不放假数据）。转写进行中（字幕
// tab 横幅同源判定）给出预期文案，与横幅「转写完成后字幕与概览将自动出现」
// 一致；字幕抓取中（subtitleFetchState=loading，点 Script 后台抓取未落定）
// 同为预期态，不误显「该视频没有可用字幕」——字幕就绪后 subtitle-ready 通知
// / 落定对账会自动触发生成。
//
// 已归因（noSubtitleReason 非空）时跟随原因（票 07 Q4）：标题 = 病因、正文 =
// 补救，逐字来自 core/asr-failure-notice 的单一真源，不带详情行（详情行是
// 单行宿主的设计，塞进标题 + 正文占位块会破排版）；任一段缺失时回退到通用
// 标题/正文。
function buildEmptyStateHtml(): string {
  if (isReaderTranscribing()) {
    return `
      <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
        <div class="biliscript-reading-placeholder-title">概览等字幕就绪后自动生成</div>
      </div>
    `;
  }
  if (state.clip.subtitleFetchState === "loading") {
    return `
      <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
        <div class="biliscript-reading-placeholder-title">字幕抓取中，就绪后自动生成概览</div>
      </div>
    `;
  }
  let title = "该视频没有可用字幕";
  let copy = "视频概览需基于字幕生成。";
  if (state.clip.noSubtitleReason) {
    const notice = getAsrFailureNotice(state.clip.noSubtitleReason);
    title = notice.cause || title;
    copy = notice.remedyText || copy;
  }
  return `
    <div class="biliscript-reading-placeholder biliscript-reading-ov-empty-card">
      <div class="biliscript-reading-placeholder-title">${escapeHtml(title)}</div>
      <p class="biliscript-reading-placeholder-copy">${escapeHtml(copy)}</p>
    </div>
  `;
}

// 生成中状态条：单槽显示管线进度文案（onProgress，分段路径实时推进；单发路径为
// 「正在生成概览…（已接收 N 字）」/「模型正在思考…」）+ 取消键——生成中唯一的面板内
// 出口。管线还没报过进度且首字节等待超过阈值时，文案换成等待计时（只提示，不设硬
// 超时）。细进度条复用转写横幅的 biliscript-asr-pulse 不确定动画（页面侧拿不到确定
// 进度）。
function buildGeneratingStrip(snapshot: ReaderOverviewSnapshot): string {
  const text = snapshot.stripText || "正在生成概览…";
  return `
    <div class="biliscript-reading-ov-strip is-generating">
      <span class="biliscript-reading-ov-strip-text">${escapeHtml(text)}</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="cancel">取消</button>
    </div>
    <div class="biliscript-reading-ov-track" aria-hidden="true"><div class="biliscript-reading-ov-fill"></div></div>
  `;
}

// 取消后的收场条：已无在飞请求，给出显式重跑入口（forceRefresh；整份缓存不读、
// 段缓存照常复用，与 partial/error 重试同一语义）。
function buildCancelledStrip(): string {
  return `
    <div class="biliscript-reading-ov-strip">
      <span class="biliscript-reading-ov-strip-text">已取消概览生成。</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重新生成</button>
    </div>
  `;
}

// 部分失败标记条：失败区间数 + 重试按钮（forceRefresh 重跑——整份缓存跳过、
// 段缓存让已成功段免重付费，见 analysis.ts 失败语义）。
function buildPartialStrip(snapshot: ReaderOverviewSnapshot): string {
  const failedCount = snapshot.analysis?.failedRanges?.length || 0;
  return `
    <div class="biliscript-reading-ov-strip is-partial">
      <span class="biliscript-reading-ov-strip-text">有 ${failedCount} 个分段生成失败，对应区间的章节与金句未生成。</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry-failed">重试失败区间</button>
    </div>
  `;
}

function buildErrorStrip(snapshot: ReaderOverviewSnapshot): string {
  return `
    <div class="biliscript-reading-ov-strip is-error">
      <span class="biliscript-reading-ov-strip-text">概览生成失败：${escapeHtml(snapshot.errorText || "未知错误")}</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重试</button>
    </div>
  `;
}

// 结果区：章节列表 → 金句卡。生成中已有旧产物（重试场景）时同样渲染，
// 新结果落定后整体重建。
function buildResultSectionsHtml(snapshot: ReaderOverviewSnapshot): string {
  const analysis = snapshot.analysis;
  if (!analysis) {
    if (snapshot.phase === "generating") {
      return `
        <div class="biliscript-reading-placeholder is-generating">
          <p class="biliscript-reading-placeholder-copy">章节与金句会出现在这里；期间可先在「字幕」页阅读。</p>
        </div>
      `;
    }
    return "";
  }

  const withHours = shouldShowHoursInNote(state, getClipBody());
  const chapters = (Array.isArray(analysis.chapters) ? analysis.chapters : []).filter(
    (item) => item && String(item.title || "").trim()
  );
  const quotes = (Array.isArray(analysis.quotes) ? analysis.quotes : []).filter(
    (item) => item && String(item?.content || "").trim()
  );
  const chapterBadge = snapshot.aiChapters ? '<span class="biliscript-reading-ov-badge">AI 生成</span>' : "";
  const quotesEmptyNote = quotes.length === 0 ? '<div class="biliscript-reading-ov-empty">没有可用的金句。</div>' : "";

  if (chapters.length === 0) {
    return `
      <section class="biliscript-reading-ov-section">
        <div class="biliscript-reading-ov-h">章节</div>
        <div class="biliscript-reading-ov-empty">没有可用的章节。</div>
      </section>
      <section class="biliscript-reading-ov-section">
        <div class="biliscript-reading-ov-h">金句<span class="biliscript-reading-ov-badge">AI 精选</span></div>
        ${quotesEmptyNote}${quotes.map((item) => quoteCardHtml(item, withHours)).join("")}
      </section>
    `;
  }

  const chapterBlocks = chapters.map((item) => chapterCardHtml(item, withHours, snapshot.chapterSourceKind)).join("");
  // 官方章节缺概括（missingSummary，ai/chapter-plan.ts 打标）：给出整份重跑入口。
  // 重试走 forceRefresh——整份缓存不读、段缓存照常复用，与 partial/error 重试同一语义。
  const missingCount = chapters.filter((item) => item.missingSummary).length;
  const missingStrip = missingCount
    ? `
    <div class="biliscript-reading-ov-strip is-partial">
      <span class="biliscript-reading-ov-strip-text">有 ${missingCount} 个章节缺少小结。</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重新生成</button>
    </div>`
    : "";
  return `
    ${missingStrip}
    <section class="biliscript-reading-ov-section">
      <div class="biliscript-reading-ov-h">章节${chapterBadge}</div>
      ${chapterBlocks}
    </section>
    <section class="biliscript-reading-ov-section">
      <div class="biliscript-reading-ov-h">金句<span class="biliscript-reading-ov-badge">AI 精选</span></div>
      ${quotesEmptyNote}${quotes.map((item) => quoteCardHtml(item, withHours)).join("")}
    </section>
  `;
}

// 章节卡（时间戳 pill + 标题 + 小结，点击跳播）。缺概括（missingSummary）时渲染
// 占位行而不是静默留白——空串的正常来源是简介/评论时间轴（titlesOnly，不打标）。
function chapterCardHtml(item: AnalysisChapter, withHours: boolean, chapterSourceKind: ChapterSourceKind): string {
  const from = Number(item.from) || 0;
  const desc = String(item.summary || "").trim();
  const descHtml = desc
    ? `<span class="biliscript-reading-ov-chapter-desc">${escapeHtml(desc)}</span>`
    : item.missingSummary
      ? `<span class="biliscript-reading-ov-chapter-desc is-missing">本章概括缺失</span>`
      : "";
  // 简介/评论时间轴（outline）且章节无独立 summary：标题按首个主分隔符拆成
  // 粗体主标题 + 常规体次级说明两层（消除全粗体堆叠的文字砖墙感）；官方章节
  // （manuscript）与 AI 自由分章（auto）保持原有单层结构。两段都经 escapeHtml。
  const split = chapterSourceKind === "outline" && !desc ? splitOutlineChapterTitle(item.title) : null;
  const titleHtml = split
    ? `<span class="biliscript-reading-ov-chapter-title">${escapeHtml(split.primary)}</span>` +
      `<span class="biliscript-reading-ov-chapter-subtitle">${escapeHtml(split.secondary)}</span>`
    : `<span class="biliscript-reading-ov-chapter-title">${escapeHtml(String(item.title))}</span>`;
  return `
    <button type="button" class="biliscript-reading-ov-chapter" data-seconds="${from}">
      <span class="biliscript-reading-time">${escapeHtml(formatClock(from, { hours: withHours }))}</span>
      <span class="biliscript-reading-ov-chapter-copy">
        ${titleHtml}
        ${descHtml}
      </span>
    </button>
  `;
}

// 金句卡（暖底淡卡）：surface-2 底 + 圆角分组，无边框、无左侧 accent 边条；
// 正文经 CSS 伪元素包「」直角引号（复制文本不含括号），底行左侧播放三角 +
// 时间戳 pill（点击跳播）、右侧操作区（分享卡片 + 复制图标钮）。
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
          <span class="biliscript-reading-time">${escapeHtml(formatClock(from, { hours: withHours }))}</span>
        </span>
        <span class="biliscript-reading-ov-quote-actions">
          <span class="biliscript-reading-ov-quote-share" role="button" data-overview-action="share-quote" data-quote="${escapeHtml(content)}" data-seconds="${from}" aria-label="分享金句卡片" title="分享金句卡片">${READING_SHARE_ICON}</span>
          <span class="biliscript-reading-ov-quote-copy" role="button" data-overview-action="copy-quote" data-quote="${escapeHtml(content)}" data-seconds="${from}" aria-label="复制该金句" title="复制该金句">${READING_COPY_ICON}</span>
        </span>
      </span>
    </button>
  `;
}

// ============================================================
// 交互（章节/金句点击跳播 + 复制金句 + 分享金句卡片 + 重试；ui-renderer 事件委托入口）
// ============================================================

export function onReadingOverviewClick(event: MouseEvent, actions?: OverviewUiActions): void {
  const currentActions = actions || registeredActions;
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-overview-action]");
  if (target) {
    const action = target.dataset.overviewAction || "";
    if (action === "retry-failed" || action === "retry") {
      currentActions?.retry();
      return;
    }
    if (action === "cancel") {
      currentActions?.cancel();
      return;
    }
    if (action === "copy-quote") {
      void copyQuoteToClipboard(target);
      return;
    }
    if (action === "share-quote") {
      const quote = target.dataset.quote || "";
      const seconds = Number(target.dataset.seconds) || 0;
      openQuoteShareModal({
        content: quote,
        from: seconds,
        videoTitle: state.clip.title || ""
      });
      return;
    }
    return;
  }

  // 章节/金句点击 → 跳播（点句跳转同一通道：jumpReadingTarget，阅读视图内
  // 点击语义 = resumePlayback:true）。金句卡有正文，用户选中文本复制时不跳转，
  // 与字幕句点击同款守卫。
  const seekTarget = (event.target as HTMLElement | null)?.closest<HTMLElement>(
    ".biliscript-reading-ov-chapter, .biliscript-reading-ov-quote"
  );
  if (!seekTarget) {
    return;
  }
  if (window.getSelection()?.toString().trim()) {
    return;
  }
  jumpReadingTarget(seekTarget.dataset.seconds ?? 0);
}

async function copyQuoteToClipboard(quoteEl: HTMLElement): Promise<void> {
  const seconds = Number(quoteEl.dataset.seconds) || 0;
  const content = quoteEl.dataset.quote || "";
  const withHours = shouldShowHoursInNote(state, getClipBody());
  const text = `${formatClock(seconds, { hours: withHours })} 「${content}」`;
  if (!content) {
    setMessage("没有可复制的金句。");
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    setMessage("金句已复制到剪贴板。");
    flashCopySuccess(quoteEl, { originalSvg: READING_COPY_ICON, originalLabel: "复制该金句" });
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}
