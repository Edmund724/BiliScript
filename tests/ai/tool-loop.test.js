// ai/tool-loop.ts 联网搜索工具循环测试（spec §2.3）。
// 假 fetch 全覆盖（completion.test 同款 sseResponse），覆盖：
// 1. 单轮 tool_calls → 搜索 → 二次调用续跑（tool 消息回填 / tool-status /
//    tool-turn 副本）；
// 2. 配额用尽：摘除 tools + system 额度提示注入 + 后续轮不再带 tools；
// 3. 搜索失败降级：「搜索失败」tool 消息 + notice，回答不中断；
// 4. 平台不支持 tools（不可重试 4xx）：notice + 摘除 tools 无联网重发一次；
// 5. 轮内多条 tool call：逐条计数 / 8 条截断 / 持久化副本 2000 字符截断。
import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolLoop, WEB_SEARCH_TOOL, TOOL_MESSAGE_MAX_CHARS } from "../../extension/ai/tool-loop.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sseResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true };
          }
        };
      }
    }
  };
}

// SSE chunk：delta 载荷 + choice 级 finish_reason。
function sseData(delta, finishReason) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

function textResponse(text, ok = false, status = 400) {
  return { ok, status, text: vi.fn(async () => text), json: vi.fn() };
}

// 第一轮 SSE：一条 web_search tool call（id/name/arguments 跨 chunk 分片）。
const TOOL_ROUND_CHUNKS = [
  sseData({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"que' } }] }),
  sseData({ tool_calls: [{ index: 0, function: { arguments: 'ry":"bilibili ai"}' } }] }),
  sseData({}, "tool_calls")
];

// 第二轮 SSE：纯文本 + stop。
const FINAL_ROUND_CHUNKS = [sseData({ content: "回答" }), sseData({}, "stop")];

function makeCapture() {
  return {
    calls: [],
    statuses: [],
    notices: [],
    toolTurns: [],
    fetchImpl: vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      capture.calls.push(body);
      return capture.calls.length === 1
        ? sseResponse(TOOL_ROUND_CHUNKS)
        : sseResponse(FINAL_ROUND_CHUNKS);
    })
  };
}
// 前置声明（fetchImpl 闭包引用 capture 自身）。
let capture;

function makeInput(overrides = {}) {
  return {
    provider: PROVIDER,
    messages: [{ role: "user", content: "hi" }],
    maxToolCalls: 5,
    executeSearch: async () => {
      throw new Error("未注入 executeSearch");
    },
    onToolStatus: (p) => capture.statuses.push(p),
    onNotice: (t) => capture.notices.push(t),
    onToolTurn: (ms) => capture.toolTurns.push(ms),
    ...overrides
  };
}

