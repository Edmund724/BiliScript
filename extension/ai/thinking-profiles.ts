import { PRESETS } from "../core/presets.js";
import { hostOf, presetIdForHost } from "../core/preset-host-index.js";
import { isPlatformKey, type PlatformKey } from "./platform-identity-vocab.js";
import { lookupThinkingFact, type ThinkingModelFact } from "./catalog/models-dev-thinking.generated.js";

export {
  AI_THINKING_LEVELS,
  AI_THINKING_LEVEL_VALUES,
  THINKING_DEFAULT_LEVEL,
  isThinkingLevel,
  isThinkingLevelValue,
  normalizeThinkingLevel,
  type ThinkingLevel,
  type ThinkingLevelValue
} from "./thinking-levels.js";
import {
  AI_THINKING_LEVELS,
  isThinkingLevel,
  normalizeThinkingLevel,
  type ThinkingLevel,
  type ThinkingLevelValue
} from "./thinking-levels.js";

const NON_OFF_LEVELS: readonly ThinkingLevel[] = AI_THINKING_LEVELS.filter((level) => level !== "off");

interface ThinkingVocabularyMembers {
  reasoningEffort: { readonly kind: "reasoningEffort"; readonly level: string };
  enableThinking: { readonly kind: "enableThinking"; readonly on: boolean };
  thinkingType: { readonly kind: "thinkingType"; readonly type: string };
  noFields: { readonly kind: "noFields" };
  unknown: { readonly kind: "unknown" };
}

export type ThinkingVocabularyKind = keyof ThinkingVocabularyMembers;

export type ThinkingVocabulary = ThinkingVocabularyMembers[ThinkingVocabularyKind];

export function reasoningEffort(level: string): ThinkingVocabulary {
  return { kind: "reasoningEffort", level };
}

export function enableThinking(on: boolean): ThinkingVocabulary {
  return { kind: "enableThinking", on };
}

export function thinkingType(type: string): ThinkingVocabulary {
  return { kind: "thinkingType", type };
}

export const NO_FIELDS: ThinkingVocabulary = { kind: "noFields" };

export const UNKNOWN_VOCABULARY: ThinkingVocabulary = { kind: "unknown" };

const VOCABULARY_CARRIES_FIELDS: Readonly<Record<ThinkingVocabularyKind, boolean>> = {
  reasoningEffort: true,
  enableThinking: true,
  thinkingType: true,
  noFields: false,
  unknown: false
};
const VOCABULARY_KINDS: ReadonlySet<string> = new Set(Object.keys(VOCABULARY_CARRIES_FIELDS));
const FIELD_WHITELIST: ReadonlySet<string> = new Set(
  Object.entries(VOCABULARY_CARRIES_FIELDS)
    .filter(([, carriesFields]) => carriesFields)
    .map(([kind]) => kind)
);

function carriesPayload(vocabulary: ThinkingVocabulary | undefined): vocabulary is ThinkingVocabulary {
  return vocabulary !== undefined && VOCABULARY_CARRIES_FIELDS[vocabulary.kind] === true;
}

export interface ThinkingPatch {
  vocabulary?: ThinkingVocabulary;
  streamOnly?: boolean;
}

export interface ClassRule {
  thinkingClass: "always" | "hybrid" | "never";
  off?: ThinkingPatch;
  on?: ThinkingPatch;
  minimal?: ThinkingPatch;
  low?: ThinkingPatch;
  medium?: ThinkingPatch;
  high?: ThinkingPatch;
  xhigh?: ThinkingPatch;
  max?: ThinkingPatch;
  tokenParam?: "max_tokens" | "max_completion_tokens";
}

export interface TaxonomyEntry {
  class: string;
  patterns: string[];
}

export interface ProviderRule {
  unknownClass?: string;
}

