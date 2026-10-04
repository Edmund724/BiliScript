// tests/ai/thinking-levels.test.ts
// 票据 05（upstream-model-facts/05）：档位值域扩到上游词表 + 全局偏好的 clamp（向下取）。
//
// 分层口径（本票的语义主体）：
//   ai/thinking-levels.ts = 档位词表叶（7 档 + 档位序 + 归一化；零 import，SW 静态图安全）；
//   ai/thinking-profiles.ts = clamp 落线（可用集 A 由 class 规则的写点派生）+ 解析入口。
//
// 先列系统可能失败的方式（每条都有对应用例）：
//   1. 词表少了档位 / off 不在第一位 / 非法值与 "none" 被当成合法档位；
//   2. clamp 方向反了（向上取）或退化成「必然取最大/最小档」；
//   3. clamp 的三个边界：L ∈ A、L ∉ A 但有 ≤ L 的档（含等距）、无 ≤ L 的档；
//   4. off 不参与档位序 —— none/high 类模型（off 可用、minimal/low/medium 不可用）
//      偏好 low 时该落到 off，而不是被"向上取"到 high；
//   5. 可用集推错：开关型（on 写点）被当成只有一档、effort 型的 none 被物化成档位；
//   6. 落线与提示面漂移：提示说 medium、请求仍发 xhigh（本文件用同一次解析钉死）；
//   7. 行为冻结被 clamp 破坏：PENDING_DIVERGENCES 的 31 行对 off/low/high 必须恒等；
//   8. 上游 effort 值集出现阶梯外的档位（物化时被静默丢掉）。

import { describe, expect, it } from "vitest";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  PENDING_DIVERGENCES,
  availableLevelsOf,
  clampThinkingLevel,
  isThinkingLevel,
  normalizeThinkingLevel,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  type ClassRule
} from "../../extension/ai/thinking-profiles.js";
import { VALUESETS } from "../../extension/ai/catalog/models-dev-thinking.generated.js";

const QWEN_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const ZHIPU_URL = "https://open.bigmodel.cn/api/paas/v4";
const DEEPSEEK_URL = "https://api.deepseek.com/v1";

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

  it("normalizeThinkingLevel：7 档原样，非法回落 off", () => {
    for (const level of AI_THINKING_LEVELS) {
      expect(normalizeThinkingLevel(level)).toBe(level);
    }
    for (const value of ["none", "ultra", "", null, undefined, 7]) {
      expect(normalizeThinkingLevel(value)).toBe("off");
    }
  });
});

describe("clamp（决策 #8：向下取）", () => {
  it("L ∈ A → 用 L", () => {
    expect(clampThinkingLevel("medium", ["off", "low", "medium", "high"])).toBe("medium");
    expect(clampThinkingLevel("off", ["off", "low", "high"])).toBe("off");
  });

  it("L ∉ A 且有 ≤ L 的档 → 取最大（等距也向下取）", () => {
    expect(clampThinkingLevel("high", ["low", "medium", "xhigh"])).toBe("medium");
    expect(clampThinkingLevel("medium", ["low", "high"])).toBe("low");
    expect(clampThinkingLevel("max", ["minimal", "low", "medium", "high"])).toBe("high");
  });

  it("A 中没有 ≤ L 的档 → 取 A 的最小档", () => {
    // 票面点名边界：可用集只有 high 而偏好 off。
    expect(clampThinkingLevel("off", ["high"])).toBe("high");
    expect(clampThinkingLevel("off", ["high", "max"])).toBe("high");
    expect(clampThinkingLevel("minimal", ["high", "xhigh"])).toBe("high");
  });

  it("off 参与档位序（06 号票：none/high 类模型 minimal/low/medium 全不可用）", () => {
    expect(clampThinkingLevel("low", ["off", "high"])).toBe("off");
    expect(clampThinkingLevel("medium", ["off", "high"])).toBe("off");
    expect(clampThinkingLevel("high", ["off", "high"])).toBe("high");
  });

  it("可用集为空 → null（无档位可落，维持不发参）", () => {
    expect(clampThinkingLevel("high", [])).toBe(null);
  });
});

