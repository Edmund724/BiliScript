// ai/context.ts buildMessages 的 tool 历史过滤（联网搜索管线，spec §2.5）。
// includeToolHistory 开启时保留 assistant(tool_calls) 与 tool 消息（多轮追问
// 保持工具上下文）；关闭时整体丢弃——无 tools 请求里出现 tool 消息部分平台
// 会报 4xx。
import { describe, expect, it } from "vitest";
import { buildMessages } from "../../extension/ai/context.js";

const TOOL_HISTORY = [
  { role: "user", content: "问" },
  { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] },
  { role: "tool", tool_call_id: "call_1", content: "[]" },
  { role: "assistant", content: "答" }
];

describe("buildMessages includeToolHistory", () => {
  it("开启：assistant(tool_calls) 与 tool 消息原样透传", () => {
    const messages = buildMessages({ userPrompt: "再问", history: TOOL_HISTORY, includeToolHistory: true });
    // system + 4 条历史 + 当前提问
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "assistant", "user"]);
    expect(messages[2].tool_calls).toEqual(TOOL_HISTORY[1].tool_calls);
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "[]" });
  });

  it("关闭（缺省）：tool 消息与 assistant(tool_calls) 整体丢弃，行为回归", () => {
    const messages = buildMessages({ userPrompt: "再问", history: TOOL_HISTORY });
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("畸形历史防御：tool 消息缺 tool_call_id / assistant.tool_calls 非数组不透传", () => {
    const messages = buildMessages({
      userPrompt: "再问",
      history: [
        { role: "tool", content: "无 id" },
        { role: "assistant", content: "", tool_calls: "不是数组" }
      ],
      includeToolHistory: true
    });
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });
});
