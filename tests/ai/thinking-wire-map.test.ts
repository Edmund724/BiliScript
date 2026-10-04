// ai/thinking-wire-map.ts 的单测（thinking-wire-map 票 01）。三件事在此钉死：
// 1. 表结构：键覆盖词表叶（Record<AiProtocol, …> 注解的运行时对账），两行各自可调用；
// 2. 逐行写法：openai 行 = 血统词汇原样并入 + token 参数名随血统事实；anthropic 行 =
//    Messages 通道的写法（probe 早退 / off 三词汇归一 / effort 档位分档与档位词汇表 /
//    开关型血统的显式一格 / 未文档化平台的按档预算回退）；
// 3. 三层无重叠主人对账（验收第 4 条，测试期静态判据，不进运行时）：Messages 线格式
//    字面量只在线格式映射表出现；adapter 内不再有思考词汇字面量的构造性写入；
//    血统表不含 Messages 通道的字段名。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_PROTOCOLS } from "../../extension/ai/protocol-vocab.js";
import { DEFAULT_BUDGET_TOKENS, HIGH_BUDGET_TOKENS, MIN_BUDGET_TOKENS, THINKING_WIRE_MAPS, type ThinkingWireInput } from "../../extension/ai/thinking-wire-map.js";

// 便捷入参：默认「非探针、流式关、上限 32768、非 effort 词汇平台、血统给 low 档」，
// 用例只覆盖自己关心的维度（不改的维度保持默认）。
function anthropicWire(overrides: Partial<ThinkingWireInput> = {}) {
  return THINKING_WIRE_MAPS.anthropic({
    fields: { reasoning_effort: "low" },
    level: "low",
    stream: false,
    probe: false,
    maxTokens: 32768,
    effortVocabularyOnly: false,
    ...overrides
  });
}

function openaiWire(overrides: Partial<ThinkingWireInput> = {}) {
  return THINKING_WIRE_MAPS.openai({
    fields: { reasoning_effort: "low" },
    level: "low",
    stream: false,
    probe: false,
    maxTokens: 32768,
    effortVocabularyOnly: false,
    ...overrides
  });
}

describe("表结构（Record<AiProtocol, …> 强制覆盖）", () => {
  it("键 = 词表叶的 AiProtocol 全集，不多不少", () => {
    expect(Object.keys(THINKING_WIRE_MAPS).sort()).toEqual([...AI_PROTOCOLS].sort());
  });

  it("每行都是可调用的映射（新增协议漏登记在编译期即红）", () => {
    for (const protocol of AI_PROTOCOLS) {
      expect(typeof THINKING_WIRE_MAPS[protocol], protocol).toBe("function");
    }
  });
});

describe("openai 行：血统词汇即本协议的线格式", () => {
  it("fields 原样并入（新对象，不与入参共享引用）；tokenParam 缺省 max_tokens", () => {
    const input = { reasoning_effort: "high" };
    const out = openaiWire({ fields: input });
    expect(out.fields).toEqual({ reasoning_effort: "high" });
    expect(out.fields).not.toBe(input);
    expect(out.tokenParam).toBe("max_tokens");
  });

  it("tokenParam 随血统事实（怪癖 maxTokensField：openai-reasoning 系 max_completion_tokens）", () => {
    expect(openaiWire({ tokenParam: "max_completion_tokens" }).tokenParam).toBe("max_completion_tokens");
  });

  it("无事实（空 patch）出参为空；探针不特化（OpenAI 通道探针照发思考字段，现状不变）", () => {
    expect(openaiWire({ fields: {} }).fields).toEqual({});
    expect(openaiWire({ probe: true, fields: { enable_thinking: true } }).fields).toEqual({ enable_thinking: true });
  });
});

