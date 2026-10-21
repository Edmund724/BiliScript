// tests/ai/thinking-golden-classes.ts
// 07 号票（golden 按类重构）的**纯数据件**：产物枚举、出口形态命名、工件解析、覆盖矩阵口径、
// 三条通道的调用缝。刻意不 import vitest/expect——同一份枚举与调用缝要同时服务 golden
// 用例与生成器（scripts/artifacts/gen-golden-tables.ts）；生成器是 node 脚本，不能把
// vitest 塞进它的 bundle。断言注册在 thinking-golden-defenses.ts。
//
// 口径（与 scripts/artifacts/gen-request-matrix.ts 逐字同源）：
// - 平台 = UPSTREAM_PROVIDER_BY_PRESET 的 12 家（preset → 上游 provider）；
// - 模型 = 02 指派表 ASSIGNMENTS 的 (provider, modelId)，有别名时换成本仓口径 localId
//   （MODEL_ID_ALIASES），保证与矩阵工件的行键逐字一致；
// - 类 = 值集 id（02 产物 VALUESETS 的键）；
// - 「实现」= (类, 平台) 对，每对取排序首个模型做代表——用例只按类 × 出口形态写，
//   每个实现的行为由归纳完整性防线扫（见 thinking-golden-defenses.ts 的 F2）。
// - gemini 通道只承载 `protocol: "gemini"` 的预设（目前只有 gemini 一家）：其它平台
//   不会用这条协议发请求，跨协议组合不是产品路径。

import { readFileSync } from "node:fs";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { geminiAdapter } from "../../extension/ai/adapters/gemini.js";
import { buildChatRequestBody } from "../../extension/ai/adapters/openai.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import { ASSIGNMENTS, MODEL_ID_ALIASES, VALUESETS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { AI_THINKING_LEVELS, UPSTREAM_PROVIDER_BY_PRESET, type ThinkingLevel } from "../../extension/ai/thinking-profiles.js";
import { DEFAULT_MAX_TOKENS } from "../../extension/ai/output-budget.js";
import type { ChatMessage } from "../../extension/ai/types.js";
import { PRESETS } from "../../extension/core/presets.js";

const ARTIFACTS = ".scratch/tickets/upstream-model-facts/artifacts";
/** gen-request-matrix.ts 的产物（pnpm artifacts:sync 跑出；只读）——来源防线（F3）的对账对象。 */
export const REQUEST_MATRIX = `${ARTIFACTS}/06-request-matrix.tsv`;
/** 本票（07）的验收工件：valuesetId × 通道 × 出口形态 → 用例归属。 */
export const COVERAGE_MATRIX = `${ARTIFACTS}/07-golden-coverage.tsv`;

/** 三条通道共用的请求消息常量（与既有 golden 逐字一致）。 */
const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

export type Channel = "openai" | "anthropic" | "gemini";

/**
 * 按类 golden 用例 = 类（值集 id）× 出口形态（该实现真实落线的线格式）→ 7 档请求字段。
 * 一个用例承载一个 (类, 出口形态) 组合；同组合的其它平台/模型由 F2 防线扫。
 */
export interface ByClassCase {
  readonly valuesetId: string;
  readonly presetId: string;
  readonly model: string;
  /** 该实现（代表模型）的可用集 A'，档位序；空 = 无档可落（不发思考参数）。 */
  readonly available: readonly ThinkingLevel[];
  /** 7 档逐字节期望的思考字段片段，序 = AI_THINKING_LEVELS；{} = 不发任何字段。 */
  readonly fields: readonly Record<string, unknown>[];
}

/** 产物里一个 (类, 平台) 实现（代表模型 = 排序首个，确定性）。 */
export interface Realization {
  readonly valuesetId: string;
  readonly presetId: string;
  readonly upstreamId: string;
  /** 本仓/矩阵口径的模型 id（别名折叠后）。 */
  readonly model: string;
}

/** 上游 (provider, modelId) → 本仓口径 localId（别名折叠，同 gen-request-matrix.ts）。 */
function localIdOf(upstreamId: string, modelId: string): string {
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.upstream === `${upstreamId}/${modelId}`) return alias.localId;
  }
  return modelId;
}

