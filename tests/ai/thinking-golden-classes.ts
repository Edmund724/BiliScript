import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { geminiAdapter } from "../../extension/ai/adapters/gemini.js";
import { buildChatRequestBody } from "../../extension/ai/adapters/openai.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import { ASSIGNMENTS, MODEL_ID_ALIASES, VALUESETS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { AI_THINKING_LEVELS, UPSTREAM_PROVIDER_BY_PRESET, type ThinkingLevel } from "../../extension/ai/thinking-profiles.js";
import { DEFAULT_MAX_TOKENS } from "../../extension/ai/output-budget.js";
import type { ChatMessage } from "../../extension/ai/types.js";
import { PRESETS } from "../../extension/core/presets.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

export type Channel = "openai" | "anthropic" | "gemini";

export interface ByClassCase {
  readonly valuesetId: string;
  readonly presetId: string;
  readonly model: string;
  readonly available: readonly ThinkingLevel[];
  readonly fields: readonly Record<string, unknown>[];
}

export interface Realization {
  readonly valuesetId: string;
  readonly presetId: string;
  readonly upstreamId: string;
  readonly model: string;
}

function localIdOf(upstreamId: string, modelId: string): string {
  for (const alias of MODEL_ID_ALIASES) {
    if (alias.upstream === `${upstreamId}/${modelId}`) return alias.localId;
  }
  return modelId;
}

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

export function productRealizations(): Realization[] {
  const first = new Map<string, Realization>();
  for (const [presetId, upstreamId] of Object.entries(UPSTREAM_PROVIDER_BY_PRESET)) {
    const table = ASSIGNMENTS[upstreamId];
    if (!table) continue;
    const models = new Set<string>();
    for (const modelId of Object.keys(table)) models.add(localIdOf(upstreamId, modelId));
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

export function productRealizationsFor(channel: Channel): Realization[] {
  if (channel !== "gemini") return productRealizations();
  return productRealizations().filter(
    (realization) => PRESETS.find((preset) => preset.id === realization.presetId)?.protocol === "gemini"
  );
}

export function channelValuesetIds(channel: Channel): string[] {
  if (channel !== "gemini") return allValuesetIds();
  return [...new Set(productRealizationsFor(channel).map((realization) => realization.valuesetId))].sort();
}

export function baseUrlFor(channel: Channel, presetId: string): string {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`PRESETS 未登记预设：${presetId}`);
  return channel === "anthropic" ? (preset.protocolBaseUrls?.anthropic ?? preset.baseUrl) : preset.baseUrl;
}

export interface BodyRequest {
  readonly presetId?: string;
  readonly baseUrl?: string;
  readonly model: string;
  readonly level: ThinkingLevel;
  readonly stream?: boolean;
  readonly maxTokens?: number;
  readonly probe?: boolean;
}

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
        ...(maxTokens != null ? { maxTokens } : {})
      }) as Record<string, unknown>;
    },
    expectedBody: (model, fields) => ({ model, messages: MESSAGES, stream: false, max_tokens: DEFAULT_MAX_TOKENS, ...fields }),
    fragmentOf: thinkingFragment
  };
}

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

const BODY_WRAPPER_KEYS = ["model", "messages", "stream", "max_tokens", "max_completion_tokens"];

export function thinkingFragment(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (BODY_WRAPPER_KEYS.includes(key)) continue;
    out[key] = value;
  }
  return out;
}

export function allValuesetIds(): string[] {
  return Object.keys(VALUESETS).sort();
}

export function assignedValuesetIds(): string[] {
  const used = new Set<string>();
  for (const table of Object.values(ASSIGNMENTS)) {
    for (const valuesetId of Object.values(table)) used.add(valuesetId);
  }
  return [...used].sort();
}

export function coveredValuesetIds(cases: readonly ByClassCase[]): string[] {
  return [...new Set(cases.map((c) => c.valuesetId))].sort();
}

export function fieldsSignature(fields: readonly Record<string, unknown>[]): string {
  return JSON.stringify(fields);
}
