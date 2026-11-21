import {
  enableThinking,
  reasoningEffort,
  thinkingType,
  type ClassRule,
  type ProviderRule as UpstreamProviderRule,
  type TaxonomyEntry
} from "../../../extension/ai/thinking-profiles.js";

interface FixtureOverrideRule {
  thinkingClass: "always" | "hybrid" | "never";
  levels: Record<string, { fields: Record<string, unknown> }>;
}

interface ProviderRule extends UpstreamProviderRule {
  override?: FixtureOverrideRule;
}

export const CLASSES: Record<string, ClassRule> = {
  "fx-glm-effort": {
    thinkingClass: "hybrid",
    off: { vocabulary: thinkingType("disabled") },
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") }
  },
  "fx-glm-always": { thinkingClass: "always" },
  "fx-kimi-k3-effort": {
    thinkingClass: "always",
    low: { vocabulary: reasoningEffort("low") },
    high: { vocabulary: reasoningEffort("high") }
  },
  "fx-minimax-always": { thinkingClass: "always" },
  "fx-qwen-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false) },
    on: { vocabulary: enableThinking(true) }
  },
  "fx-mimo-switch": {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false) },
    on: { vocabulary: enableThinking(true) }
  }
};

export const EXCEPTIONS: readonly TaxonomyEntry[] = [
  { class: "fx-glm-always", patterns: ["glm-5.3"] },
  { class: "fx-kimi-k3-effort", patterns: ["kimi-k3"] }
];

export const TAXONOMY: readonly TaxonomyEntry[] = [
  { class: "fx-glm-effort", patterns: ["glm-5.2"] },
  { class: "fx-minimax-always", patterns: ["minimax-m1", "minimax-m2", "minimax-m3"] },
  { class: "fx-qwen-switch", patterns: ["qwen3-max"] },
  { class: "fx-mimo-switch", patterns: ["mimo-v2"] }
];

export const PROVIDERS: Record<string, ProviderRule> = {
  deepseek: {},
  qwen: {},
  zhipu: {},
  moonshot: {},
  minimax: {},
  mimo: { unknownClass: "fx-mimo-switch" },
  openrouter: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  stepfun: {},
  modelscope: { unknownClass: "fx-qwen-switch" },
  amd: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  sensenova: {
    override: {
      thinkingClass: "hybrid",
      levels: {
        off: { fields: { reasoning_effort: "none" } },
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  opencodego: {
    override: {
      thinkingClass: "always",
      levels: {
        low: { fields: { reasoning_effort: "low" } },
        high: { fields: { reasoning_effort: "high" } }
      }
    }
  },
  gemini: {}
};
