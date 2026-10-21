// scripts/artifacts/gen-request-matrix.ts
// 请求体矩阵生成器：覆盖平台 × 模型 → 两通道 × 三档的请求体矩阵
// （.scratch/tickets/upstream-model-facts/artifacts/06-request-matrix.tsv）。
//
// 口径：
// - 平台 = 有上游 provider 的 AI preset（presetId 驱动，runtime 的真实入参形状）
//   + 无上游探针（openai / siliconflow / doubao / ollama / custom：baseUrl 驱动），
//   无上游探针只为在同一份工件里提供「逐字节不变」的对照行。
// - preset → 上游 provider 一律读单源 scripts/models-dev-upstream-providers.mjs
//   （它从 extension/core/presets.ts 的 PRESETS[].catalogProvider 取值并校验完整性，
//   新增 preset 漏配在生成期直接报错）。
// - 模型 = 02 产物 ASSIGNMENTS 的 (provider, modelId) 全集；有别名时用**本仓口径 id**
//   （MODEL_ID_ALIASES 的 localId）替上游 id（同一个模型只出一行，避免别名行重复计数）。
// - 三档 = off / low / high。
// - 行 = 一个 (平台, 模型)：openai 通道三档请求体 + anthropic 通道三档请求体 +
//   解析结果标记（offUnavailable/offFallback/thinkingClass，UI 的消费面）。
// - 请求体去掉 messages / stream 两个常量键（噪声），其余逐字节原样 JSON.stringify
//   （键序即 adapter 的构造序，稳定）。
//
// 跑法：pnpm artifacts:sync（编排见 scripts/artifacts/sync.mjs）；单跑：
//   node node_modules/.artifacts-sync/gen-request-matrix.mjs --out <目标.tsv>

import { writeFileSync } from "node:fs";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { buildChatRequestBody } from "../../extension/ai/adapters/openai.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import {
  ASSIGNMENTS,
  MODEL_ID_ALIASES
} from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { resolveThinkingProfile } from "../../extension/ai/thinking-profiles.js";
import { PRESETS } from "../../extension/core/presets.js";
import type { ChatMessage } from "../../extension/ai/types.js";
import { UPSTREAM_PROVIDER_BY_PRESET } from "../models-dev-upstream-providers.mjs";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];
const LEVELS = ["off", "low", "high"] as const;

// 无上游探针（基线对照）：baseUrl 驱动，presetId 留空或给 preset。
const UPSTREAM_FREE_PROBES: Array<{ presetId?: string; baseUrl: string; models: string[] }> = [
  { baseUrl: "https://api.openai.com/v1", models: ["gpt-5.1", "o3", "gpt-4o"] },
  { baseUrl: "https://api.siliconflow.cn/v1", models: ["Qwen/Qwen2.5-72B-Instruct", "qwen3-max"] },
  { baseUrl: "https://api.doubao.com/v1", models: ["doubao-seed-1.6", "skylark-2-pro"] },
  { presetId: "ollama", baseUrl: "http://localhost:11434/v1", models: ["llama3.2", "deepseek-r1:8b"] },
  { presetId: "custom", baseUrl: "https://api.example.com/v1", models: ["vendor-future-1"] }
];

// 别名折叠：上游 (provider, modelId) → 本仓口径 id（同一模型只出一行）。
function localIdOf(provider: string, modelId: string): string {
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.upstream === `${provider}/${modelId}`) return alias.localId;
  }
  return modelId;
}

function bodyCell(body: Record<string, unknown>): string {
  const trimmed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === "messages" || key === "stream") continue;
    trimmed[key] = value;
  }
  return JSON.stringify(trimmed);
}

function resCell(presetId: string | undefined, baseUrl: string, model: string, level: string): string {
  const r = resolveThinkingProfile({ presetId, baseUrl, model, level, stream: false });
  return `${r.offUnavailable ? 1 : 0}|${r.offFallback ?? "-"}|${r.thinkingClass}`;
}

interface Row {
  platform: string;
  presetId?: string;
  baseUrl: string;
  model: string;
}

const rows: Row[] = [];

for (const preset of PRESETS) {
  const upstreamId = UPSTREAM_PROVIDER_BY_PRESET[preset.id];
  if (!upstreamId) continue;
  const table = ASSIGNMENTS[upstreamId];
  const models = new Set<string>();
  for (const modelId of Object.keys(table ?? {})) {
    models.add(localIdOf(upstreamId, modelId));
  }
  // 只有别名、没有直接指派的模型（如 moonshot 的 kimi-k2.6 → moonshotai/kimi-k2.6）：
  // 上游 id 不在该 provider 的指派表里，但本仓口径 id 可查。
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider === upstreamId) models.add(alias.localId);
  }
  for (const model of models) {
    rows.push({ platform: preset.id, presetId: preset.id, baseUrl: preset.baseUrl, model });
  }
}

for (const probe of UPSTREAM_FREE_PROBES) {
  for (const model of probe.models) {
    rows.push({
      platform: probe.presetId ?? new URL(probe.baseUrl).hostname,
      presetId: probe.presetId,
      baseUrl: probe.baseUrl,
      model
    });
  }
}

rows.sort((a, b) => (a.platform === b.platform ? a.model.localeCompare(b.model) : a.platform.localeCompare(b.platform)));

const HEADER = [
  "platform",
  "model",
  "openai:off",
  "openai:low",
  "openai:high",
  "anthropic:off",
  "anthropic:low",
  "anthropic:high",
  "res:off",
  "res:low",
  "res:high"
];

const lines: string[] = [HEADER.join("\t")];
for (const row of rows) {
  const cells: string[] = [row.platform, row.model];
  for (const level of LEVELS) {
    cells.push(
      bodyCell(
        buildChatRequestBody({
          model: row.model,
          messages: MESSAGES,
          stream: false,
          // 思考线格式产出按生产同一口径先跑装配边（生产唯一调用点是 completion.ts
          // 的 fetch 点），再注入请求构造。
          thinkingWire: planThinkingWire({
            protocol: "openai",
            model: row.model,
            presetId: row.presetId,
            baseUrl: row.baseUrl,
            level,
            stream: false,
            probe: false
          }),
          maxTokens: 2048
        }) as Record<string, unknown>
      )
    );
  }
  for (const level of LEVELS) {
    cells.push(
      bodyCell(
        anthropicAdapter.buildBody({
          model: row.model,
          messages: MESSAGES,
          stream: false,
          thinkingWire: planThinkingWire({
            protocol: "anthropic",
            model: row.model,
            presetId: row.presetId,
            baseUrl: row.baseUrl,
            level,
            stream: false,
            probe: false
          }),
          maxTokens: 2048
        })
      )
    );
  }
  for (const level of LEVELS) {
    cells.push(resCell(row.presetId, row.baseUrl, row.model, level));
  }
  lines.push(cells.join("\t"));
}

const text = `${lines.join("\n")}\n`;
const outIndex = process.argv.indexOf("--out");
if (outIndex >= 0 && process.argv[outIndex + 1]) {
  writeFileSync(process.argv[outIndex + 1], text, "utf8");
} else {
  process.stdout.write(text);
}
