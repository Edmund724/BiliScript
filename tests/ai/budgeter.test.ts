import { describe, expect, it } from "vitest";
import { makeSubtitleBody } from "../setup.js";
import {
  buildBudgetPlan,
  estimateTokens,
  REDUCE_GROUP_INPUT_CHARS
} from "../../extension/ai/budgeter.js";

describe("estimateTokens", () => {
  it("非字符串返回 0", () => {
    expect(estimateTokens(undefined)).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(12345)).toBe(0);
    expect(estimateTokens({ length: 5 })).toBe(0);
    expect(estimateTokens(["ab"])).toBe(0);
  });

  it("空串 / 空白串按字符数（不含 trim）处理", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("   ")).toBe(3);
  });

  it("字符数 × 1.0（中文按字符逐个计）", () => {
    expect(estimateTokens("你好")).toBe(2);
    expect(estimateTokens("hello world")).toBe(11);
    expect(estimateTokens("x".repeat(1000))).toBe(1000);
  });
});

describe("buildBudgetPlan 判模式与各档位", () => {
  it("空输入（body 缺省 / chapters 缺省）→ single 空计划", () => {
    const plan = buildBudgetPlan();
    expect(plan.totalChars).toBe(0);
    expect(plan.estimatedTokens).toBe(0);
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
    expect(plan.needsReduce).toBe(false);
  });

  it("body=[] 显式空数组 → single，1 次调用", () => {
    const plan = buildBudgetPlan({ body: [] });
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
    expect(plan.needsReduce).toBe(false);
  });

  it("恰好 200k → single，整篇一次成稿", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(200000) });
    expect(plan.totalChars).toBe(200000);
    expect(plan.estimatedTokens).toBe(200000);
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
    expect(plan.needsReduce).toBe(false);
  });

  it("200k 边界一越（200001）→ map-reduce", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(200001) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments.length).toBe(5);
    expect(plan.estimatedCalls).toBe(6);
    expect(plan.needsReduce).toBe(false);
  });

  it("210k → 5 段小结 + 1 次成稿 ≈ 6 次调用", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(210000) });
    expect(plan.totalChars).toBe(210000);
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(5);
    expect(plan.segments.map((s) => s.chars)).toEqual([50000, 50000, 50000, 50000, 10000]);
    expect(plan.estimatedCalls).toBe(6);
    expect(plan.needsReduce).toBe(false);
  });

  it("500k 恰好触发线下 → 10 段，不归并（needsReduce=false）", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(500000) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(10);
    expect(plan.needsReduce).toBe(false);
    expect(plan.estimatedCalls).toBe(11);
  });

  it("501k（>500k）→ 11 段 + 归并调用，调用数超过段数+1", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(501000) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(11);
    expect(plan.needsReduce).toBe(true);
    expect(plan.estimatedCalls).toBeGreaterThan(plan.segments.length + 1);
    expect(plan.estimatedCalls).toBe(15);
  });

  it("estimatedCalls 随长度增长而增大（501k < 1000k）", () => {
    const small = buildBudgetPlan({ body: makeSubtitleBody(501000) });
    const large = buildBudgetPlan({ body: makeSubtitleBody(1000000) });
    expect(large.estimatedCalls).toBeGreaterThan(small.estimatedCalls);
  });
});

describe("buildBudgetPlan 分段边界", () => {
  it("无章节：按时间戳顺序累积到 50k 预算收段", () => {
    const plan = buildBudgetPlan({ body: makeSubtitleBody(210000) });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(250);
    expect(plan.segments[0].chars).toBe(50000);
    expect(plan.segments[0].items).toHaveLength(50);
    expect(plan.segments[4].items).toHaveLength(10);
  });

  it("命中章节 from：在章节起点切断对齐（段尾停在上一章结尾）", () => {
    const body = makeSubtitleBody(220000);
    const chapters = [{ from: 100, to: 200, title: "第二章" }];
    const plan = buildBudgetPlan({ body, chapters });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(5);
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(100);
    expect(plan.segments[0].chars).toBe(20000);
    expect(plan.segments[0].items).toHaveLength(20);
    expect(plan.segments[1].from).toBe(100);
    expect(plan.segments[1].chars).toBe(50000);
  });

  it("章节 from 落在两条字幕之间（非逐秒相等）也按边界对齐", () => {
    const body = makeSubtitleBody(220000);
    const chapters = [{ from: 102, to: 200, title: "第二章" }];
    const plan = buildBudgetPlan({ body, chapters });
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(105);
    expect(plan.segments[0].items).toHaveLength(21);
    expect(plan.segments[1].from).toBe(105);
  });

  it("空 content 项跳过计入，且 from/to 映回段内首末非空项", () => {
    const body = makeSubtitleBody(230000);
    body[50].content = "";
    const plan = buildBudgetPlan({ body });
    expect(plan.totalChars).toBe(230000 - 1000);
    expect(plan.mode).toBe("map-reduce");
    expect(plan.segments).toHaveLength(5);
    expect(plan.segments[0].items).toHaveLength(50);
    expect(plan.segments[0].from).toBe(0);
    expect(plan.segments[0].to).toBe(250);
    expect(plan.segments[1].from).toBe(255);
  });

  it("body 项缺 content / trim 后为空 → 不计入、跳过", () => {
    const body = [
      { from: 0, to: 2, content: "hello" },
      { from: 2, to: 4 },
      { from: 4, to: 6, content: "   " },
      { from: 6, to: 8, content: "world" }
    ];
    const plan = buildBudgetPlan({ body });
    expect(plan.totalChars).toBe(10);
    expect(plan.estimatedTokens).toBe(10);
    expect(plan.mode).toBe("single");
    expect(plan.segments).toEqual([]);
    expect(plan.estimatedCalls).toBe(1);
  });
});

describe("buildBudgetPlan options：入口侧预算参数化（溢出放宽预算重跑用）", () => {
  it("segmentInputChars 减半 → 段数翻倍；mode / needsReduce 不受影响", () => {
    const body = makeSubtitleBody(600000);
    const normal = buildBudgetPlan({ body });
    expect(normal.segments).toHaveLength(12);
    expect(normal.needsReduce).toBe(true);

    const tight = buildBudgetPlan({ body }, { segmentInputChars: 25000, reduceGroupInputChars: 50000 });
    expect(tight.segments).toHaveLength(24);
    expect(tight.mode).toBe("map-reduce");
    expect(tight.needsReduce).toBe(true);
  });

  it("reduceGroupInputChars 随 plan 带出，estimatedCalls 的归并层数随之重算", () => {
    const body = makeSubtitleBody(600000);
    const normal = buildBudgetPlan({ body });
    expect(normal.reduceGroupInputChars).toBe(REDUCE_GROUP_INPUT_CHARS);
    expect(normal.estimatedCalls).toBe(16);

    const tight = buildBudgetPlan({ body }, { segmentInputChars: 25000, reduceGroupInputChars: 50000 });
    expect(tight.reduceGroupInputChars).toBe(50000);
    expect(tight.estimatedCalls).toBe(31);
  });

  it("非法 options（0 / 负数 / 非数）回落默认常量", () => {
    const body = makeSubtitleBody(220000);
    const plan = buildBudgetPlan({ body }, { segmentInputChars: 0, reduceGroupInputChars: -1 });
    expect(plan.segments).toHaveLength(5);
    expect(plan.reduceGroupInputChars).toBe(REDUCE_GROUP_INPUT_CHARS);
  });
});
