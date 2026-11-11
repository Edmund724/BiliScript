// 概览协调器深 module：createOverviewCoordinator(deps) 工厂，生产装配点在 reader/overview.ts。
// 协调面：触发口径 × 并发闸门 × 相位机 × wait ticker。
// 单向依赖呈现层（reader/overview-ui.ts），UI 侧只吃快照、不反向依赖本协调器。
//
// 核心纪律（单源收敛于此，调用点不复述）：
//  1. 去重：inflight 编排 promise 复用（同 key 不重跑）+ generatedFor 身份校验（换片/换轨旧产物退场并换血）；
//  2. 诚实空态：无字幕（subtitleBody 为空）不触发生成，展示诚实空态；
//  3. 重复触发安全：ready/partial/error/cancelled 态不自动重跑，重试需显式 forceRefresh。
//  4. 闸门：视图打开时（isReadingViewOpen）才驱动真实 DOM 渲染，关闭时静默；
//  5. 生成进度纪律：generating 期间进度通知与每秒 wait ticker 均就地刷新状态条文案，不整块重渲以保留选区、焦点与滚动位置。

import { buildSubtitleSignature } from "../subtitle/cache.js";
import { resolveChapterSource, type ChapterSource } from "../shared/chapter-outline.js";
import type { OverviewAnalysis } from "../ai/analysis.js";
import type { AiProvider } from "../ai/types.js";
import type { ConfirmDialogOptions } from "../ui/confirm-dialog.js";
import type { SubtitleBodyItem } from "../core/state.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import type { OverviewSetupResumeIntent } from "./overview-setup-resume.js";
import { getErrorMessage, isAbortedMarkerError, isCancelledError } from "../shared/error-helpers.js";
import {
  renderReadingOverview,
  updateGeneratingStripText,
  type OverviewUiActions
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
  /** 概览相位或产物变化时通知（不含每秒进度）；返回退订函数 */
  subscribe(listener: () => void): () => void;
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
  /**
   * 消费首配续跑意图（票 01）：意图在、概览身份键与任务代次均未变时续跑一次
   * （forceRefresh），返回是否续跑；其余情况静默作废。装配方在首配保存成功后调用。
   */
  resumeAfterSetup(): Promise<boolean>;
}

interface OverviewClipSource {
  bvid: string;
  cid: string;
  aid: string;
  title: string;
  author: string;
  description: string;
  hotComments: unknown[];
  videoDuration: number;
  selectedSubtitleLang: string;
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  subtitleBody: SubtitleBodyItem[];
  chapters: unknown[];
}

