// ai/thinking-wire-map.ts 的单测（thinking-wire-map 票 01）。三件事在此钉死：
// 1. 表结构：键覆盖词表叶（Record<AiProtocol, …> 注解的运行时对账），两行各自可调用；
// 2. 逐行写法：openai 行 = 血统词汇原样并入 + token 参数名随血统事实；anthropic 行 =
//    Messages 通道的写法（probe 早退 / off 三词汇归一 / effort 档位分档与档位词汇表 /
//    开关型血统的裸开档 / 未登记档位词汇的平台发裸 effort）；
// 3. 三层无重叠主人对账（验收第 4 条，测试期静态判据，不进运行时）：Messages 线格式
//    字面量只在线格式映射表出现；adapter 内不再有思考词汇字面量的构造性写入；
//    血统表不含 Messages 通道的字段名；**budget_tokens 在 extension/ai 的代码里零出现**。
// 4（08 号票）：归一化层的词汇主人是 02 值集产物——MESSAGES_TIER_VOCABULARY 只做
//    「档位折叠 + 线格式出口」，出口上的档位词必须仍在**该模型** 02 值集里（只许收敛、
//    不许发散）；判据见文件末的「归一化不发散」用例。

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ASSIGNMENTS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { hasPlatformQuirk } from "../../extension/ai/compat-vocab.js";
import {
  AI_THINKING_LEVELS,
  PROVIDERS,
  UPSTREAM_PROVIDER_BY_PRESET,
  resolveThinkingProfile
} from "../../extension/ai/thinking-profiles.js";
import { AI_PROTOCOLS } from "../../extension/ai/protocol-vocab.js";
import {
  MESSAGES_OFF_EXIT,
  THINKING_WIRE_MAPS,
  UNRESEARCHED_OFF_EXIT,
  messagesOffExitCell,
  type ThinkingWireInput
} from "../../extension/ai/thinking-wire-map.js";

// 便捷入参：默认「非探针、流式关、非 effort 词汇平台、血统给 low 档」，
// 用例只覆盖自己关心的维度（不改的维度保持默认）。
function anthropicWire(overrides: Partial<ThinkingWireInput> = {}) {
  return THINKING_WIRE_MAPS.anthropic({
    fields: { reasoning_effort: "low" },
    stream: false,
    probe: false,
    effortVocabularyOnly: false,
    ...overrides
  });
}

