// tests/ai/error-text-norms.test.ts
// HTTP 400 错误文本规一化与判据族（ai/error-text-norms.ts）真值表测试。

import { describe, expect, it } from "vitest";
import {
  BUDGET_PARAM_RE,
  CONTEXT_OVERFLOW_DIRECT_PATTERNS,
  CONTEXT_OVERFLOW_RE,
  CONTEXT_OVERFLOW_SUBJECT_RE,
  INPUT_SIDE_RE,
  normalizeErrorText,
  OVER_LIMIT_RE
} from "../../extension/ai/error-text-norms.js";

describe("normalizeErrorText 规一化真值表", () => {
  it("空值与缺失值回退空串", () => {
    expect(normalizeErrorText(undefined)).toBe("");
    expect(normalizeErrorText(null)).toBe("");
  });

  it("空字符串与空白字符串保留原字面并小写", () => {
    expect(normalizeErrorText("")).toBe("");
    expect(normalizeErrorText("   ")).toBe("   ");
  });

  it("大小写混合英文统一转小写", () => {
    expect(normalizeErrorText("MAX_TOKENS")).toBe("max_tokens");
    expect(normalizeErrorText("Context Length Exceeded")).toBe("context length exceeded");
    expect(normalizeErrorText("Invalid max_tokens Value: the Valid Range is [1, 8192]")).toBe(
      "invalid max_tokens value: the valid range is [1, 8192]"
    );
  });

  it("非字符串强制转换为字符串并小写", () => {
    expect(normalizeErrorText(12345)).toBe("12345");
    expect(normalizeErrorText(true)).toBe("true");
    expect(normalizeErrorText(new Error("Maximum Context Length Exceeded"))).toBe(
      "error: maximum context length exceeded"
    );
    expect(normalizeErrorText({})).toBe("[object object]");
  });
});

describe("输出上限判据族（参数名 / 过限 / 输入侧排除）", () => {
  it("BUDGET_PARAM_RE：输出侧参数名命中（小写规范）", () => {
    const hits = [
      "max_tokens",
      "max_completion_tokens",
      "max_output_tokens",
      "maximum output tokens",
      "最大输出",
      "输出 tokens",
      "输出tokens",
      "输出token"
    ];
    for (const phrase of hits) {
      expect(BUDGET_PARAM_RE.test(phrase), phrase).toBe(true);
    }

    const misses = [
      "max tokens",
      "tokens",
      "context_length",
      "prompt_tokens"
    ];
    for (const phrase of misses) {
      expect(BUDGET_PARAM_RE.test(phrase), phrase).toBe(false);
    }
  });

  it("OVER_LIMIT_RE：过限措辞命中（小写规范）", () => {
    const hits = [
      "too large",
      "too big",
      "greater than",
      "larger than",
      "valid range",
      "out of range",
      "invalid",
      "exceed",
      "> 8192",
      ">1024",
      "不能大于",
      "不能超过",
      "超出",
      "超过"
    ];
    for (const phrase of hits) {
      expect(OVER_LIMIT_RE.test(phrase), phrase).toBe(true);
    }

    const misses = [
      "within range",
      "success",
      "accepted",
      "ok"
    ];
    for (const phrase of misses) {
      expect(OVER_LIMIT_RE.test(phrase), phrase).toBe(false);
    }
  });

  it("INPUT_SIDE_RE：输入侧词命中（作为排除项）", () => {
    const hits = [
      "context",
      "prompt",
      "input",
      "message",
      "messages",
      "上下文",
      "输入",
      "提示词"
    ];
    for (const phrase of hits) {
      expect(INPUT_SIDE_RE.test(phrase), phrase).toBe(true);
    }

    const misses = [
      "output",
      "completion",
      "response",
      "result"
    ];
    for (const phrase of misses) {
      expect(INPUT_SIDE_RE.test(phrase), phrase).toBe(false);
    }
  });
});

describe("上下文溢出判据族（直接子串 + 主语/超限双正则）", () => {
  it("CONTEXT_OVERFLOW_DIRECT_PATTERNS：包含完整直接匹配子串集合", () => {
    expect(CONTEXT_OVERFLOW_DIRECT_PATTERNS.length).toBe(21);
    for (const pattern of CONTEXT_OVERFLOW_DIRECT_PATTERNS) {
      expect(pattern).toBe(pattern.toLowerCase());
      const testString = `prefix ${pattern} suffix`;
      expect(testString.includes(pattern)).toBe(true);
    }
  });

  it("双正则粗判：主语 + 超限组合命中", () => {
    const subjects = ["context", "token", "tokens", "length", "上下文", "长度", "令牌", "窗口"];
    const overflows = ["exceed", "limit", "maximum", "too many", "too long", "overflow", "超出", "超过", "超限", "上限", "最大"];

    for (const sub of subjects) {
      expect(CONTEXT_OVERFLOW_SUBJECT_RE.test(sub), sub).toBe(true);
    }
    for (const ov of overflows) {
      expect(CONTEXT_OVERFLOW_RE.test(ov), ov).toBe(true);
    }

    // 组合样本
    const combined = "model context window is full and exceeded";
    expect(CONTEXT_OVERFLOW_SUBJECT_RE.test(combined)).toBe(true);
    expect(CONTEXT_OVERFLOW_RE.test(combined)).toBe(true);
  });
});
