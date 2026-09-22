// ai/adapters/anthropic.js 单测（multi-protocol-ai 第二部分）：线格式映射逐条对照
// research/anthropic-wire-mapping.md——请求构造（system 剥出 / max_tokens 兜底 /
// 思考档位改写 / tool 双向翻译）、SSE 事件流（text/thinking/tool_use 聚合 / 流内
// error / 未知事件宽容）、非流式解析、错误 detail 提取。能力声明对照 spec
// 「被有意不支持的能力」。

import { describe, expect, it, vi } from "vitest";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { PROTOCOL_ADAPTERS, resolveAdapter } from "../../extension/ai/protocol-adapter.js";
import { chatCompletion } from "../../extension/ai/completion.js";
import type { StreamChatEvent } from "../../extension/ai/types.js";

// SSE 流式响应：chunks 按 read() 顺序返回（编码为 UTF-8 字节）。
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

function anthropicSseData(event: Record<string, unknown>) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

describe("capabilities（spec「被有意不支持的能力」逐条落点）", () => {
  it("tools/thinkingProfiles 为 true；unsupported 三个稳定键", () => {
    const { capabilities } = anthropicAdapter;
    expect(capabilities.tools).toBe(true);
    expect(capabilities.thinkingProfiles).toBe(true);
    expect(Object.keys(capabilities.unsupported).sort()).toEqual([
      "parallel-tool-use-flattened",
      "server-tools",
      "thinking-roundtrip"
    ]);
  });

  it("注册表读路径：resolveAdapter(\"anthropic\") 命中本 adapter", () => {
    expect(resolveAdapter("anthropic")).toBe(PROTOCOL_ADAPTERS.anthropic);
    expect(PROTOCOL_ADAPTERS.anthropic).toBe(anthropicAdapter);
  });
});