function openaiWire(overrides: Partial<ThinkingWireInput> = {}) {
  return THINKING_WIRE_MAPS.openai({
    fields: { reasoning_effort: "low" },
    stream: false,
    probe: false,
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
    const out = anthropicWire({ probe: true, fields: { reasoning_effort: "high" } });
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
      expect(anthropicWire({ fields }).fields, JSON.stringify(fields)).toEqual({
        thinking: { type: "disabled" }
      });
    }
  });

  it("effort 词汇平台（怪癖 effortVocabMessages）：off 不发任何字段；开档原样出 output_config.effort", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "none" }, effortVocabularyOnly: true }).fields).toEqual({});
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, effortVocabularyOnly: true }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // 矩阵给的是别的开关词汇（无 reasoning_effort）→ 不发——软失败优于硬 400。
    expect(anthropicWire({ fields: { enable_thinking: true }, effortVocabularyOnly: true }).fields).toEqual({});
  });

  it("全表不发 budget_tokens：开关型血统的开档只发裸 thinking:{type:enabled}", () => {
    expect(anthropicWire({ fields: { enable_thinking: true } }).fields).toEqual({ thinking: { type: "enabled" } });
    expect(anthropicWire({ fields: { thinking: { type: "enabled" } } }).fields).toEqual({ thinking: { type: "enabled" } });
    // 上限事实与档位都不再参与取值：入参里没有它们，字段里也不该有预算。
    expect(JSON.stringify(anthropicWire({ fields: { enable_thinking: true } }).fields)).not.toContain("budget_tokens");
  });

  it("tokenParam 恒为 max_tokens：血统事实（max_completion_tokens）是 OpenAI 通道的参数名", () => {
    expect(anthropicWire({ tokenParam: "max_completion_tokens" }).tokenParam).toBe("max_tokens");
  });

  // 分档（02 号票）：effort 血统的档位词在各平台官方登记的档位字段上落线；未登记档位词汇
  // 的平台发裸 effort 词汇。修复前这里 low 与 high 同值（塌陷），现在逐格可区分。
  it("档位分档：文档登记 output_config.effort 的平台带 thinking 开关落 effort 词", () => {
    const low = anthropicWire({ fields: { reasoning_effort: "low" }, platformId: "deepseek" });
    const high = anthropicWire({ fields: { reasoning_effort: "high" }, platformId: "deepseek" });
    expect(low.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "low" } });
    expect(high.fields).toEqual({ thinking: { type: "enabled" }, output_config: { effort: "high" } });
    expect(low.fields).not.toEqual(high.fields);
    // 血统的档位词原样透传（qwen3.8-max 的高档词就是平台词表里的 xhigh）。
    expect(anthropicWire({ fields: { reasoning_effort: "xhigh" }, platformId: "qwen" }).fields).toEqual({
      thinking: { type: "enabled" },
      output_config: { effort: "xhigh" }
    });
  });

  it("档位分档：只发 output_config.effort 的平台（openrouter / opencodego / modelscope）", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, platformId: "openrouter" }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // opencodego / modelscope：官方文档未登记档位词汇，按产品裁定发裸 effort 词汇
    // （出处见 ai/thinking-wire-map.ts 的 MESSAGES_TIER_VOCABULARY）。
    for (const platformId of ["opencodego", "modelscope"]) {
      expect(anthropicWire({ fields: { reasoning_effort: "low" }, platformId }).fields, platformId).toEqual({
        output_config: { effort: "low" }
      });
      expect(anthropicWire({ fields: { reasoning_effort: "xhigh" }, platformId }).fields, platformId).toEqual({
        output_config: { effort: "xhigh" }
      });
    }
  });

  it("档位分档：moonshot（Kimi Code 端点）只发顶层 reasoning_effort", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "low" }, platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "low"
    });
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, platformId: "moonshot" }).fields).toEqual({
      reasoning_effort: "high"
    });
  });

  it("档位分档：未登记档位词汇的平台（ollama / custom 直填）同样发裸 effort，不下发预算", () => {
    expect(anthropicWire({ fields: { reasoning_effort: "low" }, platformId: "ollama" }).fields).toEqual({
      output_config: { effort: "low" }
    });
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, platformId: "ollama" }).fields).toEqual({
      output_config: { effort: "high" }
    });
    // 平台识别缺失（custom 直填端点）同样发裸 effort，而不是报错、也不退回预算。
    expect(anthropicWire({ fields: { reasoning_effort: "high" }, platformId: undefined }).fields).toEqual({
      output_config: { effort: "high" }
    });
  });

  it("严格 effort 词汇平台（怪癖 effortVocabMessages）优先：stepfun / amd 仍是原样 effort，不发 thinking", () => {
    expect(
      anthropicWire({
        fields: { reasoning_effort: "high" },
        platformId: "stepfun",
        effortVocabularyOnly: true
      }).fields
    ).toEqual({ output_config: { effort: "high" } });
  });

  it("开关型血统显式登记：无档位词汇，low 与 high 同为裸开档（不带上限）", () => {
    const low = anthropicWire({ fields: { enable_thinking: true } });
    const high = anthropicWire({ fields: { enable_thinking: true } });
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
  // 思考词汇字面量（三套中转词汇的键名 + 预算字段名）。adapter 不得再出现它们的构造性写入。
  const THINKING_LITERALS = ["enable_thinking", "reasoning_effort", "budget_tokens", "output_config", /(?<![\w.])thinking\s*:/];

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

  it("adapter 内不再有思考词汇字面量的构造性写入（取表 → 并入，取值不含词汇知识）", () => {
    for (const rel of ADAPTERS) {
      const source = read(rel);
      for (const pattern of THINKING_LITERALS) {
        const hit = typeof pattern === "string" ? source.includes(pattern) : pattern.test(source);
        expect(hit, `${rel} 出现 ${String(pattern)}——adapter 不得知道线格式词汇`).toBe(false);
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
          const word = wireWord(anthropicWire({ fields: profile.fields, platformId: presetId }).fields);
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
    expect(kinds.has("unresearched")).toBe(true);
    // 无端到端 off 路径的一格是显式「未研究过」，不是缺省项。
    expect(MESSAGES_OFF_EXIT.minimax.kind).toBe("unresearched");
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
      for (const fields of [{ reasoning_effort: "none" }, { enable_thinking: false }, { thinking: { type: "disabled" } }]) {
        const out = anthropicWire({ fields, platformId: platform, effortVocabularyOnly: quirkOn });
        const expected =
          cell.kind === "word" && cell.fields
            ? cell.fields
            : cell.kind === "silent" && quirkOn
              ? {}
              : { thinking: { type: "disabled" } };
        expect(out.fields, `${platform} kind=${cell.kind} fields=${JSON.stringify(fields)}`).toEqual(expected);
      }
    }
    // 表外（platformId 未识别 / undefined）同样按未声明 → 原生。
    expect(anthropicWire({ fields: { reasoning_effort: "none" } }).fields).toEqual({ thinking: { type: "disabled" } });
    expect(anthropicWire({ fields: { enable_thinking: false }, platformId: undefined }).fields).toEqual({
      thinking: { type: "disabled" }
    });
  });

  it("行为中立：owner 的活值优先于表——手改 baseUrl 的身份错配与旧实现逐字节相同", () => {
    // presetId=ollama + stepfun 的 baseUrl（app 允许手编 baseUrl）：怪癖按 host 命中 stepfun
    // （effortVocabularyOnly=true），档位词表按 presetId 走 ollama。旧实现在 off 分支只看全局
    // 布尔 → 不发；表化后由 ② 支保持相同（否则这一格会从静默变成原生 = 行为变更）。
    expect(
      anthropicWire({ fields: { reasoning_effort: "none" }, platformId: "ollama", effortVocabularyOnly: true }).fields
    ).toEqual({});
    // 反向：stepfun 的格 + 怪癖未开（正常入参形状里不会出现）→ 落原生，与旧实现一致。
    expect(
      anthropicWire({ fields: { reasoning_effort: "none" }, platformId: "stepfun", effortVocabularyOnly: false }).fields
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("级联不受本表影响：表只回答「off 写点存在时的出口」，档位级联仍在解析层（ADR-0014 决定 4）", () => {
    // stepfun 的目录行没有 off 写点（形状未登记）→ 解析层级联出 low；本表不参与该判定。
    expect(
      anthropicWire({ fields: { reasoning_effort: "low" }, platformId: "stepfun", effortVocabularyOnly: true }).fields
    ).toEqual({ output_config: { effort: "low" } });
  });
});
