import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { transcribe as adapterTranscribe } from "../extension/asr/adapters/openai-transcriptions.js";
import { createTranscriptionEngine } from "../extension/asr/engine.js";
import type { TranscribeChunk, TranscriptionEngineSummary } from "../extension/asr/engine.js";
import type { AsrProvider } from "../extension/asr/asr-provider-store.js";

import { installTimingFetch } from "./lib/timing-fetch.js";
import type { RequestTiming } from "./lib/timing-fetch.js";
import { summarizeRun } from "./lib/stats.js";
import { filterAvailableModels } from "./lib/model-filter.js";
import { sliceWavToChunks } from "./lib/wav-slice.js";
import type { PcmChunk } from "./lib/wav-slice.js";
import { nextReportPath } from "./lib/report.js";

const DEFAULT_CONCURRENCY_LEVELS = [1, 2, 4, 8, 16, 32];
const DEFAULT_RUNS_PER_LEVEL = 1;
const DEFAULT_CHUNK_SECONDS = 120;
const DEFAULT_AUDIO_SECONDS = 1800;
const LEVEL_COOLDOWN_MS = 2000;

interface SweepOptions {
  model?: string;
  concurrencyLevels?: number[];
  runsPerLevel?: number;
  chunkSeconds?: number;
  audioSeconds?: number;
}

interface SweepConfig {
  model: string;
  concurrencyLevels: number[];
  runsPerLevel: number;
  chunkSeconds: number;
  audioSeconds: number;
  audioPath: string;
  baseUrl: string;
  requestGapMs: number;
  outDir: string;
}