/** 该 (平台, 模型) 命中的值集 id（指派表精确 → 折叠大小写 → 别名表，与 runtime 同序）。 */
export function valuesetOf(upstreamId: string, model: string): string | undefined {
  const table = ASSIGNMENTS[upstreamId] ?? {};
  const exact = table[model];
  if (exact) return exact;
  const folded = model.toLowerCase();
  for (const candidate of Object.keys(table)) {
    if (candidate.toLowerCase() === folded) return table[candidate];
  }
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.provider === upstreamId && alias.localId.toLowerCase() === folded) return alias.valuesetId;
  }
  return undefined;
}

/**
 * 产物里的全部 (类, 平台) 实现：指派表 + 别名表指向的 localId，按 (preset, model) 排序后
 * 每个 (类, 平台) 对取首个模型。这是「哪些行为被 golden 按类承载」的枚举底座。
 */
export function productRealizations(): Realization[] {
  const first = new Map<string, Realization>();
  for (const [presetId, upstreamId] of Object.entries(UPSTREAM_PROVIDER_BY_PRESET)) {
    const table = ASSIGNMENTS[upstreamId];
    if (!table) continue;
    const models = new Set<string>();
    for (const modelId of Object.keys(table)) models.add(localIdOf(upstreamId, modelId));
    // 只有别名、没有直接指派的模型（如 moonshot 的 kimi-k2.6）也要进枚举。
    for (const alias of MODEL_ID_ALIASES) {
      if (alias.provider === upstreamId) models.add(alias.localId);
    }
    for (const model of [...models].sort()) {
      const valuesetId = valuesetOf(upstreamId, model);
      if (!valuesetId) continue;
      const key = `${valuesetId}\u0001${presetId}`;
      if (!first.has(key)) first.set(key, { valuesetId, presetId, upstreamId, model });
    }
  }
  return [...first.values()].sort((a, b) =>
    a.presetId === b.presetId ? a.model.localeCompare(b.model) : a.presetId.localeCompare(b.presetId)
  );
}

/** 通道能承载的实现：gemini 协议只由 `protocol: "gemini"` 的预设发出。 */
export function productRealizationsFor(channel: Channel): Realization[] {
  if (channel !== "gemini") return productRealizations();
  return productRealizations().filter(
    (realization) => PRESETS.find((preset) => preset.id === realization.presetId)?.protocol === "gemini"
  );
}

/** 该通道的落地值集集合（F1 覆盖防线的右侧）：gemini 只看自家预设的实现。 */
export function channelValuesetIds(channel: Channel): string[] {
  if (channel !== "gemini") return allValuesetIds();
  return [...new Set(productRealizationsFor(channel).map((realization) => realization.valuesetId))].sort();
}

/** 通道的 baseUrl 口径：anthropic 取 protocolBaseUrls.anthropic（缺省回落 baseUrl）。 */
export function baseUrlFor(channel: Channel, presetId: string): string {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`PRESETS 未登记预设：${presetId}`);
  return channel === "anthropic" ? (preset.protocolBaseUrls?.anthropic ?? preset.baseUrl) : preset.baseUrl;
}

/** 通道调用缝的入参（presetId 主路径；baseUrl 驱动的无 preset 平台如 openai/siliconflow/doubao）。 */
export interface BodyRequest {
  readonly presetId?: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly level: ThinkingLevel;
  readonly stream?: boolean;
  readonly maxTokens?: number;
  /** 探针变体：只有 anthropic 缝消费（Messages 行的 probeOmitsThinking 早退）。 */
  readonly probe?: boolean;
}

/**
 * 通道缝：各通道自己的 adapter 调用形状。bodyAt 是**唯一**的运行期入口——golden 断言、
 * 防线、塌陷判据都从它取片段，口径不会分叉。expectedBody 是同一形状的期望包装（该通道的
 * 常量键 + 片段），供用例逐字节整 body 比对（不做包含式）。fragmentOf 从整 body 里取出
 * **思考字段片段**（gemini 的思考字段嵌在 generationConfig 里，不能按顶层键剥）。
 */
export interface ChannelHarness {
  readonly channel: Channel;
  bodyAt: (request: BodyRequest) => Record<string, unknown>;
  expectedBody: (model: string, fields: Record<string, unknown>) => Record<string, unknown>;
  fragmentOf: (body: Record<string, unknown>) => Record<string, unknown>;
}

