// ai-usage-telemetry T1 单测：响应 usage 采集管道（零行为变更）。
// 三面：
// 1. 各 adapter 自陈解析（core 不认协议形状）：openai 非流式 / openai 流式末块 /
//    anthropic message_start + message_delta 跨事件累积 / anthropic 非流式响应体；
// 2. 形状不符 / 缺字段 / null / 非有限数 → 对应字段缺省：不抛错、不降级、不改控制流；
// 3. 请求体零新增字段（一期不发 stream_options）：断言整个 body（两协议 × 流式/非流式）。
// 消费方（usage-stats / 成本护栏）属 T2，本文件不涉及。

import { describe, expect, it, vi } from "vitest";
import { openaiAdapter } from "../../extension/ai/adapters/openai.js";
import { anthropicAdapter } from "../../extension/ai/adapters/anthropic.js";
import { chatCompletion } from "../../extension/ai/completion.js";

// SSE 流式响应：chunks 按 read() 顺序返回（与 adapter-anthropic.test 同型）。
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

function openaiData(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function anthropicData(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function jsonResponse(payload: unknown): Response {
  return { ok: true, status: 200, json: async () => payload } as unknown as Response;
}

describe("openai 非流式 parseResponse（json.usage 映射）", () => {
  it("有 usage：prompt_tokens / completion_tokens / completion_tokens_details.reasoning_tokens 归一", () => {
    const result = openaiAdapter.parseResponse({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 1234,
        completion_tokens: 567,
        completion_tokens_details: { reasoning_tokens: 89 }
      }
    });
    expect(result.usage).toEqual({ inputTokens: 1234, outputTokens: 567, reasoningTokens: 89 });
    // 既有字段逐字节不变（零行为变更）。
    expect(result.content).toBe("ok");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
  });

  it("无 usage / usage 非对象（字符串、数组、null）→ usage 缺省，不抛错", () => {
    expect(openaiAdapter.parseResponse({ choices: [{ message: { content: "ok" } }] }).usage).toBeUndefined();
    expect(openaiAdapter.parseResponse({ choices: [], usage: null }).usage).toBeUndefined();
    expect(openaiAdapter.parseResponse({ choices: [], usage: "1234" }).usage).toBeUndefined();
    expect(openaiAdapter.parseResponse({ choices: [], usage: [1, 2] }).usage).toBeUndefined();
  });

  it("字段为 null / 字符串 / NaN / Infinity → 该字段缺省，其余字段照常", () => {
    expect(
      openaiAdapter.parseResponse({
        choices: [],
        usage: {
          prompt_tokens: null,
          completion_tokens: "567",
          completion_tokens_details: { reasoning_tokens: Number.POSITIVE_INFINITY }
        }
      }).usage
    ).toBeUndefined();
    expect(
      openaiAdapter.parseResponse({
        choices: [],
        usage: { prompt_tokens: Number.NaN, completion_tokens: 12 }
      }).usage
    ).toEqual({ outputTokens: 12 });
    expect(
      openaiAdapter.parseResponse({
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens_details: { reasoning_tokens: null } }
      }).usage
    ).toEqual({ inputTokens: 10 });
  });

  it("completion_tokens_details 形状不符（缺失 / 非对象 / reasoning_tokens 非数）→ reasoningTokens 缺省", () => {
    expect(openaiAdapter.parseResponse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } }).usage).toEqual({
      inputTokens: 10,
      outputTokens: 20
    });
    expect(
      openaiAdapter.parseResponse({ choices: [], usage: { prompt_tokens: 10, completion_tokens_details: "x" } }).usage
    ).toEqual({ inputTokens: 10 });
    expect(
      openaiAdapter.parseResponse({ choices: [], usage: { prompt_tokens: 10, completion_tokens_details: { reasoning_tokens: "89" } } }).usage
    ).toEqual({ inputTokens: 10 });
  });

  it("0 与负数照原值入账（是否算有效样本由 T2 的样本过滤裁决，T1 只做形状归一）", () => {
    expect(openaiAdapter.parseResponse({ choices: [], usage: { prompt_tokens: 0, completion_tokens: -1 } }).usage).toEqual({
      inputTokens: 0,
      outputTokens: -1
    });
  });
});

