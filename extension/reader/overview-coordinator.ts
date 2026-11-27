import { buildSubtitleSignature } from "../subtitle/signature.js";
import { resolveChapterSource, type ChapterSource } from "../shared/chapter-outline.js";
import {
  DEFAULT_OVERVIEW_GENERATION_CONFIG,
  hasAnyOverviewAiSection,
  normalizeOverviewAiSections,
  overviewSectionsCacheSuffix,
  type OverviewAiSections,
  type OverviewGenerationConfig
} from "../shared/overview-sections.js";
import { getSiteCapabilities, normalizeSiteId, YOUTUBE_UNIT_CID, type SiteId } from "../shared/site.js";
import type { OverviewAnalysis } from "../ai/analysis.js";
import type { AiContext, AiProvider, ChapterItem, HotComment } from "../ai/types.js";
import type { ConfirmDialogOptions } from "../ui/confirm-dialog.js";
import type { SubtitleBodyItem } from "../core/state.js";
import type { OverviewSetupErrorClass } from "../core/overview-setup-error.js";
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
  readonly autoGenerate?: boolean;
  readonly sections?: OverviewAiSections;
}

export interface ReaderOverviewCoordinator {
  trigger(options?: { forceRefresh?: boolean; manual?: boolean }): Promise<void>;
  cancel(): void;
  subscribe(listener: () => void): () => void;
  reset(): void;
  getPhase(): ReaderOverviewPhase;
  getSnapshot(): ReaderOverviewSnapshot;
  render(): void;
  ensureTab(): void;
}

export interface OverviewSetupRequest {
  errorClass: OverviewSetupErrorClass;
  isStillValid: () => boolean;
  onResume: () => Promise<void>;
}

interface OverviewClipSource {
  site?: SiteId;
  bvid: string;
  cid: string;
  aid: string;
  title: string;
  author: string;
  description: string;
  hotComments: HotComment[];
  videoDuration: number;
  selectedSubtitleLang: string;
  selectedSubtitleId: string;
  selectedSubtitleUrl: string;
  subtitleBody: SubtitleBodyItem[];
  chapters: ChapterItem[];
}

export interface CreateOverviewCoordinatorDeps {
  getClip(): OverviewClipSource;
  getOverviewConfig?(): OverviewGenerationConfig;
  isReadingViewOpen(): boolean;
  resolveProvider(): Promise<AiProvider>;
  loadAnalysis(): Promise<typeof import("../ai/analysis.js")>;
  confirm(options: ConfirmDialogOptions): Promise<boolean>;
  registerUiActions(actions: OverviewUiActions): void;
  setupResume?: {
    begin(request: OverviewSetupRequest): void;
  };
  openTranscribeSettings?: () => void;
  openOverviewSettings?: () => void;
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
  let taskEpoch = 0;
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

  function resolveClipSite(clip: OverviewClipSource): SiteId {
    return normalizeSiteId(clip.site ?? (clip.cid === YOUTUBE_UNIT_CID ? "youtube" : undefined));
  }

  function currentChapterSource(): ChapterSource {
    const clip = deps.getClip();
    const supportsHotComments = getSiteCapabilities(resolveClipSite(clip)).supportsHotComments;
    return resolveChapterSource(clip.description, supportsHotComments ? clip.hotComments : [], clip.chapters);
  }

  function currentOverviewConfig(): OverviewGenerationConfig {
    const raw = deps.getOverviewConfig?.();
    if (!raw) {
      return {
        autoGenerate: DEFAULT_OVERVIEW_GENERATION_CONFIG.autoGenerate,
        sections: { ...DEFAULT_OVERVIEW_GENERATION_CONFIG.sections }
      };
    }
    return {
      autoGenerate: raw.autoGenerate !== false,
      sections: normalizeOverviewAiSections(raw.sections)
    };
  }

  function currentOverviewKey(): string {
    const clip = deps.getClip();
    const chapterSource = currentChapterSource();
    const config = currentOverviewConfig();
    const signature = buildSubtitleSignature({
      lang: clip.selectedSubtitleLang,
      subtitleId: clip.selectedSubtitleId,
      subtitleUrl: clip.selectedSubtitleUrl,
      body: getClipBody(),
      chapters: chapterSource.signatureChapters,
      chapterOutline: chapterSource.chapters
    });
    return `${clip.bvid}|${clip.cid}|${signature}${overviewSectionsCacheSuffix(config.sections)}`;
  }

  function buildOverviewContext(): AiContext {
    const clip = deps.getClip();
    const site = resolveClipSite(clip);
    const supportsHotComments = getSiteCapabilities(site).supportsHotComments;
    return {
      site,
      bvid: clip.bvid,
      cid: clip.cid,
      aid: clip.aid,
      title: clip.title,
      author: clip.author,
      videoDescription: clip.description,
      hotComments: supportsHotComments && Array.isArray(clip.hotComments) ? clip.hotComments : [],
      videoDuration: clip.videoDuration,
      subtitleLang: clip.selectedSubtitleLang,
      selectedSubtitleId: clip.selectedSubtitleId,
      selectedSubtitleUrl: clip.selectedSubtitleUrl,
      subtitleBody: getClipBody(),
      chapters: Array.isArray(clip.chapters) ? clip.chapters : []
    };
  }

