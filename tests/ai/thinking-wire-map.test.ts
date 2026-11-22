import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSIGNMENTS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { hasPlatformQuirk } from "../../extension/ai/compat-vocab.js";
import {
  AI_THINKING_LEVELS,
  NO_FIELDS,
  PROVIDERS,
  UNKNOWN_VOCABULARY,
  UPSTREAM_PROVIDER_BY_PRESET,
  enableThinking,
  reasoningEffort,
  resolveThinkingProfile,
  thinkingType,
  type ThinkingVocabulary
} from "../../extension/ai/thinking-profiles.js";
import { PLATFORM_IDENTITY_KEYS, isPlatformKey } from "../../extension/ai/platform-identity-vocab.js";
import { AI_PROTOCOLS } from "../../extension/ai/protocol-vocab.js";
import {
  MESSAGES_OFF_EXIT,
  MESSAGES_ON_EXIT,
  MESSAGES_TIER_EXIT,
  THINKING_WIRE_MAPS,
  UNRESEARCHED_OFF_EXIT,
  UNRESEARCHED_ON_EXIT,
  UNRESEARCHED_TIER_EXIT,
  messagesOffExitCell,
  messagesOnExitCell,
  messagesTierExitCell,
  type AnthropicWireInput,
  type MessagesOnExitKind,
  type MessagesTierExitKind,
  type OpenAiWireInput
} from "../../extension/ai/thinking-wire-map.js";

function anthropicWire(overrides: Partial<AnthropicWireInput> = {}) {
  return THINKING_WIRE_MAPS.anthropic({
    vocabulary: reasoningEffort("low"),
    probe: false,
    ...overrides
  });
}

function openaiWire(overrides: Partial<OpenAiWireInput> = {}) {
  return THINKING_WIRE_MAPS.openai({
    vocabulary: reasoningEffort("low"),
    ...overrides
  });
}

const PLATFORM_KEYS: readonly string[] = [...PLATFORM_IDENTITY_KEYS].sort();

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

describe("平台键集（候选 6：不变式已搬进类型，这里只留一条语义断言）", () => {
  it("PROVIDERS 与三张出口表的运行时键集都 = 平台身份键词表叶，不多不少", () => {
    const tables: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
      ["PROVIDERS", PROVIDERS],
      ["MESSAGES_TIER_EXIT", MESSAGES_TIER_EXIT],
      ["MESSAGES_OFF_EXIT", MESSAGES_OFF_EXIT],
      ["MESSAGES_ON_EXIT", MESSAGES_ON_EXIT]
    ];
    for (const [name, table] of tables) {
      expect(Object.keys(table).sort(), name).toEqual([...PLATFORM_IDENTITY_KEYS].sort());
    }
  });
});

describe("openai 行：血统词汇即本协议的线格式", () => {
  it("词汇原样并入（每次都是新对象）；tokenParam 缺省 max_tokens", () => {
    const vocabulary = reasoningEffort("high");
    const first = openaiWire({ vocabulary });
    expect(first.fields).toEqual({ reasoning_effort: "high" });
    expect(first.fields).not.toBe(openaiWire({ vocabulary }).fields);
    expect(vocabulary).toEqual(reasoningEffort("high"));
    expect(first.tokenParam).toBe("max_tokens");
  });

  it("tokenParam 随血统事实（怪癖 maxTokensField：openai-reasoning 系 max_completion_tokens）", () => {
    expect(openaiWire({ tokenParam: "max_completion_tokens" }).tokenParam).toBe("max_completion_tokens");
  });

  it("无事实（两个哨兵）出参为空；探针不特化（probe 是 Messages 侧事实，openai 行入参里没有它）", () => {
    expect(openaiWire({ vocabulary: NO_FIELDS }).fields).toEqual({});
    expect(openaiWire({ vocabulary: UNKNOWN_VOCABULARY }).fields).toEqual({});
    expect(openaiWire({ vocabulary: enableThinking(true) }).fields).toEqual({ enable_thinking: true });
  });
});

