import { describe, expect, it } from "vitest";
import { ASSIGNMENTS, MODEL_ID_ALIASES, VALUESETS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  EXCEPTIONS,
  NO_FIELDS,
  PROVIDERS,
  TAXONOMY,
  UNKNOWN_VOCABULARY,
  UPSTREAM_PROVIDER_BY_PRESET,
  UPSTREAM_TOGGLE_SHAPES,
  applyClassRule,
  enableThinking,
  providerRuleFor,
  reasoningEffort,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
  thinkingType,
  upstreamVocabularyOf,
  validateThinkingTables,
  type ClassRule,
  type ThinkingLevel
} from "../../extension/ai/thinking-profiles.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";
import { PRESETS } from "../../extension/core/presets.js";

const LEVELS: readonly ThinkingLevel[] = ["off", "low", "high"];
const ALL_LEVELS = AI_THINKING_LEVELS;
const STREAM = false;

const PRESET_BY_UPSTREAM: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(UPSTREAM_PROVIDER_BY_PRESET).map(([presetId, upstreamId]) => [upstreamId, presetId])
);

const HOSTED_PRESETS_18 = new Set(["openrouter", "amd", "sensenova", "opencodego"]);

function baseUrlOf(presetId: string): string {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`PRESETS 未登记预设：${presetId}`);
  return preset.baseUrl;
}

