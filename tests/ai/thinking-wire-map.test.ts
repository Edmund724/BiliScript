// ai/thinking-wire-map.ts 的单测（thinking-wire-map 票 01）。三件事在此钉死：
// 1. 表结构：键覆盖词表叶（Record<AiProtocol, …> 注解的运行时对账），两行各自可调用；
// 2. 逐行写法：openai 行 = 血统词汇原样并入 + token 参数名随血统事实；anthropic 行 =
//    Messages 通道的写法（probe 早退 / off 三词汇归一 / effort 档位分档与档位出口表 /
//    开关型血统的裸开档 / 未登记档位出口的平台发裸 effort）。入参是事实层的**封闭词汇**
//    （ThinkingVocabulary 判别联合），本文件按 kind 驱动写法用例；
// 3. 三层无重叠主人对账（测试期静态判据，不进运行时）：Messages 线格式
//    字面量只在线格式映射表出现；血统表不含 Messages 通道的字段名；
//    **budget_tokens 在 extension/ai 的代码里零出现**。
//    词汇字面量「只出现在写法层」这条不变式不再扫 adapter 源码文本对账——封闭联合 +
//    seam 类型已由 tsc 兜住（adapter 写 `fields: {...}` 或别的形状根本通不过类型），
//    改写坏处的判据改为**按 kind 断行为**（见 tests/ai/thinking-vocabulary.test.ts）。
// 4（08 号票）：归一化层的词汇主人是 02 值集产物——MESSAGES_TIER_EXIT 只做
//    「档位折叠 + 线格式出口」，出口上的档位词必须仍在**该模型** 02 值集里（只许收敛、
//    不许发散）；判据见文件末的「归一化不发散」用例。
// 5（thinking-wire-protocol-split）：Messages 的两张出口表逐格对账——off（02 号票）与
//    档位（01 号票）各一份「键集全覆盖 + 状态可区分 + provenance 必填 + 怪癖 owner 一致 +
//    逐格实发」的静态判据。

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

// 便捷入参：默认「非探针、非 effort 词汇平台、血统给 low 档」，
// 用例只覆盖自己关心的维度（不改的维度保持默认）。
// 入参按协议分型（宽松事实收口 01 第 2 项）：各行的默认值只含本行真读的字段——
// openai 行没有 probe / platformId / effortVocabularyOnly 可填（多填是 tsc 错误）。
function anthropicWire(overrides: Partial<AnthropicWireInput> = {}) {
  return THINKING_WIRE_MAPS.anthropic({
    vocabulary: reasoningEffort("low"),
    probe: false,
    effortVocabularyOnly: false,
    ...overrides
  });
}