describe("anthropic 行：Messages 通道的写法", () => {
  it("探针早退：任何档位都不发思考字段（怪癖 probeOmitsThinking）", () => {
    const out = anthropicWire({ probe: true, vocabulary: reasoningEffort("high") });
    expect(out).toEqual({ fields: {}, tokenParam: "max_tokens" });
  });

  it("无事实（两个哨兵：无写点 / 无解析结论）不发字段", () => {
    expect(anthropicWire({ vocabulary: NO_FIELDS }).fields).toEqual({});
    expect(anthropicWire({ vocabulary: UNKNOWN_VOCABULARY }).fields).toEqual({});
  });

  it("off 三词汇归一为 thinking:{type:disabled}（怪癖 thinkingDisabledMustBeExplicit）", () => {
    for (const vocabulary of [reasoningEffort("none"), enableThinking(false), thinkingType("disabled")]) {
      expect(anthropicWire({ vocabulary }).fields, vocabulary.kind).toEqual({
        thinking: { type: "disabled" }
      });
    }
  });

  it("effort 词汇平台（怪癖 effortVocabMessages）：off 与开档均静默不发 thinking；档位原样出 output_config.effort", () => {
    for (const platformId of ["stepfun", "amd"]) {
      expect(anthropicWire({ vocabulary: reasoningEffort("none"), platformId }).fields, `${platformId} off`).toEqual({});
      expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId }).fields, `${platformId} effort`).toEqual({
        output_config: { effort: "high" }
      });
      expect(anthropicWire({ vocabulary: enableThinking(true), platformId }).fields, `${platformId} on`).toEqual({});
    }
  });

  it("全表不发 budget_tokens：开关型血统的开档只发裸 thinking:{type:enabled}", () => {
    expect(anthropicWire({ vocabulary: enableThinking(true) }).fields).toEqual({ thinking: { type: "enabled" } });
    expect(anthropicWire({ vocabulary: thinkingType("enabled") }).fields).toEqual({ thinking: { type: "enabled" } });
    expect(JSON.stringify(anthropicWire({ vocabulary: enableThinking(true) }).fields)).not.toContain("budget_tokens");
  });

  it("tokenParam 恒为 max_tokens：血统事实（max_completion_tokens）是 OpenAI 通道的参数名，本行入参里没有它", () => {
    expect(anthropicWire().tokenParam).toBe("max_tokens");
  });

  it("档位分档：文档登记 output_config.effort 的平台带 thinking 开关落 effort 词", () => {
    const low = anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "deepseek" });
    const high = anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "deepseek" });
    expect(low.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "low" } });
    expect(high.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
    expect(low.fields).not.toEqual(high.fields);
    expect(anthropicWire({ vocabulary: reasoningEffort("xhigh"), platformId: "qwen" }).fields).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "xhigh" }
    });
  });

  it("档位分档：只发 output_config.effort 的平台（openrouter / opencodego / modelscope）", () => {
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "openrouter" }).fields).toEqual({
      output_config: { effort: "high" }
    });
    for (const platformId of ["opencodego", "modelscope"]) {
      expect(anthropicWire({ vocabulary: reasoningEffort("low"), platformId }).fields, platformId).toEqual({
        output_config: { effort: "low" }
      });
      expect(anthropicWire({ vocabulary: reasoningEffort("xhigh"), platformId }).fields, platformId).toEqual({
        output_config: { effort: "xhigh" }
      });
    }
  });

  it("档位分档：moonshot（Kimi Code 端点）只发顶层 reasoning_effort", () => {
    expect(anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "low"
    });
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "high"
    });
  });

  it("档位分档：未登记档位词汇的平台（ollama / custom 直填）同样发裸 effort，不下发预算", () => {
    expect(anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "ollama" }).fields).toEqual({
      output_config: { effort: "low" }
    });
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "ollama" }).fields).toEqual({
      output_config: { effort: "high" }
    });
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: undefined }).fields).toEqual({
      output_config: { effort: "high" }
    });
  });

  it("严格 effort 词汇平台（怪癖 effortVocabMessages）：stepfun / amd 仍是原样 effort，不发 thinking", () => {
    for (const platformId of ["stepfun", "amd"]) {
      expect(
        anthropicWire({
          vocabulary: reasoningEffort("high"),
          platformId
        }).fields,
        platformId
      ).toEqual({ output_config: { effort: "high" } });
    }
  });

  it("开关型血统显式登记：无档位词汇，low 与 high 同为裸开档（不带上限）", () => {
    const low = anthropicWire({ vocabulary: enableThinking(true) });
    const high = anthropicWire({ vocabulary: enableThinking(true) });
    expect(low.fields).toEqual({ thinking: { type: "enabled" } });
    expect(high.fields).toEqual(low.fields);
  });
});

