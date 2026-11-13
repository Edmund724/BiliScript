// extension/asr/pipeline.ts
// ASR 管线编排（调用侧只做编排不碰音频字节）：取音轨 → offscreen 下载/
// 解码/切片/逐片转写（转写引擎与解码同 context，跨 port 只传文本结果）→
// 时间戳加片偏移合并为 B 站字幕格式 [{from,to,content}]。
//
// 调用侧不感知 provider/Key：平台选择、Key 组装、语言档位全部在 offscreen
// 侧完成（entry/offscreen-asr.js 直调 background 的 get-asr-runtime-config），
// 调度引擎（asr/engine.js，活队列 + 逐片重试 + 失败计数）也在 offscreen。
// 页面回退决策由上游 fallback 承担；本模块负责取音轨地址、发任务、收文本结果、
// 合并与空结果诊断，页面与后台 Agent 桥接共用。
//
// 本模块不做任何过期守卫：转写与视频切换解耦（切走视频任务照跑、成果照落
// 缓存），中止只剩真断连（调用方关闭/扩展重载 → port disconnect）。

import { getSourceAudioUrl } from "./audio-source.js";
import type { JsonTransport } from "../bilibili/gateway-core.js";
import { createOffscreenChunkHost } from "./offscreen-bridge.page.js";
import type { OffscreenChunkHost, AsrChunkRecord, AsrChunkResult } from "./offscreen-bridge.page.js";
import { readAsrFailureSummary, projectAsrFailureSummary } from "./protocol.js";
import type { AsrAttemptOutcome } from "./protocol.js";
import type { SubtitleItem } from "./fallback.js";

// 中英文句末标点（。！？!? 以及非数字后小数点的 .）与换行符正则
const SENTENCE_DELIMITER_RE = /(?:[。！？!?]+|\.+(?!\d))["'”’」』）\)]*|\r?\n+/g;

function joinWithOptionalSpace(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const lastChar = a[a.length - 1];
  const firstChar = b[0];
  if (/[a-zA-Z0-9.!?]/.test(lastChar) && /[a-zA-Z0-9]/.test(firstChar)) {
    return `${a} ${b}`;
  }
  return `${a}${b}`;
}

// 合并过短碎句（默认长度 < 4 字符，如单字或纯语气助词加标点）
export function mergeShortSentences(sentences: string[], minChars = 4): string[] {
  if (sentences.length <= 1 || minChars <= 0) {
    return sentences;
  }
  const merged: string[] = [];

  for (const s of sentences) {
    if (merged.length === 0) {
      merged.push(s);
    } else if (s.length < minChars) {
      // 当前句过短：合入前一句
      merged[merged.length - 1] = joinWithOptionalSpace(merged[merged.length - 1], s);
    } else if (merged[merged.length - 1].length < minChars) {
      // 前一句（首句）过短：把当前句合入前一句
      merged[merged.length - 1] = joinWithOptionalSpace(merged[merged.length - 1], s);
    } else {
      merged.push(s);
    }
  }

  return merged;
}

// 按中英文句末标点与换行切分句子，并合并过短碎句
export function splitTextIntoSentences(text: string, minChars = 4): string[] {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }

  const rawSentences: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = SENTENCE_DELIMITER_RE.exec(trimmed)) !== null) {
    const end = match.index + match[0].length;
    const piece = trimmed.slice(lastIndex, end).trim();
    if (piece) {
      rawSentences.push(piece);
    }
    lastIndex = end;
  }
  const remaining = trimmed.slice(lastIndex).trim();
  if (remaining) {
    rawSentences.push(remaining);
  }

  if (rawSentences.length <= 1 || minChars <= 0) {
    return rawSentences;
  }

  return mergeShortSentences(rawSentences, minChars);
}