describe("openai 流式 drainStream（最后一个带 usage 的 chunk）", () => {
  it("末块 usage（含 reasoning_tokens）随 DrainResult 带回；content/finishReason 不变", async () => {
    const chunks = [
      openaiData({ choices: [{ delta: { content: "甲" } }] }),
      openaiData({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      openaiData({
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 7 } }
      })
    ];
    const result = await openaiAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20, reasoningTokens: 7 });
    expect(result.content).toBe("甲");
    expect(result.finishReason).toBe("stop");
  });

  it("同一流多次出现 usage → 取最后一个非空", async () => {
    const chunks = [
      openaiData({ choices: [{ delta: { content: "甲" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
      openaiData({ choices: [{ delta: { content: "乙" } }], usage: { prompt_tokens: 2, completion_tokens: 2 } }),
      openaiData({ choices: [], usage: { prompt_tokens: 300, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 5 } } })
    ];
    const result = await openaiAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toEqual({ inputTokens: 300, outputTokens: 40, reasoningTokens: 5 });
  });

  it("全程无 usage / usage 为 null / 空对象 → usage 缺省", async () => {
    const none = await openaiAdapter.drainStream(
      sseResponse([openaiData({ choices: [{ delta: { content: "甲" } }] })]),
      {}
    );
    expect(none.usage).toBeUndefined();

    const nullish = await openaiAdapter.drainStream(
      sseResponse([openaiData({ choices: [{ delta: { content: "甲" } }] }), openaiData({ choices: [], usage: null })]),
      {}
    );
    expect(nullish.usage).toBeUndefined();

    const empty = await openaiAdapter.drainStream(
      sseResponse([openaiData({ choices: [], usage: {} })]),
      {}
    );
    expect(empty.usage).toBeUndefined();
  });

  it("后续块的 usage 形状无效 → 保留最后一个非空 usage（不因空块清掉已有采集）", async () => {
    const chunks = [
      openaiData({ choices: [{ delta: { content: "甲" } }], usage: { prompt_tokens: 11, completion_tokens: 22 } }),
      openaiData({ choices: [], usage: { prompt_tokens: null, completion_tokens: "x" } })
    ];
    const result = await openaiAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });
});

describe("anthropic 流式 drainStream（message_start + message_delta 跨事件累积）", () => {
  it("message_start.message.usage.input_tokens 与 message_delta.usage.output_tokens 各归各位", async () => {
    const chunks = [
      anthropicData({ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 25, output_tokens: 1 } } }),
      anthropicData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "好" } }),
      anthropicData({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } }),
      anthropicData({ type: "message_stop" })
    ];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 15 });
    expect(result.content).toBe("好");
    expect(result.finishReason).toBe("stop");
  });

  it("各自缺失则不填：只有 message_start / 只有 message_delta", async () => {
    const onlyStart = await anthropicAdapter.drainStream(
      sseResponse([anthropicData({ type: "message_start", message: { usage: { input_tokens: 25 } } })]),
      {}
    );
    expect(onlyStart.usage).toEqual({ inputTokens: 25 });

    const onlyDelta = await anthropicAdapter.drainStream(
      sseResponse([anthropicData({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } })]),
      {}
    );
    expect(onlyDelta.usage).toEqual({ outputTokens: 15 });
  });

  it("null / 非有限数 / 非对象 → 该字段缺省，不抛错", async () => {
    const chunks = [
      anthropicData({ type: "message_start", message: { usage: { input_tokens: null } } }),
      anthropicData({ type: "message_delta", usage: "x" }),
      anthropicData({ type: "message_delta", usage: { output_tokens: Number.NaN } })
    ];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toBeUndefined();
  });

  it("多个 message_delta：output_tokens 取最后一个；input 侧一旦采到不丢", async () => {
    const chunks = [
      anthropicData({ type: "message_start", message: { usage: { input_tokens: 9 } } }),
      anthropicData({ type: "message_delta", usage: { output_tokens: 3 } }),
      anthropicData({ type: "message_delta", usage: { output_tokens: 42 } })
    ];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 42 });
  });

  it("message_start.message 形状不符（缺 message / 缺 usage）→ 缺省", async () => {
    const chunks = [
      anthropicData({ type: "message_start" }),
      anthropicData({ type: "message_start", message: { id: "msg_1" } }),
      anthropicData({ type: "message_delta", delta: { stop_reason: "end_turn" } })
    ];
    const result = await anthropicAdapter.drainStream(sseResponse(chunks), {});
    expect(result.usage).toBeUndefined();
  });
});