describe("endpoint / authHeaders", () => {
  it("endpoint = baseUrl + /v1/messages（baseUrl 已去尾斜杠）", () => {
    expect(anthropicAdapter.endpoint("https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/messages");
  });

  it("鉴权：x-api-key + anthropic-version，非 Bearer；无 key 只带 version", () => {
    expect(anthropicAdapter.authHeaders("sk-ant")).toEqual({
      "x-api-key": "sk-ant",
      "anthropic-version": "2023-06-01"
    });
    expect(anthropicAdapter.authHeaders(undefined)).toEqual({ "anthropic-version": "2023-06-01" });
  });
});

describe("buildBody（请求映射，research §2/§4）", () => {
  const base = { model: "claude-x", stream: false, probe: false, baseUrl: "https://api.anthropic.com" };

  it("system 剥为顶层参数；多条按出现顺序 \\n\\n 拼接（限制点 2）", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      messages: [
        { role: "system", content: "s1" },
        { role: "user", content: "hi" },
        { role: "system", content: "s2" }
      ]
    });
    expect(body.system).toBe("s1\n\ns2");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("max_tokens 必填兜底 4096；显式值透传（限制点 1）", () => {
    expect(anthropicAdapter.buildBody({ ...base, messages: [] }).max_tokens).toBe(4096);
    expect(anthropicAdapter.buildBody({ ...base, messages: [], maxTokens: 8192 }).max_tokens).toBe(8192);
    // 探针由 core 代劳传 1：直接透传不兜底。
    expect(anthropicAdapter.buildBody({ ...base, messages: [], maxTokens: 1 }).max_tokens).toBe(1);
  });

  it("tools：input_schema 改名透传 + tool_choice 显式压平并行（限制点 9）", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      messages: [],
      tools: [{ type: "function", function: { name: "web_search", description: "d", parameters: { type: "object" } } }]
    });
    expect(body.tools).toEqual([{ name: "web_search", description: "d", input_schema: { type: "object" } }]);
    expect(body.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true });
  });

  it("原生服务端工具（名字带日期版本后缀）不翻译：server-tools 限制点", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      messages: [],
      tools: [
        { type: "function", function: { name: "web_search_20250305", description: "原生", parameters: { type: "object" } } },
        { type: "function", function: { name: "web_search", description: "客户端", parameters: { type: "object" } } }
      ]
    });
    expect(body.tools).toEqual([{ name: "web_search", description: "客户端", input_schema: { type: "object" } }]);
    // 全部被过滤则不出现 tools/tool_choice（对齐无 tools 请求形状）。
    const onlyNative = anthropicAdapter.buildBody({
      ...base,
      messages: [],
      tools: [{ type: "function", function: { name: "web_search_20250305", description: "原生", parameters: { type: "object" } } }]
    });
    expect(onlyNative.tools).toBeUndefined();
    expect(onlyNative.tool_choice).toBeUndefined();
  });

  it("assistant tool_calls → tool_use 块；arguments 非 JSON 兜底 { query: 原文 }（限制点 4）", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      messages: [
        { role: "assistant", content: "让我查一下", tool_calls: [
          { id: "tu_1", type: "function", function: { name: "web_search", arguments: "not-json" } },
          { id: "tu_2", type: "function", function: { name: "web_search", arguments: "{\"query\":\"abc\"}" } }
        ] },
        { role: "tool", tool_call_id: "tu_1", content: "r1" },
        { role: "tool", tool_call_id: "tu_2", content: "r2" }
      ]
    });
    expect(body.messages).toEqual([
      { role: "assistant", content: [
        { type: "text", text: "让我查一下" },
        { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "not-json" } },
        { type: "tool_use", id: "tu_2", name: "web_search", input: { query: "abc" } }
      ] },
      // 连续 tool 消息合并进同一条 user 消息的多个 tool_result 块（research §4）。
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "r1" },
        { type: "tool_result", tool_use_id: "tu_2", content: "r2" }
      ] }
    ]);
  });

  it("思考档位改写：effort 词汇 → thinking enabled + budget_tokens（限制点 11）", () => {
    // deepseek-v3.2 = hybrid-effort：high → reasoning_effort high → Anthropic 开思考。
    const body = anthropicAdapter.buildBody({
      ...base,
      presetId: "deepseek",
      thinkingLevel: "high",
      messages: [{ role: "user", content: "hi" }],
      model: "deepseek-v3.2"
    });
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("关思考三种词汇殊途同归：一律不发 thinking 字段", () => {
    // off 显式关（thinking:{type:"disabled"}）。
    const off = anthropicAdapter.buildBody({
      ...base,
      presetId: "deepseek",
      thinkingLevel: "off",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(off.thinking).toBeUndefined();
    // always 级联 low（reasoning_effort low 是开思考词汇）→ 开。
    const cascaded = anthropicAdapter.buildBody({
      ...base,
      presetId: "moonshot",
      thinkingLevel: "off",
      model: "kimi-k3",
      messages: []
    });
    expect(cascaded.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("probe 不发 thinking：探针 maxTokens=1 与 budget_tokens ≥1024 互斥，发了必 400", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      probe: true,
      maxTokens: 1,
      presetId: "deepseek",
      thinkingLevel: "high",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(body.max_tokens).toBe(1);
    expect(body.thinking).toBeUndefined();
  });

  it("maxTokens 放不下 budget（<1024）时不发 thinking：软失败优于硬 400", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      maxTokens: 500,
      presetId: "deepseek",
      thinkingLevel: "high",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(body.max_tokens).toBe(500);
    expect(body.thinking).toBeUndefined();
  });

  it("查不到思考事实（unknown）不发 thinking 字段", () => {
    const body = anthropicAdapter.buildBody({
      ...base,
      thinkingLevel: "high",
      messages: []
    });
    expect(body.thinking).toBeUndefined();
  });
});

describe("drainStream（SSE 事件映射，research §3）", () => {
  it("全事件会话：text/thinking 增量、tool_use 聚合、stop_reason、未知事件宽容", async () => {
    const chunks = [
      anthropicSseData({ type: "message_start", message: { id: "msg_1" } }),
      anthropicSseData({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "想" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好" } }),
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "世界" } }),
      anthropicSseData({ type: "content_block_stop", index: 0 }),
      anthropicSseData({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_9", name: "web_search" } }),
      anthropicSseData({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"quer" } }),
      anthropicSseData({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "y\":\"x\"}" } }),
      anthropicSseData({ type: "content_block_stop", index: 1 }),
      "data: {bad json\n\n",
      anthropicSseData({ type: "message_delta", delta: { stop_reason: "tool_use" } }),
      anthropicSseData({ type: "ping" }),
      anthropicSseData({ type: "future_unknown_event", foo: 1 }),
      anthropicSseData({ type: "message_stop" })
    ];
    const events: StreamChatEvent[] = [];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });

    expect(result.content).toBe("你好世界");
    // stop_reason 映射回 OpenAI 词表：tool_use → "tool_calls"（tool-loop 精确匹配）。
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "tu_9", type: "function", function: { name: "web_search", arguments: "{\"query\":\"x\"}" } }
    ]);
    expect(events).toEqual([
      { type: "reasoning", data: "想" },
      { type: "token", data: "你好" },
      { type: "token", data: "世界" },
      { type: "tool-call", name: "web_search", args: { query: "x" } }
    ]);
  });

  it("流内 error 事件 → 抛错走 core 读流中断重试（overloaded_error 可重试语义）", async () => {
    const chunks = [
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "部分" } }),
      anthropicSseData({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      anthropicSseData({ type: "message_stop" })
    ];

    await expect(anthropicAdapter.drainStream(sseResponse(chunks), {})).rejects.toThrow("[anthropic] overloaded_error: Overloaded");
  });

  it("signal 已中止 → 抛 aborted 错误（core 统一收束）", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      anthropicAdapter.drainStream(sseResponse([anthropicSseData({ type: "message_start" })]), { signal: controller.signal })
    ).rejects.toMatchObject({ aborted: true });
  });
});

