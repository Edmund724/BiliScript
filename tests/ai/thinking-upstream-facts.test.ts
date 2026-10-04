// tests/ai/thinking-upstream-facts.test.ts
// 票据 04（upstream-model-facts/04）：有上游平台的模型结论改由 02 号票的指派表驱动，
// 手写表退为「产品语义 + 上游未覆盖兜底」，并留一张显式的**行为冻结表**。
//
// 交互方式（用户裁决 B1：指派表优先 + 手写降级兜底）：
//   PENDING_DIVERGENCES（精确 id 冻结）→ 指派表命中 + 三档投影 → 手写表（EXCEPTIONS >> TAXONOMY
//   >> unknownClass）→ UNKNOWN 哨兵。点名翻转的三处原手写专条**留在原表但已降级**：
//   它们只服务「指派表不认识的 id」（用户自填 / 上游新变体）。真删会让这些无界 id 的请求体
//   跟着变，与「只翻三处、其余行为冻结」冲突（实测见 artifacts/04-prune-matrix.external-ids.*）。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 三处翻转没翻到 / 翻错方向：指派表被手写专条抢答（或反过来翻多了）；
//   2. 降级兜底其实是删掉的：指派表不认识的 id 不再逐字节沿用旧手写结论；
//   3. 三档投影规则漂移：off 关不掉时臆造参数、none 被当档位、low/high 取错词、
//      budget-only 的模型被塞参数；
//   4. 平台方言丢失：值集 toggle 落到没登记开关形状的平台上被发明出字段；
//   5. **静默的第二事实源**（本票核心风险）：某模型既有上游事实、手写侧也有结论，
//      两者不同却没进冻结表 → 请求体被悄悄改了，没人知道；
//   6. 冻结表不忠实：冻结的 class 与手写侧原本的结论不一致 → 冻结本身改变了行为；
//   7. 只翻三处被破坏：冻结表里混进了点名的三处，或表外的分歧没有逐条冻结；
//   8. 冻结表条目不可审：class 悬挂 / 理由或上游证据为空 / 键写成通配模式；
//   9. override 平台被上游/手写抢走（识别层短路必须最先）。

import { describe, expect, it } from "vitest";
import { ASSIGNMENTS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import {
  CLASSES,
  EXCEPTIONS,
  PENDING_DIVERGENCES,
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

  it("点名的三处不在冻结表里；三处照翻，尽管手写专条还在且结论相反", () => {
    for (const key of FLIPPED) {
      expect(PENDING_DIVERGENCES[key], `${key} 不该被冻结`).toBeUndefined();
    }
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
  // 这些 id 不在 02 指派表里（用户自填 / 上游新变体），也没有冻结条目：
  // 它们必须仍然走手写专条 —— 真删专条就会改变它们的请求体。
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

describe("三档投影（上游值集 → ClassRule；规则见 ai/thinking-profiles.ts 文件头）", () => {
  const fact = (valuesetId: string, toggle: boolean, effort: string[] | null, off: "toggle" | "effort-none" | null) => ({
    valuesetId,
    toggle,
    effort,
    off
  });

  it("budget-only（无 toggle 无 effort）：不发任何参数，也不发明 off", () => {
    expect(ruleFromUpstreamFact(fact("b", false, null, null), "qwen")).toEqual({ thinkingClass: "always" });
  });

  it("toggle + budget：off 走平台开关、low/high 落开关的开写点（qwen 方言 enable_thinking）", () => {
    expect(ruleFromUpstreamFact(fact("toggle+b:-81920", true, null, "toggle"), "qwen")).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { enable_thinking: false } },
      on: { fields: { enable_thinking: true } }
    });
  });

  it("toggle 平台无登记开关形状（stepfun）：不发明形状 → 不发开关", () => {
    expect(ruleFromUpstreamFact(fact("toggle", true, null, "toggle"), "stepfun")).toEqual({ thinkingClass: "always" });
  });

  it("effort 含 none：off 走 effort none；none 不参与 low/high 选档", () => {
    expect(ruleFromUpstreamFact(fact("none-high", false, ["none", "high"], "effort-none"), "qwen")).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { reasoning_effort: "none" } },
      low: { fields: { reasoning_effort: "high" } },
      high: { fields: { reasoning_effort: "high" } }
    });
  });

  it("high-max（glm-5.2）：low 取词表最小档、high 取同名词 → 两档同值（上游事实）", () => {
    expect(ruleFromUpstreamFact(fact("high-max", false, ["high", "max"], null), "zhipu")).toEqual({
      thinkingClass: "always",
      low: { fields: { reasoning_effort: "high" } },
      high: { fields: { reasoning_effort: "high" } }
    });
  });

  it("low-medium-xhigh（qwen3.8-max）：high 没有同名词 → 取词表最大档 xhigh", () => {
    expect(
      ruleFromUpstreamFact(fact("toggle+low-medium-xhigh+b:0-262144", true, ["low", "medium", "xhigh"], "toggle"), "qwen")
    ).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { enable_thinking: false } },
      low: { fields: { reasoning_effort: "low" } },
      high: { fields: { reasoning_effort: "xhigh" } }
    });
  });

  it("low-high-max（deepseek-v4-pro）：high 有同名词 → high（不发上游多出来的 max）", () => {
    expect(ruleFromUpstreamFact(fact("toggle+low-high-max", true, ["low", "high", "max"], "toggle"), "deepseek")).toEqual({
      thinkingClass: "hybrid",
      off: { fields: { thinking: { type: "disabled" } } },
      low: { fields: { reasoning_effort: "low" } },
      high: { fields: { reasoning_effort: "high" } }
    });
  });
});