describe("runToolLoop 工具调用循环", () => {
  it("单轮搜索后二次调用：tool 消息回填、tool-status 逐条、tool-turn 副本随行", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async (query) => {
        expect(query).toBe("bilibili ai");
        return { results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" };
      }
    }));

    expect(capture.calls.length).toBe(2);
    expect(capture.calls[0].tools).toEqual([{ type: "function", function: expect.objectContaining({ name: "web_search" }) }]);
    expect(capture.calls[0].tool_choice).toBe("auto");
    // 二次调用：assistant(tool_calls) + tool 结果已追加，本轮仍带 tools（配额未满）
    const followup = capture.calls[1].messages;
    expect(followup).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: "", tool_calls: [expect.objectContaining({ id: "call_1" })] }),
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: JSON.stringify([{ title: "t", url: "u", snippet: "s" }]) })
    ]));
    expect(capture.calls[1].tools).toEqual([expect.objectContaining({ function: expect.objectContaining({ name: "web_search" }) })]);
    expect(capture.statuses).toEqual([
      { status: "searching", query: "bilibili ai" },
      { status: "done", query: "bilibili ai", resultCount: 1, platform: "Tavily", sources: [{ title: "t", url: "u", snippet: "s" }] }
    ]);
    expect(capture.notices).toEqual([]);
    // 持久化副本：assistant + tool 两条
    expect(capture.toolTurns.length).toBe(1);
    expect(capture.toolTurns[0][0]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(capture.toolTurns[0][1]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
  });

  it("跨 chunk 分片聚合：id/name/arguments 按 index 拼接为一条 tool call", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({ fetchImpl: capture.fetchImpl, executeSearch: async () => ({ results: [], platform: "Tavily" }) }));
    expect(capture.statuses[0]).toMatchObject({ status: "searching", query: "bilibili ai" });
  });

  it("配额用尽：摘除 tools + system 额度提示注入 + notice，后续轮无工具", async () => {
    capture = makeCapture();
    // maxToolCalls=1：首轮搜索后计数达上限，第二轮不带 tools 出最终回答。
    await runToolLoop(makeInput({ fetchImpl: capture.fetchImpl, maxToolCalls: 1, executeSearch: async () => ({ results: [], platform: "Tavily" }) }));

    expect(capture.calls.length).toBe(2);
    expect(capture.calls[1].tools).toBeUndefined();
    const followup = capture.calls[1].messages;
    expect(followup.some((m) => m.role === "system" && m.content.includes("搜索额度已用尽（1 次上限）"))).toBe(true);
    expect(capture.notices.some((t) => t.includes("搜索额度已用尽"))).toBe(true);
  });

  it("搜索失败降级：「搜索失败」tool 消息 + failed 状态 + notice，回答不中断", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => {
        throw new Error("HTTP 503");
      }
    }));

    const followup = capture.calls[1].messages;
    expect(followup).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "tool", tool_call_id: "call_1", content: "搜索失败：HTTP 503" })
    ]));
    expect(capture.statuses).toEqual([
      { status: "searching", query: "bilibili ai" },
      { status: "failed", query: "bilibili ai" }
    ]);
    expect(capture.notices).toContain("联网搜索失败：HTTP 503");
    // 失败不计入配额语义本轮仍继续：二次调用照常带 tools
    expect(capture.calls[1].tools).toEqual([expect.anything()]);
  });

  it("平台不支持 tools（不可重试 4xx）：notice + 摘除 tools 无联网重发一次", async () => {
    capture = makeCapture();
    // stream 默认重试 2 次（共 3 次 400），第 4 次为 tool-loop 摘除后的重发。
    capture.fetchImpl.mockImplementation(async (_url, init) => {
      capture.calls.push(JSON.parse(init.body));
      return capture.calls.length <= 3
        ? { ok: false, status: 400, text: vi.fn(async () => '{"error":"tools not supported"}'), json: vi.fn() }
        : sseResponse(FINAL_ROUND_CHUNKS);
    });
    await runToolLoop(makeInput({ fetchImpl: capture.fetchImpl, executeSearch: async () => ({ results: [], platform: "Tavily" }) }));

    expect(capture.notices).toContain("当前平台不支持工具调用，本轮未联网");
    expect(capture.calls.length).toBe(4);
    expect(capture.calls[3].tools).toBeUndefined();
    // 消息数组未被 tool 轮污染
    expect(capture.calls[3].messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("轮内多条 tool call：逐条搜索计数，注入截 8 条（短 snippet）", async () => {
    capture = makeCapture();
    const doubleRound = [
      sseData({ tool_calls: [
        { index: 0, id: "call_a", type: "function", function: { name: "web_search", arguments: '{"query":"甲"}' } },
        { index: 1, id: "call_b", type: "function", function: { name: "web_search", arguments: '{"query":"乙"}' } }
      ] }),
      sseData({}, "tool_calls")
    ];
    capture.fetchImpl.mockImplementation(async (_url, init) => {
      capture.calls.push(JSON.parse(init.body));
      return capture.calls.length === 1 ? sseResponse(doubleRound) : sseResponse(FINAL_ROUND_CHUNKS);
    });

    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      maxToolCalls: 5,
      executeSearch: async () => ({
        results: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: "s" })),
        platform: "Exa"
      })
    }));

    const searchCalls = capture.statuses.filter((s) => s.status === "searching");
    expect(searchCalls.map((s) => s.query)).toEqual(["甲", "乙"]);
    const toolMsgs = capture.calls[1].messages.filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    // 注入：单次最多 8 条（超出丢弃）
    expect(JSON.parse(toolMsgs[0].content).length).toBe(8);
    // 配额计数：2 条 tool call 计 2，未达 5，第三轮仍带 tools
    expect(capture.calls[1].tools).toEqual([expect.anything()]);
  });

  it("单条 snippet 过大：注入截 4,000 字符，持久化副本截 2,000 字符", async () => {
    capture = makeCapture();
    capture.fetchImpl.mockImplementation(async (_url, init) => {
      capture.calls.push(JSON.parse(init.body));
      return capture.calls.length === 1 ? sseResponse(TOOL_ROUND_CHUNKS) : sseResponse(FINAL_ROUND_CHUNKS);
    });

    const bigSnippet = "x".repeat(3000);
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => ({
        results: Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: bigSnippet })),
        platform: "Tavily"
      })
    }));

    const toolMsg = capture.calls[1].messages.find((m) => m.role === "tool");
    // 注入总量 ≤ 4,000（先裁条数，单条仍超限才硬截字符串）
    expect(toolMsg.content.length).toBeLessThanOrEqual(4000);
    // 持久化副本截 2,000
    const persistedTool = capture.toolTurns[0].find((m) => m.role === "tool");
    expect(persistedTool.content.length).toBe(TOOL_MESSAGE_MAX_CHARS);
  });

  it("done 状态带搜索结果 sources（时间线卡 chip 行 / 内联引用数据源）", async () => {
    capture = makeCapture();
    const results = [
      { title: "标题一", url: "https://a.com/1", snippet: "摘录一" },
      { title: "标题二", url: "https://b.com/2", snippet: "摘录二" }
    ];
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => ({ results, platform: "Brave" })
    }));

    const done = capture.statuses.find((s) => s.status === "done");
    expect(done).toMatchObject({ status: "done", query: "bilibili ai", resultCount: 2, platform: "Brave", sources: results });
  });

  it("web_search 工具描述带 [n] 引用要求（prompt 侧编号契约）", () => {
    expect(WEB_SEARCH_TOOL.function.description).toContain("[n]");
  });
});
