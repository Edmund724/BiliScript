// scripts/artifacts/gen-chip-source.ts
// 面板档位 chip 的三层来源清单 + 逐 preset × 代表模型的 chip 集合：
//   .scratch/tickets/upstream-model-facts/artifacts/06-chip-source.tsv   逐条来源清单
//   .scratch/tickets/upstream-model-facts/artifacts/06-chip-sets.tsv     代表模型的 chip 集合
//   .scratch/tickets/upstream-model-facts/artifacts/06-chip-changes.tsv  平台声明 → A' 变化清单
//
// 口径：
// - chip 集合 = resolveThinkingAdjustment().availableLevels（= availableLevelsOf(rule) = A'），
//   与请求落线同一次解析——本脚本不自建第二套档位推导，只把同一次解析的结果分类汇总。
// - A' = 上游逐模型词表在平台已登记方言下可表达的部分；本脚本按解析分支分层。
// - 层（layer）= 解析分支（source）+ 02 产物的构建期借词事实：
//     ① upstream-direct      上游逐模型词表直接命中（02 矩阵 source == direct）
//     ② upstream-borrowed    无词表行按 canonical_model_id / 别名表借到词表
//        （02 矩阵 source == canonical:<id> / alias:<id>，逐条记进 upstreamSource）
//     ③ fallback-handwritten 借不到 / 无上游平台 → 手写表（ollama / custom / 上游缺口）
//     ④ fallback-unknown     无结论（fail-closed，三档不发）
// - 行集 = 有上游 provider 的 preset ×（02 指派表全量模型 ∪ 别名表模型 ∪ 02 矩阵
//   的全部 reasoning 模型，含无词表缺口）+ 2 个无上游探针（ollama / custom）。
// - preset → 上游 provider 一律读单源 scripts/models-dev-upstream-providers.mjs
//   （从 presets.ts 的 PRESETS[].catalogProvider 取值并校验完整性，漏配即生成期报错）。
// - 02 矩阵（02-valueset-matrix.tsv）只读消费（source 列）；上游快照不重读。
//
// 跑法：pnpm artifacts:sync（编排见 scripts/artifacts/sync.mjs）。

import { readFileSync, writeFileSync } from "node:fs";
import {
  ASSIGNMENTS,
  MODEL_ID_ALIASES,
  lookupThinkingFact
} from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import {
  resolveThinkingAdjustment,
  type ThinkingRuleSource
} from "../../extension/ai/thinking-profiles.js";
import { PRESETS } from "../../extension/core/presets.js";
import { UPSTREAM_PROVIDER_BY_PRESET } from "../models-dev-upstream-providers.mjs";

const ARTIFACTS = ".scratch/tickets/upstream-model-facts/artifacts";
const MATRIX_02 = `${ARTIFACTS}/02-valueset-matrix.tsv`;

// 02 矩阵的 (provider, modelId) → source 列（direct / canonical:<id> / alias:<id> / 空）。
function read02Sources(): Map<string, string> {
  const sources = new Map<string, string>();
  const lines = readFileSync(MATRIX_02, "utf8").split("\n").filter((line) => line.length > 0);
  const header = lines[0].split("\t");
  const providerAt = header.indexOf("provider");
  const modelAt = header.indexOf("modelId");
  const sourceAt = header.indexOf("source");
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    sources.set(`${cells[providerAt]}\u0001${cells[modelAt]}`, cells[sourceAt] ?? "");
  }
  return sources;
}

const SOURCES = read02Sources();

// 别名折叠：上游 (provider, modelId) → 本仓口径 id（同一个模型只出一行）。
function localIdOf(provider: string, modelId: string): string {
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.upstream === `${provider}/${modelId}`) return alias.localId;
  }
  return modelId;
}

interface Row {
  preset: string;
  upstreamProvider: string;
  model: string;
  baseUrl: string;
}

const rows: Row[] = [];

