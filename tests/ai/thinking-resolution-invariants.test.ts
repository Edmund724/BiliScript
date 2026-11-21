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

const SENTINEL_KINDS: ReadonlySet<string> = new Set(["noFields", "unknown"]);

function carriesPayload(vocabulary: ThinkingVocabulary): boolean {
  return Object.keys(openaiVocabularyFields(vocabulary)).length > 0;
}

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

      const effective = resolution.effectiveLevel;
      expect(effective === "default" || available.some((candidate) => candidate === effective), `${at} · effectiveLevel`).toBe(true);

      expect(carriesPayload(resolution.vocabulary), `${at} · vocabulary 载荷`).toBe(!SENTINEL_KINDS.has(resolution.vocabulary.kind));

      expect(resolution.tokenParam, `${at} · tokenParam`).toBe(rule.tokenParam);

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

      expect(resolution.thinkingClass, `${at} · thinkingClass`).toBe(rule.thinkingClass);
    }
  });
});

describe("行为冻结：稀疏档规则 × 非流式 × 强度档偏好（登记格）", () => {
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
