// PR4 概览协调器深 module（arch-review-batch3/02）：
// 协调面：触发口径 × 并发闸门 × 相位机 × wait ticker。
// 单向依赖呈现层（reader/overview-ui.ts），UI 侧只吃快照、不反向依赖本协调器。
//
// 核心纪律（单源收敛于此，调用点不复述）：
//  1. 去重：inflight 编排 promise 复用（同 key 不重跑）+ generatedFor 身份校验（换片/换轨旧产物退场并换血）；
//  2. 诚实空态：无字幕（subtitleBody 为空）不触发生成，展示诚实空态；
//  3. 重复触发安全：ready/partial/error/cancelled 态不自动重跑，重试需显式 forceRefresh。
//  4. 闸门：视图打开时（state.reader.readingViewOpen）才驱动真实 DOM 渲染，关闭时静默；
//  5. ticker 纪律：generating 期间每秒就地刷新状态条，不整块重渲以避免丢失选区与滚动位置。

import { state } from "../core/state.js";
import { resolveActiveProvider } from "../ai/active-provider.js";
import { buildSubtitleSignature } from "../subtitle/cache.js";
import { resolveChapterSource, type ChapterSource } from "../shared/chapter-outline.js";
import type { OverviewAnalysis } from "../ai/analysis.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { getErrorMessage, isAbortedMarkerError, isCancelledError } from "../shared/error-helpers.js";
import {
  renderReadingOverview,
  updateGeneratingStripText,
  registerOverviewUiActions
} from "./overview-ui.js";

export type ReaderOverviewPhase =
  | "idle"
  | "generating"
  | "ready"
  | "partial"
  | "error"
  | "empty"
  | "cancelled";

export interface ReaderOverviewSnapshot {
  readonly phase: ReaderOverviewPhase;
  readonly analysis: OverviewAnalysis | null;
  readonly aiChapters: boolean;
  readonly progressText: string;
  readonly errorText: string;
  readonly stripText: string;
  readonly generatedFor: string;
}

export interface ReaderOverviewCoordinator {
  /** 触发概览生成（fire-and-forget；返回编排 promise 供测试/去重方 await） */
  trigger(options?: { forceRefresh?: boolean }): Promise<void>;
  /** 取消进行中的生成 */
  cancel(): void;
  /** 会话收尾：状态与产物引用归位（不取消进行中生成） */
  reset(): void;
  /** 当前相位查询（含当前 clip 身份自愈对账） */
  getPhase(): ReaderOverviewPhase;
  /** 投影用快照（相位 + 文案 + 产物引用 + 状态条文本） */
  getSnapshot(): ReaderOverviewSnapshot;
  /** 主动驱动一次渲染（将当前快照投影到 DOM） */
  render(): void;
  /** 概览 tab 切换入口（收敛渲染 + 未生成时自动触发） */
  ensureTab(): void;
}

interface ReaderOverviewInternalState {
  phase: ReaderOverviewPhase;
  analysis: OverviewAnalysis | null;
  aiChapters: boolean;
  progressText: string;
  errorText: string;
  generatedFor: string;
  inflight: Promise<void> | null;
}

const overview: ReaderOverviewInternalState = {
  phase: "idle",
  analysis: null,
  aiChapters: false,
  progressText: "",
  errorText: "",
  generatedFor: "",
  inflight: null
};

interface ReaderOverviewInflightAbort {
  key: string;
  controller: AbortController;
  startedAt: number;
  lastActivityAt: number;
}

let inflightAbort: ReaderOverviewInflightAbort | null = null;
let waitTicker: ReturnType<typeof setInterval> | null = null;
let cancelRequested = false;
const WAIT_NOTE_THRESHOLD_MS = 10_000;

function getClipBody(): { from: number; to: number; content: string }[] {
  return Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
}

function currentChapterSource(): ChapterSource {
  const clip = state.clip;
  return resolveChapterSource(clip.description, clip.hotComments, clip.chapters);
}

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
// 渲染闸门与快照投影
// ============================================================

function renderReadingOverviewNow(): void {
  renderReadingOverview(getReaderOverviewSnapshot());
}

function renderIfOpen(): void {
  if (state.reader.readingViewOpen) {
    renderReadingOverviewNow();
  }
}

// ============================================================
// 相位写点收口（同形写点共用；清空集定死）
// ============================================================

function clearOverviewProduct(phase: "empty" | "idle"): void {
  overview.phase = phase;
  overview.analysis = null;
  overview.generatedFor = "";
  overview.progressText = "";
  overview.errorText = "";
}

