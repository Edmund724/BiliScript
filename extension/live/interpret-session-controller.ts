import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { createDisposableContext } from "../shared/typed-event-bus.js";
import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { state, clipState, registerSubtitleSessionBoundaryHooks } from "../core/state.js";
import type { SubtitleBodyItem } from "../core/state.js";
import { findActiveSubtitleIndex, findActiveSubtitleIndexInItems } from "../subtitle/core.js";
import { acceptSubtitle } from "../subtitle/commit.js";
import {
  clearTranslatedSubtitleCache,
  flushSubtitleCache,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "../subtitle/cache.js";
import { buildSecondaryAlignment } from "../subtitle/alignment.js";
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import {
  findManualForeignTrackForAiRefine,
  findSecondaryTrackByPreferredLang,
  findTrackByRef,
  getLangFamily,
  isLoadableNativeTrack,
  isMonolingualNativeTracks,
  isSameLangFamily,
  resolveTargetLang,
  resolveTrackTarget
} from "../subtitle/selection.js";
import {
  TRANSLATION_CHUNK_SEC,
  createTranslatedTrackSession,
  type TranslatedTrackSession
} from "../subtitle/translated-track-session.js";
import type { InterpretSubtitleDisplayMode } from "./interpret-subtitle-preferences.js";
import type { RunAsrPipelineArgs } from "../asr/pipeline.js";
import { loadActiveAsrFallback } from "../asr/active-fallback.js";
import { resolveActiveAsrRuntimeState, type AsrProviderListEntry } from "../asr/asr-setup.js";
import { buildAsrSubtitleLabel } from "../subtitle/labels.js";
import type { translateSubtitleItems } from "../ai/subtitle-translate.js";
import { readCachedL1VideoIndex } from "../ai/subtitle-context.js";
import type { L1VideoIndexCacheRecord } from "../ai/long-video-hybrid-types.js";
import {
  resolveSubtitleTranslateProvider,
  type SubtitleTranslateProviderResolution
} from "../ai/subtitle-translate-config.js";
import { createLazyLoader } from "../shared/lazy-import.js";
import {
  createSubtitleChunkScheduler,
  PAUSE_TIMEOUT_MS,
  type SubtitleChunkScheduler
} from "../subtitle/chunk-scheduler.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";

const asrPipelineLoader = createLazyLoader(() => import("../asr/pipeline.js"));
const subtitleTranslateLoader = createLazyLoader(() => import("../ai/subtitle-translate.js"));

export type InterpretSessionState = "idle" | "connecting" | "connected";
export type InterpretAvailability = { ok: true } | { ok: false; error: string };
export type InterpretAiRefineMode = "off" | "manual-refine" | "foreign-refine";

export const CHUNK_DURATION_SEC = TRANSLATION_CHUNK_SEC;
export { PAUSE_TIMEOUT_MS };

export interface InterpretSessionControllerDeps {
  getVideoElement?: () => HTMLVideoElement | null;
  getTargetLang?: () => string;
  getDisplayMode?: () => InterpretSubtitleDisplayMode;
  getAiRefineMode?: () => InterpretAiRefineMode;
  showNotice?: (message: string, autoHideMs?: number) => void;
  setSubtitle?: (original: string, translation: string) => void;
  clearSubtitles?: () => void;
  clearSubtitlesOnSeek?: () => void;
  onStateChange?: (state: InterpretSessionState) => void;
  onGenerationChange?: (generation: number) => void;
  onAvailabilityChange?: (availability: InterpretAvailability) => void;
  runAsr?: (args: RunAsrPipelineArgs) => Promise<unknown>;
  translateItems?: (input: Parameters<typeof translateSubtitleItems>[0]) => Promise<SubtitleBodyItem[]>;
  loadCache?: typeof loadSubtitleFromCache;
  saveCache?: typeof saveSubtitleToCache;
  clearTranslatedCache?: typeof clearTranslatedSubtitleCache;
  resolveTranslateProvider?: typeof resolveSubtitleTranslateProvider;
  loadAsrProviders?: () => Promise<readonly AsrProviderListEntry[]>;
  loadNativePrimaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
  loadNativeSecondaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
}

export interface InterpretSessionController {
  getState(): InterpretSessionState;
  getAvailability(): InterpretAvailability;
  getVersions(): { acquisitionVersion: number; processingVersion: number };
  refreshAvailability(): Promise<InterpretAvailability>;
  flush(): Promise<void>;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  toggle(): Promise<void>;
  dispose(): void;
}

export function createInterpretSessionController(
  deps: InterpretSessionControllerDeps = {}
): InterpretSessionController {
  const getVideoElement = deps.getVideoElement ?? getRuntimeVideoElement;
  const getTargetLang = deps.getTargetLang ?? (() => state.settings?.liveInterpretTargetLang || "zh");
  const getDisplayMode = deps.getDisplayMode ?? (() => state.settings?.liveInterpretDisplayMode || "auto");
  const getAiRefineMode = deps.getAiRefineMode ?? (() => "off");
  const showNotice = deps.showNotice ?? (() => {});
  const setSubtitle = deps.setSubtitle ?? (() => {});
  const clearSubtitles = deps.clearSubtitles ?? (() => {});
  const clearSubtitlesOnSeek = deps.clearSubtitlesOnSeek ?? clearSubtitles;
  const customRunAsr = deps.runAsr;
  const customTranslateItems = deps.translateItems;
  const loadCache = deps.loadCache ?? loadSubtitleFromCache;
  const saveCache = deps.saveCache ?? saveSubtitleToCache;
  const clearTranslatedCache = deps.clearTranslatedCache ?? clearTranslatedSubtitleCache;
  const resolveTranslateProvider = deps.resolveTranslateProvider ?? resolveSubtitleTranslateProvider;
  const loadNativePrimaryTrack =
    deps.loadNativePrimaryTrack ??
    (async (target) => {
      const chain = await ensureSummarizeChain();
      await chain.loadSubtitle(target.url, target.lang, clipState.fetchRunId, target.id);
    });
  const loadNativeSecondaryTrack =
    deps.loadNativeSecondaryTrack ??
    (async (target) => {
      const chain = await ensureSummarizeChain();
      await chain.loadSecondarySubtitle(target.url, target.lang, clipState.fetchRunId, target.id);
    });

  const hasCustomLoadCache = Boolean(deps.loadCache);
  const hasCustomSaveCache = Boolean(deps.saveCache);

  let stateVal: InterpretSessionState = "idle";
  let generation = 0;
  let sessionAcquisitionVersion = clipState.acquisitionVersion;
  let sessionProcessingVersion = clipState.processingVersion;
  let activeClipSignature = "";
  let activeBvid = "";
  let activeCid = "";
  let boundVideo: HTMLVideoElement | null = null;
  let availability: InterpretAvailability = { ok: false, error: "正在检查平台配置..." };
  let availabilityGeneration = 0;
  let acquisitionAbortController: AbortController | null = null;
  let processingAbortController: AbortController | null = null;
  let scheduler: SubtitleChunkScheduler<void> | null = null;

  const activeChunkPromises = new Map<number, Promise<void>>();
  const isAsrDoneChunk = new Set<number>();
  let activeTrackSession: TranslatedTrackSession | null = null;
  let translatorConfiguredSession: TranslatedTrackSession | null = null;
  let secondaryAlignmentCache: ReturnType<typeof buildSecondaryAlignment> | null = null;
  let activeSecondaryItems: SubtitleBodyItem[] = [];
  let primaryCacheKey = "";
  let activeSessionKind: "asr" | "native-pair" | "cc-translate" = "asr";
  let activeAsrLabel = buildAsrSubtitleLabel(undefined);
  let activeProviderRes: SubtitleTranslateProviderResolution | undefined;
  let activeL1Index: L1VideoIndexCacheRecord | null = null;
  let lastTranslatingNoticeAt = -Infinity;
  let needsTranslatedCacheInvalidation = false;
  let lastOverlayOriginal: string | null = null;
  let lastOverlayTranslation: string | null = null;

  function initSessionAbortControllers(): void {
    const nextAcq = new AbortController();
    const nextProc = new AbortController();
    nextAcq.signal.addEventListener("abort", () => nextProc.abort(), { once: true });
    acquisitionAbortController = nextAcq;
    processingAbortController = nextProc;
  }

  function abortSessionControllers(scope: "both" | "processing" = "both"): void {
    scheduler?.stop();
    scheduler = null;
    if (scope === "both") {
      acquisitionAbortController?.abort();
      acquisitionAbortController = null;
    }
    processingAbortController?.abort();
    processingAbortController = null;
  }

  function isSessionStale(expectedGeneration = generation): boolean {
    return (
      expectedGeneration !== generation ||
      sessionAcquisitionVersion !== clipState.acquisitionVersion ||
      sessionProcessingVersion !== clipState.processingVersion
    );
  }

  async function flush(): Promise<void> {
    const snapBvid = activeBvid || state.clip.bvid;
    const snapCid = activeCid || state.clip.cid;
    if (activeTrackSession) {
      await activeTrackSession.flush();
      return;
    }
    await flushSubtitleCache(snapBvid && snapCid ? { bvid: snapBvid, cid: snapCid } : undefined);
  }

  function updateState(next: InterpretSessionState): void {
    stateVal = next;
    deps.onStateChange?.(next);
  }

  function updateAvailability(next: InterpretAvailability): InterpretAvailability {
    availability = next;
    deps.onAvailabilityChange?.(next);
    return availability;
  }

  function currentNativeTracks() {
    return (state.clip.subtitles || []).filter((track) => isLoadableNativeTrack(track));
  }

  function isZeroTokenNativePairScenario(): boolean {
    const nativeTracks = currentNativeTracks();
    return (
      nativeTracks.length >= 2 &&
      !isMonolingualNativeTracks(nativeTracks) &&
      getAiRefineMode() === "off"
    );
  }

  function hasPrimaryReadyInMemoryOrCache(): boolean {
    if (currentNativeTracks().length > 0) {
      return true;
    }
    if (state.clip.subtitleFetchState === "ready" && Array.isArray(state.clip.subtitleBody) && state.clip.subtitleBody.length > 0) {
      return true;
    }
    return false;
  }

  async function refreshAvailability(): Promise<InterpretAvailability> {
    const currentGeneration = ++availabilityGeneration;
    try {
      if (isZeroTokenNativePairScenario()) {
        return updateAvailability({ ok: true });
      }

      try {
        await resolveTranslateProvider();
      } catch (aiError) {
        if (currentGeneration !== availabilityGeneration) return availability;
        return updateAvailability({
          ok: false,
          error: (aiError as Error)?.message || "未配置字幕翻译 AI 平台，请先在设置中配置并填写 API Key"
        });
      }

      if (!hasPrimaryReadyInMemoryOrCache()) {
        const { activeProvider: activeAsr, setupState } = await resolveActiveAsrRuntimeState({
          loadProviders: deps.loadAsrProviders
        });

        if (currentGeneration !== availabilityGeneration) return availability;
        if (!activeAsr || activeAsr.enabled === false) {
          return updateAvailability({
            ok: false,
            error: "未配置语音识别 (ASR) 平台，请先在设置中添加平台并填写 API Key"
          });
        }
        if (setupState.providerStatus === "missing-key" || !activeAsr.hasSavedKey) {
          return updateAvailability({
            ok: false,
            error: "未配置语音识别 (ASR) 密钥，请先在设置中填写 API Key"
          });
        }
      }

      return updateAvailability({ ok: true });
    } catch (error) {
      if (currentGeneration !== availabilityGeneration) return availability;
      return updateAvailability({
        ok: false,
        error: `平台配置检查失败：${(error as Error)?.message || String(error)}`
      });
    }
  }

  function handlePause(): void {
    if (!boundVideo?.paused || stateVal !== "connected") {
      scheduler?.notifyPlay();
      return;
    }
    scheduler?.notifyPause();
  }

  function handlePlay(): void {
    scheduler?.notifyPlay();
  }

  function emitSubtitleIfChanged(original: string, translation: string): void {
    if (lastOverlayOriginal === original && lastOverlayTranslation === translation) {
      return;
    }
    lastOverlayOriginal = original;
    lastOverlayTranslation = translation;
    setSubtitle(original, translation);
  }

  function doesRangeHitActivePlayback(rangeFrom: number, rangeTo: number, currentTime: number): boolean {
    if (!(rangeTo > rangeFrom)) {
      return false;
    }
    const body = state.clip.subtitleBody;
    const activeIdx = findActiveSubtitleIndex(currentTime);
    if (activeIdx >= 0 && activeIdx < body.length) {
      const activeItem = body[activeIdx];
      return Math.min(rangeTo, activeItem.to) > Math.max(rangeFrom, activeItem.from);
    }
    return rangeFrom <= currentTime && currentTime < rangeTo;
  }

  function handleSeek(): void {
    clearSubtitlesOnSeek();
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
    setSubtitle("", "");
    const video = boundVideo || getVideoElement();
    if (!video) return;
    const currentTime = video.currentTime;
    if (activeSessionKind === "native-pair") {
      syncCurrentSubtitles(currentTime, generation);
      return;
    }
    const currentChunkIndex = Math.floor(currentTime / CHUNK_DURATION_SEC);
    if (activeTrackSession?.isChunkDone(currentChunkIndex)) {
      syncCurrentSubtitles(currentTime, generation);
    } else {
      showNotice(
        activeSessionKind === "cc-translate" ? "正在翻译字幕..." : "正在转写并翻译字幕...",
        2000
      );
    }
    scheduler?.seek(currentTime);
  }

  function handleTimeUpdate(): void {
    const video = boundVideo || getVideoElement();
    if (!video) return;
    const currentTime = video.currentTime;
    syncCurrentSubtitles(currentTime, generation);
    scheduler?.updatePlaybackTime(currentTime);
  }

  function unbindVideoLifecycle(): void {
    scheduler?.notifyPlay();
    if (boundVideo) {
      boundVideo.removeEventListener("pause", handlePause);
      boundVideo.removeEventListener("play", handlePlay);
      boundVideo.removeEventListener("seeking", handleSeek);
      boundVideo.removeEventListener("timeupdate", handleTimeUpdate);
      boundVideo = null;
    }
  }

  function bindVideoLifecycle(): void {
    unbindVideoLifecycle();
    boundVideo = getVideoElement();
    if (boundVideo) {
      boundVideo.addEventListener("pause", handlePause);
      boundVideo.addEventListener("play", handlePlay);
      boundVideo.addEventListener("seeking", handleSeek);
      boundVideo.addEventListener("timeupdate", handleTimeUpdate);
      handlePause();
    }
  }

  function syncCurrentSubtitles(currentTime: number, expectedGeneration = generation): void {
    if (isSessionStale(expectedGeneration) || stateVal !== "connected") {
      return;
    }
    const primaryBody = Array.isArray(state.clip.subtitleBody) ? state.clip.subtitleBody : [];
    const primaryIdx = findActiveSubtitleIndexInItems(primaryBody, currentTime);
    const originalText =
      primaryIdx >= 0 && primaryIdx < primaryBody.length
        ? String(primaryBody[primaryIdx]?.content || "").trim()
        : "";

    const secondaryBody =
      activeSessionKind === "native-pair"
        ? (Array.isArray(state.clip.secondarySubtitle?.body) ? state.clip.secondarySubtitle.body : [])
        : activeSecondaryItems;
    const secondaryIdx = findActiveSubtitleIndexInItems(secondaryBody, currentTime);
    let translationText =
      secondaryIdx >= 0 && secondaryIdx < secondaryBody.length
        ? String(secondaryBody[secondaryIdx]?.content || "").trim()
        : "";

    if (
      !translationText &&
      activeSessionKind !== "native-pair" &&
      primaryIdx >= 0 &&
      primaryIdx < primaryBody.length &&
      secondaryAlignmentCache
    ) {
      const originalItem = primaryBody[primaryIdx];
      translationText =
        secondaryAlignmentCache.query({
          from: originalItem.from,
          to: originalItem.to
        }) || "";
    }

    if (originalText || translationText) {
      emitSubtitleIfChanged(originalText, translationText);
      return;
    }

    const currentChunk = Math.floor(currentTime / CHUNK_DURATION_SEC);
    if (activeSessionKind === "asr" && !isAsrDoneChunk.has(currentChunk) && primaryBody.length === 0) {
      const now = Date.now();
      if (now - lastTranslatingNoticeAt > 2000) {
        lastTranslatingNoticeAt = now;
        showNotice("正在转写并翻译字幕...", 2000);
      }
    }
    emitSubtitleIfChanged("", "");
  }

  function seedAsrPseudoTrackIfNeeded(label = activeAsrLabel): void {
    const existing = state.clip.subtitles || [];
    if (!existing.some((t) => t.id === "asr")) {
      clipState.setSubtitles([
        { id: "asr", lan: "asr-zh", lanDoc: label, subtitleUrl: "" },
        ...existing
      ]);
    }
  }

  async function persistPrimaryIfAsr(currentGeneration: number): Promise<void> {
    if (activeSessionKind !== "asr" || !activeTrackSession || isSessionStale(currentGeneration)) {
      return;
    }
    const sortedPrimary = activeTrackSession.getPrimaryItems();
    if (sortedPrimary.length === 0) {
      return;
    }
    seedAsrPseudoTrackIfNeeded(activeAsrLabel);
    await acceptSubtitle({
      body: sortedPrimary,
      selectedSubtitleId: "asr",
      selectedSubtitleUrl: "",
      selectedSubtitleLang: activeAsrLabel,
      skipHotComments: true
    });
    if (isSessionStale(currentGeneration)) {
      return;
    }
    if (primaryCacheKey) {
      const saveResult = await saveCache(primaryCacheKey, sortedPrimary);
      if (saveResult?.ok !== false && needsTranslatedCacheInvalidation && activeBvid && activeCid) {
        needsTranslatedCacheInvalidation = false;
        await clearTranslatedCache({ bvid: activeBvid, cid: activeCid });
      }
    }
  }

  function createControllerTrackSession(params: {
    currentGeneration: number;
    bvid: string;
    cid: string;
    isAsrSource: boolean;
    selectedSubtitleId?: string;
    selectedSubtitleUrl?: string;
    selectedSubtitleLang?: string;
    trackLan?: string;
    targetLang: string;
    primaryItems?: readonly SubtitleBodyItem[];
    protocolProbeItems?: readonly SubtitleBodyItem[];
  }): TranslatedTrackSession {
    const { currentGeneration, bvid, cid } = params;
    return createTranslatedTrackSession(
      {
        bvid,
        cid,
        model: activeProviderRes?.model,
        primaryItems: params.primaryItems,
        protocolProbeItems: params.protocolProbeItems,
        source: {
          isAsrSource: params.isAsrSource,
          selectedSubtitleId: params.selectedSubtitleId,
          selectedSubtitleUrl: params.selectedSubtitleUrl,
          selectedSubtitleLang: params.selectedSubtitleLang,
          trackLan: params.trackLan,
          targetLang: params.targetLang
        },
        isStale: () =>
          isSessionStale(currentGeneration) ||
          stateVal === "idle" ||
          processingAbortController?.signal.aborted === true ||
          state.clip.bvid !== bvid ||
          state.clip.cid !== cid
      },
      {
        ...(customTranslateItems ? { translateItems: customTranslateItems } : {}),
        ...(hasCustomLoadCache ? { loadCustomCache: loadCache } : {}),
        ...(hasCustomSaveCache ? { saveCustomCache: saveCache } : {}),
        onStreamingUpdate: ({ items, cue }) => {
          activeSecondaryItems = items;
          secondaryAlignmentCache = items.length > 0 ? buildSecondaryAlignment(items) : null;
          const video = boundVideo || getVideoElement();
          if (video && doesRangeHitActivePlayback(cue.from, cue.to, video.currentTime)) {
            syncCurrentSubtitles(video.currentTime, currentGeneration);
          }
        },
        onAfterStreamingAccept: () => {
          if (!isSessionStale(currentGeneration) && stateVal === "connected") {
            notifyReaderPresenter({ kind: "rerender" });
          }
        },
        onBeforePersistChunk: () => persistPrimaryIfAsr(currentGeneration),
        onAfterPersistChunk: ({ chunkIndex, displayBody, updatedRange }) => {
          activeSecondaryItems = displayBody;
          secondaryAlignmentCache =
            displayBody.length > 0 ? buildSecondaryAlignment(displayBody) : null;
          notifyReaderPresenter({ kind: "rerender" });
          const video = boundVideo || getVideoElement();
          if (!video) {
            return;
          }
          const shouldSync =
            chunkIndex === -1 ||
            (updatedRange !== undefined &&
              doesRangeHitActivePlayback(updatedRange.from, updatedRange.to, video.currentTime));
          if (shouldSync) {
            syncCurrentSubtitles(video.currentTime, currentGeneration);
          }
        }
      }
    );
  }

  async function ensureTranslatorConfigured(
    session: TranslatedTrackSession,
    protocolItems?: readonly SubtitleBodyItem[]
  ): Promise<boolean> {
    if (customTranslateItems) {
      translatorConfiguredSession = session;
      return false;
    }
    if (translatorConfiguredSession === session) {
      return false;
    }
    const translateMod = await subtitleTranslateLoader.load();
    const sigChanged = session.reconfigure({
      resolveProtocolMode:
        typeof translateMod.resolveSubtitleTranslateProtocolMode === "function"
          ? translateMod.resolveSubtitleTranslateProtocolMode
          : undefined,
      translateItems: translateMod.translateSubtitleItems,
      protocolItems
    });
    translatorConfiguredSession = session;
    return sigChanged;
  }

  async function translateChunk(chunkIndex: number, currentGeneration: number): Promise<void> {
    const session = activeTrackSession;
    if (!session || isSessionStale(currentGeneration) || session.isChunkDone(chunkIndex)) {
      return;
    }
    const items = session.getPrimaryChunk(chunkIndex);
    if (items.length === 0) {
      return;
    }

    const taskPromise = (async () => {
      try {
        if (!customTranslateItems && translatorConfiguredSession !== session) {
          await ensureTranslatorConfigured(session, session.getPrimaryItems());
          if (isSessionStale(currentGeneration) || session.isChunkDone(chunkIndex)) {
            return;
          }
        }
        await session.translateChunk({
          chunkIndex,
          chunkFromSec: chunkIndex * CHUNK_DURATION_SEC,
          chunkToSec: (chunkIndex + 1) * CHUNK_DURATION_SEC,
          items,
          l1Index: activeL1Index,
          providerResolution: activeProviderRes,
          signal: processingAbortController?.signal
        });
      } catch (err) {
        const restored = session.getSecondaryItems();
        activeSecondaryItems = restored;
        secondaryAlignmentCache = restored.length > 0 ? buildSecondaryAlignment(restored) : null;
        if (isSessionStale(currentGeneration) || processingAbortController?.signal.aborted) {
          return;
        }
        throw err;
      }
    })();

    activeChunkPromises.set(chunkIndex, taskPromise);
    try {
      await taskPromise;
    } finally {
      if (activeChunkPromises.get(chunkIndex) === taskPromise) {
        activeChunkPromises.delete(chunkIndex);
      }
    }
  }

  function createSessionScheduler(
    currentGeneration: number,
    initialTimeSec: number,
    initialChunks: Array<{ index: number; startSec: number; endSec: number; status?: "pending" | "done" }>
  ): SubtitleChunkScheduler<void> {
    return createSubtitleChunkScheduler<void>({
      chunks: initialChunks,
      preloadWindowSec: 90,
      maxConcurrency: 2,
      firstScreenSolo: true,
      fillBackground: false,
      failureCooldownMs: 15_000,
      maxRateLimitRetries: 0,
      pauseTimeoutMs: PAUSE_TIMEOUT_MS,
      initialTimeSec,
      getCurrentTimeSec: () => (boundVideo || getVideoElement())?.currentTime ?? initialTimeSec,
      signal: processingAbortController?.signal,
      runChunk: async (chunk) => {
        await translateChunk(chunk.index, currentGeneration);
      },
      onChunkError: () => {
        if (isSessionStale(currentGeneration) || processingAbortController?.signal.aborted) {
          return;
        }
        showNotice("当前片段字幕翻译失败，将保留原文", 3000);
      },
      onPauseTimeout: () => {
        if (isSessionStale(currentGeneration)) {
          return;
        }
        void stop();
        showNotice("视频暂停超过 5 分钟，实时翻译已自动关闭", 6000);
      }
    });
  }

  function startScheduledTranslation(
    currentGeneration: number,
    session: TranslatedTrackSession,
    syncInitialOverlay = true
  ): void {
    updateState("connected");
    bindVideoLifecycle();
    const video = boundVideo || getVideoElement();
    const initialTime = video?.currentTime ?? 0;
    const initialChunks = session.getPrimaryChunks().map((chunk) => ({
      index: chunk.index,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      status: session.isChunkDone(chunk.index) ? ("done" as const) : ("pending" as const)
    }));
    scheduler = createSessionScheduler(currentGeneration, initialTime, initialChunks);
    scheduler.start();
    if (boundVideo?.paused) {
      scheduler.notifyPause();
    }
    if (syncInitialOverlay && video) {
      syncCurrentSubtitles(video.currentTime, currentGeneration);
    }
  }

  function markPrimaryChunksReadyInAsr(items: readonly SubtitleBodyItem[]): void {
    for (const item of items) {
      isAsrDoneChunk.add(Math.floor((Number(item.from) || 0) / CHUNK_DURATION_SEC));
    }
  }

  function resetBuffers(): void {
    activeTrackSession = null;
    translatorConfiguredSession = null;
    activeChunkPromises.clear();
    isAsrDoneChunk.clear();
    secondaryAlignmentCache = null;
    activeSecondaryItems = [];
    primaryCacheKey = "";
    activeSessionKind = "asr";
    lastTranslatingNoticeAt = -Infinity;
    needsTranslatedCacheInvalidation = false;
    activeL1Index = null;
    activeAsrLabel = buildAsrSubtitleLabel(undefined);
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
  }

  function abortAndResetSynchronously(scope: "both" | "processing" = "both"): void {
    generation += 1;
    deps.onGenerationChange?.(generation);
    abortSessionControllers(scope);
    unbindVideoLifecycle();
    clearSubtitles();
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
    setSubtitle("", "");
    resetBuffers();
    updateState("idle");
  }

  async function stop(): Promise<void> {
    const flushPromise = flush();
    abortAndResetSynchronously("both");
    await flushPromise;
  }

  async function start(): Promise<boolean> {
    if (stateVal === "connecting" || stateVal === "connected") return true;

    sessionAcquisitionVersion = clipState.acquisitionVersion;
    sessionProcessingVersion = clipState.processingVersion;
    generation += 1;
    const currentGeneration = generation;
    deps.onGenerationChange?.(currentGeneration);
    initSessionAbortControllers();
    updateState("connecting");

    try {
      const avail = await refreshAvailability();
      if (isSessionStale(currentGeneration)) return false;
      if (!avail.ok) {
        showNotice(avail.error, 6000);
        await stop();
        return false;
      }

      activeClipSignature = computeCurrentClipSignature();
      const bvid = state.clip.bvid;
      const cid = state.clip.cid;
      activeBvid = bvid;
      activeCid = cid;

      const nativeTracks = currentNativeTracks();
      const refineMode = getAiRefineMode();

      if (nativeTracks.length >= 2 && !isMonolingualNativeTracks(nativeTracks) && refineMode === "off") {
        activeSessionKind = "native-pair";
        const mainRef =
          findTrackByRef(nativeTracks, {
            id: state.clip.selectedSubtitleId,
            url: state.clip.selectedSubtitleUrl
          }) ?? nativeTracks[0];
        const mainTarget = resolveTrackTarget(mainRef, nativeTracks);
        if (
          !Array.isArray(state.clip.subtitleBody) ||
          state.clip.subtitleBody.length === 0 ||
          String(state.clip.selectedSubtitleId || "") !== mainTarget.id
        ) {
          await loadNativePrimaryTrack(mainTarget);
          if (isSessionStale(currentGeneration)) return false;
        }
        const pick = String(state.settings?.secondarySubtitleLang || DEFAULT_SETTINGS.secondarySubtitleLang).trim();
        let partnerTrack = findSecondaryTrackByPreferredLang(nativeTracks, pick, mainTarget.id);
        if (
          !partnerTrack &&
          isSameLangFamily(pick, mainRef.lan) &&
          getLangFamily(mainRef.lan) !== "zh"
        ) {
          partnerTrack = findSecondaryTrackByPreferredLang(nativeTracks, "zh-CN", mainTarget.id);
        }
        if (!partnerTrack) {
          partnerTrack =
            nativeTracks.find(
              (item) =>
                String(item.id || "") !== mainTarget.id &&
                !isSameLangFamily(item.lan, mainRef.lan)
            ) ?? null;
        }
        if (partnerTrack) {
          const secondaryTarget = resolveTrackTarget(partnerTrack, nativeTracks);
          if (
            state.clip.secondarySubtitle.state !== "ready" ||
            String(state.clip.secondarySubtitle.id || "") !== secondaryTarget.id ||
            state.clip.secondarySubtitle.body.length === 0
          ) {
            await loadNativeSecondaryTrack(secondaryTarget);
            if (isSessionStale(currentGeneration)) return false;
          }
        }
        updateState("connected");
        bindVideoLifecycle();
        const video = boundVideo || getVideoElement();
        if (video) syncCurrentSubtitles(video.currentTime, currentGeneration);
        return true;
      }

      if (nativeTracks.length > 0) {
        activeSessionKind = "cc-translate";
        const foreignSource =
          refineMode === "foreign-refine" ? findManualForeignTrackForAiRefine(nativeTracks) : null;
        const sourceTrack =
          foreignSource ??
          findTrackByRef(nativeTracks, {
            id: state.clip.selectedSubtitleId,
            url: state.clip.selectedSubtitleUrl
          }) ??
          nativeTracks[0];
        const sourceTarget = resolveTrackTarget(sourceTrack, nativeTracks);
        if (
          !Array.isArray(state.clip.subtitleBody) ||
          state.clip.subtitleBody.length === 0 ||
          (sourceTarget.id && String(state.clip.selectedSubtitleId || "") !== sourceTarget.id)
        ) {
          await loadNativePrimaryTrack(sourceTarget);
          if (isSessionStale(currentGeneration)) return false;
        }

        const sourceTrackId = String(state.clip.selectedSubtitleId || sourceTarget.id || "");
        const sourceTrackLang = String(state.clip.selectedSubtitleLang || sourceTarget.lang || "");
        const sourceTrackLan = String(sourceTrack.lan || "");
        const targetLang = foreignSource
          ? "zh"
          : resolveTargetLang(sourceTrackLan, getTargetLang());
        primaryCacheKey = "";

        activeProviderRes = await resolveTranslateProvider();
        if (isSessionStale(currentGeneration)) return false;

        const primaryItems = [...(state.clip.subtitleBody || [])];
        markPrimaryChunksReadyInAsr(primaryItems);
        const session = createControllerTrackSession({
          currentGeneration,
          bvid,
          cid,
          isAsrSource: false,
          selectedSubtitleId: sourceTrackId,
          selectedSubtitleUrl: state.clip.selectedSubtitleUrl || sourceTarget.url,
          selectedSubtitleLang: sourceTrackLang,
          trackLan: sourceTrackLan,
          targetLang,
          primaryItems
        });
        activeTrackSession = session;

        activeL1Index = await readCachedL1VideoIndex(state.clip);
        if (isSessionStale(currentGeneration)) return false;
        let secondaryItems = await session.loadCached();
        if (isSessionStale(currentGeneration)) return false;

        if (secondaryItems.length > 0) {
          await session.seedSecondary(secondaryItems);
          if (isSessionStale(currentGeneration)) return false;
          activeSecondaryItems = session.getSecondaryItems();
          secondaryAlignmentCache = buildSecondaryAlignment(activeSecondaryItems);
        } else {
          clipState.clearSecondarySubtitle();
        }

        if (session.getPendingPrimaryChunks().length > 0) {
          const sigChanged = await ensureTranslatorConfigured(session, primaryItems);
          if (isSessionStale(currentGeneration)) return false;
          if (sigChanged) {
            secondaryItems = await session.loadCached();
            if (isSessionStale(currentGeneration)) return false;
            if (secondaryItems.length > 0) {
              await session.seedSecondary(secondaryItems);
              if (isSessionStale(currentGeneration)) return false;
              activeSecondaryItems = session.getSecondaryItems();
              secondaryAlignmentCache = buildSecondaryAlignment(activeSecondaryItems);
            }
          }
        }

        startScheduledTranslation(currentGeneration, session);
        return true;
      }

      activeSessionKind = "asr";
      const targetLang = getTargetLang();

      const { activeId, activeProvider: activeAsr, asrLanguage } = await resolveActiveAsrRuntimeState({
        loadProviders: deps.loadAsrProviders
      });
      if (isSessionStale(currentGeneration)) return false;
      activeAsrLabel = buildAsrSubtitleLabel(asrLanguage);

      primaryCacheKey = getSubtitleCacheKey({
        bvid,
        cid,
        identity: {
          kind: "asr",
          providerId: activeId,
          model: activeAsr?.model,
          lang: asrLanguage
        }
      });

      activeProviderRes = await resolveTranslateProvider();
      if (isSessionStale(currentGeneration)) return false;

      let primaryItems: SubtitleBodyItem[] | null = null;
      if (state.clip.subtitleFetchState === "ready" && state.clip.subtitleBody?.length) {
        primaryItems = [...state.clip.subtitleBody];
      } else {
        const cached = await loadCache(primaryCacheKey);
        if (isSessionStale(currentGeneration)) return false;
        if (Array.isArray(cached) && cached.length > 0) {
          primaryItems = cached as SubtitleBodyItem[];
        }
      }

      const session = createControllerTrackSession({
        currentGeneration,
        bvid,
        cid,
        isAsrSource: true,
        targetLang,
        primaryItems: primaryItems ?? undefined,
        protocolProbeItems: [{ from: 0, to: 1, content: "probe" }]
      });
      activeTrackSession = session;

      const secondaryItems = await session.loadCached();
      if (isSessionStale(currentGeneration)) return false;

      if (primaryItems && primaryItems.length > 0 && secondaryItems.length > 0) {
        markPrimaryChunksReadyInAsr(primaryItems);
        seedAsrPseudoTrackIfNeeded(activeAsrLabel);
        await acceptSubtitle({
          body: primaryItems,
          selectedSubtitleId: "asr",
          selectedSubtitleUrl: "",
          selectedSubtitleLang: activeAsrLabel,
          skipHotComments: true
        });
        await session.seedSecondary(secondaryItems);
        if (isSessionStale(currentGeneration)) return false;
        activeSecondaryItems = session.getSecondaryItems();
        secondaryAlignmentCache = buildSecondaryAlignment(activeSecondaryItems);
        if (session.getPendingPrimaryChunks().length > 0) {
          await ensureTranslatorConfigured(session, primaryItems);
          if (isSessionStale(currentGeneration)) return false;
        }
        startScheduledTranslation(currentGeneration, session);
        return true;
      }

      if (primaryItems && primaryItems.length > 0) {
        markPrimaryChunksReadyInAsr(primaryItems);
        seedAsrPseudoTrackIfNeeded(activeAsrLabel);
        await acceptSubtitle({
          body: primaryItems,
          selectedSubtitleId: "asr",
          selectedSubtitleUrl: "",
          selectedSubtitleLang: activeAsrLabel,
          skipHotComments: true
        });
        if (isSessionStale(currentGeneration)) return false;
        activeL1Index = await readCachedL1VideoIndex(state.clip);
        if (isSessionStale(currentGeneration)) return false;
        await ensureTranslatorConfigured(session, primaryItems);
        if (isSessionStale(currentGeneration)) return false;
        startScheduledTranslation(currentGeneration, session);
        return true;
      }

      const activeFallback = await loadActiveAsrFallback().catch(() => null);
      if (isSessionStale(currentGeneration)) return false;
      if (activeFallback?.hasActiveAsrTranscribe({ bvid, cid })) {
        showNotice("后台语音识别正在进行中，请稍候完成后再试", 4000);
        await stop();
        return false;
      }

      const runAsr = customRunAsr ?? (await asrPipelineLoader.load()).runAsrPipeline;
      if (isSessionStale(currentGeneration)) return false;
      await ensureTranslatorConfigured(session, [{ from: 0, to: 1, content: "probe" }]);
      if (isSessionStale(currentGeneration)) return false;

      needsTranslatedCacheInvalidation = true;
      showNotice("正在转写并翻译字幕...", 3000);
      startScheduledTranslation(currentGeneration, session, false);

      void runAsr({
        bvid,
        cid,
        signal: acquisitionAbortController?.signal,
        onChunkResult: async (record, items, snapshot) => {
          if (isSessionStale(currentGeneration) || acquisitionAbortController?.signal.aborted) {
            return;
          }
          const chunkIdx = record.index;

          if (!snapshot) {
            session.setPrimaryChunk(chunkIdx, items as SubtitleBodyItem[]);
            isAsrDoneChunk.add(chunkIdx);

            scheduler?.upsertChunk(
              {
                index: chunkIdx,
                startSec: chunkIdx * CHUNK_DURATION_SEC,
                endSec: (chunkIdx + 1) * CHUNK_DURATION_SEC
              },
              { resetStatus: true }
            );
            const activePromise = activeChunkPromises.get(chunkIdx);
            if (scheduler?.getChunkStatus(chunkIdx) === "running" && activePromise) {
              await activePromise;
            }
            return;
          }

          const changedIndices = Array.from(
            new Set<number>([chunkIdx, ...snapshot.updatedChunkIndices])
          ).sort((a, b) => a - b);
          let hasUnwindowedUpdate = false;
          for (const idx of changedIndices) {
            const nextItems = (snapshot.chunkItems.get(idx) ?? (idx === chunkIdx ? items : [])) as SubtitleBodyItem[];
            if (idx !== chunkIdx) {
              session.invalidateChunk(idx);
              hasUnwindowedUpdate = true;
            }
            session.setPrimaryChunk(idx, nextItems);
            isAsrDoneChunk.add(idx);
            scheduler?.upsertChunk(
              {
                index: idx,
                startSec: idx * CHUNK_DURATION_SEC,
                endSec: (idx + 1) * CHUNK_DURATION_SEC
              },
              { resetStatus: true }
            );
          }

          const runningPromises = changedIndices
            .filter((idx) => scheduler?.getChunkStatus(idx) === "running" && activeChunkPromises.has(idx))
            .map((idx) => activeChunkPromises.get(idx)!);
          if (runningPromises.length > 0) {
            await Promise.all(runningPromises);
          } else if (hasUnwindowedUpdate) {
            await session.persistCurrent();
          }
        }
      }).catch((error) => {
        if (!isSessionStale(currentGeneration) && !acquisitionAbortController?.signal.aborted) {
          showNotice(`字幕生成失败：${(error as Error)?.message || String(error)}`, 6000);
          void stop();
        }
      });

      return true;
    } catch (err) {
      if (!isSessionStale(currentGeneration)) {
        showNotice((err as Error)?.message || String(err), 6000);
        await stop();
      }
      return false;
    }
  }

  function handleUrlChange(): void {
    if (
      (stateVal === "connecting" || stateVal === "connected") &&
      (computeCurrentClipSignature() !== activeClipSignature ||
        state.clip.bvid !== activeBvid ||
        state.clip.cid !== activeCid)
    ) {
      void stop();
    }
  }

  function handlePageHide(): void {
    void flush();
  }

  function handleVisibilityChange(): void {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      void flush();
    }
  }

  const unregisterBoundaryHooks = registerSubtitleSessionBoundaryHooks({
    flush: () => flush(),
    onAbortAndClear: (snapshot) => {
      sessionAcquisitionVersion = snapshot.acquisitionVersion;
      sessionProcessingVersion = snapshot.processingVersion;
      if (stateVal === "connecting" || stateVal === "connected") {
        abortAndResetSynchronously(snapshot.reason === "processing-switch" ? "processing" : "both");
      } else {
        abortSessionControllers(snapshot.reason === "processing-switch" ? "processing" : "both");
        clearSubtitles();
        lastOverlayOriginal = null;
        lastOverlayTranslation = null;
        setSubtitle("", "");
      }
    }
  });

  const lifecycleScope = createDisposableContext();
  contentEventBus.on("host:url-change", handleUrlChange, { signal: lifecycleScope.signal });
  if (typeof window !== "undefined") {
    lifecycleScope.addListener(window, "pagehide", handlePageHide);
  }
  if (typeof document !== "undefined") {
    lifecycleScope.addListener(document, "visibilitychange", handleVisibilityChange);
  }

  async function toggle(): Promise<void> {
    if (stateVal === "connecting" || stateVal === "connected") {
      await stop();
    } else {
      await start();
    }
  }

  function dispose(): void {
    unregisterBoundaryHooks();
    lifecycleScope.dispose();
    void stop();
  }

  return {
    getState: () => stateVal,
    getAvailability: () => availability,
    getVersions: () => ({
      acquisitionVersion: sessionAcquisitionVersion,
      processingVersion: sessionProcessingVersion
    }),
    refreshAvailability,
    flush,
    start,
    stop,
    toggle,
    dispose
  };
}
