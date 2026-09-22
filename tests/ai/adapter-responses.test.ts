// ai/adapters/responses.js 单测（multi-protocol-ai 第三部分）：线格式映射逐条对照
// research/responses-wire-mapping.md——请求构造（system 剥 instructions / store:false /
// input 项拆分 / tools 内联 strict:false / thinking 二次改写 / max_output_tokens）、
// SSE 事件流（event: 行解析、delta 顶层字符串、function_call 聚合、终态事件、
// L1 兼容加固）、非流式解析、错误 detail 提取。能力声明对照 spec
// 「被有意不支持的能力」。

import { describe, expect, it, vi } from "vitest";
import { responsesAdapter } from "../../extension/ai/adapters/responses.js";
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

// Responses SSE 块：event: 行 + data: 行 + 空行分隔。
function responsesSseBlock(eventName: string, payload: unknown) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

describe("capabilities（spec「被有意不支持的能力」逐条落点）", () => {
  it("tools/thinkingProfiles 为 true；unsupported 三个稳定键", () => {
    const { capabilities } = responsesAdapter;
    expect(capabilities.tools).toBe(true);
    expect(capabilities.thinkingProfiles).toBe(true);
    expect(Object.keys(capabilities.unsupported).sort()).toEqual([
      "finish-reason-synthetic",
      "reasoning-replay",
      "sequence-reorder"
    ]);
  });

  it("注册表读路径：resolveAdapter(\"responses\") 命中本 adapter", () => {
    expect(resolveAdapter("responses")).toBe(PROTOCOL_ADAPTERS.responses);
    expect(PROTOCOL_ADAPTERS.responses).toBe(responsesAdapter);
  });
});

describe("endpoint / authHeaders", () => {
  it("endpoint = baseUrl + /responses（baseUrl 已去尾斜杠）", () => {
    expect(responsesAdapter.endpoint("https://api.deepseek.com/v1")).toBe("https://api.deepseek.com/v1/responses");
  });

  it("鉴权同 OpenAI：Bearer；无 key 不带 Authorization", () => {
    expect(responsesAdapter.authHeaders("sk-x")).toEqual({ Authorization: "Bearer sk-x" });
    expect(responsesAdapter.authHeaders(undefined)).toEqual({});
  });
});

