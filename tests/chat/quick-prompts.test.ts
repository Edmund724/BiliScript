// tests/chat/quick-prompts.test.ts
// 初始快捷问题生成链的纯函数契约（extension/chat/quick-prompts.ts）：
// 字幕节选、生成提示词组装、模型输出解析、自定义/生成/兜底三档取用。
// 生成编排（取平台、发请求、写缓存）在 tests/reader/quick-prompts.test.ts。

import { describe, expect, it } from "vitest";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";
import {
  MAX_INITIAL_QUICK_PROMPTS,
  MAX_QUICK_PROMPT_CHARS,
  buildQuickPromptExcerpt,
  buildQuickPromptMessages,
  normalizePromptList,
  parseQuickPrompts,
  resolveInitialQuickPrompts
} from "../../extension/chat/quick-prompts.js";

function body(items: string[]) {
  return items.map((content, index) => ({ from: index * 5, to: index * 5 + 5, content }));
}

describe("normalizePromptList（问题列表归一：去空白、去空项、去重、限条数）", () => {
  it("非数组一律空表；空白项与重复项丢弃", () => {
    expect(normalizePromptList(undefined)).toEqual([]);
    expect(normalizePromptList("总结视频")).toEqual([]);
    expect(normalizePromptList([" 总结视频 ", "", "   ", "总结视频"])).toEqual(["总结视频"]);
  });

  it("最多三条（多余项截断）", () => {
    expect(normalizePromptList(["一", "二", "三", "四"])).toHaveLength(MAX_INITIAL_QUICK_PROMPTS);
    expect(normalizePromptList(["一", "二", "三", "四"])).toEqual(["一", "二", "三"]);
  });

  it("maxChars > 0 时按字数截断（生成结果短句化），默认不截断（用户自定义不限长）", () => {
    const long = "整".repeat(MAX_QUICK_PROMPT_CHARS + 10);
    expect(normalizePromptList([long])[0]).toBe(long);
    const truncated = normalizePromptList([long], MAX_QUICK_PROMPT_CHARS)[0];
    expect(truncated.length).toBe(MAX_QUICK_PROMPT_CHARS);
    expect(truncated.endsWith("…")).toBe(true);
  });
});

describe("buildQuickPromptExcerpt（字幕节选）", () => {
  it("短字幕整体拼接（不截断）", () => {
    expect(buildQuickPromptExcerpt(body(["今天聊缓存穿透", "先看三种成因"])))
      .toBe("今天聊缓存穿透先看三种成因");
  });

  it("长字幕取头/中/尾三段（每段不超预算三分之一）", () => {
    const items = Array.from({ length: 60 }, (_item, index) => `第${index}句${"内容".repeat(20)}`);
    const excerpt = buildQuickPromptExcerpt(body(items), 300);
    // 三段 + 两个省略号分隔
    expect(excerpt.split("……")).toHaveLength(3);
    expect(excerpt.length).toBeLessThanOrEqual(300 + 2 * "……".length);
    expect(excerpt).toContain("第0句");
    expect(excerpt).toContain("第59句");
  });

  it("空字幕 / 非法项 / 非正预算 → 空串", () => {
    expect(buildQuickPromptExcerpt([])).toBe("");
    expect(buildQuickPromptExcerpt(undefined)).toBe("");
    expect(buildQuickPromptExcerpt([{ content: "   " }, null])).toBe("");
    expect(buildQuickPromptExcerpt(body(["有内容"]), 0)).toBe("");
  });
});

describe("buildQuickPromptMessages（生成提示词）", () => {
  it("system 钉住输出形状与条数，user 带标题与字幕节选", () => {
    const messages = buildQuickPromptMessages({ title: "缓存穿透怎么解", excerpt: "今天聊缓存穿透" });
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("JSON");
    expect(messages[0].content).toContain(String(MAX_INITIAL_QUICK_PROMPTS));
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("缓存穿透怎么解");
    expect(messages[1].content).toContain("今天聊缓存穿透");
  });
});

describe("parseQuickPrompts（模型输出解析：宽容、去噪、限三条）", () => {
  it("纯 JSON 数组", () => {
    expect(parseQuickPrompts('["核心结论是什么","有哪些数据","怎么落地"]'))
      .toEqual(["核心结论是什么", "有哪些数据", "怎么落地"]);
  });

  it("带 markdown 代码围栏 / 前后解说：只取数组本体", () => {
    expect(parseQuickPrompts('好的，结果如下：\n```json\n["问题一","问题二"]\n```\n希望有帮助'))
      .toEqual(["问题一", "问题二"]);
  });

  it("退化为逐行列表：剥掉序号、项目符号与引号", () => {
    expect(parseQuickPrompts('1. "问题一"\n2. - 问题二\n3) 问题三'))
      .toEqual(["问题一", "问题二", "问题三"]);
  });

  it("超过三条只取前三条；重复项去重；非字符串项丢弃", () => {
    expect(parseQuickPrompts('["一","二","三","四"]')).toEqual(["一", "二", "三"]);
    expect(parseQuickPrompts('["一","一","二"]')).toEqual(["一", "二"]);
    expect(parseQuickPrompts('[1,null,"二"]')).toEqual(["二"]);
  });

  it("空输入 / 无可用内容 → 空表（调用方回落固定问题）", () => {
    expect(parseQuickPrompts("")).toEqual([]);
    expect(parseQuickPrompts(undefined)).toEqual([]);
    expect(parseQuickPrompts("模型今天不想说话")).toEqual([]);
    expect(parseQuickPrompts("[]")).toEqual([]);
  });
});

describe("resolveInitialQuickPrompts（用户自定义 > 生成结果 > 固定兜底）", () => {
  it("用户配了自定义：自定义优先，长句不截断", () => {
    const custom = ["整理这期视频的内容，输出结构化总结：主题、核心观点、关键细节、结论与可执行启发。"];
    expect(resolveInitialQuickPrompts(custom, ["生成一", "生成二"])).toEqual(custom);
  });

  it("自定义为空（留空 = 自动生成）：用生成结果", () => {
    expect(resolveInitialQuickPrompts([], ["生成一", "生成二"])).toEqual(["生成一", "生成二"]);
    expect(resolveInitialQuickPrompts(undefined, ["生成一"])).toEqual(["生成一"]);
  });

  it("自定义与生成都为空：回落固定三条兜底", () => {
    expect(resolveInitialQuickPrompts([], null)).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
    expect(resolveInitialQuickPrompts(undefined, undefined)).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
    expect(DEFAULT_INITIAL_QUICK_PROMPTS).toHaveLength(MAX_INITIAL_QUICK_PROMPTS);
  });
});