for (const preset of PRESETS) {
  const upstreamProvider = UPSTREAM_PROVIDER_BY_PRESET[preset.id];
  if (!upstreamProvider) continue;
  const models = new Set<string>();
  for (const modelId of Object.keys(ASSIGNMENTS[upstreamProvider] ?? {})) {
    models.add(localIdOf(upstreamProvider, modelId));
  }
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider === upstreamProvider) models.add(alias.localId);
  }
  // 02 矩阵的全量 reasoning 模型（含无词表缺口；provider 键 = 上游 provider id）
  for (const key of SOURCES.keys()) {
    const [provider, modelId] = key.split("\u0001");
    if (provider === upstreamProvider) models.add(localIdOf(upstreamProvider, modelId));
  }
  for (const model of models) {
    rows.push({ preset: preset.id, upstreamProvider, model, baseUrl: preset.baseUrl });
  }
}

// 无上游平台探针（custom 的端点无身份，baseUrl 是形状）。
const PROBES: ReadonlyArray<Row> = [
  { preset: "ollama", upstreamProvider: "", model: "llama3.2", baseUrl: "http://localhost:11434/v1" },
  { preset: "ollama", upstreamProvider: "", model: "deepseek-r1:8b", baseUrl: "http://localhost:11434/v1" },
  { preset: "custom", upstreamProvider: "", model: "vendor-future-1", baseUrl: "https://api.example.com/v1" },
  { preset: "custom", upstreamProvider: "", model: "gpt-5.1", baseUrl: "https://api.example.com/v1" },
  { preset: "custom", upstreamProvider: "", model: "deepseek-v4-pro", baseUrl: "https://api.example.com/v1" }
];
rows.push(...PROBES);

rows.sort((a, b) => (a.preset === b.preset ? a.model.localeCompare(b.model) : a.preset.localeCompare(b.preset)));

interface Resolved {
  layer: string;
  upstreamSource: string;
  valuesetId: string;
  levels: string;
  source: ThinkingRuleSource;
}

function resolveRow(row: Row): Resolved {
  const adjustment = resolveThinkingAdjustment({
    presetId: row.preset,
    baseUrl: row.baseUrl,
    model: row.model,
    level: "off",
    stream: true
  });
  const fact = row.upstreamProvider ? lookupThinkingFact(row.upstreamProvider, row.model) : null;
  const upstreamSource = row.upstreamProvider ? SOURCES.get(`${row.upstreamProvider}\u0001${row.model}`) ?? "" : "";
  let layer: string;
  if (adjustment.source === "upstream") {
    layer =
      upstreamSource.startsWith("canonical:") || upstreamSource.startsWith("alias:")
        ? "upstream-borrowed"
        : "upstream-direct";
  } else if (adjustment.source === "handwritten") {
    layer = "fallback-handwritten";
  } else {
    layer = "fallback-unknown";
  }
  const resolved: Resolved = {
    layer,
    upstreamSource,
    valuesetId: fact?.valuesetId ?? "",
    levels: adjustment.availableLevels.length > 0 ? adjustment.availableLevels.join(",") : "-",
    source: adjustment.source
  };
  return resolved;
}

const resolvedRows = rows.map((row) => ({ row, resolved: resolveRow(row) }));

// ===== 06-chip-source.tsv（三层来源清单，逐条）=====
// upstreamSource 列 = 02 产物的构建期结论（direct / canonical:<id> / alias:<id>）。
const SOURCE_HEADER = ["preset", "upstreamProvider", "model", "layer", "upstreamSource", "upstreamValuesetId", "availableLevels"];
const sourceLines = [SOURCE_HEADER.join("\t")];
for (const { row, resolved } of resolvedRows) {
  sourceLines.push(
    [
      row.preset,
      row.upstreamProvider || "-",
      row.model,
      resolved.layer,
      resolved.upstreamSource || "-",
      resolved.valuesetId || "-",
      resolved.levels
    ].join("\t")
  );
}
writeFileSync(`${ARTIFACTS}/06-chip-source.tsv`, `${sourceLines.join("\n")}\n`, "utf8");

