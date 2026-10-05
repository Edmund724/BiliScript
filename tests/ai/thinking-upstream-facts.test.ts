// tests/ai/thinking-upstream-facts.test.ts
// 票据 04（upstream-model-facts/04）+ 12（残留清单裁决落地）+ 18（删平台 override）：有上游
// 平台的模型结论改由 02 号票的指派表驱动，手写表退为「产品语义 + 上游未覆盖兜底」。
//
// 交互方式（12 号票，用户 2026-10-04 裁决「冻结的都按上游，复审以后发现以前的确实都是
// 错的」）：02 指派表命中 + 档位投影 → 手写表（EXCEPTIONS >> TAXONOMY
// >> unknownClass）→ UNKNOWN 哨兵。04 号票的行为冻结表 PENDING_DIVERGENCES（31 行）连同
// 其查表 / 校验 / 导出一并删除；31 行逐行按上游（对照表 artifacts/12-adjudication-log.md，
// 矩阵逐字节证据 artifacts/12-adjudication-matrix.diff.txt）。点名翻转的三处原手写专条
// **留在原表但已降级**：它们只服务「指派表不认识的 id」（用户自填 / 上游新变体）。真删会让
// 这些无界 id 的请求体跟着变，是尚未裁决的开放问题（12 号票非目标）。
// 18 号票（2026-10-05 用户裁定「4 家的平台声明必须压过上游词表这件事取消」）删掉
// openrouter / amd / sensenova / opencodego 的平台级 override 声明：识别层不再有短路，
// 这四家与本文件里其它有上游平台走同一条链（副作用清单见
// artifacts/18-platform-override-removal.txt 与 18-report.md）。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 三处翻转没翻到 / 翻错方向：指派表被手写专条抢答（或反过来翻多了）；
//   2. 降级兜底其实是删掉的：指派表不认识的 id 不再逐字节沿用旧手写结论；
//   3. 三档投影规则漂移：off 关不掉时臆造参数、none 被当档位、low/high 取错词、
//      budget-only 的模型被塞参数；
//   4. 平台方言丢失：值集 toggle 落到没登记开关形状的平台上被发明出字段；
//   5. **静默的第二事实源**（本票核心风险）：某行既有上游事实、手写侧也有
//      结论，两者不同却没进残留清单的 31 行 → 请求体被悄悄改了，没人知道；
//   6. 裁决不彻底：清单里某一行的旧手写结论仍能抢答（残留冻结语义）；
//   7. 目录外 id 被波及：B1 三条专条被删或降级链断掉；
//   8. 18 号票：四家托管平台的目录内模型掉进 unknown / 档位没按上游词表收窄
//      （见文件末尾「18 号票」describe 的 9 条）。

import { describe, expect, it } from "vitest";
import { ASSIGNMENTS, MODEL_ID_ALIASES, VALUESETS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  EXCEPTIONS,
  PROVIDERS,
  TAXONOMY,
  UPSTREAM_PROVIDER_BY_PRESET,
  UPSTREAM_TOGGLE_SHAPES,
  applyClassRule,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
  upstreamVocabularyOf,
  validateThinkingTables,
  type ClassRule,
  type TaxonomyEntry,
  type ThinkingLevel
} from "../../extension/ai/thinking-profiles.js";
import { PRESETS } from "../../extension/core/presets.js";

const LEVELS: readonly ThinkingLevel[] = ["off", "low", "high"];
const ALL_LEVELS = AI_THINKING_LEVELS;
const STREAM = false;

// 上游 provider id → preset id（桥接表的反向，用于拿 preset baseUrl / 手写 unknownClass）。
const PRESET_BY_UPSTREAM: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(UPSTREAM_PROVIDER_BY_PRESET).map(([presetId, upstreamId]) => [upstreamId, presetId])
);

// 18 号票前叫「override 型平台」；本票删掉平台级声明后它们与其它上游平台同构。这里
// 保留一个集合名，只用于**分区**：04/12 的历史审计线（31 行裁决清单）不含这四家，
// 它们 18 号票后的分歧集在文件末尾单独钉（口径：手写侧有具体 class 且与投影不同档）。
const HOSTED_PRESETS_18 = new Set(["openrouter", "amd", "sensenova", "opencodego"]);

function baseUrlOf(presetId: string): string {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`PRESETS 未登记预设：${presetId}`);
  return preset.baseUrl;
}

// 手写侧结论入口（与 resolver 的兜底分支同口径：EXCEPTIONS >> TAXONOMY >> unknownClass）。
function handClassOf(presetId: string, model: string): string | undefined {
  const normalized = model.trim().toLowerCase();
  const matches = (pattern: string) =>
    pattern.includes("*")
      ? new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(normalized)
      : normalized.startsWith(pattern);
  for (const entries of [EXCEPTIONS, TAXONOMY] as readonly (readonly TaxonomyEntry[])[]) {
    for (const entry of entries) {
      if (entry.patterns.some(matches)) return entry.class;
    }
  }
  return PROVIDERS[presetId]?.unknownClass;
}

function handRuleOf(presetId: string, model: string): ClassRule | undefined {
  const className = handClassOf(presetId, model);
  return className ? CLASSES[className] : undefined;
}

function outcomeOf(rule: ClassRule | undefined, level: ThinkingLevel): string {
  if (!rule) {
    return JSON.stringify({ fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "unknown" });
  }
  return JSON.stringify(applyClassRule(rule, level, STREAM));
}

function resolveViaRuntime(presetId: string, model: string, level: ThinkingLevel): string {
  return JSON.stringify(resolveThinkingProfile({ presetId, baseUrl: baseUrlOf(presetId), model, level, stream: STREAM }));
}

// 用户裁定 2 点名翻转的三处（上游 provider id / 上游模型 id，小写）。
const FLIPPED = ["zhipuai/glm-5.2", "zhipuai/glm-5.3", "kimi-code-plan-cn/k3"];

// 04 之前这三处靠手写专条决定；降级兜底后专条仍在（B1）。
// 19 号票收尾裁定后只剩两条：`kimi-k3*` 专条已删（见下方 describe 的钉数），
// 因为它是三条里唯一删掉不改变 fail-closed 方向的一条（另两条删了会让
// `glm-5.3-air` 从「不发参」翻成发 thinking:{type:"enabled"}，是 fail-open）。
const DOWNGRADED_HAND_ENTRIES: Array<{ upstreamId: string; presetId: string; pattern: string; className: string }> = [
  { upstreamId: "zhipuai", presetId: "zhipu", pattern: "glm-5.2", className: "glm-hybrid-effort" },
  { upstreamId: "zhipuai", presetId: "zhipu", pattern: "glm-5.3", className: "glm-always" }
];

