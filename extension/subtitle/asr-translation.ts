// extension/subtitle/asr-translation.ts
// 伪轨（自配平台转写）的译文副轨批量生成器：分片计划、缓存覆盖判定、逐片翻译、
// 逐片合入副轨槽与整份落盘。
//
// 归属链层（不常驻）：翻译请求经 ai/subtitle-translate（动态 import，与 fetcher
// 的 asr 回退同款边）、副轨写入经 subtitle/commit 的接受事务、缓存键经
// subtitle/cache——三者同属总结链的 chunk。reader 侧只持有进度与在飞状态
// （reader/asr-translation.ts），装载入口经 subtitle/lazy 的 chain 暴露，故本模块
// 不被 reader 静态拖进主包。
//
// 领域口径（GLOSSARY「字幕」「双语」）：伪轨视频没有第二条真轨，译文**不是轨**，
// 只是副轨槽里的第二路正文。因此：
//   - 主轨 `clip.subtitles` / `selected*` / `subtitleFetchState` 一概不碰；
//   - 写入只走 acceptSecondarySubtitle（独立通知 kind，不复制主轨副作用）；
//   - 缓存键沿用浮层的 `id_translate-<目标语言>`（键形是已落盘缓存的兼容面，不改）。
//
// 分片口径：与播放器浮层同一条时间轴语义——按 `from` 落在 60 秒窗口内归片，通过
// `createSubtitleChunkScheduler` 优先调度当前播放游标 `[currentTime, +90s]` 窗口并
// 后台抖动退避补齐全片。已翻片命中缓存，只补未覆盖的分片。

import { state, clipState } from "../core/state.js";
import type { SubtitleBodyItem } from "../ai/types.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { logWarn } from "../shared/logging.js";
import { getSubtitleCacheKey, loadSubtitleFromCache, saveSubtitleToCache } from "./cache.js";
import { createSubtitleChunkScheduler } from "./chunk-scheduler.js";
import { acceptSecondarySubtitle } from "./commit.js";
import {
  classifySubtitleTrack,
  findTrackByRef,
  toCanonicalTargetLangBcp47
} from "./selection.js";
import {
  buildSubtitleSourceKey,
  trackTranslatedSlotId,
  translatedTrackId,
  type TrackIdentity
} from "./source-key.js";
import {
  extractPreviousBilingualLinesBeforeTime,
  resolveRuntimeSubtitleContext
} from "../ai/subtitle-context.js";

// 分片时长：与浮层 use 的时间轴一致（60 秒），但调度语义独立——本模块不 import
// live 域，避免把阅读面绑到播放器会话。
const TRANSLATION_CHUNK_SEC = 60;

export interface AsrTranslationProgress {
  // 有原文的分片总数
  total: number;
  // 已有译文的分片数（缓存命中 + 本轮新增）
  done: number;
  // 本轮失败的分片数
  failed: number;
}

export interface AsrTranslationArgs {
  // cache-only：只做缓存覆盖判定与挂载，绝不发请求（面板打开/字幕就绪时的自动路径；
  // 不花钱的路径不设门）。
  // translate：补齐未覆盖分片（用户显式动作 / 重试）。
  mode: "cache-only" | "translate";
  targetLang: string;
  // 发起方抓取代次：写槽前自检，代次已被推进则整轮让位（与两条接受事务同一道门）。
  runId?: number;
  signal?: AbortSignal | null;
  onProgress?: (progress: AsrTranslationProgress) => void;
  // 目标语言是否仍是发起时那一门（词表 normalize 归发起方所有）：改选语言后旧一轮
  // 不再写槽。
  isStale?: () => boolean;
}

export interface AsrTranslationResult {
  // done：本轮结束后全片有译文（缓存命中或刚翻完）；pending：cache-only 下仍有
  // 未覆盖分片（调用方据此出「开始生成译文」）；aborted：代次/信号中止。
  kind: "done" | "pending" | "aborted";
  total: number;
  done: number;
  failed: number;
}