describe("anthropic 非流式 parseResponse（json.usage 映射）", () => {
  it("有 usage：input_tokens / output_tokens 归一；content/toolCalls/finishReason 逐字节不变", () => {
    const result = anthropicAdapter.parseResponse({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 25, output_tokens: 15 }
    });
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 15 });
    expect(result.content).toBe("ok");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
  });

  it("无 usage / usage 非对象（字符串、数组、null）→ usage 缺省，不抛错", () => {
    expect(anthropicAdapter.parseResponse({ content: [{ type: "text", text: "ok" }] }).usage).toBeUndefined();
    expect(anthropicAdapter.parseResponse({ content: [], usage: null }).usage).toBeUndefined();
    expect(anthropicAdapter.parseResponse({ content: [], usage: "25" }).usage).toBeUndefined();
    expect(anthropicAdapter.parseResponse({ content: [], usage: [25, 15] }).usage).toBeUndefined();
  });

  it("字段为 null / 字符串 / NaN / Infinity → 该字段缺省，其余字段照常", () => {
    expect(anthropicAdapter.parseResponse({ content: [], usage: { input_tokens: null, output_tokens: "15" } }).usage).toBeUndefined();
    expect(
      anthropicAdapter.parseResponse({ content: [], usage: { input_tokens: Number.NaN, output_tokens: 15 } }).usage
    ).toEqual({ outputTokens: 15 });
    expect(
      anthropicAdapter.parseResponse({ content: [], usage: { input_tokens: 25, output_tokens: Number.POSITIVE_INFINITY } }).usage
    ).toEqual({ inputTokens: 25 });
  });

  it("只有单侧字段 → 只该字段入账（reasoningTokens 本协议无来源，不出现在对象里）", () => {
    expect(anthropicAdapter.parseResponse({ content: [], usage: { input_tokens: 25 } }).usage).toEqual({ inputTokens: 25 });
    expect(anthropicAdapter.parseResponse({ content: [], usage: { output_tokens: 15 } }).usage).toEqual({ outputTokens: 15 });
  });

  it("0 与负数照原值入账（是否算有效样本由 T2 的样本过滤裁决，T1 只做形状归一）", () => {
    expect(anthropicAdapter.parseResponse({ content: [], usage: { input_tokens: 0, output_tokens: -1 } }).usage).toEqual({
      inputTokens: 0,
      outputTokens: -1
    });
  });
});

describe("请求体不含 stream_options（一期零新增字段：两协议 × 流式/非流式）", () => {
  const PROVIDER_OPENAI = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };
  const PROVIDER_ANTHROPIC = { baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "sk-ant", protocol: "anthropic" as const };

  function bodyOf(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it("openai 非流式：整个 body 与预期逐键相等（无 stream_options）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    await chatCompletion({
      provider: PROVIDER_OPENAI,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const body = bodyOf(fetchMock);
    expect(body).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: false
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  it("openai 流式：整个 body 与预期逐键相等（无 stream_options / include_usage）", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([openaiData({ choices: [{ delta: { content: "甲" } }] }), "data: [DONE]\n\n"])
    );
    await chatCompletion({
      provider: PROVIDER_OPENAI,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const body = bodyOf(fetchMock);
    expect(body).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "hi" }],
      stream: true
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  it("anthropic 非流式：整个 body 与预期逐键相等（无 stream_options）", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }));
    await chatCompletion({
      provider: PROVIDER_ANTHROPIC,
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const body = bodyOf(fetchMock);
    expect(body).toEqual({
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
      max_tokens: 32768
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  it("anthropic 流式：整个 body 与预期逐键相等（无 stream_options）", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([anthropicData({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "甲" } }), anthropicData({ type: "message_stop" })])
    );
    await chatCompletion({
      provider: PROVIDER_ANTHROPIC,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const body = bodyOf(fetchMock);
    expect(body).toEqual({
      model: "claude-x",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      max_tokens: 32768
    });
    expect(body).not.toHaveProperty("stream_options");
  });

  // Object.assign(body, thinking.fields)（openai adapter buildBody）是表驱动注键进
  // body 的唯一通道：上面四条都是空 patch，锁不住它。本用例用非空 patch（deepseek
  // 血统 × high → reasoning_effort）证明该通道真注了键（不是空 patch 的假绿），
  // 并同时锁整份 body 无 stream_options。
  it("openai 流式 + 非空 thinking patch：注入 reasoning_effort，整份 body 仍无 stream_options", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([openaiData({ choices: [{ delta: { content: "甲" } }] }), "data: [DONE]\n\n"])
    );
    await chatCompletion({
      provider: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash", apiKey: "sk-test", presetId: "deepseek" },
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      thinkingLevel: "high",
      fetchImpl: fetchMock as unknown as typeof fetch
    });
    const body = bodyOf(fetchMock);
    expect(body.reasoning_effort).toBe("high");
    expect(body).toEqual({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      reasoning_effort: "high"
    });
    expect(body).not.toHaveProperty("stream_options");
  });
});
