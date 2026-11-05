// ai/context.ts buildMessages 不再将评论区注入到聊天上下文。
//
// 背景：热评数据通道保存全文供章节目录解析（shared/chapter-outline.ts），
// 但默认的对话与总结上下文不再塞入热门评论，杜绝 token 浪费与评论区梗/情绪干扰。

import { describe, expect, it } from "vitest";
import { buildMessages } from "../../extension/ai/context.js";

describe("buildMessages 评论区上下文剥离", () => {
  it("即便 context 中有 hotComments，也不向提示词注入评论内容", () => {
    const messages = buildMessages({
      context: {
        hotComments: [
          { uname: "热评用户", like: 999, message: "这是很火的评论正文", subMessages: ["这是楼中楼"] }
        ]
      },
      userPrompt: "总结一下"
    });

    const system = String(messages[0].content);
    expect(system).not.toContain("这是很火的评论正文");
    expect(system).not.toContain("这是楼中楼");
    expect(system).not.toContain("热门评论");
  });
});
