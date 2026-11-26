import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { getSiteCapabilities } from "../shared/site.js";
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
import { ensureSummarizeChain } from "../subtitle/lazy.js";
import {
  canUseNativeBilingualPair,
  classifySubtitleTrack,
  createAsrPseudoTrack,
  findManualForeignTrackForAiRefine,
  findSecondaryTrackByPreferredLang,
  findTrackByRef,
  getLangFamily,
  isAsrSubtitleTrack,
  isLoadableNativeTrack,
  isSameLangFamily,
  resolveTargetLang,
  resolveTrackTarget,
  upsertAsrPseudoTrack
} from "../subtitle/selection.js";
import {
  TRANSLATION_CHUNK_SEC,
  createTranslatedTrackSession,
  resolveTranslatedTrackSource,
  type TranslatedTrackSession,
  type TranslatedTrackSourceSpec
} from "../subtitle/translated-track-session.js";
import type {
  InterpretSubtitleDisplayMode,
  LiveInterpretTargetLang
} from "./interpret-subtitle-preferences.js";
import type { RunAsrPipelineArgs } from "../asr/pipeline.js";
import { loadActiveAsrFallback } from "../asr/active-fallback.js";
import { resolveActiveAsrRuntimeState, type AsrProviderListEntry } from "../asr/asr-setup.js";
import { buildAsrSubtitleLabel } from "../subtitle/labels.js";
import type { translateSubtitleTrack } from "../ai/subtitle-translate.js";
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

export type InterpretModeIntent =
  | "off"
  | "native-bilingual"
  | { kind: "ai-refine"; refineMode: "manual-refine" | "foreign-refine" }
  | {
      kind: "translate";
      displayMode: InterpretSubtitleDisplayMode;
      targetLang: LiveInterpretTargetLang;
    };

export interface InterpretSessionSnapshot {
  state: InterpretSessionState;
  availability: InterpretAvailability;
  aiRefineMode: InterpretAiRefineMode;
  generation: number;
  sourceLan: string;
  targetLang: LiveInterpretTargetLang;
  displayMode: InterpretSubtitleDisplayMode;
  nativePairAvailable: boolean;
  foreignRefineAvailable: boolean;
  hasNativeTracks: boolean;
  versions: { acquisitionVersion: number; processingVersion: number };
}

export interface InterpretVideoPort {
  getElement: () => HTMLVideoElement | null;
}

export interface InterpretOverlayPort {
  setSubtitle: (original: string, translation: string, expectedGeneration?: number) => void;
  clear: () => void;
  clearForSeek?: () => void;
  showNotice?: (message: string, autoHideMs?: number) => void;
  syncAppearance?: () => void;
  setSessionGeneration?: (generation: number) => void;
  onStateChange?: (snapshot: InterpretSessionSnapshot) => void;
  onAvailabilityChange?: (availability: InterpretAvailability) => void;
}

export interface InterpretStoragePort {
  loadCache?: typeof loadSubtitleFromCache;
  saveCache?: typeof saveSubtitleToCache;
  clearTranslatedCache?: typeof clearTranslatedSubtitleCache;
  saveSettings?: (patch: Record<string, unknown>) => Promise<unknown> | void;
}

export interface InterpretMediaPort {
  runAsr?: (args: RunAsrPipelineArgs) => Promise<unknown>;
  translateTrack?: typeof translateSubtitleTrack;
  resolveTranslateProvider?: typeof resolveSubtitleTranslateProvider;
  loadAsrProviders?: () => Promise<readonly AsrProviderListEntry[]>;
  loadNativePrimaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
  loadNativeSecondaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
}

export interface InterpretSessionControllerPorts {
  video?: InterpretVideoPort;
  overlay?: InterpretOverlayPort;
  storage?: InterpretStoragePort;
  media?: InterpretMediaPort;
}

