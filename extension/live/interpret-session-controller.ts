import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../core/url-watcher.js";
import { state, clipState } from "../core/state.js";
import type { SubtitleBodyItem } from "../core/state.js";
import { findActiveSubtitleIndex } from "../subtitle/core.js";
import { acceptSubtitle, acceptSecondarySubtitle } from "../subtitle/commit.js";
import {
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "../subtitle/cache.js";
import { buildSecondaryAlignment } from "../subtitle/alignment.js";
import {
  resolveInterpretSubtitleLines,
  type InterpretSubtitleDisplayMode
} from "./interpret-subtitle-lines.js";
import { runAsrPipeline, type RunAsrPipelineArgs } from "../asr/pipeline.js";
import { asrProviderStore } from "../asr/asr-provider-store.js";
import { resolveActiveAsrProviderId } from "../asr/asr-provider-normalize.js";
import {
  resolveSubtitleTranslateProvider,
  translateSubtitleItems,
  type SubtitleTranslateProviderResolution
} from "../ai/subtitle-translate.js";
import { notifyReaderPresenter } from "../reader/reader-bus.js";

export type InterpretSessionState = "idle" | "connecting" | "connected";
export type InterpretAvailability = { ok: true } | { ok: false; error: string };

export const CHUNK_DURATION_SEC = 60;
export const SLIDING_WINDOW_SIZE = 3;
export const PAUSE_TIMEOUT_MS = 300_000;

export interface InterpretSessionControllerDeps {
  getVideoElement?: () => HTMLVideoElement | null;
  getTargetLang?: () => string;
  getDisplayMode?: () => InterpretSubtitleDisplayMode;
  showNotice?: (message: string, autoHideMs?: number) => void;
  setSubtitle?: (original: string, translation: string) => void;
  onTranscript?: (event: any) => void;
  clearSubtitles?: () => void;
  clearSubtitlesOnSeek?: () => void;
  onStateChange?: (state: InterpretSessionState) => void;
  onAvailabilityChange?: (availability: InterpretAvailability) => void;
  runAsr?: (args: RunAsrPipelineArgs) => Promise<unknown>;
  translateItems?: typeof translateSubtitleItems;
  loadCache?: typeof loadSubtitleFromCache;
  saveCache?: typeof saveSubtitleToCache;
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
  const resolveTranslateProvider = deps.resolveTranslateProvider ?? resolveSubtitleTranslateProvider;
  const loadAsrProviders = deps.loadAsrProviders ?? (() => asrProviderStore.loadProviders());

  let stateVal: InterpretSessionState = "idle";
  let generation = 0;
  let activeClipSignature = "";
  let activeBvid = "";
  let activeCid = "";
  let pauseTimer: ReturnType<typeof setTimeout> | null = null;
  let boundVideo: HTMLVideoElement | null = null;
  let availability: InterpretAvailability = { ok: false, error: "正在检查平台配置..." };
  let availabilityGeneration = 0;
  let abortController: AbortController | null = null;

  // 滑动窗口分片状态跟踪
  const chunkPrimaryItems = new Map<number, SubtitleBodyItem[]>();
  const chunkSecondaryItems = new Map<number, SubtitleBodyItem[]>();
  const isTranslatingChunk = new Set<number>();
  const isTranslateDoneChunk = new Set<number>();
  const isAsrDoneChunk = new Set<number>();
  let secondaryAlignmentCache: ReturnType<typeof buildSecondaryAlignment> | null = null;
  let primaryCacheKey = "";
  let secondaryCacheKey = "";
  let activeTargetLang = "zh";
  let activeProviderRes: SubtitleTranslateProviderResolution | undefined;

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

  function clearPauseTimer(): void {
    if (pauseTimer !== null) clearTimeout(pauseTimer);
    pauseTimer = null;
  }

  function handlePause(): void {
    clearPauseTimer();
    if (!boundVideo?.paused || stateVal !== "connected") return;
    const pausedGeneration = generation;
    pauseTimer = setTimeout(() => {
      pauseTimer = null;
      if (pausedGeneration !== generation || !boundVideo?.paused) return;
      void stop();
      showNotice("视频暂停超过 5 分钟，实时翻译已自动关闭", 6000);
    }, PAUSE_TIMEOUT_MS);
  }

  function handlePlay(): void {
    clearPauseTimer();
  }

  function handleSeek(): void {
    clearSubtitlesOnSeek();
    setSubtitle("", "");
    const video = boundVideo || getVideoElement();
    if (!video) return;
    const currentTime = video.currentTime;
    const currentChunkIndex = Math.floor(currentTime / CHUNK_DURATION_SEC);
    if (isTranslateDoneChunk.has(currentChunkIndex)) {
      syncCurrentSubtitles(currentTime);
    } else {
      showNotice("正在转写并翻译字幕...", 2000);
    }
    ensureWindowChunks(currentChunkIndex);
  }

  function handleTimeUpdate(): void {
    const video = boundVideo || getVideoElement();
    if (!video) return;
    const currentTime = video.currentTime;
    syncCurrentSubtitles(currentTime);
    const currentChunkIndex = Math.floor(currentTime / CHUNK_DURATION_SEC);
    ensureWindowChunks(currentChunkIndex);
  }

  function unbindVideoLifecycle(): void {
    clearPauseTimer();
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

  function syncCurrentSubtitles(currentTime: number): void {
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
      setSubtitle(originalText, translationText);
      return;
    }

    const currentChunk = Math.floor(currentTime / CHUNK_DURATION_SEC);
    if (isTranslatingChunk.has(currentChunk) || (!isAsrDoneChunk.has(currentChunk) && !isTranslateDoneChunk.has(currentChunk))) {
      // 正在处理中显示轻量状态
      showNotice("正在转写并翻译字幕...", 2000);
    }
    setSubtitle("", "");
  }

  function seedAsrPseudoTrackIfNeeded(label = "语音识别"): void {
    const existing = state.clip.subtitles || [];
    if (!existing.some((t) => t.id === "asr")) {
      clipState.setSubtitles([
        { id: "asr", lan: "asr-zh", lanDoc: label, subtitleUrl: "" },
        ...existing
      ]);
    }
  }

  async function mergeAndPersistProgress(): Promise<void> {
    const sortedPrimary = Array.from(chunkPrimaryItems.entries())
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items)
      .sort((a, b) => a.from - b.from);

    const sortedSecondary = Array.from(chunkSecondaryItems.entries())
      .sort(([a], [b]) => a - b)
      .flatMap(([, items]) => items)
      .sort((a, b) => a.from - b.from);

    if (sortedPrimary.length > 0) {
      seedAsrPseudoTrackIfNeeded();
      await acceptSubtitle({
        body: sortedPrimary,
        selectedSubtitleId: "asr",
        selectedSubtitleUrl: "",
        selectedSubtitleLang: "asr-zh",
        skipHotComments: true
      });
      if (primaryCacheKey) {
        await saveCache(primaryCacheKey, sortedPrimary);
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
    if (video) {
      syncCurrentSubtitles(video.currentTime);
    }
  }

  async function translateChunk(chunkIndex: number, currentGeneration: number): Promise<void> {
    if (currentGeneration !== generation || isTranslatingChunk.has(chunkIndex) || isTranslateDoneChunk.has(chunkIndex)) {
      return;
    }
    const items = chunkPrimaryItems.get(chunkIndex) || [];
    if (items.length === 0) {
      isTranslateDoneChunk.add(chunkIndex);
      return;
    }

    isTranslatingChunk.add(chunkIndex);
    try {
      const translated = await translateItems({
        items,
        targetLang: activeTargetLang,
        providerResolution: activeProviderRes,
        signal: abortController?.signal
      });

      if (currentGeneration !== generation) return;

      chunkSecondaryItems.set(chunkIndex, translated);
      isTranslateDoneChunk.add(chunkIndex);
      await mergeAndPersistProgress();
    } catch (err) {
      // 中止或单片失败不崩溃整条流水
      if (currentGeneration !== generation || abortController?.signal.aborted) return;
    } finally {
      isTranslatingChunk.delete(chunkIndex);
    }
  }

  function ensureWindowChunks(currentChunkIndex: number): void {
    if (stateVal !== "connected") return;
    const currentGeneration = generation;
    const windowChunks: number[] = [];
    for (let i = 0; i < SLIDING_WINDOW_SIZE; i++) {
      windowChunks.push(currentChunkIndex + i);
    }

    for (const chunkIdx of windowChunks) {
      if (isTranslateDoneChunk.has(chunkIdx) || isTranslatingChunk.has(chunkIdx)) {
        continue;
      }
      if (chunkPrimaryItems.has(chunkIdx)) {
        void translateChunk(chunkIdx, currentGeneration);
      }
    }
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

  async function stop(): Promise<void> {
    generation += 1;
    abortController?.abort();
    abortController = null;
    unbindVideoLifecycle();
    clearSubtitles();
    setSubtitle("", "");
    chunkPrimaryItems.clear();
    chunkSecondaryItems.clear();
    isTranslatingChunk.clear();
    isTranslateDoneChunk.clear();
    isAsrDoneChunk.clear();
    secondaryAlignmentCache = null;
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
        seedAsrPseudoTrackIfNeeded(activeAsr?.name);
        await acceptSubtitle({
          body: primaryItems,
          selectedSubtitleId: "asr",
          selectedSubtitleUrl: "",
          selectedSubtitleLang: "asr-zh",
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
        if (video) syncCurrentSubtitles(video.currentTime);
        return true;
      }

      // 主轨已就绪仅缺译文：跳过 ASR，仅按播放游标滑动窗口调度 LLM 翻译
      if (primaryItems && primaryItems.length > 0) {
        partitionItemsIntoChunks(primaryItems);
        seedAsrPseudoTrackIfNeeded(activeAsr?.name);
        await acceptSubtitle({
          body: primaryItems,
          selectedSubtitleId: "asr",
          selectedSubtitleUrl: "",
          selectedSubtitleLang: "asr-zh",
          skipHotComments: true
        });
        updateState("connected");
        bindVideoLifecycle();
        const video = boundVideo || getVideoElement();
        const currentChunk = video ? Math.floor(video.currentTime / CHUNK_DURATION_SEC) : 0;
        ensureWindowChunks(currentChunk);
        if (video) syncCurrentSubtitles(video.currentTime);
        return true;
      }

      // 需要 ASR 转写：启动滑动窗口调度与 ASR 流水线
      updateState("connected");
      bindVideoLifecycle();
      showNotice("正在转写并翻译字幕...", 3000);

      const video = boundVideo || getVideoElement();
      const initialChunk = video ? Math.floor(video.currentTime / CHUNK_DURATION_SEC) : 0;

      void runAsr({
        bvid,
        cid,
        signal: abortController?.signal,
        onChunkResult: async (record, items) => {
          if (currentGeneration !== generation) return;
          const chunkIdx = record.index;
          chunkPrimaryItems.set(chunkIdx, items as SubtitleBodyItem[]);
          isAsrDoneChunk.add(chunkIdx);

          const currentVideo = boundVideo || getVideoElement();
          const currentChunk = currentVideo ? Math.floor(currentVideo.currentTime / CHUNK_DURATION_SEC) : initialChunk;
          if (chunkIdx >= currentChunk && chunkIdx <= currentChunk + SLIDING_WINDOW_SIZE) {
            await translateChunk(chunkIdx, currentGeneration);
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