function openaiWire(overrides: Partial<OpenAiWireInput> = {}) {
  return THINKING_WIRE_MAPS.openai({
    vocabulary: reasoningEffort("low"),
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
  it("词汇原样并入（每次都是新对象）；tokenParam 缺省 max_tokens", () => {
    const vocabulary = reasoningEffort("high");
    const first = openaiWire({ vocabulary });
    expect(first.fields).toEqual({ reasoning_effort: "high" });
    // 恒等投影不把出参对象当缓存，也不改入参词汇（事实层的成员对象不变量）。
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
    // 三个 off 词汇各自是一个**不同的联合成员**——按 kind 分支，不再嗅探字段字面量。
    for (const vocabulary of [reasoningEffort("none"), enableThinking(false), thinkingType("disabled")]) {
      expect(anthropicWire({ vocabulary }).fields, vocabulary.kind).toEqual({
        thinking: { type: "disabled" }
      });
    }
  });

  it("effort 词汇平台（怪癖 effortVocabMessages）：off 不发任何字段；开档原样出 output_config.effort", () => {
    expect(anthropicWire({ vocabulary: reasoningEffort("none"), effortVocabularyOnly: true }).fields).toEqual({});
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), effortVocabularyOnly: true }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // 矩阵给的是别的开关词汇（无 reasoning_effort）→ 不发——软失败优于硬 400。
    expect(anthropicWire({ vocabulary: enableThinking(true), effortVocabularyOnly: true }).fields).toEqual({});
  });

  it("全表不发 budget_tokens：开关型血统的开档只发裸 thinking:{type:enabled}", () => {
    expect(anthropicWire({ vocabulary: enableThinking(true) }).fields).toEqual({ thinking: { type: "enabled" } });
    expect(anthropicWire({ vocabulary: thinkingType("enabled") }).fields).toEqual({ thinking: { type: "enabled" } });
    // 上限事实与档位都不再参与取值：入参里没有它们，字段里也不该有预算。
    expect(JSON.stringify(anthropicWire({ vocabulary: enableThinking(true) }).fields)).not.toContain("budget_tokens");
  });

  it("tokenParam 恒为 max_tokens：血统事实（max_completion_tokens）是 OpenAI 通道的参数名，本行入参里没有它", () => {
    expect(anthropicWire().tokenParam).toBe("max_tokens");
    // 「本行不收 tokenParam」是编译期断言（见 tests/ai/thinking-wire-input.types.ts）：
    // 血统的 token 参数名事实只随 OpenAI 行进请求体。
  });

  // 分档（02 号票）：effort 血统的档位词在各平台官方登记的档位字段上落线；未登记档位词汇
  // 的平台发裸 effort 词汇。修复前这里 low 与 high 同值（塌陷），现在逐格可区分。
  it("档位分档：文档登记 output_config.effort 的平台带 thinking 开关落 effort 词", () => {
    const low = anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "deepseek" });
    const high = anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "deepseek" });
    expect(low.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "low" } });
    expect(high.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
    expect(low.fields).not.toEqual(high.fields);
    // 血统的档位词原样透传（qwen3.8-max 的高档词就是平台词表里的 xhigh）。
    expect(anthropicWire({ vocabulary: reasoningEffort("xhigh"), platformId: "qwen" }).fields).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "xhigh" }
    });
  });

  it("档位分档：只发 output_config.effort 的平台（openrouter / opencodego / modelscope）", () => {
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "openrouter" }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // opencodego / modelscope：官方文档未登记档位词汇，按产品裁定发裸 effort 词汇
    // （出处见 ai/thinking-wire-map.ts 的 MESSAGES_TIER_VOCABULARY）。
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
    // 平台识别缺失（custom 直填端点）同样发裸 effort，而不是报错、也不退回预算。
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: undefined }).fields).toEqual({
      output_config: { effort: "high" }
    });
  });

  it("严格 effort 词汇平台（怪癖 effortVocabMessages）优先：stepfun / amd 仍是原样 effort，不发 thinking", () => {
    expect(
      anthropicWire({
        vocabulary: reasoningEffort("high"),
        platformId: "stepfun",
        effortVocabularyOnly: true
      }).fields
    ).toEqual({ output_config: { effort: "high" } });
  });

  it("开关型血统显式登记：无档位词汇，low 与 high 同为裸开档（不带上限）", () => {
    const low = anthropicWire({ vocabulary: enableThinking(true) });
    const high = anthropicWire({ vocabulary: enableThinking(true) });
    expect(low.fields).toEqual({ thinking: { type: "enabled" } });
    expect(high.fields).toEqual(low.fields);
  });
});

