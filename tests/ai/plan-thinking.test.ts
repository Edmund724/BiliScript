// tests/ai/plan-thinking.test.ts
// 思考装配边（ai/plan-thinking.ts）的表驱动用例：直接驱动 `planThinkingWire`，**不穿
// `buildBody`**——断言外部行为（本协议的思考字段对象 + 本协议的输出上限参数名），
// 不断言内部调用与实现结构。
//
// 覆盖票面要求的两条通道行为面：
// - openai 行：三套词汇（reasoning_effort / enable_thinking / thinking:{type}）原样落线、
//   两个哨兵（noFields / unknown）一个字段都不发、token 参数名随血统事实分流
//   （openai-reasoning 系 max_completion_tokens、其余 max_tokens）、probe 事实不参与本行
//   （同一事实下 probe 真/假产物相同；探针不发思考字段靠请求侧归一：探针不传档位 →
//   default → 空 patch）。
// - anthropic 行：探针早退、只认 effort 词汇的平台（stepfun / amd，怪癖
//   effortVocabMessages）改写为 output_config.effort、未登记平台回落裸 effort、
//   开关型血统的裸开档、两个哨兵不发。
//
// 期望值取自事实表与线格式映射表**逐条读出的结论**（不重算实现里的分支）：
// `custom` 预设无上游桥接、baseUrl 也不在 host 索引里，故档位规则来自手写兜底表
// （EXCEPTIONS >> TAXONOMY）；stepfun / amd 的模型取自 02 指派表（值集见
// ai/catalog/models-dev-thinking.generated.ts）。
import { describe, expect, it } from "vitest";
import { planThinkingWire, type ThinkingRequestFacts } from "../../extension/ai/plan-thinking.js";

interface WireCase {
  readonly name: string;
  readonly facts: ThinkingRequestFacts;
  readonly fields: Record<string, unknown>;
  readonly tokenParam: string;
}

// 未登记平台（custom 预设 + 不在 host 索引里的 baseUrl）：档位规则走手写兜底，
// 平台识别与怪癖识别都查不到 → 装配边必须容忍「两个识别都为 undefined」。
const CUSTOM = { presetId: "custom", baseUrl: "https://example.invalid/v1" } as const;

const CASES: readonly WireCase[] = [
  // ===== openai：词汇即本协议线格式，token 参数名随血统事实 =====
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

  // ===== anthropic：探针早退 / 两个平台事实 / 开关型血统 / 两个哨兵 =====
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
  }
];

describe("思考装配边 planThinkingWire：协议 × 词汇 × 平台事实 → 思考字段 + 输出上限参数名", () => {
  it.each(CASES)("$name", ({ facts, fields, tokenParam }) => {
    expect(planThinkingWire(facts)).toEqual({ fields, tokenParam });
  });
});