// ===== 残留清单 31 行（04-prune-matrix.residual.md §2；model = 矩阵行口径的模型 id）=====
// 决策 #8 后续裁决：31 行按上游，2026-10-04 用户裁定「冻结的都按上游」。
const ADJUDICATED: readonly { presetId: string; model: string; key: string; oldHand: string | null }[] = [
  { presetId: "qwen", model: "deepseek-v4-flash", key: "alibaba-cn/deepseek-v4-flash", oldHand: "deepseek-hybrid-effort" },
  { presetId: "qwen", model: "deepseek-v4-pro", key: "alibaba-cn/deepseek-v4-pro", oldHand: "deepseek-hybrid-effort" },
  { presetId: "qwen", model: "glm-5.2", key: "alibaba-cn/glm-5.2", oldHand: "glm-hybrid-effort" },
  { presetId: "qwen", model: "glm-5.3", key: "alibaba-cn/glm-5.3", oldHand: "glm-always" },
  { presetId: "zhipu", model: "glm-5.3-flash", key: "zhipuai/glm-5.3-flash", oldHand: "glm-always" },
  { presetId: "zhipu", model: "glm-5.3-flashx", key: "zhipuai/glm-5.3-flashx", oldHand: "glm-always" },
  { presetId: "qwen", model: "siliconflow/deepseek-v3.2", key: "alibaba-cn/siliconflow/deepseek-v3.2", oldHand: null },
  { presetId: "minimax", model: "MiniMax-M3", key: "minimax-cn/minimax-m3", oldHand: "minimax-always" },
  { presetId: "stepfun", model: "step-3.5-flash", key: "stepfun-step-plan/step-3.5-flash", oldHand: "step-always" },
  { presetId: "stepfun", model: "step-3.5-flash-2603", key: "stepfun-step-plan/step-3.5-flash-2603", oldHand: "step-always" },
  { presetId: "deepseek", model: "deepseek-flash", key: "deepseek/deepseek-flash", oldHand: null },
  { presetId: "qwen", model: "qwen3-14b", key: "alibaba-cn/qwen3-14b", oldHand: null },
  { presetId: "qwen", model: "qwen3-8b", key: "alibaba-cn/qwen3-8b", oldHand: null },
  { presetId: "qwen", model: "qwen3-omni-flash", key: "alibaba-cn/qwen3-omni-flash", oldHand: null },
  { presetId: "qwen", model: "qwen3-vl-plus", key: "alibaba-cn/qwen3-vl-plus", oldHand: null },
  { presetId: "qwen", model: "siliconflow/deepseek-v3.1-terminus", key: "alibaba-cn/siliconflow/deepseek-v3.1-terminus", oldHand: null },
  { presetId: "moonshot", model: "k3-256k", key: "kimi-code-plan-cn/k3-256k", oldHand: null },
  { presetId: "moonshot", model: "kimi-for-coding", key: "kimi-code-plan-cn/kimi-for-coding", oldHand: null },
  { presetId: "stepfun", model: "step-5-preview", key: "stepfun-step-plan/step-5-preview", oldHand: null },
  { presetId: "qwen", model: "deepseek-v4.1-flash", key: "alibaba-cn/deepseek-v4.1-flash", oldHand: "deepseek-hybrid-effort" },
  { presetId: "qwen", model: "glm-5", key: "alibaba-cn/glm-5", oldHand: "glm-hybrid-switch" },
  { presetId: "qwen", model: "glm-5.1", key: "alibaba-cn/glm-5.1", oldHand: "glm-hybrid-switch" },
  { presetId: "qwen", model: "kimi-k2.5", key: "alibaba-cn/kimi-k2.5", oldHand: "kimi-hybrid-switch" },
  { presetId: "qwen", model: "kimi-k2.6", key: "alibaba-cn/kimi-k2.6", oldHand: "kimi-hybrid-switch" },
  { presetId: "qwen", model: "kimi/kimi-k2.5", key: "alibaba-cn/kimi/kimi-k2.5", oldHand: null },
  { presetId: "qwen", model: "qwen3-235b-a22b", key: "alibaba-cn/qwen3-235b-a22b", oldHand: "qwen-hybrid-switch-streamonly" },
  { presetId: "qwen", model: "qwen3-32b", key: "alibaba-cn/qwen3-32b", oldHand: "qwen-hybrid-switch-streamonly" },
  { presetId: "qwen", model: "qwen3.8-flash", key: "alibaba-cn/qwen3.8-flash", oldHand: "qwen-hybrid-switch" },
  { presetId: "qwen", model: "qwen3.8-omni-flash", key: "alibaba-cn/qwen3.8-omni-flash", oldHand: "qwen-hybrid-switch" },
  { presetId: "modelscope", model: "GLM-4.5", key: "modelscope/glm-4.5", oldHand: "glm-hybrid-switch" },
  { presetId: "modelscope", model: "GLM-4.6", key: "modelscope/glm-4.6", oldHand: "glm-hybrid-switch" }
];

// 31 行里行为**不变**的那一行（逐条登记，防止「裁决行都该变」的误读）：
// minimax-cn/minimax-m3：上游 `reasoning_options:[toggle]` 与厂商文档矛盾——platform.minimax.cn
// 官方文档写明**思考不可关闭**，所以这条 toggle 不可采信、不投 wire；fail-closed
// （thinkingClass always、无字段）恰与厂商口径一致，手写 `minimax-always` 是对的。
// 用户 2026-10-04 裁定：这是「上游事实 vs 厂商文档」的**已裁决分歧（hand-wins）**，不是缺口，
// 不需要给 minimax 补开关方言。故该行逐字节不变。
const NON_DIVERGENT = ["minimax-cn/minimax-m3"];

// 残留清单里两行 modelscope 的键是**本仓口径裸 id**（调用方传 GLM-4.5/GLM-4.6）——
// 它们的矩阵行确实按上游翻转（thinking:{type} → enable_thinking）；指派表里的上游写法
// ZhipuAI/GLM-4.x 那行才是不变的（手写 unknownClass 与投影同结论）。
const MODELSCOPE_UPSTREAM_ID_ROWS = ["modelscope/glm-4.5", "modelscope/glm-4.6"];

// 指派行的「上游投影 vs 手写结论」分歧键集（指定档位口径下计算）。
// 默认排除四家托管平台（HOSTED_PRESETS_18）——04/12 的历史审计线不含它们，它们的分歧集
// 在文件末尾单独钉。传 `presets` 时只算该集合；`handOnly` 只算「手写侧有具体 class」的行
// （目录外的 namespaced id 手写侧无结论，是覆盖缺口而不是分歧）。
function divergentKeys(
  levels: readonly ThinkingLevel[],
  options: { presets?: ReadonlySet<string>; handOnly?: boolean } = {}
): string[] {
  const divergent = new Set<string>();
  for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
    const presetId = PRESET_BY_UPSTREAM[upstreamId];
    expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
    if (options.presets) {
      if (!options.presets.has(presetId)) continue;
    } else if (HOSTED_PRESETS_18.has(presetId)) {
      continue;
    }
    for (const modelId of Object.keys(table)) {
      const fact = lookupThinkingFact(upstreamId, modelId);
      expect(fact, `${upstreamId}/${modelId} 有指派却查不到值集`).toBeTruthy();
      const projected = ruleFromUpstreamFact(fact!, presetId);
      const hand = handRuleOf(presetId, modelId);
      if (options.handOnly && !hand) continue;
      if (levels.some((level) => outcomeOf(projected, level) !== outcomeOf(hand, level))) {
        divergent.add(`${upstreamId}/${modelId.toLowerCase()}`);
      }
    }
  }
  return [...divergent];
}

describe("三处翻转（用户裁定 2：只翻 zhipuai/glm-5.2、zhipuai/glm-5.3、kimi-code-plan-cn/k3）", () => {
  it("zhipuai/glm-5.2：D1=A2 本仓补声明补上 toggle → off 可用（落 thinking 开关），档位仍是 high/max", () => {
    // 04 号票时这一行的上游事实是 effort[high,max]（无 toggle）→ off 关不掉、级联 high；
    // D1=A2 之后本仓给这一行补了 off 能力（见 OFF_CAPABILITY_DECLARATIONS），zhipu 已登记
    // 开关形状 → off 有写点：off 与档外的 minimal/low/medium 都落 off 写点，high/xhigh → high。
    for (const level of ["off", "minimal", "low", "medium"] as const) {
      expect(resolveViaRuntime("zhipu", "glm-5.2", level), level).toBe(
        JSON.stringify({
          fields: { thinking: { type: "disabled" } },
          offUnavailable: false,
          offFallback: null,
          thinkingClass: "hybrid"
        })
      );
    }
    expect(resolveViaRuntime("zhipu", "glm-5.2", "high")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "high" }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    expect(resolveViaRuntime("zhipu", "glm-5.2", "max")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "max" }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
  });

  it("zhipuai/glm-5.3：上游 low-high-max → 有档位；off 关不掉、级联落 low", () => {
    expect(resolveViaRuntime("zhipu", "glm-5.3", "high")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "high" }, offUnavailable: false, offFallback: null, thinkingClass: "always" })
    );
    for (const level of ["off", "low"] as const) {
      expect(resolveViaRuntime("zhipu", "glm-5.3", level)).toBe(
        JSON.stringify({
          fields: { reasoning_effort: "low" },
          offUnavailable: level === "off",
          offFallback: level === "off" ? "low" : null,
          thinkingClass: "always"
        })
      );
    }
  });

  it("kimi-code-plan-cn/k3：13 号票 canonical 优先 → 词表 low-high-max（off 关不掉、级联落 low）", () => {
    // 12 号票的翻转（direct 的 toggle → off 可用）被 13 号票的 canonical 优先覆盖：
    // canonical（moonshotai/kimi-k3）没有 toggle → off 只走级联落最低可用档。
    expect(resolveViaRuntime("moonshot", "kimi-k3", "off")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "low" }, offUnavailable: true, offFallback: "low", thinkingClass: "always" })
    );
    expect(resolveViaRuntime("moonshot", "kimi-k3", "high")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "high" }, offUnavailable: false, offFallback: null, thinkingClass: "always" })
    );
    // 上游 id 写法（k3）与别名写法（kimi-k3）同源同结论。
    expect(resolveViaRuntime("moonshot", "k3", "off")).toBe(resolveViaRuntime("moonshot", "kimi-k3", "off"));
    expect(resolveViaRuntime("moonshot", "k3", "high")).toBe(resolveViaRuntime("moonshot", "kimi-k3", "high"));
  });

  it("两条照翻，尽管手写专条还在且结论相反（12 号票后专条只兜指派表不认识的 id）", () => {
    // 手写专条仍在（B1 降级而非删除；19 号票收尾只删了第三条 kimi-k3*）……
    for (const entry of DOWNGRADED_HAND_ENTRIES) {
      const table = entry.className === "glm-hybrid-effort" ? TAXONOMY : EXCEPTIONS;
      expect(table.some((row) => row.class === entry.className && row.patterns.includes(entry.pattern)), `${entry.pattern} 专条应在表里`).toBe(true);
      expect(handClassOf(entry.presetId, entry.pattern)).toBe(entry.className);
    }
    // 但原生模型照上游翻转（上三个用例），即手写专条对「指派表命中的模型」不再参与。
    expect(handRuleOf("zhipu", "glm-5.2")).toBe(CLASSES["glm-hybrid-effort"]);
    expect(resolveViaRuntime("zhipu", "glm-5.2", "low")).not.toBe(outcomeOf(CLASSES["glm-hybrid-effort"], "low"));
  });
});

