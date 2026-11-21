import { describe, expect, it } from "vitest";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  applyClassRule,
  availableLevelsOf,
  clampThinkingLevel,
  enableThinking,
  isThinkingLevel,
  normalizeThinkingLevel,
  reasoningEffort,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
  type ClassRule,
  type ResolveThinkingInput,
  type ThinkingLevelValue
} from "../../extension/ai/thinking-profiles.js";
import { VALUESETS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_URL = "https://api.deepseek.com/v1";
const SENSENOVA_URL = "https://token.sensenova.cn/v1";
const MINIMAX_URL = "https://api.minimaxi.com/v1";

describe("档位词表（7 档，off 第一位）", () => {
  it("AI_THINKING_LEVELS 是上游词表的全序：off < minimal < low < medium < high < xhigh < max", () => {
    expect(AI_THINKING_LEVELS).toEqual(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    expect(AI_THINKING_LEVELS[0]).toBe("off");
  });

  it("isThinkingLevel：7 档为真；上游的 none 与任意脏值都不是档位", () => {
    for (const level of AI_THINKING_LEVELS) {
      expect(isThinkingLevel(level)).toBe(true);
    }
    for (const value of ["none", "bogus", "HIGH", "", null, undefined, 0, {}]) {
      expect(isThinkingLevel(value)).toBe(false);
    }
  });

  it("normalizeThinkingLevel：8 个可选值原样，缺省 / 脏值回落 default", () => {
    for (const level of ["default", ...AI_THINKING_LEVELS]) {
      expect(normalizeThinkingLevel(level)).toBe(level);
    }
    for (const value of ["none", "ultra", "", null, undefined, 7]) {
      expect(normalizeThinkingLevel(value)).toBe("default");
    }
  });
});

describe("clamp：内部 seam 的排序语义（少量直调；对外观测面见下一节的逐档断言）", () => {
  it("向下取：偏好档的等距更低档（合成集才有的边角）", () => {
    expect(clampThinkingLevel("high", ["low", "medium", "xhigh"])).toBe("medium");
  });

  it("可用集为空 → default；偏好 default 恒为 default（不参与向下取）", () => {
    expect(clampThinkingLevel("high", [])).toBe("default");
    expect(clampThinkingLevel("default", ["off", "low", "high"])).toBe("default");
  });
});

describe("实发档 effectiveLevel：逐档断言解析结果（clamp / off 级联的对外观测面）", () => {
  const levelOf = (input: Omit<ResolveThinkingInput, "level">, level: ThinkingLevelValue) =>
    resolveThinkingAdjustment({ ...input, level }).effectiveLevel;

  it("向下取：A'={off,low,medium,xhigh}（qwen3.8-max）——L∈A' 恒等，L∉A' 取最近更低档", () => {
    const input = { presetId: "qwen", model: "qwen3.8-max", stream: true };
    expect(levelOf(input, "off")).toBe("off");
    expect(levelOf(input, "minimal")).toBe("off");
    expect(levelOf(input, "low")).toBe("low");
    expect(levelOf(input, "medium")).toBe("medium");
    expect(levelOf(input, "high")).toBe("medium");
    expect(levelOf(input, "xhigh")).toBe("xhigh");
    expect(levelOf(input, "max")).toBe("xhigh");
    expect(levelOf(input, "default")).toBe("default");
  });

  it("A' 中没有 ≤ L 的档 → 取 A' 的最小档（sensenova/glm-5.2，A'={high,max}）", () => {
    const input = { presetId: "sensenova", baseUrl: SENSENOVA_URL, model: "glm-5.2", stream: true };
    expect(resolveThinkingAdjustment({ ...input, level: "off" }).availableLevels).toEqual(["high", "max"]);
    expect(levelOf(input, "off")).toBe("high");
    expect(levelOf(input, "minimal")).toBe("high");
    expect(levelOf(input, "low")).toBe("high");
    expect(levelOf(input, "medium")).toBe("high");
    expect(levelOf(input, "high")).toBe("high");
    expect(levelOf(input, "xhigh")).toBe("high");
    expect(levelOf(input, "max")).toBe("max");
    expect(levelOf(input, "default")).toBe("default");
  });

  it("off 参与档位序：A'={off,high}（opencodego/hy4-preview）偏好 minimal/low/medium 落 off", () => {
    const input = { presetId: "opencodego", model: "hy4-preview", stream: true };
    for (const level of ["off", "minimal", "low", "medium"] as const) {
      expect(levelOf(input, level), level).toBe("off");
    }
    for (const level of ["high", "xhigh", "max"] as const) {
      expect(levelOf(input, level), level).toBe("high");
    }
  });

  it("开关型（zhipu/glm-4.6，A'=全 7 档）：clamp 恒等，逐档实发 = 偏好且不误报调整", () => {
    const input = { presetId: "zhipu", baseUrl: ZHIPU_URL, model: "glm-4.6", stream: true };
    expect(resolveThinkingAdjustment({ ...input, level: "low" }).availableLevels).toEqual(AI_THINKING_LEVELS);
    for (const level of AI_THINKING_LEVELS) {
      const r = resolveThinkingAdjustment({ ...input, level });
      expect(r.effectiveLevel, level).toBe(level);
      expect(r.reason, level).toBe(null);
    }
    expect(levelOf(input, "default")).toBe("default");
  });

  it("零档行（手写 minimax-always，A'=∅）：逐档实发 default，不发任何思考字段", () => {
    const input = { baseUrl: MINIMAX_URL, model: "minimax-m2", stream: true };
    for (const level of ["default", ...AI_THINKING_LEVELS] as const) {
      const r = resolveThinkingAdjustment({ ...input, level });
      expect(r.availableLevels, level).toEqual([]);
      expect(r.effectiveLevel, level).toBe("default");
      expect(openaiVocabularyFields(r.resolution.vocabulary), level).toEqual({});
    }
  });

  it("unknown 哨兵（无任何事实）：effectiveLevel=null = 没有解析结论（不是「无档可落」）", () => {
    for (const level of ["default", ...AI_THINKING_LEVELS] as const) {
      const r = resolveThinkingAdjustment({
        baseUrl: "https://api.example.com/v1",
        model: "totally-unknown",
        level,
        stream: true
      });
      expect(r.effectiveLevel, level).toBe(null);
      expect(r.availableLevels, level).toEqual([]);
    }
  });

  it("口径 B 的修正格：streamOnly off × 非流式 → 实发档 = 级联目标（改造前显示 Off、请求发开档）", () => {
    const input = { baseUrl: QWEN_URL, model: "qwen3-32b-air" };
    const streamed = resolveThinkingAdjustment({ ...input, level: "off", stream: true });
    expect(streamed.effectiveLevel).toBe("off");
    expect(openaiVocabularyFields(streamed.resolution.vocabulary)).toEqual({ enable_thinking: false });

    const blocked = resolveThinkingAdjustment({ ...input, level: "off", stream: false });
    expect(blocked.effectiveLevel).toBe("minimal");
    expect(blocked.resolution.offUnavailable).toBe(true);
    expect(openaiVocabularyFields(blocked.resolution.vocabulary)).toEqual({ enable_thinking: true });
  });
});

describe("可用集 A：由 class 规则的写点派生（提示面与落线同源）", () => {
  it("effort 型：物化的档位键 + off 声明，按档位序", () => {
    const rule: ClassRule = {
      thinkingClass: "hybrid",
      off: { vocabulary: reasoningEffort("none") },
      xhigh: { vocabulary: reasoningEffort("xhigh") },
      medium: { vocabulary: reasoningEffort("medium") },
      low: { vocabulary: reasoningEffort("low") }
    };
    expect(availableLevelsOf(rule)).toEqual(["off", "low", "medium", "xhigh"]);
  });

  it("开关型：on 是任何非 off 档的唯一写点 → 全部非 off 档可用", () => {
    const rule: ClassRule = {
      thinkingClass: "hybrid",
      off: { vocabulary: enableThinking(false) },
      on: { vocabulary: enableThinking(true) }
    };
    expect(availableLevelsOf(rule)).toEqual(AI_THINKING_LEVELS);
  });

  it("无任何档位写点（never / always 无档）→ 空集", () => {
    expect(availableLevelsOf({ thinkingClass: "never" })).toEqual([]);
    expect(availableLevelsOf({ thinkingClass: "always" })).toEqual([]);
  });
});

describe("落线：clamp 后的档位就是实发档位", () => {
  it("qwen3.8-max + high：A={off,low,medium,xhigh} 无 high → 实发 medium（决策 #8 的字节变化）", () => {
    const r = resolveThinkingProfile({ presetId: "qwen", model: "qwen3.8-max", level: "high", stream: true });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "medium" });
  });

  it("qwen3.8-max：low / medium / xhigh / off 原样落线（只有 high 被调整）", () => {
    const fields = (level: string) =>
      openaiVocabularyFields(
        resolveThinkingProfile({ presetId: "qwen", model: "qwen3.8-max", level, stream: true }).vocabulary
      );
    expect(fields("off")).toEqual({ enable_thinking: false });
    expect(fields("low")).toEqual({ reasoning_effort: "low" });
    expect(fields("medium")).toEqual({ reasoning_effort: "medium" });
    expect(fields("xhigh")).toEqual({ reasoning_effort: "xhigh" });
    expect(fields("max")).toEqual({ reasoning_effort: "xhigh" });
  });

  it("关不掉的模型偏好 off：级联落可用集最小档（sensenova/glm-5.2 A={high,max} → high）", () => {
    const r = resolveThinkingProfile({ presetId: "sensenova", model: "glm-5.2", level: "off", stream: true });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "high" });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe("low");
  });

  it("D1=A2 本仓补声明：zhipu/glm-5.2 偏好 off 真落 thinking:{type:\"disabled\"}（不再级联）", () => {
    const r = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: true });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ thinking: { type: "disabled" } });
    expect(r.offUnavailable).toBe(false);
    expect(r.offFallback).toBe(null);
    expect(r.thinkingClass).toBe("hybrid");
    expect(
      openaiVocabularyFields(
        resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "low", stream: true }).vocabulary
      )
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("上游未登记模型走手写兜底：A={off,low,high} → xhigh 向下取 high", () => {
    const r = resolveThinkingProfile({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_URL,
      model: "deepseek-v4-pro-2026",
      level: "xhigh",
      stream: true
    });
    expect(openaiVocabularyFields(r.vocabulary)).toEqual({ reasoning_effort: "high" });
  });

  it("18 号票：平台声明口径已删——amd 上目录外的 id 回落手写/未知，不再有平台兜底档位", () => {
    const unknown = resolveThinkingProfile({
      presetId: "amd",
      baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
      model: "any-model",
      level: "medium",
      stream: true
    });
    expect(openaiVocabularyFields(unknown.vocabulary)).toEqual({});
    expect(unknown.thinkingClass).toBe("unknown");
    expect(
      openaiVocabularyFields(
        resolveThinkingProfile({
          presetId: "amd",
          baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
          model: "deepseek-v4-pro",
          level: "off",
          stream: true
        }).vocabulary
      )
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("开关型血统：非 off 档全落 on 写点（clamp 恒等，不误报调整）", () => {
    const r = resolveThinkingAdjustment({
      presetId: "zhipu",
      baseUrl: ZHIPU_URL,
      model: "glm-4.6",
      level: "xhigh",
      stream: true
    });
    expect(r.effectiveLevel).toBe("xhigh");
    expect(r.reason).toBe(null);
    expect(openaiVocabularyFields(r.resolution.vocabulary)).toEqual({ thinking: { type: "enabled" } });
  });
});

describe("resolveThinkingAdjustment：提示面的「源档 → 目标档 + 原因」", () => {
  it("未调整：reason=null，effectiveLevel = 偏好", () => {
    const r = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level: "low", stream: true });
    expect(r.requestedLevel).toBe("low");
    expect(r.effectiveLevel).toBe("low");
    expect(r.reason).toBe(null);
  });

  it("模型词表没有该档：reason=model-vocabulary（qwen3.8-max + high → medium）", () => {
    const r = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level: "high", stream: true });
    expect(r.requestedLevel).toBe("high");
    expect(r.effectiveLevel).toBe("medium");
    expect(r.reason).toBe("model-vocabulary");
    expect(r.availableLevels).toEqual(["off", "low", "medium", "xhigh"]);
  });

  it("上游未登记该模型（手写兜底）：reason=upstream-unlisted", () => {
    const r = resolveThinkingAdjustment({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_URL,
      model: "deepseek-v4-pro-2026",
      level: "xhigh",
      stream: true
    });
    expect(r.effectiveLevel).toBe("high");
    expect(r.reason).toBe("upstream-unlisted");
  });

  it("18 号票：四家托管平台不再有 platform-vocabulary 原因——按各自上游词表 clamp", () => {
    const downgraded = resolveThinkingAdjustment({ presetId: "amd", model: "Qwen3.8-27B", level: "high", stream: true });
    expect(downgraded.effectiveLevel).toBe("medium");
    expect(downgraded.reason).toBe("model-vocabulary");
    expect(downgraded.availableLevels).toEqual(["low", "medium"]);
    const unknown = resolveThinkingAdjustment({
      presetId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "any/model",
      level: "max",
      stream: true
    });
    expect(unknown.source).toBe("unknown");
    expect(unknown.reason).toBe(null);
    expect(unknown.effectiveLevel).toBe(null);
  });

  it("可用集为空：实发 default（不发字段）且如实报「被调整」（2026-10-05 default 档）", () => {
    const r = resolveThinkingAdjustment({
      presetId: "minimax",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2",
      level: "high",
      stream: true
    });
    expect(r.availableLevels).toEqual([]);
    expect(r.effectiveLevel).toBe("default");
    expect(openaiVocabularyFields(r.resolution.vocabulary)).toEqual({});
    expect(r.reason).toBe("upstream-unlisted");
  });

  it("偏好就是 default：实发 default、不发字段、不报「被调整」", () => {
    const r = resolveThinkingAdjustment({ presetId: "deepseek", model: "deepseek-v4-pro", level: "default", stream: true });
    expect(r.effectiveLevel).toBe("default");
    expect(openaiVocabularyFields(r.resolution.vocabulary)).toEqual({});
    expect(r.reason).toBe(null);
    expect(r.availableLevels).toEqual(["off", "low", "high", "max"]);
  });

  it("提示面的 effectiveLevel 是解析结果的读值投影（同源由构造保证，不再自算落线字段）", () => {
    for (const level of AI_THINKING_LEVELS) {
      const r = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level, stream: true });
      expect(r.effectiveLevel, level).toBe(r.resolution.effectiveLevel);
    }
    const clamped = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level: "high", stream: true });
    expect(clamped.requestedLevel).toBe("high");
    expect(clamped.resolution.effectiveLevel).toBe("medium");
    expect(clamped.effectiveLevel).toBe("medium");
  });
});

