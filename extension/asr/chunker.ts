// extension/asr/chunker.ts
// WAV 切片（16bit PCM / 16kHz / 单声道）。
// WAV 字节编码本体已拆到 asr/wav-encode.js（asr-provider-store 探针只需编码
// 不需切片，拆静态边让 chunker 其余部分退 offscreen/SW 图，见 ADR-0003），
// 本模块 import 它并保留 Blob 包装；切片、解码结果校验在本模块。
// Service Worker 没有 AudioContext：解码与重采样由 offscreen 文档宿主完成
// （见 asr/protocol.js，接 entry/offscreen-asr.js 基建），offscreen 文档侧经
// stream-chunker 流式切片，在本 context 内直接交给转写引擎，不跨 context。
// 核心模块不直接碰 AudioContext，Node/vitest 下可独立测试。

import { encodeWavBytes } from "./wav-encode.js";

// 切片计划：chunkSeconds <= 0（或缺省）表示不切——整段一个片段
export interface ChunkPlan {
  chunkSeconds: number;
}

// 切片时间戳：startSec / durationSec / overlapLeadSec 显式表达采样区间；
// 有重叠时下一片会回退 overlapLeadSec，无重叠时 overlapLeadSec 为 0
export interface ChunkSpec {
  index: number;
  startSec: number;
  durationSec: number;
  overlapLeadSec: number;
}

// buildWavChunks 的产出：切片时间戳 + 本片 WAV Blob
export interface WavChunk extends ChunkSpec {
  wavBlob: Blob;
}

// RMS 软切分与无静音回退重叠参数（16kHz 单声道为主口径）
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

// 解码诊断（可选 {durationSec, peak}）
export interface DecodedAudioDiagnostic {
  durationSec: number;
  peak: number;
}

// chunker 契约的 AudioBuffer 鸭子类型（{ sampleRate, length, getChannelData }，
// 另带可选解码诊断；DOM AudioBuffer 结构兼容）
export interface DecodedAudioBuffer {
  sampleRate: number;
  length: number;
  getChannelData(channel: number): Float32Array;
  diagnostic?: DecodedAudioDiagnostic;
}

// encodeWavBytes 的 Blob 包装（转写上传用 Blob 形态）。
export function encodeWav(monoFloat32: Float32Array, sampleRate = 16000): Blob {
  return new Blob([encodeWavBytes(monoFloat32, sampleRate)], { type: "audio/wav" });
}

// ===== 切片 =====

// 按总时长切分片段。plan = { chunkSeconds }，chunkSeconds <= 0（或缺省）
// 表示不切：整段一个片段。返回 [{ index, startSec, durationSec }]，
// startSec 连续无缝隙，最后一片短于标准片长属正常；总时长为 0 返回 []。
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

// 在目标分片缓冲区末尾 [target - 8s, target] 窗口内以 20ms 步长滑动计算 280ms 窗 RMS：
// - 找到低于静音阈值（< 0.008 或 < 当前分片中位能量 15%）的最深静音波谷 → 切点落波谷中心，下片无缝接续；
// - 全窗均为连续高密度口播 → 在缓冲区末尾切分，下一分片回退 1.5s 防止边界吞词。
export function decideAudioChunkCut(
  chunkSamplesBuf: Float32Array,
  sampleRate = 16000
): AudioChunkCutDecision {
  const targetSamples = chunkSamplesBuf.length;
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : 16000;
  const winSamples = Math.max(1, Math.round(SOFT_CUT_WINDOW_SEC * rate));
  const stepSamples = Math.max(1, Math.round(SOFT_CUT_STEP_SEC * rate));
  const fallbackOverlapSamples = Math.max(0, Math.round(FALLBACK_OVERLAP_SEC * rate));

  // 极短分片（如单测短片）不足以安全支撑 1.5s 重叠与双倍窗长，直接整片切出
  if (targetSamples <= fallbackOverlapSamples * 2 || targetSamples < winSamples * 2) {
    return { cutSamples: targetSamples, nextOverlapSamples: 0 };
  }

  // 计算当前分片非重叠 280ms 窗的中位 RMS 能量
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

  // 用平方前缀和计算 [searchStart, targetSamples) 内以 20ms 步长滑动的 280ms 窗 RMS
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
    // 选出包含全局最深波谷的连续低能量区间，切点落在该区间的中心位置
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

// 按 provider 类型计算切片计划：
//   openai-transcriptions：统一 60 秒一片（降低单片重传方差与延迟）。
// 未知类型保守按不切处理。
export function buildChunkPlan(providerType: string): ChunkPlan {
  if (providerType === "openai-transcriptions") {
    return { chunkSeconds: 60 };
  }
  return { chunkSeconds: 0 };
}

// ===== 解码校验 =====

// 裸 Float32Array → AudioBuffer 鸭子类型（chunker 契约 { sampleRate, length,
// getChannelData }）。裸数组没有 sampleRate，validateDecodedAudio 会算不出
// 时长并误报「解码结果时长为零」——曾实际发生（采样数千万级、采样率
// undefined）。decodeHost 契约与 buildWavChunks 共用此适配，口径一致。
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

// 「疑似静音」判据与冻结文案的唯一落点：chunker 的全量前置校验与 stream-chunker
// 完成时的全静音检查共用（两处曾各写一份同形实现、阈值与文案靠注释宣称同口径）。
// durationSec 由调用方给出手头持有的时长事实（本模块取解码诊断的自报时长，
// stream-chunker 取累计采样算出的时长）。时长 ≤ 0 时不判：零片产出（空输入 /
// 全部段失败 / 段解码为空）归调用方按「有没有产出」判定，见 stream-chunker 尾部。
export function assertDecodedAudioNotSilent({ durationSec, peak }: DecodedAudioDiagnostic): void {
  if (Number.isFinite(peak) && peak < 0.001 && durationSec > 0) {
    throw new Error(
      `音频解码失败：解码结果疑似静音（时长 ${durationSec}s、峰值幅度 ${peak}）`
    );
  }
}

// 校验解码结果可转写，非法时抛显式错误：
//   - 峰值≈0 且时长 > 0 → 解码出来疑似静音（音轨获取或容器解码出了问题），
//     直接报错，避免上游把空音频转写出误导性的"未识别到语音内容"；
//   - 时长 ≤ 0（空采样/采样率异常）→ 报错，绝不静默产出空切片。
// buildWavChunks 直用；静音判据走 assertDecodedAudioNotSilent。
export function validateDecodedAudio(audioBuffer: DecodedAudioBuffer): number {
  // 解码诊断：可选 {durationSec, peak}
  const diag = audioBuffer?.diagnostic;
  if (diag) {
    assertDecodedAudioNotSilent(diag);
  }

  const totalDurationSec = audioBuffer.length / audioBuffer.sampleRate;
  // 显式化：解码出零时长（空采样/采样率异常）直接报错，绝不静默产出
  // 空切片——上游会把空切片误报成"未识别到语音内容"。
  if (!(totalDurationSec > 0)) {
    throw new Error(
      `音频解码失败：解码结果时长为零（采样数 ${audioBuffer?.length ?? 0}、采样率 ${audioBuffer?.sampleRate}）`
    );
  }
  return totalDurationSec;
}

// ===== 切片编码：校验 → 切片 → 编码 =====

// 直接按切片计划把已解码音频切成 WAV 块（全量切片语义；offscreen 主链路已改
// 走 stream-chunker 流式切片，本函数留作其测试基准，并与流式切片共用同一
// 软切分与微重叠决策 decideAudioChunkCut）。
// 返回 [{ index, startSec, durationSec, overlapLeadSec, wavBlob }]。
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