describe("三层无重叠主人对账（验收第 4 条，静态判据）", () => {
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const read = (rel: string) => stripComments(readFileSync(rel, "utf8"));

  const ADAPTERS = ["extension/ai/adapters/openai.ts", "extension/ai/adapters/anthropic.ts"];
  const LINEAGE = "extension/ai/thinking-profiles.ts";
  const WIRE_MAP = "extension/ai/thinking-wire-map.ts";
  const AI_MODULES = [...ADAPTERS, LINEAGE, WIRE_MAP, "extension/ai/compat-vocab.ts", "extension/ai/protocol-adapter.ts"];

  const MESSAGES_LITERALS = ["output_config"];

  it("主人自检：线格式映射表里确实有这个 Messages 字面量（防扫描空转）", () => {
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

  it("硬规则：budget_tokens 在 extension/ai 的代码里零出现（任何通道、任何平台都不发思考预算）", () => {
    for (const rel of AI_MODULES) {
      expect(read(rel).includes("budget_tokens"), `${rel} 出现 budget_tokens——本扩展一律不自造思考预算`).toBe(false);
    }
  });

  it("硬规则：思考预算的常量与推导函数已从线格式映射表删除（不留无人消费的出口）", () => {
    const owner = read(WIRE_MAP);
    for (const gone of ["MIN_BUDGET_TOKENS", "DEFAULT_BUDGET_TOKENS", "HIGH_BUDGET_TOKENS", "TIER_BUDGET_BY_LEVEL", "openThinking", "thinkingFitsMaxTokens"]) {
      expect(owner.includes(gone), `${WIRE_MAP} 仍含 ${gone}`).toBe(false);
    }
  });
});

describe("归一化不发散（08 号票：像集合 ⊆ 该模型 02 值集）", () => {
  const PRESET_BY_UPSTREAM: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(UPSTREAM_PROVIDER_BY_PRESET).map(([presetId, upstreamId]) => [upstreamId, presetId])
  );

  function wireWord(fields: Record<string, unknown>): string | undefined {
    const outputConfig = fields.output_config as { effort?: unknown } | undefined;
    if (typeof outputConfig?.effort === "string") return outputConfig.effort;
    return typeof fields.reasoning_effort === "string" ? fields.reasoning_effort : undefined;
  }

  it("02 指派表逐条 × 7 档：Messages 出口上的档位词 ∈ 该模型值集", () => {
    let comparedModels = 0;
    let emittedWords = 0;
    for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
      const presetId = PRESET_BY_UPSTREAM[upstreamId];
      expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
      for (const model of Object.keys(table)) {
        const fact = lookupThinkingFact(upstreamId, model);
        expect(fact, `${upstreamId}/${model} 有指派却查不到值集`).toBeTruthy();
        const valuesetWords = new Set(fact!.effort ?? []);
        comparedModels += 1;
        for (const level of AI_THINKING_LEVELS) {
          const profile = resolveThinkingProfile({ presetId, model, level, stream: false });
          const word = wireWord(anthropicWire({ vocabulary: profile.vocabulary, platformId: presetId }).fields);
          if (word === undefined) continue;
          emittedWords += 1;
          expect(
            valuesetWords.has(word),
            `${presetId}/${model} · ${level}：出口发出 "${word}"，不在该模型 02 值集 [${[...valuesetWords].join("/")}]`
          ).toBe(true);
        }
      }
    }
    expect(comparedModels).toBeGreaterThanOrEqual(359);
    expect(emittedWords).toBeGreaterThanOrEqual(1300);
  });

  it("判据非空转：值集不含的档位词不合法（glm-5.2 值集 toggle+high-max，无 low 可发）", () => {
    expect(lookupThinkingFact("zhipuai", "glm-5.2")!.effort).toEqual(["high", "max"]);
  });
});

