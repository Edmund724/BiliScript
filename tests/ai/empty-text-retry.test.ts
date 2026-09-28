// tests/ai/empty-text-retry.test.ts
// 空正文重跑的策略单源（ai/empty-text-retry.ts）：触发判定 + 重试预算。
// 预算与协议兜底上限（ai/output-budget 的 DEFAULT_MAX_TOKENS）绑定——「加倍」
// 只有相对首发实际发出的兜底值才成立；兜底上调后重试预算必须同步，否则重试
// 反而比首发更小。

import { describe, expect, it } from "vitest";
import {
  EMPTY_TEXT_RETRY_MAX_TOKENS,
  isEmptyTextRetryable,
  retryBudget
} from "../../extension/ai/empty-text-retry.js";
import { DEFAULT_MAX_TOKENS } from "../../extension/ai/output-budget.js";

describe("重试预算", () => {
  it("base 缺省（chat 链：首发不带预算）→ 兜底上限的倍加", () => {
    expect(EMPTY_TEXT_RETRY_MAX_TOKENS).toBe(DEFAULT_MAX_TOKENS * 2);
    expect(retryBudget()).toBe(EMPTY_TEXT_RETRY_MAX_TOKENS);
    expect(retryBudget()).toBeGreaterThan(DEFAULT_MAX_TOKENS);
  });

  it("base 有值 → 加倍；超过定值封顶", () => {
    expect(retryBudget(2048)).toBe(4096);
    expect(retryBudget(DEFAULT_MAX_TOKENS * 4)).toBe(EMPTY_TEXT_RETRY_MAX_TOKENS);
  });
});

describe("触发判定", () => {
  it("有正文（含仅空白）不重试", () => {
    expect(isEmptyTextRetryable({ hasBody: true })).toBe(false);
  });

  it("finishReason 传入时只认 length；缺省不约束", () => {
    expect(isEmptyTextRetryable({ finishReason: "length", hasBody: false })).toBe(true);
    expect(isEmptyTextRetryable({ finishReason: "stop", hasBody: false })).toBe(false);
    expect(isEmptyTextRetryable({ finishReason: null, hasBody: false })).toBe(false);
    expect(isEmptyTextRetryable({ hasBody: false })).toBe(true);
  });
});