describe("可用集 A：由 class 规则的写点派生（提示面与落线同源）", () => {
  it("effort 型：物化的档位键 + off 声明，按档位序", () => {
    const rule: ClassRule = {
      thinkingClass: "hybrid",
      off: { fields: { reasoning_effort: "none" } },
      xhigh: { fields: { reasoning_effort: "xhigh" } },
      medium: { fields: { reasoning_effort: "medium" } },
      low: { fields: { reasoning_effort: "low" } }
    };
    expect(availableLevelsOf(rule)).toEqual(["off", "low", "medium", "xhigh"]);
  });

  it("开关型：on 是任何非 off 档的唯一写点 → 全部非 off 档可用", () => {
    const rule: ClassRule = {
      thinkingClass: "hybrid",
      off: { fields: { enable_thinking: false } },
      on: { fields: { enable_thinking: true } }
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
    expect(r.fields).toEqual({ reasoning_effort: "medium" });
  });

  it("qwen3.8-max：low / medium / xhigh / off 原样落线（只有 high 被调整）", () => {
    const fields = (level: string) =>
      resolveThinkingProfile({ presetId: "qwen", model: "qwen3.8-max", level, stream: true }).fields;
    expect(fields("off")).toEqual({ enable_thinking: false });
    expect(fields("low")).toEqual({ reasoning_effort: "low" });
    expect(fields("medium")).toEqual({ reasoning_effort: "medium" });
    expect(fields("xhigh")).toEqual({ reasoning_effort: "xhigh" });
    expect(fields("max")).toEqual({ reasoning_effort: "xhigh" });
  });

  it("关不掉的模型偏好 off：级联落可用集最小档（glm-5.2 A={high,max} → high）", () => {
    const r = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: true });
    expect(r.fields).toEqual({ reasoning_effort: "high" });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe("low");
  });

  it("上游未登记模型走手写兜底：A={off,low,high} → xhigh 向下取 high", () => {
    const r = resolveThinkingProfile({
      presetId: "deepseek",
      baseUrl: DEEPSEEK_URL,
      model: "deepseek-v4-pro-2026",
      level: "xhigh",
      stream: true
    });
    expect(r.fields).toEqual({ reasoning_effort: "high" });
  });

  it("override 平台：声明的档位键就是可用集（amd 的 medium → low）", () => {
    const r = resolveThinkingProfile({
      presetId: "amd",
      baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
      model: "any-model",
      level: "medium",
      stream: true
    });
    expect(r.fields).toEqual({ reasoning_effort: "low" });
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
    expect(r.resolution.fields).toEqual({ thinking: { type: "enabled" } });
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

  it("override 平台：reason=platform-vocabulary", () => {
    const r = resolveThinkingAdjustment({
      presetId: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "any/model",
      level: "max",
      stream: true
    });
    expect(r.effectiveLevel).toBe("high");
    expect(r.reason).toBe("platform-vocabulary");
  });

  it("可用集为空：effectiveLevel=null 且不报「被调整」（无档可落维持现状）", () => {
    const r = resolveThinkingAdjustment({
      presetId: "minimax",
      baseUrl: "https://api.minimaxi.com/v1",
      model: "MiniMax-M2",
      level: "high",
      stream: true
    });
    expect(r.availableLevels).toEqual([]);
    expect(r.effectiveLevel).toBe(null);
    expect(r.reason).toBe(null);
  });

  it("提示面的 effectiveLevel 与请求字段同源（同一份解析，不会漂移）", () => {
    for (const level of AI_THINKING_LEVELS) {
      const r = resolveThinkingAdjustment({ presetId: "qwen", model: "qwen3.8-max", level, stream: true });
      if (r.effectiveLevel === "off") {
        expect(r.resolution.fields).toEqual({ enable_thinking: false });
      } else if (r.effectiveLevel) {
        expect(r.resolution.fields).toEqual({ reasoning_effort: r.effectiveLevel });
      }
    }
  });
});

describe("行为冻结（PENDING_DIVERGENCES 31 行）：clamp 不得改变 off/low/high 的落线", () => {
  it("每条冻结 class 对 low/high 恒等（A ⊆ {off,low,high}）；无档位的 always 类仍无档可落", () => {
    const frozen = Object.entries(PENDING_DIVERGENCES).filter(([, entry]) => entry.class !== null);
    expect(frozen.length).toBeGreaterThanOrEqual(19);
    for (const [key, entry] of frozen) {
      const available = availableLevelsOf(CLASSES[entry.class!]);
      for (const level of ["low", "high"] as const) {
        // 冻结行的逐字节结论由 tests/ai/thinking-upstream-facts.test.ts 钉住；此处只锁
        // 本票新增的 clamp 不移动它们：要么原样（A 含该档），要么无档可落（A 为空）。
        const effective = clampThinkingLevel(level, available);
        expect(effective, `${key} @ ${level}`).toBe(available.length === 0 ? null : level);
      }
    }
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