function loadConfig(configPath: string): SweepConfig {
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

  const audioPath = String(cfg.audioPath || "").trim();
  if (!audioPath) {
    throw new Error("配置缺少 audioPath：待评测的 WAV 音频路径");
  }

  const models = Array.isArray(cfg.models) ? cfg.models.map((m) => String(m).trim()).filter(Boolean) : [];
  const sweep = (typeof cfg.sweep === "object" && cfg.sweep !== null ? cfg.sweep : {}) as SweepOptions;

  const model = String(sweep.model || models[0] || "").trim();
  if (!model) {
    throw new Error("未指定扫描模型：请在 config 的 sweep.model 里指定，或在 models 名单里至少放一个模型");
  }

  const levelsRaw = Array.isArray(sweep.concurrencyLevels) ? sweep.concurrencyLevels : DEFAULT_CONCURRENCY_LEVELS;
  const concurrencyLevels = levelsRaw.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 1);
  if (concurrencyLevels.length === 0) {
    throw new Error("sweep.concurrencyLevels 必须是正整数数组");
  }

  const runsPerLevel = Number(sweep.runsPerLevel ?? DEFAULT_RUNS_PER_LEVEL);
  if (!Number.isInteger(runsPerLevel) || runsPerLevel < 1) {
    throw new Error("sweep.runsPerLevel 必须是不小于 1 的整数");
  }

  const chunkSeconds = Number(sweep.chunkSeconds ?? DEFAULT_CHUNK_SECONDS);
  if (!Number.isFinite(chunkSeconds) || chunkSeconds <= 0) {
    throw new Error("sweep.chunkSeconds 必须是正数（单位秒）");
  }

  const audioSeconds = Number(sweep.audioSeconds ?? DEFAULT_AUDIO_SECONDS);
  if (!Number.isFinite(audioSeconds) || audioSeconds <= 0) {
    throw new Error("sweep.audioSeconds 必须是正数（单位秒）");
  }

  return {
    model,
    concurrencyLevels,
    runsPerLevel,
    chunkSeconds,
    audioSeconds,
    audioPath,
    baseUrl: String(cfg.baseUrl || "https://api.siliconflow.cn/v1").trim().replace(/\/+$/, "") || "https://api.siliconflow.cn/v1",
    requestGapMs: Number.isFinite(Number(cfg.requestGapMs)) ? Number(cfg.requestGapMs) : 300,
    outDir: String(cfg.outDir || "eval/out").trim() || "eval/out"
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

interface RequestCounts {
  total: number;
  ok: number;
  rateLimited: number;
  serverError: number;
  clientError: number;
  networkError: number;
}

function countRequests(timings: RequestTiming[]): RequestCounts {
  const c: RequestCounts = { total: timings.length, ok: 0, rateLimited: 0, serverError: 0, clientError: 0, networkError: 0 };
  for (const t of timings) {
    if (is2xx(t.status)) c.ok += 1;
    else if (t.status === 429) c.rateLimited += 1;
    else if (t.status >= 500) c.serverError += 1;
    else if (t.status > 0) c.clientError += 1;
    else c.networkError += 1;
  }
  return c;
}

function segmentMeanMs(timings: RequestTiming[]): number | null {
  const ok = timings.filter((t) => is2xx(t.status)).map((t) => t.durationMs);
  return mean(ok);
}

interface LevelRun {
  runIndex: number;
  wallMs: number;
  completedChunks: number;
  failedChunks: number;
  counts: RequestCounts;
  segmentMeanMs: number | null;
}

async function runOnce(
  model: string,
  apiKey: string,
  baseUrl: string,
  chunks: PcmChunk[],
  concurrency: number,
  records: RequestTiming[]
): Promise<LevelRun> {
  const sliceStart = records.length;

  const transcribe = async (chunk: TranscribeChunk & Partial<PcmChunk>, ctx: { onProgress: () => void }) =>
    adapterTranscribe({
      wavBlob: (chunk as PcmChunk).blob,
      startSec: (chunk as PcmChunk).startSec,
      durationSec: chunk.durationSec,
      provider: { baseUrl, model, apiKey, language: "auto" } as AsrProvider,
      onProgress: ctx.onProgress
    });

  const engine = createTranscriptionEngine({ transcribe, concurrency });
  const t0 = performance.now();
  for (const chunk of chunks) {
    engine.push({ index: chunk.startSec, durationSec: chunk.durationSec, blob: chunk.blob, startSec: chunk.startSec } as TranscribeChunk);
  }
  const summary: TranscriptionEngineSummary = await engine.close();
  const wallMs = performance.now() - t0;

  return {
    runIndex: 0,
    wallMs,
    completedChunks: summary.completedChunks,
    failedChunks: summary.failedChunks,
    counts: countRequests(records.slice(sliceStart)),
    segmentMeanMs: segmentMeanMs(records.slice(sliceStart))
  };
}

interface LevelReport {
  level: number;
  runs: LevelRun[];
  wallMean: number | null;
  segmentMeanMean: number | null;
  speedupVsPrev: number | null;
  speedupVsFirst: number | null;
  rateLimitedTotal: number;
  serverErrorTotal: number;
  completedTotal: number;
  chunkTotal: number;
}

interface SweepReport {
  meta: {
    generatedAt: string;
    model: string;
    audioName: string;
    audioSecondsUsed: number;
    chunkSeconds: number;
    chunksPerRun: number;
    runsPerLevel: number;
  };
  levels: LevelReport[];
  firstRateLimitedLevel: number | null;
  firstPlateauLevel: number | null;
}

function buildSweepReport(levels: LevelReport[], meta: SweepReport["meta"]): SweepReport {
  let firstRateLimitedLevel: number | null = null;
  let firstPlateauLevel: number | null = null;
  for (const l of levels) {
    if (firstRateLimitedLevel === null && l.rateLimitedTotal > 0) {
      firstRateLimitedLevel = l.level;
    }
    if (firstPlateauLevel === null && l.speedupVsPrev !== null && l.speedupVsPrev < 1.2) {
      firstPlateauLevel = l.level;
    }
  }
  return { meta, levels, firstRateLimitedLevel, firstPlateauLevel };
}

function renderMarkdown(report: SweepReport): string {
  const { meta } = report;
  const lines: string[] = [];
  lines.push("# ASR API 并发上限扫描报告");
  lines.push("");
  lines.push(`- 生成时间：${meta.generatedAt}`);
  lines.push(`- 模型：${meta.model}`);
  lines.push(`- 音频：${meta.audioName}（本次使用前 ${Math.round(meta.audioSecondsUsed / 60)} 分钟）`);
  lines.push(`- 片长：${meta.chunkSeconds} 秒/片，每片 ${meta.chunksPerRun} 片/次，每档跑 ${meta.runsPerLevel} 次`);
  lines.push("");
  lines.push("| 并发 | 墙钟均值ms | 段均均值ms | 相对上一档加速 | 相对首档加速 | 429 | 5xx | 完成片/总片 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const l of report.levels) {
    lines.push(
      `| ${l.level} | ${l.wallMean === null ? "FAIL" : Math.round(l.wallMean)}` +
      ` | ${l.segmentMeanMean === null ? "-" : Math.round(l.segmentMeanMean)}` +
      ` | ${l.speedupVsPrev === null ? "-" : l.speedupVsPrev.toFixed(2)}x` +
      ` | ${l.speedupVsFirst === null ? "-" : l.speedupVsFirst.toFixed(2)}x` +
      ` | ${l.rateLimitedTotal}` +
      ` | ${l.serverErrorTotal}` +
      ` | ${l.runs.reduce((s, r) => s + r.completedChunks, 0)}/${l.chunkTotal * l.runs.length} |`
    );
  }
  lines.push("");
  lines.push(`- 判读：首次 429 档位 = ${report.firstRateLimitedLevel ?? "未出现"}；墙钟疑似平台化首档（相对上一档加速 < 1.2x）= ${report.firstPlateauLevel ?? "未出现"}。`);
  lines.push("- 提示：并发低于上限时墙钟应近似按并发倍数下降；拐点之后墙钟平台化、段均被排队拉长、可能伴随 429。");
  lines.push("");
  return lines.join("\n");
}

function printSummaryTable(report: SweepReport): void {
  const header = "| 并发 | 墙钟均值ms | 段均均值ms | 相对上一档加速 | 相对首档加速 | 429 | 5xx |";
  const divider = "| --- | --- | --- | --- | --- | --- | --- |";
  const rows = report.levels.map((l) =>
    `| ${l.level} | ${l.wallMean === null ? "FAIL" : Math.round(l.wallMean)}` +
    ` | ${l.segmentMeanMean === null ? "-" : Math.round(l.segmentMeanMean)}` +
    ` | ${l.speedupVsPrev === null ? "-" : l.speedupVsPrev.toFixed(2) + "x"}` +
    ` | ${l.speedupVsFirst === null ? "-" : l.speedupVsFirst.toFixed(2) + "x"}` +
    ` | ${l.rateLimitedTotal} | ${l.serverErrorTotal} |`
  );
  console.log("\n并发扫描结果：\n" + [header, divider, ...rows].join("\n"));
  console.log(`\n判读：首次 429 档位 = ${report.firstRateLimitedLevel ?? "未出现"}；疑似平台化首档 = ${report.firstPlateauLevel ?? "未出现"}`);
  console.log("提示：并发低于上限时墙钟近似按倍数下降；拐点之后墙钟平台化、段均被排队拉长、可能伴随 429。");
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
  const chunks = allChunks.filter((c) => c.startSec < config.audioSeconds);
  if (chunks.length === 0) {
    console.error(`错误：音频切片结果为空，请确认 ${config.audioPath} 是标准 PCM WAV 文件。`);
    process.exit(1);
  }
  const usedSec = chunks.reduce((s, c) => s + c.durationSec, 0);
  console.log(`模型：${config.model}`);
  console.log(`音频：${config.audioPath}（本次取前 ${usedSec.toFixed(0)} 秒，切 ${chunks.length} 片，每片 ${config.chunkSeconds} 秒）`);
  console.log(`并发档位：${config.concurrencyLevels.join(" → ")}，每档 ${config.runsPerLevel} 次`);

  const realFetch = globalThis.fetch;
  const records: RequestTiming[] = [];
  const restoreFetch = installTimingFetch(realFetch, (t) => records.push(t));

  try {
    let modelsBody: unknown;
    try {
      const r = await realFetch(`${config.baseUrl}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
      if (!r.ok) {
        console.error(`错误：拉取模型列表失败：${config.baseUrl}/models 返回 HTTP ${r.status}`);
        process.exit(1);
      }
      modelsBody = await r.json();
    } catch (error) {
      console.error(`错误：拉取模型列表失败（${config.baseUrl}/models）：${(error as Error).message}`);
      process.exit(1);
    }
    const available = filterAvailableModels(modelsBody, [config.model]);
    if (available.length === 0) {
      console.error(`错误：模型 ${config.model} 不在平台在线名单中，无法扫描。`);
      process.exit(1);
    }

    const levels: LevelReport[] = [];
    for (const level of config.concurrencyLevels) {
      const runs: LevelRun[] = [];
      const sliceStart = records.length;
      for (let i = 0; i < config.runsPerLevel; i += 1) {
        const run = await runOnce(config.model, apiKey, config.baseUrl, chunks, level, records);
        run.runIndex = i;
        runs.push(run);
        console.log(
          `[并发 ${level}] 第 ${i + 1}/${config.runsPerLevel} 次：墙钟 ${Math.round(run.wallMs)}ms，` +
            `段均 ${run.segmentMeanMs === null ? "-" : Math.round(run.segmentMeanMs)}ms，` +
            `完成片 ${run.completedChunks}/${chunks.length}` +
            (run.counts.rateLimited > 0 ? `，429×${run.counts.rateLimited}` : "") +
            (run.counts.serverError > 0 ? `，5xx×${run.counts.serverError}` : "")
        );
        if (i < config.runsPerLevel - 1 && config.requestGapMs > 0) {
          await sleep(config.requestGapMs);
        }
      }
      const levelRecords = records.slice(sliceStart);
      const wallStats = summarizeRun(runs.map((r) => (r.completedChunks > 0 ? r.wallMs : null)));
      const segStats = summarizeRun(runs.map((r) => r.segmentMeanMs));
      levels.push({
        level,
        runs,
        wallMean: wallStats.mean,
        segmentMeanMean: segStats.mean,
        speedupVsPrev: null,
        speedupVsFirst: null,
        rateLimitedTotal: levelRecords.filter((t) => t.status === 429).length,
        serverErrorTotal: levelRecords.filter((t) => t.status >= 500).length,
        completedTotal: runs.reduce((s, r) => s + r.completedChunks, 0),
        chunkTotal: chunks.length
      });
      await sleep(LEVEL_COOLDOWN_MS);
    }

    const firstWall = levels.find((l) => l.wallMean !== null)?.wallMean ?? null;
    for (let i = 0; i < levels.length; i += 1) {
      const l = levels[i];
      if (l.wallMean === null) continue;
      if (firstWall !== null) l.speedupVsFirst = firstWall / l.wallMean;
      const prev = levels[i - 1];
      if (prev && prev.wallMean !== null && prev.completedTotal > 0) {
        l.speedupVsPrev = prev.wallMean / l.wallMean;
      }
    }

    const report = buildSweepReport(levels, {
      generatedAt: new Date().toISOString(),
      model: config.model,
      audioName: config.audioPath,
      audioSecondsUsed: usedSec,
      chunkSeconds: config.chunkSeconds,
      chunksPerRun: chunks.length,
      runsPerLevel: config.runsPerLevel
    });

    mkdirSync(config.outDir, { recursive: true });
    const reportBase = nextReportPath(config.outDir, "sweep-report", existsSync);
    writeFileSync(`${reportBase}.json`, JSON.stringify(report, null, 2), "utf8");
    writeFileSync(`${reportBase}.md`, renderMarkdown(report), "utf8");
    printSummaryTable(report);
    console.log(`\n报告已写入：${reportBase}.json 与 ${reportBase}.md`);
  } finally {
    restoreFetch();
  }
}

const isCliEntry = process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href;
if (isCliEntry) {
  main().catch((error) => {
    console.error(`并发扫描失败：${(error as Error)?.message || error}`);
    process.exit(1);
  });
}
