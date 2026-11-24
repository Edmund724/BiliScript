import { state, clipState } from "../core/state.js";
import type { SubtitleBodyItem } from "../ai/types.js";
import { getSiteRuntimeVideoElement } from "../core/site-video-probe.js";
import { logWarn } from "../shared/logging.js";
import { createSubtitleChunkScheduler } from "./chunk-scheduler.js";
import { classifySubtitleTrack, findTrackByRef } from "./selection.js";
import { slot } from "./slot.js";
import {
  readCachedL1VideoIndex,
  resolveRuntimeSubtitleContext
} from "../ai/subtitle-context.js";
import {
  createTranslatedTrackSession,
  isUsableSubtitleItem,
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
      origin: matchedTrack?.origin,
      kind: matchedTrack?.kind,
      source: matchedTrack?.source,
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
  const providerRes = await translateModule.resolveSubtitleTranslateProvider().catch(() => null);

  const sigChanged = session.reconfigure({
    model: providerRes?.model,
    glossary: baseContext?.glossary ?? state.settings?.subtitleTranslateGlossary,
    resolveProtocolMode: translateModule.resolveSubtitleTranslateProtocolMode,
    translateTrack: translateModule.translateSubtitleTrack,
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

  const runtimeVideo = getSiteRuntimeVideoElement();
  const scheduler = createSubtitleChunkScheduler<TranslatedTrackPrimaryChunk>({
    chunks: pending.map((chunk) => ({
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