export const CLASSES: Record<string, ClassRule> = {
  "openai-reasoning": {
    thinkingClass: "always",
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") },
    tokenParam: "max_completion_tokens"
  },
  "openai-reasoning-none": {
    thinkingClass: "hybrid",
    off: { vocabulary: reasoningEffort("none") },
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") },
    tokenParam: "max_completion_tokens"
  },

  "qwen-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false) },
    on: { vocabulary: enableThinking(true) }
  },
  "qwen-hybrid-switch-streamonly": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false), streamOnly: true },
    on: { vocabulary: enableThinking(true) }
  },
  "qwen-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false) },
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("xhigh") }
  },
  "qwen-always": { thinkingClass: "always" },

  "deepseek-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { vocabulary: thinkingType("disabled") },
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") }
  },
  "deepseek-reasoner-always": { thinkingClass: "always" },
  "deepseek-chat-never": { thinkingClass: "never" },

  "glm-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: thinkingType("disabled") },
    on: { vocabulary: thinkingType("enabled") }
  },
  "glm-hybrid-effort": {
    thinkingClass: "hybrid",
    off: { vocabulary: thinkingType("disabled") },
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") }
  },
  "glm-always": { thinkingClass: "always" },

  "kimi-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: thinkingType("disabled") },
    on: { vocabulary: thinkingType("enabled") }
  },
  "kimi-always": { thinkingClass: "always" },
  "kimi-instruct-never": { thinkingClass: "never" },

  "minimax-always": { thinkingClass: "always" },

  "doubao-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: thinkingType("disabled") },
    on: { vocabulary: thinkingType("enabled") }
  },

  "step37-effort": {
    thinkingClass: "always",
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") }
  },
  "step-always": { thinkingClass: "always" },

  "mimo-hybrid-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false) },
    on: { vocabulary: enableThinking(true) }
  },

  "ollama-effort": {
    thinkingClass: "hybrid",
    off: { vocabulary: reasoningEffort("none") },
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") }
  },

  "siliconflow-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false) },
    on: { vocabulary: enableThinking(true) }
  }
};

export const EXCEPTIONS: readonly TaxonomyEntry[] = [
  { class: "qwen-always", patterns: ["qwen3-*-thinking-2507"] },
  { class: "qwen-hybrid-effort", patterns: ["qwen3.8-max"] },
  { class: "qwen-hybrid-switch-streamonly", patterns: ["qwen3-235b", "qwen3-32b", "qwen3-30b"] },
  { class: "glm-always", patterns: ["glm-5.3"] },
  { class: "kimi-always", patterns: ["kimi-k2.7"] },
  { class: "openai-reasoning-none", patterns: ["gpt-5.1", "gpt-5.2"] },
  { class: "openai-reasoning", patterns: ["gpt-6", "o3", "o4"] }
];

export const TAXONOMY: readonly TaxonomyEntry[] = [
  { class: "qwen-always", patterns: ["qwen3-next-*-thinking", "qwen3.7-max-preview", "qwen3.8-2.4t-a95b", "qwq"] },
  { class: "qwen-hybrid-switch", patterns: ["qwen3-max", "qwen-plus", "qwen-flash", "qwen-turbo", "qwen3.5", "qwen3.6", "qwen3.7", "qwen3.8"] },
  { class: "deepseek-chat-never", patterns: ["deepseek-chat"] },
  { class: "deepseek-reasoner-always", patterns: ["deepseek-reasoner", "deepseek-r1"] },
  { class: "deepseek-hybrid-effort", patterns: ["deepseek-v3.2", "deepseek-v4"] },
  { class: "glm-hybrid-effort", patterns: ["glm-5.2"] },
  { class: "glm-hybrid-switch", patterns: ["glm-5", "glm-5.1", "glm-4.5", "glm-4.6", "glm-4.7"] },
  { class: "kimi-always", patterns: ["kimi-k2-thinking", "kimi-thinking"] },
  { class: "kimi-hybrid-switch", patterns: ["kimi-k2.5", "kimi-k2.6"] },
  { class: "kimi-instruct-never", patterns: ["kimi-k2-"] },
  { class: "minimax-always", patterns: ["minimax-m1", "minimax-m2", "minimax-m3"] },
  { class: "doubao-hybrid-switch", patterns: ["doubao-seed"] },
  { class: "openai-reasoning", patterns: ["gpt-5"] },
  { class: "step37-effort", patterns: ["step-3.7"] },
  { class: "step-always", patterns: ["step-3"] },
  { class: "mimo-hybrid-switch", patterns: ["mimo-v2"] }
];