describe("三层无重叠主人对账（验收第 4 条，静态判据）", () => {
  // 去注释后再扫：注释里允许引用键名与出处（如「不再发 thinking.budget_tokens」），
  // 判据只针对**代码里**的构造性出现。URL 里的 // 可能被行注释剥离误伤，但被扫文件
  // 的代码串里不含 URL，够用。
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const read = (rel: string) => stripComments(readFileSync(rel, "utf8"));

  const ADAPTERS = ["extension/ai/adapters/openai.ts", "extension/ai/adapters/anthropic.ts"];
  const LINEAGE = "extension/ai/thinking-profiles.ts";
  const WIRE_MAP = "extension/ai/thinking-wire-map.ts";
  // 「全部平台都不发预算」的判定范围：extension/ai 里所有可能构造思考字段的模块。
  const AI_MODULES = [...ADAPTERS, LINEAGE, WIRE_MAP, "extension/ai/compat-vocab.ts", "extension/ai/protocol-adapter.ts"];

  // Messages 通道独有（或归一后独有）的线格式字面量：唯一主人是线格式映射表。
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

  // 改造前这里还有一条「adapter 内不再有思考词汇字面量的构造性写入」的源码文本扫描
  // （enable_thinking / reasoning_effort / thinking: 的构造性出现）。seam 换成封闭判别联合后，
  // adapter 写的 `fields: {...}` / `vocabulary: {...}` 形状由 tsc 直接拒绝，这条不变式不再
  // 需要扫文本；对应的行为判据改为按 kind 断（tests/ai/thinking-vocabulary.test.ts）。

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

// 08 号票：MESSAGES_TIER_VOCABULARY 降级为**纯归一化层**（档位折叠 + 线格式出口），
// 「哪些档位词合法」的主人让给 02 号票的值集产物（ai/catalog/models-dev-thinking.generated.ts，
// 逐模型物化见 thinking-profiles 的 ruleFromUpstreamFact）。归一化只许**收敛**（多档折同词），
// 不许**发散**——所以对每个有上游事实的模型，Messages 出口上的档位词必须仍是该模型值集里的词。
describe("归一化不发散（08 号票：像集合 ⊆ 该模型 02 值集）", () => {
  const PRESET_BY_UPSTREAM: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(UPSTREAM_PROVIDER_BY_PRESET).map(([presetId, upstreamId]) => [upstreamId, presetId])
  );

  // 出口上的档位词（与工件 artifacts/08-messages-matrix.ts 的 wire:<档> 列同口径）。
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
          // effortVocabularyOnly 留 false：stepfun 走「未登记线格式出口」的裸 effort，与它
          // 在 runtime 走怪癖 effortVocabMessages 的形态逐字同值（两条路都只发 output_config.effort）。
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
    // 口径自检：循环不许空转（02 产物 359+ 条指派，18 号票后不再有被跳过的平台；
    // 其中大量是 toggle 型不发档位词，故 emittedWords 只在这一量级）。实测 359 / 1320。
    expect(comparedModels).toBeGreaterThanOrEqual(359);
    expect(emittedWords).toBeGreaterThanOrEqual(1300);
  });

  it("判据非空转：值集不含的档位词不合法（glm-5.2 值集 toggle+high-max，无 low 可发）", () => {
    // glm-5.2 的 02 值集 effort 是 high/max（D1=A2 起带 toggle，off 走平台开关）——
    // 归一化层若「发散」出 low 就会违反上一条断言；这里把该值集钉死，证明上一条断言的判据不是恒真。
    expect(lookupThinkingFact("zhipuai", "glm-5.2")!.effort).toEqual(["high", "max"]);
  });
});

