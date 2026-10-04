// ai/thinking-wire-map.ts 的单测（thinking-wire-map 票 01）。三件事在此钉死：
// 1. 表结构：键覆盖词表叶（Record<AiProtocol, …> 注解的运行时对账），两行各自可调用；
// 2. 逐行写法：openai 行 = 血统词汇原样并入 + token 参数名随血统事实；anthropic 行 =
//    Messages 通道的写法（probe 早退 / off 三词汇归一 / effort 词汇平台改写 / budget
//    推算）。本票**逐字节钉住现状，含 02 号票要翻转的塌陷格**；
// 3. 三层无重叠主人对账（验收第 4 条，测试期静态判据，不进运行时）：Messages 线格式
//    字面量只在线格式映射表出现；adapter 内不再有思考词汇字面量的构造性写入；
//    血统表不含 Messages 通道的字段名。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AI_PROTOCOLS } from "../../extension/ai/protocol-vocab.js";
import { DEFAULT_BUDGET_TOKENS, MIN_BUDGET_TOKENS, THINKING_WIRE_MAPS, type ThinkingWireInput } from "../../extension/ai/thinking-wire-map.js";

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

  // 塌陷格：02 号票的修复锚点。同一血统的 low 与 high 在 Messages 通道线上完全同值
  //（档位的值不参与计算）——本票有意保持，golden 逐字节钉住；翻转由 02 号票显式做。
  it("塌陷格：effort 血统的 low 与 high 同值（02 号票在此翻转）", () => {
    const low = anthropicWire({ fields: { reasoning_effort: "low" }, level: "low" });
    const high = anthropicWire({ fields: { reasoning_effort: "high" }, level: "high" });
    expect(low).toEqual(high);
    expect(high.fields).toEqual({ thinking: { type: "enabled", budget_tokens: DEFAULT_BUDGET_TOKENS } });
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
