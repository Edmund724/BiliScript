// tests/ai/thinking-upstream-facts.test.ts
// 票据 04（upstream-model-facts/04）+ 12（残留清单裁决落地）：有上游平台的模型结论改由
// 02 号票的指派表驱动，手写表退为「产品语义 + 上游未覆盖兜底」。
//
// 交互方式（12 号票，用户 2026-10-04 裁决「冻结的都按上游，复审以后发现以前的确实都是
// 错的」）：override 短路 → 02 指派表命中 + 档位投影 → 手写表（EXCEPTIONS >> TAXONOMY
// >> unknownClass）→ UNKNOWN 哨兵。04 号票的行为冻结表 PENDING_DIVERGENCES（31 行）连同
// 其查表 / 校验 / 导出一并删除；31 行逐行按上游（对照表 artifacts/12-adjudication-log.md，
// 矩阵逐字节证据 artifacts/12-adjudication-matrix.diff.txt）。点名翻转的三处原手写专条
// **留在原表但已降级**：它们只服务「指派表不认识的 id」（用户自填 / 上游新变体）。真删会让
// 这些无界 id 的请求体跟着变，是尚未裁决的开放问题（12 号票非目标）。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 三处翻转没翻到 / 翻错方向：指派表被手写专条抢答（或反过来翻多了）；
//   2. 降级兜底其实是删掉的：指派表不认识的 id 不再逐字节沿用旧手写结论；
//   3. 三档投影规则漂移：off 关不掉时臆造参数、none 被当档位、low/high 取错词、
//      budget-only 的模型被塞参数；
//   4. 平台方言丢失：值集 toggle 落到没登记开关形状的平台上被发明出字段；
//   5. **静默的第二事实源**（本票核心风险）：某非 override 行既有上游事实、手写侧也有
//      结论，两者不同却没进残留清单的 31 行 → 请求体被悄悄改了，没人知道；
//   6. 裁决不彻底：清单里某一行的旧手写结论仍能抢答（残留冻结语义）；
//   7. 目录外 id 被波及：B1 三条专条被删或降级链断掉；
//   8. override 平台被上游/手写抢走（识别层短路必须最先）。

