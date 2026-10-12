// tests/ai/thinking-resolution-invariants.test.ts — applyClassRule 的全表联合不变量扫描
// 与一格行为冻结（架构评审候选 3，构造收敛半边）。
//
// applyClassRule 的结果只由「规则 + 偏好档 + 流态」决定，是纯查表的全函数：所以它的输出
// 可以用一组**联合不变量**描述，而不必逐格点名。本文件做三件事：
//   1. 全表扫描（CLASSES × 档位词表全部取值 × stream 两态）：每一格都断言四条联合不变量
//      —— 实发档必在可用集内（unknown 哨兵的 null 语义不属本扫描，扫描输入永远是真实规则）、
//      落线词汇的载荷判定与线格式映射同结论、tokenParam 与规则事实同进同出、
//      offUnavailable / offFallback 的组合合法；
//   2. 一格行为冻结：稀疏档规则（off 仅流式 + 单个强度档）× 非流式 × 强度档偏好——
//      thinking-profiles.ts 的 ThinkingResolution.effectiveLevel 上登记的那一格
//      （clamp 落 off 而写点被非流式阻断 → 线上一个字段都不发）。逐字段钉住现状，
//      本文件不评价该口径；
//   3. 结构不变量：结论里的 thinkingClass 恒等于规则事实（出口写字面量的不对称若回潮，
//      这里会红）。
//
// 本文件在收敛前后都必须全绿：它是回归锁，不是红测试。

import { describe, expect, it } from "vitest";
import {
  AI_THINKING_LEVEL_VALUES,
  CLASSES,
  applyClassRule,
  availableLevelsOf,
  enableThinking,
  reasoningEffort,
  type ClassRule,
  type ThinkingVocabulary
} from "../../extension/ai/thinking-profiles.js";
import { openaiVocabularyFields } from "../../extension/ai/thinking-wire-map.js";

// 哨兵 kind（有结论但不发言 / 没有结论）：与「带载荷」互斥。
const SENTINEL_KINDS: ReadonlySet<string> = new Set(["noFields", "unknown"]);

// 载荷判定按**线格式映射**复算（而不是复用事实层内部的谓词）：两条判据同源同结论是本扫描
// 要盯的事——映射发得出字段 ⇔ 词汇不是哨兵。
function carriesPayload(vocabulary: ThinkingVocabulary): boolean {
  return Object.keys(openaiVocabularyFields(vocabulary)).length > 0;
}

// 扫描格：规则 × 档位（含 default）× 流态。以词表实际取值为准，不另写一份字面量。
const CELLS = Object.entries(CLASSES).flatMap(([name, rule]) =>
  AI_THINKING_LEVEL_VALUES.flatMap((level) => [true, false].map((stream) => ({ name, rule, level, stream })))
);

describe("applyClassRule 全表联合不变量（CLASSES × 档位词表 × stream 两态）", () => {
  it("扫描覆盖全部规则 × 全部档位 × 两流态", () => {
    expect(CELLS).toHaveLength(Object.keys(CLASSES).length * AI_THINKING_LEVEL_VALUES.length * 2);
  });

  it("每格：实发档 ∈ 可用集 ∪ {default}；载荷判定与哨兵互斥；tokenParam 同进同出；off 组合合法", () => {
    for (const { name, rule, level, stream } of CELLS) {
      const at = `${name} · ${level} · stream=${stream}`;
      const resolution = applyClassRule(rule, level, stream);
      const available = availableLevelsOf(rule);

      // ① 实发档只能落在本次请求的可用集里，或是不干预的 `default`（availableLevelsOf
      //    从不产 default）。null 只属 UNKNOWN 哨兵，不在本扫描的输入域内。
      const effective = resolution.effectiveLevel;
      expect(effective === "default" || available.some((candidate) => candidate === effective), `${at} · effectiveLevel`).toBe(true);

      // ② 落线词汇非空（带载荷）⇔ 出口不是哨兵：线格式映射与事实层的载荷判据同结论。
      expect(carriesPayload(resolution.vocabulary), `${at} · vocabulary 载荷`).toBe(!SENTINEL_KINDS.has(resolution.vocabulary.kind));

      // ③ tokenParam 是规则事实的投影：规则有就带上，规则没有就不许凭空出现。
      expect(resolution.tokenParam, `${at} · tokenParam`).toBe(rule.tokenParam);

      // ④ off 级联的两位标记组合合法：offFallback="low" 必伴随 offUnavailable；
      //    offUnavailable 只可能由「偏好 off 且本次写点不可用」触发（default / 强度档 / never
      //    都不得置位）；never 是关思考天然成立，静默且无提示。
      expect(["low", null], `${at} · offFallback`).toContain(resolution.offFallback);
      if (resolution.offFallback === "low") {
        expect(resolution.offUnavailable, `${at} · offFallback=low ⇒ offUnavailable`).toBe(true);
      }
      if (resolution.offUnavailable) {
        expect(level, `${at} · offUnavailable ⇒ 偏好 off`).toBe("off");
        expect(rule.thinkingClass, `${at} · offUnavailable ⇒ 非 never`).not.toBe("never");
      }
      if (rule.thinkingClass === "never") {
        expect(resolution.offUnavailable, `${at} · never 静默`).toBe(false);
        expect(resolution.offFallback, `${at} · never 静默`).toBeNull();
      }

      // ⑤ 结论里的血统恒等于规则事实：出口各处写字面量的分叉（如 never 分支硬写 "never"）
      //    若回潮成不对称，这里红。
      expect(resolution.thinkingClass, `${at} · thinkingClass`).toBe(rule.thinkingClass);
    }
  });
});

describe("行为冻结：稀疏档规则 × 非流式 × 强度档偏好（登记格）", () => {
  // 登记口径（见 ThinkingResolution.effectiveLevel 的「已知残留瑕疵」）：稀疏档规则下，
  // 强度档偏好 clamp 到「被本次请求阻断的 off」时 effectiveLevel 写 off，而线上一个字段
  // 都不发——剔 off 只发生在偏好本身就是 off 的那条级联上。今天的真实表里取不到这种规则
  // （唯一带 streamOnly 的规则是开关型、全部非 off 档可用），故本格只由本用例看守。
  const sparse: ClassRule = {
    thinkingClass: "hybrid",
    off: { vocabulary: enableThinking(false), streamOnly: true },
    high: { vocabulary: reasoningEffort("high") }
  };

  it("非流式：clamp 落 off、写点被阻断 → 不发字段，且不置 off 级联标记", () => {
    const resolution = applyClassRule(sparse, "minimal", false);

    expect(resolution.effectiveLevel).toBe("off");
    expect(resolution.vocabulary).toEqual({ kind: "noFields" });
    expect(openaiVocabularyFields(resolution.vocabulary)).toEqual({});
    expect(resolution.tokenParam).toBeUndefined();
    expect(resolution.offUnavailable).toBe(false);
    expect(resolution.offFallback).toBeNull();
    expect(resolution.thinkingClass).toBe("hybrid");
  });

  it("流式对照：同一个 off 写点本次可用 → 发 enable_thinking:false（实发档仍是 off）", () => {
    const resolution = applyClassRule(sparse, "minimal", true);

    expect(resolution.effectiveLevel).toBe("off");
    expect(openaiVocabularyFields(resolution.vocabulary)).toEqual({ enable_thinking: false });
    expect(resolution.offUnavailable).toBe(false);
    expect(resolution.offFallback).toBeNull();
  });
});