export const PROVIDERS: Record<PlatformKey, ProviderRule> = {
  deepseek: {},
  qwen: {},
  zhipu: {},
  moonshot: {},
  minimax: {},
  mimo: { unknownClass: "mimo-hybrid-switch" },
  openrouter: {},
  stepfun: {},
  modelscope: { unknownClass: "qwen-hybrid-switch" },
  ollama: { unknownClass: "ollama-effort" },
  siliconflow: { unknownClass: "siliconflow-switch" },
  amd: {},
  sensenova: {},
  opencodego: {},
  gemini: {}
};

export const UPSTREAM_PROVIDER_BY_PRESET: Readonly<Record<string, string>> = Object.fromEntries(
  PRESETS.flatMap((preset) =>
    preset.catalogProvider ? [[preset.id, preset.catalogProvider] as const] : []
  )
);

export const UPSTREAM_TOGGLE_SHAPES: Readonly<
  Record<string, { off: ThinkingVocabulary; on: ThinkingVocabulary } | undefined>
> = {
  deepseek: { off: thinkingType("disabled"), on: thinkingType("enabled") },
  qwen: { off: enableThinking(false), on: enableThinking(true) },
  zhipu: { off: thinkingType("disabled"), on: thinkingType("enabled") },
  moonshot: { off: thinkingType("disabled"), on: thinkingType("enabled") },
  mimo: { off: enableThinking(false), on: enableThinking(true) },
  modelscope: { off: enableThinking(false), on: enableThinking(true) },
  minimax: { off: thinkingType("disabled"), on: thinkingType("adaptive") }
};

export type UpstreamThinkingFact = Pick<ThinkingModelFact, "valuesetId" | "toggle" | "effort" | "off">;

export function upstreamVocabularyOf(fact: UpstreamThinkingFact): readonly ThinkingLevel[] {
  const tiers = (fact.effort ?? []).filter((tier): tier is ThinkingLevel => isThinkingLevel(tier));
  const levels: ThinkingLevel[] = [];
  if (fact.off) {
    levels.push("off");
  }
  levels.push(...(tiers.length > 0 ? tiers : fact.toggle ? NON_OFF_LEVELS : []));
  return AI_THINKING_LEVELS.filter((level) => levels.includes(level));
}

export function ruleFromUpstreamFact(fact: UpstreamThinkingFact, providerId: string): ClassRule {
  const shape = UPSTREAM_TOGGLE_SHAPES[providerId];
  const tiers = (fact.effort ?? []).filter((tier): tier is ThinkingLevel => isThinkingLevel(tier));
  const off: ThinkingPatch | undefined =
    fact.off === "toggle"
      ? shape
        ? { vocabulary: shape.off }
        : undefined
      : fact.off === "effort-none"
        ? { vocabulary: reasoningEffort("none") }
        : undefined;

  const rule: ClassRule = { thinkingClass: off ? "hybrid" : "always" };
  if (off) {
    rule.off = off;
  }
  if (tiers.length > 0) {
    for (const tier of tiers) {
      rule[tier] = { vocabulary: reasoningEffort(tier) };
    }
    return rule;
  }
  if (fact.toggle && shape) {
    rule.on = { vocabulary: shape.on };
  }
  return rule;
}

export function availableLevelsOf(rule: ClassRule): readonly ThinkingLevel[] {
  if (rule.on) {
    return rule.off ? [...AI_THINKING_LEVELS] : [...NON_OFF_LEVELS];
  }
  const available: ThinkingLevel[] = [];
  if (rule.off) {
    available.push("off");
  }
  for (const level of NON_OFF_LEVELS) {
    if (rule[level]) {
      available.push(level);
    }
  }
  return available;
}

