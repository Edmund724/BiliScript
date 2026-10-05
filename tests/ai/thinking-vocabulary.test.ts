// tests/ai/thinking-vocabulary.test.ts
// 思考线「事实层 → 写法层」seam 的**封闭词汇**（判别联合 ThinkingVocabulary）对账。
//
// 先列这个改造可能失败的方式（每条在此有对应判据）：
//   ① 联合漏 kind / 新增 kind 不表态：kind 全集穷尽（`Record<ThinkingVocabularyKind, true>`
//      是编译期检查——联合加成员而这里没跟，tsc 红），且表里出现的 kind 都在全集内；
//   ② 载荷成员串味：level / on / type 三种载荷不许互相串（串了就是两个成员被折成一个）；
//   ③ 哨兵被 falsy 默认吞掉：noFields（有结论但不发言）与 unknown（无结论）是同一线上的
//      两个显式状态，判别键不同，且都**不带载荷**（进了 patch 就是误用，校验器报错）；
//   ④ 白名单派生漏词 / 派生为恒真：校验器对哨兵与联合外的脏 kind 报错、对载荷 kind 放行；
//   ⑤ 出口漏 kind：解析结果的 vocabulary 恒在，且五个 kind 都能从真实的表/解析路径到达；
//   ⑥ 写法层漏 switch 分支：每个 kind 在**两个通道**上的落线逐条钉住（off / effort 词 /
//      开档 / 不发四态）——这是替代「扫 adapter 源码文本抓词汇发散」的行为判据。
//
// 词汇字面量「只出现在写法层」这条不变式由本联合的封闭性 + seam 类型兜住（tsc），
// 不再靠扫 adapter / 血统表源码文本对账；写法层逐平台逐出口表的用例在
// tests/ai/thinking-wire-map.test.ts。