export function channelHarness(channel: Channel): ChannelHarness {
  if (channel === "openai") {
    return {
      channel,
      // 思考线格式产出由装配边（planThinkingWire）按生产同一口径先算好再注入请求构造
      //（生产唯一调用点是 completion.ts 的 fetch 点）。openai 行不读 probe：本缝
      //「探针不发思考字段」靠请求侧归一（探针不传档位 → default 不干预 → 空 patch，
      // 2026-10-05 裁定见 docs/adr/0015 修订块）；probeOmitsThinking 是 Messages 侧事实
      //（装配边 anthropic 行的探针早退）。
      bodyAt: ({ presetId, baseUrl, model, level, stream = false, maxTokens }) => {
        const resolvedBaseUrl = baseUrl ?? (presetId ? baseUrlFor(channel, presetId) : undefined);
        return buildChatRequestBody({
          model,
          messages: MESSAGES,
          stream,
          thinkingWire: planThinkingWire({ protocol: "openai", model, presetId, baseUrl: resolvedBaseUrl, level, stream, probe: false }),
          ...(maxTokens != null ? { maxTokens } : {})
        }) as Record<string, unknown>;
      },
      expectedBody: (model, fields) => ({ model, messages: MESSAGES, stream: false, ...fields }),
      fragmentOf: thinkingFragment
    };
  }
  if (channel === "gemini") {
    return {
      channel,
      bodyAt: ({ presetId, baseUrl, model, level, stream = false, maxTokens }) => {
        const resolvedBaseUrl = baseUrl ?? (presetId ? baseUrlFor(channel, presetId) : undefined);
        return geminiAdapter.buildBody({
          model,
          messages: MESSAGES,
          stream,
          thinkingWire: planThinkingWire({ protocol: "gemini", model, presetId, baseUrl: resolvedBaseUrl, level, stream, probe: false }),
          ...(maxTokens != null ? { maxTokens } : {})
        }) as Record<string, unknown>;
      },
      // contents 由 MESSAGES 的 user 单条转换而来（与 adapter 的角色转换无关的常量键）；
      // 思考字段落 generationConfig.thinkingConfig，无字段时整块 generationConfig 不发射。
      expectedBody: (model, fields) => {
        const thinkingConfig = fields.thinkingConfig;
        return {
          contents: [{ role: "user", parts: [{ text: "hi" }] }],
          ...(thinkingConfig ? { generationConfig: { thinkingConfig } } : {})
        };
      },
      fragmentOf: (body) => {
        const generationConfig = body.generationConfig as Record<string, unknown> | undefined;
        return generationConfig?.thinkingConfig ? { thinkingConfig: generationConfig.thinkingConfig } : {};
      }
    };
  }
  return {
    channel,
    bodyAt: ({ presetId, baseUrl, model, level, stream = false, maxTokens, probe = false }) => {
      const resolvedBaseUrl = baseUrl ?? (presetId ? baseUrlFor(channel, presetId) : "");
      return anthropicAdapter.buildBody({
        model,
        messages: MESSAGES,
        stream,
        thinkingWire: planThinkingWire({ protocol: "anthropic", model, presetId, baseUrl: resolvedBaseUrl, level, stream, probe }),
        // adapter 默认 max_tokens 走 DEFAULT_MAX_TOKENS（32768）——用例字面钉住该值。
        ...(maxTokens != null ? { maxTokens } : {})
      }) as Record<string, unknown>;
    },
    expectedBody: (model, fields) => ({ model, messages: MESSAGES, stream: false, max_tokens: DEFAULT_MAX_TOKENS, ...fields }),
    fragmentOf: thinkingFragment
  };
}

/**
 * 出口形态命名（票面六种出口的机械写法）：由**实际发出去的字段组合**命名，不手抄。
 * 例：`thinking:enabled+output_config.effort:medium` / `enable_thinking:true` / `none`。
 * gemini 的关思考靠 includeThoughts:false 表达，单独进名字，避免与开档同形。
 */
export function exitFormOf(fields: Record<string, unknown>): string {
  const parts: string[] = [];
  const thinking = fields.thinking as { type?: unknown } | undefined;
  if (thinking) parts.push(`thinking:${String(thinking.type)}`);
  if (fields.enable_thinking !== undefined) parts.push(`enable_thinking:${fields.enable_thinking ? "true" : "false"}`);
  if (fields.reasoning_effort !== undefined) parts.push(`reasoning_effort:${String(fields.reasoning_effort)}`);
  const outputConfig = fields.output_config as { effort?: unknown } | undefined;
  if (outputConfig) parts.push(`output_config.effort:${String(outputConfig.effort)}`);
  const thinkingConfig = fields.thinkingConfig as { thinkingLevel?: unknown; includeThoughts?: unknown } | undefined;
  if (thinkingConfig) {
    parts.push(`thinkingConfig.thinkingLevel:${String(thinkingConfig.thinkingLevel)}`);
    if (thinkingConfig.includeThoughts === false) parts.push("includeThoughts:false");
  }
  return parts.length > 0 ? parts.join("+") : "none";
}