// thinking-wire-protocol-split 02 号票：Messages 通道的 off 出口表。票面的失败方式逐条对应下面的用例：
//   ① 表与真实行为不同步（表说原生、代码走怪癖落不发）→ 逐格行为用例；
//   ②「未声明」被 falsy 默认吞成「原生」，新增平台静默拿默认 → 键集全覆盖 + 四态可区分；
//   ③ 怪癖语义抄成第二份事实（怪癖改了表不跟）→ owner 键集对账（表只声明归属）；
//   ⑤ 无证据格子声称有出处 → provenance 三态 + 出处必填。
// ④（只覆盖目录内行、漏掉手写表兜底行）由 thinking-golden-messages.test.ts 的 stepfun/amd 格承载。
describe("off 出口表（thinking-wire-protocol-split 02）：逐格可审，行为中立", () => {
  const PLATFORM_KEYS = Object.keys(PROVIDERS).sort();

  it("键集对账：表 = PROVIDERS 键空间，不多不少（新增平台不表态 → 红）", () => {
    expect(Object.keys(MESSAGES_OFF_EXIT).sort()).toEqual(PLATFORM_KEYS);
  });

  it("四态可区分：「未研究过」与「声明为原生」是两个显式值，不许 falsy 默认吞掉", () => {
    const kinds = new Set(Object.values(MESSAGES_OFF_EXIT).map((cell) => cell.kind));
    expect(kinds.has("native")).toBe(true);
    // 表内今天三态（native / silent；word 无实例）：minimax 2026-10-05 由 unresearched 改为
    // native——厂商文档登记了 thinking 与该端点的 off 语义（见单元头注与 UPSTREAM_TOGGLE_SHAPES.minimax）。
    // 第四态由**表外兜底**承载：「没人研究过 → 原生默认」这条路仍然显式存在、可被否决。
    expect(UNRESEARCHED_OFF_EXIT.kind).toBe("unresearched");
    for (const [platform, cell] of Object.entries(MESSAGES_OFF_EXIT)) {
      expect(["native", "silent", "word", "unresearched"], platform).toContain(cell.kind);
    }
  });

  it("provenance 必填：三态取值合法、出处非空；silent 带 reason、word 带载荷", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_OFF_EXIT)) {
      expect(["实测", "文档", "推断"], platform).toContain(cell.provenance.level);
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
    expect(UNRESEARCHED_OFF_EXIT.kind).toBe("unresearched");
    expect(messagesOffExitCell(undefined).kind).toBe("unresearched");
    expect(messagesOffExitCell("未登记的平台").kind).toBe("unresearched");
    expect(messagesOffExitCell("constructor").kind).toBe("unresearched");
    expect(messagesOffExitCell("toString").kind).toBe("unresearched");
  });

  it("逐格实发：off 三词汇 × 表内声明（owner 格命中怪癖 → 不发；其余 → 原生）", () => {
    for (const platform of PLATFORM_KEYS) {
      const cell = messagesOffExitCell(platform);
      const quirkOn = hasPlatformQuirk(platform, "effortVocabMessages");
      for (const vocabulary of [reasoningEffort("none"), enableThinking(false), thinkingType("disabled")]) {
        const out = anthropicWire({ vocabulary, platformId: platform, effortVocabularyOnly: quirkOn });
        const expected =
          cell.kind === "word" && cell.fields
            ? cell.fields
            : cell.kind === "silent" && quirkOn
              ? {}
              : { thinking: { type: "disabled" } };
        expect(out.fields, `${platform} kind=${cell.kind} vocabulary=${vocabulary.kind}`).toEqual(expected);
      }
    }
    // 表外（platformId 未识别 / undefined）同样按未声明 → 原生。
    expect(anthropicWire({ vocabulary: reasoningEffort("none") }).fields).toEqual({ thinking: { type: "disabled" } });
    expect(anthropicWire({ vocabulary: enableThinking(false), platformId: undefined }).fields).toEqual({
      thinking: { type: "disabled" }
    });
  });

  it("行为中立：owner 的活值优先于表——手改 baseUrl 的身份错配与旧实现逐字节相同", () => {
    // presetId=ollama + stepfun 的 baseUrl（app 允许手编 baseUrl）：怪癖按 host 命中 stepfun
    // （effortVocabularyOnly=true），档位词表按 presetId 走 ollama。旧实现在 off 分支只看全局
    // 布尔 → 不发；表化后由 ② 支保持相同（否则这一格会从静默变成原生 = 行为变更）。
    expect(
      anthropicWire({ vocabulary: reasoningEffort("none"), platformId: "ollama", effortVocabularyOnly: true }).fields
    ).toEqual({});
    // 反向：stepfun 的格 + 怪癖未开（正常入参形状里不会出现）→ 落原生，与旧实现一致。
    expect(
      anthropicWire({ vocabulary: reasoningEffort("none"), platformId: "stepfun", effortVocabularyOnly: false }).fields
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("级联不受本表影响：表只回答「off 写点存在时的出口」，档位级联仍在解析层（ADR-0014 决定 4）", () => {
    // stepfun 的目录行没有 off 写点（形状未登记）→ 解析层级联出 low；本表不参与该判定。
    expect(
      anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "stepfun", effortVocabularyOnly: true }).fields
    ).toEqual({ output_config: { effort: "low" } });
  });
});

