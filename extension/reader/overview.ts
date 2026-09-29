// PR4 概览 tab：状态机 + 生成编排 + 渲染 + 交互（reader 域内，PR3
// subtitle-search / transcribe-banner 同款单模块先例）。
//
// 数据管线：ai/analysis.ts 的 runOverviewAnalysis（PR4a 已定稿，本模块只接线）——
// 缓存读取、分段产物复用、生成中 promise 复用都在管线内；本模块负责：
//   1. 状态机：idle / generating（含进度文案、取消键、首字节前等待计时）/ ready /
//      partial（带 failedRanges）/ error（带错误信息）/ cancelled（用户取消，可重新
//      生成）/ empty（无字幕诚实空态），产物引用存模块内闭包。
//   2. 触发时机（基线决议「打开即自动生成并缓存」）：
//        - enterReaderMode 打开视图（lifecycle 调用，字幕已在则直接生成）；
//        - subtitle-ready reader-bus 通知（lifecycle 调用，转写/抓取完成后兜住）；
//        - 用户切到概览 tab（ui-renderer → ensureReaderOverviewTab，idle 才触发）。
//      重复触发去重两层：本模块 inflight promise 复用 + 管线 finalKey promise
//      复用（runOverviewAnalysis 内建）；已生成（ready/partial）不自动重跑，
//      重试一律显式 forceRefresh（段缓存让已成功段免重付费）。
//   3. 签名守卫：generatedFor 记录生成时的 (bvid, cid, 字幕签名)（与缓存键同一
//      构成），换轨/切分P/重抓后旧产物立即退场，渲染层自愈不串片展示。
//   4. 点击跳播：章节/金句复用 seekReadingTarget 通道（jumpReadingTarget，
//      阅读视图内点击语义 resumePlayback:true）；金句卡选中文本时不跳转。
//   5. 清理：closeReadingView 调 resetReaderOverviewState 归位状态；不取消进行中
//      的生成（管线后台跑完落缓存，重开阅读模式读缓存命中；落定回执因
//      generatedFor 已清而被丢弃，不会写进新会话）。生成中要中断只能走状态条的
//      「取消」键（cancelReaderOverview）：通道不设硬超时（ADR-0010），首字节前
//      等待超阈值只给计时提示，不中断。
//
// 分章来源标注：按 07 票决议从入参推断——用 shared/chapter-outline 的
// resolveChapterSource 裁定来源，只有 AI 自由分章（简介/评论时间轴与官方章节都没有）
// 才标「AI 生成」；时间轴或官方章节作给定来源时不标。

import { state } from "../core/state.js";
import { escapeHtml } from "../shared/string-utils.js";
import { formatClock } from "../shared/clock-text.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { setMessage } from "../core/ui-status.js";
// 「选中平台 + 其 API Key」解析（与选区解释共用）。
import { resolveActiveProvider } from "../ai/active-provider.js";
// 签名族已迁 subtitle/cache.ts（arch-slim-3 #1，键族同居）；概览管线本体只留
// type-only 引用（编译期擦除），运行时在 startOverviewRun 内动态 import 按需
// 装载——reader 装载图不拖整条 AI 管线（build-content 守卫钉住）。
import { buildSubtitleSignature } from "../subtitle/cache.js";
// 分章来源裁定（简介/评论时间轴 > B 站官方章节 > AI 自由分章）住在 shared 叶子：
// 身份键与「AI 生成」标注都取同一份裁定，禁止与管线各判一次。
import { resolveChapterSource, type ChapterSource } from "../shared/chapter-outline.js";
import type { AnalysisChapter, AnalysisQuote, OverviewAnalysis } from "../ai/analysis.js";
import { shouldShowHoursInNote } from "../notes/section-lines.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { ids } from "./state.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { jumpReadingTarget } from "./sync.js";

// ============================================================
// 状态（模块内闭包，对齐 scroll-state/explain-intent 的 reader 域叶子模式）
// ============================================================

export type ReaderOverviewPhase =
  | "idle"
  | "generating"
  | "ready"
  | "partial"
  | "error"
  | "empty"
  | "cancelled";