describe("off 出口表（thinking-wire-protocol-split 02）：逐格可审，行为中立", () => {
  it("四态可区分：「未研究过」与「声明为原生」是两个显式值，不许 falsy 默认吞掉", () => {
    const kinds = new Set(Object.values(MESSAGES_OFF_EXIT).map((cell) => cell.kind));
    expect(kinds.has("native")).toBe(true);
    for (const [platform, cell] of Object.entries(MESSAGES_OFF_EXIT)) {
      expect(["native", "silent", "word", "unresearched", "non-messages"], platform).toContain(cell.kind);
    }
    expect(MESSAGES_OFF_EXIT.gemini.kind).toBe("non-messages");
  });

  it("provenance 必填：三态取值合法、出处非空；silent 带 reason、word 带载荷", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_OFF_EXIT)) {
      expect(["实测", "文档", "推断", "构造性不适用"], platform).toContain(cell.provenance.level);
      expect(cell.provenance.source.length, platform).toBeGreaterThan(8);
      if (cell.kind === "silent") expect(cell.reason, platform).toBeTruthy();
      if (cell.kind === "word") expect(cell.fields, platform).toBeTruthy();
    }
  });

  it("怪癖 owner 对账：声明 owner=effortVocabMessages 的格 ≡ 词表里开该怪癖的平台（不复制键集）", () => {
    const declared = Object.entries(MESSAGES_OFF_EXIT)
      .filter(([, cell]) => cell.owner === "effortVocabMessages")
      .map(([platform]) => platform)
      .sort();
    const quirkPlatforms = PLATFORM_KEYS.filter((platform) => hasPlatformQuirk(platform, "effortVocabMessages"));
    expect(declared).toEqual(quirkPlatforms);
    expect(declared).toEqual(["amd", "stepfun"]);
  });

  it("表外 / 未识别平台 → 未声明（原生）；原型链上的键不算表内格", () => {
    expect(messagesOffExitCell(undefined).kind).toBe("unresearched");
    expect(messagesOffExitCell("未登记的平台").kind).toBe("unresearched");
    expect(messagesOffExitCell("constructor").kind).toBe("unresearched");
    expect(messagesOffExitCell("toString").kind).toBe("unresearched");
  });

  it("逐格实发：off 三词汇 × 表内声明（silent / non-messages → 不发；word → 平台自有词；其余 → 原生）", () => {
    for (const platform of PLATFORM_KEYS) {
      const cell = messagesOffExitCell(platform);
      for (const vocabulary of [reasoningEffort("none"), enableThinking(false), thinkingType("disabled")]) {
        const out = anthropicWire({ vocabulary, platformId: platform });
        const expected =
          cell.kind === "non-messages" || cell.kind === "silent"
            ? {}
            : cell.kind === "word" && cell.fields
              ? cell.fields
              : { thinking: { type: "disabled" } };
        expect(out.fields, `${platform} kind=${cell.kind} vocabulary=${vocabulary.kind}`).toEqual(expected);
      }
    }
    expect(anthropicWire({ vocabulary: reasoningEffort("none") }).fields).toEqual({ thinking: { type: "disabled" } });
    expect(anthropicWire({ vocabulary: enableThinking(false), platformId: undefined }).fields).toEqual({
      thinking: { type: "disabled" }
    });
  });

  it("级联不受本表影响：表只回答「off 写点存在时的出口」，档位级联仍在解析层（ADR-0008）", () => {
    expect(
      anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "stepfun" }).fields
    ).toEqual({ output_config: { effort: "low" } });
  });
});