// thinking-wire-protocol-split 01 号票：Messages 通道的**档位出口表**（建表前是「8 家登记 + 未登记
// 平台隐式回落裸 effort」）。票面的失败方式逐条对应下面的用例：
//   ① 表与真实行为不同步（kind 说 reasoning-effort、代码发裸 effort）→ 逐格实发用例；
//   ②「未研究过」被 falsy 默认吞成「已声明只发裸 effort」，新增平台静默拿默认 → 键集全覆盖 + 四态可区分；
//   ③ 怪癖语义抄成第二份事实（怪癖改了表不跟）→ owner 键集对账（表只声明归属、判据取活值）；
//   ⑤ 无证据格子声称有出处 → provenance 三态 + 出处必填；
//   ④（只覆盖目录内行、漏掉手写表兜底行）由 thinking-golden-messages.test.ts 的逐格 golden 承载。
describe("档位出口表（thinking-wire-protocol-split 01）：逐格可审，行为中立", () => {
  const PLATFORM_KEYS = Object.keys(PROVIDERS).sort();
  const ALL_KINDS: readonly MessagesTierExitKind[] = ["effort", "effort-bare", "reasoning-effort", "unresearched"];

  it("键集对账：表 = PROVIDERS 键空间，不多不少（新增平台不表态 → 红）", () => {
    expect(Object.keys(MESSAGES_TIER_EXIT).sort()).toEqual(PLATFORM_KEYS);
  });

  it("四态可区分：「未研究过」与「已声明只发裸 effort」是两个显式值，不许 falsy 默认吞掉", () => {
    // 两态在线上同形（都发裸 output_config.effort），但在表里必须答得不一样——这正是建表的理由。
    for (const [platform, cell] of Object.entries(MESSAGES_TIER_EXIT)) {
      expect(ALL_KINDS, platform).toContain(cell.kind);
    }
    // minimax 2026-10-05 起是 "effort"（文档登记了 output_config.effort 与 thinking；它不再属于
    // 「没人研究过」那一格），故剩下三格才是今天真正的 unresearched。
    expect(MESSAGES_TIER_EXIT.minimax.kind).toBe("effort");
    expect(MESSAGES_TIER_EXIT.mimo.kind).toBe("unresearched");
    expect(MESSAGES_TIER_EXIT.ollama.kind).toBe("unresearched");
    expect(MESSAGES_TIER_EXIT.siliconflow.kind).toBe("unresearched");
    // 剩下的落三态出口；「有依据地只发裸 effort」的格（含怪癖托管格）不是 unresearched。
    expect(MESSAGES_TIER_EXIT.openrouter.kind).toBe("effort-bare");
    expect(MESSAGES_TIER_EXIT.stepfun.kind).toBe("effort-bare");
    expect(MESSAGES_TIER_EXIT.deepseek.kind).toBe("effort");
    expect(MESSAGES_TIER_EXIT.moonshot.kind).toBe("reasoning-effort");
  });

  it("provenance 必填：三态取值合法、出处非空（每格都答得出「凭什么」）", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_TIER_EXIT)) {
      expect(["实测", "文档", "推断"], platform).toContain(cell.provenance.level);
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
    expect(UNRESEARCHED_TIER_EXIT.kind).toBe("unresearched");
    expect(messagesTierExitCell(undefined).kind).toBe("unresearched");
    expect(messagesTierExitCell("未登记的平台").kind).toBe("unresearched");
    expect(messagesTierExitCell("constructor").kind).toBe("unresearched");
    expect(messagesTierExitCell("toString").kind).toBe("unresearched");
  });

  it("逐格实发：kind × 形态（effort = 档位词 + 开关；effort-bare / unresearched = 裸档位词；reasoning-effort = 顶层）", () => {
    for (const platform of PLATFORM_KEYS) {
      const cell = messagesTierExitCell(platform);
      // owner 格（stepfun / amd）的判据是怪癖活值：命中时只发裸 output_config.effort。
      const quirkOn = hasPlatformQuirk(platform, "effortVocabMessages");
      const out = anthropicWire({
        vocabulary: reasoningEffort("high"),
        platformId: platform,
        effortVocabularyOnly: quirkOn
      });
      // kind="effort" 的显式开思考开关逐格查 MESSAGES_ON_EXIT（minimax 的开词是 adaptive，
      // 不是原生的 enabled）——2026-10-05 起开词不再硬写。
      const onCell = messagesOnExitCell(platform);
      const onFields = onCell.kind === "word" && onCell.fields ? onCell.fields : { thinking: { type: "enabled" } };
      const expected =
        cell.kind === "reasoning-effort"
          ? { reasoning_effort: "high" }
          : cell.kind === "effort"
            ? { output_config: { effort: "high" }, ...onFields }
            : { output_config: { effort: "high" } };
      expect(out.fields, `${platform} kind=${cell.kind}${cell.owner ? ` owner=${cell.owner}` : ""}`).toEqual(expected);
    }
    // 表外（platformId 未识别 / undefined）按未声明 → 裸 effort，不下发预算。
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

  it("行为中立：owner 的活值优先于表——手改 baseUrl 的身份错配与建表前的全局布尔逐字节相同", () => {
    // presetId=deepseek + stepfun 的 baseUrl（app 允许手编 baseUrl）：怪癖按 host 命中 stepfun
    // （effortVocabularyOnly=true），档位表按 presetId 走 deepseek（kind="effort"）。建表前那一支是
    // **不分格**的全局布尔 → 只发裸 effort；表化后仍走它（否则这一格会多出 thinking:{type:enabled}，
    // 就是行为变更）。
    expect(
      anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "deepseek", effortVocabularyOnly: true }).fields
    ).toEqual({ output_config: { effort: "low" } });
    // 反向：怪癖未开 + stepfun 的格 → 按表声明发裸 effort（与 runtime 走怪癖时同形）。
    expect(
      anthropicWire({ vocabulary: reasoningEffort("low"), platformId: "stepfun", effortVocabularyOnly: false }).fields
    ).toEqual({ output_config: { effort: "low" } });
  });

  it("档位表不接管开关型血统：词汇只有开关时仍是裸开档（off / 开关走各自的分支）", () => {
    expect(anthropicWire({ vocabulary: enableThinking(true), platformId: "moonshot" }).fields).toEqual({
      thinking: { type: "enabled" }
    });
    expect(anthropicWire({ vocabulary: thinkingType("enabled"), platformId: "deepseek" }).fields).toEqual({
      thinking: { type: "enabled" }
    });
  });
});