/** 请求体里与思考无关的包装键（矩阵工件保留了 model 与 token 上限，去掉后才是思考片段）。 */
const BODY_WRAPPER_KEYS = ["model", "messages", "stream", "max_tokens", "max_completion_tokens"];

export function thinkingFragment(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (BODY_WRAPPER_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/** 矩阵工件的单元格（JSON 文本）→ 思考字段片段。 */
export function thinkingFragmentOfCell(cell: string): Record<string, unknown> {
  return thinkingFragment(JSON.parse(cell) as Record<string, unknown>);
}

/** 按通道取思考片段（gemini 的字段嵌在 generationConfig 里）。 */
export function thinkingFragmentFor(channel: Channel, body: Record<string, unknown>): Record<string, unknown> {
  return channelHarness(channel).fragmentOf(body);
}

export function thinkingFragmentOfCellFor(channel: Channel, cell: string): Record<string, unknown> {
  return thinkingFragmentFor(channel, JSON.parse(cell) as Record<string, unknown>);
}

export interface RequestMatrix {
  readonly header: readonly string[];
  /** `${platform}\u0001${model}` → 单元格文本（列名见 header）。 */
  readonly rows: ReadonlyMap<string, readonly string[]>;
}

function parseRequestMatrix(text: string): RequestMatrix {
  const lines = text.split("\n").filter((line) => line.length > 0);
  const header = lines[0].split("\t");
  const rows = new Map<string, readonly string[]>();
  for (const line of lines.slice(1)) {
    const cells = line.split("\t");
    rows.set(`${cells[0]}\u0001${cells[1]}`, cells);
  }
  return { header, rows };
}

export function readRequestMatrix(path: string = REQUEST_MATRIX): RequestMatrix {
  return parseRequestMatrix(readFileSync(path, "utf8"));
}

/** 值集表全部键（覆盖防线 F1 的右侧）。 */
export function allValuesetIds(): string[] {
  return Object.keys(VALUESETS).sort();
}

/** 指派表实际用到的值集 id 集合（产物自洽判据：值集表不该有孤儿）。 */
export function assignedValuesetIds(): string[] {
  const used = new Set<string>();
  for (const table of Object.values(ASSIGNMENTS)) {
    for (const valuesetId of Object.values(table)) used.add(valuesetId);
  }
  return [...used].sort();
}

/** 用例表里覆盖到的值集 id 集合。 */
export function coveredValuesetIds(cases: readonly ByClassCase[]): string[] {
  return [...new Set(cases.map((c) => c.valuesetId))].sort();
}

/** 用例的 7 档片段签名（同签名 = 同一出口形态组合，用于归纳完整性对账 F2）。 */
export function fieldsSignature(fields: readonly Record<string, unknown>[]): string {
  return JSON.stringify(fields);
}

/** 覆盖矩阵表头（生成器与 F4 防线共用；改这里两边一起改）。 */
export const COVERAGE_HEADER = [
  "valuesetId",
  "channel",
  "level",
  "exitForm",
  "presetId",
  "model",
  "inAvailableSet",
  "caseTitle"
] as const;

/** 覆盖矩阵的期望行：valuesetId × 通道 × 档位（出口形态）→ 用例归属。 */
export function coverageRows(channel: Channel, cases: readonly ByClassCase[]): string[] {
  const rows: string[] = [];
  for (const case_ of cases) {
    for (const level of AI_THINKING_LEVELS) {
      const index = AI_THINKING_LEVELS.indexOf(level);
      rows.push(
        [
          case_.valuesetId,
          channel,
          level,
          exitFormOf(case_.fields[index]),
          case_.presetId,
          case_.model,
          case_.available.includes(level) ? "1" : "0",
          `${case_.valuesetId} · ${case_.presetId}/${case_.model}`
        ].join("\t")
      );
    }
  }
  return rows;
}