export function clampThinkingLevel(preference: ThinkingLevelValue, available: readonly ThinkingLevel[]): ThinkingLevelValue | null {
  if (preference === "default") {
    return "default";
  }
  if (available.length === 0) {
    return "default";
  }
  if (available.includes(preference as ThinkingLevel)) {
    return preference;
  }
  const rank = (level: ThinkingLevel): number => AI_THINKING_LEVELS.indexOf(level);
  const below = available.filter((level) => rank(level) <= rank(preference as ThinkingLevel));
  if (below.length > 0) {
    return below.reduce((best, level) => (rank(level) > rank(best) ? level : best), below[0]);
  }
  return available.reduce((best, level) => (rank(level) < rank(best) ? level : best), available[0]);
}

export type ThinkingClampReason = "model-vocabulary" | "upstream-unlisted";

export type ThinkingRuleSource = "upstream" | "handwritten" | "unknown";

export type ResolvedThinkingClass = ClassRule["thinkingClass"] | "unknown";

export interface ResolveThinkingInput {
  presetId?: string;
  baseUrl?: string;
  model: string;
  level: unknown;
  stream: boolean;
}

export interface ThinkingResolution {
  vocabulary: ThinkingVocabulary;
  requestedLevel: ThinkingLevelValue;
  effectiveLevel: ThinkingLevelValue | null;
  tokenParam?: "max_tokens" | "max_completion_tokens";
  offUnavailable: boolean;
  offFallback: "low" | null;
  thinkingClass: ResolvedThinkingClass;
}

function copyVocabulary(vocabulary: ThinkingVocabulary): ThinkingVocabulary {
  return { ...vocabulary };
}

function resolutionOf(
  vocabulary: ThinkingVocabulary,
  requestedLevel: ThinkingLevelValue,
  effectiveLevel: ThinkingLevelValue | null,
  rest: Pick<ThinkingResolution, "offUnavailable" | "offFallback" | "thinkingClass">
): ThinkingResolution {
  return { vocabulary: copyVocabulary(vocabulary), requestedLevel, effectiveLevel, ...rest };
}

const UNKNOWN_RESOLUTION: ThinkingResolution = resolutionOf(UNKNOWN_VOCABULARY, "default", null, {
  offUnavailable: false,
  offFallback: null,
  thinkingClass: "unknown"
});

function unknownResolutionOf(requestedLevel: ThinkingLevelValue): ThinkingResolution {
  return { ...UNKNOWN_RESOLUTION, requestedLevel };
}

interface ResolvedRule {
  rule: ClassRule | undefined;
  reason: ThinkingClampReason | null;
  source: ThinkingRuleSource;
}

function ruleFor({ presetId, baseUrl, model }: ResolveThinkingInput): ResolvedRule {
  const normalizedModel = String(model || "").trim().toLowerCase();
  const providerId = resolveThinkingProviderId(presetId, baseUrl);
  const provider = providerRuleFor(providerId);
  const upstreamId = providerId ? UPSTREAM_PROVIDER_BY_PRESET[providerId] : undefined;

  if (upstreamId) {
    const fact = lookupThinkingFact(upstreamId, model);
    if (fact) {
      return { rule: ruleFromUpstreamFact(fact, providerId!), reason: "model-vocabulary", source: "upstream" };
    }
  }

  const className = matchHandwrittenClass(normalizedModel) ?? provider?.unknownClass;
  return {
    rule: className ? CLASSES[className] : undefined,
    reason: className ? "upstream-unlisted" : null,
    source: className ? "handwritten" : "unknown"
  };
}

function resolutionFor(rule: ClassRule | undefined, input: ResolveThinkingInput): ThinkingResolution {
  const requestedLevel = normalizeThinkingLevel(input.level);
  return rule ? applyClassRule(rule, requestedLevel, input.stream) : unknownResolutionOf(requestedLevel);
}

export function resolveThinkingProfile(input: ResolveThinkingInput): ThinkingResolution {
  return resolutionFor(ruleFor(input).rule, input);
}

export interface ThinkingLevelAdjustment {
  resolution: ThinkingResolution;
  requestedLevel: ThinkingLevelValue;
  availableLevels: readonly ThinkingLevel[];
  effectiveLevel: ThinkingLevelValue | null;
  reason: ThinkingClampReason | null;
  source: ThinkingRuleSource;
  switchOnly: boolean;
}