describe("buildBody（请求映射，research §1/§3）", () => {
  const base = { model: "m", stream: false, probe: false, baseUrl: "https://api.example.com/v1" };

  it("system 剥为顶层 instructions；多条按出现顺序 \\n\\n 拼接（L3）；store:false 恒在", () => {
    const body = responsesAdapter.buildBody({
      ...base,
      messages: [
        { role: "system", content: "s1" },
        { role: "user", content: "hi" },
        { role: "system", content: "s2" }
      ]
    });
    expect(body.instructions).toBe("s1\n\ns2");
    expect(body.store).toBe(false);
    expect(body.stream).toBe(false);
    // 无状态形态：input 只含非 system 消息，不发 previous_response_id。
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect("previous_response_id" in body).toBe(false);
  });

  it("消息翻译：assistant 纯文本 / tool_calls 拆独立项 / tool 转 function_call_output", () => {
    const body = responsesAdapter.buildBody({
      ...base,
      messages: [
        { role: "user", content: "查一下" },
        { role: "assistant", content: "好的" },
        { role: "assistant", content: "让我查一下", tool_calls: [
          { id: "call_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"abc\"}" } }
        ] },
        { role: "tool", tool_call_id: "call_1", content: "{\"results\":[]}" }
      ]
    });
    expect(body.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "查一下" }] },
      { role: "assistant", content: [{ type: "output_text", text: "好的" }] },
      { type: "function_call", call_id: "call_1", name: "web_search", arguments: "{\"query\":\"abc\"}" },
      { type: "function_call_output", call_id: "call_1", output: "{\"results\":[]}" }
    ]);
  });

  it("maxTokens → max_output_tokens；缺省不发", () => {
    expect(responsesAdapter.buildBody({ ...base, messages: [], maxTokens: 8192 }).max_output_tokens).toBe(8192);
    expect("max_output_tokens" in responsesAdapter.buildBody({ ...base, messages: [] })).toBe(false);
  });

  it("tools：内联标签 + 显式 strict:false + tool_choice auto", () => {
    const body = responsesAdapter.buildBody({
      ...base,
      messages: [],
      tools: [{ type: "function", function: { name: "web_search", description: "d", parameters: { type: "object" } } }]
    });
    expect(body.tools).toEqual([{ type: "function", name: "web_search", description: "d", parameters: { type: "object" }, strict: false }]);
    expect(body.tool_choice).toBe("auto");
  });

  it("思考档位二次改写：reasoning_effort → reasoning.effort（L9）", () => {
    // deepseek-v3.2 = hybrid-effort：high → reasoning_effort high。
    const body = responsesAdapter.buildBody({
      ...base,
      presetId: "deepseek",
      thinkingLevel: "high",
      model: "deepseek-v3.2",
      messages: [{ role: "user", content: "hi" }]
    });
    expect(body.reasoning).toEqual({ effort: "high" });
    // chat-completions 系字段名不透传。
    expect("reasoning_effort" in body).toBe(false);
  });

  it("probe 不发 reasoning：探针 maxTokens=1 与 reasoning 并存有被 400 的风险", () => {
    const body = responsesAdapter.buildBody({
      ...base,
      probe: true,
      maxTokens: 1,
      presetId: "deepseek",
      thinkingLevel: "high",
      model: "deepseek-v3.2",
      messages: []
    });
    expect(body.max_output_tokens).toBe(1);
    expect("reasoning" in body).toBe(false);
  });

  it("查不到思考事实（unknown）不发 reasoning 字段", () => {
    const body = responsesAdapter.buildBody({ ...base, thinkingLevel: "high", messages: [] });
    expect("reasoning" in body).toBe(false);
  });

  it("开关型 off 词汇归一为 reasoning.effort:\"none\"（Responses 默认开思考，直接丢弃会让 off 变默认开）", () => {
    // deepseek-v3.2 = deepseek-hybrid-effort：off 词汇是 thinking:{type:disabled}。
    const deepseek = responsesAdapter.buildBody({
      ...base, presetId: "deepseek", thinkingLevel: "off", model: "deepseek-v3.2", messages: []
    });
    expect(deepseek.reasoning).toEqual({ effort: "none" });
    // qwen3-max = qwen-hybrid-switch：off 词汇是 enable_thinking:false。
    const qwen = responsesAdapter.buildBody({
      ...base, presetId: "qwen", thinkingLevel: "off", model: "qwen3-max", messages: []
    });
    expect(qwen.reasoning).toEqual({ effort: "none" });
  });

  it("effort 值归一：qwen 系 xhigh → high（Responses 官方词表只有 none/minimal/low/medium/high）", () => {
    // qwen3.8-max = qwen-hybrid-effort：high 档词表产出 reasoning_effort:"xhigh"。
    const body = responsesAdapter.buildBody({
      ...base, presetId: "qwen", thinkingLevel: "high", model: "qwen3.8-max", messages: []
    });
    expect(body.reasoning).toEqual({ effort: "high" });
  });
});