export interface CreateOverviewCoordinatorDeps {
  /** 当前 clip 读取（身份键/上下文/字幕体的真源） */
  getClip(): OverviewClipSource;
  /** 阅读视图开关（渲染闸门） */
  isReadingViewOpen(): boolean;
  /** 解析当前启用的 AI 平台（含 apiKey/baseUrl/model） */
  resolveProvider(): Promise<AiProvider>;
  /** 概览管线动态装载（chunk 锚点：调用点保持 import() 按需装载，不得静态 import） */
  loadAnalysis(): Promise<typeof import("../ai/analysis.js")>;
  /** 费用确认弹窗 */
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  /** 注册 UI 点击分派对应的协调动作 */
  registerUiActions(actions: OverviewUiActions): void;
  /**
   * 首配续跑意图支持（票 01）：概览「去设置」动作经 begin 记录意图（装配方落页面
   * 内存并打开对应平台编辑界面），首配保存成功后协调器经 consume 取走校验。
   * 缺省 = 不支持（伴看侧无头协调器等非阅读视图装配）。
   */
  setupResume?: {
    begin(intent: OverviewSetupResumeIntent): void;
    consume(): OverviewSetupResumeIntent | null;
  };
  /** 无字幕配置空态「前往设置」的打开出口（装配方打开设置抽屉并定位转写分区） */
  openTranscribeSettings?: () => void;
  now(): number;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
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

interface ReaderOverviewInflightAbort {
  key: string;
  controller: AbortController;
  startedAt: number;
  lastActivityAt: number;
}

const WAIT_NOTE_THRESHOLD_MS = 10_000;

export function createOverviewCoordinator(
  deps: CreateOverviewCoordinatorDeps
): ReaderOverviewCoordinator {
  const overview: ReaderOverviewInternalState = {
    phase: "idle",
    analysis: null,
    aiChapters: false,
    progressText: "",
    errorText: "",
    generatedFor: "",
    inflight: null
  };

  let inflightAbort: ReaderOverviewInflightAbort | null = null;
  let waitTicker: ReturnType<typeof setInterval> | null = null;
  let cancelRequested = false;
  // 任务代次（票 01 首配续跑校验）：每次概览任务实际起跑递增一次。意图记录时的
  // 代次与续跑时不一致 = 设置期间概览又起过新一轮，旧续跑意图作废。
  let taskEpoch = 0;
  // 伴看等外部消费方的变更订阅：只在相位/产物/错误变化时扇出，进度文案不进签名
  // （每秒变化会把会话指令刷成噪声）。签名去重让 cancel/reset 的重复写点天然幂等。
  const changeListeners = new Set<() => void>();
  let lastNotifiedSignature = "";

  function overviewChangeSignature(): string {
    return JSON.stringify({
      phase: overview.phase,
      analysis: overview.analysis,
      errorText: overview.errorText
    });
  }

  function notifyOverviewChanged(): void {
    const signature = overviewChangeSignature();
    if (signature === lastNotifiedSignature) return;
    lastNotifiedSignature = signature;
    for (const listener of [...changeListeners]) {
      try {
        listener();
      } catch {
        // 订阅方异常不得打断协调器状态机
      }
    }
  }

  function subscribeOverviewChanges(listener: () => void): () => void {
    if (typeof listener !== "function") {
      return () => {};
    }
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  }

  function getClipBody(): { from: number; to: number; content: string }[] {
    const body = deps.getClip().subtitleBody;
    return Array.isArray(body) ? body : [];
  }

  function currentChapterSource(): ChapterSource {
    const clip = deps.getClip();
    return resolveChapterSource(clip.description, clip.hotComments, clip.chapters);
  }

  function currentOverviewKey(): string {
    const clip = deps.getClip();
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
    const clip = deps.getClip();
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
    if (deps.isReadingViewOpen()) {
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
    const waitedMs = deps.now() - slot.startedAt;
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
      deps.clearInterval(waitTicker);
      waitTicker = null;
    }
  }

  function renderGeneratingProgressIfOpen(): void {
    if (!deps.isReadingViewOpen() || overview.phase !== "generating") {
      return;
    }
    const text = stripText();
    if (!updateGeneratingStripText(text)) {
      renderReadingOverviewNow();
    }
  }

  function tickWaitNote(): void {
    if (overview.phase !== "generating") {
      stopWaitTicker();
      return;
    }
    renderGeneratingProgressIfOpen();
  }

  function startWaitTicker(): void {
    stopWaitTicker();
    waitTicker = deps.setInterval(tickWaitNote, 1000);
  }

  // ============================================================
  // 协调器窄接口实现
  // ============================================================

  function cancelReaderOverview(): void {
    if (overview.phase !== "generating") {
      return;
    }
    cancelRequested = true;
    stopWaitTicker();
    inflightAbort?.controller.abort();
    overview.inflight = null;
    clearOverviewToCancelled();
    renderIfOpen();
    notifyOverviewChanged();
  }

  function triggerReaderOverviewGeneration(
    { forceRefresh = false }: { forceRefresh?: boolean } = {}
  ): Promise<void> {
    if (overview.inflight && overview.generatedFor === currentOverviewKey()) {
      return overview.inflight;
    }
    if (getClipBody().length === 0) {
      markEmptyPhase();
      renderIfOpen();
      notifyOverviewChanged();
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
      slot = { key: clipKey, controller: new AbortController(), startedAt: deps.now(), lastActivityAt: 0 };
      inflightAbort = slot;
    }
    cancelRequested = false;
    taskEpoch += 1;
    overview.generatedFor = clipKey;
    overview.aiChapters = currentChapterSource().kind === "auto";
    overview.phase = "generating";
    overview.progressText = "";
    overview.errorText = "";
    startWaitTicker();
    renderIfOpen();
    notifyOverviewChanged();

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
      const { runOverviewAnalysis } = await deps.loadAnalysis();
      const provider = await deps.resolveProvider();
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
            if (inflightAbort !== slot || overview.generatedFor !== clipKey || overview.phase !== "generating") {
              return;
            }
            overview.progressText = String(notice || "");
            slot.lastActivityAt = deps.now();
            renderGeneratingProgressIfOpen();
          },
          askCostGuard: (message) => deps.confirm({ message, confirmText: "继续" })
        }
      );
      if (inflightAbort !== slot || overview.generatedFor !== clipKey) {
        return;
      }
      overview.analysis = analysis;
      overview.phase =
        (Array.isArray(analysis.failedRanges) && analysis.failedRanges.length > 0) || analysis.summaryFailed
          ? "partial"
          : "ready";
      overview.progressText = "";
      overview.errorText = "";
      renderIfOpen();
      notifyOverviewChanged();
    } catch (error) {
      if (inflightAbort !== slot || overview.generatedFor !== clipKey) {
        return;
      }
      if (isCancelledError(error) || isAbortedMarkerError(error)) {
        if (cancelRequested || isCancelledError(error)) {
          clearOverviewToCancelled();
          if (isCancelledError(error) && !cancelRequested) {
            overview.errorText = "费用确认已取消，未生成全片概览";
          }
          renderIfOpen();
          notifyOverviewChanged();
          return;
        }
        dropOverviewProduct();
        renderIfOpen();
        notifyOverviewChanged();
        return;
      }
      overview.phase = "error";
      overview.errorText = getErrorMessage(error, "概览生成失败");
      overview.progressText = "";
      renderIfOpen();
      notifyOverviewChanged();
    }
  }

  function resetReaderOverviewState(): void {
    stopWaitTicker();
    cancelRequested = false;
    overview.phase = "idle";
    overview.analysis = null;
    overview.aiChapters = false;
    overview.progressText = "";
    overview.errorText = "";
    overview.generatedFor = "";
    overview.inflight = null;
    notifyOverviewChanged();
  }

  function getReaderOverviewPhase(): ReaderOverviewPhase {
    syncOverviewPhaseToClip();
    return overview.phase;
  }

  function getReaderOverviewSnapshot(): ReaderOverviewSnapshot {
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

  function ensureReaderOverviewTab(): void {
    renderReadingOverviewNow();
    void triggerReaderOverviewGeneration();
  }

  // 首配续跑（票 01）：取走意图并逐项校验——意图缺失/已消费、无字幕空态、
  // 概览身份键变化（换视频/分P/换轨）、任务代次变化（设置期间起过新一轮）均
  // 静默作废；通过才 forceRefresh 续跑一次（error 相位同 key 会被去重挡回，
  // 必须强刷）。校验失败的意图已随 consume 丢弃，不会二次生效。
  async function resumeOverviewAfterSetup(): Promise<boolean> {
    const gate = deps.setupResume;
    if (!gate) {
      return false;
    }
    const intent = gate.consume();
    if (!intent) {
      return false;
    }
    if (getClipBody().length === 0) {
      return false;
    }
    if (String(intent.overviewKey || "") !== currentOverviewKey()) {
      return false;
    }
    if (Number(intent.taskEpoch) !== taskEpoch) {
      return false;
    }
    await triggerReaderOverviewGeneration({ forceRefresh: true });
    return true;
  }

  // 注册 UI 点击分派对应的协调动作（单向依赖：呈现不 import 协调器，由协调器挂接）
  deps.registerUiActions({
    retry: () => {
      void triggerReaderOverviewGeneration({ forceRefresh: true });
    },
    cancel: () => {
      cancelReaderOverview();
    },
    setup: (errorClass: OverviewSetupErrorClass) => {
      // 记录首配续跑意图（identity/代次在任务起跑前快照），打开正确平台编辑界面
      // 的出站由装配方在 begin 里完成。
      deps.setupResume?.begin({
        overviewKey: currentOverviewKey(),
        taskEpoch,
        createdAt: deps.now(),
        errorClass
      });
    },
    openTranscribeSettings: () => {
      deps.openTranscribeSettings?.();
    }
  });

  return {
    trigger: triggerReaderOverviewGeneration,
    cancel: cancelReaderOverview,
    subscribe: subscribeOverviewChanges,
    reset: resetReaderOverviewState,
    getPhase: getReaderOverviewPhase,
    getSnapshot: getReaderOverviewSnapshot,
    render: renderReadingOverviewNow,
    ensureTab: ensureReaderOverviewTab,
    resumeAfterSetup: resumeOverviewAfterSetup
  };
}