export function resolveThinkingAdjustment(input: ResolveThinkingInput): ThinkingLevelAdjustment {
  const { rule, reason, source } = ruleFor(input);
  const resolution = resolutionFor(rule, input);
  const requestedLevel = resolution.requestedLevel;
  const availableLevels = rule ? availableLevelsOf(rule) : [];
  const effectiveLevel = resolution.effectiveLevel;
  return {
    resolution,
    requestedLevel,
    availableLevels,
    effectiveLevel,
    reason: rule && effectiveLevel !== null && effectiveLevel !== requestedLevel ? reason : null,
    source,
    switchOnly: Boolean(rule?.on)
  };
}

export function providerRuleFor(platformId: string | undefined): ProviderRule | undefined {
  const id = String(platformId || "").trim();
  return isPlatformKey(id) ? PROVIDERS[id] : undefined;
}

export function resolveThinkingProviderId(presetId?: string, baseUrl?: string): string | undefined {
  const byId = String(presetId || "").trim();
  if (providerRuleFor(byId)) {
    return byId;
  }
  return presetIdForHost(hostOf(String(baseUrl || ""))) ?? undefined;
}

function matchHandwrittenClass(model: string): string | undefined {
  return (
    matchRuleClass(EXCEPTIONS, model) ??
    matchRuleClass(TAXONOMY, model) ??
    matchRuleClass(TAXONOMY, stripOrgPrefix(model))
  );
}

function stripOrgPrefix(model: string): string {
  const slash = model.lastIndexOf("/");
  if (slash < 0 || slash === model.length - 1) return model;
  return model.slice(slash + 1);
}

function matchRuleClass(entries: readonly TaxonomyEntry[], model: string): string | undefined {
  for (const entry of entries) {
    for (const pattern of entry.patterns) {
      if (modelMatches(pattern, model)) {
        return entry.class;
      }
    }
  }
  return undefined;
}

