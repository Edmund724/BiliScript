import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { transcribe as adapterTranscribe } from "../extension/asr/adapters/openai-transcriptions.js";
import { createTranscriptionEngine } from "../extension/asr/engine.js";
import type { TranscribeChunk, TranscriptionEngineSummary } from "../extension/asr/engine.js";
import type { TranscriptSegment } from "../extension/asr/adapters/openai-transcriptions.js";
import type { AsrProvider } from "../extension/asr/asr-provider-store.js";
import { ASR_CONCURRENCY } from "../extension/shared/offscreen-constants.js";

import { installTimingFetch } from "./lib/timing-fetch.js";
import type { RequestTiming } from "./lib/timing-fetch.js";
import { detectTimestamps } from "./lib/timestamp-detect.js";
import { filterAvailableModels } from "./lib/model-filter.js";
import { sliceWavToChunks } from "./lib/wav-slice.js";
import type { PcmChunk } from "./lib/wav-slice.js";
import { buildReport, nextReportPath, renderMarkdown } from "./lib/report.js";
import type { PerModelReport, RunReport } from "./lib/report.js";

const DEFAULT_INLINE_TIMESTAMP_PATTERNS: string[] = [
  "\\[\\d{1,2}:\\d{2}(?::\\d{2})?\\]",
  "\\{\\d+(?:\\.\\d+)?\\}",
  "\\d{1,2}:\\d{2}(?::\\d{2})?"
];

const RUN_GAP_MS = 300;

interface EvalConfig {
  models: string[];
  runsPerModel: number;
  chunkSeconds: number;
  audioPath: string;
  outDir: string;
  baseUrl: string;
  inlineTimestampPatterns: string[];
  requestGapMs: number;
  audioSeconds?: number;
}

