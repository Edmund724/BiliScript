// ai-usage-telemetry T2a 单测：ai/usage-stats.ts（响应 usage 的实测 chars→token 比学习）。
// 四面：比例学习（首样本即可用 / 丢弃规则 / 中位数抗单点异常 / 只留最近 8 个 / per-scope
// 隔离）、observedOutputCap（T3 的数据源，本票不消费）、estimateTokensFromChars
// （无样本回落 CHAR_PER_TOKEN、有样本用实测比）。
// 纯内存模块：用例间经 resetUsageStatsForTests 清桶（与 learned-budget 同纪律）。
// 失败方式先行：首样本被当噪声丢掉、越界样本污染中位数、窗口不生效（旧样本不淘汰）、
// 非 length 的截断证据被记进 cap、作用域不隔离导致跨平台混样、换算回落错系数。

import { beforeEach, describe, expect, it } from "vitest";
import {
  estimateTokensFromChars,
  learnedCharsPerToken,
  noteUsageSample,
  observedOutputCap,
  resetUsageStatsForTests
} from "../../extension/ai/usage-stats.js";
import { CHAR_PER_TOKEN } from "../../extension/ai/budgeter.js";

const SCOPE = { baseUrl: "https://api.example.com/v1", model: "test-model" };
const OTHER_MODEL = { baseUrl: SCOPE.baseUrl, model: "other-model" };
const OTHER_HOST = { baseUrl: "https://api.other.com/v1", model: SCOPE.model };

// 记一个 payloadChars / inputTokens = ratio 的样本（inputTokens 固定 100，便于心算）。
function noteRatio(ratio: number, extra: Record<string, unknown> = {}): void {
  noteUsageSample(SCOPE, { payloadChars: ratio * 100, inputTokens: 100, ...extra });
}

beforeEach(() => {
  resetUsageStatsForTests();
});

describe("learnedCharsPerToken：比例学习", () => {
  it("无样本 → undefined（首样本之前不猜）", () => {
    expect(learnedCharsPerToken(SCOPE)).toBeUndefined();
    expect(learnedCharsPerToken(undefined)).toBeUndefined();
  });

  it("首样本即可用：payloadChars / inputTokens 直接成为学到的比", () => {
    noteRatio(1.5);
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(1.5);
  });

  it("inputTokens 非有限或 ≤0 → 样本丢弃（0 / 负数 / NaN / Infinity / 缺失）", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined]) {
      resetUsageStatsForTests();
      noteUsageSample(SCOPE, { payloadChars: 1000, inputTokens: bad as number | undefined });
      expect(learnedCharsPerToken(SCOPE), `inputTokens=${String(bad)} 应被丢弃`).toBeUndefined();
    }
  });

  it("payloadChars 非有限 → 比值非有限，样本丢弃", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      resetUsageStatsForTests();
      noteUsageSample(SCOPE, { payloadChars: bad as number | undefined, inputTokens: 100 });
      expect(learnedCharsPerToken(SCOPE), `payloadChars=${String(bad)} 应被丢弃`).toBeUndefined();
    }
  });

  it("比值越界丢弃，端点 [0.2, 20] 含在内", () => {
    noteRatio(0.19);
    expect(learnedCharsPerToken(SCOPE)).toBeUndefined();

    resetUsageStatsForTests();
    noteRatio(20.01);
    expect(learnedCharsPerToken(SCOPE)).toBeUndefined();

    resetUsageStatsForTests();
    noteRatio(0.2);
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(0.2);

    resetUsageStatsForTests();
    noteRatio(20);
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(20);
  });

  it("中位数抗单点异常：单个 20 倍的离群样本不把学到的比拉走", () => {
    noteRatio(1);
    noteRatio(2);
    noteRatio(3);
    noteRatio(20);
    // 中位数 (2+3)/2 = 2.5；算术均值 6.5 才是被离群点带偏的那个。
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(2.5);
  });

  it("样本超 8 个只取最近 8 个（更早的逐出）", () => {
    for (let i = 0; i < 8; i += 1) {
      noteRatio(1);
    }
    for (let i = 0; i < 8; i += 1) {
      noteRatio(10);
    }
    // 最近 8 个全是 10；若旧样本还在，16 个样本的中位数会是 5.5。
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(10);

    resetUsageStatsForTests();
    for (let i = 0; i < 7; i += 1) {
      noteRatio(1);
    }
    noteRatio(10);
    // 窗口没满：8 个样本 [1×7, 10] 的中位数仍是 1。
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(1);
  });

  it("per-scope 隔离：换模型 / 换端点各自成桶，缺字段归一后仍隔离", () => {
    noteRatio(2);
    expect(learnedCharsPerToken(OTHER_MODEL)).toBeUndefined();
    expect(learnedCharsPerToken(OTHER_HOST)).toBeUndefined();

    noteUsageSample(OTHER_MODEL, { payloadChars: 300, inputTokens: 100 });
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(2);
    expect(learnedCharsPerToken(OTHER_MODEL)).toBeCloseTo(3);

    // 尾斜杠归一（budgetScopeKey 口径）：同一平台写法不同不另开桶。
    noteUsageSample({ baseUrl: `${SCOPE.baseUrl}/`, model: SCOPE.model }, { payloadChars: 400, inputTokens: 100 });
    expect(learnedCharsPerToken(SCOPE)).toBeCloseTo(3); // [2, 4] 的中位数
  });
});

