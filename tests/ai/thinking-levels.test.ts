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
//   7. 裁决被 clamp 破坏：残留清单 31 行（2026-10-04 用户裁定：全部按上游）里定义域的
//      档位必须由该模型自己的上游投影派生的可用集决定，不许回到旧手写结论；
//   8. 上游 effort 值集出现阶梯外的档位（物化时被静默丢掉）。

import { describe, expect, it } from "vitest";
import {
  AI_THINKING_LEVELS,
  CLASSES,
  applyClassRule,
  availableLevelsOf,
  clampThinkingLevel,
  isThinkingLevel,
  normalizeThinkingLevel,
  resolveThinkingAdjustment,
  resolveThinkingProfile,
  ruleFromUpstreamFact,
  type ClassRule
} from "../../extension/ai/thinking-profiles.js";
import { VALUESETS, lookupThinkingFact } from "../../extension/ai/catalog/models-dev-thinking.generated.js";

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

  it("可用集为空 → default（没有可表达的强度档：不干预，不发思考字段）", () => {
    expect(clampThinkingLevel("high", [])).toBe("default");
    expect(clampThinkingLevel("off", [])).toBe("default");
  });

  it("偏好 default → 恒为 default（不参与向下取，任何可用集都一样）", () => {
    expect(clampThinkingLevel("default", [])).toBe("default");
    expect(clampThinkingLevel("default", ["off", "low", "high"])).toBe("default");
    expect(clampThinkingLevel("default", ["high", "max"])).toBe("default");
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

  it("关不掉的模型偏好 off：级联落可用集最小档（sensenova/glm-5.2 A={high,max} → high）", () => {
    // D1=A2 前这个样本是 zhipu/glm-5.2；补声明后它的 off 可用（见下一条），同形状且仍关不掉的
    // 代表行换成 sensenova/glm-5.2（未登记开关形状 → toggle 不产写点，A' 不变）。
    const r = resolveThinkingProfile({ presetId: "sensenova", model: "glm-5.2", level: "off", stream: true });
    expect(r.fields).toEqual({ reasoning_effort: "high" });
    expect(r.offUnavailable).toBe(true);
    expect(r.offFallback).toBe("low");
  });

  it("D1=A2 本仓补声明：zhipu/glm-5.2 偏好 off 真落 thinking:{type:\"disabled\"}（不再级联）", () => {
    const r = resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "off", stream: true });
    expect(r.fields).toEqual({ thinking: { type: "disabled" } });
    expect(r.offUnavailable).toBe(false);
    expect(r.offFallback).toBe(null);
    expect(r.thinkingClass).toBe("hybrid");
    // A' 里没有 low → 偏好 low 向下取到 off（与 qwen3.8-max 的偏好 high 落 medium 同一条 clamp 语义）。
    expect(
      resolveThinkingProfile({ presetId: "zhipu", model: "glm-5.2", level: "low", stream: true }).fields
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
    expect(r.fields).toEqual({ reasoning_effort: "high" });
  });

  it("18 号票：平台声明口径已删——amd 上目录外的 id 回落手写/未知，不再有平台兜底档位", () => {
    // 上游词表只覆盖 preset 目录内的模型；目录外 id 回落手写表。手写侧无命中
    // （any-model）→ UNKNOWN 哨兵，三档都不发参（原先 override 会凭空发 low）。
    const unknown = resolveThinkingProfile({
      presetId: "amd",
      baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
      model: "any-model",
      level: "medium",
      stream: true
    });
    expect(unknown.fields).toEqual({});
    expect(unknown.thinkingClass).toBe("unknown");
    // 手写侧命中血统的目录外 id（deepseek-v4 前缀）按手写结论落原生 thinking 开关——
    // AMD 网关对未知字段严格 400，这是 18 号票删 override 后对「目录外 id」的已知代价
    // （目录内 282 行零缺口，见 artifacts/18-platform-override-removal.txt）。
    expect(
      resolveThinkingProfile({
        presetId: "amd",
        baseUrl: "https://developer.amd.com.cn/radeon/api/v1",
        model: "deepseek-v4-pro",
        level: "off",
        stream: true
      }).fields
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

  it("18 号票：四家托管平台不再有 platform-vocabulary 原因——按各自上游词表 clamp", () => {
    // amd/Qwen3.8-27B 的值集是 low-medium（无 high），芯片是 [low, medium]：
    // 偏好 high 被 clamp 到 medium，原因是「模型词表没有这个档位」，不是平台声明裁的。
    // 口径提醒：删 override 前这行芯片就只剩 [low]（high 早在 06 号票的 A' 交集被裁），
    // 变的只是 high 偏好的落线档 low → medium。
    const downgraded = resolveThinkingAdjustment({ presetId: "amd", model: "Qwen3.8-27B", level: "high", stream: true });
    expect(downgraded.effectiveLevel).toBe("medium");
    expect(downgraded.reason).toBe("model-vocabulary");
    expect(downgraded.availableLevels).toEqual(["low", "medium"]);
    // openrouter 未登记上游词表的 id 不再有「平台声明兜底」这条原因：落 unknown 哨兵。
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
    expect(r.resolution.fields).toEqual({});
    expect(r.reason).toBe("upstream-unlisted");
  });

  it("偏好就是 default：实发 default、不发字段、不报「被调整」", () => {
    const r = resolveThinkingAdjustment({ presetId: "deepseek", model: "deepseek-v4-pro", level: "default", stream: true });
    expect(r.effectiveLevel).toBe("default");
    expect(r.resolution.fields).toEqual({});
    expect(r.reason).toBe(null);
    expect(r.availableLevels).toEqual(["off", "low", "high", "max"]);
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

describe("残留清单裁决（31 行按上游，2026-10-04 用户裁定）：clamp 只在模型自己的词表内移动", () => {
  // 12 号票删掉 04 的行为冻结表后，这 31 行的档位全部来自 02 指派表的 7 档投影；
  // 本用例是「clamp 不改变裁决行落线」的新形态：逐行、逐档（含 05 号票新增的
  // minimal/medium/xhigh/max）断言 runtime 结论 === 该行上游投影的结论，
  // 即旧手写结论不再有任何落线入口（对照表见 artifacts/12-adjudication-log.md）。
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

  // 目录外的 minimax id（如 M2.x）落手写 `minimax-always`：无写点（M2.x 官方文档：`disabled`
  // 收下但忽略 → 关不掉）。目录内的 `MiniMax-M3` 自 2026-10-05 起走已登记的开关形状
  // （off/on 两个写点），不再落本类——旧 hand-wins 裁定已被那次登记取代。
  it("无档位可落的裁决行不被 clamp 造出强度档：实发 default（2026-10-05 起恒可发）", () => {
    expect(availableLevelsOf(CLASSES["minimax-always"])).toEqual([]);
    expect(clampThinkingLevel("high", availableLevelsOf(CLASSES["minimax-always"]))).toBe("default");
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