describe("冻结表（PENDING_DIVERGENCES）：不翻的行逐条可审、可查、忠实", () => {
  it("每条都有非空理由与上游证据，键是精确 `上游 provider/模型 id`", () => {
    const keys = Object.keys(PENDING_DIVERGENCES);
    expect(keys.length).toBeGreaterThanOrEqual(19);
    for (const [key, entry] of Object.entries(PENDING_DIVERGENCES)) {
      expect(key.includes("*"), key).toBe(false);
      expect(key, key).toMatch(/^[^/]+\/.+$/);
      expect(entry.reason.trim().length, key).toBeGreaterThan(0);
      expect(entry.upstream, key).toMatch(/last_updated|https?:\/\//);
      if (entry.class !== null) {
        expect(CLASSES[entry.class], `${key} 冻结到不存在的 class`).toBeTruthy();
      }
    }
    // 表自检（表校验器）也把冻结表算进去。
    expect(validateThinkingTables()).toEqual([]);
  });

  it("冻结是忠实的：冻结的 class = 手写侧原本的结论（null = 原本也没有结论）", () => {
    for (const [key, entry] of Object.entries(PENDING_DIVERGENCES)) {
      const [upstreamId, modelId] = key.split("/");
      const presetId = PRESET_BY_UPSTREAM[upstreamId];
      expect(handClassOf(presetId, modelId) ?? null, key).toBe(entry.class);
      // 冻结后逐档结果必须与「该手写规则直接施加」一致；无结论的行维持 unknown。
      const frozen = entry.class ? CLASSES[entry.class] : undefined;
      for (const level of LEVELS) {
        expect(resolveViaRuntime(presetId, modelId, level), `${key} · ${level}`).toBe(outcomeOf(frozen, level));
      }
    }
  });

  it("表校验器抓得住冻结表的坏条目（悬挂 class / 空理由 / 通配键）", () => {
    const dangling = JSON.parse(JSON.stringify(PENDING_DIVERGENCES));
    dangling["deepseek/deepseek-flash"].class = "no-such-class";
    expect(validateThinkingTables({ divergences: dangling }).join("\n")).toContain("no-such-class");

    const noReason = JSON.parse(JSON.stringify(PENDING_DIVERGENCES));
    noReason["deepseek/deepseek-flash"].reason = "  ";
    expect(validateThinkingTables({ divergences: noReason }).join("\n")).toContain("冻结理由");

    const wildcard = JSON.parse(JSON.stringify(PENDING_DIVERGENCES));
    wildcard["deepseek/*"] = wildcard["deepseek/deepseek-flash"];
    delete wildcard["deepseek/deepseek-flash"];
    expect(validateThinkingTables({ divergences: wildcard }).join("\n")).toContain("精确");
  });
});

describe("冻结表完整性 / 两套匹配不并存（本票核心不变式）", () => {
  // 逐格遍历 02 指派表的全部 (provider, modelId)：算「上游投影」与「手写侧结论」，
  // 两者只要有一档不同，就**必须**是点名翻转的三处之一、或在冻结表里 —— 不允许静默的
  // 第二事实源。同时：非冻结且非翻转的非 override 平台行，runtime 结果必须等于上游投影
  // （即**对指派表命中的模型**，手写正则不再参与）。
  it("02 指派表逐条：对命中的模型，结论只来自上游投影或冻结表（两套不并存）", () => {
    let compared = 0;
    const silent: string[] = [];
    const redundant: string[] = [];
    for (const [upstreamId, table] of Object.entries(ASSIGNMENTS)) {
      const presetId = PRESET_BY_UPSTREAM[upstreamId];
      expect(presetId, `指派表 provider ${upstreamId} 没有 preset 桥接`).toBeTruthy();
      const override = OVERRIDE_PRESETS.has(presetId);
      for (const modelId of Object.keys(table)) {
        const fact = lookupThinkingFact(upstreamId, modelId);
        expect(fact, `${upstreamId}/${modelId} 有指派却查不到值集`).toBeTruthy();
        compared += 1;

        const key = `${upstreamId}/${String(modelId).toLowerCase()}`;
        const frozen = PENDING_DIVERGENCES[key];
        const flipped = FLIPPED.includes(key);
        if (override) {
          // override 平台：识别层短路，与上游/手写逐格对比无关（03 §6）。
          expect(frozen, `${key} 是 override 平台，不该进冻结表`).toBeUndefined();
          continue;
        }

        const projected = ruleFromUpstreamFact(fact!, presetId);
        const hand = handRuleOf(presetId, modelId);
        const divergent = LEVELS.some((level) => outcomeOf(projected, level) !== outcomeOf(hand, level));

        if (divergent && !frozen && !flipped) {
          silent.push(`${key}（上游投影 vs 手写结论不同，未冻结）`);
        }
        if (!divergent && frozen) {
          redundant.push(key);
        }
        if (frozen || flipped) {
          continue;
        }
        for (const level of LEVELS) {
          expect(resolveViaRuntime(presetId, modelId, level), `${key} · ${level}`).toBe(outcomeOf(projected, level));
        }
      }
    }
    expect(silent, `静默分歧（未冻结也不是点名翻转）：\n${silent.join("\n")}`).toEqual([]);
    // 冻结了但按当前投影其实同结论的行：这是**有意的**过度冻结（裁定 2 点名的行照冻），
    // 逐条登记在此，防止以后悄悄多冻。minimax-cn/MiniMax-M3：上游有 toggle 但本仓没登记
    // MiniMax 的开关方言 → 投影 fail-closed，与手写 minimax-always 同结论；仍冻结，以免
    // 将来补了方言就静默翻转。
    expect(redundant).toEqual(["minimax-cn/minimax-m3"]);
    // 口径自检：指派表规模没被误读（02 产物 359 条指派）。
    expect(compared).toBeGreaterThanOrEqual(359);
  });

  it("override 平台仍然无视模型身份（上游与手写都不参与）", () => {
    for (const presetId of OVERRIDE_PRESETS) {
      // 有上游事实的模型（glm-5.2 三档上游是 high-max）在 override 平台照走平台裁定。
      const off = JSON.stringify(resolveThinkingProfile({ presetId, model: "glm-5.2", level: "off", stream: STREAM }));
      const high = JSON.stringify(resolveThinkingProfile({ presetId, model: "glm-5.2", level: "high", stream: STREAM }));
      expect(off, presetId).not.toBe(high);
      expect(off, presetId).toContain("reasoning_effort");
    }
  });

  it("上游未覆盖的兜底职责仍在：用户自填 id 走手写表，有事实的模型由指派表决定", () => {
    // 用户自填 id（指派表查不到）仍命中手写前缀模式。
    expect(resolveViaRuntime("qwen", "qwen3.5-my-finetune", "high")).toBe(
      JSON.stringify({ fields: { enable_thinking: true }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    // 同一平台上「有事实」的模型：runtime 结论 = 指派表投影，不再等于手写侧结论。
    // qwen3.8-max 手写是 qwen-hybrid-effort（high=effort high），上游是 low/medium/xhigh → high=xhigh。
    expect(handClassOf("qwen", "qwen3.8-max")).toBe("qwen-hybrid-effort");
    expect(resolveViaRuntime("qwen", "qwen3.8-max", "high")).toBe(
      JSON.stringify({ fields: { reasoning_effort: "xhigh" }, offUnavailable: false, offFallback: null, thinkingClass: "hybrid" })
    );
    expect(resolveViaRuntime("qwen", "qwen3.8-max", "high")).toBe(
      outcomeOf(ruleFromUpstreamFact(lookupThinkingFact("alibaba-cn", "qwen3.8-max")!, "qwen"), "high")
    );
    // 冻结的行照样按冻结结论走（alibaba-cn/glm-5.2 手写=上游，冻结只是把结论钉死）。
    expect(handClassOf("qwen", "glm-5.2")).toBe("glm-hybrid-effort");
    expect(resolveViaRuntime("qwen", "glm-5.2", "off")).toBe(outcomeOf(CLASSES["glm-hybrid-effort"], "off"));
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