describe("降级兜底（B1）：指派表不认识的 id 逐字节沿用旧手写结论", () => {
  // 这些 id 不在 02 指派表里（用户自填 / 上游新变体）：
  // 它们必须仍然走手写专条 —— 真删专条就会改变它们的请求体（12 号票非目标）。
  // 19 号票删了 kimi-k3* 那条，两条 kimi-k3 的目录外 id 随之改落别处（UNKNOWN 哨兵 /
  // 平台 unknownClass），已在本 describe 之后的「新」块里逐条钉住，不再列为「沿用专条」。
  const CASES: Array<[string, string]> = [
    ["zhipu", "glm-5.2-air"],
    ["qwen", "glm-5.3-air"],
    ["ollama", "glm-5.2"]
  ];

  for (const [presetId, model] of CASES) {
    it(`${presetId}/${model}：三档 = 手写专条结论`, () => {
      expect(lookupThinkingFact(UPSTREAM_PROVIDER_BY_PRESET[presetId] ?? "", model), `${model} 不该在指派表里`).toBeNull();
      for (const level of LEVELS) {
        expect(resolveViaRuntime(presetId, model, level), level).toBe(outcomeOf(handRuleOf(presetId, model), level));
      }
    });
  }

  // 非上游平台（无 preset，靠 host 推断）上恰为这三个 id 的极端情形：真删专条会连它们一起改
  // （如 api.siliconflow.cn/glm-5.2 从 effort 档变成 thinking:{type}，方言反而更不对）。
  const HOST_CASES: Array<[string, string, string]> = [
    ["siliconflow", "https://api.siliconflow.cn/v1", "glm-5.2"],
    ["siliconflow", "https://api.siliconflow.cn/v1", "glm-5.3-air"]
  ];

  for (const [providerId, baseUrl, model] of HOST_CASES) {
    it(`host 推断 ${providerId} + ${model}：三档 = 手写专条结论`, () => {
      for (const level of LEVELS) {
        const actual = resolveThinkingProfile({ baseUrl, model, level, stream: STREAM });
        expect(JSON.stringify(actual), level).toBe(outcomeOf(handRuleOf(providerId, model), level));
      }
    });
  }

  });

describe("19 号票：删 EXCEPTIONS kimi-k3* 专条（另两条保留）", () => {
  // 裁定依据（12 号票明写「真删 + 替代兜底是开放问题」，2026-10-05 收尾裁 B）：
  // 目录内 359 行模型零个靠这三条兜底（实测 artifacts/20-b1-fallback.ts），
  // 它们唯一的服务对象是目录外 id。逐条删的后果方向不同：
  //   - EXCEPTIONS glm-5.3* 删了 → glm-5.3-air 落到 TAXONOMY 的 glm-5 → hybrid-switch
  //     → 对「传 disabled 硬报错」的永不思考族改发 thinking:{type:"enabled"} = fail-open。故留。
  //   - TAXONOMY glm-5.2 前置删了 → 方言从 effort 词表变 thinking 开关（不报错，形状变）。故留。
  //   - EXCEPTIONS kimi-k3* 删了 → 不匹配任何模式 → UNKNOWN 哨兵 → 一个字段都不发
  //     = fail-closed，方向正确，是三条里唯一删了不亏的。故删。
  it("专条与随之孤儿化的 class 都不在了", () => {
    expect(EXCEPTIONS.some((row) => row.patterns.includes("kimi-k3"))).toBe(false);
    expect(CLASSES["kimi-k3-effort"]).toBeUndefined();
    // 另两条原样保留。
    expect(EXCEPTIONS.some((row) => row.class === "glm-always" && row.patterns.includes("glm-5.3"))).toBe(true);
    expect(TAXONOMY.some((row) => row.class === "glm-hybrid-effort" && row.patterns.includes("glm-5.2"))).toBe(true);
  });

  it("moonshot/kimi-k3-air：七档全落 UNKNOWN 哨兵，一个字段都不发", () => {
    expect(lookupThinkingFact(UPSTREAM_PROVIDER_BY_PRESET["moonshot"] ?? "", "kimi-k3-air")).toBeNull();
    expect(handClassOf("moonshot", "kimi-k3-air")).toBeUndefined();
    for (const level of ALL_LEVELS) {
      const adjustment = resolveThinkingAdjustment({
        presetId: "moonshot",
        baseUrl: baseUrlOf("moonshot"),
        model: "kimi-k3-air",
        level,
        stream: STREAM
      });
      expect(adjustment.source, level).toBe("unknown");
      expect(adjustment.availableLevels, level).toEqual([]);
      expect(adjustment.resolution.fields, level).toEqual({});
      expect(adjustment.resolution.thinkingClass, level).toBe("unknown");
    }
  });

  it("ollama/kimi-k3：不再吃 k3 专条，改落该平台 unknownClass（ollama-effort）", () => {
    expect(handClassOf("ollama", "kimi-k3")).toBe("ollama-effort");
    expect(resolveViaRuntime("ollama", "kimi-k3", "off")).toBe(outcomeOf(CLASSES["ollama-effort"], "off"));
    expect(resolveViaRuntime("ollama", "kimi-k3", "high")).toBe(outcomeOf(CLASSES["ollama-effort"], "high"));
    expect(CLASSES["ollama-effort"].thinkingClass).toBe("hybrid");
  });

  it("host 推断 api.openai.com + kimi-k3：UNKNOWN 哨兵（该 host 无平台可兜）", () => {
    // resolveThinkingProfile 不回传 source，改用 adjustment 入口钉 source。
    expect(lookupThinkingFact(UPSTREAM_PROVIDER_BY_PRESET["moonshot"] ?? "", "kimi-k3-air")).toBeNull();
    for (const level of ALL_LEVELS) {
      const actual = resolveThinkingAdjustment({
        baseUrl: "https://api.openai.com/v1",
        model: "kimi-k3",
        level,
        stream: STREAM
      });
      expect(actual.source, level).toBe("unknown");
      expect(actual.availableLevels, level).toEqual([]);
      expect(actual.resolution.fields, level).toEqual({});
      expect(actual.resolution.thinkingClass, level).toBe("unknown");
    }
  });
});

describe("上游值集 → class 规则（05 号票：每个 effort 档物化成一个写点）", () => {
  const fact = (valuesetId: string, toggle: boolean, effort: string[] | null, off: "toggle" | "effort-none" | null) => ({
    valuesetId,
    toggle,
    effort,
    off
  });

  it("budget-only（无 toggle 无 effort）：不发任何参数，也不发明 off", () => {
    expect(ruleFromUpstreamFact(fact("b", false, null, null), "qwen")).toEqual({ thinkingClass: "always" });
  });

  it("toggle + budget：off 走平台开关、非 off 档落开关的开写点（qwen 方言 enable_thinking）", () => {
    expect(ruleFromUpstreamFact(fact("toggle+b:-81920", true, null, "toggle"), "qwen")).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { enable_thinking: false } },
      on: { fields: { enable_thinking: true } }
    });
  });

  it("toggle 平台无登记开关形状（stepfun）：不发明形状 → 不发开关", () => {
    expect(ruleFromUpstreamFact(fact("toggle", true, null, "toggle"), "stepfun")).toEqual({ thinkingClass: "always" });
  });

  it("effort 含 none：off 走 effort none；none 不物化成档位", () => {
    expect(ruleFromUpstreamFact(fact("none-high", false, ["none", "high"], "effort-none"), "qwen")).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { reasoning_effort: "none" } },
      high: { fields: { reasoning_effort: "high" } }
    });
  });

  it("high-max（glm-5.2）：词表两档各一格（clamp 决定偏好落在哪档，投影不再折叠）", () => {
    expect(ruleFromUpstreamFact(fact("high-max", false, ["high", "max"], null), "zhipu")).toEqual({
      thinkingClass: "always",
      high: { fields: { reasoning_effort: "high" } },
      max: { fields: { reasoning_effort: "max" } }
    });
  });

  it("low-medium-xhigh（qwen3.8-max）：三个档位逐格物化（偏好 high 由 clamp 向下取到 medium）", () => {
    expect(
      ruleFromUpstreamFact(fact("toggle+low-medium-xhigh+b:0-262144", true, ["low", "medium", "xhigh"], "toggle"), "qwen")
    ).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { enable_thinking: false } },
      low: { fields: { reasoning_effort: "low" } },
      medium: { fields: { reasoning_effort: "medium" } },
      xhigh: { fields: { reasoning_effort: "xhigh" } }
    });
  });

  it("low-high-max（deepseek-v4-pro）：词表三档各一格", () => {
    expect(ruleFromUpstreamFact(fact("toggle+low-high-max", true, ["low", "high", "max"], "toggle"), "deepseek")).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { thinking: { type: "disabled" } } },
      low: { fields: { reasoning_effort: "low" } },
      high: { fields: { reasoning_effort: "high" } },
      max: { fields: { reasoning_effort: "max" } }
    });
  });
});