describe("drainStream（SSE 事件映射，research §2）", () => {
  it("全事件会话：delta 顶层字符串、reasoning/refusal、function_call 聚合、completed 收口、未知事件宽容", async () => {
    const chunks = [
      responsesSseBlock("response.created", { response: { id: "resp_1" } }),
      responsesSseBlock("response.output_item.added", { item: { id: "msg_1", type: "message" } }),
      responsesSseBlock("response.content_part.added", { item_id: "msg_1" }),
      responsesSseBlock("response.output_text.delta", { item_id: "msg_1", delta: "你好" }),
      responsesSseBlock("response.output_text.delta", { item_id: "msg_1", delta: "世界" }),
      // done 事件带完整文本：忽略，不得重复吐（research §2）。
      responsesSseBlock("response.output_text.done", { item_id: "msg_1", text: "你好世界" }),
      responsesSseBlock("response.reasoning_summary_text.delta", { item_id: "rs_1", delta: "想" }),
      // 第三方兼容端点事件（DeepSeek）宽容处理。
      responsesSseBlock("response.reasoning_text.delta", { item_id: "rs_1", delta: "推" }),
      responsesSseBlock("response.refusal.delta", { item_id: "msg_2", delta: "拒" }),
      responsesSseBlock("response.output_item.added", { item: { id: "fc_1", type: "function_call", call_id: "call_9", name: "web_search" } }),
      responsesSseBlock("response.function_call_arguments.delta", { item_id: "fc_1", delta: "{\"quer" }),
      // done 的完整 arguments 在 payload 顶层，覆盖累积串。
      responsesSseBlock("response.function_call_arguments.done", { item_id: "fc_1", arguments: "{\"query\":\"x\"}" }),
      "event: response.output_text.delta\ndata: {bad json\n\n",
      responsesSseBlock("response.web_search_call.in_progress", { item_id: "ws_1" }),
      responsesSseBlock("future_unknown_event", { foo: 1 }),
      responsesSseBlock("response.completed", { response: { status: "completed" } })
    ];
    const events: StreamChatEvent[] = [];
    const result = await responsesAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });

    expect(result.content).toBe("你好世界拒");
    // finishReason 合成回 OpenAI 词表：有 toolCalls → "tool_calls"（tool-loop 精确匹配）。
    expect(result.finishReason).toBe("tool_calls");
    expect(result.toolCalls).toEqual([
      { id: "call_9", type: "function", function: { name: "web_search", arguments: "{\"query\":\"x\"}" } }
    ]);
    // 流内不吐 done（调用方收口单发）；tool-call 在流末补发。
    expect(events).toEqual([
      { type: "token", data: "你好" },
      { type: "token", data: "世界" },
      { type: "reasoning", data: "想" },
      { type: "reasoning", data: "推" },
      { type: "token", data: "拒" },
      { type: "tool-call", name: "web_search", args: { query: "x" } }
    ]);
  });

  it("纯文本会话：completed → finishReason \"stop\"，无 toolCalls", async () => {
    const chunks = [
      responsesSseBlock("response.output_text.delta", { item_id: "m", delta: "hi" }),
      responsesSseBlock("response.completed", { response: { status: "completed" } })
    ];
    const events: StreamChatEvent[] = [];
    const result = await responsesAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });
    expect(result).toEqual({ content: "hi", toolCalls: [], finishReason: "stop" });
    expect(events).toEqual([{ type: "token", data: "hi" }]);
  });

  it("response.incomplete → finishReason \"length\"，不发 stopped 事件（收口纪律同 done）", async () => {
    const chunks = [
      responsesSseBlock("response.output_text.delta", { item_id: "m", delta: "半" }),
      responsesSseBlock("response.incomplete", { response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } } })
    ];
    const events: StreamChatEvent[] = [];
    const result = await responsesAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });
    expect(result.finishReason).toBe("length");
    expect(result.content).toBe("半");
    expect(events).toEqual([{ type: "token", data: "半" }]);
  });

  it("response.failed → 抛 [responses] 错走 core 读流中断重试", async () => {
    const chunks = [
      responsesSseBlock("response.output_text.delta", { item_id: "m", delta: "部分" }),
      responsesSseBlock("response.failed", { response: { error: { code: "server_error", message: "boom" } } })
    ];
    await expect(responsesAdapter.drainStream(sseResponse(chunks), {})).rejects.toThrow("[responses] server_error: boom");
  });

  it("SSE 层级 error 事件 → 抛 [responses] 错", async () => {
    const chunks = [
      responsesSseBlock("error", { code: "rate_limit_exceeded", message: "slow down" })
    ];
    await expect(responsesAdapter.drainStream(sseResponse(chunks), {})).rejects.toThrow("[responses] slow down");
  });

  it("L1 加固：漏发 output_item.added 时 arguments 聚合 + output_item.done 回填 name", async () => {
    const chunks = [
      // 兼容端点直接发 arguments delta，没有 added 提供 call_id/name。
      responsesSseBlock("response.function_call_arguments.delta", { item_id: "fc_7", delta: "{\"query\":\"y\"}" }),
      responsesSseBlock("response.output_item.done", { item: { id: "fc_7", type: "function_call", call_id: "call_7", name: "web_search", arguments: "{\"query\":\"y\"}" } }),
      responsesSseBlock("response.completed", { response: { status: "completed" } })
    ];
    const events: StreamChatEvent[] = [];
    const result = await responsesAdapter.drainStream(sseResponse(chunks), { onEvent: (e) => events.push(e) });
    expect(result.toolCalls).toEqual([
      { id: "call_7", type: "function", function: { name: "web_search", arguments: "{\"query\":\"y\"}" } }
    ]);
    expect(events).toEqual([{ type: "tool-call", name: "web_search", args: { query: "y" } }]);
  });

  it("signal 已中止 → 抛 aborted 错误（core 统一收束）", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      responsesAdapter.drainStream(sseResponse([responsesSseBlock("response.created", {})]), { signal: controller.signal })
    ).rejects.toMatchObject({ aborted: true });
  });

  it("连接关闭未收终态事件 → 抛错走 core 读流中断重试（research §2 收束判据）", async () => {
    const chunks = [
      responsesSseBlock("response.output_text.delta", { item_id: "m", delta: "截断" })
      // 无 completed/failed/incomplete：连接即关闭。
    ];
    await expect(
      responsesAdapter.drainStream(sseResponse(chunks), {})
    ).rejects.toThrow("[responses] stream closed before terminal event");
  });
});

