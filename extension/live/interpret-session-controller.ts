import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { state, clipState } from "../core/state.js";
import type { SubtitleBodyItem } from "../core/state.js";
import { findActiveSubtitleIndex } from "../subtitle/core.js";
import { acceptSubtitle, acceptSecondarySubtitle } from "../subtitle/commit.js";
import {
  clearTranslatedSubtitleCache,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "../subtitle/cache.js";
import { buildSecondaryAlignment } from "../subtitle/alignment.js";
import type { InterpretSubtitleDisplayMode } from "./interpret-subtitle-preferences.js";
import { runAsrPipeline, type RunAsrPipelineArgs } from "../asr/pipeline.js";
import { loadActiveAsrFallback } from "../asr/active-fallback.js";
import { asrProviderStore } from "../asr/asr-provider-store.js";
import { resolveActiveAsrProviderId } from "../asr/asr-provider-normalize.js";
import { buildAsrSubtitleLabel } from "../subtitle/labels.js";
import {
  resolveSubtitleTranslateProvider,
  translateSubtitleItems
} from "../ai/subtitle-translate.js";
import type { SubtitleTranslateProviderResolution } from "../ai/subtitle-translate-config.js";
import {
  createSubtitleChunkScheduler,
  PAUSE_TIMEOUT_MS,
  type SubtitleChunkScheduler
} from "../subtitle/chunk-scheduler.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";

export type InterpretSessionState = "idle" | "connecting" | "connected";
export type InterpretAvailability = { ok: true } | { ok: false; error: string };

export const CHUNK_DURATION_SEC = 60;
export { PAUSE_TIMEOUT_MS };

export interface InterpretSessionControllerDeps {
  getVideoElement?: () => HTMLVideoElement | null;
  getTargetLang?: () => string;
  getDisplayMode?: () => InterpretSubtitleDisplayMode;
  showNotice?: (message: string, autoHideMs?: number) => void;
  setSubtitle?: (original: string, translation: string) => void;
  clearSubtitles?: () => void;
  clearSubtitlesOnSeek?: () => void;
  onStateChange?: (state: InterpretSessionState) => void;
  onAvailabilityChange?: (availability: InterpretAvailability) => void;
  runAsr?: (args: RunAsrPipelineArgs) => Promise<unknown>;
  translateItems?: typeof translateSubtitleItems;
  loadCache?: typeof loadSubtitleFromCache;
  saveCache?: typeof saveSubtitleToCache;
  clearTranslatedCache?: typeof clearTranslatedSubtitleCache;
  resolveTranslateProvider?: typeof resolveSubtitleTranslateProvider;
  loadAsrProviders?: () => Promise<any[]>;
}

export interface InterpretSessionController {
  getState(): InterpretSessionState;
  getAvailability(): InterpretAvailability;
  refreshAvailability(): Promise<InterpretAvailability>;
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
  const showNotice = deps.showNotice ?? (() => {});
  const setSubtitle = deps.setSubtitle ?? (() => {});
  const clearSubtitles = deps.clearSubtitles ?? (() => {});
  const clearSubtitlesOnSeek = deps.clearSubtitlesOnSeek ?? clearSubtitles;
  const runAsr = deps.runAsr ?? runAsrPipeline;
  const translateItems = deps.translateItems ?? translateSubtitleItems;
  const loadCache = deps.loadCache ?? loadSubtitleFromCache;
  const saveCache = deps.saveCache ?? saveSubtitleToCache;
  const clearTranslatedCache = deps.clearTranslatedCache ?? clearTranslatedSubtitleCache;
  const resolveTranslateProvider = deps.resolveTranslateProvider ?? resolveSubtitleTranslateProvider;
  const loadAsrProviders = deps.loadAsrProviders ?? (() => asrProviderStore.loadProviders());

  let stateVal: InterpretSessionState = "idle";
  let generation = 0;
  let activeClipSignature = "";
  let activeBvid = "";
  let activeCid = "";
  let boundVideo: HTMLVideoElement | null = null;
  let availability: InterpretAvailability = { ok: false, error: "正在检查平台配置..." };
  let availabilityGeneration = 0;
  let abortController: AbortController | null = null;
  let scheduler: SubtitleChunkScheduler<void> | null = null;

  // 播放游标优先调度分片状态跟踪
  const chunkPrimaryItems = new Map<number, SubtitleBodyItem[]>();
  const chunkPrimaryRevision = new Map<number, number>();
  const chunkSecondaryItems = new Map<number, SubtitleBodyItem[]>();
  const chunkStreamingCues = new Map<number, Map<string, SubtitleBodyItem>>();
  const activeChunkPromises = new Map<number, Promise<void>>();
  const isTranslateDoneChunk = new Set<number>();
  const isAsrDoneChunk = new Set<number>();
  let secondaryAlignmentCache: ReturnType<typeof buildSecondaryAlignment> | null = null;
  let primaryCacheKey = "";
  let secondaryCacheKey = "";
  let activeTargetLang = "zh";
  let activeAsrLabel = buildAsrSubtitleLabel(undefined);
  let activeProviderRes: SubtitleTranslateProviderResolution | undefined;
  let lastTranslatingNoticeAt = -Infinity;
  let needsTranslatedCacheInvalidation = false;
  let lastOverlayOriginal: string | null = null;
  let lastOverlayTranslation: string | null = null;

  function updateState(next: InterpretSessionState): void {
    stateVal = next;
    deps.onStateChange?.(next);
  }

  function updateAvailability(next: InterpretAvailability): InterpretAvailability {
    availability = next;
    deps.onAvailabilityChange?.(next);
    return availability;
  }

  function hasPrimaryReadyInMemoryOrCache(): boolean {
    if (state.clip.subtitleFetchState === "ready" && Array.isArray(state.clip.subtitleBody) && state.clip.subtitleBody.length > 0) {
      return true;
    }
    return false;
  }

  async function refreshAvailability(): Promise<InterpretAvailability> {
    const currentGeneration = ++availabilityGeneration;
    try {
      // 1. 检查字幕翻译 AI 平台（或默认 AI 平台）
      try {
        await resolveTranslateProvider();
      } catch (aiError) {
        if (currentGeneration !== availabilityGeneration) return availability;
        return updateAvailability({
          ok: false,
          error: (aiError as Error)?.message || "未配置字幕翻译 AI 平台，请先在设置中配置并填写 API Key"
        });
      }

      // 2. 检查语音识别 (ASR) 平台（若内存中已有主轨则可跳过 ASR 检查）
      if (!hasPrimaryReadyInMemoryOrCache()) {
        const [providers, settings] = await Promise.all([
          loadAsrProviders(),
          chrome.storage.sync.get(["activeAsrProviderId"])
        ]);
        const activeId = resolveActiveAsrProviderId(
          providers,
          typeof settings.activeAsrProviderId === "string" ? settings.activeAsrProviderId : undefined
        );
        const activeAsr = providers.find((p) => p.id === activeId);

        if (currentGeneration !== availabilityGeneration) return availability;
        if (!activeAsr || activeAsr.enabled === false) {
          return updateAvailability({
            ok: false,
            error: "未配置语音识别 (ASR) 平台，请先在设置中添加平台并填写 API Key"
          });
        }
        if (!activeAsr.hasSavedKey) {
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

  function computeItemsRange(items: readonly SubtitleBodyItem[]): { from: number; to: number } | undefined {
    let minFrom = Infinity;
    let maxTo = -Infinity;
    for (const item of items) {
      const from = Number(item.from);
      const to = Number(item.to);
      if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
        if (from < minFrom) minFrom = from;
        if (to > maxTo) maxTo = to;
      }
    }
    return Number.isFinite(minFrom) && Number.isFinite(maxTo) && maxTo > minFrom
      ? { from: minFrom, to: maxTo }
      : undefined;
  }

  function collectSortedSecondaryItems(): SubtitleBodyItem[] {
    return Array.from(chunkSecondaryItems.entries())
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items)
      .sort((a, b) => a.from - b.from);
  }

  function handleSeek(): void {
    clearSubtitlesOnSeek();
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
    setSubtitle("", "");
    const video = boundVideo || getVideoElement();
    if (!video) return;
    const currentTime = video.currentTime;
    const currentChunkIndex = Math.floor(currentTime / CHUNK_DURATION_SEC);
    if (isTranslateDoneChunk.has(currentChunkIndex)) {
      syncCurrentSubtitles(currentTime, generation);
    } else {
      showNotice("正在转写并翻译字幕...", 2000);
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
    if (expectedGeneration !== generation || stateVal !== "connected") {
      return;
    }
    const body = state.clip.subtitleBody;
    const activeIdx = findActiveSubtitleIndex(currentTime);
    if (activeIdx >= 0 && activeIdx < body.length) {
      const originalItem = body[activeIdx];
      const originalText = String(originalItem?.content || "").trim();
      let translationText = "";
      if (secondaryAlignmentCache) {
        translationText = secondaryAlignmentCache.query({
          from: originalItem.from,
          to: originalItem.to
        }) || "";
      }
      emitSubtitleIfChanged(originalText, translationText);
      return;
    }

    const currentChunk = Math.floor(currentTime / CHUNK_DURATION_SEC);
    if (!isAsrDoneChunk.has(currentChunk) && body.length === 0) {
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

  async function mergeAndPersistProgress(options: {
    currentGeneration: number;
    updatedRange?: { from: number; to: number };
    syncOverlay?: boolean;
  }): Promise<void> {
    if (options.currentGeneration !== generation || stateVal !== "connected") {
      return;
    }
    const sortedPrimary = Array.from(chunkPrimaryItems.entries())
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items)
      .sort((a, b) => a.from - b.from);

    const sortedSecondary = collectSortedSecondaryItems();

    if (sortedPrimary.length > 0) {
      seedAsrPseudoTrackIfNeeded(activeAsrLabel);
      await acceptSubtitle({
        body: sortedPrimary,
        selectedSubtitleId: "asr",
        selectedSubtitleUrl: "",
        selectedSubtitleLang: activeAsrLabel,
        skipHotComments: true
      });
      if (primaryCacheKey) {
        const saveResult = await saveCache(primaryCacheKey, sortedPrimary);
        if (saveResult?.ok !== false && needsTranslatedCacheInvalidation && activeBvid && activeCid) {
          needsTranslatedCacheInvalidation = false;
          await clearTranslatedCache({ bvid: activeBvid, cid: activeCid });
        }
      }
    }

    if (sortedSecondary.length > 0) {
      secondaryAlignmentCache = buildSecondaryAlignment(sortedSecondary);
      await acceptSecondarySubtitle({
        body: sortedSecondary,
        subtitleId: `translate-${activeTargetLang}`,
        subtitleUrl: ""
      });
      if (secondaryCacheKey) {
        await saveCache(secondaryCacheKey, sortedSecondary);
      }
    }

    notifyReaderPresenter({ kind: "rerender" });
    const video = boundVideo || getVideoElement();
    if (!video) {
      return;
    }
    const shouldSync =
      options.syncOverlay ??
      (!options.updatedRange ||
        doesRangeHitActivePlayback(options.updatedRange.from, options.updatedRange.to, video.currentTime));
    if (shouldSync) {
      syncCurrentSubtitles(video.currentTime, options.currentGeneration);
    }
  }

  async function translateChunk(chunkIndex: number, currentGeneration: number): Promise<void> {
    if (currentGeneration !== generation || isTranslateDoneChunk.has(chunkIndex)) {
      return;
    }
    const items = chunkPrimaryItems.get(chunkIndex) || [];
    if (items.length === 0) {
      isTranslateDoneChunk.add(chunkIndex);
      return;
    }

    const primaryRevisionAtStart = chunkPrimaryRevision.get(chunkIndex) ?? 0;
    const prevSecondary = chunkSecondaryItems.get(chunkIndex);
    const taskPromise = (async () => {
      try {
        const translated = await translateItems({
          items,
          targetLang: activeTargetLang,
          selectedSubtitleId: "asr",
          providerResolution: activeProviderRes,
          signal: abortController?.signal,
          fallbackToOriginal: false,
          onCueReady: (cue) => {
            if (
              currentGeneration !== generation ||
              stateVal !== "connected" ||
              abortController?.signal.aborted ||
              state.clip.bvid !== activeBvid ||
              state.clip.cid !== activeCid
            ) {
              return;
            }
            if ((chunkPrimaryRevision.get(chunkIndex) ?? 0) !== primaryRevisionAtStart) {
              return;
            }
            const translation = String(cue.translation ?? "").trim();
            if (!translation || !(cue.to > cue.from)) {
              return;
            }
            let cueMap = chunkStreamingCues.get(chunkIndex);
            if (!cueMap) {
              cueMap = new Map<string, SubtitleBodyItem>();
              chunkStreamingCues.set(chunkIndex, cueMap);
            }
            cueMap.set(`${cue.startIndex}:${cue.endIndex}`, {
              from: cue.from,
              to: cue.to,
              content: translation
            });
            chunkSecondaryItems.set(
              chunkIndex,
              Array.from(cueMap.values()).sort((a, b) => a.from - b.from)
            );
            const sortedSecondary = collectSortedSecondaryItems();
            if (sortedSecondary.length > 0) {
              secondaryAlignmentCache = buildSecondaryAlignment(sortedSecondary);
              void acceptSecondarySubtitle({
                body: sortedSecondary,
                subtitleId: `translate-${activeTargetLang}`,
                subtitleUrl: ""
              })
                .then(() => {
                  if (currentGeneration === generation && stateVal === "connected") {
                    notifyReaderPresenter({ kind: "rerender" });
                  }
                })
                .catch(() => {});
            }
            const video = boundVideo || getVideoElement();
            if (video && doesRangeHitActivePlayback(cue.from, cue.to, video.currentTime)) {
              syncCurrentSubtitles(video.currentTime, currentGeneration);
            }
          }
        });

        if (currentGeneration !== generation || abortController?.signal.aborted) {
          return;
        }

        chunkStreamingCues.delete(chunkIndex);
        chunkSecondaryItems.set(chunkIndex, translated);
        if ((chunkPrimaryRevision.get(chunkIndex) ?? 0) === primaryRevisionAtStart) {
          isTranslateDoneChunk.add(chunkIndex);
        }
        const range = computeItemsRange(translated.length > 0 ? translated : items);
        await mergeAndPersistProgress({
          currentGeneration,
          updatedRange: range,
          syncOverlay: range ? undefined : false
        });
      } catch (err) {
        chunkStreamingCues.delete(chunkIndex);
        if (prevSecondary !== undefined) {
          chunkSecondaryItems.set(chunkIndex, prevSecondary);
        } else {
          chunkSecondaryItems.delete(chunkIndex);
        }
        const sortedSecondary = collectSortedSecondaryItems();
        secondaryAlignmentCache =
          sortedSecondary.length > 0 ? buildSecondaryAlignment(sortedSecondary) : null;
        if (currentGeneration !== generation || abortController?.signal.aborted) {
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
      signal: abortController?.signal,
      runChunk: async (chunk) => {
        await translateChunk(chunk.index, currentGeneration);
      },
      onChunkError: () => {
        if (currentGeneration !== generation || abortController?.signal.aborted) {
          return;
        }
        showNotice("当前片段字幕翻译失败，将保留原文", 3000);
      },
      onPauseTimeout: () => {
        if (currentGeneration !== generation) {
          return;
        }
        void stop();
        showNotice("视频暂停超过 5 分钟，实时翻译已自动关闭", 6000);
      }
    });
  }

  function partitionItemsIntoChunks(items: SubtitleBodyItem[]): void {
    for (const item of items) {
      const from = Number(item.from) || 0;
      const chunkIdx = Math.floor(from / CHUNK_DURATION_SEC);
      const list = chunkPrimaryItems.get(chunkIdx) || [];
      list.push(item);
      chunkPrimaryItems.set(chunkIdx, list);
      isAsrDoneChunk.add(chunkIdx);
    }
  }

  function partitionSecondaryItemsIntoChunks(items: SubtitleBodyItem[]): void {
    for (const item of items) {
      const from = Number(item.from) || 0;
      const chunkIdx = Math.floor(from / CHUNK_DURATION_SEC);
      const list = chunkSecondaryItems.get(chunkIdx) || [];
      list.push(item);
      chunkSecondaryItems.set(chunkIdx, list);
      isTranslateDoneChunk.add(chunkIdx);
    }
  }

  function resetBuffers(): void {
    chunkPrimaryItems.clear();
    chunkPrimaryRevision.clear();
    chunkSecondaryItems.clear();
    chunkStreamingCues.clear();
    activeChunkPromises.clear();
    isTranslateDoneChunk.clear();
    isAsrDoneChunk.clear();
    secondaryAlignmentCache = null;
    lastTranslatingNoticeAt = -Infinity;
    needsTranslatedCacheInvalidation = false;
    activeAsrLabel = buildAsrSubtitleLabel(undefined);
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
  }

  async function stop(): Promise<void> {
    generation += 1;
    scheduler?.stop();
    scheduler = null;
    abortController?.abort();
    abortController = null;
    unbindVideoLifecycle();
    clearSubtitles();
    lastOverlayOriginal = null;
    lastOverlayTranslation = null;
    setSubtitle("", "");
    resetBuffers();
    updateState("idle");
  }

  async function start(): Promise<boolean> {
    if (stateVal === "connecting" || stateVal === "connected") return true;

    generation += 1;
    const currentGeneration = generation;
    abortController = new AbortController();
    updateState("connecting");

    try {
      const avail = await refreshAvailability();
      if (!avail.ok) {
        showNotice(avail.error, 6000);
        await stop();
        return false;
      }

      activeTargetLang = getTargetLang();
      activeClipSignature = computeCurrentClipSignature();
      const bvid = state.clip.bvid;
      const cid = state.clip.cid;
      activeBvid = bvid;
      activeCid = cid;

      const [providers, settings] = await Promise.all([
        loadAsrProviders(),
        chrome.storage.sync.get(["activeAsrProviderId", "asrLanguage"])
      ]);
      const activeId = resolveActiveAsrProviderId(
        providers,
        typeof settings.activeAsrProviderId === "string" ? settings.activeAsrProviderId : undefined
      );
      const activeAsr = providers.find((p) => p.id === activeId);
      activeAsrLabel = buildAsrSubtitleLabel(
        typeof settings.asrLanguage === "string" ? settings.asrLanguage : undefined
      );

      primaryCacheKey = getSubtitleCacheKey({
        bvid,
        cid,
        identity: {
          kind: "asr",
          providerId: activeId,
          model: activeAsr?.model,
          lang: settings.asrLanguage || "auto"
        }
      });
      secondaryCacheKey = getSubtitleCacheKey({
        bvid,
        cid,
        identity: {
          kind: "track",
          trackId: `translate-${activeTargetLang}`
        }
      });

      activeProviderRes = await resolveTranslateProvider();
      if (currentGeneration !== generation) return false;

      // 1. 检查主轨缓存（内存优先，次选本地 storage 缓存）
      let primaryItems: SubtitleBodyItem[] | null = null;
      if (state.clip.subtitleFetchState === "ready" && state.clip.subtitleBody?.length) {
        primaryItems = [...state.clip.subtitleBody];
      } else {
        const cached = await loadCache(primaryCacheKey);
        if (Array.isArray(cached) && cached.length > 0) {
          primaryItems = cached as SubtitleBodyItem[];
        }
      }

      // 2. 检查译文副轨缓存
      const cachedSecondary = await loadCache(secondaryCacheKey);
      const secondaryItems = Array.isArray(cachedSecondary) && cachedSecondary.length > 0
        ? (cachedSecondary as SubtitleBodyItem[])
        : null;

      // 全命中：零网络请求挂载并渲染
      if (primaryItems && primaryItems.length > 0 && secondaryItems && secondaryItems.length > 0) {
        partitionItemsIntoChunks(primaryItems);
        partitionSecondaryItemsIntoChunks(secondaryItems);
        secondaryAlignmentCache = buildSecondaryAlignment(secondaryItems);
        seedAsrPseudoTrackIfNeeded(activeAsrLabel);
        await acceptSubtitle({
          body: primaryItems,
          selectedSubtitleId: "asr",
          selectedSubtitleUrl: "",
          selectedSubtitleLang: activeAsrLabel,
          skipHotComments: true
        });
        await acceptSecondarySubtitle({
          body: secondaryItems,
          subtitleId: `translate-${activeTargetLang}`,
          subtitleUrl: ""
        });
        updateState("connected");
        bindVideoLifecycle();
        const video = boundVideo || getVideoElement();
        const initialTime = video?.currentTime ?? 0;
        const initialChunks = Array.from(chunkPrimaryItems.keys())
          .sort((a, b) => a - b)
          .map((idx) => ({
            index: idx,
            startSec: idx * CHUNK_DURATION_SEC,
            endSec: (idx + 1) * CHUNK_DURATION_SEC,
            status: "done" as const
          }));
        scheduler = createSessionScheduler(currentGeneration, initialTime, initialChunks);
        scheduler.start();
        if (boundVideo?.paused) {
          scheduler.notifyPause();
        }
        if (video) syncCurrentSubtitles(video.currentTime, currentGeneration);
        return true;
      }

      // 主轨已就绪仅缺译文：跳过 ASR，按 [currentTime, +90s] 优先队列调度 LLM 翻译
      if (primaryItems && primaryItems.length > 0) {
        partitionItemsIntoChunks(primaryItems);
        seedAsrPseudoTrackIfNeeded(activeAsrLabel);
        await acceptSubtitle({
          body: primaryItems,
          selectedSubtitleId: "asr",
          selectedSubtitleUrl: "",
          selectedSubtitleLang: activeAsrLabel,
          skipHotComments: true
        });
        updateState("connected");
        bindVideoLifecycle();
        const video = boundVideo || getVideoElement();
        const initialTime = video?.currentTime ?? 0;
        const initialChunks = Array.from(chunkPrimaryItems.keys())
          .sort((a, b) => a - b)
          .map((idx) => ({
            index: idx,
            startSec: idx * CHUNK_DURATION_SEC,
            endSec: (idx + 1) * CHUNK_DURATION_SEC,
            status: isTranslateDoneChunk.has(idx) ? ("done" as const) : ("pending" as const)
          }));
        scheduler = createSessionScheduler(currentGeneration, initialTime, initialChunks);
        scheduler.start();
        if (boundVideo?.paused) {
          scheduler.notifyPause();
        }
        if (video) syncCurrentSubtitles(video.currentTime, currentGeneration);
        return true;
      }

      const activeFallback = await loadActiveAsrFallback().catch(() => null);
      if (currentGeneration !== generation) return false;
      if (activeFallback?.hasActiveAsrTranscribe({ bvid, cid })) {
        showNotice("后台语音识别正在进行中，请稍候完成后再试", 4000);
        await stop();
        return false;
      }

      // 需要 ASR 转写：启动统一调度器与 ASR 流水线
      needsTranslatedCacheInvalidation = true;
      updateState("connected");
      bindVideoLifecycle();
      showNotice("正在转写并翻译字幕...", 3000);

      const video = boundVideo || getVideoElement();
      const initialTime = video?.currentTime ?? 0;
      scheduler = createSessionScheduler(currentGeneration, initialTime, []);
      scheduler.start();
      if (boundVideo?.paused) {
        scheduler.notifyPause();
      }

      void runAsr({
        bvid,
        cid,
        signal: abortController?.signal,
        onChunkResult: async (record, items, snapshot) => {
          if (currentGeneration !== generation) return;
          const chunkIdx = record.index;

          if (!snapshot) {
            chunkPrimaryItems.set(chunkIdx, items as SubtitleBodyItem[]);
            chunkPrimaryRevision.set(chunkIdx, (chunkPrimaryRevision.get(chunkIdx) ?? 0) + 1);
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
            chunkPrimaryItems.set(idx, nextItems);
            chunkPrimaryRevision.set(idx, (chunkPrimaryRevision.get(idx) ?? 0) + 1);
            isAsrDoneChunk.add(idx);
            if (idx !== chunkIdx) {
              isTranslateDoneChunk.delete(idx);
              chunkSecondaryItems.delete(idx);
              chunkStreamingCues.delete(idx);
              hasUnwindowedUpdate = true;
            }
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
            await mergeAndPersistProgress({ currentGeneration });
          }
        }
      }).catch((error) => {
        if (currentGeneration === generation && !abortController?.signal.aborted) {
          showNotice(`字幕生成失败：${(error as Error)?.message || String(error)}`, 6000);
          void stop();
        }
      });

      return true;
    } catch (err) {
      if (currentGeneration === generation) {
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

  async function toggle(): Promise<void> {
    if (stateVal === "connecting" || stateVal === "connected") {
      await stop();
    } else {
      await start();
    }
  }

  function dispose(): void {
    window.removeEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);
    void stop();
  }

  window.addEventListener(BILISCRIPT_URL_CHANGE_EVENT, handleUrlChange);

  return {
    getState: () => stateVal,
    getAvailability: () => availability,
    refreshAvailability,
    start,
    stop,
    toggle,
    dispose
  };
}
