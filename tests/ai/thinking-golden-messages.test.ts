// Messages 通道（Anthropic）思考参数 golden 测试：13 平台 × {off,low,high} × 代表模型
// → 逐字节精确请求体。
// 平台矩阵 = PRESETS 里登记了 protocolBaseUrls.anthropic 的 12 家 + ollama
// （无 anthropic 端点，按任务约定用它的 openai baseUrl 代位），baseUrl 一律从
// PRESETS 取（protocolBaseUrls?.anthropic ?? baseUrl），不在本文件手抄 URL。
// 代表模型按各平台实际有的模型选：混合（可开关/可给 effort） / 永远思考 / 永不思考；
// 平台没有某血统时用「未列模型」代位断言三档不发（unknown 哨兵）并注明。
// 请求构造单缝：anthropicAdapter.buildBody，不传 maxTokens（走 adapter 默认
// DEFAULT_MAX_TOKENS = 32768，见 ai/output-budget.ts；golden 按字面值钉住）。
//
// 档位分档（02 号票）：effort 血统的档位在 Messages 通道按平台**官方登记的档位词汇**落线，
// 逐格见 ai/thinking-wire-map.ts 的 MESSAGES_TIER_VOCABULARY（每条注释带出处域名）：
// - deepseek / qwen / zhipu / sensenova：thinking:{type:"enabled"} + output_config.effort
//   （deepseek 词表 low/high/max；qwen3.8-max 词表 low/medium/xhigh，血统的 high 即 xhigh；
//   zhipu 官方把 low/medium 折成 high——平台侧既有归一化，本文件照实钉住我们发出的请求体；
//   sensenova 官方词表自相矛盾，保守只用 low/medium/high）。
// - openrouter / opencodego / modelscope：只发 output_config.effort（不带 thinking 对象——
//   openrouter 的 thinking.enabled 必带 budget_tokens；opencodego 与 modelscope 的 thinking
//   形状无官方文档，只发档位字段。后两家官方文档未登记档位词汇，按产品裁定发裸 effort 词汇，
//   不再退回自定 budget_tokens）。
// - moonshot：仓库 base 是 Kimi Code 端点，档位词是顶层 reasoning_effort（该端点未登记
//   thinking 形状）→ 只发 reasoning_effort。
// - 未登记档位词汇的平台（ollama 的 Messages 通道无思考参数文档；custom 直填端点同样无平台
//   事实）：退回按档分配 thinking.budget_tokens —— low 2048 / high 8192。
// - 开关型血统（glm-4.6 / kimi-k2.6 / qwen3-max / mimo-v2.5-pro）与严格 effort 词汇平台
//   （stepfun / amd）维持原状：前者该通道只有开/关两态，后者已按档发 output_config.effort。
// 塌陷格（low == high）只应出现在开关型血统的 low 与 high（该通道只有开/关两态，设计使然）。

import { describe, expect, it } from "vitest";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { PRESETS } from "../../extension/core/presets.js";
import type { ChatMessage } from "../../extension/ai/types.js";

const MESSAGES: ChatMessage[] = [{ role: "user", content: "hi" }];

// adapter 默认 max_tokens（未传 maxTokens 时兜底）；逐字节钉住字面值。
const DEFAULT_MAX_TOKENS = 32768;

// baseUrl 单源取自 PRESETS：登记了 anthropic 端点用该端点，否则回落 baseUrl
// （ollama 即此路：无 anthropic 端点，用 http://localhost:11434/v1 代位）。
function baseUrlOf(presetId: string): string {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`PRESETS 未登记预设：${presetId}`);
  return preset.protocolBaseUrls?.anthropic ?? preset.baseUrl;
}

// 三档期望的思考字段片段（{} = 不发任何思考字段）。
interface GoldenCase {
  kind: string;
  model: string;
  off: Record<string, unknown>;
  low: Record<string, unknown>;
  high: Record<string, unknown>;
}

interface PlatformGolden {
  presetId: string;
  name: string;
  cases: GoldenCase[];
}

