// extension/subtitle/asr-translation.ts
// 伪轨与单语原生轨的译文副轨批量生成器：分片计划、缓存覆盖判定、按播放游标优先调度与
// 零产出错误状态收敛；会话层（身份签名、分块缓存、跨块前情/L1 语境、流式合入与防抖落盘）
// 委托 subtitle/translated-track-session.ts 统一承载。
//
// 懒加载纪律（ADR-0025 / scripts/build-content.js）：
// 本模块禁止静态 import ai/subtitle-translate.ts，仅在 mode="translate" 且缓存未覆盖全片时
// 动态装载翻译协议栈并通过 deps 注入会话，确保 cache-only 路径零协议栈解析成本。

import { state, clipState } from "../core/state.js";
import type { SubtitleBodyItem } from "../ai/types.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { logWarn } from "../shared/logging.js";
import { createSubtitleChunkScheduler } from "./chunk-scheduler.js";
import { classifySubtitleTrack, findTrackByRef } from "./selection.js";
import {
  readCachedL1VideoIndex,
  resolveRuntimeSubtitleContext
} from "../ai/subtitle-context.js";
import {
  createTranslatedTrackSession,
  isUsableSubtitleItem,
  type ResolveTranslationProtocolFn,
  type TranslatedTrackPrimaryChunk
} from "./translated-track-session.js";

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

function readOptionalModuleExport<T>(mod: object, key: string): T | undefined {
  try {
    const candidate = (mod as Record<string, unknown>)[key];
    return typeof candidate === "function" ? (candidate as T) : undefined;
  } catch {
    return undefined;
  }
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
  const initialAcquisitionVersion = clipState.acquisitionVersion;
  const initialProcessingVersion = clipState.processingVersion;
  const body = (state.clip.subtitleBody || []) as SubtitleBodyItem[];
  const usableBody = body.filter(isUsableSubtitleItem);

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
  const bvid = state.clip.bvid;
  const cid = state.clip.cid;

  // 代次自检（写槽前）：视频身份/抓取代次/目标语言任一变了就整轮让位，不把旧视频或
  // 旧目标语言的译文写进新槽。
  const isStale = () =>
    args.signal?.aborted === true ||
    (runId !== undefined && runId !== clipState.fetchRunId) ||
    clipState.acquisitionVersion !== initialAcquisitionVersion ||
    clipState.processingVersion !== initialProcessingVersion ||
    state.clip.bvid !== bvid ||
    state.clip.cid !== cid ||
    String(state.clip.selectedSubtitleId || "").trim() !== selectedId ||
    String(state.clip.selectedSubtitleUrl || "").trim() !== selectedUrl ||
    args.isStale?.() === true;

  const session = createTranslatedTrackSession({
    bvid,
    cid,
    runId,
    primaryItems: usableBody,
    source: {
      isAsrSource,
      selectedSubtitleId: selectedId,
      selectedSubtitleUrl: selectedUrl,
      selectedSubtitleLang: selectedLang,
      trackLan: matchedTrack?.lan,
      targetLang
    },
    isStale
  });

  const chunks = session.getPrimaryChunks();
  if (chunks.length === 0) {
    return { kind: "done", total: 0, done: 0, failed: 0 };
  }

  const cached = await session.loadCached();
  if (cached.length > 0) {
    await session.seedSecondary(cached, { accept: false });
  }
  let pending = session.getPendingPrimaryChunks();
  const report = (done: number, failed: number) =>
    args.onProgress?.({ total: chunks.length, done, failed });

  // 缓存已覆盖全片：零请求挂载（不花钱的路径不需要用户动作）。
  if (pending.length === 0) {
    await session.acceptCurrentSecondary();
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

  const [translateModule, l1Index] = await Promise.all([
    import("../ai/subtitle-translate.js"),
    readCachedL1VideoIndex(state.clip)
  ]);
  const baseContext = await resolveRuntimeSubtitleContext({ l1Index });
  const resolveProviderFn = readOptionalModuleExport<
    () => Promise<{ model?: string } | null>
  >(translateModule, "resolveSubtitleTranslateProvider");
  const resolveProtocolFn = readOptionalModuleExport<ResolveTranslationProtocolFn>(
    translateModule,
    "resolveSubtitleTranslateProtocolMode"
  );
  const providerRes = resolveProviderFn
    ? await resolveProviderFn().catch(() => null)
    : null;

  const sigChanged = session.reconfigure({
    model: providerRes?.model,
    glossary: baseContext?.glossary ?? state.settings?.subtitleTranslateGlossary,
    resolveProtocolMode: resolveProtocolFn,
    translateItems: translateModule.translateSubtitleItems,
    protocolItems: body
  });
  if (sigChanged) {
    const exactCached = await session.loadCached();
    if (exactCached.length > 0) {
      await session.seedSecondary(exactCached, { accept: false });
      pending = session.getPendingPrimaryChunks();
    }
  }
  if (pending.length === 0) {
    if (isStale()) {
      return { kind: "aborted", total: chunks.length, done: 0, failed: 0 };
    }
    await session.acceptCurrentSecondary();
    report(chunks.length, 0);
    return { kind: "done", total: chunks.length, done: chunks.length, failed: 0 };
  }

  let done = chunks.length - pending.length;
  let failed = 0;
  report(done, failed);

  if (isStale()) {
    return { kind: "aborted", total: chunks.length, done, failed };
  }

  await session.acceptCurrentSecondary();

  const runtimeVideo = getRuntimeVideoElement();
  const scheduler = createSubtitleChunkScheduler<TranslatedTrackPrimaryChunk>({
    chunks: pending.map((chunk) => ({
      index: chunk.index,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
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
      const res = await session.translateChunk({
        chunkIndex: chunk.index,
        chunkFromSec: chunk.startSec,
        chunkToSec: chunk.endSec,
        items: chunk.items,
        l1Index,
        baseContext,
        signal: chunkSignal
      });
      if (res.status === "aborted") {
        scheduler.stop();
        return;
      }
      if (res.items.length > 0) {
        done += 1;
      }
      report(done, failed);
    },
    onChunkError: (scheduled, error) => {
      if (isStale()) {
        scheduler.stop();
        return;
      }
      failed += 1;
      logWarn("[BILISCRIPT] failed to translate subtitle chunk", {
        bvid,
        cid,
        targetLang,
        start: scheduled.payload?.startSec ?? scheduled.startSec,
        error
      });
      report(done, failed);
    }
  });

  scheduler.start();
  await scheduler.waitForIdle();
  await session.flush();

  if (isStale()) {
    return { kind: "aborted", total: chunks.length, done, failed };
  }

  // 零产出（全片无一条译文）才落失败态：副行出「译文加载失败」，重试入口在副列。
  // 部分产出保持 ready——缺片是可见的空白，不是整份失败。
  if (session.getSecondaryItems().length === 0) {
    markSecondaryTranslationFailed(session.slotId);
  }
  return { kind: "done", total: chunks.length, done, failed };
}