interface ReaderOverviewState {
  phase: ReaderOverviewPhase;
  analysis: OverviewAnalysis | null;
  /** 章节标头「AI 生成」小标注：生成发起时视频自带章节为空即 AI 分章 */
  aiChapters: boolean;
  progressText: string;
  errorText: string;
  /** 生成发起时的视频/字幕轨身份（bvid|cid|字幕签名），换轨/换片后退场旧产物 */
  generatedFor: string;
  /** 进行中的生成编排 promise：重复触发复用，落定置回 null */
  inflight: Promise<void> | null;
}

const overview: ReaderOverviewState = {
  phase: "idle",
  analysis: null,
  aiChapters: false,
  progressText: "",
  errorText: "",
  generatedFor: "",
  inflight: null
};

// 生成中的中止句柄：与 overview.inflight 不同寿命——关闭阅读模式只归位状态、不取消
// 在飞请求（ADR-0010 不变式），重开同视频时编排 promise 会按 finalKey 复用，所以
// controller 必须活到编排落定：否则重开后的「取消」键取消的是一个没人听的信号。
// startedAt / lastActivityAt 供首字节前的等待计时用。
interface ReaderOverviewInflightAbort {
  key: string;
  controller: AbortController;
  /** 本次编排的发起时刻（等待计时基准） */
  startedAt: number;
  /** 最近一次管线进度回吐时刻；0 = 尚无任何可观察活动 */
  lastActivityAt: number;
}

let inflightAbort: ReaderOverviewInflightAbort | null = null;
let waitTicker: ReturnType<typeof setInterval> | null = null;
/** 用户主动取消（区别于其它 abort 来源）：决定 aborted 上浮后停在哪个态 */
let cancelRequested = false;
/** 首字节前多久把固定文案换成等待计时：只提示，不设硬超时 */
const WAIT_NOTE_THRESHOLD_MS = 10_000;

