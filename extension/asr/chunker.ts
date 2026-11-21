import { encodeWavBytes } from "./wav-encode.js";

export interface ChunkPlan {
  chunkSeconds: number;
}

export interface ChunkSpec {
  index: number;
  startSec: number;
  durationSec: number;
  overlapLeadSec: number;
}

export interface WavChunk extends ChunkSpec {
  wavBlob: Blob;
}

export const SOFT_CUT_LOOKBACK_SEC = 8;
export const SOFT_CUT_WINDOW_SEC = 0.28;
export const SOFT_CUT_STEP_SEC = 0.02;
export const SILENCE_RMS_THRESHOLD = 0.008;
export const SILENCE_MEDIAN_RATIO = 0.15;
export const FALLBACK_OVERLAP_SEC = 1.5;

export interface AudioChunkCutDecision {
  cutSamples: number;
  nextOverlapSamples: number;
}

export interface DecodedAudioDiagnostic {
  durationSec: number;
  peak: number;
}

export interface DecodedAudioBuffer {
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
  diagnostic?: DecodedAudioDiagnostic;
}

export function encodeWav(monoFloat32: Float32Array, sampleRate = 16000): Blob {
  return new Blob([encodeWavBytes(monoFloat32, sampleRate)], { type: "audio/wav" });
}

export function decideChunks(totalDurationSec: number, plan: ChunkPlan): ChunkSpec[] {
  const total = Number(totalDurationSec);
  if (!(total > 0)) return [];
  const chunkSec = plan?.chunkSeconds > 0 ? plan.chunkSeconds : total;

  const chunks: ChunkSpec[] = [];
  let start = 0;
  let index = 0;
  while (total - start > 1e-9) {
    const end = Math.min(start + chunkSec, total);
    chunks.push({ index, startSec: start, durationSec: end - start, overlapLeadSec: 0 });
    start = end;
    index += 1;
  }
  return chunks;
}

export function decideAudioChunkCut(
  chunkSamplesBuf: Float32Array,
  sampleRate = 16000
): AudioChunkCutDecision {
  const targetSamples = chunkSamplesBuf.length;
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000;
  const winSamples = Math.max(1, Math.round(SOFT_CUT_WINDOW_SEC * rate));
  const stepSamples = Math.max(1, Math.round(SOFT_CUT_STEP_SEC * rate));
  const fallbackOverlapSamples = Math.max(0, Math.round(FALLBACK_OVERLAP_SEC * rate));

  if (targetSamples <= fallbackOverlapSamples * 2 || targetSamples < winSamples * 2) {
    return { cutSamples: targetSamples, nextOverlapSamples: 0 };
  }

  const blockRms: number[] = [];
  for (let pos = 0; pos + winSamples <= targetSamples; pos += winSamples) {
    let sumSq = 0;
    for (let j = pos; j < pos + winSamples; j += 1) {
      const v = chunkSamplesBuf[j];
      sumSq += v * v;
    }
    blockRms.push(Math.sqrt(sumSq / winSamples));
  }
  blockRms.sort((a, b) => a - b);
  const midIdx = Math.floor(blockRms.length / 2);
  const medianRms =
    blockRms.length === 0
      ? 0
      : blockRms.length % 2 === 1
        ? blockRms[midIdx]
        : (blockRms[midIdx - 1] + blockRms[midIdx]) / 2;

  const lookbackSamples = Math.min(targetSamples, Math.round(SOFT_CUT_LOOKBACK_SEC * rate));
  const searchStart = targetSamples - lookbackSamples;
  if (lookbackSamples < winSamples) {
    return { cutSamples: targetSamples, nextOverlapSamples: 0 };
  }

  const prefixSq = new Float64Array(lookbackSamples + 1);
  for (let i = 0; i < lookbackSamples; i += 1) {
    const v = chunkSamplesBuf[searchStart + i];
    prefixSq[i + 1] = prefixSq[i] + v * v;
  }

  const offsets: number[] = [];
  const rmsValues: number[] = [];
  let minRms = Infinity;
  for (let offset = 0; offset + winSamples <= lookbackSamples; offset += stepSamples) {
    const sumSq = Math.max(0, prefixSq[offset + winSamples] - prefixSq[offset]);
    const rms = Math.sqrt(sumSq / winSamples);
    offsets.push(offset);
    rmsValues.push(rms);
    if (rms < minRms) {
      minRms = rms;
    }
  }

  const effectiveThreshold = Math.max(SILENCE_RMS_THRESHOLD, medianRms * SILENCE_MEDIAN_RATIO);
  if (rmsValues.length > 0 && minRms < effectiveThreshold) {
    const valleyCutoff = Math.min(effectiveThreshold, Math.max(minRms * 1.05, minRms + 1e-6));
    let bestStart = -1;
    let bestEnd = -1;
    let bestContainsMin = false;
    let bestLen = -1;

    let i = 0;
    while (i < rmsValues.length) {
      if (rmsValues[i] < effectiveThreshold && rmsValues[i] <= valleyCutoff) {
        const rStart = i;
        let containsMin = false;
        while (i < rmsValues.length && rmsValues[i] < effectiveThreshold && rmsValues[i] <= valleyCutoff) {
          if (rmsValues[i] <= minRms + 1e-9) {
            containsMin = true;
          }
          i += 1;
        }
        const rEnd = i - 1;
        const rLen = rEnd - rStart + 1;
        const better =
          (containsMin && !bestContainsMin) ||
          (containsMin === bestContainsMin && rLen >= bestLen);
        if (better) {
          bestStart = rStart;
          bestEnd = rEnd;
          bestContainsMin = containsMin;
          bestLen = rLen;
        }
      } else {
        i += 1;
      }
    }

    if (bestStart >= 0) {
      const valleyLeft = searchStart + offsets[bestStart];
      const valleyRight = searchStart + offsets[bestEnd] + winSamples;
      const cutSamples = Math.max(1, Math.min(targetSamples, Math.round((valleyLeft + valleyRight) / 2)));
      return { cutSamples, nextOverlapSamples: 0 };
    }
  }

  return {
    cutSamples: targetSamples,
    nextOverlapSamples: Math.min(fallbackOverlapSamples, targetSamples - 1)
  };
}