  function renderReadingOverviewNow(): void {
    renderReadingOverview(getReaderOverviewSnapshot());
  }

  function renderIfOpen(): void {
    if (deps.isReadingViewOpen()) {
      renderReadingOverviewNow();
    }
  }

  function clearOverviewProduct(phase: "empty" | "idle"): void {
    stopWaitTicker();
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

  async function hydrateCachedOverviewIfAvailable(
    clipKey: string,
    sections: OverviewAiSections
  ): Promise<void> {
    try {
      const analysisMod = await deps.loadAnalysis();
      if (typeof analysisMod.loadCachedOverviewAnalysis !== "function") {
        return;
      }
      const cached = await analysisMod.loadCachedOverviewAnalysis(buildOverviewContext(), sections);
      if (!cached || currentOverviewKey() !== clipKey || overview.phase === "generating") {
        return;
      }
      overview.generatedFor = clipKey;
      overview.aiChapters = sections.chapters && currentChapterSource().kind === "auto";
      overview.analysis = cached;
      overview.phase =
        (Array.isArray(cached.failedRanges) && cached.failedRanges.length > 0) || cached.summaryFailed
          ? "partial"
          : "ready";
      overview.progressText = "";
      overview.errorText = "";
      renderIfOpen();
      notifyOverviewChanged();
    } catch {
    }
  }

  function triggerReaderOverviewGeneration(
    { forceRefresh = false, manual = false }: { forceRefresh?: boolean; manual?: boolean } = {}
  ): Promise<void> {
    const config = currentOverviewConfig();
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

    if (!hasAnyOverviewAiSection(config.sections)) {
      renderIfOpen();
      notifyOverviewChanged();
      return Promise.resolve();
    }

    if (!manual && !forceRefresh && !config.autoGenerate) {
      renderIfOpen();
      return hydrateCachedOverviewIfAvailable(clipKey, config.sections);
    }

    let slot = inflightAbort;
    if (!slot || slot.key !== clipKey || slot.controller.signal.aborted) {
      slot = { key: clipKey, controller: new AbortController(), startedAt: deps.now(), lastActivityAt: 0 };
      inflightAbort = slot;
    }
    cancelRequested = false;
    taskEpoch += 1;
    overview.generatedFor = clipKey;
    overview.aiChapters = config.sections.chapters && currentChapterSource().kind === "auto";
    overview.phase = "generating";
    overview.progressText = "";
    overview.errorText = "";
    startWaitTicker();
    renderIfOpen();
    notifyOverviewChanged();

    const run = startOverviewRun(clipKey, forceRefresh, slot, config.sections);
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
      } finally {
        cleanup();
      }
    })();
    return run;
  }

  async function startOverviewRun(
    clipKey: string,
    forceRefresh: boolean,
    slot: ReaderOverviewInflightAbort,
    sections: OverviewAiSections
  ): Promise<void> {
    try {
      const { runOverviewAnalysis } = await deps.loadAnalysis();
      const provider = await deps.resolveProvider();
      const analysis = await runOverviewAnalysis(
        {
          provider,
          context: buildOverviewContext(),
          forceRefresh,
          sections,
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
          askCostGuard: (message) =>
            deps.confirm({ title: "确认生成全片概览", message, confirmText: "继续" })
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
    const config = currentOverviewConfig();
    return {
      phase: overview.phase,
      analysis: overview.analysis,
      aiChapters: overview.aiChapters,
      progressText: overview.progressText,
      errorText: overview.errorText,
      stripText: stripText(),
      generatedFor: overview.generatedFor,
      autoGenerate: config.autoGenerate,
      sections: config.sections
    };
  }

  function ensureReaderOverviewTab(): void {
    renderReadingOverviewNow();
    void triggerReaderOverviewGeneration();
  }

  deps.registerUiActions({
    generate: () => {
      void triggerReaderOverviewGeneration({ manual: true });
    },
    retry: () => {
      void triggerReaderOverviewGeneration({ forceRefresh: true, manual: true });
    },
    cancel: () => {
      cancelReaderOverview();
    },
    setup: (errorClass: OverviewSetupErrorClass) => {
      const snapshotKey = currentOverviewKey();
      const snapshotEpoch = taskEpoch;
      deps.setupResume?.begin({
        errorClass,
        isStillValid: () =>
          getClipBody().length > 0 &&
          snapshotKey === currentOverviewKey() &&
          snapshotEpoch === taskEpoch,
        onResume: () => triggerReaderOverviewGeneration({ forceRefresh: true, manual: true })
      });
    },
    openTranscribeSettings: () => {
      deps.openTranscribeSettings?.();
    },
    openOverviewSettings: () => {
      deps.openOverviewSettings?.();
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
    ensureTab: ensureReaderOverviewTab
  };
}