function modelMatches(pattern: string, model: string): boolean {
  if (!pattern.includes("*")) {
    return model.startsWith(pattern);
  }
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(model);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type ClassRuleDecision = "default" | "off-usable" | "never" | "off-cascade" | "tier";

export function applyClassRule(rule: ClassRule, level: ThinkingLevelValue, stream: boolean): ThinkingResolution {
  const available = availableLevelsOf(rule);
  const offPatch = streamEnabledPatch(rule.off, stream);
  const effective = clampThinkingLevel(
    level,
    level === "off" && !offPatch ? available.filter((tier) => tier !== "off") : available
  );

  let decision: ClassRuleDecision;
  let candidate: ThinkingVocabulary | undefined;

  if (level === "default") {
    decision = "default";
  } else if (level === "off") {
    if (offPatch) {
      decision = "off-usable";
      candidate = offPatch.vocabulary;
    } else if (rule.thinkingClass === "never") {
      decision = "never";
    } else {
      decision = "off-cascade";
      candidate = streamEnabledPatch(patchForLevel(rule, effective), stream)?.vocabulary;
    }
  } else {
    decision = "tier";
    candidate = streamEnabledPatch(patchForLevel(rule, effective), stream)?.vocabulary;
  }

  const vocabulary = candidate && carriesPayload(candidate) ? candidate : NO_FIELDS;
  const hasPayload = carriesPayload(vocabulary);
  const offCascade = decision === "off-cascade";
  return withTokenParam(
    resolutionOf(vocabulary, level, effective, {
      offUnavailable: offCascade,
      offFallback: offCascade && hasPayload ? "low" : null,
      thinkingClass: rule.thinkingClass
    }),
    rule
  );
}

function patchForLevel(rule: ClassRule, level: ThinkingLevelValue | null): ThinkingPatch | undefined {
  if (level === null || level === "default") {
    return undefined;
  }
  if (level === "off") {
    return rule.off;
  }
  return rule[level] ?? rule.on;
}

function streamEnabledPatch(patch: ThinkingPatch | undefined, stream: boolean): ThinkingPatch | undefined {
  if (!patch || (patch.streamOnly && !stream)) {
    return undefined;
  }
  return patch;
}

function withTokenParam(resolution: ThinkingResolution, rule: ClassRule): ThinkingResolution {
  if (rule.tokenParam) {
    resolution.tokenParam = rule.tokenParam;
  }
  return resolution;
}

const CLASS_FACTS = new Set(["always", "hybrid", "never"]);
const TOKEN_PARAMS = new Set(["max_tokens", "max_completion_tokens"]);
const LEVEL_KEYS = ["off", "on", ...NON_OFF_LEVELS] as const;

export interface ThinkingTables {
  classes?: Record<string, ClassRule>;
  taxonomy?: readonly TaxonomyEntry[];
  exceptions?: readonly TaxonomyEntry[];
  providers?: Record<string, ProviderRule>;
}

export function validateThinkingTables(tables: ThinkingTables = {}): string[] {
  const classes = tables.classes ?? CLASSES;
  const taxonomy = tables.taxonomy ?? TAXONOMY;
  const exceptions = tables.exceptions ?? EXCEPTIONS;
  const providers = tables.providers ?? PROVIDERS;
  const errors: string[] = [];

  for (const [name, rule] of Object.entries(classes)) {
    const at = `CLASSES.${name}`;
    if (!CLASS_FACTS.has(rule.thinkingClass)) {
      errors.push(`${at}: thinkingClass 必填，取值 always/hybrid/never`);
    }
    if (rule.thinkingClass === "hybrid" && !rule.off) {
      errors.push(`${at}: hybrid 必有 off 声明`);
    }
    if (rule.thinkingClass !== "hybrid" && rule.off) {
      errors.push(`${at}: ${rule.thinkingClass} 不得有 off`);
    }
    if (rule.thinkingClass === "never" && (rule.on || NON_OFF_LEVELS.some((tier) => rule[tier]))) {
      errors.push(`${at}: never 无任何档位`);
    }
    if (rule.thinkingClass === "never" && rule.tokenParam) {
      errors.push(`${at}: never 不得带 tokenParam`);
    }
    const explicitTiers = NON_OFF_LEVELS.filter((tier) => rule[tier]);
    if (rule.on && explicitTiers.length > 0) {
      errors.push(`${at}: on 与显式档位（${explicitTiers.join("/")}）同级冲突（开关型的唯一写点是 on）`);
    }
    for (const key of LEVEL_KEYS) {
      checkPatchVocabulary(`${at}.${key}`, rule[key], errors);
    }
    if (rule.tokenParam && !TOKEN_PARAMS.has(rule.tokenParam)) {
      errors.push(`${at}: tokenParam 只允许 max_tokens/max_completion_tokens`);
    }
  }

  const entryTables: [string, readonly TaxonomyEntry[]][] = [
    ["TAXONOMY", taxonomy],
    ["EXCEPTIONS", exceptions]
  ];
  for (const [tableName, entries] of entryTables) {
    entries.forEach((entry, index) => {
      if (!entry.patterns || entry.patterns.length === 0) {
        errors.push(`${tableName}[${index}]: patterns 不能为空`);
      }
      if (!classes[entry.class]) {
        errors.push(`${tableName}[${index}]: 引用的 class "${entry.class}" 不存在`);
      }
    });
  }

  for (const [id, rule] of Object.entries(providers)) {
    const at = `PROVIDERS.${id}`;
    if (rule.unknownClass && !classes[rule.unknownClass]) {
      errors.push(`${at}: unknownClass "${rule.unknownClass}" 不存在`);
    }
  }

  return errors;
}

function checkPatchVocabulary(at: string, patch: ThinkingPatch | undefined, errors: string[]): void {
  const kind = patch?.vocabulary?.kind;
  if (kind === undefined) {
    return;
  }
  if (FIELD_WHITELIST.has(kind)) {
    return;
  }
  errors.push(
    VOCABULARY_KINDS.has(kind)
      ? `${at}: 词汇 "${kind}" 是哨兵（无载荷），patch 不写 vocabulary 即可`
      : `${at}: 词汇 kind "${kind}" 不在白名单（${[...FIELD_WHITELIST].join("/")}）`
  );
}
