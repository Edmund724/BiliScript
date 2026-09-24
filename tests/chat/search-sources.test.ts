// chat/search-sources.ts 纯函数测试（spec §2.5/§4：来源从历史 tool 消息重建）。
// 覆盖：完整 JSON 解析 / 2,000 字符截断后的残缺 JSON 容错析取 / 非法输入 /
// 回放回合聚合（assistant tool_calls 查询词 + tool 结果 → 时间线卡重建输入）。
import { describe, expect, it } from "vitest";
import {
  parseToolSourceArray,
  collectHistorySearchTurns
} from "../../extension/chat/search-sources.js";

describe("parseToolSourceArray", () => {
  it("完整 JSON 数组：逐条归一为 { title, url, snippet }", () => {
    const content = JSON.stringify([
      { title: "DeepSeek-V3 解读", url: "https://a.example.com/x", snippet: "专家并行……" },
      { title: "", url: "", snippet: null }
    ]);
    expect(parseToolSourceArray(content)).toEqual([
      { title: "DeepSeek-V3 解读", url: "https://a.example.com/x", snippet: "专家并行……" },
      { title: "", url: "", snippet: "" }
    ]);
  });

  it("2,000 字符截断的残缺 JSON：只析取完整的对象条目，丢弃截断尾巴", () => {
    const complete = [
      { title: "条目一", url: "https://a.com/1", snippet: "s1" },
      { title: "条目二", url: "https://b.com/2", snippet: "s2" },
      { title: "条目三", url: "https://c.com/3", snippet: "s3" }
    ];
    // 模拟 TOOL_MESSAGE_MAX_CHARS 截断：第三个对象被腰斩。
    const truncated = JSON.stringify(complete).slice(0, JSON.stringify(complete).indexOf("条目三") + 12);
    expect(truncated.endsWith("}")).toBe(false);
    expect(parseToolSourceArray(truncated)).toEqual([complete[0], complete[1]]);
  });

  it("非 JSON / 空串 / 非数组：返回空数组", () => {
    expect(parseToolSourceArray("搜索失败：HTTP 429")).toEqual([]);
    expect(parseToolSourceArray("")).toEqual([]);
    expect(parseToolSourceArray(null)).toEqual([]);
    expect(parseToolSourceArray('{"title":"x"}')).toEqual([]);
  });

  it("数组内混入非对象条目：跳过，不影响其余", () => {
    const content = JSON.stringify(["bad", { title: "t", url: "u", snippet: "s" }, 42]);
    expect(parseToolSourceArray(content)).toEqual([{ title: "t", url: "u", snippet: "s" }]);
  });
});

describe("collectHistorySearchTurns", () => {
  it("按回合聚合：assistant(tool_calls) 的查询词 + tool 消息结果，编号跨搜索累计", () => {
    const history = [
      { role: "user", content: "问" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "web_search", arguments: '{"query":"第一问"}' } },
          { id: "call_2", function: { name: "web_search", arguments: '{"query":"第二问"}' } }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify([{ title: "A", url: "https://a.com", snippet: "sa" }]) },
      { role: "tool", tool_call_id: "call_2", content: JSON.stringify([{ title: "B", url: "https://b.com", snippet: "sb" }, { title: "C", url: "https://c.com", snippet: "sc" }]) },
      { role: "assistant", content: "答 [1] 与 [2]。" }
    ];
    const turns = collectHistorySearchTurns(history);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantIndex).toBe(4);
    expect(turns[0].queries).toEqual(["第一问", "第二问"]);
    expect(turns[0].sources).toEqual([
      { title: "A", url: "https://a.com", snippet: "sa" },
      { title: "B", url: "https://b.com", snippet: "sb" },
      { title: "C", url: "https://c.com", snippet: "sc" }
    ]);
    expect(turns[0].resultCounts).toEqual([1, 2]);
  });

  it("多回合各成一条；无 tool 轮的 assistant 不产出", () => {
    const history = [
      { role: "user", content: "问一" },
      { role: "assistant", content: "答一" },
      { role: "user", content: "问二" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c", function: { name: "web_search", arguments: '{"query":"q"}' } }]
      },
      { role: "tool", tool_call_id: "c", content: "搜索失败：HTTP 429" },
      { role: "assistant", content: "答二" }
    ];
    const turns = collectHistorySearchTurns(history);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantIndex).toBe(5);
    expect(turns[0].queries).toEqual(["q"]);
    expect(turns[0].sources).toEqual([]);
    expect(turns[0].resultCounts).toEqual([0]);
  });

  it("arguments 解析失败的 tool call：查询词记空串，回合仍产出", () => {
    const history = [
      { role: "user", content: "问" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c", function: { name: "web_search", arguments: "not-json" } }]
      },
      { role: "tool", tool_call_id: "c", content: "[]" },
      { role: "assistant", content: "答" }
    ];
    expect(collectHistorySearchTurns(history)[0].queries).toEqual([""]);
  });

  it("同一 user 回合内多个 tool-turn 聚为一张多步骤卡（累积落盘形状：连续多组 assistant(tool_calls)+tool）", () => {
    const history = [
      { role: "user", content: "问" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "web_search", arguments: '{"query":"第一轮"}' } }]
      },
      { role: "tool", tool_call_id: "call_1", content: JSON.stringify([{ title: "A", url: "https://a.com", snippet: "sa" }]) },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_2", function: { name: "web_search", arguments: '{"query":"第二轮"}' } }]
      },
      { role: "tool", tool_call_id: "call_2", content: JSON.stringify([{ title: "B", url: "https://b.com", snippet: "sb" }]) },
      { role: "assistant", content: "答 [1] 与 [2]。" }
    ];
    const turns = collectHistorySearchTurns(history);
    expect(turns).toHaveLength(1);
    expect(turns[0].assistantIndex).toBe(5);
    expect(turns[0].queries).toEqual(["第一轮", "第二轮"]);
    expect(turns[0].resultCounts).toEqual([1, 1]);
    expect(turns[0].sources).toEqual([
      { title: "A", url: "https://a.com", snippet: "sa" },
      { title: "B", url: "https://b.com", snippet: "sb" }
    ]);
  });
});