describe("残留清单裁决（31 行按上游，2026-10-04 用户裁定）：clamp 只在模型自己的词表内移动", () => {
  const ADJUDICATED: Array<[presetId: string, upstreamId: string, model: string]> = [
    ["qwen", "alibaba-cn", "deepseek-v4-flash"],
    ["qwen", "alibaba-cn", "deepseek-v4-pro"],
    ["qwen", "alibaba-cn", "glm-5.2"],
    ["qwen", "alibaba-cn", "glm-5.3"],
    ["zhipu", "zhipuai", "glm-5.3-flash"],
    ["zhipu", "zhipuai", "glm-5.3-flashx"],
    ["qwen", "alibaba-cn", "siliconflow/deepseek-v3.2"],
    ["minimax", "minimax-cn", "MiniMax-M3"],
    ["stepfun", "stepfun-step-plan", "step-3.5-flash"],
    ["stepfun", "stepfun-step-plan", "step-3.5-flash-2603"],
    ["deepseek", "deepseek", "deepseek-flash"],
    ["qwen", "alibaba-cn", "qwen3-14b"],
    ["qwen", "alibaba-cn", "qwen3-8b"],
    ["qwen", "alibaba-cn", "qwen3-omni-flash"],
    ["qwen", "alibaba-cn", "qwen3-vl-plus"],
    ["qwen", "alibaba-cn", "siliconflow/deepseek-v3.1-terminus"],
    ["moonshot", "kimi-code-plan-cn", "k3-256k"],
    ["moonshot", "kimi-code-plan-cn", "kimi-for-coding"],
    ["stepfun", "stepfun-step-plan", "step-5-preview"],
    ["qwen", "alibaba-cn", "deepseek-v4.1-flash"],
    ["qwen", "alibaba-cn", "glm-5"],
    ["qwen", "alibaba-cn", "glm-5.1"],
    ["qwen", "alibaba-cn", "kimi-k2.5"],
    ["qwen", "alibaba-cn", "kimi-k2.6"],
    ["qwen", "alibaba-cn", "kimi/kimi-k2.5"],
    ["qwen", "alibaba-cn", "qwen3-235b-a22b"],
    ["qwen", "alibaba-cn", "qwen3-32b"],
    ["qwen", "alibaba-cn", "qwen3.8-flash"],
    ["qwen", "alibaba-cn", "qwen3.8-omni-flash"],
    ["modelscope", "modelscope", "GLM-4.5"],
    ["modelscope", "modelscope", "GLM-4.6"]
  ];

  it("31 行 × 7 档：落线 = 上游投影（可用集由投影写点派生，clamp 不引入旧手写事实）", () => {
    expect(ADJUDICATED.length).toBe(31);
    for (const [presetId, upstreamId, model] of ADJUDICATED) {
      const projected = ruleFromUpstreamFact(lookupThinkingFact(upstreamId, model)!, presetId);
      for (const level of AI_THINKING_LEVELS) {
        expect(resolveThinkingProfile({ presetId, model, level, stream: true }), `${presetId}/${model} · ${level}`).toEqual(
          applyClassRule(projected, level, true)
        );
      }
    }
  });

  it("无档位可落的裁决行不被 clamp 造出强度档：实发 default（2026-10-05 起恒可发）", () => {
    expect(availableLevelsOf(CLASSES["minimax-always"])).toEqual([]);
    expect(applyClassRule(CLASSES["minimax-always"], "high", true).effectiveLevel).toBe("default");
  });
});

describe("上游值集：effort 档位全在阶梯内（物化不丢档）", () => {
  it("VALUESETS 的每个 effort 值要么是 none（off 的线值），要么是 7 档之一", () => {
    for (const [id, valueset] of Object.entries(VALUESETS)) {
      for (const tier of valueset.effort ?? []) {
        expect(tier === "none" || isThinkingLevel(tier), `${id} 的档位 ${tier} 不在阶梯内`).toBe(true);
      }
    }
  });
});