// 纯文本按字符长度比例在 [startSec, startSec + durationSec] 线性插值分配 {from, to}
export function interpolateSentenceTimestamps({
  sentences,
  startSec,
  durationSec
}: {
  sentences: string[];
  startSec: number;
  durationSec: number;
}): SubtitleItem[] {
  if (!sentences || sentences.length === 0) {
    return [];
  }
  const start = Number(startSec) || 0;
  const dur = Number(durationSec) || 0;

  if (sentences.length === 1) {
    return [{
      from: start,
      to: dur > 0 ? start + dur : start,
      content: sentences[0]
    }];
  }

  if (!(dur > 0)) {
    return sentences.map((content) => ({
      from: start,
      to: start,
      content
    }));
  }

  const weights = sentences.map((s) => Math.max(1, s.length));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const out: SubtitleItem[] = [];
  let currentFrom = start;
  let accumulatedWeight = 0;

  for (let i = 0; i < sentences.length; i++) {
    accumulatedWeight += weights[i];
    const currentTo = (i === sentences.length - 1)
      ? start + dur
      : start + (dur * accumulatedWeight) / totalWeight;

    out.push({
      from: currentFrom,
      to: currentTo,
      content: sentences[i]
    });
    currentFrom = currentTo;
  }

  return out;
}

// 把单片的转写结果合成 {from,to,content}[]：
//   有有效 segments → 每条 = startSec + seg.start/end，to 不超过片末边界；
//   无 segments → 按句末标点与换行切分句子并合并碎句，按字符长度在起止时间窗内线性插值。
// 空白片段返回 []。
export function synthesizeChunk({ startSec, durationSec, result }: {
  startSec: number;
  durationSec: number;
  result: AsrChunkResult | null;
}): SubtitleItem[] {
  const out: SubtitleItem[] = [];
  const chunkDur = Number(result?.durationSec || 0) || Number(durationSec) || 0;
  if (result?.segments && result.segments.length > 0) {
    for (const seg of result.segments) {
      const content = String(seg.text || "").trim();
      if (!content) {
        continue;
      }
      const from = Number(startSec) + Number(seg.start);
      const segEnd = Number(seg.end);
      const to = chunkDur > 0
        ? Math.min(Number(startSec) + segEnd, Number(startSec) + chunkDur)
        : Number(startSec) + segEnd;
      out.push({ from, to, content });
    }
  } else {
    const text = String(result?.text || "").trim();
    if (text) {
      const sentences = splitTextIntoSentences(text);
      return interpolateSentenceTimestamps({
        sentences,
        startSec: Number(startSec) || 0,
        durationSec: chunkDur > 0 ? chunkDur : Number(durationSec) || 0
      });
    }
  }
  return out;
}

// 全部片段合成 → 按 from 排序 → content 拼接 trim 为空返回 []（上层提示
// "未识别到语音内容"）。chunkResults 为按片 index 对齐的单片记录
// [{ index, startSec, durationSec, result }]（offscreen 桥 done 后已排序）；
// 转写失败片 / 解码失败段不在其中（offscreen 引擎跳过并计数），不参与合并。
export function mergeChunkResults(chunkResults: AsrChunkRecord[]): SubtitleItem[] {
  const merged: SubtitleItem[] = [];
  for (const record of chunkResults) {
    if (!record?.result) {
      continue;
    }
    merged.push(...synthesizeChunk({ startSec: record.startSec, durationSec: record.durationSec, result: record.result }));
  }
  merged.sort((a, b) => a.from - b.from);
  return merged;
}

// ===== 主入口 =====

// runAsrPipeline 的入参：bvid/cid 取音轨；onProgress 中继状态文案；
// chunkHost 为可选注入的任务宿主（测试传合成宿主，生产默认走
// createOffscreenChunkHost）；onEmptyDiagnostic 承接空结果诊断文案。
// 单次转写尝试的失败面结果（整轮自动重试判定用；声明唯一住在 asr/protocol，
// 此处转出原类型名以供既有 import 点）：totalChunks 为产出片数、failedChunks 为
// 转写失败跳过片数、elapsedMs 为本次尝试墙钟耗时，外加片级失败摘要的 wire 字段
// （「有则带键」，未携带失败信号时这三个键不出现）。
export type { AsrAttemptOutcome };

export interface RunAsrPipelineArgs {
  bvid: string;
  cid: string;
  onProgress?: (message: string) => void;
  chunkHost?: OffscreenChunkHost;
  sourceTransport?: JsonTransport;
  onEmptyDiagnostic?: (diagText: string) => void;
  onAttemptOutcome?: (outcome: AsrAttemptOutcome) => void;
  onChunkResult?: (record: AsrChunkRecord, items: SubtitleItem[]) => void;
  signal?: AbortSignal | null;
}