describe("档位出口表（thinking-wire-protocol-split 01）：逐格可审，行为中立", () => {
  const ALL_KINDS: readonly MessagesTierExitKind[] = ["effort", "effort-bare", "reasoning-effort", "unresearched", "non-messages"];

  it("四态可区分：「未研究过」与「已声明只发裸 effort」是两个显式值，不许 falsy 默认吞掉", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_TIER_EXIT)) {
      expect(ALL_KINDS, platform).toContain(cell.kind);
    }
    expect(MESSAGES_TIER_EXIT.gemini.kind).toBe("non-messages");
    expect(MESSAGES_TIER_EXIT.minimax.kind).toBe("effort");
    expect(MESSAGES_TIER_EXIT.mimo.kind).toBe("unresearched");
    expect(MESSAGES_TIER_EXIT.ollama.kind).toBe("unresearched");
    expect(MESSAGES_TIER_EXIT.siliconflow.kind).toBe("unresearched");
    expect(MESSAGES_TIER_EXIT.openrouter.kind).toBe("effort-bare");
    expect(MESSAGES_TIER_EXIT.stepfun.kind).toBe("effort-bare");
    expect(MESSAGES_TIER_EXIT.deepseek.kind).toBe("effort");
    expect(MESSAGES_TIER_EXIT.moonshot.kind).toBe("reasoning-effort");
  });

  it("provenance 必填：三态取值合法、出处非空（每格都答得出「凭什么」）", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_TIER_EXIT)) {
      expect(["实测", "文档", "推断", "构造性不适用"], platform).toContain(cell.provenance.level);
      expect(cell.provenance.source.length, platform).toBeGreaterThan(8);
    }
    expect(UNRESEARCHED_TIER_EXIT.provenance.level).toBe("推断");
    expect(UNRESEARCHED_TIER_EXIT.provenance.source.length).toBeGreaterThan(8);
  });

  it("怪癖 owner 对账：声明 owner=effortVocabMessages 的格 ≡ 词表里开该怪癖的平台（不复制键集）", () => {
    const declared = Object.entries(MESSAGES_TIER_EXIT)
      .filter(([, cell]) => cell.owner === "effortVocabMessages")
      .map(([platform]) => platform)
      .sort();
    const quirkPlatforms = PLATFORM_KEYS.filter((platform) => hasPlatformQuirk(platform, "effortVocabMessages"));
    expect(declared).toEqual(quirkPlatforms);
    expect(declared).toEqual(["amd", "stepfun"]);
  });

  it("表外 / 未识别平台 → 未声明（裸 effort）；原型链上的键不算表内格", () => {
    expect(messagesTierExitCell(undefined).kind).toBe("unresearched");
    expect(messagesTierExitCell("未登记的平台").kind).toBe("unresearched");
    expect(messagesTierExitCell("constructor").kind).toBe("unresearched");
    expect(messagesTierExitCell("toString").kind).toBe("unresearched");
  });

  it("逐格实发：kind × 形态（effort = 档位词 + 开关；effort-bare / unresearched = 裸档位词；reasoning-effort = 顶层）", () => {
    for (const platform of PLATFORM_KEYS) {
      const cell = messagesTierExitCell(platform);
      const out = anthropicWire({
        vocabulary: reasoningEffort("high"),
        platformId: platform
      });
      const onCell = messagesOnExitCell(platform);
      const onFields = onCell.kind === "word" && onCell.fields ? onCell.fields : { thinking: { type: "enabled" } };
      const expected =
        cell.kind === "non-messages"
          ? {}
          : cell.kind === "reasoning-effort"
            ? { reasoning_effort: "high" }
            : cell.kind === "effort"
              ? { output_config: { effort: "high" }, ...onFields }
              : { output_config: { effort: "high" } };
      expect(out.fields, `${platform} kind=${cell.kind}${cell.owner ? ` owner=${cell.owner}` : ""}`).toEqual(expected);
    }
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: undefined }).fields).toEqual({
      output_config: { effort: "high" }
    });
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "未登记的平台" }).fields).toEqual({
      output_config: { effort: "high" }
    });
  });

  it("同一通道内的擦边格：moonshot 档位走顶层 reasoning_effort、off 走原生 thinking（两表各自表态）", () => {
    expect(MESSAGES_TIER_EXIT.moonshot.kind).toBe("reasoning-effort");
    expect(MESSAGES_OFF_EXIT.moonshot.kind).toBe("native");
    expect(anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "low"
    });
    expect(anthropicWire({ vocabulary: reasoningEffort("none"), platformId: "moonshot" }).fields).toEqual({
      thinking: { type: "disabled" }
    });
  });

  it("档位表不接管开关型血统：词汇只有开关时按开词表落线（off / 开关走各自的分支）", () => {
    expect(anthropicWire({ vocabulary: enableThinking(true), platformId: "moonshot" }).fields).toEqual({
      thinking: { type: "enabled" }
    });
    expect(anthropicWire({ vocabulary: thinkingType("enabled"), platformId: "deepseek" }).fields).toEqual({
      thinking: { type: "enabled" }
    });
  });
});