interface TranslationChunk {
  // 窗口左闭右开（秒级）
  start: number;
  end: number;
  items: SubtitleBodyItem[];
}

function isUsableItem(item: unknown): item is SubtitleBodyItem {
  const candidate = item as SubtitleBodyItem | null;
  if (!candidate) {
    return false;
  }
  const from = Number(candidate.from);
  const to = Number(candidate.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
    return false;
  }
  return String(candidate.content ?? "").trim().length > 0;
}

function sortByFrom(items: SubtitleBodyItem[]): SubtitleBodyItem[] {
  return items.slice().sort((a, b) => Number(a.from) - Number(b.from));
}

// 分片计划：按 `from` 归窗，空内容条目先剔除（无原文可翻，不占分片）。
function planTranslationChunks(body: readonly SubtitleBodyItem[]): TranslationChunk[] {
  const byStart = new Map<number, SubtitleBodyItem[]>();
  for (const item of body) {
    if (!isUsableItem(item)) {
      continue;
    }
    const from = Number(item.from) || 0;
    const start = Math.floor(from / TRANSLATION_CHUNK_SEC) * TRANSLATION_CHUNK_SEC;
    const list = byStart.get(start);
    if (list) {
      list.push(item);
    } else {
      byStart.set(start, [item]);
    }
  }
  return [...byStart.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, items]) => ({ start, end: start + TRANSLATION_CHUNK_SEC, items: sortByFrom(items) }));
}

function loadTranslatedBody(cacheKey: string): Promise<SubtitleBodyItem[]> {
  return loadSubtitleFromCache(cacheKey).then((cached) => {
    if (!Array.isArray(cached)) {
      return [];
    }
    return sortByFrom(cached.filter(isUsableItem));
  });
}

// 槽「零产出」的写法：副轨槽没有「带身份直接置 error」的原语，先写 loading 再写
// error——两次同步写入同一拍，中间不渲染（不出现「译文加载中…」的闪烁占位）。
function markSecondaryTranslationFailed(trackId: string): void {
  clipState.markSecondarySubtitleLoading({ id: trackId, url: "" });
  clipState.markSecondarySubtitleError();
}