import { describe, expect, it } from "vitest";
import { VALUESETS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  NO_FIELDS,
  UNKNOWN_VOCABULARY,
  UPSTREAM_TOGGLE_SHAPES,
  enableThinking,
  reasoningEffort,
  resolveThinkingProfile,
  thinkingType,
  validateThinkingTables,
  type ClassRule,
  type ThinkingTables,
  type ThinkingVocabulary,
  type ThinkingVocabularyKind
} from "../../extension/ai/thinking-profiles.js";
import { THINKING_WIRE_MAPS, openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

// 联合的 kind 全集（穷尽由 tsc 兜住：联合新增成员而这里不表态 → 编译期红）。
const ALL_KINDS: Readonly<Record<ThinkingVocabularyKind, true>> = {
  reasoningEffort: true,
  enableThinking: true,
  thinkingType: true,
  noFields: true,
  unknown: true
};
const KIND_NAMES = Object.keys(ALL_KINDS).sort();
// 带线格式载荷的 kind（哨兵不含）——与 thinking-profiles 的白名单派生同源口径。
const PAYLOAD_KINDS = ["enableThinking", "reasoningEffort", "thinkingType"];

// class 规则上的写点键（off / on + 7 档投影里的非 off 档）。
const PATCH_KEYS = ["off", "on", ...AI_THINKING_LEVELS.filter((level) => level !== "off")] as const;

function collectPatches(): ThinkingVocabulary[] {
  const vocabularies: ThinkingVocabulary[] = [];
  for (const rule of Object.values(CLASSES)) {
    for (const key of PATCH_KEYS) {
      const vocabulary = rule[key]?.vocabulary;
      if (vocabulary) vocabularies.push(vocabulary);
    }
  }
  for (const shape of Object.values(UPSTREAM_TOGGLE_SHAPES)) {
    if (!shape) continue;
    vocabularies.push(shape.off, shape.on);
  }
  return vocabularies;
}

function classesWith(rule: unknown): ThinkingTables {
  return { classes: { ...CLASSES, probe: rule as ClassRule } };
}

describe("封闭词汇（事实层 → 写法层的中转词汇）", () => {
  it("表里出现的 kind 全部落在联合内（漏 kind / 脏 kind 都红）", () => {
    const seen = [...new Set(collectPatches().map((vocabulary) => vocabulary.kind))].sort();
    expect(seen).toEqual(PAYLOAD_KINDS);
    for (const kind of seen) {
      expect(KIND_NAMES, `${kind} 不在联合 kind 全集里`).toContain(kind);
    }
  });

  it("载荷成员各带语义载荷：level / on / type 三处不许互相串", () => {
    const byKind = new Map(collectPatches().map((vocabulary) => [vocabulary.kind, vocabulary]));
    const effort = byKind.get("reasoningEffort");
    expect(effort && "level" in effort && typeof effort.level === "string").toBe(true);
    const toggle = byKind.get("enableThinking");
    expect(toggle && "on" in toggle && typeof toggle.on === "boolean").toBe(true);
    const typed = byKind.get("thinkingType");
    expect(typed && "type" in typed && typeof typed.type === "string").toBe(true);
    expect(effort).not.toHaveProperty("on");
    expect(toggle).not.toHaveProperty("level");
    expect(typed).not.toHaveProperty("level");
  });

  it("哨兵：noFields 与 unknown 是两个显式状态（判别键不同、都不带载荷）", () => {
    expect(NO_FIELDS.kind).toBe("noFields");
    expect(UNKNOWN_VOCABULARY.kind).toBe("unknown");
    expect(NO_FIELDS.kind).not.toBe(UNKNOWN_VOCABULARY.kind);
    expect(KIND_NAMES).toContain(NO_FIELDS.kind);
    expect(KIND_NAMES).toContain(UNKNOWN_VOCABULARY.kind);
    // 哨兵不进表：它是解析期的「没有/不发」，写进 patch 就是误用（下一条用例）。
    expect(PAYLOAD_KINDS).not.toContain(NO_FIELDS.kind);
    expect(PAYLOAD_KINDS).not.toContain(UNKNOWN_VOCABULARY.kind);
  });

  it("白名单派生口径：载荷 kind 放行、哨兵与联合外的脏 kind 都在校验器里报错（派生不是恒真）", () => {
    expect(validateThinkingTables()).toEqual([]);
    const payload = { thinkingClass: "hybrid", off: { vocabulary: { kind: "reasoningEffort", level: "none" } } };
    const sentinel = { thinkingClass: "hybrid", off: { vocabulary: { kind: "unknown" } } };
    const dirty = { thinkingClass: "hybrid", off: { vocabulary: { kind: "reasoning_effort", level: "none" } } };
    expect(validateThinkingTables(classesWith(payload))).toEqual([]);
    expect(validateThinkingTables(classesWith(sentinel))[0]).toContain("哨兵");
    expect(validateThinkingTables(classesWith(dirty))[0]).toContain("白名单");
  });

  it("载荷词非空：表与 02 值集里的档位词 / 枚举词都是非空串，开关是布尔（写法层「有词」判据的结构前提）", () => {
    // 失败方式 ⑦：词汇载荷若是空串，写法层「effort 词存在 → 发档位词」与改造前
    // `if (bloodLineEffort)`（truthy）的落支就会不同（空词会掉进裸开档那一支）。
    // 表内所有词汇都由构造子登记，这里把「没有空词」钉成不变量，防止新登记 / 上游再生
    // （ai/catalog/models-dev-thinking.generated.ts 由构建期生成）悄悄引入空词。
    for (const vocabulary of collectPatches()) {
      if (vocabulary.kind === "reasoningEffort") {
        expect(vocabulary.level.length > 0, `档位词为空（${JSON.stringify(vocabulary)}）`).toBe(true);
      }
      if (vocabulary.kind === "thinkingType") {
        expect(vocabulary.type.length > 0, `枚举词为空（${JSON.stringify(vocabulary)}）`).toBe(true);
      }
      if (vocabulary.kind === "enableThinking") {
        expect(typeof vocabulary.on).toBe("boolean");
      }
    }
    let valuesetWords = 0;
    for (const [signature, valueset] of Object.entries(VALUESETS)) {
      for (const word of valueset.effort ?? []) {
        valuesetWords += 1;
        expect(word.length > 0, `${signature} 值集里的档位词为空`).toBe(true);
      }
    }
    // 口径自检：值集扫描不许空转（去重后的 02 值集签名里登记着百量级的档位词）。
    expect(valuesetWords).toBeGreaterThan(100);
  });
});

// ===== seam 出口与写法层落线（按 kind 断行为）=====

describe("事实层出口：解析结果的 vocabulary", () => {
  it("出口恒在：五个 kind 都能从真实的表 / 解析路径到达（无死成员，也无漏成员）", () => {
    const samples: ReadonlyArray<[string, unknown, ThinkingVocabulary]> = [
      ["上游 effort 档", { presetId: "deepseek", model: "deepseek-v4-pro", level: "high" }, reasoningEffort("high")],
      ["上游/手写开关开档", { presetId: "qwen", model: "qwen3-max", level: "low" }, enableThinking(true)],
      ["平台开关 off 写点", { presetId: "zhipu", model: "glm-5.2", level: "off" }, thinkingType("disabled")],
      ["default 档（有结论但不发言）", { presetId: "deepseek", model: "deepseek-v4-pro", level: "default" }, NO_FIELDS],
      ["无解析结论", { baseUrl: "https://api.example.com/v1", model: "vendor-future-1", level: "low" }, UNKNOWN_VOCABULARY]
    ];
    for (const [label, input, expected] of samples) {
      const resolution = resolveThinkingProfile({ ...(input as object), stream: false } as never);
      expect(resolution.vocabulary, label).toEqual(expected);
    }
    expect(new Set(samples.map(([, , vocabulary]) => vocabulary.kind)).size).toBe(KIND_NAMES.length);
  });

  it("哨兵出口：default 落 noFields（不是 unknown）；无结论落 unknown（不是 noFields）", () => {
    const deferred = resolveThinkingProfile({ presetId: "deepseek", model: "deepseek-v4-pro", level: "default", stream: false });
    expect(deferred.vocabulary).toEqual(NO_FIELDS);
    expect(deferred.thinkingClass).not.toBe("unknown");
    const unknown = resolveThinkingProfile({ baseUrl: "https://api.example.com/v1", model: "vendor-future-1", level: "default", stream: false });
    expect(unknown.vocabulary).toEqual(UNKNOWN_VOCABULARY);
    expect(unknown.thinkingClass).toBe("unknown");
  });
});

describe("写法层按 kind 断行为（替代扫源码文本抓词汇发散）", () => {
  interface VocabularyCase {
    readonly vocabulary: ThinkingVocabulary;
    /** openai 通道（= OpenAI 词汇原样并入）的期望字段。 */
    readonly openai: Record<string, unknown>;
    /** anthropic 通道上这一词汇的写法类别；none = 一个字段都不发。 */
    readonly anthropic: "off" | "effort" | "on" | "none";
    readonly word?: string;
  }

  const CASES: readonly VocabularyCase[] = [
    { vocabulary: reasoningEffort("none"), openai: { reasoning_effort: "none" }, anthropic: "off" },
    { vocabulary: reasoningEffort("high"), openai: { reasoning_effort: "high" }, anthropic: "effort", word: "high" },
    { vocabulary: enableThinking(false), openai: { enable_thinking: false }, anthropic: "off" },
    { vocabulary: enableThinking(true), openai: { enable_thinking: true }, anthropic: "on" },
    { vocabulary: thinkingType("disabled"), openai: { thinking: { type: "disabled" } }, anthropic: "off" },
    { vocabulary: thinkingType("enabled"), openai: { thinking: { type: "enabled" } }, anthropic: "on" },
    { vocabulary: thinkingType("adaptive"), openai: { thinking: { type: "adaptive" } }, anthropic: "on" },
    { vocabulary: NO_FIELDS, openai: {}, anthropic: "none" },
    { vocabulary: UNKNOWN_VOCABULARY, openai: {}, anthropic: "none" }
  ];

  it("用例表覆盖全部 kind（新增成员而漏用例 → 红）", () => {
    expect([...new Set(CASES.map((testCase) => testCase.vocabulary.kind))].sort()).toEqual(KIND_NAMES);
  });

  it("openai 行：词汇原样并入，与导出的投影逐条一致", () => {
    for (const testCase of CASES) {
      const wire = THINKING_WIRE_MAPS.openai({
        vocabulary: testCase.vocabulary
      });
      expect(wire.fields, testCase.vocabulary.kind).toEqual(testCase.openai);
      expect(openaiVocabularyFields(testCase.vocabulary), testCase.vocabulary.kind).toEqual(testCase.openai);
    }
  });

  it("anthropic 行：四态按 kind 落线（off 归一 / effort 透传 / 开档 / 不发）", () => {
    for (const testCase of CASES) {
      const wire = THINKING_WIRE_MAPS.anthropic({
        vocabulary: testCase.vocabulary,
        probe: false,
        effortVocabularyOnly: false,
        platformId: "未研究过的端点"
      });
      const expected =
        testCase.anthropic === "off"
          ? { thinking: { type: "disabled" } }
          : testCase.anthropic === "effort"
            ? { output_config: { effort: testCase.word } }
            : testCase.anthropic === "on"
              ? { thinking: { type: "enabled" } }
              : {};
      expect(wire.fields, `${testCase.vocabulary.kind} · ${testCase.anthropic}`).toEqual(expected);
    }
  });

  it("anthropic 行：档位词原样交给登记的线格式出口（moonshot = 顶层 reasoning_effort）", () => {
    expect(
      THINKING_WIRE_MAPS.anthropic({
        vocabulary: reasoningEffort("xhigh"),
        probe: false,
        effortVocabularyOnly: false,
        platformId: "moonshot"
      }).fields
    ).toEqual({ reasoning_effort: "xhigh" });
  });

  it("anthropic 行：探针对任何 kind 都早退（怪癖 probeOmitsThinking），两哨兵也不例外", () => {
    for (const testCase of CASES) {
      expect(
        THINKING_WIRE_MAPS.anthropic({
          vocabulary: testCase.vocabulary,
          probe: true,
          effortVocabularyOnly: false,
          platformId: "deepseek"
        }).fields,
        testCase.vocabulary.kind
      ).toEqual({});
    }
  });
});