describe("anthropic 行：Messages 通道的写法", () => {
  it("探针早退：任何档位都不发思考字段（怪癖 probeOmitsThinking）", () => {
    const out = anthropicWire({ probe: true, fields: { reasoning_effort: "high" }, maxTokens: 1 });
    expect(out).toEqual({ fields: {}, tokenParam: "max_tokens" });
  });

  it("无事实（空 patch）不发字段", () => {
    expect(anthropicWire({ fields: {} }).fields).toEqual({});
  });

  it("off 三词汇归一为 thinking:{type:disabled}（怪癖 thinkingDisabledMustBeExplicit）", () => {
    for (const fields of [
      { reasoning_effort: "none" },
      { enable_thinking: false },
      { thinking: { type: "disabled" } }
    ]) {
      expect(anthropicWire({ fields, level: "off" }).fields, JSON.stringify(fields)).toEqual({
        thinking: { type: "disabled" }
      });
    }
  });

  it("effort 词汇平台（怪癖 effortVocabMessages）：off 不发任何字段；开档原样出 output_config.effort", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "none" }, level: "off", effortVocabularyOnly: true }).fields).toEqual({});
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", effortVocabularyOnly: true }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // 矩阵给的是别的开关词汇（无 reasoning_effort）→ 不发——软失败优于硬 400。
    expect(anthropicWire({ fields: { enable_thinking: true }, effortVocabularyOnly: true }).fields).toEqual({});
  });

  it("开思考（怪癖 thinkingBudgetTokens）：budget = min(2048, maxTokens-1)，夹在 [1024, maxTokens) 内", () => {
    expect(anthropicWire({ maxTokens: 32768 }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: DEFAULT_BUDGET_TOKENS }
    });
    // 上限小于默认预算 → 取 maxTokens-1。
    expect(anthropicWire({ maxTokens: 1500 }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: 1499 }
    });
    // 放不下（下限 1024）：maxTokens 1025 → budget 1024 恰可发；1024 及以下不发。
    expect(anthropicWire({ maxTokens: 1025 }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: MIN_BUDGET_TOKENS }
    });
    expect(anthropicWire({ maxTokens: 1024 }).fields).toEqual({});
    expect(anthropicWire({ maxTokens: 500 }).fields).toEqual({});
    // 无上限事实（调用方没给 max_tokens）→ 不发。
    expect(anthropicWire({ maxTokens: undefined }).fields).toEqual({});
  });

  it("tokenParam 恒为 max_tokens：血统事实（max_completion_tokens）是 OpenAI 通道的参数名", () => {
    expect(anthropicWire({ tokenParam: "max_completion_tokens" }).tokenParam).toBe("max_tokens");
  });

  // 分档（02 号票）：effort 血统的档位词在各平台官方登记的档位字段上落线；未登记档位词汇
  // 的平台退回按档分配 budget。修复前这里 low 与 high 同值（塌陷），现在逐格可区分。
  it("档位分档：文档登记 output_config.effort 的平台带 thinking 开关落 effort 词", () => {
    const low = anthropicWire({ fields: { reasoning_effort: "low" }, level: "low", platformId: "deepseek" });
    const high = anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", platformId: "deepseek" });
    expect(low.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "low" } });
    expect(high.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
    expect(low.fields).not.toEqual(high.fields);
    // 血统的档位词原样透传（qwen3.8-max 的高档词就是平台词表里的 xhigh）。
    expect(anthropicWire({ fields: { reasoning_effort: "xhigh" }, level: "high", platformId: "qwen" }).fields).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "xhigh" }
    });
  });

  it("档位分档：只发 output_config.effort 的平台（openrouter / opencodego / modelscope）", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", platformId: "openrouter" }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // opencodego / modelscope：官方文档未登记档位词汇，按产品裁定发裸 effort 词汇，
    // 不再退回自定 budget_tokens（出处见 ai/thinking-wire-map.ts 的 MESSAGES_TIER_VOCABULARY）。
    for (const platformId of ["opencodego", "modelscope"]) {
      expect(
        anthropicWire({ fields: { reasoning_effort: "low" }, level: "low", platformId }).fields,
        platformId
      ).toEqual({ output_config: { effort: "low" } });
      expect(
        anthropicWire({ fields: { reasoning_effort: "xhigh" }, level: "high", platformId }).fields,
        platformId
      ).toEqual({ output_config: { effort: "xhigh" } });
    }
  });

  it("档位分档：moonshot（Kimi Code 端点）只发顶层 reasoning_effort", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "low" }, level: "low", platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "low"
    });
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "high"
    });
  });

  it("档位分档：未登记档位词汇的平台退回按档分配 budget（off 级联落低档预算）", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "low" }, level: "low", platformId: "ollama" }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: DEFAULT_BUDGET_TOKENS }
    });
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", platformId: "ollama" }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: HIGH_BUDGET_TOKENS }
    });
    // 平台识别缺失（custom 直填端点）同样走回退，而不是报错。
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", platformId: undefined }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: HIGH_BUDGET_TOKENS }
    });
    // off 级联后的 fields 仍是低档词，但档位事实是 off → 取低档预算（与 offFallback:"low" 同向）。
    expect(anthropicWire({ fields: { reasoning_effort: "low" }, level: "off", platformId: "ollama" }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: DEFAULT_BUDGET_TOKENS }
    });
  });

  it("档位分档：高档预算同样受 max_tokens 夹取与下限约束", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", maxTokens: 4096 }).fields).toEqual({
      thinking: { type: "enabled", budget_tokens: 4095 }
    });
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, level: "high", maxTokens: 1024 }).fields).toEqual({});
  });

  it("严格 effort 词汇平台（怪癖 effortVocabMessages）优先：stepfun / amd 仍是原样 effort，不发 thinking", () => {
    expect(
      anthropicWire({
        fields: { reasoning_effort: "high" },
        level: "high",
        platformId: "stepfun",
        effortVocabularyOnly: true
      }).fields
    ).toEqual({ output_config: { effort: "high" } });
  });

  it("开关型血统显式登记：无档位词汇，low 与 high 同为开档默认预算", () => {
    const low = anthropicWire({ fields: { enable_thinking: true }, level: "low" });
    const high = anthropicWire({ fields: { enable_thinking: true }, level: "high" });
    expect(low.fields).toEqual({ thinking: { type: "enabled", budget_tokens: DEFAULT_BUDGET_TOKENS } });
    expect(high.fields).toEqual(low.fields);
  });
});