export async function ensureAsrSecondarySubtitle(
  args: AsrTranslationArgs
): Promise<AsrTranslationResult> {
  const targetLang = String(args.targetLang || "").trim();
  const runId = args.runId;
  const body = (state.clip.subtitleBody || []) as SubtitleBodyItem[];
  const chunks = planTranslationChunks(body);

  const selectedId = String(state.clip.selectedSubtitleId || "").trim();
  const selectedUrl = String(state.clip.selectedSubtitleUrl || "").trim();
  const selectedLang = String(state.clip.selectedSubtitleLang || "").trim();
  const matchedTrack = findTrackByRef(state.clip.subtitles, {
    id: selectedId,
    url: selectedUrl
  });
  const trackKind = classifySubtitleTrack(
    matchedTrack ?? { id: selectedId, lan: selectedLang, subtitleUrl: selectedUrl }
  );
  const isAsrSource = trackKind === "asr" || (!selectedUrl && (!selectedId || selectedId === "asr"));
  const sourceKey = isAsrSource
    ? "asr"
    : buildSubtitleSourceKey(selectedId, selectedUrl, selectedLang);
  const canonicalBcp47 = toCanonicalTargetLangBcp47(targetLang);
  const trackId = isAsrSource
    ? translatedTrackId(targetLang)
    : trackTranslatedSlotId(sourceKey, canonicalBcp47);
  const cacheIdentity: TrackIdentity = isAsrSource
    ? { kind: "translated", targetLang }
    : { kind: "track-translated", sourceKey, targetLang: canonicalBcp47 };

  const empty: AsrTranslationResult = { kind: "done", total: chunks.length, done: 0, failed: 0 };
  if (chunks.length === 0) {
    return empty;
  }

  const bvid = state.clip.bvid;
  const cid = state.clip.cid;
  const cacheKey = getSubtitleCacheKey({
    bvid,
    cid,
    identity: cacheIdentity
  });
  const cached = await loadTranslatedBody(cacheKey);

  // 覆盖判定：缓存条目落在某个分片窗口内即该片已有译文（与浮层同一条时间轴口径）。
  const covered = new Set<number>();
  for (const item of cached) {
    const start = Math.floor((Number(item.from) || 0) / TRANSLATION_CHUNK_SEC) * TRANSLATION_CHUNK_SEC;
    covered.add(start);
  }
  const pending = chunks.filter((chunk) => !covered.has(chunk.start));
  const report = (done: number, failed: number) =>
    args.onProgress?.({ total: chunks.length, done, failed });

  // 缓存已覆盖全片：零请求挂载（Q15：不花钱的路径不需要用户动作）。
  if (pending.length === 0) {
    if (cached.length > 0) {
      await acceptSecondarySubtitle({ body: cached, subtitleId: trackId, subtitleUrl: "", runId });
    }
    report(chunks.length, 0);
    return { kind: "done", total: chunks.length, done: chunks.length, failed: 0 };
  }

  if (args.mode === "cache-only") {
    report(chunks.length - pending.length, 0);
    return {
      kind: "pending",
      total: chunks.length,
      done: chunks.length - pending.length,
      failed: 0
    };
  }

  // 代次自检（写槽前）：视频身份/抓取代次/目标语言任一变了就整轮让位，不把旧视频或
  // 旧目标语言的译文写进新槽（改选语言时旧一轮可能正停在某个请求上）。目标语言的
  // 判据归发起方（读者侧持有词表归一），这里只问一句。
  const isStale = () =>
    args.signal?.aborted === true ||
    (runId !== undefined && runId !== clipState.fetchRunId) ||
    state.clip.bvid !== bvid ||
    state.clip.cid !== cid ||
    String(state.clip.selectedSubtitleId || "").trim() !== selectedId ||
    String(state.clip.selectedSubtitleUrl || "").trim() !== selectedUrl ||
    args.isStale?.() === true;

  const [{ translateSubtitleItems }, baseContext] = await Promise.all([
    import("../ai/subtitle-translate.js"),
    resolveRuntimeSubtitleContext()
  ]);
  let accumulated = cached;
  let done = chunks.length - pending.length;
  let failed = 0;
  report(done, failed);

  if (isStale()) {
    return { kind: "aborted", total: chunks.length, done, failed };
  }

  if (cached.length > 0) {
    await acceptSecondarySubtitle({ body: cached, subtitleId: trackId, subtitleUrl: "", runId });
  }

  const inFlightPartials = new Map<number, Map<string, SubtitleBodyItem>>();
  let persistQueue: Promise<void> = Promise.resolve();

  function buildMergedBody(): SubtitleBodyItem[] {
    const partialItems: SubtitleBodyItem[] = [];
    for (const cueMap of inFlightPartials.values()) {
      for (const item of cueMap.values()) {
        partialItems.push(item);
      }
    }
    return partialItems.length > 0
      ? sortByFrom([...accumulated, ...partialItems])
      : accumulated;
  }

  function enqueuePersist(
    displayBody: SubtitleBodyItem[],
    cacheBodyToSave?: SubtitleBodyItem[]
  ): Promise<void> {
    persistQueue = persistQueue.then(async () => {
      if (isStale()) {
        return;
      }
      await acceptSecondarySubtitle({
        body: displayBody,
        subtitleId: trackId,
        subtitleUrl: "",
        runId
      });
      if (cacheBodyToSave) {
        const saveResult = await saveSubtitleToCache(cacheKey, cacheBodyToSave);
        if (saveResult && saveResult.ok === false) {
          logWarn("[BILISCRIPT] failed to persist translated subtitle cache", {
            bvid,
            cid,
            targetLang
          });
        }
      }
    });
    return persistQueue;
  }

  const runtimeVideo = getRuntimeVideoElement();
  const scheduler = createSubtitleChunkScheduler<TranslationChunk>({
    chunks: pending.map((chunk) => ({
      index: Math.floor(chunk.start / TRANSLATION_CHUNK_SEC),
      startSec: chunk.start,
      endSec: chunk.end,
      payload: chunk
    })),
    video: runtimeVideo,
    getCurrentTimeSec: () => getRuntimeVideoElement()?.currentTime ?? 0,
    preloadWindowSec: 90,
    maxConcurrency: 2,
    firstScreenSolo: true,
    fillBackground: true,
    backgroundJitterRangeMs: [300, 600],
    maxRateLimitRetries: 2,
    rateLimitBaseDelayMs: 250,
    pauseTimeoutMs: 0,
    signal: args.signal,
    runChunk: async (scheduled, chunkSignal) => {
      const chunk = scheduled.payload;
      if (!chunk) {
        return;
      }
      if (isStale()) {
        scheduler.stop();
        return;
      }
      const chunkIndex = scheduled.index;
      const previousLines = extractPreviousBilingualLinesBeforeTime(
        body,
        accumulated,
        chunk.start,
        2
      );
      const translated = await translateSubtitleItems({
        items: chunk.items,
        targetLang,
        selectedSubtitleId: isAsrSource ? "asr" : selectedId,
        selectedSubtitleLang: isAsrSource ? undefined : selectedLang,
        trackLan: isAsrSource ? "asr-zh" : matchedTrack?.lan,
        fallbackToOriginal: false,
        ...(baseContext ? { context: baseContext } : {}),
        ...(previousLines.length > 0 ? { previousLines } : {}),
        signal: chunkSignal,
        onCueReady: (cue) => {
          if (isStale()) {
            scheduler.stop();
            return;
          }
          const text = String(cue.translation ?? "").trim();
          if (!text || !(cue.to > cue.from)) {
            return;
          }
          let cueMap = inFlightPartials.get(chunkIndex);
          if (!cueMap) {
            cueMap = new Map<string, SubtitleBodyItem>();
            inFlightPartials.set(chunkIndex, cueMap);
          }
          cueMap.set(`${cue.startIndex}:${cue.endIndex}`, {
            from: cue.from,
            to: cue.to,
            content: text
          });
          const previewBody = buildMergedBody();
          if (previewBody.length > 0) {
            void enqueuePersist(previewBody).catch(() => {});
          }
        }
      });

      inFlightPartials.delete(chunkIndex);
      if (isStale()) {
        scheduler.stop();
        return;
      }

      const usable = (Array.isArray(translated) ? translated : []).filter(isUsableItem);
      if (usable.length > 0) {
        accumulated = sortByFrom([
          ...accumulated.filter((item) => item.from < chunk.start || item.from >= chunk.end),
          ...usable
        ]);
        done += 1;
        const displayBody = buildMergedBody();
        const cacheSnapshot = accumulated;
        await enqueuePersist(displayBody, cacheSnapshot);
      }
      report(done, failed);
    },
    onChunkError: (scheduled, error) => {
      inFlightPartials.delete(scheduled.index);
      if (isStale()) {
        scheduler.stop();
        return;
      }
      failed += 1;
      logWarn("[BILISCRIPT] failed to translate subtitle chunk", {
        bvid,
        cid,
        targetLang,
        start: scheduled.payload?.start ?? scheduled.startSec,
        error
      });
      report(done, failed);
    }
  });

  scheduler.start();
  await scheduler.waitForIdle();
  await persistQueue.catch(() => {});

  if (isStale()) {
    return { kind: "aborted", total: chunks.length, done, failed };
  }

  // 零产出（全片无一条译文）才落失败态：副行出「译文加载失败」，重试入口在副列。
  // 部分产出保持 ready——缺片是可见的空白，不是整份失败（Q11）。
  if (accumulated.length === 0) {
    markSecondaryTranslationFailed(trackId);
  }
  return { kind: "done", total: chunks.length, done, failed };
}