function clearOverviewToCancelled(): void {
  overview.phase = "cancelled";
  overview.progressText = "";
  overview.errorText = "";
}

function markEmptyPhase(): void {
  clearOverviewProduct("empty");
}

function dropOverviewProduct(): void {
  clearOverviewProduct("idle");
}

// 渲染前与相位读取前把状态收敛到与当前视频/字幕轨一致：
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
    dropOverviewProduct();
    return;
  }
  if (overview.generatedFor && overview.generatedFor !== currentOverviewKey()) {
    dropOverviewProduct();
  }
}

// ============================================================
// 等待计时与 ticker
// ============================================================

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

function stripText(): string {
  return overview.progressText || waitingNoteText();
}

function stopWaitTicker(): void {
  if (waitTicker !== null) {
    clearInterval(waitTicker);
    waitTicker = null;
  }
}

function tickWaitNote(): void {
  if (overview.phase !== "generating") {
    stopWaitTicker();
    return;
  }
  const text = stripText();
  if (!updateGeneratingStripText(text)) {
    renderIfOpen();
  }
}

function startWaitTicker(): void {
  stopWaitTicker();
  waitTicker = setInterval(tickWaitNote, 1000);
}

// ============================================================
// 协调器窄接口实现
// ============================================================

export function cancelReaderOverview(): void {
  if (overview.phase !== "generating") {
    return;
  }
  cancelRequested = true;
  stopWaitTicker();
  inflightAbort?.controller.abort();
  overview.inflight = null;
  clearOverviewToCancelled();
  renderIfOpen();
}

export function triggerReaderOverviewGeneration(
  { forceRefresh = false }: { forceRefresh?: boolean } = {}
): Promise<void> {
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
    stopWaitTicker();
  };
  void (async () => {
    try {
      await run;
    } catch {
      // 保证清理执行
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
    const { runOverviewAnalysis } = await import("../ai/analysis.js");
    const provider = await resolveActiveProvider();
    const analysis = await runOverviewAnalysis(
      {
        provider,
        context: buildOverviewContext(),
        forceRefresh,
        thinkingLevel: "off",
        signal: slot.controller.signal
      },
      {
        onProgress: (notice) => {
          overview.progressText = String(notice || "");
          slot.lastActivityAt = Date.now();
          renderIfOpen();
        },
        askCostGuard: (message) => confirmDialog({ message, confirmText: "继续" })
      }
    );
    if (inflightAbort !== slot || overview.generatedFor !== clipKey) {
      return;
    }
    overview.analysis = analysis;
    overview.phase = Array.isArray(analysis.failedRanges) && analysis.failedRanges.length > 0 ? "partial" : "ready";
    overview.progressText = "";
    overview.errorText = "";
    renderIfOpen();
  } catch (error) {
    if (inflightAbort !== slot || overview.generatedFor !== clipKey) {
      return;
    }
    if (isCancelledError(error) || isAbortedMarkerError(error)) {
      if (cancelRequested) {
        clearOverviewToCancelled();
        renderIfOpen();
        return;
      }
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

export function getReaderOverviewPhase(): ReaderOverviewPhase {
  syncOverviewPhaseToClip();
  return overview.phase;
}

export function getReaderOverviewSnapshot(): ReaderOverviewSnapshot {
  syncOverviewPhaseToClip();
  return {
    phase: overview.phase,
    analysis: overview.analysis,
    aiChapters: overview.aiChapters,
    progressText: overview.progressText,
    errorText: overview.errorText,
    stripText: stripText(),
    generatedFor: overview.generatedFor
  };
}

export function ensureReaderOverviewTab(): void {
  renderReadingOverviewNow();
  void triggerReaderOverviewGeneration();
}

export const overviewCoordinator: ReaderOverviewCoordinator = {
  trigger: triggerReaderOverviewGeneration,
  cancel: cancelReaderOverview,
  reset: resetReaderOverviewState,
  getPhase: getReaderOverviewPhase,
  getSnapshot: getReaderOverviewSnapshot,
  render: renderReadingOverviewNow,
  ensureTab: ensureReaderOverviewTab
};

// 注册 UI 点击分派对应的协调动作（单向依赖：呈现不 import 协调器，由协调器挂接）
registerOverviewUiActions({
  retry: () => {
    void triggerReaderOverviewGeneration({ forceRefresh: true });
  },
  cancel: () => {
    cancelReaderOverview();
  }
});