// runAsrPipeline({ bvid, cid, onProgress, chunkHost, onEmptyDiagnostic })
// → [{from,to,content}]（空数组表示未识别到语音内容）。
// 不做任何过期守卫（runId/视频键复核均已移除）：调用方（asr/fallback）自行
// 决定 UI 应用时机，转写本身与视频切换解耦，跑完即返回。chunkHost 为可选
// 注入的任务宿主（测试传合成宿主，生产默认走 createOffscreenChunkHost：
// offscreen 文档内下载+解码+切片+逐片转写，每片完成即回传文本结果）。
export async function runAsrPipeline({
  bvid,
  cid,
  onProgress,
  chunkHost,
  sourceTransport,
  onEmptyDiagnostic,
  onAttemptOutcome,
  onChunkResult,
  signal
}: RunAsrPipelineArgs): Promise<SubtitleItem[]> {
  const host = chunkHost || createOffscreenChunkHost();
  const startedAt = Date.now();

  // 取音轨：playurl 依赖浏览器登录态，页面与 SW 分别经注入传输请求。
  onProgress?.("无字幕轨，正在获取音频流…");
  const source = await getSourceAudioUrl({ bvid, cid }, sourceTransport);

  // offscreen 文档内完成下载 → 解码 → 切片 → 逐片转写（engine 并发调度），
  // 每片完成即把文本结果经 port 发回；音频字节与 API Key 都不出 offscreen。
  // 防盗链规则由 prepare 阶段在 background 加上。
  onProgress?.("音频下载与解码中…");
  const hostResult = await host({
    audioUrl: source.url,
    backupUrls: source.backupUrls || [],
    onProgress,
    signal,
    onChunkResult: (record) => {
      if (onChunkResult) {
        const items = synthesizeChunk({
          startSec: record.startSec,
          durationSec: record.durationSec,
          result: record.result
        });
        try {
          onChunkResult(record, items);
        } catch {
          // ignore
        }
      }
    }
  });
  // 失败字段不再解构：片级失败摘要经协议模块的判定 → 投影读出（宿主结果形状见
  // asr/protocol.js 的 AsrFailureFields）。
  const { results, totalChunks, skippedSegments, failedChunks } = hostResult;

  const merged = mergeChunkResults(results);
  if (merged.length === 0 && typeof onEmptyDiagnostic === "function") {
    // 空结果诊断：静音场景已在解码层显式报错，剩下的事件级证据随适配器
    // 诊断字段上来，失败计数（转写失败片 / 解码失败跳过段）一并拼进文案。
    const diagnostics = results
      .map((r) => r?.result?._asrDiag)
      .filter(Boolean)
      .slice(0, 1);
    const plannedChunks = Number(totalChunks) > 0 ? Number(totalChunks) : results.length;
    let diagText =
      `分片 ${plannedChunks} 片、各片文本长度[${results.map((r) => String(r?.result?.text || "").length).join(",")}]`;
    if (diagnostics[0]) {
      diagText += `；事件诊断 ${JSON.stringify(diagnostics[0])}`;
    }
    const failureParts: string[] = [];
    if (Number(failedChunks) > 0) {
      failureParts.push(`${Number(failedChunks)} 片转写失败`);
    }
    if (Number(skippedSegments) > 0) {
      failureParts.push(`${Number(skippedSegments)} 段解码失败已跳过`);
    }
    if (failureParts.length > 0) {
      diagText += `；${failureParts.join("、")}`;
    }
    try {
      onEmptyDiagnostic(diagText.slice(0, 400));
    } catch {
      // 诊断回调异常不影响主流程
    }
  }
  // 失败面结果上报（整轮自动重试判定用，fallback 空结果分支消费）：每次尝试
  // 完成都会调用，非空结果同样上报（failedChunks 反映片失败计数）。片级失败
  // 摘要经判定 → 投影产出（键缺失即无失败信号，不补 undefined——fallback 按
  // 有无 kind 区分「说得出原因」与「归 asr-unknown」）。
  if (typeof onAttemptOutcome === "function") {
    onAttemptOutcome({
      totalChunks: Number(totalChunks) > 0 ? Number(totalChunks) : results.length,
      failedChunks: Number(failedChunks) || 0,
      elapsedMs: Date.now() - startedAt,
      ...projectAsrFailureSummary(readAsrFailureSummary(hostResult))
    });
  }
  return merged;
}