function handClassOf(presetId: string, model: string): string | undefined {
  const normalized = model.trim().toLowerCase();
  const slash = normalized.lastIndexOf("/");
  const bare = slash >= 0 && slash < normalized.length - 1 ? normalized.slice(slash + 1) : normalized;
  const matches = (pattern: string, subject: string) =>
    pattern.includes("*")
      ? new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`).test(subject)
      : subject.startsWith(pattern);
  for (const entry of EXCEPTIONS) {
    if (entry.patterns.some((pattern) => matches(pattern, normalized))) return entry.class;
  }
  for (const subject of [normalized, bare]) {
    for (const entry of TAXONOMY) {
      if (entry.patterns.some((pattern) => matches(pattern, subject))) return entry.class;
    }
  }
  return providerRuleFor(presetId)?.unknownClass;
}

function handRuleOf(presetId: string, model: string): ClassRule | undefined {
  const className = handClassOf(presetId, model);
  return className ? CLASSES[className] : undefined;
}

function patchShape(resolution: object): string {
  const { requestedLevel, ...patch } = resolution as Record<string, unknown>;
  void requestedLevel;
  return JSON.stringify(patch);
}

function outcomeOf(rule: ClassRule | undefined, level: ThinkingLevel): string {
  if (!rule) {
    return patchShape({
      vocabulary: UNKNOWN_VOCABULARY,
      effectiveLevel: null,
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "unknown"
    });
  }
  return patchShape(applyClassRule(rule, level, STREAM));
}

function resolveViaRuntime(presetId: string, model: string, level: ThinkingLevel): string {
  return patchShape(resolveThinkingProfile({ presetId, baseUrl: baseUrlOf(presetId), model, level, stream: STREAM }));
}

const FLIPPED = ["zhipuai/glm-5.2", "zhipuai/glm-5.3", "kimi-code-plan-cn/k3"];

const DOWNGRADED_HAND_ENTRIES: Array<{ upstreamId: string; presetId: string; pattern: string; className: string }> = [
  { upstreamId: "zhipuai", presetId: "zhipu", pattern: "glm-5.2", className: "glm-hybrid-effort" },
  { upstreamId: "zhipuai", presetId: "zhipu", pattern: "glm-5.3", className: "glm-always" }
];

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

const MODELSCOPE_UPSTREAM_ID_ROWS = ["modelscope/glm-4.5", "modelscope/glm-4.6"];

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
    } else if (HOSTED_PRESETS_18.has(presetId) || presetId === "gemini") {
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
    for (const level of ["off", "minimal", "low", "medium"] as const) {
      expect(resolveViaRuntime("zhipu", "glm-5.2", level), level).toBe(
        JSON.stringify({
          vocabulary: thinkingType("disabled"),
          effectiveLevel: "off",
          offUnavailable: false,
          offFallback: null,
          thinkingClass: "hybrid"
        })
      );
    }
    expect(resolveViaRuntime("zhipu", "glm-5.2", "high")).toBe(
      JSON.stringify({ vocabulary: reasoningEffort("high"), effectiveLevel: "high", offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    expect(resolveViaRuntime("zhipu", "glm-5.2", "max")).toBe(
      JSON.stringify({ vocabulary: reasoningEffort("max"), effectiveLevel: "max", offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
  });

  it("zhipuai/glm-5.3：上游 low-high-max → 有档位；off 关不掉、级联落 low", () => {
    expect(resolveViaRuntime("zhipu", "glm-5.3", "high")).toBe(
      JSON.stringify({ vocabulary: reasoningEffort("high"), effectiveLevel: "high", offUnavailable: false, offFallback: null, thinkingClass: "always" })
    );
    for (const level of ["off", "low"] as const) {
      expect(resolveViaRuntime("zhipu", "glm-5.3", level)).toBe(
        JSON.stringify({
          vocabulary: reasoningEffort("low"),
          effectiveLevel: "low",
          offUnavailable: level === "off",
          offFallback: level === "off" ? "low" : null,
          thinkingClass: "always"
        })
      );
    }
  });

  it("kimi-code-plan-cn/k3：13 号票 canonical 优先 → 词表 low-high-max（off 关不掉、级联落 low）", () => {
    expect(resolveViaRuntime("moonshot", "kimi-k3", "off")).toBe(
      JSON.stringify({ vocabulary: reasoningEffort("low"), effectiveLevel: "low", offUnavailable: true, offFallback: "low", thinkingClass: "always" })
    );
    expect(resolveViaRuntime("moonshot", "kimi-k3", "high")).toBe(
      JSON.stringify({ vocabulary: reasoningEffort("high"), effectiveLevel: "high", offUnavailable: false, offFallback: null, thinkingClass: "always" })
    );
    expect(resolveViaRuntime("moonshot", "k3", "off")).toBe(resolveViaRuntime("moonshot", "kimi-k3", "off"));
    expect(resolveViaRuntime("moonshot", "k3", "high")).toBe(resolveViaRuntime("moonshot", "kimi-k3", "high"));
  });

  it("两条照翻，尽管手写专条还在且结论相反（12 号票后专条只兜指派表不认识的 id）", () => {
    for (const entry of DOWNGRADED_HAND_ENTRIES) {
      const table = entry.className === "glm-hybrid-effort" ? TAXONOMY : EXCEPTIONS;
      expect(table.some((row) => row.class === entry.className && row.patterns.includes(entry.pattern)), `${entry.pattern} 专条应在表里`).toBe(true);
      expect(handClassOf(entry.presetId, entry.pattern)).toBe(entry.className);
    }
    expect(handRuleOf("zhipu", "glm-5.2")).toBe(CLASSES["glm-hybrid-effort"]);
    expect(resolveViaRuntime("zhipu", "glm-5.2", "low")).not.toBe(outcomeOf(CLASSES["glm-hybrid-effort"], "low"));
  });
});

describe("降级兜底（B1）：指派表不认识的 id 逐字节沿用旧手写结论", () => {
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

  const HOST_CASES: Array<[string, string, string]> = [
    ["siliconflow", "https://api.siliconflow.cn/v1", "glm-5.2"],
    ["siliconflow", "https://api.siliconflow.cn/v1", "glm-5.3-air"]
  ];

  for (const [providerId, baseUrl, model] of HOST_CASES) {
    it(`host 推断 ${providerId} + ${model}：三档 = 手写专条结论`, () => {
      for (const level of LEVELS) {
        const actual = resolveThinkingProfile({ baseUrl, model, level, stream: STREAM });
        expect(patchShape(actual), level).toBe(outcomeOf(handRuleOf(providerId, model), level));
      }
    });
  }

  });

describe("19 号票：删 EXCEPTIONS kimi-k3* 专条（另两条保留）", () => {
  it("专条与随之孤儿化的 class 都不在了", () => {
    expect(EXCEPTIONS.some((row) => row.patterns.includes("kimi-k3"))).toBe(false);
    expect(CLASSES["kimi-k3-effort"]).toBeUndefined();
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
      expect(openaiVocabularyFields(adjustment.resolution.vocabulary), level).toEqual({});
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
      expect(openaiVocabularyFields(actual.resolution.vocabulary), level).toEqual({});
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
      off: { vocabulary: enableThinking(false) },
      on: { vocabulary: enableThinking(true) }
    });
  });

  it("toggle 平台无登记开关形状（stepfun）：不发明形状 → 不发开关", () => {
    expect(ruleFromUpstreamFact(fact("toggle", true, null, "toggle"), "stepfun")).toEqual({ thinkingClass: "always" });
  });

  it("effort 含 none：off 走 effort none；none 不物化成档位", () => {
    expect(ruleFromUpstreamFact(fact("none-high", false, ["none", "high"], "effort-none"), "qwen")).toEqual({
      thinkingClass: "hybrid",
      off: { vocabulary: reasoningEffort("none") },
      high: { vocabulary: reasoningEffort("high") }
    });
  });

  it("high-max（glm-5.2）：词表两档各一格（clamp 决定偏好落在哪档，投影不再折叠）", () => {
    expect(ruleFromUpstreamFact(fact("high-max", false, ["high", "max"], null), "zhipu")).toEqual({
      thinkingClass: "always",
      high: { vocabulary: reasoningEffort("high") },
      max: { vocabulary: reasoningEffort("max") }
    });
  });

  it("low-medium-xhigh（qwen3.8-max）：三个档位逐格物化（偏好 high 由 clamp 向下取到 medium）", () => {
    expect(
      ruleFromUpstreamFact(fact("toggle+low-medium-xhigh+b:0-262144", true, ["low", "medium", "xhigh"], "toggle"), "qwen")
    ).toEqual({
      thinkingClass: "hybrid",
      off: { vocabulary: enableThinking(false) },
      low: { vocabulary: reasoningEffort("low") },
      medium: { vocabulary: reasoningEffort("medium") },
      xhigh: { vocabulary: reasoningEffort("xhigh") }
    });
  });

  it("low-high-max（deepseek-v4-pro）：词表三档各一格", () => {
    expect(ruleFromUpstreamFact(fact("toggle+low-high-max", true, ["low", "high", "max"], "toggle"), "deepseek")).toEqual({
      thinkingClass: "hybrid",
      off: { vocabulary: thinkingType("disabled") },
      low: { vocabulary: reasoningEffort("low") },
      high: { vocabulary: reasoningEffort("high") },
      max: { vocabulary: reasoningEffort("max") }
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

  it("04 口径（off/low/high）下与旧手写结论不同的非 override 指派行，恰好是这 31 行的 29 行 + modelscope 上游写法两行 + 点名三处 + clamp 分歧", () => {
    const divergent = divergentKeys(LEVELS);
    const expected = [
      ...ADJUDICATED.map((row) => row.key).filter((key) => !MODELSCOPE_UPSTREAM_ID_ROWS.includes(key)),
      "modelscope/zhipuai/glm-4.5",
      "modelscope/zhipuai/glm-4.6",
      ...FLIPPED,
      "alibaba-cn/qwen3.8-max",
      "alibaba-cn/kimi-k3",
      "kimi-code-plan-cn/k3.1-pro",
      "kimi-code-plan-cn/k3.1-pro-highspeed",
      "minimax-cn/minimax-m3.1-flash"
    ].sort();
    expect([...divergent].sort()).toEqual(expected);
  });

  it("7 档口径下多出的 4 行：旧手写 class 缺 05 号票新增档位写点（清单外的「分歧」与新档位无关）", () => {
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

  it("曾经的唯一行为不变裁决行 minimax-cn/minimax-m3：2026-10-05 起按登记的平台开关形状（hand-wins 已废）", () => {
    const KEY = "minimax-cn/minimax-m3";
    const row = ADJUDICATED.find((candidate) => candidate.key === KEY)!;
    const projected = ruleFromUpstreamFact(lookupThinkingFact("minimax-cn", row.model)!, row.presetId);
    expect(projected).toEqual({
      thinkingClass: "hybrid",
      off: { vocabulary: thinkingType("disabled") },
      on: { vocabulary: thinkingType("adaptive") }
    });
    for (const level of ALL_LEVELS) {
      expect(resolveViaRuntime(row.presetId, row.model, level), `${KEY} · ${level}`).toBe(outcomeOf(projected, level));
      expect(resolveViaRuntime(row.presetId, row.model, level), `${KEY} · ${level}`).not.toBe(
        outcomeOf(row.oldHand ? CLASSES[row.oldHand] : undefined, level)
      );
    }
  });

  it("modelscope 两行：清单键 = 本仓口径裸 id（矩阵行），该行确实翻转；上游写法剥前缀落 GLM 血统（手写侧分歧，运行期仍按上游）", () => {
    for (const key of MODELSCOPE_UPSTREAM_ID_ROWS) {
      const row = ADJUDICATED.find((candidate) => candidate.key === key)!;
      expect(handClassOf(row.presetId, row.model)).toBe(row.oldHand);
      const bare = outcomeOf(CLASSES[row.oldHand!], "off");
      expect(resolveViaRuntime(row.presetId, row.model, "off")).not.toBe(bare);
      expect(resolveViaRuntime(row.presetId, row.model, "off")).toBe(
        JSON.stringify({
          vocabulary: enableThinking(false),
          effectiveLevel: "off",
          offUnavailable: false,
          offFallback: null,
          thinkingClass: "hybrid"
        })
      );
      const upstreamIdModel = `ZhipuAI/${row.model}`;
      const projected = ruleFromUpstreamFact(lookupThinkingFact(row.presetId, upstreamIdModel)!, row.presetId);
      expect(handClassOf(row.presetId, upstreamIdModel)).toBe("glm-hybrid-switch");
      expect(outcomeOf(handRuleOf(row.presetId, upstreamIdModel), "off")).not.toBe(outcomeOf(projected, "off"));
      for (const level of ALL_LEVELS) {
        expect(resolveViaRuntime(row.presetId, upstreamIdModel, level), `${key} · ${level}`).toBe(outcomeOf(projected, level));
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
    expect(total).toBeGreaterThanOrEqual(359);
  });

  it("18 号票：四家托管平台的目录内模型也逐格按上游词表（不再是平台声明口径）", () => {
    for (const presetId of HOSTED_PRESETS_18) {
      const upstreamId = UPSTREAM_PROVIDER_BY_PRESET[presetId];
      for (const modelId of Object.keys(ASSIGNMENTS[upstreamId] ?? {})) {
        expect(
          resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model: modelId, level: "high", stream: STREAM }).source,
          `${presetId}/${modelId}`
        ).toBe("upstream");
      }
    }
    const low = resolveThinkingProfile({ presetId: "opencodego", model: "hy4-preview", level: "low", stream: STREAM });
    expect(openaiVocabularyFields(low.vocabulary)).toEqual({ reasoning_effort: "none" });
    expect(openaiVocabularyFields(resolveThinkingProfile({ presetId: "opencodego", model: "hy4-preview", level: "high", stream: STREAM }).vocabulary)).toEqual({
      reasoning_effort: "high"
    });
  });

  it("上游未覆盖的兜底职责仍在：用户自填 id 走手写表，有事实的模型由指派表决定", () => {
    expect(resolveViaRuntime("qwen", "qwen3.5-my-finetune", "high")).toBe(
      JSON.stringify({ vocabulary: enableThinking(true), effectiveLevel: "high", offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    expect(handClassOf("qwen", "qwen3.8-max")).toBe("qwen-hybrid-effort");
    expect(resolveViaRuntime("qwen", "qwen3.8-max", "high")).toBe(
      JSON.stringify({ vocabulary: reasoningEffort("medium"), effectiveLevel: "medium", offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    expect(resolveViaRuntime("qwen", "qwen3.8-max", "high")).toBe(
      outcomeOf(ruleFromUpstreamFact(lookupThinkingFact("alibaba-cn", "qwen3.8-max")!, "qwen"), "high")
    );
    expect(handClassOf("qwen", "glm-5.2")).toBe("glm-hybrid-effort");
    expect(resolveViaRuntime("qwen", "glm-5.2", "off")).toBe(
      JSON.stringify({ vocabulary: enableThinking(false), effectiveLevel: "off", offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
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
        expect(patchShape(actual), `${model} · ${level}`).toBe(expected);
      }
    }
  });
});

describe("13 号票：canonical 优先 + 重定向表（2026-10-05 用户裁定）", () => {
  const adjustmentOf = (presetId: string, model: string, level = "high") =>
    resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level, stream: STREAM });
  const levelsOf = (presetId: string, model: string): readonly ThinkingLevel[] => adjustmentOf(presetId, model).availableLevels;

  it("canonical 优先：direct 非空的行也按 canonical 的词表服务（opencode-go/kimi-k3 拿到 low-high-max）", () => {
    const fact = lookupThinkingFact("opencode-go", "kimi-k3");
    expect(fact?.valuesetId).toBe("low-high-max");
    expect(fact?.effort).toEqual(["low", "high", "max"]);
    expect(levelsOf("opencodego", "kimi-k3")).toEqual(["low", "high", "max"]);
    expect(adjustmentOf("opencodego", "kimi-k3").source).toBe("upstream");
  });

  it("canonical 悬空回落 direct（不变成未知词表）：deepseek-v4-pro 的指针指向不存在的 id", () => {
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
    const amd = lookupThinkingFact("amd", "DeepSeek-V4.1-Flash");
    expect(amd?.toggle).toBe(true);
    expect(amd?.effort).toEqual(["low", "high", "max"]);
    expect(amd?.off).toBe("toggle");
    expect(levelsOf("amd", "DeepSeek-V4.1-Flash")).not.toContain("off");
  });

  it("丢 off 的行按新上游事实失去 off（16 行 openrouter + moonshot/k3；glm-5.2 已由 D1=A2 补回；gemini-3.1-flash-image-preview 上游重新带 off）", () => {
    const lost: Array<[presetId: string, upstreamId: string, model: string]> = [
      ["openrouter", "openrouter", "anthropic/claude-opus-4.5"],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.6"],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.7"],
      ["openrouter", "openrouter", "anthropic/claude-opus-4.8"],
      ["openrouter", "openrouter", "anthropic/claude-haiku-4.5"],
      ["openrouter", "openrouter", "anthropic/claude-opus-5"],
      ["openrouter", "openrouter", "anthropic/claude-sonnet-4.5"],
      ["openrouter", "openrouter", "anthropic/claude-sonnet-4.6"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-image"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-lite-image"],
      ["openrouter", "openrouter", "google/gemini-3-flash-preview"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-lite-preview"],
      ["openrouter", "openrouter", "google/gemini-3.1-flash-lite"],
      ["openrouter", "openrouter", "moonshotai/kimi-k3"],
      ["openrouter", "openrouter", "openai/o3-pro"],
      ["openrouter", "openrouter", "openai/o3"],
      ["moonshot", "kimi-code-plan-cn", "k3"]
    ];
    expect(lost.filter(([presetId]) => presetId === "openrouter")).toHaveLength(16);
    for (const [presetId, upstreamId, model] of lost) {
      const fact = lookupThinkingFact(upstreamId, model);
      expect(fact, `${upstreamId}/${model}`).toBeTruthy();
      expect(fact?.off, `${upstreamId}/${model} 不该再有 off`).toBeNull();
      expect(upstreamVocabularyOf(fact!), `${upstreamId}/${model} 的词表不该含 off`).not.toContain("off");
      expect(levelsOf(presetId, model), `${presetId}/${model}`).not.toContain("off");
      const off = resolveThinkingProfile({ presetId, baseUrl: baseUrlOf(presetId), model, level: "off", stream: STREAM });
      expect(JSON.stringify(openaiVocabularyFields(off.vocabulary)), `${presetId}/${model} 偏好 off`).not.toContain('"none"');
    }
  });

  it("A' = ∅ 的行仍 fail-closed（openrouter/anthropic/claude-haiku-4.5、claude-sonnet-4.5 不发参）", () => {
    for (const model of ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"]) {
      const adj = adjustmentOf("openrouter", model);
      expect(adj.availableLevels, model).toEqual([]);
      expect(adj.effectiveLevel, model).toBe("default");
      expect(adj.source, model).toBe("upstream");
      for (const level of ALL_LEVELS) {
        expect(resolveViaRuntime("openrouter", model, level), `${model} · ${level}`).toBe(
          JSON.stringify({
            vocabulary: NO_FIELDS,
            effectiveLevel: "default",
            offUnavailable: level === "off",
            offFallback: null,
            thinkingClass: "always"
          })
        );
      }
    }
  });

  it("minimax/MiniMax-M3：canonical 优先碰不到它；形状登记后按登记方言发参（2026-10-05）", () => {
    const upstream = "minimax-cn";
    expect(lookupThinkingFact(upstream, "MiniMax-M3")?.valuesetId).toBe("toggle");
    expect(UPSTREAM_PROVIDER_BY_PRESET.minimax).toBe(upstream);
    expect(PROVIDERS.minimax).toEqual({});
    expect(UPSTREAM_TOGGLE_SHAPES.minimax).toEqual({
      off: thinkingType("disabled"),
      on: thinkingType("adaptive")
    });
    expect(levelsOf("minimax", "MiniMax-M3")).toEqual([...AI_THINKING_LEVELS]);
    expect(resolveViaRuntime("minimax", "MiniMax-M3", "off")).toBe(
      JSON.stringify({
        vocabulary: thinkingType("disabled"),
        effectiveLevel: "off",
        offUnavailable: false,
        offFallback: null,
        thinkingClass: "hybrid"
      })
    );
    expect(resolveViaRuntime("minimax", "MiniMax-M3", "high")).toBe(
      JSON.stringify({
        vocabulary: thinkingType("adaptive"),
        effectiveLevel: "high",
        offUnavailable: false,
        offFallback: null,
        thinkingClass: "hybrid"
      })
    );
  });

  it("18 号票：机制删干净——四家 PROVIDERS 记录都是空对象", () => {
    for (const presetId of HOSTED_PRESETS_18) {
      expect(providerRuleFor(presetId), presetId).toEqual({});
    }
  });
});

describe("18 号票：删 4 家平台 override（2026-10-05 用户裁定）", () => {
  const levelsOf = (presetId: string, model: string): readonly ThinkingLevel[] =>
    resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "high", stream: STREAM }).availableLevels;

  const localIdOf = (upstreamId: string, modelId: string): string => {
    for (const alias of MODEL_ID_ALIASES) {
      if (alias.upstream === `${upstreamId}/${modelId}`) return alias.localId;
    }
    return modelId;
  };

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

  it("目录内 293 行零缺口：四家每一行都落 source: \"upstream\"（没有 unknown / fail-closed）", () => {
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
    expect(counts).toEqual({ openrouter: 241, amd: 8, sensenova: 6, opencodego: 38 });
    expect(total).toBe(293);
  });

  it("上游词表更窄的行：档位被静默改写（amd/Qwen3.8-27B 的 high → medium）", () => {
    const adjustment = resolveThinkingAdjustment({ presetId: "amd", model: "Qwen3.8-27B", level: "high", stream: true });
    expect(adjustment.availableLevels).toEqual(["low", "medium"]);
    expect(adjustment.effectiveLevel).toBe("medium");
    expect(adjustment.reason).toBe("model-vocabulary");
    expect(openaiVocabularyFields(resolveThinkingProfile({ presetId: "amd", model: "Qwen3.8-27B", level: "high", stream: true }).vocabulary)).toEqual({
      reasoning_effort: "medium"
    });
  });

  it("上游词表更窄的行：chip 就是上游那两档，low 偏好被裁到 high（sensenova/glm-5.2）", () => {
    expect(levelsOf("sensenova", "glm-5.2")).toEqual(["high", "max"]);
    expect(openaiVocabularyFields(resolveThinkingProfile({ presetId: "sensenova", model: "glm-5.2", level: "low", stream: true }).vocabulary)).toEqual({
      reasoning_effort: "high"
    });
  });

  it("19 号票：值集覆盖 / canonical 重定向后的三行逐档钉住", () => {
    expect(levelsOf("opencodego", "deepseek-v4-pro")).toEqual(["low", "high", "max"]);
    expect(levelsOf("sensenova", "deepseek-v4-pro")).toEqual(["low", "high", "max"]);
    expect(resolveThinkingProfile({ presetId: "sensenova", model: "deepseek-v4-pro", level: "off", stream: true })).toEqual({
      vocabulary: reasoningEffort("low"),
      requestedLevel: "off",
      effectiveLevel: "low",
      offUnavailable: true,
      offFallback: "low",
      thinkingClass: "always"
    });
    expect(levelsOf("amd", "DeepSeek-V4-Flash")).toEqual(["low", "high", "max"]);
    expect(openaiVocabularyFields(resolveThinkingProfile({ presetId: "amd", model: "DeepSeek-V4-Flash", level: "minimal", stream: true }).vocabulary)).toEqual({
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
        openaiVocabularyFields(resolveThinkingProfile({ presetId: "opencodego", model: "kimi-k3", level, stream: true }).vocabulary),
        level
      ).toEqual(expected[index]);
    }
  });

  it("off 级联：票面「上游词表含 off」的口径 177 行（146/5/5/21），逐平台钉数", () => {
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
    }).toEqual({ openrouter: 146, amd: 5, sensenova: 5, opencodego: 21 });
    expect(hasOff("openrouter") + hasOff("amd") + hasOff("sensenova") + hasOff("opencodego")).toBe(177);
  });

  it("off 级联：按「thinkingClass=always + offUnavailable」口径是 231 行（与口径 A 的 177 差异见 18-report）", () => {
    const cascade = (presetId: string): string[] =>
      modelsOf(presetId).filter((model) => {
        const adjustment = resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "off", stream: true });
        return adjustment.resolution.thinkingClass === "always" && adjustment.resolution.offUnavailable;
      });
    const counts = {
      openrouter: cascade("openrouter").length,
      amd: cascade("amd").length,
      sensenova: cascade("sensenova").length,
      opencodego: cascade("opencodego").length
    };
    expect(counts).toEqual({ openrouter: 185, amd: 8, sensenova: 5, opencodego: 33 });
    expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(231);
    const glm = resolveThinkingAdjustment({ presetId: "sensenova", model: "glm-5.2", level: "off", stream: true });
    expect(glm.effectiveLevel).toBe("high");
    expect(glm.resolution.offFallback).toBe("low");
  });

  it("零档行（budget-only）fail-closed：不发任何思考字段，且不被 clamp 造出档位", () => {
    for (const model of ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"]) {
      for (const level of ALL_LEVELS) {
        const adjustment = resolveThinkingAdjustment({ presetId: "openrouter", baseUrl: baseUrlOf("openrouter"), model, level, stream: true });
        expect(adjustment.availableLevels, `${model} · ${level}`).toEqual([]);
        expect(openaiVocabularyFields(adjustment.resolution.vocabulary), `${model} · ${level}`).toEqual({});
      }
    }
  });

  it("UPSTREAM_TOGGLE_SHAPES 登记 7 家（删 override 不顺手加四家；第 7 家 minimax 是 2026-10-05 的单独裁定）", () => {
    expect(Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()).toEqual([
      "deepseek",
      "mimo",
      "minimax",
      "modelscope",
      "moonshot",
      "qwen",
      "zhipu"
    ]);
    for (const presetId of HOSTED_PRESETS_18) {
      expect(presetId in UPSTREAM_TOGGLE_SHAPES, presetId).toBe(false);
    }
  });

  it("minimax/MiniMax-M3：形状登记与 override 删除互不干扰（登记后逐字节）", () => {
    expect(lookupThinkingFact("minimax-cn", "MiniMax-M3")?.valuesetId).toBe("toggle");
    expect(PROVIDERS.minimax).toEqual({});
    expect(resolveViaRuntime("minimax", "MiniMax-M3", "off")).toBe(
      JSON.stringify({
        vocabulary: thinkingType("disabled"),
        effectiveLevel: "off",
        offUnavailable: false,
        offFallback: null,
        thinkingClass: "hybrid"
      })
    );
    expect(resolveViaRuntime("minimax", "MiniMax-M3", "low")).toBe(
      JSON.stringify({
        vocabulary: thinkingType("adaptive"),
        effectiveLevel: "low",
        offUnavailable: false,
        offFallback: null,
        thinkingClass: "hybrid"
      })
    );
    expect(levelsOf("minimax", "MiniMax-M3")).toEqual([...AI_THINKING_LEVELS]);
    expect(levelsOf("minimax", "MiniMax-M2")).toEqual([]);
  });

  it("18 号票新增分歧 25 行 → 2026-10-06 剥 org 前缀后 109 行（逐条钉；含 AMD 的 5 行 400 风险面）", () => {
    const divergent = divergentKeys(LEVELS, { presets: HOSTED_PRESETS_18, handOnly: true });
    expect(divergent.sort()).toEqual([
      "amd/deepseek-v4-flash",
      "amd/deepseek-v4-flash-vision-exp",
      "amd/deepseek-v4.1-flash",
      "amd/glm-5.3-flash",
      "amd/mimo-v2.6-flash",
      "amd/qwen3.8-27b",
      "amd/qwen3.8-flash-next",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/deepseek-v4.1-flash",
      "opencode-go/glm-5.2",
      "opencode-go/glm-5.3",
      "opencode-go/glm-5.3-flash",
      "opencode-go/gpt-5.6-luna",
      "opencode-go/gpt-6-luna",
      "opencode-go/mimo-v2.5",
      "opencode-go/mimo-v2.5-pro",
      "opencode-go/mimo-v2.6-flash",
      "opencode-go/mimo-v2.6-pro",
      "opencode-go/minimax-m3.1-flash",
      "opencode-go/minimax-m3.1-flash-free",
      "opencode-go/qwen3.7-plus",
      "opencode-go/qwen3.8-flash",
      "opencode-go/qwen3.8-max",
      "openrouter/deepseek/deepseek-chat-v3.1",
      "openrouter/deepseek/deepseek-v3.2",
      "openrouter/deepseek/deepseek-v3.2-exp",
      "openrouter/deepseek/deepseek-v4-flash",
      "openrouter/deepseek/deepseek-v4-flash-0731",
      "openrouter/deepseek/deepseek-v4-flash-vision-exp",
      "openrouter/deepseek/deepseek-v4-pro",
      "openrouter/deepseek/deepseek-v4-pro-0813",
      "openrouter/deepseek/deepseek-v4.1-flash",
      "openrouter/deepseek/deepseek-v4.1-flash-1017",
      "openrouter/minimax/minimax-m3.1-flash",
      "openrouter/moonshotai/kimi-k2.5",
      "openrouter/moonshotai/kimi-k2.6",
      "openrouter/openai/gpt-5",
      "openrouter/openai/gpt-5-mini",
      "openrouter/openai/gpt-5-nano",
      "openrouter/openai/gpt-5-pro",
      "openrouter/openai/gpt-5.1",
      "openrouter/openai/gpt-5.1-codex",
      "openrouter/openai/gpt-5.1-codex-max",
      "openrouter/openai/gpt-5.1-codex-mini",
      "openrouter/openai/gpt-5.2",
      "openrouter/openai/gpt-5.2-codex",
      "openrouter/openai/gpt-5.2-pro",
      "openrouter/openai/gpt-5.3-codex",
      "openrouter/openai/gpt-5.4",
      "openrouter/openai/gpt-5.4-image-2",
      "openrouter/openai/gpt-5.4-mini",
      "openrouter/openai/gpt-5.4-nano",
      "openrouter/openai/gpt-5.4-pro",
      "openrouter/openai/gpt-5.5",
      "openrouter/openai/gpt-5.5-pro",
      "openrouter/openai/gpt-5.6-luna",
      "openrouter/openai/gpt-5.6-luna-pro",
      "openrouter/openai/gpt-5.6-sol",
      "openrouter/openai/gpt-5.6-sol-pro",
      "openrouter/openai/gpt-5.6-terra",
      "openrouter/openai/gpt-5.6-terra-pro",
      "openrouter/qwen/qwen3.5-122b-a10b",
      "openrouter/qwen/qwen3.5-27b",
      "openrouter/qwen/qwen3.5-35b-a3b",
      "openrouter/qwen/qwen3.5-397b-a17b",
      "openrouter/qwen/qwen3.5-9b",
      "openrouter/qwen/qwen3.5-flash-02-23",
      "openrouter/qwen/qwen3.5-plus-02-15",
      "openrouter/qwen/qwen3.5-plus-20260420",
      "openrouter/qwen/qwen3.6-27b",
      "openrouter/qwen/qwen3.6-35b-a3b",
      "openrouter/qwen/qwen3.6-flash",
      "openrouter/qwen/qwen3.6-plus",
      "openrouter/qwen/qwen3.7-flash",
      "openrouter/qwen/qwen3.7-max",
      "openrouter/qwen/qwen3.7-plus",
      "openrouter/qwen/qwen3.8-2.4t-a95b",
      "openrouter/qwen/qwen3.8-27b",
      "openrouter/qwen/qwen3.8-flash",
      "openrouter/qwen/qwen3.8-max-0902",
      "openrouter/qwen/qwen3.8-max-prime",
      "openrouter/qwen/qwen3.8-omni-flash",
      "openrouter/stepfun/step-3.5-flash",
      "openrouter/xiaomi/mimo-v2.5",
      "openrouter/xiaomi/mimo-v2.5-pro",
      "openrouter/xiaomi/mimo-v2.6-flash",
      "openrouter/xiaomi/mimo-v2.6-pro",
      "openrouter/xiaomi/mimo-v2.6-pro-ultraspeed",
      "openrouter/z-ai/glm-4.5",
      "openrouter/z-ai/glm-4.5-air",
      "openrouter/z-ai/glm-4.5v",
      "openrouter/z-ai/glm-4.6",
      "openrouter/z-ai/glm-4.6v",
      "openrouter/z-ai/glm-4.7",
      "openrouter/z-ai/glm-4.7-flash",
      "openrouter/z-ai/glm-5",
      "openrouter/z-ai/glm-5-turbo",
      "openrouter/z-ai/glm-5.1",
      "openrouter/z-ai/glm-5.2",
      "openrouter/z-ai/glm-5.3",
      "openrouter/z-ai/glm-5.3-flash",
      "openrouter/z-ai/glm-5.3-flashx",
      "openrouter/z-ai/glm-5.3-flashx-legal",
      "openrouter/z-ai/glm-5.3-prime",
      "openrouter/z-ai/glm-5v-turbo",
      "openrouter/~deepseek/deepseek-v4-flash-latest",
      "sensenova/deepseek-v4-flash",
      "sensenova/deepseek-v4-pro",
      "sensenova/deepseek-v4.1-flash",
      "sensenova/glm-5.2"
    ]);
    const divergent7 = divergentKeys(ALL_LEVELS, { presets: HOSTED_PRESETS_18, handOnly: true });
    expect(divergent7.filter((key) => !divergent.includes(key)).sort()).toEqual(["openrouter/stepfun/step-3.7-flash"]);
  });
});

describe("D1=A2：本仓补声明（zhipuai/glm-5.2 补 off 能力）", () => {
  const levelsOf = (presetId: string, model: string): readonly ThinkingLevel[] =>
    resolveThinkingAdjustment({ presetId, baseUrl: baseUrlOf(presetId), model, level: "high", stream: STREAM }).availableLevels;

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
      expect(fact?.effort, `${provider}/${model}`).toEqual(["high", "max"]);
    }
    expect(VALUESETS["high-max"]).toBeUndefined();
    expect(VALUESETS["toggle+high-max"]?.effort).toEqual(["high", "max"]);
  });

  it("少开 off：zhipu（thinking.type）与 qwen（enable_thinking）都真拿到 off 写点", () => {
    expect(levelsOf("zhipu", "glm-5.2")).toEqual(["off", "high", "max"]);
    expect(levelsOf("qwen", "glm-5.2")).toEqual(["off", "high", "max"]);
    expect(resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: STREAM })).toEqual({
      vocabulary: thinkingType("disabled"),
      requestedLevel: "off",
      effectiveLevel: "off",
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "hybrid"
    });
    expect(resolveThinkingProfile({ presetId: "qwen", model: "glm-5.2", level: "off", stream: STREAM })).toEqual({
      vocabulary: enableThinking(false),
      requestedLevel: "off",
      effectiveLevel: "off",
      offUnavailable: false,
      offFallback: null,
      thinkingClass: "hybrid"
    });
  });

  it("误开 off：三家未登记开关形状的行 A' 不变（{high,max}）、off 仍级联 high", () => {
    expect(Object.keys(UPSTREAM_TOGGLE_SHAPES).sort()).toEqual([
      "deepseek",
      "mimo",
      "minimax",
      "modelscope",
      "moonshot",
      "qwen",
      "zhipu"
    ]);
    for (const [presetId, provider, model] of THREE_UNREGISTERED) {
      expect(presetId in UPSTREAM_TOGGLE_SHAPES, presetId).toBe(false);
      const fact = lookupThinkingFact(provider, model);
      expect(fact?.off, `${provider}/${model}`).toBe("toggle");
      expect(ruleFromUpstreamFact(fact!, presetId).off, `${provider}/${model}`).toBeUndefined();
      expect(levelsOf(presetId, model), `${presetId}/${model}`).toEqual(["high", "max"]);
      expect(resolveThinkingProfile({ presetId, model, level: "off", stream: STREAM }), `${presetId}/${model}`).toEqual({
        vocabulary: reasoningEffort("high"),
        requestedLevel: "off",
        effectiveLevel: "high",
        offUnavailable: true,
        offFallback: "low",
        thinkingClass: "always"
      });
    }
  });

  it("同一模型两条路径：目录内 zhipu/glm-5.2 与目录外 zhipu/glm-5.2-air 的 off 出口同为 thinking:{type:\"disabled\"}", () => {
    expect(lookupThinkingFact("zhipuai", "glm-5.2-air"), "glm-5.2-air 不该在指派表里").toBeNull();
    const inCatalog = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: STREAM });
    const outOfCatalog = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2-air", level: "off", stream: STREAM });
    expect(openaiVocabularyFields(inCatalog.vocabulary)).toEqual({ thinking: { type: "disabled" } });
    expect(openaiVocabularyFields(outOfCatalog.vocabulary)).toEqual({ thinking: { type: "disabled" } });
    expect(outOfCatalog).toEqual(inCatalog);
    expect(levelsOf("zhipu", "glm-5.2")).toEqual(["off", "high", "max"]);
    expect(levelsOf("zhipu", "glm-5.2-air")).toEqual(["off", "low", "high"]);
  });
});
