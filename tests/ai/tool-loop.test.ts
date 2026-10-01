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
  TOOL_CONTENT_MAX_CHARS,
  TOOL_MESSAGE_MAX_CHARS,
  type RunToolLoopInput,
  type ToolStatusPayload
} from "../../extension/ai/tool-loop.js";
import type { ChatMessage } from "../../extension/ai/types.js";
import type { ChatToolDefinition } from "../../extension/ai/protocol-adapter.js";
import {
  executeSearchChain,
  SEARCH_QUOTA_MESSAGE,
  type SearchChainCandidate
} from "../../extension/search/search-chain.js";

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

  it("本轮次数达上限：摘除 tools + system 次数提示注入 + notice，后续轮无工具", async () => {
    capture = makeCapture();
    // maxToolCalls=1：首轮搜索后计数达上限，第二轮不带 tools 出最终回答。
    await runToolLoop(makeInput({ fetchImpl: capture.fetchImpl, maxToolCalls: 1, executeSearch: async () => ({ results: [], platform: "Tavily" }) }));

    expect(capture.calls.length).toBe(2);
    expect(capture.calls[1].tools).toBeUndefined();
    const followup = capture.calls[1].messages;
    // 同名收口（§6.4）：本条只讲「本轮的搜索次数」，平台额度另有文案
    expect(followup.some((m) => m.role === "system" && m.content === "本轮的搜索次数已达上限（1 次），请基于已有搜索结果作答。")).toBe(true);
    expect(capture.notices).toContain("本轮的搜索次数已达上限，请基于已有结果作答");
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

  // §8 验收断言三条（§10 第 52、54、55 行的缺口部分）：500 档 5×500 全保 5 条、
  // 条数按算术递减、极端长正文硬截；序列化真裁条时来源 chip 仍取全量；产物不含
  // truncated 标注。
  it("结果正文预算：500 档 5×500 全保 5 条，条数按算术递减（§10 第 52 行）", async () => {
    const cases = [
      { snippet: 500, kept: 5 },
      { snippet: 1000, kept: 3 },
      { snippet: 1500, kept: 2 },
      { snippet: 2000, kept: 1 }
    ];
    for (const { snippet, kept } of cases) {
      capture = makeCapture();
      const results = Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: "x".repeat(snippet) }));
      await runToolLoop(makeInput({
        fetchImpl: capture.fetchImpl,
        executeSearch: async () => ({ results, platform: "Tavily" })
      }));

      const content = capture.calls[1].messages.find((m) => m.role === "tool")!.content;
      expect(content.length).toBeLessThanOrEqual(TOOL_CONTENT_MAX_CHARS);
      expect(JSON.parse(content), `snippet=${snippet} 的保留条数`).toHaveLength(kept);
    }
  });

  it("结果正文预算：极端 4546×5 → 无完整条目、硬截到 4,000（§10 第 52 行）", async () => {
    capture = makeCapture();
    const results = Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: "x".repeat(4546) }));
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => ({ results, platform: "Firecrawl" })
    }));

    const content = capture.calls[1].messages.find((m) => m.role === "tool")!.content;
    // 单条 JSON 结构开销 + 4546 已超总预算，裁到仅剩 1 条后仍超限 → 硬截字符串
    expect(content.length).toBe(TOOL_CONTENT_MAX_CHARS);
    expect(() => JSON.parse(content)).toThrow();
  });

  it("来源 chip 取全量：序列化真裁条时 tool-status.sources 仍为全量结果集（§8 新不变量 / §10 第 54 行）", async () => {
    capture = makeCapture();
    const results = Array.from({ length: 10 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: "x".repeat(2000) }));
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => ({ results, platform: "Exa" })
    }));

    // 序列化确实裁了（先裁 8 条上限，再按总量裁到 1 条），用户侧仍是全部 10 条
    const content = capture.calls[1].messages.find((m) => m.role === "tool")!.content;
    expect(JSON.parse(content)).toHaveLength(1);
    const done = capture.statuses.find((s) => s.status === "done")!;
    expect(done.resultCount).toBe(10);
    expect(done.sources).toBe(results);
  });

  it("序列化产物不含 truncated 标注（§8「不加截断标注」/ §10 第 55 行）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: async () => ({
        // 2000 字正文 5 条 → 序列化真裁条，正是最容易被加标注的路径
        results: Array.from({ length: 5 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, snippet: "x".repeat(2000) })),
        platform: "Tavily"
      })
    }));

    const content = capture.calls[1].messages.find((m) => m.role === "tool")!.content;
    expect(content).not.toContain("truncated");
    for (const entry of JSON.parse(content) as Array<Record<string, unknown>>) {
      expect(Object.keys(entry)).toEqual(["title", "url", "snippet"]);
    }
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