interface LegacyInterpretSessionControllerDeps {
  getVideoElement?: () => HTMLVideoElement | null;
  getAiRefineMode?: () => InterpretAiRefineMode;
  setSubtitle?: (original: string, translation: string) => void;
  clearSubtitles?: () => void;
  runAsr?: (args: RunAsrPipelineArgs) => Promise<unknown>;
  translateTrack?: typeof translateSubtitleTrack;
  resolveTranslateProvider?: typeof resolveSubtitleTranslateProvider;
  loadAsrProviders?: () => Promise<readonly AsrProviderListEntry[]>;
  loadNativePrimaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
  loadNativeSecondaryTrack?: (track: { id: string; url: string; lang: string }) => Promise<void>;
}

export interface InterpretSessionController {
  applyMode(intent: InterpretModeIntent): Promise<boolean>;
  getSnapshot(): InterpretSessionSnapshot;
  refreshAvailability(): Promise<InterpretAvailability>;
  flush(): Promise<void>;
  dispose(): void;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  getState(): InterpretSessionState;
}

export const CHUNK_DURATION_SEC = TRANSLATION_CHUNK_SEC;
export { PAUSE_TIMEOUT_MS };

export function createInterpretSessionController(
  input: InterpretSessionControllerPorts | LegacyInterpretSessionControllerDeps = {}
): InterpretSessionController {
  const legacy = input as LegacyInterpretSessionControllerDeps;
  const ports = input as InterpretSessionControllerPorts;
  const getVideoElement = ports.video?.getElement ?? legacy.getVideoElement ?? getRuntimeVideoElement;
  const overlay = ports.overlay;
  const setSubtitle: (original: string, translation: string, expectedGeneration?: number) => void =
    overlay?.setSubtitle ??
    (legacy.setSubtitle ? (orig, trans) => legacy.setSubtitle!(orig, trans) : () => {});
  const clearSubtitles = overlay?.clear ?? legacy.clearSubtitles ?? (() => {});
  const clearSubtitlesOnSeek = overlay?.clearForSeek ?? clearSubtitles;
  const showNotice = overlay?.showNotice ?? (() => {});
  const syncAppearance = overlay?.syncAppearance ?? (() => {});

  const loadCache = ports.storage?.loadCache ?? loadSubtitleFromCache;
  const saveCache = ports.storage?.saveCache ?? saveSubtitleToCache;
  const clearTranslatedCache = ports.storage?.clearTranslatedCache ?? clearTranslatedSubtitleCache;
  const saveSettings =
    ports.storage?.saveSettings ??
    ((patch: Record<string, unknown>) =>
      sendRuntimeMessage({ type: "save-settings", settings: patch }).catch(() => null));
  const hasCustomLoadCache = Boolean(ports.storage?.loadCache);
  const hasCustomSaveCache = Boolean(ports.storage?.saveCache);

  const customRunAsr = ports.media?.runAsr ?? legacy.runAsr;
  const customTranslateTrack = ports.media?.translateTrack ?? legacy.translateTrack;
  const resolveTranslateProvider =
    ports.media?.resolveTranslateProvider ??
    legacy.resolveTranslateProvider ??
    resolveSubtitleTranslateProvider;
  const loadAsrProviders = ports.media?.loadAsrProviders ?? legacy.loadAsrProviders;
  const loadNativePrimaryTrack =
    ports.media?.loadNativePrimaryTrack ??
    legacy.loadNativePrimaryTrack ??
    (async (target) => {
      const chain = await ensureSummarizeChain();
      await chain.loadSubtitle(target.url, target.lang, clipState.fetchRunId, target.id);
    });
  const loadNativeSecondaryTrack =
    ports.media?.loadNativeSecondaryTrack ??
    legacy.loadNativeSecondaryTrack ??
    (async (target) => {
      const chain = await ensureSummarizeChain();
      await chain.loadSecondarySubtitle(target.url, target.lang, clipState.fetchRunId, target.id);
    });
  const externalAiRefineMode = legacy.getAiRefineMode;

  let stateVal: InterpretSessionState = "idle";
  let generation = 0;
  let aiRefineMode: InterpretAiRefineMode = "off";
  let aiRefineVideoKey = "";
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
  let primaryCacheKey = "";
  let activeSessionKind: "asr" | "native-pair" | "cc-translate" = "asr";
  let activeAsrLabel = buildAsrSubtitleLabel(undefined);
  let activeProviderRes: SubtitleTranslateProviderResolution | undefined;
  let activeL1Index: L1VideoIndexCacheRecord | null = null;
  let lastTranslatingNoticeAt = -Infinity;
  let needsTranslatedCacheInvalidation = false;
  let lastOverlayOriginal: string | null = null;
  let lastOverlayTranslation: string | null = null;

  function currentVideoKey(): string {
    return `${state.clip.bvid}|${state.clip.cid}`;
  }

  function getAiRefineMode(): InterpretAiRefineMode {
    if (externalAiRefineMode) {
      return externalAiRefineMode();
    }
    const key = currentVideoKey();
    if (aiRefineVideoKey !== key) {
      aiRefineVideoKey = key;
      aiRefineMode = "off";
    }
    return aiRefineMode;
  }

  function setAiRefineMode(mode: InterpretAiRefineMode): void {
    aiRefineVideoKey = currentVideoKey();
    aiRefineMode = mode;
  }

  function currentNativeTracks() {
    return (state.clip.subtitles || []).filter((track) => isLoadableNativeTrack(track));
  }

  function resolveCurrentSourceLan(): string {
    const tracks = state.clip.subtitles || [];
    const current =
      findTrackByRef(tracks, {
        id: state.clip.selectedSubtitleId,
        url: state.clip.selectedSubtitleUrl
      }) ??
      tracks[0] ??
      null;
    if (!current) {
      return "";
    }
    if (classifySubtitleTrack(current) === "asr") {
      const asrLang = String(state.settings?.asrLanguage || "auto").trim().toLowerCase();
      return asrLang === "zh" || asrLang === "en" ? `asr-${asrLang}` : "";
    }
    return String(current.lan || "");
  }

  function resolveCurrentTargetLang(): LiveInterpretTargetLang {
    const configured = String(state.settings?.liveInterpretTargetLang || "zh");
    const sourceLan = resolveCurrentSourceLan();
    return (sourceLan ? resolveTargetLang(sourceLan, configured) : configured) as LiveInterpretTargetLang;
  }

  function getSnapshot(): InterpretSessionSnapshot {
    const nativeTracks = currentNativeTracks();
    return {
      state: stateVal,
      availability,
      aiRefineMode: getAiRefineMode(),
      generation,
      sourceLan: resolveCurrentSourceLan(),
      targetLang: resolveCurrentTargetLang(),
      displayMode: (state.settings?.liveInterpretDisplayMode || "auto") as InterpretSubtitleDisplayMode,
      nativePairAvailable: canUseNativeBilingualPair(nativeTracks, state.clip.site),
      foreignRefineAvailable: Boolean(findManualForeignTrackForAiRefine(nativeTracks)),
      hasNativeTracks: nativeTracks.length > 0,
      versions: {
        acquisitionVersion: sessionAcquisitionVersion,
        processingVersion: sessionProcessingVersion
      }
    };
  }

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
    overlay?.onStateChange?.(getSnapshot());
  }

  function updateAvailability(next: InterpretAvailability): InterpretAvailability {
    availability = next;
    overlay?.onAvailabilityChange?.(next);
    return availability;
  }

  function isZeroTokenNativePairScenario(): boolean {
    const nativeTracks = currentNativeTracks();
    return canUseNativeBilingualPair(nativeTracks, state.clip.site) && getAiRefineMode() === "off";
  }

  function hasPrimaryReadyInMemoryOrCache(): boolean {
    if (currentNativeTracks().length > 0) {
      return true;
    }
    if (
      state.clip.subtitleFetchState === "ready" &&
      Array.isArray(state.clip.subtitleBody) &&
      state.clip.subtitleBody.length > 0
    ) {
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
          error:
            (aiError as Error)?.message || "未配置字幕翻译 AI 平台，请先在设置中配置并填写 API Key"
        });
      }

      if (!hasPrimaryReadyInMemoryOrCache()) {
        if (!getSiteCapabilities(state.clip.site).supportsAsr) {
          return updateAvailability({
            ok: false,
            error: "当前视频暂无可用字幕"
          });
        }
        const { activeProvider: activeAsr, setupState } = await resolveActiveAsrRuntimeState({
          loadProviders: loadAsrProviders
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

  function emitSubtitleIfChanged(original: string, translation: string, expectedGeneration = generation): void {
    if (lastOverlayOriginal === original && lastOverlayTranslation === translation) {
      return;
    }
    lastOverlayOriginal = original;
    lastOverlayTranslation = translation;
    setSubtitle(original, translation, expectedGeneration);
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
    setSubtitle("", "", generation);
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
    const activePrimary =
      primaryIdx >= 0 && primaryIdx < primaryBody.length ? primaryBody[primaryIdx] : null;
    const originalText = activePrimary ? String(activePrimary.content || "").trim() : "";

    let translationText = "";
    if (activeSessionKind === "native-pair") {
      const secondaryBody = Array.isArray(state.clip.secondarySubtitle?.body)
        ? state.clip.secondarySubtitle.body
        : [];
      const secondaryIdx = findActiveSubtitleIndexInItems(secondaryBody, currentTime);
      translationText =
        secondaryIdx >= 0 && secondaryIdx < secondaryBody.length
          ? String(secondaryBody[secondaryIdx]?.content || "").trim()
          : "";
    } else if (activeTrackSession) {
      translationText = activeTrackSession.querySecondaryLine(
        currentTime,
        activePrimary ? { from: activePrimary.from, to: activePrimary.to } : null
      );
    }

    if (originalText || translationText) {
      emitSubtitleIfChanged(originalText, translationText, expectedGeneration);
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
    emitSubtitleIfChanged("", "", expectedGeneration);
  }

  function seedAsrPseudoTrackIfNeeded(label = activeAsrLabel): void {
    const existing = state.clip.subtitles || [];
    if (!existing.some((t) => isAsrSubtitleTrack(t))) {
      clipState.setSubtitles(upsertAsrPseudoTrack(existing, { ...createAsrPseudoTrack(label) }));
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
    source: TranslatedTrackSourceSpec;
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
        source: params.source,
        isStale: () =>
          isSessionStale(currentGeneration) ||
          stateVal === "idle" ||
          processingAbortController?.signal.aborted === true ||
          state.clip.bvid !== bvid ||
          state.clip.cid !== cid
      },
      {
        ...(customTranslateTrack ? { translateTrack: customTranslateTrack } : {}),
        ...(hasCustomLoadCache ? { loadCustomCache: loadCache } : {}),
        ...(hasCustomSaveCache ? { saveCustomCache: saveCache } : {}),
        onStreamingUpdate: ({ cue }) => {
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
        onAfterPersistChunk: ({ chunkIndex, updatedRange }) => {
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

  function buildLoadTranslator(protocolItems?: readonly SubtitleBodyItem[]) {
    if (customTranslateTrack) {
      return undefined;
    }
    return async () => {
      const translateMod = await subtitleTranslateLoader.load();
      return {
        resolveProtocolMode:
          typeof translateMod.resolveSubtitleTranslateProtocolMode === "function"
            ? translateMod.resolveSubtitleTranslateProtocolMode
            : undefined,
        translateTrack: translateMod.translateSubtitleTrack,
        protocolItems
      };
    };
  }

  async function translateChunk(chunkIndex: number, currentGeneration: number): Promise<void> {
    const session = activeTrackSession;
    if (!session || isSessionStale(currentGeneration) || session.isChunkDone(chunkIndex)) {
      return;
    }

    const taskPromise = (async () => {
      try {
        await session.translateChunk({
          chunkIndex,
          chunkFromSec: chunkIndex * CHUNK_DURATION_SEC,
          chunkToSec: (chunkIndex + 1) * CHUNK_DURATION_SEC,
          l1Index: activeL1Index,
          providerResolution: activeProviderRes,
          signal: processingAbortController?.signal
        });
      } catch (err) {
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
        void stopInternal();
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
    activeChunkPromises.clear();
    isAsrDoneChunk.clear();
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
    overlay?.setSessionGeneration?.(generation);
    abortSessionControllers(scope);
    unbindVideoLifecycle();
    clearSubtitles();
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
    setSubtitle("", "", generation);
    resetBuffers();
    updateState("idle");
  }

  async function stopInternal(): Promise<void> {
    const flushPromise = flush();
    abortAndResetSynchronously("both");
    await flushPromise;
  }

  async function startInternal(): Promise<boolean> {
    if (stateVal === "connecting" || stateVal === "connected") return true;

    sessionAcquisitionVersion = clipState.acquisitionVersion;
    sessionProcessingVersion = clipState.processingVersion;
    generation += 1;
    const currentGeneration = generation;
    overlay?.setSessionGeneration?.(currentGeneration);
    initSessionAbortControllers();
    updateState("connecting");

    try {
      const avail = await refreshAvailability();
      if (isSessionStale(currentGeneration)) return false;
      if (!avail.ok) {
        showNotice(avail.error, 6000);
        await stopInternal();
        return false;
      }

      activeClipSignature = computeCurrentClipSignature();
      const bvid = state.clip.bvid;
      const cid = state.clip.cid;
      activeBvid = bvid;
      activeCid = cid;

      const nativeTracks = currentNativeTracks();
      const refineMode = getAiRefineMode();

      if (canUseNativeBilingualPair(nativeTracks, state.clip.site) && refineMode === "off") {
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
        const pick = String(
          state.settings?.secondarySubtitleLang || DEFAULT_SETTINGS.secondarySubtitleLang
        ).trim();
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
          : resolveTargetLang(sourceTrackLan, resolveCurrentTargetLang());
        primaryCacheKey = "";

        activeProviderRes = await resolveTranslateProvider();
        if (isSessionStale(currentGeneration)) return false;

        const primaryItems = [...(state.clip.subtitleBody || [])];
        markPrimaryChunksReadyInAsr(primaryItems);
        const session = createControllerTrackSession({
          currentGeneration,
          bvid,
          cid,
          source: resolveTranslatedTrackSource(
            {
              track: sourceTrack,
              selectedSubtitleId: sourceTrackId,
              selectedSubtitleUrl: state.clip.selectedSubtitleUrl || sourceTarget.url,
              selectedSubtitleLang: sourceTrackLang
            },
            targetLang
          ),
          primaryItems
        });
        activeTrackSession = session;

        activeL1Index = await readCachedL1VideoIndex(state.clip);
        if (isSessionStale(currentGeneration)) return false;

        const hydrated = await session.hydrate({
          mode: "translate",
          loadTranslator: buildLoadTranslator(primaryItems),
          acceptOnHit: true,
          protocolItems: primaryItems
        });
        if (hydrated.status === "aborted" || isSessionStale(currentGeneration)) return false;
        if (hydrated.secondaryItems.length === 0) {
          clipState.clearSecondarySubtitle();
        }

        startScheduledTranslation(currentGeneration, session);
        return true;
      }

      if (!getSiteCapabilities(state.clip.site).supportsAsr) {
        showNotice("当前视频暂无可用字幕", 5000);
        await stopInternal();
        return false;
      }

      activeSessionKind = "asr";
      const targetLang = resolveCurrentTargetLang();

      const { activeId, activeProvider: activeAsr, asrLanguage } = await resolveActiveAsrRuntimeState({
        loadProviders: loadAsrProviders
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

      const probeItems = [{ from: 0, to: 1, content: "probe" }];
      const session = createControllerTrackSession({
        currentGeneration,
        bvid,
        cid,
        source: resolveTranslatedTrackSource({ isAsrSource: true }, targetLang),
        primaryItems: primaryItems ?? undefined,
        protocolProbeItems: probeItems
      });
      activeTrackSession = session;

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

        const hydrated = await session.hydrate({
          mode: "translate",
          loadTranslator: buildLoadTranslator(primaryItems),
          acceptOnHit: true,
          protocolItems: primaryItems
        });
        if (hydrated.status === "aborted" || isSessionStale(currentGeneration)) return false;

        startScheduledTranslation(currentGeneration, session);
        return true;
      }

      const activeFallback = await loadActiveAsrFallback().catch(() => null);
      if (isSessionStale(currentGeneration)) return false;
      if (activeFallback?.hasActiveAsrTranscribe({ bvid, cid })) {
        showNotice("后台语音识别正在进行中，请稍候完成后再试", 4000);
        await stopInternal();
        return false;
      }

      const runAsr = customRunAsr ?? (await asrPipelineLoader.load()).runAsrPipeline;
      if (isSessionStale(currentGeneration)) return false;
      const hydrated = await session.hydrate({
        mode: "translate",
        loadTranslator: buildLoadTranslator(probeItems),
        acceptOnHit: false,
        protocolItems: probeItems
      });
      if (hydrated.status === "aborted" || isSessionStale(currentGeneration)) return false;

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
          void stopInternal();
        }
      });

      return true;
    } catch (err) {
      if (!isSessionStale(currentGeneration)) {
        showNotice((err as Error)?.message || String(err), 6000);
        await stopInternal();
      }
      return false;
    }
  }

  async function applyMode(intent: InterpretModeIntent): Promise<boolean> {
    if (intent === "off") {
      setAiRefineMode("off");
      await stopInternal();
      return true;
    }

    if (intent === "native-bilingual") {
      setAiRefineMode("off");
      const patch = { liveInterpretDisplayMode: "bilingual" as const };
      state.patchSettings(patch);
      void Promise.resolve(saveSettings(patch)).catch(() => null);
      if (stateVal !== "idle") {
        await stopInternal();
      }
      return startInternal();
    }

    if (intent.kind === "ai-refine") {
      setAiRefineMode(intent.refineMode);
      const sourceLan =
        intent.refineMode === "foreign-refine"
          ? (findManualForeignTrackForAiRefine(state.clip.subtitles)?.lan ?? resolveCurrentSourceLan())
          : resolveCurrentSourceLan();
      const resolvedLang =
        intent.refineMode === "foreign-refine"
          ? "zh"
          : resolveTargetLang(sourceLan, state.settings?.liveInterpretTargetLang || "zh");
      const patch = {
        liveInterpretTargetLang: resolvedLang as LiveInterpretTargetLang,
        liveInterpretDisplayMode: "bilingual" as const
      };
      state.patchSettings(patch);
      void Promise.resolve(saveSettings(patch)).catch(() => null);
      if (stateVal !== "idle") {
        await stopInternal();
      }
      return startInternal();
    }

    const resolvedLang = resolveTargetLang(
      resolveCurrentSourceLan(),
      intent.targetLang
    ) as LiveInterpretTargetLang;
    const prevLang = String(state.settings?.liveInterpretTargetLang || "zh");
    const langChanged = resolvedLang !== prevLang;
    const patch = {
      liveInterpretTargetLang: resolvedLang,
      liveInterpretDisplayMode: intent.displayMode
    };
    state.patchSettings(patch);
    void Promise.resolve(saveSettings(patch)).catch(() => null);

    if (stateVal === "idle") {
      return startInternal();
    }
    if (langChanged) {
      await stopInternal();
      return startInternal();
    }
    syncAppearance();
    return true;
  }

  function handleUrlChange(): void {
    const clipChanged =
      computeCurrentClipSignature() !== activeClipSignature ||
      state.clip.bvid !== activeBvid ||
      state.clip.cid !== activeCid;
    if (clipChanged) {
      setAiRefineMode("off");
    }
    if ((stateVal === "connecting" || stateVal === "connected") && clipChanged) {
      void stopInternal();
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
      if (snapshot.reason !== "processing-switch") {
        setAiRefineMode("off");
      }
      if (stateVal === "connecting" || stateVal === "connected") {
        abortAndResetSynchronously(snapshot.reason === "processing-switch" ? "processing" : "both");
      } else {
        abortSessionControllers(snapshot.reason === "processing-switch" ? "processing" : "both");
        clearSubtitles();
        lastOverlayOriginal = null;
        lastOverlayTranslation = null;
        setSubtitle("", "", generation);
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

  function dispose(): void {
    unregisterBoundaryHooks();
    lifecycleScope.dispose();
    setAiRefineMode("off");
    void stopInternal();
  }

  return {
    applyMode,
    getSnapshot,
    refreshAvailability,
    flush,
    dispose,
    start: startInternal,
    stop: stopInternal,
    getState: () => stateVal
  };
}