// ===== 06-chip-sets.tsv（逐 preset × 代表模型的 chip 集合）=====
// 代表模型：全部 none-high 行 + 全部借词行 + 全部无结论行 + 无上游探针全部
// + 每个 preset 每种层各取字典序第一条。case 列写清入选理由（可审）。
const representatives: Array<{ row: Row; case: string }> = [];
const seen = new Set<string>();
function add(row: Row, reason: string): void {
  const key = `${row.preset}\u0001${row.model}`;
  if (seen.has(key)) return;
  seen.add(key);
  representatives.push({ row, case: reason });
}

for (const { row, resolved } of resolvedRows) {
  if (resolved.valuesetId === "none-high") add(row, "none/high 值集（验收第一条：上游投影 {off,high}）");
  if (resolved.layer === "upstream-borrowed") add(row, `借词（${resolved.upstreamSource}）`);
  if (resolved.layer === "fallback-unknown") add(row, "无结论（fail-closed）");
}
for (const row of PROBES) add(row, "无上游平台探针");
for (const presetId of new Set(rows.map((row) => row.preset))) {
  for (const layer of ["upstream-direct", "fallback-handwritten"]) {
    const hit = resolvedRows.find((item) => item.row.preset === presetId && item.resolved.layer === layer);
    if (hit) add(hit.row, `preset ${presetId} 的 ${layer} 代表`);
  }
}
representatives.sort((a, b) => (a.row.preset === b.row.preset ? a.row.model.localeCompare(b.row.model) : a.row.preset.localeCompare(b.row.preset)));

const SET_HEADER = ["preset", "model", "case", "source", "layer", "availableLevels", "chips"];
const setLines = [SET_HEADER.join("\t")];
for (const { row, case: reason } of representatives) {
  const resolved = resolveRow(row);
  setLines.push(
    [
      row.preset,
      row.model,
      reason,
      resolved.source,
      resolved.layer,
      resolved.levels,
      resolved.levels === "-" ? "(none)" : resolved.levels.split(",").join("/")
    ].join("\t")
  );
}
writeFileSync(`${ARTIFACTS}/06-chip-sets.tsv`, `${setLines.join("\n")}\n`, "utf8");

// ===== 06-chip-changes.tsv（chip 集合变化清单：平台声明档位 → A'）=====
// 平台级 override 声明机制已删，本清单的定义域（平台声明 ∩ 上游词表）整体消失：
// 所有有上游词表的模型的 A' 就是该模型上游词表的写点集，「声明 → A'」的收窄不再存在。
// 故本文件仅表头（0 行），随机制一并退役。
const CHANGE_HEADER = ["preset", "model", "layer", "upstreamValuesetId", "platformLevels", "availableLevels", "reason"];
const changeLines = [CHANGE_HEADER.join("\t")];
let changeCount = 0;
writeFileSync(`${ARTIFACTS}/06-chip-changes.tsv`, `${changeLines.join("\n")}\n`, "utf8");

// ===== 控制台摘要（报告用数字）=====
const layerCounts = new Map<string, number>();
for (const { resolved } of resolvedRows) {
  layerCounts.set(resolved.layer, (layerCounts.get(resolved.layer) ?? 0) + 1);
}
const sourceCounts = new Map<string, number>();
for (const { resolved } of resolvedRows) {
  sourceCounts.set(resolved.source, (sourceCounts.get(resolved.source) ?? 0) + 1);
}
const chipDist = new Map<string, number>();
for (const { resolved } of resolvedRows) {
  chipDist.set(resolved.levels, (chipDist.get(resolved.levels) ?? 0) + 1);
}
console.log(`06-chip-source.tsv: ${resolvedRows.length} 行`);
console.log("层：", JSON.stringify(Object.fromEntries([...layerCounts].sort())));
console.log("解析来源：", JSON.stringify(Object.fromEntries([...sourceCounts].sort())));
console.log("chip 集合分布：");
for (const [levels, count] of [...chipDist].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count}\t${levels}`);
}
console.log(`06-chip-sets.tsv: ${representatives.length} 行`);
console.log(`06-chip-changes.tsv: ${changeCount} 行（平台声明层已删，退化为仅表头）`);