describe("parseResponse（非流式，research §5）", () => {
  it("text 块顺序拼接无分隔符；stop_reason 映射回 OpenAI 词表（限制点 7/13）", () => {
    const result = anthropicAdapter.parseResponse({
      content: [{ type: "text", text: "甲" }, { type: "text", text: "乙" }],
      stop_reason: "end_turn"
    });
    expect(result).toEqual({ content: "甲乙", toolCalls: [], finishReason: "stop" });
    // 词表映射全表：tool_use/max_tokens/stop_sequence/refusal。
    for (const [raw, mapped] of [["tool_use", "tool_calls"], ["max_tokens", "length"], ["stop_sequence", "stop"], ["refusal", "stop"]]) {
      expect(anthropicAdapter.parseResponse({ content: [], stop_reason: raw }).finishReason).toBe(mapped);
    }
  });

  it("tool_use 块回转为 ChatToolCall（arguments JSON 化）", () => {
    const result = anthropicAdapter.parseResponse({
      content: [
        { type: "tool_use", id: "tu_1", name: "web_search", input: { query: "abc" } },
        { type: "text", text: "好的" }
      ],
      stop_reason: "tool_use"
    });
    expect(result.content).toBe("好的");
    expect(result.toolCalls).toEqual([
      { id: "tu_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"abc\"}" } }
    ]);
    expect(result.finishReason).toBe("tool_calls");
  });

  it("缺 content / stop_reason → 空串与 null", () => {
    expect(anthropicAdapter.parseResponse({})).toEqual({ content: "", toolCalls: [], finishReason: null });
  });
});

describe("extractErrorDetail（research §6）", () => {
  it("错误 envelope：type + message", () => {
    expect(anthropicAdapter.extractErrorDetail(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens 必填" } })))
      .toBe("invalid_request_error: max_tokens 必填");
  });

  it("缺 type / 缺 message / 非 JSON → 宽容回落", () => {
    expect(anthropicAdapter.extractErrorDetail(JSON.stringify({ error: { message: "只有消息" } }))).toBe("只有消息");
    expect(anthropicAdapter.extractErrorDetail(JSON.stringify({ error: { type: "只有类型" } }))).toBe("只有类型");
    expect(anthropicAdapter.extractErrorDetail("plain text")).toBe("plain text");
  });
});

describe("chatCompletion 经 anthropic 协议端到端（core 骨架零改动）", () => {
  it("流式：onEvent 收 token/done 归一事件，返回 { done: true }", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => sseResponse([
      anthropicSseData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "流" } }),
      anthropicSseData({ type: "message_delta", delta: { stop_reason: "end_turn" } }),
      anthropicSseData({ type: "message_stop" })
    ]));
    const events: StreamChatEvent[] = [];
    const result = await chatCompletion({
      provider: { baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "sk-ant", protocol: "anthropic" },
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      onEvent: (e) => events.push(e),
      fetchImpl: fetchMock
    });

    expect(result).toEqual({ done: true });
    expect(events).toEqual([{ type: "token", data: "流" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant");
  });

  it("HTTP 错误：detail 带 [anthropic] 前缀（core 统一加）与截断", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => ({
      ok: false,
      status: 400,
      text: vi.fn(async () => JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 99 tokens > 9 maximum" } }))
    }) as unknown as Response);

    await expect(
      chatCompletion({
        provider: { baseUrl: "https://api.anthropic.com", model: "claude-x", protocol: "anthropic" },
        messages: [],
        retries: 0,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ overflow: true });
  });
});
