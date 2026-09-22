// ai/tool-loop.ts 联网搜索工具循环测试（spec §2.3）。
// 假 fetch 全覆盖（completion.test 同款 sseResponse），覆盖：
// 1. 单轮 tool_calls → 搜索 → 二次调用续跑（tool 消息回填 / tool-status /
//    tool-turn 副本）；
// 2. 配额用尽：摘除 tools + system 额度提示注入 + 后续轮不再带 tools；
// 3. 搜索失败降级：「搜索失败」tool 消息 + notice，回答不中断；
// 4. 平台不支持 tools（不可重试 4xx）：notice + 摘除 tools 无联网重发一次；
// 5. 轮内多条 tool call：逐条计数 / 8 条截断 / 持久化副本 2000 字符截断。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runToolLoop,
  webSearchTool,
  WEB_SEARCH_TOOL,
  TOOL_MESSAGE_MAX_CHARS,
  type RunToolLoopInput,
  type ToolStatusPayload
} from "../../extension/ai/tool-loop.js";
import type { ChatMessage } from "../../extension/ai/types.js";
import type { ChatToolDefinition } from "../../extension/ai/completion.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// 假 fetch 工厂：显式声明签名，mock.calls 才带 [url, init] 元组类型；返回值只
// 消费 Response 的少数字段，形状断言在这里统一收口（同 tests/search 惯例）。
function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>) {
  return vi.fn<FetchImpl>(impl as FetchImpl);
}

// makeCapture 捕获的请求体形状（adapter 组装后的 OpenAI 兼容 body）。
interface CapturedRequest {
  tools?: ChatToolDefinition[];
  tool_choice?: string;
  messages: ChatMessage[];
  max_tokens?: number;
}

interface Capture {
  calls: CapturedRequest[];
  statuses: ToolStatusPayload[];
  notices: string[];
  toolTurns: ChatMessage[][];
  fetchImpl: ReturnType<typeof mockFetch>;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// 假 Response：只实现测试消费的字段，形状断言收口在返回处。
function sseResponse(chunks: string[]): Response {
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
  } as unknown as Response;
}

// SSE chunk：delta 载荷 + choice 级 finish_reason（缺省时序列化即省略该键）。
function sseData(delta: unknown, finishReason?: string) {
  return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
}

function textResponse(text: string, ok = false, status = 400): Response {
  return { ok, status, text: vi.fn(async () => text), json: vi.fn() } as unknown as Response;
}

// 第一轮 SSE：一条 web_search tool call（id/name/arguments 跨 chunk 分片）。
const TOOL_ROUND_CHUNKS = [
  sseData({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"que' } }] }),
  sseData({ tool_calls: [{ index: 0, function: { arguments: 'ry":"bilibili ai"}' } }] }),
  sseData({}, "tool_calls")
];

// 第二轮 SSE：纯文本 + stop。
const FINAL_ROUND_CHUNKS = [sseData({ content: "回答" }), sseData({}, "stop")];

function makeCapture(): Capture {
  return {
    calls: [],
    statuses: [],
    notices: [],
    toolTurns: [],
    fetchImpl: mockFetch(async (_url, init) => {
      const body = JSON.parse(init!.body as string);
      capture.calls.push(body);
      return capture.calls.length === 1
        ? sseResponse(TOOL_ROUND_CHUNKS)
        : sseResponse(FINAL_ROUND_CHUNKS);
    })
  };
}
// 前置声明（fetchImpl 闭包引用 capture 自身）。
let capture: Capture;

function makeInput(overrides: Partial<RunToolLoopInput> = {}): RunToolLoopInput {
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
      capture.calls.push(JSON.parse(init!.body as string));
      return capture.calls.length <= 3
        ? ({ ok: false, status: 400, text: vi.fn(async () => '{"error":"tools not supported"}'), json: vi.fn() } as unknown as Response)
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
      capture.calls.push(JSON.parse(init!.body as string));
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
      capture.calls.push(JSON.parse(init!.body as string));
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
    expect(toolMsg!.content.length).toBeLessThanOrEqual(4000);
    // 持久化副本截 2,000
    const persistedTool = capture.toolTurns[0].find((m) => m.role === "tool");
    expect(persistedTool!.content.length).toBe(TOOL_MESSAGE_MAX_CHARS);
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

  it("toolDefinition 变体：解释链传 requireCitations:false，描述不带 [n] 且随请求注入", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" }),
      toolDefinition: webSearchTool({ requireCitations: false })
    }));
    expect(capture.calls[0].tools).toHaveLength(1);
    expect(capture.calls[0].tools![0].function.name).toBe("web_search");
    expect(capture.calls[0].tools![0].function.description).not.toContain("[n]");
  });

  it("非流式轮返回最终文本（选区解释链消费，无事件拼装）", async () => {
    let call = 0;
    const json = vi.fn(async () => {
      call += 1;
      return call === 1
        ? { choices: [{ message: { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"术语"}' } }] }, finish_reason: "tool_calls" }] }
        : { choices: [{ message: { role: "assistant", content: "最终解释" }, finish_reason: "stop" }] };
    });
    const fetchImpl = mockFetch(async () => ({ ok: true, status: 200, json }));
    const result = await runToolLoop(makeInput({
      stream: false,
      fetchImpl,
      executeSearch: async () => ({ results: [{ title: "t", url: "u", snippet: "s" }], platform: "Tavily" })
    }));
    expect(result).toBe("最终解释");
  });

  it("maxTokens 透传 chatCompletion（解释链钉 320 输出上限）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({ maxTokens: 320, fetchImpl: capture.fetchImpl, executeSearch: async () => ({ results: [], platform: "Tavily" }) }));
    expect(capture.calls[0].max_tokens).toBe(320);
  });
});