const DISABLED = { thinking: { type: "disabled" } };
const BUDGET = { thinking: { type: "enabled", budget_tokens: 2048 } };
const BUDGET_HIGH = { thinking: { type: "enabled", budget_tokens: 8192 } };
// 档位词汇平台的两种形态（词表与出处见 ai/thinking-wire-map.ts）：
// effortWithSwitch = 文档登记 thinking 开关 + output_config.effort；
// effortOnly = 只登记 output_config.effort（该平台 thinking.enabled 必带预算，故不带 thinking 对象）。
const effortWithSwitch = (effort: string) => ({ thinking: { type: "enabled" }, output_config: { effort } });
const effortOnly = (effort: string) => ({ output_config: { effort } });
const reasoningEffort = (word: string) => ({ reasoning_effort: word });

const PLATFORMS: PlatformGolden[] = [
  {
    presetId: "deepseek",
    name: "DeepSeek（api.deepseek.com/anthropic）",
    cases: [
      {
        kind: "混合（off=矩阵 thinking 开关词汇；low/high=output_config.effort 分档，api-docs.deepseek.com）",
        model: "deepseek-v4-pro",
        off: DISABLED,
        low: effortWithSwitch("low"),
        high: effortWithSwitch("high")
      },
      {
        kind: "永远思考（reasoner 无档位；三档全不发 + offUnavailable）",
        model: "deepseek-reasoner",
        off: {},
        low: {},
        high: {}
      },
      {
        kind: "永不思考（deepseek-chat 三档静默）",
        model: "deepseek-chat",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    presetId: "qwen",
    name: "Qwen/百炼（dashscope.aliyuncs.com/apps/anthropic）",
    cases: [
      {
        kind: "混合开关（qwen3-max 默认关；low/high 塌陷）",
        model: "qwen3-max",
        off: DISABLED,
        low: BUDGET,
        high: BUDGET
      },
      {
        kind: "混合 effort（矩阵 high→xhigh；Messages 通道 effort 词表同为 low/xhigh，help.aliyun.com）",
        model: "qwen3.8-max",
        off: DISABLED,
        low: effortWithSwitch("low"),
        high: effortWithSwitch("xhigh")
      },
      {
        kind: "永远思考（thinking 系无档位；三档全不发）",
        model: "qwen3-next-80b-a3b-thinking",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    presetId: "zhipu",
    name: "GLM 智谱（open.bigmodel.cn/api/anthropic）",
    cases: [
      {
        kind: "混合开关（glm-4.6；low/high 塌陷）",
        model: "glm-4.6",
        off: DISABLED,
        low: BUDGET,
        high: BUDGET
      },
      {
        kind: "混合 effort（glm-5.2；Messages 通道发 output_config.effort，docs.bigmodel.cn）",
        model: "glm-5.2",
        off: DISABLED,
        low: effortWithSwitch("low"),
        high: effortWithSwitch("high")
      },
      {
        kind: "永远思考（glm-5.3 无档位；三档全不发）",
        model: "glm-5.3",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    presetId: "moonshot",
    name: "Kimi/moonshot（api.kimi.com/coding）",
    cases: [
      {
        kind: "混合开关（kimi-k2.6；low/high 塌陷）",
        model: "kimi-k2.6",
        off: DISABLED,
        low: BUDGET,
        high: BUDGET
      },
      {
        kind: "永远思考 + effort（kimi-k3：off 级联落 low；Messages 通道发顶层 reasoning_effort，kimi.com/code/docs）",
        model: "kimi-k3",
        off: reasoningEffort("low"),
        low: reasoningEffort("low"),
        high: reasoningEffort("high")
      },
      {
        kind: "永远思考（kimi-k2.7-code 强制 keep:all 无档位；三档全不发）",
        model: "kimi-k2.7-code",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    presetId: "minimax",
    name: "MiniMax（api.minimaxi.com/anthropic）",
    cases: [
      {
        kind: "永远思考（M2 无开关无档位；三档全不发 + offUnavailable）",
        model: "MiniMax-M2",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    presetId: "mimo",
    name: "Mimo 小米（api.xiaomimimo.com/anthropic）",
    cases: [
      {
        kind: "混合开关（mimo-v2.5-pro；low/high 塌陷）",
        model: "mimo-v2.5-pro",
        off: DISABLED,
        low: BUDGET,
        high: BUDGET
      }
    ]
  },
  {
    presetId: "opencodego",
    name: "Opencode Go（opencode.ai/zen/go）",
    cases: [
      {
        kind: "override effort 平台（矩阵 off 关不掉、级联落 low；网关无档位词汇文档 → 按产品裁定发裸 output_config.effort，opencode.ai/docs）",
        model: "deepseek-v4-flash",
        off: effortOnly("low"),
        low: effortOnly("low"),
        high: effortOnly("high")
      }
    ]
  },
  {
    presetId: "openrouter",
    name: "OpenRouter（openrouter.ai/api）",
    cases: [
      {
        kind: "override effort 平台（openai 侧 off=effort none；Messages 通道只发 output_config.effort，openrouter.ai/docs）",
        model: "deepseek-v4-pro",
        off: DISABLED,
        low: effortOnly("low"),
        high: effortOnly("high")
      }
    ]
  },
  {
    presetId: "stepfun",
    name: "StepFun（api.stepfun.com/step_plan）",
    cases: [
      {
        kind: "永远思考 + effort（step-3.7-flash；effortVocabMessages：只发 output_config.effort，off 级联落 low，low/high 不塌陷）",
        model: "step-3.7-flash",
        off: { output_config: { effort: "low" } },
        low: { output_config: { effort: "low" } },
        high: { output_config: { effort: "high" } }
      },
      {
        kind: "永远思考（step-3 无档位；三档全不发 + offUnavailable）",
        model: "step-3",
        off: {},
        low: {},
        high: {}
      }
    ]
  },
  {
    presetId: "modelscope",
    name: "ModelScope（api-inference.modelscope.cn）",
    cases: [
      {
        kind: "org 限定 id → unknownClass 兜底（enable_thinking 词汇；off 显式 thinking:disabled 才能真正关掉，low/high 塌陷）",
        model: "deepseek-ai/DeepSeek-V4.1-Flash",
        off: DISABLED,
        low: BUDGET,
        high: BUDGET
      },
      {
        kind: "命中 effort 血统（直填 id qwen3.8-max → 血统档位词 low/xhigh；端点未登记档位词汇 → 按产品裁定发裸 output_config.effort）",
        model: "qwen3.8-max",
        off: DISABLED,
        low: effortOnly("low"),
        high: effortOnly("xhigh")
      }
    ]
  },
  {
    presetId: "amd",
    name: "AMD Radeon Cloud（developer.amd.com.cn/radeon/api）",
    cases: [
      {
        kind: "override effort + effortVocabMessages（off=effort none 被丢弃 → 不发；low/high 不塌陷）",
        model: "DeepSeek-V4-Flash",
        off: {},
        low: { output_config: { effort: "low" } },
        high: { output_config: { effort: "high" } }
      }
    ]
  },
  {
    presetId: "sensenova",
    name: "SenseNova 商汤（token.sensenova.cn）",
    cases: [
      {
        kind: "override effort 平台（openai 侧 effort 词表；Messages 通道发 output_config.effort，platform.sensenova.cn 保守取 low/medium/high）",
        model: "deepseek-v4-flash",
        off: DISABLED,
        low: effortWithSwitch("low"),
        high: effortWithSwitch("high")
      }
    ]
  },
  {
    presetId: "ollama",
    name: "Ollama（无 anthropic 端点，baseUrl 代位 http://localhost:11434/v1）",
    cases: [
      {
        kind: "unknownClass 兜底（openai 侧 effort 词汇平台无规则；Messages 通道无档位词汇文档 → 退回按档预算，docs.ollama.com）",
        model: "llama3.2",
        off: DISABLED,
        low: BUDGET,
        high: BUDGET_HIGH
      },
      {
        kind: "模式表命中（deepseek-r1:8b 永远思考无档位；三档全不发）",
        model: "deepseek-r1:8b",
        off: {},
        low: {},
        high: {}
      }
    ]
  }
];

function bodyFor(presetId: string, model: string, level: string, extra: { stream?: boolean; probe?: boolean; maxTokens?: number } = {}) {
  return anthropicAdapter.buildBody({
    model,
    messages: MESSAGES,
    stream: extra.stream ?? false,
    probe: extra.probe ?? false,
    baseUrl: baseUrlOf(presetId),
    presetId,
    thinkingLevel: level,
    ...(extra.maxTokens != null ? { maxTokens: extra.maxTokens } : {})
  });
}

for (const platform of PLATFORMS) {
  describe(`golden：${platform.name}`, () => {
    for (const c of platform.cases) {
      for (const level of ["off", "low", "high"] as const) {
        it(`${c.model}（${c.kind}）· ${level}`, () => {
          expect(bodyFor(platform.presetId, c.model, level)).toEqual({
            model: c.model,
            messages: MESSAGES,
            stream: false,
            max_tokens: DEFAULT_MAX_TOKENS,
            ...c[level]
          });
        });
      }
    }
  });
}

// 探针变体（怪癖 probeOmitsThinking）：探针 maxTokens=1，任何 thinking 字段都会把
// 探针打成 400（budget_tokens ≥1024 且须 < max_tokens），故 probe=true 一律不发思考
// 字段——deepseek（有档位可发）与 stepfun（effort 词汇）两条路都要钉住。
describe("golden：探针变体（probe 不发思考字段）", () => {
  it("deepseek + deepseek-v4-pro + probe + maxTokens:1 + high → 无 thinking", () => {
    expect(bodyFor("deepseek", "deepseek-v4-pro", "high", { probe: true, maxTokens: 1 })).toEqual({
      model: "deepseek-v4-pro",
      messages: MESSAGES,
      stream: false,
      max_tokens: 1
    });
  });

  it("stepfun + step-3.7-flash + probe + maxTokens:1 + high → 无 output_config", () => {
    expect(bodyFor("stepfun", "step-3.7-flash", "high", { probe: true, maxTokens: 1 })).toEqual({
      model: "step-3.7-flash",
      messages: MESSAGES,
      stream: false,
      max_tokens: 1
    });
  });
});

// ModelScope + qwen3-32b（裸 id 命中模式表，血统声明关思考仅流式）：off 在非流式被
// streamOnly 阻断 → 级联落开档，只有流式才真发 thinking:disabled。与 openai 通道
// 的 enable_thinking 事实同源，形状换成 Messages 的 thinking。
describe("golden：ModelScope qwen3-32b 关思考仅流式（stream 维度）", () => {
  it("stream:true + off → thinking:disabled", () => {
    expect(bodyFor("modelscope", "qwen3-32b", "off", { stream: true })).toEqual({
      model: "qwen3-32b",
      messages: MESSAGES,
      stream: true,
      max_tokens: DEFAULT_MAX_TOKENS,
      thinking: { type: "disabled" }
    });
  });

  it("stream:false + off → 级联落开档（thinking:enabled）", () => {
    expect(bodyFor("modelscope", "qwen3-32b", "off", { stream: false })).toEqual({
      model: "qwen3-32b",
      messages: MESSAGES,
      stream: false,
      max_tokens: DEFAULT_MAX_TOKENS,
      thinking: { type: "enabled", budget_tokens: 2048 }
    });
  });
});

// 02 号票的验收判据（7 家 × {low, high} 的 Messages 请求体互不相同）。每家的取值依据与
// 出处域名见 ai/thinking-wire-map.ts 的 MESSAGES_TIER_VOCABULARY 注释与调研报告
// （调研未经真实请求，全部结论来自官方文档）。
describe("验收：8 家 effort 血统的 low 与 high 请求体互不相同（02 号票）", () => {
  const CASES: Array<{ presetId: string; model: string; note: string }> = [
    { presetId: "deepseek", model: "deepseek-v4-pro", note: "output_config.effort（api-docs.deepseek.com）" },
    { presetId: "zhipu", model: "glm-5.2", note: "output_config.effort（docs.bigmodel.cn）" },
    { presetId: "moonshot", model: "kimi-k3", note: "顶层 reasoning_effort（kimi.com/code/docs）" },
    { presetId: "qwen", model: "qwen3.8-max", note: "output_config.effort（help.aliyun.com）" },
    { presetId: "openrouter", model: "deepseek-v4-pro", note: "output_config.effort（openrouter.ai/docs）" },
    { presetId: "sensenova", model: "deepseek-v4-flash", note: "output_config.effort（platform.sensenova.cn）" },
    { presetId: "opencodego", model: "deepseek-v4-flash", note: "裸 output_config.effort（产品裁定；opencode.ai/docs 无档位词汇文档）" },
    { presetId: "modelscope", model: "qwen3.8-max", note: "裸 output_config.effort（产品裁定；api-inference.modelscope.cn 无档位词汇文档）" }
  ];

  for (const c of CASES) {
    it(`${c.presetId}/${c.model}：low ≠ high（${c.note}）`, () => {
      const low = bodyFor(c.presetId, c.model, "low");
      const high = bodyFor(c.presetId, c.model, "high");
      expect(JSON.stringify(low)).not.toBe(JSON.stringify(high));
    });
  }
});