describe("三层无重叠主人对账（验收第 4 条，静态判据）", () => {
  // 去注释后再扫：注释里允许引用键名与出处（如「老式 thinking:{type,budget_tokens}」），
  // 判据只针对**代码里**的构造性出现。URL 里的 // 可能被行注释剥离误伤，但被扫文件
  // 的代码串里不含 URL，够用。
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const read = (rel: string) => stripComments(readFileSync(rel, "utf8"));

  const ADAPTERS = ["extension/ai/adapters/openai.ts", "extension/ai/adapters/anthropic.ts"];
  const LINEAGE = "extension/ai/thinking-profiles.ts";
  const WIRE_MAP = "extension/ai/thinking-wire-map.ts";

  // Messages 通道独有（或归一后独有）的线格式字面量：唯一主人是线格式映射表。
  const MESSAGES_LITERALS = ["budget_tokens", "output_config"];
  // 思考词汇字面量（三套中转词汇的键名）。adapter 不得再出现它们的构造性写入。
  const THINKING_LITERALS = ["enable_thinking", "reasoning_effort", "budget_tokens", "output_config", /(?<![\w.])thinking\s*:/];

  it("主人自检：线格式映射表里确实有这两个 Messages 字面量（防扫描空转）", () => {
    const owner = read(WIRE_MAP);
    for (const literal of MESSAGES_LITERALS) {
      expect(owner, `${literal} 不在 ${WIRE_MAP}`).toContain(literal);
    }
  });

  it("Messages 线格式字面量只在线格式映射表出现（adapter 与血统表都没有）", () => {
    for (const rel of [...ADAPTERS, LINEAGE]) {
      const source = read(rel);
      for (const literal of MESSAGES_LITERALS) {
        expect(source.includes(literal), `${rel} 出现 ${literal}——线格式取值只属于 ${WIRE_MAP}`).toBe(false);
      }
    }
  });

  it("adapter 内不再有思考词汇字面量的构造性写入（取表 → 并入，取值不含词汇知识）", () => {
    for (const rel of ADAPTERS) {
      const source = read(rel);
      for (const pattern of THINKING_LITERALS) {
        const hit = typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
        expect(hit, `${rel} 出现 ${String(pattern)}——adapter 不得知道线格式词汇`).toBe(false);
      }
    }
  });
});