import { describe, expect, it } from "vitest";
import { ASSIGNMENTS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  EXCEPTIONS,
  PROVIDERS,
  TAXONOMY,
  UPSTREAM_PROVIDER_BY_PRESET,
  applyClassRule,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
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

// override 型平台（03 §6）：平台级产品裁定，识别层短路，不逐格比上游。
const OVERRIDE_PRESETS = new Set(["openrouter", "amd", "sensenova", "opencodego"]);

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
const DOWNGRADED_HAND_ENTRIES: Array<{ upstreamId: string; presetId: string; pattern: string; className: string }> = [
  { upstreamId: "zhipuai", presetId: "zhipu", pattern: "glm-5.2", className: "glm-hybrid-effort" },
  { upstreamId: "zhipuai", presetId: "zhipu", pattern: "glm-5.3", className: "glm-always" },
  { upstreamId: "kimi-code-plan-cn", presetId: "moonshot", pattern: "kimi-k3", className: "kimi-k3-effort" }
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

// 非 override 指派行的「上游投影 vs 手写结论」分歧键集（指定档位口径下计算）。
function divergentKeys(levels: readonly ThinkingLevel[]): string[] {
  const divergent = new Set<string>();
  for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
    const presetId = PRESET_BY_UPSTREAM[upstreamId];
    expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
    if (OVERRIDE_PRESETS.has(presetId)) continue;
    for (const modelId of Object.keys(table)) {
      const fact = lookupThinkingFact(upstreamId, modelId);
      expect(fact, `${upstreamId}/${modelId} 有指派却查不到值集`).toBeTruthy();
      const projected = ruleFromUpstreamFact(fact!, presetId);
      const hand = handRuleOf(presetId, modelId);
      if (levels.some((level) => outcomeOf(projected, level) !== outcomeOf(hand, level))) {
        divergent.add(`${upstreamId}/${modelId.toLowerCase()}`);
      }
    }
  }
  return [...divergent];
}

describe("三处翻转（用户裁定 2：只翻 zhipuai/glm-5.2、zhipuai/glm-5.3、kimi-code-plan-cn/k3）", () => {
  it("zhipuai/glm-5.2：上游 high-max → off 关不掉、级联落最小档 high；low 折 high", () => {
    for (const level of LEVELS) {
      expect(resolveViaRuntime("zhipu", "glm-5.2", level)).toBe(
        JSON.stringify({
          fields: { reasoning_effort: "high" },
          offUnavailable: level === "off",
          offFallback: level === "off" ? "low" : null,
          thinkingClass: "always"
        })
      );
    }
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

  it("kimi-code-plan-cn/k3：上游 toggle+low-high-max → off 可用（走 Kimi 的 thinking 开关）", () => {
    expect(resolveViaRuntime("moonshot", "kimi-k3", "off")).toBe(
      JSON.stringify({ fields: { thinking: { type: "disabled" } }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    // 上游 id 写法（k3）与别名写法（kimi-k3）同源同结论。
    expect(resolveViaRuntime("moonshot", "k3", "off")).toBe(resolveViaRuntime("moonshot", "kimi-k3", "off"));
    expect(resolveViaRuntime("moonshot", "k3", "high")).toBe(resolveViaRuntime("moonshot", "kimi-k3", "high"));
  });

  it("三处照翻，尽管手写专条还在且结论相反（12 号票后专条只兜指派表不认识的 id）", () => {
    // 手写专条仍在（B1 降级而非删除）……
    for (const entry of DOWNGRADED_HAND_ENTRIES) {
      const table = entry.className === "glm-hybrid-effort" ? TAXONOMY : EXCEPTIONS;
      expect(table.some((row) => row.class === entry.className && row.patterns.includes(entry.pattern)), `${entry.pattern} 专条应在表里`).toBe(true);
      expect(handClassOf(entry.presetId, entry.pattern)).toBe(entry.className);
    }
    expect(CLASSES["kimi-k3-effort"]).toBeTruthy();
    // 但原生模型照上游翻转（上三个用例），即手写专条对「指派表命中的模型」不再参与。
    expect(handRuleOf("zhipu", "glm-5.2")).toBe(CLASSES["glm-hybrid-effort"]);
    expect(resolveViaRuntime("zhipu", "glm-5.2", "low")).not.toBe(outcomeOf(CLASSES["glm-hybrid-effort"], "low"));
  });
});

describe("降级兜底（B1）：指派表不认识的 id 逐字节沿用旧手写结论", () => {
  // 这些 id 不在 02 指派表里（用户自填 / 上游新变体）：
  // 它们必须仍然走手写专条 —— 真删专条就会改变它们的请求体（12 号票非目标）。
  const CASES: Array<[string, string]> = [
    ["zhipu", "glm-5.2-air"],
    ["qwen", "glm-5.3-air"],
    ["moonshot", "kimi-k3-air"],
    ["ollama", "glm-5.2"],
    ["ollama", "kimi-k3"]
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
    ["openai", "https://api.openai.com/v1", "kimi-k3"],
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

  it("kimi-k3-air 落 kimi-k3-effort（永远思考 + effort），不是 fail-closed 空参", () => {
    expect(outcomeOf(handRuleOf("moonshot", "kimi-k3-air"), "high")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "high" }, offUnavailable: false, offFallback: null, thinkingClass: "always" })
    );
    expect(outcomeOf(handRuleOf("moonshot", "kimi-k3-air"), "off")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "low" }, offUnavailable: true, offFallback: "low", thinkingClass: "always" })
    );
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
    //   + 05 号票 clamp 的有意分歧 qwen3.8-max（词表 low/medium/xhigh，偏好 high 落 medium）。
    const expected = [
      ...ADJUDICATED.map((row) => row.key).filter((key) => !NON_DIVERGENT.includes(key) && !MODELSCOPE_UPSTREAM_ID_ROWS.includes(key)),
      ...FLIPPED,
      "alibaba-cn/qwen3.8-max"
    ].sort();
    expect([...divergent].sort()).toEqual(expected);
  });

  it("7 档口径下多出的 5 行：旧手写 class 缺 05 号票新增档位写点（清单外的「分歧」与新档位无关）", () => {
    // 05 号票把词表扩到 7 档后，下面 5 行的上游值集带 max 档而旧手写 class 没有 max 写点
    // （偏好 max 在手写侧被 clamp 到 high）——它们从未进过 04 冻结表（04 口径只比 off/low/high），
    // 也不构成「静默第二事实源」：命中指派表的行一律走上游投影（见下一个 describe）。
    const EXTRA_TIERS: Record<string, string> = {
      "alibaba-cn/kimi-k3": "上游 low-high-max；手写 kimi-k3-effort 无 max 写点",
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
  it("02 指派表逐条 × 7 档：非 override 行 runtime === 上游投影", () => {
    let compared = 0;
    let total = 0;
    for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
      const presetId = PRESET_BY_UPSTREAM[upstreamId];
      expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
      for (const modelId of Object.keys(table)) {
        const fact = lookupThinkingFact(upstreamId, modelId);
        expect(fact, `${upstreamId}/${modelId} 有指派却查不到值集`).toBeTruthy();
        total += 1;
        if (OVERRIDE_PRESETS.has(presetId)) continue;
        compared += 1;
        const projected = ruleFromUpstreamFact(fact!, presetId);
        for (const level of ALL_LEVELS) {
          expect(resolveViaRuntime(presetId, modelId, level), `${upstreamId}/${modelId} · ${level}`).toBe(outcomeOf(projected, level));
        }
      }
    }
    // 口径自检：指派表规模没被误读（02 产物 359 条指派；override 平台 4 家不走上游投影）。
    expect(total).toBeGreaterThanOrEqual(359);
    expect(compared).toBeGreaterThan(0);
    expect(compared).toBeLessThan(total);
  });

  it("override 平台：可用集 = 上游词表 ∩ 平台声明（06 号票裁定），写点形状仍只由平台决定", () => {
    for (const presetId of OVERRIDE_PRESETS) {
      // 有上游事实的模型（glm-5.2 上游是 high-max）在 override 平台不再整域放宽：
      // A' = 平台声明 ∩ 上游词表；off 关不掉（关闭落点仍是平台的 effort 词汇）。
      const off = JSON.stringify(resolveThinkingProfile({ presetId, model: "glm-5.2", level: "off", stream: STREAM }));
      const high = JSON.stringify(resolveThinkingProfile({ presetId, model: "glm-5.2", level: "high", stream: STREAM }));
      expect(off, presetId).not.toBe(high);
      expect(off, presetId).toContain("reasoning_effort");
    }
    // 裁定点名的边界格：opencodego/hy4-preview（上游 none-high，平台无 off 写点）
    // → A' = {high}，偏好 off/low 都落 high（平台表达不了 off）。
    for (const level of ["off", "low", "high"] as const) {
      expect(
        JSON.stringify(resolveThinkingProfile({ presetId: "opencodego", model: "hy4-preview", level, stream: STREAM })),
        level
      ).toContain('"reasoning_effort":"high"');
    }
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
    // 裁决行同样按上游：托管 alibaba-cn/glm-5.2 与原生 zhipuai/glm-5.2 同值集（high-max）。
    expect(handClassOf("qwen", "glm-5.2")).toBe("glm-hybrid-effort");
    expect(resolveViaRuntime("qwen", "glm-5.2", "off")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "high" }, offUnavailable: true, offFallback: "low", thinkingClass: "always" })
    );
    expect(resolveViaRuntime("qwen", "glm-5.2", "off")).toBe(resolveViaRuntime("zhipu", "glm-5.2", "off"));
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