describe("parseResponse（非流式，research §5）", () => {
  it("message 项拼 output_text（refusal part 并入）；function_call 回转为 ChatToolCall", () => {
    const result = responsesAdapter.parseResponse({
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "甲" }, { type: "refusal", text: "拒" }] },
        { type: "function_call", call_id: "call_1", name: "web_search", arguments: "{\"query\":\"abc\"}" },
        { type: "message", content: [{ type: "output_text", text: "乙" }] }
      ]
    });
    expect(result.content).toBe("甲拒乙");
    expect(result.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "web_search", arguments: "{\"query\":\"abc\"}" } }
    ]);
    // 有 toolCalls → 合成 "tool_calls"（tool-loop 精确匹配）。
    expect(result.finishReason).toBe("tool_calls");
  });

  it("finishReason 合成：无 toolCalls → stop；status incomplete → length", () => {
    expect(responsesAdapter.parseResponse({ status: "completed", output: [] }).finishReason).toBe("stop");
    expect(responsesAdapter.parseResponse({ status: "incomplete", output: [] }).finishReason).toBe("length");
  });

  it("缺 output → 空串与合成 finishReason", () => {
    expect(responsesAdapter.parseResponse({})).toEqual({ content: "", toolCalls: [], finishReason: "stop" });
  });

  it("status failed → 抛错（HTTP 200 终态失败不当成功返回，同流内 response.failed）", () => {
    expect(() =>
      responsesAdapter.parseResponse({ status: "failed", error: { code: "server_error", message: "boom" } })
    ).toThrow("[responses] server_error: boom");
  });
});

describe("extractErrorDetail（research §4）", () => {
  it("错误 envelope：error.message", () => {
    expect(responsesAdapter.extractErrorDetail(JSON.stringify({ error: { message: "bad request", type: "invalid_request_error" } })))
      .toBe("bad request");
  });

  it("非 JSON / 无 envelope → 宽容回落整段", () => {
    expect(responsesAdapter.extractErrorDetail("plain text")).toBe("plain text");
    expect(responsesAdapter.extractErrorDetail(JSON.stringify({ foo: 1 }))).toBe(JSON.stringify({ foo: 1 }));
  });
});

describe("chatCompletion 经 responses 协议端到端（core 骨架零改动）", () => {
  it("流式：onEvent 收 token 归一事件，返回 { done: true }，请求体无状态形状", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => sseResponse([
      responsesSseBlock("response.output_text.delta", { item_id: "m", delta: "流" }),
      responsesSseBlock("response.completed", { response: { status: "completed" } })
    ]));
    const events: StreamChatEvent[] = [];
    const result = await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "sk", protocol: "responses" },
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      stream: true,
      onEvent: (e) => events.push(e),
      fetchImpl: fetchMock
    });

    expect(result).toEqual({ done: true });
    expect(events).toEqual([{ type: "token", data: "流" }]);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe("https://api.example.com/v1/responses");
    expect(init.headers.Authorization).toBe("Bearer sk");
    const body = JSON.parse(init.body);
    expect(body.instructions).toBe("sys");
    expect(body.store).toBe(false);
    expect(body.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
  });

  it("HTTP 错误：detail 带 [responses] 前缀（core 统一加），溢出判定照常命中", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ({
      ok: false,
      status: 400,
      text: vi.fn(async () => JSON.stringify({ error: { message: "prompt is too long: 99 tokens > 9 maximum allowed" } }))
    }) as unknown as Response);

    await expect(
      chatCompletion({
        provider: { baseUrl: "https://api.example.com/v1", model: "m", protocol: "responses" },
        messages: [],
        retries: 0,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ overflow: true });
    // 前缀经 core 拼接（adapter.protocol 原样），detail 截前 200 字符。
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