describe("残留清单裁决（31 行按上游，2026-10-04 用户裁定；决策 #8 后续）", () => {
  it("31 行逐行按上游投影（7 档全锁，不允许旧手写结论抢答）", () => {
    expect(ADJUDICATED.length).toBe(31);
    for (const row of ADJUDICATED) {
      const fact = lookupThinkingFact(row.key.slice(0, row.key.indexOf("/")), row.model);
      expect(fact, `${row.key} 应有上游事实`).toBeTruthy();
      const projected = ruleFromUpstreamFact(fact!, row.presetId);
      for (const level of ALL_LEVELS) {
        expect(resolveViaRuntime(row.presetId, row.model, level), `${row.key} · ${level}`).toBe(outcomeOf(projected, level));
      }
    }
  });

  it("04 口径（off/low/high）下与旧手写结论不同的非 override 指派行，恰好是这 31 行的 28 行 + 点名三处 + clamp 分歧", () => {
    const divergent = divergentKeys(LEVELS);
    // 期望 = 残留清单 31 行里的 28 行（另 3 行逐条见 NON_DIVERGENT / MODELSCOPE_UPSTREAM_ID_ROWS 说明）
    //   + 用户裁定 2 点名的三处（04 号票起就按上游）
    //   + 05 号票 clamp 的有意分歧 qwen3.8-max（词表 low/medium/xhigh，偏好 high 落 medium）
    //   + alibaba-cn/kimi-k3：**19 号票删掉 kimi-k3* 专条后的口径变化**——它原先是
    //     「7 档才分歧」（手写 kimi-k3-effort 缺 max 写点），手写侧现无结论（qwen 无
    //     unknownClass → UNKNOWN）故任何档位都与上游投影不同。行本身走指派表，运行时不变。
    const expected = [
      ...ADJUDICATED.map((row) => row.key).filter((key) => !NON_DIVERGENT.includes(key) && !MODELSCOPE_UPSTREAM_ID_ROWS.includes(key)),
      ...FLIPPED,
      "alibaba-cn/qwen3.8-max",
      "alibaba-cn/kimi-k3"
    ].sort();
    expect([...divergent].sort()).toEqual(expected);
  });

  it("7 档口径下多出的 4 行：旧手写 class 缺 05 号票新增档位写点（清单外的「分歧」与新档位无关）", () => {
    // 05 号票把词表扩到 7 档后，下面 4 行的上游值集带 max 档而旧手写 class 没有 max 写点
    // （偏好 max 在手写侧被 clamp 到 high）——它们从未进过 04 冻结表（04 口径只比 off/low/high），
    // 也不构成「静默第二事实源」：命中指派表的行一律走上游投影（见下一个 describe）。
    // 原第 5 行 alibaba-cn/kimi-k3 已移出：成因从「手写 kimi-k3-effort 缺 max 写点」变成
    // 「19 号票删掉该专条后手写侧无结论」，不再是「档位差异」，已并入上一用例的 3 档集合。
    const EXTRA_TIERS: Record<string, string> = {
      "deepseek/deepseek-v4-flash": "上游 toggle+low-high-max；手写 deepseek-hybrid-effort 无 max 写点",
      "deepseek/deepseek-v4-flash-vision-exp": "同上（同族变体）",
      "deepseek/deepseek-v4-pro": "同上（同族变体）",
      "stepfun-step-plan/step-3.7-flash": "上游含 max；手写 step37-effort 无 max 写点"
    };
    const divergent7 = divergentKeys(ALL_LEVELS);
    const divergent3 = divergentKeys(LEVELS);
    expect([...divergent7].sort()).toEqual([...divergent3, ...Object.keys(EXTRA_TIERS)].sort());
  });

  it("唯一行为不变的裁决行：minimax-cn/minimax-m3（上游 toggle 与厂商文档矛盾，2026-10-04 裁定 hand-wins）", () => {
    const key = NON_DIVERGENT[0];
    const row = ADJUDICATED.find((candidate) => candidate.key === key)!;
    const projected = ruleFromUpstreamFact(lookupThinkingFact("minimax-cn", row.model)!, row.presetId);
    // 成因写死在断言里：上游 toggle 与厂商文档矛盾（platform.minimax.cn：思考不可关闭）→
    // 不可投 wire，fail-closed 恰与厂商口径一致（2026-10-04 用户裁定 hand-wins，不是缺口）。
    expect(projected).toEqual({ thinkingClass: "always" });
    for (const level of ALL_LEVELS) {
      expect(resolveViaRuntime(row.presetId, row.model, level), `${key} · ${level}`).toBe(
        outcomeOf(row.oldHand ? CLASSES[row.oldHand] : undefined, level)
      );
    }
  });

  it("modelscope 两行：清单键 = 本仓口径裸 id（矩阵行），该行确实翻转（上游 id 那行才是不变的）", () => {
    // 残留清单的键 `modelscope/glm-4.5|4.6` 是**调用方传入的本仓口径裸 id**；指派表/别名表里的
    // 上游写法是 ZhipuAI/GLM-4.x。裸 id 行：手写 TAXONOMY glm-4.x → thinking:{type}，投影按
    // modelscope preset 方言 → enable_thinking（翻转，矩阵与 golden 逐字节钉住）；
    // 上游 id 行：手写落 unknownClass qwen-hybrid-switch（enable_thinking）与投影相同（不变）。
    for (const key of MODELSCOPE_UPSTREAM_ID_ROWS) {
      const row = ADJUDICATED.find((candidate) => candidate.key === key)!;
      expect(handClassOf(row.presetId, row.model)).toBe(row.oldHand);
      const bare = outcomeOf(CLASSES[row.oldHand!], "off");
      expect(resolveViaRuntime(row.presetId, row.model, "off")).not.toBe(bare);
      expect(resolveViaRuntime(row.presetId, row.model, "off")).toBe(
        JSON.stringify({ fields: { enable_thinking: false }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
      );
      // 上游 id 写法（ZhipuAI/GLM-4.x）的兜底路径与投影同结论——这行行为不变。
      const upstreamIdModel = `ZhipuAI/${row.model}`;
      expect(handClassOf(row.presetId, upstreamIdModel)).toBe("qwen-hybrid-switch");
      for (const level of ALL_LEVELS) {
        const projected = ruleFromUpstreamFact(lookupThinkingFact(row.presetId, upstreamIdModel)!, row.presetId);
        expect(outcomeOf(handRuleOf(row.presetId, upstreamIdModel), level), `${key} · ${level}`).toBe(outcomeOf(projected, level));
      }
    }
  });

  it("表校验器仍把 CLASSES/TAXONOMY/EXCEPTIONS/PROVIDERS 校验干净（冻结表一节随裁决删除）", () => {
    expect(validateThinkingTables()).toEqual([]);
  });
});

describe("完整性：对指派表命中的模型，结论只来自上游投影（无静默第二事实源）", () => {
  it("02 指派表逐条 × 7 档：全部行 runtime === 上游投影（18 号票起四家托管平台也在内）", () => {
    let total = 0;
    for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
      const presetId = PRESET_BY_UPSTREAM[upstreamId];
      expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
      for (const modelId of Object.keys(table)) {
        const fact = lookupThinkingFact(upstreamId, modelId);
        expect(fact, `${upstreamId}/${modelId} 有指派却查不到值集`).toBeTruthy();
        total += 1;
        const projected = ruleFromUpstreamFact(fact!, presetId);
        for (const level of ALL_LEVELS) {
          expect(resolveViaRuntime(presetId, modelId, level), `${upstreamId}/${modelId} · ${level}`).toBe(outcomeOf(projected, level));
        }
      }
    }
    // 口径自检：指派表规模没被误读（02 产物 359+ 条指派；18 号票删 override 后不再有例外，
    // 逐条都进断言）。
    expect(total).toBeGreaterThanOrEqual(359);
  });

  it("18 号票：四家托管平台的目录内模型也逐格按上游词表（不再是平台声明口径）", () => {
    // 18 号票前这四家整域走平台声明；现在逐模型按自己的值集。
    for (const presetId of HOSTED_PRESETS_18) {
      const upstreamId = UPSTREAM_PROVIDER_BY_PRESET[presetId];
      for (const modelId of Object.keys(ASSIGNMENTS[upstreamId] ?? {})) {
        expect(
          resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model: modelId, level: "high", stream: STREAM }).source,
          `${presetId}/${modelId}`
        ).toBe("upstream");
      }
    }
    // 裁定点名的边界格：opencodego/hy4-preview（上游 none-high，平台未登记开关形状）
    // → A' = {off, high}；偏好 low 向下取 off（发 effort none），不是平台声明的一刀切 effort。
    const low = resolveThinkingProfile({ presetId: "opencodego", model: "hy4-preview", level: "low", stream: STREAM });
    expect(low.fields).toEqual({ reasoning_effort: "none" });
    expect(resolveThinkingProfile({ presetId: "opencodego", model: "hy4-preview", level: "high", stream: STREAM }).fields).toEqual({
      reasoning_effort: "high"
    });
  });

  it("上游未覆盖的兜底职责仍在：用户自填 id 走手写表，有事实的模型由指派表决定", () => {
    // 用户自填 id（指派表查不到）仍命中手写前缀模式。
    expect(resolveViaRuntime("qwen", "qwen3.5-my-finetune", "high")).toBe(
      JSON.stringify({ fields: { enable_thinking: true }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    // 同一平台上「有事实」的模型：runtime 结论 = 指派表投影，不再等于手写侧结论。
    // 05 号票（决策 #8 + 裁定 A）：qwen3.8-max 词表 low/medium/xhigh 无 high →
    // 偏好 high 由 clamp 向下取到 medium（实发即 medium）。
    expect(handClassOf("qwen", "qwen3.8-max")).toBe("qwen-hybrid-effort");
    expect(resolveViaRuntime("qwen", "qwen3.8-max", "high")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "medium" }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    expect(resolveViaRuntime("qwen", "qwen3.8-max", "high")).toBe(
      outcomeOf(ruleFromUpstreamFact(lookupThinkingFact("alibaba-cn", "qwen3.8-max")!, "qwen"), "high")
    );
    // 裁决行同样按上游：托管 alibaba-cn/glm-5.2 与原生 zhipuai/glm-5.2 同值集
    // （D1=A2 后是 toggle+high-max）——qwen 方言的 off 写点 = enable_thinking:false。
    expect(handClassOf("qwen", "glm-5.2")).toBe("glm-hybrid-effort");
    expect(resolveViaRuntime("qwen", "glm-5.2", "off")).toBe(
      JSON.stringify({ fields: { enable_thinking: false }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    // 两条路径的 off 出口是各自的平台方言（zhipu = thinking.type、qwen = enable_thinking），
    // 不再逐字节相同——补声明保证的是「都关得掉」这个语义，跨平台形状由 UPSTREAM_TOGGLE_SHAPES 定。
    const zhipuOff = JSON.parse(resolveViaRuntime("zhipu", "glm-5.2", "off"));
    const qwenOff = JSON.parse(resolveViaRuntime("qwen", "glm-5.2", "off"));
    expect(qwenOff.offUnavailable).toBe(false);
    expect(zhipuOff.offUnavailable).toBe(false);
    expect(qwenOff.thinkingClass).toBe("hybrid");
    expect(zhipuOff.thinkingClass).toBe("hybrid");
  });

  it("无上游平台的解析结果与手写表逐格一致（ollama / custom / 未知 host 不被上游影响）", () => {
    const cases: Array<[string | undefined, string, string]> = [
      [undefined, "https://api.example.com/v1", "totally-unknown"],
      ["ollama", "http://localhost:11434/v1", "llama3.2"],
      ["ollama", "http://localhost:11434/v1", "deepseek-r1:8b"],
      ["custom", "https://api.example.com/v1", "vendor-future-1"]
    ];
    for (const [presetId, baseUrl, model] of cases) {
      for (const level of LEVELS) {
        const actual = resolveThinkingProfile({ presetId, baseUrl, model, level, stream: STREAM });
        const expected = outcomeOf(presetId ? handRuleOf(presetId, model) : undefined, level);
        expect(JSON.stringify(actual), `${model} · ${level}`).toBe(expected);
      }
    }
  });
});

// ===== 13 号票：canonical 优先 + canonical 重定向表 =====
// 失败方式（每条一个用例）：
//   1. canonical 悬空时没回落 direct（行变成「未知词表」不发参）；
//   2. canonical 优先没生效（direct 的窄词表仍当主人，如 opencode-go/kimi-k3 只剩 max）；
//   3. 重定向表没生效（7 行借不到 deepseek-flash）；
//   4. 单点裁决删除后 opencodego 的 max 被平台声明裁掉（kimi-k3 的 A' 少了 max）；
//   5. 丢 off 的行没按新上游事实丢（还发 reasoning_effort:none）；
//   6. A' = ∅ 的行不再 fail-closed（照平台声明发参）；
//   7. minimax 的 hand-wins 被 canonical 优先波及（负事实被动过）；
//   8. 18 号票删平台 override 时把 13 号票的对齐结果带偏（canonical 词表/重定向语义被改）。
describe("13 号票：canonical 优先 + 重定向表（2026-10-05 用户裁定）", () => {
  const adjustmentOf = (presetId: string, model: string, level = "high") =>
    resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level, stream: STREAM });
  const levelsOf = (presetId: string, model: string): readonly ThinkingLevel[] => adjustmentOf(presetId, model).availableLevels;

  it("canonical 优先：direct 非空的行也按 canonical 的词表服务（opencode-go/kimi-k3 拿到 low-high-max）", () => {
    // direct 只有 effort[max]；canonical（moonshotai/kimi-k3）是 low-high-max。
    const fact = lookupThinkingFact("opencode-go", "kimi-k3");
    expect(fact?.valuesetId).toBe("low-high-max");
    expect(fact?.effort).toEqual(["low", "high", "max"]);
    // 13 号票时平台声明补了 max → A' = {low, high, max}；18 号票删声明后 A' 仍是
    // 上游词表自己的 {low, high, max}（无 off：opencodego 未登记开关形状）。
    expect(levelsOf("opencodego", "kimi-k3")).toEqual(["low", "high", "max"]);
    expect(adjustmentOf("opencodego", "kimi-k3").source).toBe("upstream");
  });

  it("canonical 悬空回落 direct（不变成未知词表）：deepseek-v4-pro 的指针指向不存在的 id", () => {
    // canonical = deepseek/deepseek-v4-pro-0813，上游没有这个 id → 回落 direct。
    const fact = lookupThinkingFact("deepseek", "deepseek-v4-pro");
    expect(fact?.valuesetId).toBe("toggle+low-high-max");
    expect(fact?.off).toBe("toggle");
    for (const level of ALL_LEVELS) {
      expect(resolveViaRuntime("deepseek", "deepseek-v4-pro", level), level).toBe(
        outcomeOf(ruleFromUpstreamFact(fact!, "deepseek"), level)
      );
    }
  });

  it("重定向表：7 行 canonical 指向 deepseek/deepseek-v4.1-flash 的行，档位集合逐一等于裁定表", () => {
    // 18 号票：四家托管平台未在 UPSTREAM_TOGGLE_SHAPES 登记开关形状，值集里的 toggle
    // 不产生 off 写点，故 openrouter / amd 两行的 A' 从 13 号票的 {off,low,high} 变成
    // 上游 effort 词表自己的 {low,high,max}。
    const expected: Array<[presetId: string, upstreamId: string, model: string, levels: readonly ThinkingLevel[]]> = [
      ["deepseek", "deepseek", "deepseek-v4-flash-vision-exp", ["off", "low", "high", "max"]],
      ["deepseek", "deepseek", "deepseek-flash", ["off", "low", "high", "max"]],
      ["deepseek", "deepseek", "deepseek-v4-flash", ["off", "low", "high", "max"]],
      ["qwen", "alibaba-cn", "deepseek-v4.1-flash", ["off", "low", "high", "max"]],
      ["opencodego", "opencode-go", "deepseek-v4.1-flash", ["low", "high", "max"]],
      ["openrouter", "openrouter", "deepseek/deepseek-v4.1-flash", ["low", "high", "max"]],
      ["amd", "amd", "DeepSeek-V4.1-Flash", ["low", "high", "max"]]
    ];
    expect(expected).toHaveLength(7);
    const target = lookupThinkingFact("deepseek", "deepseek-flash");
    for (const [presetId, upstreamId, model, levels] of expected) {
      expect(lookupThinkingFact(upstreamId, model)?.valuesetId, `${upstreamId}/${model}`).toBe(target?.valuesetId);
      expect(levelsOf(presetId, model), `${presetId}/${model}`).toEqual([...levels]);
    }
    // amd 从 direct 的 effort[none,…,max] 换成重定向目标的 toggle+low-high-max：值集带 toggle，
    // 但 amd 未登记开关形状 → off 不物化（18 号票前是平台 override 的 off 写点在兜）。
    const amd = lookupThinkingFact("amd", "DeepSeek-V4.1-Flash");
    expect(amd?.toggle).toBe(true);
    expect(amd?.effort).toEqual(["low", "high", "max"]);
    expect(amd?.off).toBe("toggle");
    expect(levelsOf("amd", "DeepSeek-V4.1-Flash")).not.toContain("off");
  });

  it("丢 off 的行按新上游事实失去 off（21 行 openrouter + moonshot/k3；glm-5.2 已由 D1=A2 补回）", () => {
    // D1=A2 前本清单还含 openrouter/z-ai/glm-5.2 与 sensenova/glm-5.2（13 号票 canonical 优先把
    // 它们的 direct off 抹掉）；本仓补声明给 zhipuai/glm-5.2 补上 toggle 后，这两行的**模型侧**
    // 事实重新带 off，故移出本清单——它们仍未关得掉，但原因换成了「平台形状未登记」（见紧随的
    // 「D1=A2 不变性」用例）。
    const lost: Array<[presetId: string, upstreamId: string, model: string]> = [
      ["openrouter", "openrouter", "anthropic/claude-opus-4.5"],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.6"],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.7"],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.8"],
      ["openrouter", "openrouter", "anthropic/claude-haiku-4.5"],
      ["openrouter", "openrouter", "anthropic/claude-opus-5"],
      ["openrouter", "openrouter", "anthropic/claude-sonnet-4.5"],
      ["openrouter", "openrouter", "anthropic/claude-sonnet-4.6"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-image-preview"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-image"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-lite-image"],
      ["openrouter", "openrouter", "google/gemini-3-flash-preview"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-lite-preview"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-lite"],
      ["openrouter", "openrouter", "moonshotai/kimi-k3"],
      ["openrouter", "openrouter", "openai/o4-mini"],
      ["openrouter", "openrouter", "openai/o3-mini"],
      ["openrouter", "openrouter", "openai/o1"],
      ["openrouter", "openrouter", "openai/o3-pro"],
      ["openrouter", "openrouter", "openai/o3"],
      ["openrouter", "openrouter", "openai/o1-pro"],
      ["moonshot", "kimi-code-plan-cn", "k3"]
    ];
    expect(lost.filter(([presetId]) => presetId === "openrouter")).toHaveLength(21);
    for (const [presetId, upstreamId, model] of lost) {
      const fact = lookupThinkingFact(upstreamId, model);
      expect(fact, `${upstreamId}/${model}`).toBeTruthy();
      // 模型侧事实：off 不再可得（无 toggle、effort 不含 none）。
      expect(fact?.off, `${upstreamId}/${model} 不该再有 off`).toBeNull();
      expect(upstreamVocabularyOf(fact!), `${upstreamId}/${model} 的词表不该含 off`).not.toContain("off");
      // 档位层：off 不在 chip 集合里，请求 off 不发 none（级联落最低可用档）。
      expect(levelsOf(presetId, model), `${presetId}/${model}`).not.toContain("off");
      const off = resolveThinkingProfile({ presetId, baseUrl: baseUrlOf(presetId), model, level: "off", stream: STREAM });
      expect(JSON.stringify(off.fields), `${presetId}/${model} 偏好 off`).not.toContain('"none"');
    }
  });

  it("A' = ∅ 的行仍 fail-closed（openrouter/anthropic/claude-haiku-4.5、claude-sonnet-4.5 不发参）", () => {
    for (const model of ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"]) {
      const adj = adjustmentOf("openrouter", model);
      expect(adj.availableLevels, model).toEqual([]);
      // 2026-10-05 default 档：没有可表达的强度档 → 实发 default（线上一律不发字段，语义同旧口径）。
      expect(adj.effectiveLevel, model).toBe("default");
      expect(adj.source, model).toBe("upstream");
      for (const level of ALL_LEVELS) {
        // 模型侧词表是 budget-only（无 toggle、无 effort）→ A' = ∅、thinkingClass always：
        // off 走级联（无档可落 → offUnavailable 标记），非 off 档不发任何字段。
        expect(resolveViaRuntime("openrouter", model, level), `${model} · ${level}`).toBe(
          JSON.stringify({
            fields: {},
            offUnavailable: level === "off",
            offFallback: null,
            thinkingClass: "always"
          })
        );
      }
    }
  });

  it("minimax/MiniMax-M3 的 hand-wins 逐字节不变（没有 canonical 指针，改造碰不到它）", () => {
    const upstream = "minimax-cn";
    // 负事实没被动过：上游仍是 [toggle]（不可采信），本仓仍不登记 minimax 开关方言。
    expect(lookupThinkingFact(upstream, "MiniMax-M3")?.valuesetId).toBe("toggle");
    expect(UPSTREAM_PROVIDER_BY_PRESET.minimax).toBe(upstream);
    // 本仓仍不给 minimax 登记开关形状（PROVIDERS.minimax 无平台声明、无 override 机制）。
    expect(PROVIDERS.minimax).toEqual({});
    const expectedOff = JSON.stringify({ fields: {}, offUnavailable: true, offFallback: null, thinkingClass: "always" });
    const expectedOn = JSON.stringify({ fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "always" });
    for (const level of ALL_LEVELS) {
      expect(resolveViaRuntime("minimax", "MiniMax-M3", level), level).toBe(level === "off" ? expectedOff : expectedOn);
    }
    expect(levelsOf("minimax", "MiniMax-M3")).toEqual([]);
  });

  it("18 号票：机制删干净——四家 PROVIDERS 记录都是空对象", () => {
    for (const presetId of HOSTED_PRESETS_18) {
      expect(PROVIDERS[presetId], presetId).toEqual({});
    }
  });
});

// ===== 18 号票：删 4 家平台 override，四家全面回归上游词表投影 =====
// 用户 2026-10-05 裁定：「4 家的平台声明必须压过上游词表这件事取消，删除平台声明，
// 直接用上游词表」。落地验证器（可复跑，exit 0）见 artifacts/18-platform-override-removal.ts。
//
// 先列这次改造可能失败的方式（每条一个用例）：
//   1. 某家模型查不到上游词表 → 静默落 unknown / fail-closed（282 行零缺口钉「零」）；
//   2. 平台声明删了却仍能凭空多发档位（该降级的没降级、该消失的档位没消失）；
//   3. 13 号票刚对齐的行被这次删除带偏（opencodego/kimi-k3 逐字节哨兵）；
//   4. thinkingClass 没有整体翻转 / off 级联没生效（175 / 235 两个口径都钉）；
//   5. 零档行不再 fail-closed（budget-only 被塞进任何字段）；
//   6. UPSTREAM_TOGGLE_SHAPES 被顺手加了四家登记（无平台文档支撑，裁定 3）；
//   7. minimax 的 hand-wins 被波及（与 override 无关的负事实）；
//   8. 四家目录内行仍报告 source: "override"（机制残留）；
//   9. 四家「手写侧有结论」的行没被识别为新分歧（本票新增的审计面）。
describe("18 号票：删 4 家平台 override（2026-10-05 用户裁定）", () => {
  const levelsOf = (presetId: string, model: string): readonly ThinkingLevel[] =>
    resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "high", stream: STREAM }).availableLevels;

  const localIdOf = (upstreamId: string, modelId: string): string => {
    for (const alias of MODEL_ID_ALIASES) {
      if (alias.upstream === `${upstreamId}/${modelId}`) return alias.localId;
    }
    return modelId;
  };

  // 目录内模型 = 02 指派表键 ∪ 指向该 provider 的别名（与 04-prune-matrix.ts / 06 工件同源）。
  const modelsOf = (presetId: string): string[] => {
    const upstreamId = UPSTREAM_PROVIDER_BY_PRESET[presetId];
    const models = new Set<string>();
    for (const modelId of Object.keys(ASSIGNMENTS[upstreamId] ?? {})) {
      models.add(localIdOf(upstreamId, modelId));
    }
    for (const alias of MODEL_ID_ALIASES) {
      if (alias.provider === upstreamId) models.add(alias.localId);
    }
    return [...models].sort();
  };

  it("目录内 282 行零缺口：四家每一行都落 source: \"upstream\"（没有 unknown / fail-closed）", () => {
    const counts: Record<string, number> = {};
    let unknown: string[] = [];
    let total = 0;
    for (const presetId of HOSTED_PRESETS_18) {
      const models = modelsOf(presetId);
      counts[presetId] = models.length;
      for (const model of models) {
        const adjustment = resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "off", stream: STREAM });
        if (adjustment.source !== "upstream") unknown.push(`${presetId}/${model}:${adjustment.source}`);
        total += 1;
      }
    }
    expect(unknown).toEqual([]);
    expect(counts).toEqual({ openrouter: 243, amd: 5, sensenova: 5, opencodego: 29 });
    expect(total).toBe(282);
  });

  it("上游词表更窄的行：档位被静默改写（amd/Qwen3.8-27B 的 high → medium）", () => {
    // 值集 low-medium：18 号票前 override 凭空多发 high（平台声明），删掉后 high 发不出去。
    const adjustment = resolveThinkingAdjustment({ presetId: "amd", model: "Qwen3.8-27B", level: "high", stream: true });
    expect(adjustment.availableLevels).toEqual(["low", "medium"]);
    expect(adjustment.effectiveLevel).toBe("medium");
    expect(adjustment.reason).toBe("model-vocabulary");
    expect(resolveThinkingProfile({ presetId: "amd", model: "Qwen3.8-27B", level: "high", stream: true }).fields).toEqual({
      reasoning_effort: "medium"
    });
  });

  it("上游词表更窄的行：chip 就是上游那两档，low 偏好被裁到 high（sensenova/glm-5.2）", () => {
    // 口径提醒：low 档**不是 18 号票删掉的**——06 号票的 A'= 上游 ∩ 平台声明 已经把它裁了。
    // 本例钉的是删后的稳态，不是「消失」事件。
    // （原另一例 opencodego/deepseek-v4-pro 已被 19 号票的值集覆盖表改写：low 拿回，
    //  另由下面的 19 号票用例承载。）
    expect(levelsOf("sensenova", "glm-5.2")).toEqual(["high", "max"]);
    expect(resolveThinkingProfile({ presetId: "sensenova", model: "glm-5.2", level: "low", stream: true }).fields).toEqual({
      reasoning_effort: "high"
    });
  });

  it("19 号票：值集覆盖 / canonical 重定向后的三行逐档钉住", () => {
    // opencodego/deepseek-v4-pro：覆盖表借 deepseek/deepseek-v4-pro 的 toggle+[low,high,max]
    //   → opencodego 未登记开关形状，toggle 不产 off 写点，chip = [low, high, max]。
    expect(levelsOf("opencodego", "deepseek-v4-pro")).toEqual(["low", "high", "max"]);
    // sensenova/deepseek-v4-pro：-0813 重定向拿回 low（off 仍关不掉 → 级联 low）。
    expect(levelsOf("sensenova", "deepseek-v4-pro")).toEqual(["low", "high", "max"]);
    expect(resolveThinkingProfile({ presetId: "sensenova", model: "deepseek-v4-pro", level: "off", stream: true })).toEqual({
      fields: { reasoning_effort: "low" },
      offUnavailable: true,
      offFallback: "low",
      thinkingClass: "always"
    });
    // amd/DeepSeek-V4-Flash：7 档收窄到 3 档，minimal/medium/xhigh 消失、off 关不掉。
    expect(levelsOf("amd", "DeepSeek-V4-Flash")).toEqual(["low", "high", "max"]);
    expect(resolveThinkingProfile({ presetId: "amd", model: "DeepSeek-V4-Flash", level: "minimal", stream: true }).fields).toEqual({
      reasoning_effort: "low"
    });
  });

  it("13 号票刚对齐的行逐字节不变（opencodego/kimi-k3 哨兵，7 档全钉）", () => {
    const expected = [
      { reasoning_effort: "low" },
      { reasoning_effort: "low" },
      { reasoning_effort: "low" },
      { reasoning_effort: "low" },
      { reasoning_effort: "high" },
      { reasoning_effort: "high" },
      { reasoning_effort: "max" }
    ];
    for (const [index, level] of ALL_LEVELS.entries()) {
      expect(
        resolveThinkingProfile({ presetId: "opencodego", model: "kimi-k3", level, stream: true }).fields,
        level
      ).toEqual(expected[index]);
    }
  });

  it("off 级联：票面「上游词表含 off」的口径 180 行（153/3/4/20），逐平台钉数", () => {
    // 票面 §实测把这个数百字面记作 off 级联受影响行数：这四家 override 里都显式声明了
    // off 写点（opencodego 除外），故「上游值集含 off」的行就是删声明后会失去/保留关闭
    // 落点的行。逐平台 152 / 3 / 3 / 17 = 175；19 号票后 opencodego 两行拿到 toggle
    // （deepseek-v4-flash 走 -0731 重定向、deepseek-v4-pro 走值集覆盖）→ 17 + 2 = 19 = 177。
    // D1=A2 后 zhipuai/glm-5.2 补上 toggle，canonical 继承到 openrouter（+1）、sensenova
    // （+1）、opencode-go（+1）三行 → 177 + 3 = 180（152→153 / 3 / 3→4 / 19→20）。
    const hasOff = (presetId: string): number =>
      modelsOf(presetId).filter((model) => {
        const fact = lookupThinkingFact(UPSTREAM_PROVIDER_BY_PRESET[presetId], model);
        return Boolean(fact) && upstreamVocabularyOf(fact!).includes("off");
      }).length;
    expect({
      openrouter: hasOff("openrouter"),
      amd: hasOff("amd"),
      sensenova: hasOff("sensenova"),
      opencodego: hasOff("opencodego")
    }).toEqual({ openrouter: 153, amd: 3, sensenova: 4, opencodego: 20 });
    expect(hasOff("openrouter") + hasOff("amd") + hasOff("sensenova") + hasOff("opencodego")).toBe(180);
  });

  it("off 级联：按「thinkingClass=always + offUnavailable」口径是 236 行（与口径 A 的 177 差异见 18-report）", () => {
    const cascade = (presetId: string): string[] =>
      modelsOf(presetId).filter((model) => {
        const adjustment = resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "off", stream: true });
        return adjustment.resolution.thinkingClass === "always" && adjustment.resolution.offUnavailable;
      });
    const counts = {
      openrouter: cascade("openrouter").length,
      // amd 4 → 5：19 号票后 DeepSeek-V4-Flash 收窄到 toggle+[low,high,max]，amd 未登记开关
      // 形状 → off 关不掉（此前它靠 effort none 关得上，是这五行里唯一新增的）。
      amd: cascade("amd").length,
      sensenova: cascade("sensenova").length,
      opencodego: cascade("opencodego").length
    };
    expect(counts).toEqual({ openrouter: 202, amd: 5, sensenova: 4, opencodego: 25 });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(236);
    // 级联目标 = 可用集里最小的非 off 档：glm-5.2（A={high,max}）偏好 off → high。
    const glm = resolveThinkingAdjustment({ presetId: "sensenova", model: "glm-5.2", level: "off", stream: true });
    expect(glm.effectiveLevel).toBe("high");
    expect(glm.resolution.offFallback).toBe("low");
  });

  it("零档行（budget-only）fail-closed：不发任何思考字段，且不被 clamp 造出档位", () => {
    for (const model of ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"]) {
      for (const level of ALL_LEVELS) {
        const adjustment = resolveThinkingAdjustment({ presetId: "openrouter", baseUrl: baseUrlOf("openrouter"), model, level, stream: true });
        expect(adjustment.availableLevels, `${model} · ${level}`).toEqual([]);
        expect(adjustment.resolution.fields, `${model} · ${level}`).toEqual({});
      }
    }
  });

  it("UPSTREAM_TOGGLE_SHAPES 仍只登记 6 家（删 override 不顺手加四家）", () => {
    expect(Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()).toEqual(["deepseek", "mimo", "modelscope", "moonshot", "qwen", "zhipu"]);
    for (const presetId of HOSTED_PRESETS_18) {
      expect(presetId in UPSTREAM_TOGGLE_SHAPES, presetId).toBe(false);
    }
  });

  it("minimax hand-wins 逐字节不变（与 override 无关的负事实）", () => {
    expect(lookupThinkingFact("minimax-cn", "MiniMax-M3")?.valuesetId).toBe("toggle");
    const expectedOff = JSON.stringify({ fields: {}, offUnavailable: true, offFallback: null, thinkingClass: "always" });
    const expectedOn = JSON.stringify({ fields: {}, offUnavailable: false, offFallback: null, thinkingClass: "always" });
    for (const level of ALL_LEVELS) {
      expect(resolveViaRuntime("minimax", "MiniMax-M3", level), level).toBe(level === "off" ? expectedOff : expectedOn);
    }
  });

  it("18 号票新增分歧：四家「手写侧有具体 class」的 25 行（逐条钉；含 AMD 的 5 行 400 风险面）", () => {
    const divergent = divergentKeys(LEVELS, { presets: HOSTED_PRESETS_18, handOnly: true });
    expect(divergent.sort()).toEqual([
      "amd/deepseek-v4-flash",
      "amd/deepseek-v4-flash-vision-exp",
      "amd/deepseek-v4.1-flash",
      "amd/qwen3.8-27b",
      "amd/qwen3.8-flash-next",
      "opencode-go/deepseek-v4-flash",
      "opencode-go/deepseek-v4-flash-vision-exp",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/glm-5.2",
      "opencode-go/glm-5.3",
      "opencode-go/glm-5.3-flash",
      "opencode-go/gpt-5.6-luna",
      "opencode-go/gpt-6-luna",
      "opencode-go/kimi-k2.6",
      "opencode-go/mimo-v2.6-flash",
      "opencode-go/mimo-v2.6-pro",
      "opencode-go/qwen3.6-plus",
      "opencode-go/qwen3.7-max",
      "opencode-go/qwen3.7-plus",
      "opencode-go/qwen3.8-flash",
      "opencode-go/qwen3.8-max",
      "sensenova/deepseek-v4-flash",
      "sensenova/deepseek-v4-pro",
      "sensenova/glm-5.2"
    ]);
    // 7 档口径原本再多两行（canonical 词表带 max，手写 kimi-k3-effort 没有 max 写点）。
    // 19 号票删掉 kimi-k3* 专条后，opencode-go / sensenova 的 kimi-k3 手写侧已无结论，
    // `handOnly` 口径直接跳过 → 7 档不再比 3 档多出任何行。**运行时两行逐档不变**
    // （都是指派表命中，值集 low-high-max，手写侧本就不参与；见
    // 「13 号票刚对齐的行逐字节不变（opencodego/kimi-k3 哨兵，7 档全钉）」用例）。
    const divergent7 = divergentKeys(ALL_LEVELS, { presets: HOSTED_PRESETS_18, handOnly: true });
    expect(divergent7.filter((key) => !divergent.includes(key)).sort()).toEqual([]);
  });
});