// ===== 回退链 × 工具链接缝（spec §4 / §6.4 / §10 第 42–44 行）=====
// 正式 executeSearchChain 作为 executeSearch 注入工具循环：链内失败静默（第 42
// 行）、整链无果恰好一条终态 notice（第 43 行）、额度类与其余类两条文案（第 44 行）
// 都在既有 onNotice / onToolStatus 通道上断言，不改动第 47/48 行的既有用例。
const CHAIN_FIRECRAWL: SearchChainCandidate = {
  provider: { id: "search_firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev" },
  apiKey: ""
};
const CHAIN_TAVILY: SearchChainCandidate = {
  provider: { id: "search_tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
  apiKey: "tvly-k"
};
const CHAIN_RESULT = { title: "t2", url: "u2", snippet: "s2" };

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("回退链 × 工具链接缝", () => {
  it("链内单家失败静默：不上 notice、无 failed 状态，直接试下一家（§10 第 42 行）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: (query) =>
        executeSearchChain([CHAIN_FIRECRAWL, CHAIN_TAVILY], query, {
          execute: async (candidate) => {
            if (candidate.provider.id === "search_firecrawl") throw httpError(503);
            return { results: [CHAIN_RESULT], platform: candidate.provider.name };
          }
        })
    }));

    expect(capture.notices).toEqual([]);
    expect(capture.statuses).toEqual([
      { status: "searching", query: "bilibili ai" },
      {
        status: "done",
        query: "bilibili ai",
        resultCount: 1,
        platform: "Tavily",
        sources: [CHAIN_RESULT]
      }
    ]);
  });

  it("整链无果：恰好一条终态 notice，其余类沿用「联网搜索失败：<适配器可读原因>」（§10 第 43、44 行）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: (query) =>
        executeSearchChain([CHAIN_FIRECRAWL, CHAIN_TAVILY], query, {
          execute: async (candidate) => {
            throw httpError(candidate.provider.id === "search_firecrawl" ? 503 : 500);
          }
        })
    }));

    expect(capture.notices).toEqual(["联网搜索失败：HTTP 500"]);
    // 其余类（含鉴权）与额度类的分界：这里不带 searchFailureClass，notice 仍是
    // 「联网搜索失败：<原因>」形态，不落到额度终态句。
    expect(capture.notices[0]).not.toBe(SEARCH_QUOTA_MESSAGE);
    expect(capture.statuses).toEqual([
      { status: "searching", query: "bilibili ai" },
      { status: "failed", query: "bilibili ai" }
    ]);
  });

  it("整链无果且鉴权类在列：notice 沿用其余类文案（§6.4 第 ② 行不单开第三条）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: (query) =>
        executeSearchChain([CHAIN_TAVILY], query, {
          execute: async () => {
            throw httpError(401);
          }
        })
    }));

    expect(capture.notices).toEqual(["联网搜索失败：HTTP 401"]);
  });

  it("整链无果且额度类在列：终态 notice 用 §6.4 额度文案原文（§6.4 第 ① 行 / §10 第 44 行）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: (query) =>
        executeSearchChain([CHAIN_FIRECRAWL, CHAIN_TAVILY], query, {
          execute: async (candidate) => {
            throw httpError(candidate.provider.id === "search_firecrawl" ? 503 : 402);
          }
        })
    }));

    // 额度句已是终态文案：不再套「联网搜索失败：」前缀（全等原文）。
    expect(capture.notices).toEqual([SEARCH_QUOTA_MESSAGE]);
    // tool 内容维持「搜索失败：<reason>」既有形状（§10 第 47/48 行），reason 即额度句。
    const toolMessage = capture.calls[1].messages.find((m) => m.role === "tool")!;
    expect(toolMessage.content).toBe(`搜索失败：${SEARCH_QUOTA_MESSAGE}`);
    expect(capture.statuses).toEqual([
      { status: "searching", query: "bilibili ai" },
      { status: "failed", query: "bilibili ai" }
    ]);
  });

  // §6.5 模型侧引擎注记（§10 第 50 行）：只在降级时附一行，链首成功不附。
  it("链首成功：tool 内容为纯结果 JSON，不附引擎注记（§6.5 / §10 第 50 行）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: (query) =>
        executeSearchChain([CHAIN_FIRECRAWL, CHAIN_TAVILY], query, {
          execute: async (candidate) => ({ results: [CHAIN_RESULT], platform: candidate.provider.name })
        })
    }));

    const content = capture.calls[1].messages.find((m) => m.role === "tool")!.content;
    expect(content).not.toContain("注：");
    expect(JSON.parse(content)).toEqual([CHAIN_RESULT]);
  });

  it("回退成功：tool 内容附恰一行「注：首选 <X> 未成功，以下结果来自 <Y>。」（§6.5 / §10 第 50 行）", async () => {
    capture = makeCapture();
    await runToolLoop(makeInput({
      fetchImpl: capture.fetchImpl,
      executeSearch: (query) =>
        executeSearchChain([CHAIN_FIRECRAWL, CHAIN_TAVILY], query, {
          execute: async (candidate) => {
            if (candidate.provider.id === "search_firecrawl") throw httpError(503);
            return { results: [CHAIN_RESULT], platform: candidate.provider.name };
          }
        })
    }));

    const content = capture.calls[1].messages.find((m) => m.role === "tool")!.content;
    const notes = content.split("\n").filter((line) => line.startsWith("注："));
    expect(notes).toEqual(["注：首选 Firecrawl 未成功，以下结果来自 Tavily。"]);
    // 注记之外结果本体照常进内容
    expect(content).toContain(JSON.stringify([CHAIN_RESULT]));
  });
});
