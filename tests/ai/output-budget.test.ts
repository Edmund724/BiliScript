// tests/ai/output-budget.test.ts
// 输出兜底预算（ai/output-budget.ts）：默认上限/保守上限的取值关系，以及
// 「平台按 max_tokens 超上限拒绝」的判定。判定必须与上下文溢出文案互斥——两者
// 都走 HTTP 400，误判会把「预算给大了」（换个更小的值就能成）当成「输入太长」
// （该转 Map-Reduce），指错方向。

import { describe, expect, it } from "vitest";
import {
  CONSERVATIVE_MAX_TOKENS,
  DEFAULT_MAX_TOKENS,
  isOutputBudgetTooLarge
} from "../../extension/ai/output-budget.js";
// 估算函数住在 analysis-prompts.ts，但封顶值是本模块的政策——两条断言放在一起，
// 「估算上限」与「协议兜底」是不是同源一眼可见。
import { estimateOutputTokens } from "../../extension/ai/analysis-prompts.js";

describe("上限取值", () => {
  it("默认值是给新模型放得下的宽值，保守值仍是旧兜底（退回后可用的下限）", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(32768);
    expect(CONSERVATIVE_MAX_TOKENS).toBe(8192);
    expect(DEFAULT_MAX_TOKENS).toBeGreaterThan(CONSERVATIVE_MAX_TOKENS);
  });
});

describe("estimateOutputTokens 的封顶与兜底同源", () => {
  it("按正文估算的输出预算不再被砍到 8192（5 万字段 25k、超长素材封顶在兜底值）", () => {
    // ratio 0.5（概览是摘要，产出远小于原文）+ floor 2048 是调用方口径。
    expect(estimateOutputTokens(50000, { ratio: 0.5, floor: 2048 })).toBe(25512);
    expect(estimateOutputTokens(200000, { ratio: 0.5, floor: 2048 })).toBe(DEFAULT_MAX_TOKENS);
    expect(estimateOutputTokens(0, { ratio: 0.5, floor: 2048 })).toBe(2048);
  });

  it("显式 ceiling 仍可覆盖（knob 没被写死）", () => {
    expect(estimateOutputTokens(200000, { ratio: 0.5, floor: 2048, ceiling: 8192 })).toBe(8192);
  });
});

describe("isOutputBudgetTooLarge 判定", () => {
  it("典型「输出上限过大」文案 → true", () => {
    const messages = [
      // Anthropic 官方形状：比较式 + 最大输出 token 说明。
      "max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for claude-3-haiku-20240307",
      "Invalid max_tokens value: the valid range of max_tokens is [1, 8192]",
      "max_tokens is too large",
      "max_completion_tokens 超过上限",
      "max_output_tokens exceeds the model limit",
      "请求的 max_tokens 超出模型上限"
    ];
    for (const message of messages) {
      expect(isOutputBudgetTooLarge(message), message).toBe(true);
    }
  });

  it("上下文/输入侧文案 → false（归 isContextLengthOverflow，不做退回）", () => {
    const messages = [
      "This model's maximum context length is 16385 tokens, but your messages resulted in 20000 tokens",
      "context_length_exceeded",
      "prompt is too long",
      "input is too large",
      "请求的上下文长度超出限制"
    ];
    for (const message of messages) {
      expect(isOutputBudgetTooLarge(message), message).toBe(false);
    }
  });

  it("既有溢出样本不被抢走（无比较式/无区间式措辞 → false）", () => {
    // 这些是 completion.test 溢出对照表里的样本，语义是输入超长。
    const messages = [
      "max_tokens limit reached",
      "max tokens exceeded",
      "token limit exceeded",
      'incomplete_details: {"reason":"max_output_tokens"}'
    ];
    for (const message of messages) {
      expect(isOutputBudgetTooLarge(message), message).toBe(false);
    }
  });

  it("与预算无关的错误 / 空值 → false", () => {
    const messages = [
      "401 Unauthorized",
      "model not found",
      "connection reset by peer",
      "rate limit exceeded",
      "",
      "  ",
      undefined,
      null
    ];
    for (const message of messages) {
      expect(isOutputBudgetTooLarge(message), String(message)).toBe(false);
    }
  });
});