function loadConfig(configPath: string): EvalConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`无法读取配置文件 ${configPath}：${(error as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("配置文件内容必须是 JSON 对象");
  }
  const cfg = raw as Record<string, unknown>;

  if (!Array.isArray(cfg.models) || cfg.models.length === 0) {
    throw new Error("配置缺少 models（非空字符串数组）：要评测的模型名单");
  }
  const models = cfg.models.map((m) => String(m).trim()).filter(Boolean);
  if (models.length === 0) {
    throw new Error("配置 models 不能全是空字符串");
  }

  const audioPath = String(cfg.audioPath || "").trim();
  if (!audioPath) {
    throw new Error("配置缺少 audioPath：待评测的 WAV 音频路径");
  }

  const runsPerModel = Number(cfg.runsPerModel ?? 3);
  if (!Number.isInteger(runsPerModel) || runsPerModel < 1) {
    throw new Error("配置 runsPerModel 必须是不小于 1 的整数");
  }

  const chunkSeconds = Number(cfg.chunkSeconds ?? 120);
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error("配置 chunkSeconds 必须是正数（单位秒）");
  }

  let audioSeconds: number | undefined;
  if (cfg.audioSeconds !== undefined && cfg.audioSeconds !== null && cfg.audioSeconds !== "") {
    audioSeconds = Number(cfg.audioSeconds);
    if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
      throw new Error("配置 audioSeconds 必须是正数（单位秒），或省略表示全量");
    }
  }

  const inlineTimestampPatterns = Array.isArray(cfg.inlineTimestampPatterns)
    ? cfg.inlineTimestampPatterns.map((p) => String(p))
    : DEFAULT_INLINE_TIMESTAMP_PATTERNS;
  for (const pattern of inlineTimestampPatterns) {
    try {
      new RegExp(pattern);
    } catch (error) {
      throw new Error(`配置 inlineTimestampPatterns 中的正则不合法 "${pattern}"：${(error as Error).message}`);
    }
  }

  return {
    models,
    runsPerModel,
    chunkSeconds,
    audioPath,
    outDir: String(cfg.outDir || "eval/out").trim() || "eval/out",
    baseUrl: String(cfg.baseUrl || "https://api.siliconflow.cn/v1").trim().replace(/\/+$/, "") || "https://api.siliconflow.cn/v1",
    inlineTimestampPatterns,
    requestGapMs: Number.isFinite(Number(cfg.requestGapMs)) ? Number(cfg.requestGapMs) : RUN_GAP_MS,
    audioSeconds
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isDeterministic4xx(status: number): boolean {
  return status === 400 || status === 401 || status === 404;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function mean(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function meanSuccessfulDuration(timings: RequestTiming[]): number | null {
  return mean(timings.filter((t) => is2xx(t.status)).map((t) => t.durationMs));
}

function fmtMs(ms: number | null): string {
  return ms === null ? "-" : `${Math.round(ms)}`;
}

function fmtNum(value: number | null, digits = 3): string {
  return value === null ? "-" : value.toFixed(digits);
}

interface ModelSample {
  text: string;
  segments?: TranscriptSegment[];
}

async function evalModel(
  model: string,
  config: EvalConfig,
  apiKey: string,
  chunks: PcmChunk[],
  audioDurationSec: number,
  records: RequestTiming[]
): Promise<PerModelReport> {
  const runs: RunReport[] = [];
  let sample: ModelSample | null = null;

  for (let runIndex = 0; runIndex < config.runsPerModel; runIndex += 1) {
    const sliceStart = records.length;
    let firstSuccessChunk: ModelSample | null = null;

    const transcribe = async (chunk: TranscribeChunk & Partial<PcmChunk>, ctx: { onProgress: () => void }) =>
      adapterTranscribe({
        wavBlob: (chunk as PcmChunk).blob,
        startSec: (chunk as PcmChunk).startSec,
        durationSec: chunk.durationSec,
        provider: {
          baseUrl: config.baseUrl,
          model,
          apiKey,
          language: "auto"
        } as AsrProvider,
        onProgress: ctx.onProgress
      });

    const engine = createTranscriptionEngine({
      transcribe,
      concurrency: ASR_CONCURRENCY,
      onChunkResult: (chunk, result) => {
        if (!firstSuccessChunk && typeof result?.text === "string") {
          firstSuccessChunk = { text: result.text, segments: result.segments };
        }
      }
    });

    const t0 = performance.now();
    for (const chunk of chunks) {
      engine.push({ index: chunk.startSec, durationSec: chunk.durationSec, blob: chunk.blob, startSec: chunk.startSec } as TranscribeChunk);
    }
    const summary: TranscriptionEngineSummary = await engine.close();
    const wallMs = performance.now() - t0;

    const requestTimings = records.slice(sliceStart);
    const segmentMeanMs = meanSuccessfulDuration(requestTimings);
    const rtf = audioDurationSec > 0 ? wallMs / (audioDurationSec * 1000) : null;
    const success = summary.completedChunks > 0 && segmentMeanMs !== null;

    runs.push({
      runIndex,
      wallMs,
      segmentCount: summary.completedChunks,
      failedChunks: summary.failedChunks,
      requestTimings,
      segmentMeanMs,
      rtf,
      success
    });

    if (firstSuccessChunk) {
      sample = firstSuccessChunk as ModelSample;
    }

    console.log(
      `[${model}] 第 ${runIndex + 1}/${config.runsPerModel} 次运行：` +
        `墙钟 ${Math.round(wallMs)}ms，段均 ${fmtMs(segmentMeanMs)}ms，` +
        `完成片 ${summary.completedChunks}/${summary.acceptedChunks}` +
        (summary.failedChunks > 0 ? `，失败片 ${summary.failedChunks}` : "") +
        (success ? "" : "（本次记为 FAIL）")
    );

    const allDeterministicFail = requestTimings.length > 0 && requestTimings.every((t) => !is2xx(t.status) && isDeterministic4xx(t.status));
    if (allDeterministicFail || summary.completedChunks === 0) {
      const reason = allDeterministicFail
        ? "端点返回确定性 4xx（400/401/404），模型可能不支持该端点、key 无权限或已下线"
        : "本次运行没有任何分片转写成功";
      console.log(`[${model}] 跳过该模型后续运行：${reason}`);
      return {
        model,
        runs,
        aggregate: summarizeModelRuns(runs),
        timestamps: { hasResponseStructure: false, hasInline: false, matchedPatterns: [] },
        sampleText: "",
        skipped: true,
        skipReason: reason
      };
    }

    if (config.requestGapMs > 0) {
      await sleep(config.requestGapMs);
    }
  }

  return {
    model,
    runs,
    aggregate: summarizeModelRuns(runs),
    timestamps: detectSampleTimestamps(sample, config),
    sampleText: sample ? sample.text.slice(0, 300) : "",
    skipped: false
  };
}

function summarizeModelRuns(runs: RunReport[]): PerModelReport["aggregate"] {
  const successful = runs.filter((r) => r.success);
  const segmentMeans = successful.map((r) => r.segmentMeanMs);
  const walls = successful.map((r) => r.wallMs);
  const rtfs = successful.map((r) => r.rtf);
  return {
    segmentMeanMean: mean(segmentMeans.filter((v): v is number => v !== null)),
    wallMean: mean(walls.filter((v): v is number => v !== null)),
    rtfMean: mean(rtfs.filter((v): v is number => v !== null)),
    successCount: successful.length
  };
}

function detectSampleTimestamps(sample: ModelSample | null, config: EvalConfig): PerModelReport["timestamps"] {
  if (!sample) {
    return { hasResponseStructure: false, hasInline: false, matchedPatterns: [] };
  }
  const patterns = config.inlineTimestampPatterns.map((p) => new RegExp(p));
  return detectTimestamps({ text: sample.text, segments: sample.segments }, patterns);
}

async function fetchAvailableModels(baseUrl: string, apiKey: string, wanted: string[], realFetch: typeof fetch): Promise<string[]> {
  let response: Response;
  try {
    response = await realFetch(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` }
    });
  } catch (error) {
    throw new Error(`拉取模型列表失败（${baseUrl}/models）：${(error as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(`拉取模型列表失败：${baseUrl}/models 返回 HTTP ${response.status}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`模型列表响应不是合法 JSON：${(error as Error).message}`);
  }
  return filterAvailableModels(body, wanted);
}