// ===== D1=A2：本仓补声明（2026-10-05 用户裁定；交接单 handoff-glm52-toggle §4）=====
// 失败方式（每条一个用例）：
//   1. 少开 off：zhipu / qwen 的 glm-5.2 没拿到 off 写点（补声明没生效 / 平台形状没接上）；
//   2. 误开 off：未登记开关形状的三家（openrouter / sensenova / opencodego）冒出 Off；
//   3. 补声明越界：家族里别的行被一起改（用「家族 N 行也有 toggle」当依据的后果）；
//   4. 同一模型两条路径不一致：目录内 glm-5.2 与目录外 glm-5.2-air 的 off 出口不同；
//   5. 值集孤儿：high-max 没被自然淘汰 / toggle+high-max 没登记。
describe("D1=A2：本仓补声明（zhipuai/glm-5.2 补 off 能力）", () => {
  const levelsOf = (presetId: string, model: string): readonly ThinkingLevel[] =>
    resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "high", stream: STREAM }).availableLevels;

  // 事实 5 行（canonical 全部指向 zhipuai/glm-5.2）+ 行为 2 行的平台。
  const FIVE_ROWS: ReadonlyArray<[provider: string, model: string]> = [
    ["zhipuai", "glm-5.2"],
    ["alibaba-cn", "glm-5.2"],
    ["opencode-go", "glm-5.2"],
    ["openrouter", "z-ai/glm-5.2"],
    ["sensenova", "glm-5.2"]
  ];
  const THREE_UNREGISTERED: ReadonlyArray<[preset: string, provider: string, model: string]> = [
    ["openrouter", "openrouter", "z-ai/glm-5.2"],
    ["sensenova", "sensenova", "glm-5.2"],
    ["opencodego", "opencode-go", "glm-5.2"]
  ];

  it("事实层：5 行都是 toggle+high-max（effort 不变），且只改了这 5 行", () => {
    const changed: string[] = [];
    for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
      for (const [modelId, valuesetId] of Object.entries(table)) {
        if (valuesetId === "toggle+high-max") changed.push(`${upstreamId}/${modelId}`);
      }
    }
    expect(changed.sort()).toEqual(FIVE_ROWS.map(([provider, model]) => `${provider}/${model}`).sort());
    for (const [provider, model] of FIVE_ROWS) {
      const fact = lookupThinkingFact(provider, model);
      expect(fact?.valuesetId, `${provider}/${model}`).toBe("toggle+high-max");
      expect(fact?.toggle, `${provider}/${model}`).toBe(true);
      expect(fact?.off, `${provider}/${model}`).toBe("toggle");
      // 补声明只补 off 能力，不动档位词表（上游 effort[high,max] 原样）。
      expect(fact?.effort, `${provider}/${model}`).toEqual(["high", "max"]);
    }
    // 值集表：high-max 的 5 个用户全迁走后自然消失（不靠孤儿剪枝），toggle+high-max 补位。
    expect(VALUESETS["high-max"]).toBeUndefined();
    expect(VALUESETS["toggle+high-max"]?.effort).toEqual(["high", "max"]);
  });

  it("少开 off：zhipu（thinking.type）与 qwen（enable_thinking）都真拿到 off 写点", () => {
    expect(levelsOf("zhipu", "glm-5.2")).toEqual(["off", "high", "max"]);
    expect(levelsOf("qwen", "glm-5.2")).toEqual(["off", "high", "max"]);
    expect(resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: STREAM })).toEqual({
      fields: { thinking: { type: "disabled" } },
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "hybrid"
    });
    expect(resolveThinkingProfile({ presetId: "qwen", model: "glm-5.2", level: "off", stream: STREAM })).toEqual({
      fields: { enable_thinking: false },
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "hybrid"
    });
  });

  it("误开 off：三家未登记开关形状的行 A' 不变（{high,max}）、off 仍级联 high", () => {
    expect(
      Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()
    ).toEqual(["deepseek", "mimo", "modelscope", "moonshot", "qwen", "zhipu"]);
    for (const [presetId, provider, model] of THREE_UNREGISTERED) {
      expect(presetId in UPSTREAM_TOGGLE_SHAPES, presetId).toBe(false);
      // 模型侧事实有 toggle，但平台形状没登记 → 一个 off 写点都不产（D3）。
      const fact = lookupThinkingFact(provider, model);
      expect(fact?.off, `${provider}/${model}`).toBe("toggle");
      expect(ruleFromUpstreamFact(fact!, presetId).off, `${provider}/${model}`).toBeUndefined();
      expect(levelsOf(presetId, model), `${presetId}/${model}`).toEqual(["high", "max"]);
      // 逐字节与补声明前相同：off 级联 high、offUnavailable 仍 true（D1=A2 的 before/after
      // 工件 02-before-after.tsv 里这三行两侧同值）。
      expect(resolveThinkingProfile({ presetId, model, level: "off", stream: STREAM }), `${presetId}/${model}`).toEqual({
        fields: { reasoning_effort: "high" },
        offUnavailable: true,
        offFallback: "low",
        thinkingClass: "always"
      });
    }
  });

  it("同一模型两条路径：目录内 zhipu/glm-5.2 与目录外 zhipu/glm-5.2-air 的 off 出口同为 thinking:{type:\"disabled\"}", () => {
    // 档位词表本来就不同（兜底类 glm-hybrid-effort 只有 low/high，属历史遗留，本票不动档位），
    // 本用例只钉「本仓第一次能力补声明消掉了那个自相矛盾」：两条路径关思考的出口必须一致。
    expect(lookupThinkingFact("zhipuai", "glm-5.2-air"), "glm-5.2-air 不该在指派表里").toBeNull();
    const inCatalog = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: STREAM });
    const outOfCatalog = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2-air", level: "off", stream: STREAM });
    expect(inCatalog.fields).toEqual({ thinking: { type: "disabled" } });
    expect(outOfCatalog.fields).toEqual({ thinking: { type: "disabled" } });
    expect(outOfCatalog).toEqual(inCatalog);
    // 两条路径的档位词表确实不同（钉住「本次没顺手改兜底档位」）。
    expect(levelsOf("zhipu", "glm-5.2")).toEqual(["off", "high", "max"]);
    expect(levelsOf("zhipu", "glm-5.2-air")).toEqual(["off", "low", "high"]);
  });
});