function getClipBody(): { from: number; to: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

// 当前分章来源（与概览管线同一份裁定）：身份键与「AI 生成」标注共用，避免两处
// 各判一次导致标注与实际章节来源不一致。
function currentChapterSource(): ChapterSource {
  const clip = state.clip;
  return resolveChapterSource(clip.description, clip.hotComments, clip.chapters);
}

// 当前视频/字幕轨身份：与整份概览缓存键同一构成（bvid + cid + 字幕签名）。签名口径
// 由 shared/chapter-outline 的 resolveChapterSource 与管线同源裁定——简介/评论时间轴、
// 官方章节、AI 自由分章三种来源切换，或目录内容变化，都会换键让旧产物退场。
function currentOverviewKey(): string {
  const clip = state.clip;
  const chapterSource = currentChapterSource();
  const signature = buildSubtitleSignature({
    lang: clip.selectedSubtitleLang,
    subtitleId: clip.selectedSubtitleId,
    subtitleUrl: clip.selectedSubtitleUrl,
    body: getClipBody(),
    chapters: chapterSource.signatureChapters,
    chapterOutline: chapterSource.chapters
  });
  return `${clip.bvid}|${clip.cid}|${signature}`;
}

// AI 上下文（runOverviewAnalysis 入参）：三键位 + 元信息 + 字幕体 + 章节 + 热评。
// 字段名对齐 segmentCacheKeyFields（selectedSubtitleId/selectedSubtitleUrl/
// subtitleLang），保证缓存键位与 sidepanel/offscreen 侧同构。
// 热评透传给管线：与简介一起供「现成章节目录」解析（简介/评论里的时间戳目录
// 优先决定章节边界，AI 只补每章大意）；无目录/解析失败不影响现状行为。
function buildOverviewContext(): Record<string, unknown> {
  const clip = state.clip;
  return {
    bvid: clip.bvid,
    cid: clip.cid,
    aid: clip.aid,
    title: clip.title,
    author: clip.author,
    videoDescription: clip.description,
    hotComments: Array.isArray(clip.hotComments) ? clip.hotComments : [],
    videoDuration: clip.videoDuration,
    subtitleLang: clip.selectedSubtitleLang,
    selectedSubtitleId: clip.selectedSubtitleId,
    selectedSubtitleUrl: clip.selectedSubtitleUrl,
    subtitleBody: getClipBody(),
    chapters: Array.isArray(clip.chapters) ? clip.chapters : []
  };
}

// ============================================================
// 生成编排（provider 解析 + 管线调用 + 状态机迁移）
// ============================================================

// 「选中平台 + 其 API Key」解析在 ai/active-provider.js（与选区解释共用同一份
// 消息链实现）；失败以异常上翻进 error 态。

function renderIfOpen(): void {
  if (state.reader.readingViewOpen) {
    renderReadingOverview();
  }
}

// 无字幕出口：不触发生成（07 票决议数据层也直接拒绝），展示诚实空态。
// 转写进行中给出预期文案（转写完成后字幕就绪通知会再触发）。
function markEmptyPhase(): void {
  overview.phase = "empty";
  overview.analysis = null;
  overview.generatedFor = "";
  overview.progressText = "";
  overview.errorText = "";
}

// 旧产物退场（换轨/切分P/会话收尾共用）：产物引用一并丢弃。
function dropOverviewProduct(): void {
  overview.phase = "idle";
  overview.analysis = null;
  overview.generatedFor = "";
  overview.progressText = "";
  overview.errorText = "";
}

// ============================================================
// 等待计时与取消（生成中的面板内出口，ADR-0010：通道不设硬超时）
// ============================================================

// 首字节未至时的等待文案：已有管线进度就把文案交给管线（不叠加计时，避免把「模型
// 在长思考」读成故障）；不足阈值返回空串，渲染回落到固定文案。
function waitingNoteText(): string {
  const slot = inflightAbort;
  if (!slot || slot.lastActivityAt) {
    return "";
  }
  const waitedMs = Date.now() - slot.startedAt;
  if (waitedMs < WAIT_NOTE_THRESHOLD_MS) {
    return "";
  }
  return `正在等待平台响应…（已等待 ${Math.floor(waitedMs / 1000)} 秒）`;
}

function stopWaitTicker(): void {
  if (waitTicker !== null) {
    clearInterval(waitTicker);
    waitTicker = null;
  }
}

// 每秒就地刷新状态条那句文案：不整块 renderReadingOverview——重试场景下屏上已有旧
// 产物的章节/金句，重建 innerHTML 会丢滚动位置与选区。
function tickWaitNote(): void {
  if (overview.phase !== "generating") {
    stopWaitTicker();
    return;
  }
  const text = overview.progressText || waitingNoteText();
  const stripText = document
    .getElementById(ids.readingOverviewBody)
    ?.querySelector(".biliscript-reading-ov-strip-text");
  if (stripText) {
    if (text) {
      stripText.textContent = text;
    }
    return;
  }
  renderIfOpen();
}

function startWaitTicker(): void {
  stopWaitTicker();
  waitTicker = setInterval(tickWaitNote, 1000);
}

// 取消进行中的生成：生成中唯一的面板内出口（retry 只在 error/partial 条，而关闭
// 阅读模式按 ADR-0010 不取消在飞请求）。立即转 cancelled 态让点击有反馈；管线以
// aborted 上浮时据 cancelRequested 停在同一态，不落回 idle——那会让切 tab 的自动
// 触发立刻重跑一次刚被取消的请求。
export function cancelReaderOverview(): void {
  if (overview.phase !== "generating") {
    return;
  }
  cancelRequested = true;
  stopWaitTicker();
  inflightAbort?.controller.abort();
  // 放开去重绑定：cancel 后「重新生成」必须能立刻重跑，不必等被中止的编排落定。
  // 旧编排的迟到回执由 startOverviewRun 的 slot 身份守卫丢弃（新触发换了 slot）。
  overview.inflight = null;
  overview.phase = "cancelled";
  overview.progressText = "";
  overview.errorText = "";
  renderIfOpen();
}

/**
 * 触发概览生成（fire-and-forget；返回编排 promise 供测试/去重方 await）。
 * 去重语义：
 *   - generating 中重复触发且视频身份未变 → 复用本次编排 promise（管线内还会
 *     按 finalKey 二次去重）；
 *   - inflight 属于旧视频（换轨/切P/换片后触发）：旧编排退场换血——旧 promise
 *     落定回执因 generatedFor 已换而按过期丢弃，不阻塞新视频的生成；
 *   - ready/partial 且身份未变 → 不重跑（部分结果重试必须显式 forceRefresh）；
 *   - error → 不自动重跑（错误条上的重试按钮走 forceRefresh）；
 *   - forceRefresh=true → 跳过以上短路重新生成（整份缓存不读，段缓存照常复用）。
 * 无字幕 → 标记 empty 态不触发。
 */
export function triggerReaderOverviewGeneration(
  { forceRefresh = false }: { forceRefresh?: boolean } = {}
): Promise<void> {
  // inflight 身份守卫：复用仅限同一视频/字幕轨的重复触发。切到新视频后旧视频
  // 的后台编排还在跑时，直接换血开新编排——若不判身份，新触发会复用旧 promise
  // 且旧回执落定后（generatedFor 仍是旧 key）旧章节金句会串进新视频面板。
  if (overview.inflight && overview.generatedFor === currentOverviewKey()) {
    return overview.inflight;
  }
  if (getClipBody().length === 0) {
    markEmptyPhase();
    renderIfOpen();
    return Promise.resolve();
  }
  const clipKey = currentOverviewKey();
  if (
    !forceRefresh &&
    overview.generatedFor === clipKey &&
    (overview.phase === "ready" ||
      overview.phase === "partial" ||
      overview.phase === "error" ||
      overview.phase === "cancelled")
  ) {
    return Promise.resolve();
  }
  if (overview.generatedFor !== clipKey) {
    dropOverviewProduct();
  }
  // 中止句柄按视频身份复用：同 key 的重复触发（含关闭阅读模式后重开）拿同一个
  // signal，取消才作用在真正在飞的那次请求上；已中止的句柄不复用（取消后重跑要新
  // controller）。
  let slot = inflightAbort;
  if (!slot || slot.key !== clipKey || slot.controller.signal.aborted) {
    slot = { key: clipKey, controller: new AbortController(), startedAt: Date.now(), lastActivityAt: 0 };
    inflightAbort = slot;
  }
  cancelRequested = false;
  overview.generatedFor = clipKey;
  overview.aiChapters = currentChapterSource().kind === "auto";
  overview.phase = "generating";
  overview.progressText = "";
  overview.errorText = "";
  startWaitTicker();
  renderIfOpen();

  const run = startOverviewRun(clipKey, forceRefresh, slot);
  overview.inflight = run;
  const cleanup = () => {
    if (overview.inflight === run) {
      overview.inflight = null;
    }
    // 编排落定即停表（句柄本身留到下次触发或取消处理——见 inflightAbort 注释）
    stopWaitTicker();
  };
  void (async () => {
    try {
      await run;
    } catch {
      // 拒绝在此收口（原 then(cleanup, cleanup) 不外抛），仅保证清理执行。
    } finally {
      cleanup();
    }
  })();
  return run;
}

async function startOverviewRun(
  clipKey: string,
  forceRefresh: boolean,
  slot: ReaderOverviewInflightAbort
): Promise<void> {
  try {
    // 动态 import：AI 管线（analysis → map-reduce/pool/budgeter…）只在生成触发
    // 时装载，reader chunk 保持轻（守卫见 scripts/build-content.js）。并发首触
    // 由 analysis 模块内的 inflightOverviews 去重，装载本身经 ESM 缓存单次。
    const { runOverviewAnalysis } = await import("../ai/analysis.js");
    const provider = await resolveActiveProvider();
    const analysis = await runOverviewAnalysis(
      // script-only-ui：思考档位显式钉死 off（对齐 ai/explain.ts 的钉法）——
      // 章节/金句生成不开放思考档位，省略档位虽会在协议层归一化落到 off，
      // 显式传参让「查表关思考」（thinking-profiles → 平台关闭字段/级联）的
      // 行为成为契约而非默认值巧合（协议层改动时不会被静默带走）。
      // signal：取消键据此中止在飞请求（content → offscreen 代发端口断连即 abort）。
      {
        provider,
        context: buildOverviewContext(),
        forceRefresh,
        thinkingLevel: "off",
        signal: slot.controller.signal
      },
      {
        // 分段进度文案（buildProgressNotice：「正在整理第 x/y 段（n%）」）注入：
        // 生成中状态条实时跟随（管线 onProgress 为可选注入，分段路径才回调）。
        // 回调同时刷新 lastActivityAt：有过进度就不再叠「已等待」计时。
        onProgress: (notice) => {
          overview.progressText = String(notice || "");
          slot.lastActivityAt = Date.now();
          renderIfOpen();
        },
        // 成本护栏（分段路径预估 ≥5 次调用时）：面板内确认弹层
        //（ui/confirm-dialog.js；原生 confirm 绘制在浏览器窗口正中央，面板
        // 停靠右侧时可能看不到），管线内 await 回执；拒绝以 err.cancelled 上翻。
        askCostGuard: (message) => confirmDialog({ message, confirmText: "继续" })
      }
    );
    if (inflightAbort !== slot || overview.generatedFor !== clipKey) {
      return; // 会话已收尾/已换片/已被新一轮取代：产物丢弃
    }
    overview.analysis = analysis;
    overview.phase = Array.isArray(analysis.failedRanges) && analysis.failedRanges.length > 0 ? "partial" : "ready";
    overview.progressText = "";
    overview.errorText = "";
    renderIfOpen();
  } catch (error) {
    if (inflightAbort !== slot || overview.generatedFor !== clipKey) {
      return; // 同上：过期回执丢弃（含取消后新一轮已接手的旧编排）
    }
    const err = error as { cancelled?: unknown; aborted?: unknown } | null;
    if (err?.cancelled || err?.aborted) {
      if (cancelRequested) {
        // 用户主动取消：停在 cancelled 态（有「重新生成」出口），不回 idle——
        // 那会让切 tab 的自动触发立刻重跑一次刚被取消的请求。
        overview.phase = "cancelled";
        overview.progressText = "";
        overview.errorText = "";
        renderIfOpen();
        return;
      }
      // 用户拒绝成本护栏 / 请求被中止：回到未生成态，不算失败
      dropOverviewProduct();
      renderIfOpen();
      return;
    }
    overview.phase = "error";
    overview.errorText = getErrorMessage(error, "概览生成失败");
    overview.progressText = "";
    renderIfOpen();
  }
}

// ============================================================
// 触发入口（lifecycle / ui-renderer 调用面）
// ============================================================

/**
 * 切到概览 tab 的入口（ui-renderer 标签切换回调）：先收敛渲染（含换片自愈），
 * 未生成就触发生成。幂等：已生成不重跑，生成中复用。
 */
export function ensureReaderOverviewTab(): void {
  renderReadingOverview();
  void triggerReaderOverviewGeneration();
}

// ============================================================
// 渲染（替换 PR2 占位卡：#biliscript-reading-tabbody-overview 内整块重建）
// ============================================================

// 渲染前把状态收敛到与当前视频/字幕轨一致：
//   - 字幕体为空 → empty（诚实空态，转写中给出预期文案）；
//   - 字幕从无到有 → empty 退场回 idle（等下次触发）；
//   - generatedFor 与当前身份不一致 → 旧产物退场（换轨/切分P/重抓不串片）。
function syncOverviewPhaseToClip(): void {
  if (getClipBody().length === 0) {
    if (overview.phase !== "empty") {
      markEmptyPhase();
    }
    return;
  }
  if (overview.phase === "empty") {
    overview.phase = "idle";
    return;
  }
  if (overview.generatedFor && overview.generatedFor !== currentOverviewKey()) {
    dropOverviewProduct();
  }
}

export function renderReadingOverview(): void {
  const body = document.getElementById(ids.readingOverviewBody);
  if (!body) {
    return;
  }
  syncOverviewPhaseToClip();
  body.innerHTML = buildOverviewBodyHtml();
}

function buildOverviewBodyHtml(): string {
  switch (overview.phase) {
    case "empty":
      return buildEmptyStateHtml();
    case "generating":
      return buildGeneratingStrip() + buildResultSectionsHtml();
    case "partial":
      return buildPartialStrip() + buildResultSectionsHtml();
    case "error":
      return buildErrorStrip();
    case "cancelled":
      return buildCancelledStrip();
    case "ready":
      return buildResultSectionsHtml();
    case "idle":
    default:
      return `
        <div class="biliscript-reading-placeholder">
          <div class="biliscript-reading-placeholder-title">概览还未生成</div>
          <p class="biliscript-reading-placeholder-copy">切到概览标签页会自动开始生成章节与金句。</p>
        </div>
      `;
  }
}

// 无字幕诚实空态（07 票决议：无字幕不触发、不放假数据）。转写进行中（字幕
// tab 横幅同源判定）给出预期文案，与横幅「转写完成后字幕与概览将自动出现」
// 一致；字幕抓取中（subtitleFetchState=loading，点 Script 后台抓取未落定）
// 同为预期态，不误显「该视频没有可用字幕」——字幕就绪后 subtitle-ready 通知
// / 落定对账会自动触发生成。
function buildEmptyStateHtml(): string {
  if (isReaderTranscribing()) {
    return `
      <div class="biliscript-reading-placeholder">
        <div class="biliscript-reading-placeholder-title">概览等字幕就绪后自动生成</div>
        <p class="biliscript-reading-placeholder-copy">音频转写完成后会自动生成章节与金句，期间可先在「字幕」页看视频。</p>
      </div>
    `;
  }
  if (state.clip.subtitleFetchState === "loading") {
    return `
      <div class="biliscript-reading-placeholder">
        <div class="biliscript-reading-placeholder-title">字幕抓取中，就绪后自动生成概览</div>
        <p class="biliscript-reading-placeholder-copy">章节与金句会在字幕就绪后自动出现，无需切换标签页。</p>
      </div>
    `;
  }
  return `
    <div class="biliscript-reading-placeholder">
      <div class="biliscript-reading-placeholder-title">该视频没有可用字幕</div>
      <p class="biliscript-reading-placeholder-copy">概览（章节与金句）需要字幕才能生成。</p>
    </div>
  `;
}

// 生成中状态条：单槽显示管线进度文案（onProgress，分段路径实时推进；单发路径为
// 「正在生成概览…（已接收 N 字）」/「模型正在思考…」）+ 取消键——生成中唯一的面板内
// 出口。管线还没报过进度且首字节等待超过阈值时，文案换成等待计时（只提示，不设硬
// 超时）。细进度条复用转写横幅的 biliscript-asr-pulse 不确定动画（页面侧拿不到确定
// 进度）。
function buildGeneratingStrip(): string {
  const text = overview.progressText || waitingNoteText() || "正在生成概览…";
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
function buildPartialStrip(): string {
  const failedCount = overview.analysis?.failedRanges?.length || 0;
  return `
    <div class="biliscript-reading-ov-strip is-partial">
      <span class="biliscript-reading-ov-strip-text">有 ${failedCount} 个分段生成失败，对应区间的章节与金句缺失。</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry-failed">重试失败区间</button>
    </div>
  `;
}

function buildErrorStrip(): string {
  return `
    <div class="biliscript-reading-ov-strip is-error">
      <span class="biliscript-reading-ov-strip-text">概览生成失败：${escapeHtml(overview.errorText || "未知错误")}</span>
      <button type="button" class="biliscript-reading-mini-btn" data-overview-action="retry">重试</button>
    </div>
  `;
}

// 结果区：章节列表 → 金句卡。生成中已有旧产物（重试场景）时同样渲染，
// 新结果落定后整体重建。
function buildResultSectionsHtml(): string {
  const analysis = overview.analysis;
  if (!analysis) {
    // 生成中无旧产物：结果区只留一句「稍后会出现什么」的说明——标题行曾与
    // 状态条重复同一句「正在生成概览」，已删；没了标题，这句就是卡的正文
    //（样式按 is-generating 提到正文档）。
    if (overview.phase === "generating") {
      return `
        <div class="biliscript-reading-placeholder is-generating">
          <p class="biliscript-reading-placeholder-copy">章节与金句会出现在这里；期间可先在「字幕」页阅读。</p>
        </div>
      `;
    }
    return "";
  }

  const withHours = shouldShowHoursInNote(state, getClipBody());
  // 章节缺标题 / 金句缺文本的残条目不渲染（与既有空态判定同口径）。
  const chapters = (Array.isArray(analysis.chapters) ? analysis.chapters : []).filter(
    (item) => item && String(item.title || "").trim()
  );
  const quotes = (Array.isArray(analysis.quotes) ? analysis.quotes : []).filter(
    (item) => item && String(item?.content || "").trim()
  );
  const chapterBadge = overview.aiChapters ? '<span class="biliscript-reading-ov-badge">AI 生成</span>' : "";
  const quotesEmptyNote = quotes.length === 0 ? '<div class="biliscript-reading-ov-empty">没有可用的金句。</div>' : "";

  // —— 无章节视频：维持平铺——章节空态 + 独立金句 section（卡片按 from 平铺）——
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

  // —— 有章节：章节与金句分区呈现——章节 section 只放章节卡，金句单列独立
  // section（卡片按 from 平铺），不与章节混排。三种分章来源（时间轴目录 / 官方
  // 章节 / AI 自由分章）产物同构，UI 只按来源决定是否标「AI 生成」。
  const chapterBlocks = chapters.map((item) => chapterCardHtml(item, withHours)).join("");
  return `
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

// 章节卡（时间戳 pill + 标题 + 小结，点击跳播）。
function chapterCardHtml(item: AnalysisChapter, withHours: boolean): string {
  const from = Number(item.from) || 0;
  const desc = String(item.summary || "").trim();
  return `
    <button type="button" class="biliscript-reading-ov-chapter" data-seconds="${from}">
      <span class="biliscript-reading-time">${escapeHtml(formatClock(from, { hours: withHours }))}</span>
      <span class="biliscript-reading-ov-chapter-copy">
        <span class="biliscript-reading-ov-chapter-title">${escapeHtml(String(item.title))}</span>
        ${desc ? `<span class="biliscript-reading-ov-chapter-desc">${escapeHtml(desc)}</span>` : ""}
      </span>
    </button>
  `;
}

// 金句卡（白底 + 左 3px accent 边 + 右下角时间戳 + Copy 按钮）。
// 时间戳与原话原样呈现，不重排不改写。
function quoteCardHtml(item: AnalysisQuote, withHours: boolean): string {
  const from = Number(item?.from) || 0;
  const content = String(item?.content || "").trim();
  if (!content) {
    return "";
  }
  return `
    <button type="button" class="biliscript-reading-ov-quote" data-seconds="${from}">
      <span class="biliscript-reading-ov-quote-text">「${escapeHtml(content)}」</span>
      <span class="biliscript-reading-ov-quote-foot">
        <span class="biliscript-reading-time">${escapeHtml(formatClock(from, { hours: withHours }))}</span>
        <span class="biliscript-reading-ov-quote-copy" role="button" data-overview-action="copy-quote" data-quote="${escapeHtml(content)}" data-seconds="${from}">Copy</span>
      </span>
    </button>
  `;
}

// ============================================================
// 交互（章节/金句点击跳播 + 复制金句 + 重试；ui-renderer 事件委托入口）
// ============================================================

export function onReadingOverviewClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-overview-action]");
  if (target) {
    const action = target.dataset.overviewAction || "";
    if (action === "retry-failed" || action === "retry") {
      // 失败区间/整体重试：forceRefresh 跳过整份缓存，段缓存让已成功段免重付费
      void triggerReaderOverviewGeneration({ forceRefresh: true });
      return;
    }
    if (action === "cancel") {
      // 生成中取消：中止在飞请求并停在 cancelled 态（见 cancelReaderOverview）
      cancelReaderOverview();
      return;
    }
    if (action === "copy-quote") {
      void copyQuoteToClipboard(target);
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

// 复制单条金句（含时间戳）到剪贴板：取数与反馈照抄 copySubtitleTranscript
// （subtitle/ui.js）——navigator.clipboard.writeText + setMessage；文本取
// 卡片 data-quote（无 HTML 实体顾虑）。金句点击默认是跳播，本按钮在
// onReadingOverviewClick 顶部分流拦下。
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
  } catch (error) {
    setMessage(`复制失败：${getErrorMessage(error)}`);
  }
}

// ============================================================
// 清理（closeReadingView 清理清单调用）
// ============================================================

/**
 * 会话收尾：状态与产物引用归位。不取消进行中的生成——管线后台跑完落缓存，
 * 重开阅读模式读缓存命中；落定回执因 generatedFor 已清而被丢弃（见
 * startOverviewRun 的回执守卫），不会写进新会话。inflightAbort 同理保留：重开同
 * 视频时与编排 promise 一起复用，「取消」键才作用在真正在飞的那次请求上。
 */
export function resetReaderOverviewState(): void {
  stopWaitTicker();
  cancelRequested = false;
  overview.phase = "idle";
  overview.analysis = null;
  overview.aiChapters = false;
  overview.progressText = "";
  overview.errorText = "";
  overview.generatedFor = "";
  overview.inflight = null;
}