function printSummaryTable(models: PerModelReport[]): void {
  const header = "| 模型 | 段均均值ms | 墙钟均值ms | RTF | 时间戳 | 成功次数 | 备注 |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- |";
  const rows = models.map((m) => {
    const hasTimestamp = !m.skipped && (m.timestamps.hasResponseStructure || m.timestamps.hasInline);
    const timestampText = m.skipped ? "-" : hasTimestamp ? "是" : "否";
    const note = m.skipped ? `已跳过：${m.skipReason || "未知原因"}` : "";
    return `| ${m.model} | ${fmtMs(m.aggregate.segmentMeanMean)} | ${fmtMs(m.aggregate.wallMean)} | ${fmtNum(m.aggregate.rtfMean)} | ${timestampText} | ${m.aggregate.successCount}/${m.runs.length} | ${note} |`;
  });
  console.log("\n评测结果摘要：\n" + [header, divider, ...rows].join("\n"));
}

export async function main(): Promise<void> {
  const configPath = process.argv[2] ? resolve(process.argv[2]) : resolve("eval/config.json");
  const config = loadConfig(configPath);

  const apiKey = String(process.env.SILICONFLOW_API_KEY || "").trim();
  if (!apiKey) {
    console.error("错误：未设置环境变量 SILICONFLOW_API_KEY。请先执行 export SILICONFLOW_API_KEY=sk-...（key 不要写进代码或 git）。");
    process.exit(1);
  }

  let audioBuffer: Uint8Array;
  try {
    audioBuffer = new Uint8Array(readFileSync(config.audioPath));
  } catch (error) {
    console.error(`错误：无法读取音频文件 ${config.audioPath}：${(error as Error).message}`);
    process.exit(1);
  }
  const allChunks = sliceWavToChunks(audioBuffer, config.chunkSeconds);
  const chunks = config.audioSeconds === undefined ? allChunks : allChunks.filter((c) => c.startSec < config.audioSeconds!);
  if (chunks.length === 0) {
    console.error(`错误：音频切片结果为空，请确认 ${config.audioPath} 是标准 PCM WAV 文件。`);
    process.exit(1);
  }
  const audioDurationSec = chunks.reduce((sum, c) => sum + c.durationSec, 0);
  const scopeText = config.audioSeconds === undefined ? "全量" : `前 ${audioDurationSec.toFixed(0)} 秒（audioSeconds=${config.audioSeconds}）`;
  console.log(`音频：${config.audioPath}（${scopeText}，约 ${audioDurationSec.toFixed(1)} 秒），切成 ${chunks.length} 片，每片 ${config.chunkSeconds} 秒。`);

  const realFetch = globalThis.fetch;
  const records: RequestTiming[] = [];
  const restoreFetch = installTimingFetch(realFetch, (t) => records.push(t));

  try {
    const availableModels = await fetchAvailableModels(config.baseUrl, apiKey, config.models, realFetch);
    const missing = config.models.filter((m) => !availableModels.includes(m));
    if (missing.length > 0) {
      console.log(`以下模型不在平台在线名单中，跳过：${missing.join("、")}`);
    }
    if (availableModels.length === 0) {
      console.error("错误：配置的模型没有一个在平台在线名单中，无法评测。");
      process.exit(1);
    }
    console.log(`开始评测 ${availableModels.length} 个模型：${availableModels.join("、")}`);

    const models: PerModelReport[] = [];
    for (const model of availableModels) {
      console.log(`\n===== 模型 ${model} =====`);
      const report = await evalModel(model, config, apiKey, chunks, audioDurationSec, records);
      models.push(report);
    }

    const evalReport = buildReport({
      models,
      meta: {
        generatedAt: new Date().toISOString(),
        audioName: config.audioPath,
        audioDurationSec,
        config: config as unknown as Record<string, unknown>
      }
    });

    mkdirSync(config.outDir, { recursive: true });
    const reportBase = nextReportPath(config.outDir, "report", existsSync);
    writeFileSync(`${reportBase}.json`, JSON.stringify(evalReport, null, 2), "utf8");
    writeFileSync(`${reportBase}.md`, renderMarkdown(evalReport), "utf8");
    printSummaryTable(models);
    console.log(`\n报告已写入：${reportBase}.json 与 ${reportBase}.md`);
  } finally {
    restoreFetch();
  }
}

const isCliEntry = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isCliEntry) {
  main().catch((error) => {
    console.error(`评测失败：${(error as Error)?.message || error}`);
    process.exit(1);
  });
}