// 2026-10-05 用户裁定（票 toggle-shape-registration 01：形态 C「完整登记 off + on」）：Messages 通道的
// **开词**也逐格显式声明。落地前那一层只有硬写 `thinking:{type:"enabled"}`——对平台枚举词不是 enabled
// 的端点（minimax 只有 disabled / adaptive）就是替平台发明词。票面的失败方式与前两张表同构：
//   ① 表与真实行为不同步（表说平台自有词、代码仍发 enabled）→ 逐格实发用例；
//   ②「未研究过」被 falsy 默认吞成「声明为原生」→ 键集全覆盖 + 三态可区分 + 表外兜底；
//   ③ 无证据格子声称有出处 → provenance 三态 + 出处必填；
//   ④ 硬规则：本表只发开关形状，任何一格的载荷都不得含思考预算。
// 与前两张表的差别：本表的落地**改行为**（minimax 行从「一个字段都不发」变成真发 off / on），
// 其余平台逐字节不变（域与 before/after 工件见票内）。
describe("开词出口表（2026-10-05 裁定：形态 C）：逐格可审，只对 minimax 改行为", () => {
  const PLATFORM_KEYS = Object.keys(PROVIDERS).sort();
  const ALL_KINDS: readonly MessagesOnExitKind[] = ["native", "word", "unresearched"];

  it("键集对账：表 = PROVIDERS 键空间，不多不少（新增平台不表态 → 红）", () => {
    expect(Object.keys(MESSAGES_ON_EXIT).sort()).toEqual(PLATFORM_KEYS);
  });

  it("三态可区分：表内只有 minimax 是平台自有词，其余按原生；未识别平台走表外兜底", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_ON_EXIT)) {
      expect(ALL_KINDS, platform).toContain(cell.kind);
      if (cell.kind === "word") expect(cell.fields, platform).toBeTruthy();
    }
    expect(MESSAGES_ON_EXIT.minimax.kind).toBe("word");
    expect(MESSAGES_ON_EXIT.minimax.fields).toEqual({ thinking: { type: "adaptive" } });
    expect(UNRESEARCHED_ON_EXIT.kind).toBe("unresearched");
    expect(messagesOnExitCell(undefined).kind).toBe("unresearched");
    expect(messagesOnExitCell("未登记的平台").kind).toBe("unresearched");
    // 原型链上的键不算表内格。
    expect(messagesOnExitCell("constructor").kind).toBe("unresearched");
    expect(messagesOnExitCell("toString").kind).toBe("unresearched");
  });

  it("provenance 必填：三态取值合法、出处非空（每格都答得出「凭什么」）", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_ON_EXIT)) {
      expect(["实测", "文档", "推断"], platform).toContain(cell.provenance.level);
      expect(cell.provenance.source.length, platform).toBeGreaterThan(8);
    }
    expect(UNRESEARCHED_ON_EXIT.provenance.level).toBe("推断");
    expect(UNRESEARCHED_ON_EXIT.provenance.source.length).toBeGreaterThan(8);
  });

  it("硬规则：本表任何一格的载荷都不含思考预算（只发不带预算的开关形状）", () => {
    for (const [platform, cell] of Object.entries(MESSAGES_ON_EXIT)) {
      expect(JSON.stringify(cell.fields ?? {}), platform).not.toContain("budget_tokens");
    }
    // 实发同样不得出现预算：两条开档入口都只在开关形状内取值。
    expect(JSON.stringify(anthropicWire({ vocabulary: enableThinking(true), platformId: "minimax" }).fields)).not.toContain(
      "budget_tokens"
    );
  });

  it("逐格实发：word 格发平台自有词，其余发原生 enabled（两条开档入口都读本表）", () => {
    for (const platform of PLATFORM_KEYS) {
      const cell = messagesOnExitCell(platform);
      const expected = cell.kind === "word" && cell.fields ? cell.fields : { thinking: { type: "enabled" } };
      // 入口 A：开关型血统的裸开档。
      expect(
        anthropicWire({ vocabulary: enableThinking(true), platformId: platform }).fields,
        `${platform} 裸开档`
      ).toEqual(expected);
      // 入口 B：档位出口 kind="effort" 的显式开思考开关（其余 kind 只发档位词）。
      const tierCell = messagesTierExitCell(platform);
      if (tierCell.kind === "effort") {
        expect(
          anthropicWire({ vocabulary: reasoningEffort("high"), platformId: platform }).fields,
          `${platform} effort 出口`
        ).toEqual({ output_config: { effort: "high" }, ...expected });
      }
    }
    // 表外（platformId 未识别 / undefined）按未声明 → 原生。
    expect(anthropicWire({ vocabulary: enableThinking(true), platformId: undefined }).fields).toEqual({
      thinking: { type: "enabled" }
    });
  });

  it("minimax 专项：开词是 adaptive（该端点的 enum 里没有 enabled）", () => {
    expect(anthropicWire({ vocabulary: enableThinking(true), platformId: "minimax" }).fields).toEqual({
      thinking: { type: "adaptive" }
    });
    // 事实层给出的就是平台词（UPSTREAM_TOGGLE_SHAPES.minimax 的 on），两条通道同一形状。
    expect(anthropicWire({ vocabulary: thinkingType("adaptive"), platformId: "minimax" }).fields).toEqual({
      thinking: { type: "adaptive" }
    });
    // 档位出口那条路（kind="effort"）同样用平台自有开词——今天没有 minimax 的 effort 档位行，
    // 这一格由写法层直接喂入，防止后人把开词再硬写回 enabled。
    expect(anthropicWire({ vocabulary: reasoningEffort("high"), platformId: "minimax" }).fields).toEqual({
      output_config: { effort: "high" },
      thinking: { type: "adaptive" }
    });
  });

  it("不可达格：stepfun / amd 在 strict effort 词汇下永不读本表（开分支之前就返回）", () => {
    for (const platform of ["stepfun", "amd"]) {
      // 开关词汇：strict effort 词汇支不透传 → 不发（既不读开词，也不发 enabled）。
      expect(
        anthropicWire({ vocabulary: enableThinking(true), platformId: platform, effortVocabularyOnly: true }).fields,
        platform
      ).toEqual({});
      // 档位词汇：只发裸 output_config.effort，不带开思考开关。
      expect(
        anthropicWire({ vocabulary: reasoningEffort("high"), platformId: platform, effortVocabularyOnly: true }).fields,
        platform
      ).toEqual({ output_config: { effort: "high" } });
    }
  });
});

