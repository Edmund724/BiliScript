import { assertDecodedAudioNotSilent, decideAudioChunkCut, encodeWav } from "./chunker.js";
import type { WavChunk } from "./chunker.js";
import { ASR_PENDING_CHUNKS_LIMIT_MESSAGE } from "./protocol.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { logWarn } from "../shared/logging.js";

export interface StreamWavChunksOptions {
  chunkSeconds: number;
  sampleRate?: number;
  decodeSegment: (segment: unknown) => Promise<Float32Array>;
  onChunk: (chunk: WavChunk) => boolean | void | Promise<boolean | void>;
  decodeRetries?: number;
  skipFailedSegments?: boolean;
  isAbortError?: (error: unknown) => boolean;
}

export interface StreamWavChunksResult {
  totalChunks: number;
  totalDurationSec: number;
  peak: number;
  skippedSegments: number;
}

export async function streamWavChunks(
  segments: Iterable<unknown> | AsyncIterable<unknown>,
  {
    chunkSeconds,
    sampleRate = 16000,
    decodeSegment,
    onChunk,
    decodeRetries = 0,
    skipFailedSegments = false,
    isAbortError
  }: StreamWavChunksOptions = {} as StreamWavChunksOptions
): Promise<StreamWavChunksResult> {
  const chunkSamples = Number(chunkSeconds) > 0 ? Math.round(Number(chunkSeconds) * sampleRate) : 0;

  const parts: Array<Float32Array | null> = [];
  let partsLen = 0;
  let emitted = 0;
  let cursorSamples = 0;
  let pendingOverlapSamples = 0;
  let totalLen = 0;
  let peak = 0;
  let skippedSegments = 0;

  const emitPart = async (
    part: Float32Array,
    startSamples: number,
    durationSamples: number,
    overlapSamples: number
  ): Promise<boolean> => {
    const index = emitted;
    emitted += 1;
    const accepted = await onChunk({
      index,
      startSec: startSamples / sampleRate,
      durationSec: durationSamples / sampleRate,
      overlapLeadSec: overlapSamples / sampleRate,
      wavBlob: encodeWav(part, sampleRate)
    });
    return accepted !== false;
  };

  const peekSamples = (need: number): Float32Array => {
    const out = new Float32Array(need);
    let off = 0;
    let remaining = need;
    for (let i = 0; i < parts.length && remaining > 0; i += 1) {
      const head = parts[i];
      if (!head) continue;
      const take = Math.min(remaining, head.length);
      out.set(head.subarray(0, take), off);
      off += take;
      remaining -= take;
    }
    return out;
  };

  const dropSamples = (dropCount: number): void => {
    let remaining = dropCount;
    let i = 0;
    for (; i < parts.length && remaining > 0; i += 1) {
      const head = parts[i];
      if (!head) continue;
      const take = Math.min(remaining, head.length);
      remaining -= take;
      if (take === head.length) {
        parts[i] = null;
      } else {
        parts[i] = head.subarray(take);
        i += 1;
        break;
      }
    }
    let drop = 0;
    while (drop < i && parts[drop] === null) drop += 1;
    if (drop > 0) parts.splice(0, drop);
  };

  const decodeWithDowngrade = async (
    segment: unknown,
    segmentIndex: number
  ): Promise<{ mono: Float32Array | null }> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= decodeRetries; attempt += 1) {
      try {
        return { mono: await decodeSegment(segment) };
      } catch (error) {
        if (typeof isAbortError === "function" && isAbortError(error)) {
          throw error;
        }
        lastError = error;
      }
    }
    if (!skipFailedSegments) {
      throw lastError;
    }
    skippedSegments += 1;
    logWarn("[BILISCRIPT] asr segment decode failed, skipping", {
      segmentIndex,
      attempts: decodeRetries + 1,
      error: getErrorMessage(lastError)
    });
    return { mono: null };
  };

  let segmentIndex = 0;
  for await (const segment of segments) {
    const { mono: segMono } = await decodeWithDowngrade(segment, segmentIndex);
    segmentIndex += 1;
    if (!(segMono && segMono.length > 0)) {
      continue;
    }
    for (let i = 0; i < segMono.length; i += 1) {
      const abs = Math.abs(segMono[i]);
      if (abs > peak) peak = abs;
    }
    parts.push(segMono);
    partsLen += segMono.length;
    totalLen += segMono.length;

    if (!(chunkSamples > 0)) {
      continue;
    }
    while (partsLen >= chunkSamples) {
      const windowBuf = peekSamples(chunkSamples);
      const { cutSamples, nextOverlapSamples } = decideAudioChunkCut(windowBuf, sampleRate);
      const chunkPcm = cutSamples === chunkSamples ? windowBuf : windowBuf.subarray(0, cutSamples);
      const startSamples = cursorSamples;
      const overlapSamples = pendingOverlapSamples;
      const advanceSamples = Math.max(1, cutSamples - nextOverlapSamples);
      dropSamples(advanceSamples);
      partsLen -= advanceSamples;
      cursorSamples += advanceSamples;
      pendingOverlapSamples = nextOverlapSamples;
      if (!(await emitPart(chunkPcm, startSamples, cutSamples, overlapSamples))) {
        throw new Error(ASR_PENDING_CHUNKS_LIMIT_MESSAGE);
      }
    }
  }

  const hasNewTailSamples = chunkSamples > 0
    ? (emitted === 0 ? partsLen > 0 : partsLen > pendingOverlapSamples)
    : partsLen > 0;
  if (hasNewTailSamples) {
    const tailPart = peekSamples(partsLen);
    dropSamples(partsLen);
    if (!(await emitPart(tailPart, cursorSamples, partsLen, chunkSamples > 0 ? pendingOverlapSamples : 0))) {
      throw new Error(ASR_PENDING_CHUNKS_LIMIT_MESSAGE);
    }
    partsLen = 0;
  }

  const totalDurationSec = totalLen / sampleRate;
  assertDecodedAudioNotSilent({ durationSec: totalDurationSec, peak });
  return { totalChunks: emitted, totalDurationSec, peak, skippedSegments };
}
