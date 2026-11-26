import { state, clipState } from "../core/state.js";
import type { SubtitleBodyItem } from "../ai/types.js";
import type { L1VideoIndexCacheRecord } from "../ai/long-video-hybrid-types.js";
import { getSiteRuntimeVideoElement } from "../core/site-video-probe.js";
import { logWarn } from "../shared/logging.js";
import { createSubtitleChunkScheduler } from "./chunk-scheduler.js";
import { slot } from "./slot.js";
import {
  readCachedL1VideoIndex,
  resolveRuntimeSubtitleContext,
  type SubtitleTranslatePromptContext
} from "../ai/subtitle-context.js";
import {
  createTranslatedTrackSession,
  isUsableSubtitleItem,
  resolveTranslatedTrackSource,
  type TranslatedTrackPrimaryChunk
} from "./translated-track-session.js";

export interface AsrTranslationProgress {
  total: number;
  done: number;
  failed: number;
}

export interface AsrTranslationArgs {
  mode: "cache-only" | "translate";
  targetLang: string;
  runId?: number;
  signal?: AbortSignal | null;
  onProgress?: (progress: AsrTranslationProgress) => void;
  isStale?: () => boolean;
}

export interface AsrTranslationResult {
  kind: "done" | "pending" | "aborted";
  total: number;
  done: number;
  failed: number;
}

function markSecondaryTranslationFailed(trackId: string): void {
  slot.markSecondaryError({ id: trackId, url: "" });
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
  const bvid = state.clip.bvid;
  const cid = state.clip.cid;

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
    source: resolveTranslatedTrackSource(
      {
        tracks: state.clip.subtitles,
        selectedSubtitleId: selectedId,
        selectedSubtitleUrl: selectedUrl,
        selectedSubtitleLang: selectedLang
      },
      targetLang
    ),
    isStale
  });

  const chunks = session.getPrimaryChunks();
  if (chunks.length === 0) {
    return { kind: "done", total: 0, done: 0, failed: 0 };
  }

  let l1Index: L1VideoIndexCacheRecord | null = null;
  let baseContext: SubtitleTranslatePromptContext | undefined;

  const hydrated = await session.hydrate({
    mode: args.mode,
    acceptOnHit: true,
    protocolItems: body,
    loadTranslator: async () => {
      const [translateModule, cachedL1] = await Promise.all([
        import("../ai/subtitle-translate.js"),
        readCachedL1VideoIndex(state.clip)
      ]);
      l1Index = cachedL1;
      baseContext = await resolveRuntimeSubtitleContext({ l1Index: cachedL1 });
      const providerRes = await translateModule.resolveSubtitleTranslateProvider().catch(() => null);
      return {
        model: providerRes?.model,
        glossary: baseContext?.glossary ?? state.settings?.subtitleTranslateGlossary,
        resolveProtocolMode: translateModule.resolveSubtitleTranslateProtocolMode,
        translateTrack: translateModule.translateSubtitleTrack,
        protocolItems: body
      };
    }
  });

  const report = (done: number, failed: number) =>
    args.onProgress?.({ total: chunks.length, done, failed });

  if (hydrated.status === "aborted") {
    return { kind: "aborted", total: chunks.length, done: hydrated.doneChunks, failed: 0 };
  }
  if (hydrated.status === "ready") {
    report(chunks.length, 0);
    return { kind: "done", total: chunks.length, done: chunks.length, failed: 0 };
  }
  if (args.mode === "cache-only") {
    report(hydrated.doneChunks, 0);
    return {
      kind: "pending",
      total: chunks.length,
      done: hydrated.doneChunks,
      failed: 0
    };
  }

  let done = hydrated.doneChunks;
  let failed = 0;
  report(done, failed);

  const runtimeVideo = getSiteRuntimeVideoElement();
  const scheduler = createSubtitleChunkScheduler<TranslatedTrackPrimaryChunk>({
    chunks: hydrated.pendingChunks.map((chunk) => ({
      index: chunk.index,
      startSec: chunk.startSec,
      endSec: chunk.endSec,
      payload: chunk
    })),
    video: runtimeVideo,
    getCurrentTimeSec: () => getSiteRuntimeVideoElement()?.currentTime ?? 0,
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

  if (session.getSecondaryItems().length === 0) {
    markSecondaryTranslationFailed(session.slotId);
  }
  return { kind: "done", total: chunks.length, done, failed };
}