// 宽松事实收口（票 thinking-seam-tightening/issues/01 第 1、2 项）：写法层的入参按协议分型，
// 每一行只收自己真读的字段，平台事实由调用方一次算好。票面的失败方式逐条对应下面的用例：
//   ① 删 stream 漏改调用点（字段删了还有人传）→ 类型级（多余字段即红）+ 源码扫描（声明也没了）；
//   ② 分型后某行读到 undefined（必填事实漏传被静默吞成 falsy）→ 类型级（缺必填即红）+ 正对照；
//   ③ openai 行仍被迫填对它无意义的平台事实 → 类型级（多余字段即红）+ adapter 源码扫描；
//   ④ 写法层被加上运行时 import（纯叶契约破）→ 源码扫描（每条 import 都须 type-only）。
describe("入参分型（宽松事实收口 01 的第 1、2 项）：每行只收自己读得到的字段", () => {
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  const WIRE_MAP = "extension/ai/thinking-wire-map.ts";
  const OPENAI_ADAPTER = "extension/ai/adapters/openai.ts";

  it("第 1 项：stream 从写法层消失——声明与传参都无（无人读的字段不留痕）", () => {
    const code = stripComments(readFileSync(WIRE_MAP, "utf8"));
    // 判据非空转：扫描确实看到了本文件的正文（probe 是 Messages 行真读的事实）。
    expect(code).toContain("probe");
    expect(code.includes("stream"), `${WIRE_MAP} 仍出现 stream——该字段是票 01 第 1 项要删的死字段`).toBe(false);
  });

  it("第 2 项：openai 行不再被迫填无意义的平台事实（adapter 里没有这类填值）", () => {
    const code = stripComments(readFileSync(OPENAI_ADAPTER, "utf8"));
    // 判据非空转：openai 行真读的 token 参数名事实仍由它传。
    expect(code).toContain("tokenParam");
    expect(code.includes("effortVocabularyOnly"), `${OPENAI_ADAPTER} 仍出现 effortVocabularyOnly——该事实对 openai 行无意义`).toBe(
      false
    );
  });

  it("纯叶契约：写法层的每一条 import 都是 type-only（零运行时 import，SW 静态图安全）", () => {
    const importLines = stripComments(readFileSync(WIRE_MAP, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("import "));
    expect(importLines.length, `扫描空转：${WIRE_MAP} 没有 import 行`).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line.startsWith("import type "), `运行时 import：${line}`).toBe(true);
    }
  });

  // 「某协议行不收哪些字段」的编译期断言（@ts-expect-error）不在这里：它们一旦被执行就会
  // 用非法入参真调表。按仓内既有体例（tests/chat/chat-state-readonly.types.ts）落在
  // tests/ai/thinking-wire-input.types.ts，由 `pnpm typecheck` 执行、vitest 不加载。

  it("判据非空转：同一形状的合法入参照常通过（字段落在正确的行上）", () => {
    expect(openaiWire({ tokenParam: "max_completion_tokens" }).tokenParam).toBe("max_completion_tokens");
    expect(
      anthropicWire({
        vocabulary: reasoningEffort("high"),
        probe: false,
        platformId: "deepseek",
        effortVocabularyOnly: false
      }).fields
    ).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
  });
});
