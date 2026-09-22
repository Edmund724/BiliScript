// ai/conversation.js normalizeConversations 的联网搜索 tool 字段透传测试（spec §2.5）：
// 读取会话（storage 原始值 → NormalizedConversation）时，tool 轮消息不得被剥掉
// tool_calls / tool_call_id / role:"tool"——回放重建（collectHistorySearchTurns）
// 依赖这三个字段聚合搜索回合；同时保持既有裁剪语义（非法消息丢弃、空会话丢弃）。

import { describe, expect, it } from "vitest";
import { normalizeConversations } from "../../extension/ai/conversation.js";

function conversationWith(messages: unknown[]) {
  return [
    {
      id: "conv-1",
      title: "测试会话",
      contextKey: "bilibili:video:BV1test",
      contextTitle: "测试视频",
      contextUrl: "https://www.bilibili.com/video/BV1test",
      isVideoContext: true,
      createdAt: 1000,
      updatedAt: 2000,
      contextRef: { bvid: "BV1test" },
      messages
    }
  ];
}

describe("normalizeConversations 联网搜索 tool 字段透传", () => {
  it("assistant(tool_calls) 消息保留 tool_calls 字段（回放聚合的开启信号）", () => {
    const toolCalls = [
      { id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"测试"}' } }
    ];
    const result = normalizeConversations(conversationWith([
      { role: "user", content: "问" },
      { role: "assistant", content: "", tool_calls: toolCalls }
    ]));
    expect(result[0].messages[1]).toEqual({ role: "assistant", content: "", tool_calls: toolCalls });
  });

  it("role:\"tool\" 消息保留（tool_call_id + content），不再被 filter 丢弃", () => {
    const result = normalizeConversations(conversationWith([
      { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify([{ title: "t", url: "u", snippet: "s" }]) },
      { role: "assistant", content: "答" }
    ]));
    const messages = result[0].messages;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "tool",
      content: JSON.stringify([{ title: "t", url: "u", snippet: "s" }]),
      tool_call_id: "call_1"
    });
  });

  it("普通 user/assistant 消息形状不变（无 tool 字段时不添多余键）", () => {
    const result = normalizeConversations(conversationWith([
      { role: "user", content: "问" },
      { role: "assistant", content: "答" }
    ]));
    expect(result[0].messages).toEqual([
      { role: "user", content: "问" },
      { role: "assistant", content: "答" }
    ]);
  });

  it("既有裁剪语义不回退：非法消息仍丢弃", () => {
    const result = normalizeConversations(conversationWith([
      { role: "system", content: "系统消息" },
      { role: "assistant", content: 42 },
      { role: "user", content: "有效" }
    ]));
    expect(result[0].messages.map((m) => m.role)).toEqual(["user"]);
    expect(result[0].messages[0].content).toBe("有效");
  });
});