export function buildChunkPlan(providerType: string): ChunkPlan {
  if (providerType === "openai-transcriptions") {
    return { chunkSeconds: 60 };
  }
  return { chunkSeconds: 0 };
}

export function makeDecodedBuffer(
  channelData: Float32Array,
  { sampleRate = 16000, diagnostic }: { sampleRate?: number; diagnostic?: DecodedAudioDiagnostic } = {}
): DecodedAudioBuffer {
  return {
    sampleRate,
    length: channelData.length,
    getChannelData: () => channelData,
    diagnostic
  };
}

export function assertDecodedAudioNotSilent({ durationSec, peak }: DecodedAudioDiagnostic): void {
  if (Number.isFinite(peak) && peak < 0.001 && durationSec > 0) {
    throw new Error(
      `音频解码失败：解码结果疑似静音（时长 ${durationSec}s、峰值幅度 ${peak}）`
    );
  }
}

export function validateDecodedAudio(audioBuffer: DecodedAudioBuffer): number {
  const diag = audioBuffer?.diagnostic;
  if (diag) {
    assertDecodedAudioNotSilent(diag);
  }

  const totalDurationSec = audioBuffer.length / audioBuffer.sampleRate;
  if (!(totalDurationSec > 0)) {
    throw new Error(
      `音频解码失败：解码结果时长为零（采样数 ${audioBuffer?.length ?? 0}、采样率 ${audioBuffer?.sampleRate}）`
    );
  }
  return totalDurationSec;
}

export function buildWavChunks(audioBuffer: DecodedAudioBuffer, plan: ChunkPlan): WavChunk[] {
  const totalDurationSec = validateDecodedAudio(audioBuffer);
  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const chunkSec = plan?.chunkSeconds > 0 ? plan.chunkSeconds : 0;

  if (!(chunkSec > 0)) {
    return decideChunks(totalDurationSec, plan).map((chunk): WavChunk => {
      const startSample = Math.round(chunk.startSec * sampleRate);
      const sampleCount = Math.round(chunk.durationSec * sampleRate);
      return {
        index: chunk.index,
        startSec: chunk.startSec,
        durationSec: chunk.durationSec,
        overlapLeadSec: 0,
        wavBlob: encodeWav(
          channelData.subarray(startSample, startSample + sampleCount),
          sampleRate
        )
      };
    });
  }

  const targetSamples = Math.round(chunkSec * sampleRate);
  const chunks: WavChunk[] = [];
  let cursorSamples = 0;
  let pendingOverlapSamples = 0;
  let index = 0;

  while (channelData.length - cursorSamples >= targetSamples) {
    const windowBuf = channelData.subarray(cursorSamples, cursorSamples + targetSamples);
    const { cutSamples, nextOverlapSamples } = decideAudioChunkCut(windowBuf, sampleRate);
    const part = cutSamples === targetSamples ? windowBuf : windowBuf.subarray(0, cutSamples);
    chunks.push({
      index,
      startSec: cursorSamples / sampleRate,
      durationSec: cutSamples / sampleRate,
      overlapLeadSec: pendingOverlapSamples / sampleRate,
      wavBlob: encodeWav(part, sampleRate)
    });
    const advanceSamples = Math.max(1, cutSamples - nextOverlapSamples);
    cursorSamples += advanceSamples;
    pendingOverlapSamples = nextOverlapSamples;
    index += 1;
  }

  const remainingSamples = channelData.length - cursorSamples;
  if (remainingSamples > 0 && (index === 0 || remainingSamples > pendingOverlapSamples)) {
    chunks.push({
      index,
      startSec: cursorSamples / sampleRate,
      durationSec: remainingSamples / sampleRate,
      overlapLeadSec: pendingOverlapSamples / sampleRate,
      wavBlob: encodeWav(channelData.subarray(cursorSamples), sampleRate)
    });
  }

  return chunks;
}
