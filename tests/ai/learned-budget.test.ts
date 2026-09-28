// tests/ai/learned-budget.test.ts
// 会话内存级的「平台学到的输出上限」（ai/learned-budget.ts）：作用域键的口径、
// 只夹低不抬高、以及 canRaiseBudget 的判定——它的唯一用途是让「加倍重跑」在
// 平台上限已到顶时不要发出一个与前一次完全相同的请求。

import { describe, expect, it } from "vitest";
import {
  budgetScopeKey,
  canRaiseBudget,
  clampToLearnedMaxTokens,
  noteLearnedMaxTokens,
  resetLearnedBudgetsForTests
} from "../../extension/ai/learned-budget.js";

const SCOPE = { baseUrl: "https://api.example.com/v1", model: "test-model" };

describe("作用域键", () => {
  it("按 baseUrl（去尾斜杠）+ model 组装：同平台同模型同一个键", () => {
    expect(budgetScopeKey(SCOPE)).toBe(budgetScopeKey({ baseUrl: "https://api.example.com/v1/", model: "test-model" }));
    expect(budgetScopeKey(SCOPE)).not.toBe(budgetScopeKey({ baseUrl: "https://api.example.com/v1", model: "other" }));
    expect(budgetScopeKey(SCOPE)).not.toBe(budgetScopeKey({ baseUrl: "https://api.other.com/v1", model: "test-model" }));
  });

  it("缺字段归一为空串（不抛错）", () => {
    expect(budgetScopeKey({})).toBe(budgetScopeKey({ baseUrl: "", model: "" }));
  });
});

describe("夹取与记忆", () => {
  it("没学到 → 原值透传；学到 → min；请求为 null 保持 null（协议本来不发这个字段就不发）", () => {
    resetLearnedBudgetsForTests();
    expect(clampToLearnedMaxTokens(32768, SCOPE)).toBe(32768);
    expect(clampToLearnedMaxTokens(null, SCOPE)).toBeNull();

    noteLearnedMaxTokens(SCOPE, 8192);
    expect(clampToLearnedMaxTokens(32768, SCOPE)).toBe(8192);
    expect(clampToLearnedMaxTokens(4096, SCOPE)).toBe(4096);
    // null 不被学到的值「变出」字段：openai 协议不发明文的现状不因本模块改变。
    expect(clampToLearnedMaxTokens(null, SCOPE)).toBeNull();
  });

  it("只夹低不抬高：学到的值大于请求值时不生效", () => {
    resetLearnedBudgetsForTests();
    noteLearnedMaxTokens(SCOPE, 65536);
    expect(clampToLearnedMaxTokens(32768, SCOPE)).toBe(32768);
  });

  it("作用域隔离：换个模型/端点不共享", () => {
    resetLearnedBudgetsForTests();
    noteLearnedMaxTokens(SCOPE, 8192);
    expect(clampToLearnedMaxTokens(32768, { baseUrl: SCOPE.baseUrl, model: "other" })).toBe(32768);
    expect(clampToLearnedMaxTokens(32768, { baseUrl: "https://api.other.com/v1", model: SCOPE.model })).toBe(32768);
  });

  it("resetLearnedBudgetsForTests 清空（测试间不串状态）", () => {
    noteLearnedMaxTokens(SCOPE, 8192);
    resetLearnedBudgetsForTests();
    expect(clampToLearnedMaxTokens(32768, SCOPE)).toBe(32768);
  });
});

describe("canRaiseBudget（加倍重跑值不值得发）", () => {
  it("没学到 → from < to 即 true", () => {
    resetLearnedBudgetsForTests();
    expect(canRaiseBudget(SCOPE, 32768, 65536)).toBe(true);
    expect(canRaiseBudget(SCOPE, 2048, 4096)).toBe(true);
  });

  it("学到的上限压在两值之间 → 抬高仍有效（真能要到更多空间）", () => {
    resetLearnedBudgetsForTests();
    noteLearnedMaxTokens(SCOPE, 32768);
    expect(canRaiseBudget(SCOPE, 8192, 65536)).toBe(true);
  });

  it("学到的上限 ≤ from → false（重跑会发出与前一次完全相同的请求）", () => {
    resetLearnedBudgetsForTests();
    noteLearnedMaxTokens(SCOPE, 8192);
    expect(canRaiseBudget(SCOPE, 25512, 51024)).toBe(false);
    expect(canRaiseBudget(SCOPE, 8192, 65536)).toBe(false);
  });
});
