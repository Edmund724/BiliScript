// ai/context.ts buildMessages 的热评展示截断（F2）。
//
// 背景：热评数据通道（mergeHotCommentsFromPayload）保存全文供章节目录解析，
// 聊天语境里的评论展示沿用历史行为——每条截断到 500 字符，避免超长置顶目录
// 灌爆对话上下文。截断只发生在展示点，不影响数据层。

import { describe, expect, it } from "vitest";
import { buildMessages } from "../../extension/ai/context.js";

describe("buildMessages 热评展示截断", () => {
  it("每条评论展示时截断到 500 字符（数据层另有全文通道）", () => {
    const message = "A".repeat(600);
    const messages = buildMessages({
      context: { hotComments: [{ uname: "读者", like: 1, message }] },
      userPrompt: "总结一下"
    });

    const system = String(messages[0].content);
    expect(system).toContain("A".repeat(500));
    expect(system).not.toContain("A".repeat(501));
  });

  it("短于 500 字符的评论原样展示", () => {
    const messages = buildMessages({
      context: { hotComments: [{ uname: "读者", like: 1, message: "短评" }] },
      userPrompt: "总结一下"
    });

    expect(String(messages[0].content)).toContain("短评");
  });

  it("楼中楼续篇（subMessages）不进聊天展示，只供目录解析", () => {
    const messages = buildMessages({
      context: {
        hotComments: [
          { uname: "UP", like: 9, message: "顶层正文", subMessages: ["25:00 楼中楼续篇"] }
        ]
      },
      userPrompt: "总结一下"
    });

    const system = String(messages[0].content);
    expect(system).toContain("顶层正文");
    expect(system).not.toContain("楼中楼续篇");
  });
});