describe("开词出口表（MESSAGES_ON_EXIT）：逐格可审，纯查表分派", () => {
  const ALL_KINDS: readonly MessagesOnExitKind[] = ["native", "silent", "word", "unresearched", "non-messages"];

  it("五态可区分：minimax 为平台自有词、stepfun/amd 为 silent、gemini 为 non-messages，其余按原生；未识别平台走表外兜底", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_ON_EXIT)) {
      expect(ALL_KINDS, platform).toContain(cell.kind);
      if (cell.kind === "silent") expect(cell.reason, platform).toBeTruthy();
      if (cell.kind === "word") expect(cell.fields, platform).toBeTruthy();
    }
    expect(MESSAGES_ON_EXIT.gemini.kind).toBe("non-messages");
    expect(MESSAGES_ON_EXIT.stepfun.kind).toBe("silent");
    expect(MESSAGES_ON_EXIT.amd.kind).toBe("silent");
    expect(MESSAGES_ON_EXIT.minimax.kind).toBe("word");
    expect(MESSAGES_ON_EXIT.minimax.fields).toEqual({ thinking: { type: "adaptive" } });
    expect(messagesOnExitCell(undefined).kind).toBe("unresearched");
    expect(messagesOnExitCell("未登记的平台").kind).toBe("unresearched");
    expect(messagesOnExitCell("constructor").kind).toBe("unresearched");
    expect(messagesOnExitCell("toString").kind).toBe("unresearched");
  });

  it("怪癖 owner 对账：声明 owner=effortVocabMessages 的格 ≡ 词表里开该怪癖的平台（不复制键集）", () => {
    const declared = Object.entries(MESSAGES_ON_EXIT)
      .filter(([, cell]) => cell.owner === "effortVocabMessages")
      .map(([platform]) => platform)
      .sort();
    const quirkPlatforms = PLATFORM_KEYS.filter((platform) => hasPlatformQuirk(platform, "effortVocabMessages"));
    expect(declared).toEqual(quirkPlatforms);
    expect(declared).toEqual(["amd", "stepfun"]);
  });

  it("provenance 必填：三态取值合法、出处非空（每格都答得出「凭什么」）", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_ON_EXIT)) {
      expect(["实测", "文档", "推断", "构造性不适用"], platform).toContain(cell.provenance.level);
      expect(cell.provenance.source.length, platform).toBeGreaterThan(8);
    }
    expect(UNRESEARCHED_ON_EXIT.provenance.level).toBe("推断");
    expect(UNRESEARCHED_ON_EXIT.provenance.source.length).toBeGreaterThan(8);
  });

  it("硬规则：本表任何一格的载荷都不含思考预算（只发不带预算的开关形状）", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_ON_EXIT)) {
      expect(JSON.stringify(cell.fields ?? {}), platform).not.toContain("budget_tokens");
    }
    expect(JSON.stringify(anthropicWire({ vocabulary: enableThinking(true), platformId: "minimax" }).fields)).not.toContain(
      "budget_tokens"
    );
  });

  it("逐格实发：silent / non-messages 不发、word 发平台自有词、其余发原生 enabled（两条开档入口都读本表）", () => {
    for (const platform of PLATFORM_KEYS) {
      const cell = messagesOnExitCell(platform);
      if (cell.kind === "non-messages" || cell.kind === "silent") {
        expect(
          anthropicWire({ vocabulary: enableThinking(true), platformId: platform }).fields,
          `${platform} ${cell.kind}`
        ).toEqual({});
        continue;
      }
      const expected = cell.kind === "word" && cell.fields ? cell.fields : { thinking: { type: "enabled" } };
      expect(
        anthropicWire({ vocabulary: enableThinking(true), platformId: platform }).fields,
        `${platform} 裸开档`
      ).toEqual(expected);
      const tierCell = messagesTierExitCell(platform);
      if (tierCell.kind === "effort") {
        expect(
          anthropicWire({ vocabulary: reasoningEffort("high"), platformId: platform }).fields,
          `${platform} effort 出口`
        ).toEqual({ output_config: { effort: "high" }, ...expected });
      }
    }
    expect(anthropicWire({ vocabulary: enableThinking(true), platformId: undefined }).fields).toEqual({
      thinking: { type: "enabled" }
    });
  });

  it("minimax 专项：开词是 adaptive（该端点的 enum 里没有 enabled）", () => {
    expect(anthropicWire({ vocabulary: enableThinking(true), platformId: "minimax" }).fields).toEqual({
      thinking: { type: "adaptive" }
    });
    expect(anthropicWire({ vocabulary: thinkingType("adaptive"), platformId: "minimax" }).fields).toEqual({
      thinking: { type: "adaptive" }
    });
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "minimax" }).fields).toEqual({
      output_config: { effort: "high" },
      thinking: { type: "adaptive" }
    });
  });

  it("silent 格：stepfun / amd 裸开档按表静默不发 thinking，档位只发裸 output_config.effort", () => {
    for (const platform of ["stepfun", "amd"]) {
      expect(
        anthropicWire({ vocabulary: enableThinking(true), platformId: platform }).fields,
        platform
      ).toEqual({});
      expect(
        anthropicWire({ vocabulary: reasoningEffort("high"), platformId: platform }).fields,
        platform
      ).toEqual({ output_config: { effort: "high" } });
    }
  });
});

describe("入参分型（宽松事实收口 01 的第 1、2 项）：每行只收自己读得到的字段", () => {
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const WIRE_MAP = "extension/ai/thinking-wire-map.ts";
  const OPENAI_ADAPTER = "extension/ai/adapters/openai.ts";
  it("判据非空转：同一形状的合法入参照常通过（字段落在正确的行上）", () => {
    expect(openaiWire({ tokenParam: "max_completion_tokens" }).tokenParam).toBe("max_completion_tokens");
    expect(
      anthropicWire({
        vocabulary: reasoningEffort("high"),
        probe: false,
        platformId: "deepseek"
      }).fields
    ).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
  });
  it("isPlatformKey：词表内为真；表外 / 非串 / 原型链上的键为假", () => {
    for (const key of PLATFORM_IDENTITY_KEYS) {
      expect(isPlatformKey(key), key).toBe(true);
    }
    for (const value of ["", "custom", "ghost", "constructor", "toString", undefined, null, 42, {}]) {
      expect(isPlatformKey(value), String(value)).toBe(false);
    }
  });
});