describe("observedOutputCap：截断证据（供 T3，本票不消费）", () => {
  it("无 length 样本 → undefined；stop 样本即使 outputTokens 更大也不影响", () => {
    noteRatio(1, { outputTokens: 99999, finishReason: "stop" });
    expect(observedOutputCap(SCOPE)).toBeUndefined();
  });

  it("length 样本记 outputTokens，取最大值", () => {
    noteRatio(1, { outputTokens: 8192, finishReason: "length" });
    expect(observedOutputCap(SCOPE)).toBe(8192);

    noteRatio(1, { outputTokens: 4096, finishReason: "length" });
    expect(observedOutputCap(SCOPE)).toBe(8192);

    noteRatio(1, { outputTokens: 16384, finishReason: "length" });
    expect(observedOutputCap(SCOPE)).toBe(16384);
  });

  it("length 但 outputTokens 缺失 / 非有限 / ≤0 → 不更新 cap", () => {
    for (const bad of [undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      resetUsageStatsForTests();
      noteUsageSample(SCOPE, { payloadChars: 100, inputTokens: 100, outputTokens: bad, finishReason: "length" });
      expect(observedOutputCap(SCOPE), `outputTokens=${String(bad)} 不应入 cap`).toBeUndefined();
    }
  });

  it("被丢弃的样本不参与：比值越界的 length 样本不入 cap（样本丢弃是整条丢弃）", () => {
    noteUsageSample(SCOPE, { payloadChars: 10, inputTokens: 1000, outputTokens: 8192, finishReason: "length" });
    expect(learnedCharsPerToken(SCOPE)).toBeUndefined();
    expect(observedOutputCap(SCOPE)).toBeUndefined();
  });

  it("per-scope 隔离", () => {
    noteRatio(1, { outputTokens: 8192, finishReason: "length" });
    expect(observedOutputCap(OTHER_MODEL)).toBeUndefined();
  });
});

describe("estimateTokensFromChars：护栏数字的唯一换算函数", () => {
  it("无样本回落 CHAR_PER_TOKEN", () => {
    expect(estimateTokensFromChars(SCOPE, 1000)).toBe(Math.round(1000 / CHAR_PER_TOKEN));
  });

  it("有样本用实测比（四舍五入）", () => {
    noteRatio(2.5);
    expect(estimateTokensFromChars(SCOPE, 1000)).toBe(400);

    resetUsageStatsForTests();
    noteRatio(3);
    expect(estimateTokensFromChars(SCOPE, 1000)).toBe(333);
    expect(estimateTokensFromChars(SCOPE, 1001)).toBe(334);
  });

  it("作用域隔离：别的 scope 仍回落 CHAR_PER_TOKEN", () => {
    noteRatio(2.5);
    expect(estimateTokensFromChars(OTHER_MODEL, 1000)).toBe(Math.round(1000 / CHAR_PER_TOKEN));
  });

  it("字符数缺失 / 非有限 / 非正 → 0（注入方 fake plan 不带 totalChars 时护栏数字仍是 0，与改动前一致）", () => {
    expect(estimateTokensFromChars(SCOPE, undefined)).toBe(0);
    expect(estimateTokensFromChars(SCOPE, Number.NaN)).toBe(0);
    expect(estimateTokensFromChars(SCOPE, -5)).toBe(0);
    expect(estimateTokensFromChars(undefined, 1000)).toBe(Math.round(1000 / CHAR_PER_TOKEN));
  });
});
