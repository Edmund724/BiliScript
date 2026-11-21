import { describe, expect, it } from "vitest";
import { planThinkingWire, type ThinkingRequestFacts } from "../../extension/ai/plan-thinking.js";

interface WireCase {
  readonly name: string;
  readonly facts: ThinkingRequestFacts;
  readonly fields: Record<string, unknown>;
  readonly tokenParam: string;
}

const CUSTOM = { presetId: "custom", baseUrl: "https://example.invalid/v1" } as const;

const GEMINI = { presetId: "gemini" } as const;

const CASES: readonly WireCase[] = [
  {
    name: "openai · reasoningEffort 档位词汇原样落线；openai-reasoning 系上限参数名 = max_completion_tokens",
    facts: { protocol: "openai", model: "gpt-5", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: { reasoning_effort: "high" },
    tokenParam: "max_completion_tokens"
  },
  {
    name: "openai · 同一事实下 probe 真/假产物相同（探针事实不参与本行，装配边不得自造档位）",
    facts: { protocol: "openai", model: "gpt-5", ...CUSTOM, level: "high", stream: true, probe: true },
    fields: { reasoning_effort: "high" },
    tokenParam: "max_completion_tokens"
  },
  {
    name: "openai · enableThinking 开关词汇原样落线；无血统 token 事实 → max_tokens",
    facts: { protocol: "openai", model: "mimo-v2", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: { enable_thinking: true },
    tokenParam: "max_tokens"
  },
  {
    name: "openai · thinkingType 开关词汇原样落线；无血统 token 事实 → max_tokens",
    facts: { protocol: "openai", model: "glm-4.5", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: { thinking: { type: "enabled" } },
    tokenParam: "max_tokens"
  },
  {
    name: "openai · 哨兵 noFields（显式 default 档 = 不干预）：一个字段都不发",
    facts: { protocol: "openai", model: "glm-4.5", ...CUSTOM, level: "default", stream: true, probe: false },
    fields: {},
    tokenParam: "max_tokens"
  },
  {
    name: "openai · 哨兵 unknown（未命中任何档位规则）：一个字段都不发",
    facts: { protocol: "openai", model: "no-such-model-xyz", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: {},
    tokenParam: "max_tokens"
  },
  {
    name: "openai · 探针不特化：探针不传档位 → 请求侧归一为不干预 → 空 patch",
    facts: { protocol: "openai", model: "glm-4.5", ...CUSTOM, level: undefined, stream: true, probe: true },
    fields: {},
    tokenParam: "max_tokens"
  },

  {
    name: "anthropic · 探针早退：任何档位都不发思考字段（probeOmitsThinking）",
    facts: { protocol: "anthropic", model: "glm-4.5", ...CUSTOM, level: "high", stream: true, probe: true },
    fields: {},
    tokenParam: "max_tokens"
  },
  {
    name: "anthropic · 只认 effort 词汇的平台（stepfun，怪癖 effortVocabMessages）：档位词改写为 output_config.effort",
    facts: {
      protocol: "anthropic",
      model: "step-3.7-flash",
      presetId: "stepfun",
      baseUrl: "https://api.stepfun.com/step_plan",
      level: "high",
      stream: true,
      probe: false
    },
    fields: { output_config: { effort: "high" } },
    tokenParam: "max_tokens"
  },
  {
    name: "anthropic · 只认 effort 词汇的平台（amd，怪癖 effortVocabMessages）：档位词改写为 output_config.effort",
    facts: {
      protocol: "anthropic",
      model: "DeepSeek-V4.1-Flash",
      presetId: "amd",
      baseUrl: "https://developer.amd.com.cn/radeon/api",
      level: "high",
      stream: true,
      probe: false
    },
    fields: { output_config: { effort: "high" } },
    tokenParam: "max_tokens"
  },
  {
    name: "anthropic · 未登记平台的档位出口回落：只发裸 output_config.effort（不带 thinking 开关）",
    facts: { protocol: "anthropic", model: "gpt-5", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: { output_config: { effort: "high" } },
    tokenParam: "max_tokens"
  },
  {
    name: "anthropic · 开关型血统：非 off 档落裸开档，不发明档位词",
    facts: { protocol: "anthropic", model: "glm-4.5", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: { thinking: { type: "enabled" } },
    tokenParam: "max_tokens"
  },
  {
    name: "anthropic · 哨兵 noFields（default 档 = 不干预）：一个字段都不发",
    facts: { protocol: "anthropic", model: "glm-4.5", ...CUSTOM, level: "default", stream: true, probe: false },
    fields: {},
    tokenParam: "max_tokens"
  },
  {
    name: "anthropic · 哨兵 unknown（未命中任何档位规则）：一个字段都不发",
    facts: { protocol: "anthropic", model: "no-such-model-xyz", ...CUSTOM, level: "high", stream: true, probe: false },
    fields: {},
    tokenParam: "max_tokens"
  },
  {
    name: "gemini · gemini-3 系 high 档：thinkingLevel: HIGH, includeThoughts: true",
    facts: { protocol: "gemini", model: "gemini-3-flash-preview", ...GEMINI, level: "high", stream: true, probe: false },
    fields: { thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    tokenParam: "maxOutputTokens"
  },
  {
    name: "gemini · gemini-3 系 off 档：伪关闭 MINIMAL + includeThoughts: false",
    facts: { protocol: "gemini", model: "gemini-3-flash-preview", ...GEMINI, level: "off", stream: true, probe: false },
    fields: { thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
    tokenParam: "maxOutputTokens"
  },
  {
    name: "gemini · 2.5 系（上游只有区间、没有逐档数值）：不发思考字段",
    facts: { protocol: "gemini", model: "gemini-2.5-flash", ...GEMINI, level: "medium", stream: true, probe: false },
    fields: {},
    tokenParam: "maxOutputTokens"
  },
  {
    name: "gemini · 2.5 系 off 档：关不掉，同样不发思考字段",
    facts: { protocol: "gemini", model: "gemini-2.5-flash", ...GEMINI, level: "off", stream: true, probe: false },
    fields: {},
    tokenParam: "maxOutputTokens"
  },
  {
    name: "gemini · 目录外模型：无档位事实，不按偏好补发 thinkingLevel",
    facts: { protocol: "gemini", model: "gemini-3-flash", ...GEMINI, level: "high", stream: true, probe: false },
    fields: {},
    tokenParam: "maxOutputTokens"
  },
  {
    name: "gemini · default 档（不干预）：一个字段都不发",
    facts: { protocol: "gemini", model: "gemini-3-flash-preview", ...GEMINI, level: "default", stream: true, probe: false },
    fields: {},
    tokenParam: "maxOutputTokens"
  }
];

describe("思考装配边 planThinkingWire：协议 × 词汇 × 平台事实 → 思考字段 + 输出上限参数名", () => {
  it.each(CASES)("$name", ({ facts, fields, tokenParam }) => {
    expect(planThinkingWire(facts)).toEqual({ fields, tokenParam });
  });
});
