import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chatCompletion,
  isContextLengthOverflow,
  makeOverflowError
} from "../../extension/ai/completion.js";
import { buildChatRequestBody, OPENAI_CHAT_PATH } from "../../extension/ai/adapters/openai.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import { normalizeThinkingLevel } from "../../extension/ai/thinking-profiles.js";
import { resetLearnedBudgetsForTests } from "../../extension/ai/learned-budget.js";
import type { ChatToolDefinition } from "../../extension/ai/protocol-adapter.js";
import type { StreamChatEvent } from "../../extension/ai/types.js";

const PROVIDER = { baseUrl: "https://api.example.com/v1", model: "test-model", apiKey: "sk-test" };

type OpenAiBodyFacts = Omit<Parameters<typeof buildChatRequestBody>[0], "thinkingWire"> & {
  baseUrl?: string;
  presetId?: string;
  thinkingLevel?: unknown;
};
function buildOpenAiChatBody({ baseUrl, presetId, thinkingLevel, ...request }: OpenAiBodyFacts) {
  return buildChatRequestBody({
    ...request,
    thinkingWire: planThinkingWire({
      protocol: "openai",
      model: request.model,
      presetId,
      baseUrl,
      level: thinkingLevel,
      stream: request.stream ?? false,
      probe: false
    })
  });
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function mockFetch(impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>) {
  return vi.fn<FetchImpl>(impl as FetchImpl);
}

type InitLike = { body: string; headers: Record<string, string>; method?: string };

type RetryInfo = { attempt: number; maxRetries: number; kind: "fetch" | "http" | "stream"; error: Error };

beforeEach(() => {
  vi.useRealTimers();
  resetLearnedBudgetsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: vi.fn(async () => JSON.stringify(payload)),
    json: async () => payload
  } as unknown as Response;
}

function textResponse(text: string, ok = false, status = 400): Response {
  return { ok, status, text: vi.fn(async () => text), json: vi.fn() } as unknown as Response;
}

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

function sseData(delta: unknown) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

describe("请求构造对照表（url / body / headers）", () => {
  it("baseUrl 去尾斜杠（单个与多个）+ 拼接 OPENAI_CHAT_PATH；Bearer 仅当 apiKey", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1/", model: "m", apiKey: "sk-1" },
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock
    });
    await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1///", model: "m", apiKey: "sk-1" },
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock
    });
    await chatCompletion({
      provider: { baseUrl: "https://api.example.com/v1", model: "m" },
      messages: [{ role: "user", content: "hi" }],
      fetchImpl: fetchMock
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe(`https://api.example.com/v1${OPENAI_CHAT_PATH}`);
      expect(url).toContain("/chat/completions");
    }
    const withKey = fetchMock.mock.calls[0][1] as InitLike;
    expect(withKey.headers.Authorization).toBe("Bearer sk-1");
    expect(withKey.method).toBe("POST");
    const noKey = fetchMock.mock.calls[2][1] as InitLike;
    expect(noKey.headers.Authorization).toBeUndefined();
    expect(noKey.headers["Content-Type"]).toBe("application/json");
  });

  it("思考档位经 thinking-profiles 查表：OpenAI gpt-5.1 off→effort none、low/high→effort；未知平台×模型三档不发", async () => {
    const fetchMock = mockFetch(async (_url, init) =>
      JSON.parse(init!.body as string).stream
        ? sseResponse([])
        : jsonResponse({ choices: [{ message: { content: "" } }] })
    );
    const run = (provider: { baseUrl?: string; model?: string; apiKey?: string }, overrides: Partial<Parameters<typeof chatCompletion>[0]>) =>
      chatCompletion({
        provider,
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fetchMock,
        ...overrides
      });

    const openai = { baseUrl: "https://api.openai.com/v1", model: "gpt-5.1" };
    await run(openai, { stream: false, thinkingLevel: "off" });
    await run(openai, { stream: true, thinkingLevel: "low" });
    await run(openai, { stream: true, thinkingLevel: "high" });
    await run(PROVIDER, { stream: true, thinkingLevel: "off" });
    await run(PROVIDER, { stream: true });

    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse((init as InitLike).body));
    expect(bodies[0]).toMatchObject({ reasoning_effort: "none" });
    expect(bodies[0]).not.toHaveProperty("thinking");
    expect(bodies[0]).not.toHaveProperty("enable_thinking");
    expect(bodies[1]).toMatchObject({ stream: true, reasoning_effort: "low" });
    expect(bodies[1]).not.toHaveProperty("enable_thinking");
    expect(bodies[2]).toMatchObject({ stream: true, reasoning_effort: "high" });
    for (const body of [bodies[3], bodies[4]]) {
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body).not.toHaveProperty("thinking");
      expect(body).not.toHaveProperty("enable_thinking");
    }
  });

  it("probe 模式：max_tokens:1 + ping 消息 + stream:false；额外头合并且不覆盖 Content-Type", async () => {
    const response = jsonResponse({ choices: [{ message: { content: "" } }] });
    const fetchMock = mockFetch(async () => response);

    await chatCompletion({
      provider: PROVIDER,
      messages: [{ role: "user", content: "ping" }],
      probe: true,
      headers: { Accept: "application/json" },
      fetchImpl: fetchMock
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.example.com/v1${OPENAI_CHAT_PATH}`);
    expect(JSON.parse((init as InitLike).body)).toEqual({
      model: "test-model",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_tokens: 1
    });
    expect((init as InitLike).headers).toEqual({
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test"
    });
  });

  it("Opencode Go 预设补 x-opencode-session（同会话恒同值 / 新会话新值 / 其余预设不补）", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const send = (presetId: string, sessionId?: string) =>
      chatCompletion({
        provider: { ...PROVIDER, presetId, ...(sessionId ? { sessionId } : {}) },
        messages: [{ role: "user", content: "hi" }],
        fetchImpl: fetchMock
      });

    await send("opencodego", "conv_a1");
    await send("opencodego", "conv_a1");
    await send("opencodego", "conv_b2");
    await send("deepseek", "conv_a1");

    const headers = fetchMock.mock.calls.map(([, init]) => (init as InitLike).headers);
    const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(headers[0]["x-opencode-session"]).toMatch(UUID_V4);
    expect(headers[1]["x-opencode-session"]).toBe(headers[0]["x-opencode-session"]);
    expect(headers[2]["x-opencode-session"]).not.toBe(headers[0]["x-opencode-session"]);
    expect(headers[3]["x-opencode-session"]).toBeUndefined();
  });

  it("Opencode Go 的 off 落 effort low（解释/概览钉的 off 在这平台真发出最低档；不臆造关思考字段）", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://opencode.ai/zen/go/v1", model: "deepseek-v4.1-flash", apiKey: "sk-1", presetId: "opencodego" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body);
    expect(body.reasoning_effort).toBe("low");
    expect(body.thinking).toBeUndefined();
    expect(body.enable_thinking).toBeUndefined();
  });

  it("probe 在 OpenAI reasoning 模型上不发关思考字段（缺省档 = default 不干预，2026-10-05 裁定）；token 上限参数名事实随血统不变", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.openai.com/v1", model: "gpt-5.1", apiKey: "sk-1" },
      messages: [{ role: "user", content: "ping" }],
      probe: true,
      fetchImpl: fetchMock
    });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body)).toEqual({
      model: "gpt-5.1",
      messages: [{ role: "user", content: "ping" }],
      stream: false,
      max_completion_tokens: 1
    });
  });

  it("显式 maxTokens 写进 body；传入 headers 已带 Authorization 时不重复注入", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      maxTokens: 7,
      headers: { Authorization: "Bearer pre-set" },
      fetchImpl: fetchMock
    });

    const init = fetchMock.mock.calls[0][1] as InitLike;
    expect(JSON.parse(init.body).max_tokens).toBe(7);
    expect(init.headers.Authorization).toBe("Bearer pre-set");
  });

  it("守卫：缺 baseUrl 抛「baseUrl 未配置」，缺 model 抛「模型未配置」，不发请求", async () => {
    const fetchMock = vi.fn();

    await expect(
      chatCompletion({ provider: { model: "m" }, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("baseUrl 未配置");
    await expect(
      chatCompletion({ provider: { baseUrl: "https://x" }, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("模型未配置");
    await expect(
      chatCompletion({ provider: { baseUrl: "   ", model: "m" }, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("baseUrl 未配置");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("presetId 穿线（chatCompletion → 思考装配边）", () => {
  it("provider.presetId 与 host 推断冲突时 presetId 赢：host 命中 Mimo 但记录是 ollama → effort 词汇", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.xiaomimimo.com/v1", apiKey: "sk-1", model: "llama3.2", presetId: "ollama" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body);
    expect(body).toMatchObject({ reasoning_effort: "none" });
    expect(body).not.toHaveProperty("enable_thinking");
  });

  it("provider.presetId（如反代场景）→ 按 preset 平台规则出 enable_thinking 族", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://thinking-proxy.example.com/v1", apiKey: "sk-1", model: "qwen3-max", presetId: "qwen" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body)).toMatchObject({ enable_thinking: false });
  });

  it("presetId='custom'（旧记录 normalize 落点）→ 回落模型名识别：taxonomy 命中 DeepSeek 规则", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://thinking-proxy.example.com/v1", apiKey: "sk-1", model: "deepseek-v4-pro", presetId: "custom" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body)).toMatchObject({ thinking: { type: "disabled" } });
  });

  it("旧记录不带 presetId 字段：host 推断照常（01 golden 不回归）", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-1", model: "gpt-5.1" },
      messages: [{ role: "user", content: "hi" }],
      thinkingLevel: "off",
      fetchImpl: fetchMock
    });

    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body)).toMatchObject({ reasoning_effort: "none" });
  });
});

describe("token 参数名映射（maxTokens 随类换名，04 号票）", () => {
  it("OpenAI reasoning 模型（gpt-5.1）+ maxTokens → 请求体 max_completion_tokens，无 max_tokens", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.openai.com/v1", apiKey: "sk-1", model: "gpt-5.1" },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 4096,
      fetchImpl: fetchMock
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body);
    expect(body).toMatchObject({ max_completion_tokens: 4096 });
    expect(body).not.toHaveProperty("max_tokens");
  });

  it("非 reasoning 模型（deepseek-v4）+ maxTokens → 请求体仍 max_tokens（现状不变）", async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ choices: [{ message: { content: "" } }] }));

    await chatCompletion({
      provider: { baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-1", model: "deepseek-v4-pro" },
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 4096,
      fetchImpl: fetchMock
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body);
    expect(body).toMatchObject({ max_tokens: 4096 });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});

describe("buildChatRequestBody / normalizeThinkingLevel（主人：adapters/openai、thinking-profiles）", () => {
  it("off：按平台表发显式关闭字段（OpenAI gpt-5.1 例外 effort none；DeepSeek v4 模式表 thinking disabled）", () => {
    const base = { messages: [], stream: true };
    expect(buildOpenAiChatBody({
      ...base, model: "gpt-5.1", baseUrl: "https://api.openai.com/v1", thinkingLevel: "off"
    })).toEqual({
      model: "gpt-5.1",
      messages: [],
      stream: true,
      reasoning_effort: "none"
    });
    expect(buildOpenAiChatBody({
      ...base, model: "deepseek-v4-pro", baseUrl: "https://api.deepseek.com/v1", thinkingLevel: "off"
    })).toEqual({
      model: "deepseek-v4-pro",
      messages: [],
      stream: true,
      thinking: { type: "disabled" }
    });
  });

  it("low / high：按平台表映射（OpenAI effort），不混入其他思考字段；maxTokens 透传（openai-reasoning 系随表换名）", () => {
    const base = { model: "gpt-5.1", messages: [], stream: false, baseUrl: "https://api.openai.com/v1" };
    expect(buildOpenAiChatBody({ ...base, thinkingLevel: "low" })).toEqual({
      model: "gpt-5.1",
      messages: [],
      stream: false,
      reasoning_effort: "low"
    });
    expect(buildOpenAiChatBody({ ...base, thinkingLevel: "high" })).toMatchObject({
      reasoning_effort: "high"
    });
    expect(buildOpenAiChatBody({ ...base, maxTokens: 1 })).toMatchObject({ max_completion_tokens: 1 });
  });

  it("未知平台 × 未知模型：省略/非法/三档均不发思考字段（UNKNOWN 哨兵）；stream 缺省 false", () => {
    const base = { model: "test-model", messages: [], baseUrl: "https://api.example.com/v1" };
    for (const thinkingLevel of [undefined, "off", "low", "high", "medium"]) {
      expect(buildOpenAiChatBody({ ...base, thinkingLevel })).toEqual({
        model: "test-model",
        messages: [],
        stream: false
      });
    }
  });

  it("normalizeThinkingLevel 接受 8 个可选值，缺省 / 脏值回落 default（不干预）", () => {
    for (const level of ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeThinkingLevel(level), level).toBe(level);
    }
    expect(normalizeThinkingLevel("none")).toBe("default");
    expect(normalizeThinkingLevel("ultra")).toBe("default");
    expect(normalizeThinkingLevel(undefined)).toBe("default");
    expect(normalizeThinkingLevel(null)).toBe("default");
  });
});

describe("images 线格式（image-input 路线 B：openai chat 的 content 翻译）", () => {
  const base = { model: "test-model", stream: false, baseUrl: "https://api.example.com/v1" };
  const IMAGE = { mime: "image/webp", data: "QUJD" };

  it("无图消息：请求体逐字节不变（images 是纯本地字段，不上线）", () => {
    const body = buildOpenAiChatBody({
      ...base,
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "yo" }
      ]
    });
    expect(JSON.stringify(body)).toBe(
      '{"model":"test-model","messages":[{"role":"user","content":"hi"},{"role":"assistant","content":"yo"}],"stream":false}'
    );
  });

  it("images: []（空数组）与缺省同形：不产生 content parts，也不上线 images 字段", () => {
    const body = buildOpenAiChatBody({ ...base, messages: [{ role: "user", content: "hi", images: [] }] });
    expect(JSON.stringify(body)).toBe(
      '{"model":"test-model","messages":[{"role":"user","content":"hi"}],"stream":false}'
    );
  });

  it("带图消息：content 翻成 text + image_url 块数组（url 为 data:<mime>;base64,<b64>）", () => {
    const body = buildOpenAiChatBody({
      ...base,
      messages: [
        { role: "user", content: "这张图里是什么", images: [IMAGE, { mime: "image/png", data: "REVG" }] },
        { role: "assistant", content: "是截图" }
      ]
    });
    expect(body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "这张图里是什么" },
          { type: "image_url", image_url: { url: "data:image/webp;base64,QUJD" } },
          { type: "image_url", image_url: { url: "data:image/png;base64,REVG" } }
        ]
      },
      { role: "assistant", content: "是截图" }
    ]);
  });

  it("纯图消息（正文空）：只发 image_url 块，不发空 text 块", () => {
    const body = buildOpenAiChatBody({ ...base, messages: [{ role: "user", content: "", images: [IMAGE] }] });
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:image/webp;base64,QUJD" } }] }
    ]);
  });
});

describe("非流式返回值", () => {
  it("返回 choices[0].message.content；非字符串 content 回落空串", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "成稿" } }] }));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).resolves.toBe("成稿");

    const fetchMock2 = vi.fn(async () => jsonResponse({ choices: [{ message: { content: 123 } }] }));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock2 })
    ).resolves.toBe("");
  });

  it("响应体非法 JSON → 抛「响应解析失败」（不重试，只调一次）", async () => {
    const fetchMock = mockFetch(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }));
    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).rejects.toThrow("响应解析失败：bad json");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("SSE 流式解析与事件序列", () => {
  it("多事件逐条吐出（reasoning + token），[DONE] 跳过，成功 resolve { done: true, finishReason: null }", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        sseData({ reasoning_content: "思路" }),
        sseData({ content: "Hello" }),
        sseData({ content: " 世界" }),
        "data: [DONE]\n\n"
      ])
    );
    const events: StreamChatEvent[] = [];
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });

    expect(result).toEqual({ done: true, finishReason: null });
    expect(events).toEqual([
      { type: "reasoning", data: "思路" },
      { type: "token", data: "Hello" },
      { type: "token", data: " 世界" }
    ]);
  });

  it("半行 buffer：跨 chunk 切断的 data: 行在下一块拼齐后仍解析", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hel',
        'lo"}}]}\n\ndata: {"choices":[{"delta":{"content":"!"}}]}\n\n'
      ])
    );
    const events: StreamChatEvent[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });

    expect(events).toEqual([
      { type: "token", data: "Hello" },
      { type: "token", data: "!" }
    ]);
  });

  it("非 data: 行与空 data 跳过；非法 JSON data 行静默忽略", async () => {
    const fetchMock = vi.fn(async () =>
      sseResponse([
        ": keep-alive\n\n",
        "data:\n\n",
        "data: not-json\n\n",
        sseData({ content: "ok" })
      ])
    );
    const events: StreamChatEvent[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });
    expect(events).toEqual([{ type: "token", data: "ok" }]);
  });
});

describe("isContextLengthOverflow 溢出识别（样本自 budget-single-shot 迁移）", () => {
  it("典型 context-length 溢出文案 → true", () => {
    const overflowMessages = [
      "context_length_exceeded",
      "This model's maximum context length is 8192 tokens, but you requested 12000 tokens.",
      "maximum context length exceeded",
      "exceeds the maximum context window",
      "too many tokens in request",
      "max_tokens limit reached",
      "token limit exceeded",
      "max tokens exceeded",
      "prompt is too long",
      "input is too large",
      'incomplete_details: {"reason":"max_output_tokens"}',
      "请求的上下文长度超出限制",
      "上下文长度超过最大限制",
      "请求 tokens 超出上下文上限"
    ];
    for (const message of overflowMessages) {
      expect(isContextLengthOverflow(message), message).toBe(true);
    }
  });

  it("Error 对象也按文案判定（String 强制转换）", () => {
    expect(isContextLengthOverflow(new Error("maximum context length exceeded"))).toBe(true);
    expect(isContextLengthOverflow(new Error("network down"))).toBe(false);
  });

  it("普通错误（401/404/500/网络/限流/空输入）→ false", () => {
    const plainErrors = [
      "401 Unauthorized",
      "404 Not Found",
      "500 Internal Server Error",
      "invalid api key",
      "model not found",
      "connection reset by peer",
      "rate limit exceeded",
      "请求超时（90 秒未返回任何数据）已自动中断",
      "",
      undefined,
      null,
      123
    ];
    for (const message of plainErrors) {
      expect(isContextLengthOverflow(message), String(message)).toBe(false);
    }
  });
});

describe("溢出端到端：抛 .overflow 标记错误且不重试", () => {
  it("HTTP 400 body 含 maximum context length → rejects { overflow: true }，只调一次 fetch", async () => {
    const fetchMock = vi.fn(async () =>
      textResponse("This model's maximum context length is 8192 tokens, but you requested 12000 tokens.", false, 400)
    );

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], stream: true, fetchImpl: fetchMock })
    ).rejects.toMatchObject({ overflow: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("非流式路径同样命中溢出标记；message 保留 HTTP 详情", async () => {
    const fetchMock = vi.fn(async () =>
      textResponse("context_length_exceeded", false, 413)
    );

    const error = await chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock }).catch((e) => e);
    expect(error.overflow).toBe(true);
    expect(error.message).toBe("HTTP 413: [openai] context_length_exceeded");
  });

  it("makeOverflowError 是 err.overflow 的唯一工厂", () => {
    const error = makeOverflowError("字幕过长，已切换为分段整理模式");
    expect(error).toBeInstanceOf(Error);
    expect(error.overflow).toBe(true);
    expect(error.message).toBe("字幕过长，已切换为分段整理模式");
    expect(makeOverflowError().message).toBe("上下文超出模型限制");
  });
});

describe("输出上限过大 → 退回保守值重发一次", () => {
  const ANTHROPIC = {
    baseUrl: "https://api.anthropic.com",
    model: "claude-x",
    apiKey: "sk-ant",
    protocol: "anthropic" as const
  };
  const TOO_LARGE = JSON.stringify({
    type: "error",
    error: {
      type: "invalid_request_error",
      message: "max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for claude-x"
    }
  });
  const anthropicToken = (text: string) =>
    `data: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text } })}\n\n`;

  it("兜底 32768 被拒 → 以 8192 重发并正常返回；不报 onRetry（自动降级，非失败重试）", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      const budget = JSON.parse(String((init as InitLike).body)).max_tokens;
      return budget === 8192
        ? jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
        : textResponse(TOO_LARGE, false, 400);
    });
    const retries: RetryInfo[] = [];

    const result = await chatCompletion({
      provider: ANTHROPIC,
      messages: [],
      fetchImpl: fetchMock,
      onRetry: (payload) => retries.push(payload)
    });

    expect(result).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body).max_tokens).toBe(32768);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as InitLike).body).max_tokens).toBe(8192);
    expect(retries).toEqual([]);
  });

  it("流式路径同样退回，且退回后照常收流", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(textResponse(TOO_LARGE, false, 400))
      .mockResolvedValueOnce(sseResponse([anthropicToken("ok")]));
    const events: StreamChatEvent[] = [];

    await chatCompletion({
      provider: ANTHROPIC,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: (event) => events.push(event)
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[1][1] as InitLike).body).max_tokens).toBe(8192);
    expect(events).toEqual([{ type: "token", data: "ok" }]);
  });

  it("退回只发生一次：保守值仍被拒 → 抛普通 HTTP 400，不带 overflow 标记", async () => {
    const fetchMock = mockFetch(async () => textResponse(TOO_LARGE, false, 400));

    const error = await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock }).catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(error.status).toBe(400);
    expect(error.overflow).toBeUndefined();
  });

  it("无可退（显式预算不超过保守值，如探针 maxTokens=1）→ 不重发，直接抛错", async () => {
    const fetchMock = mockFetch(async () => textResponse(TOO_LARGE, false, 400));

    const error = await chatCompletion({ provider: ANTHROPIC, messages: [], probe: true, fetchImpl: fetchMock }).catch((e) => e);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.overflow).toBeUndefined();
  });

  it("上下文溢出文案不被退回分支抢走：仍抛 overflow 标记且只请求一次", async () => {
    const fetchMock = mockFetch(async () =>
      textResponse("This model's maximum context length is 8192 tokens, but you requested 12000 tokens.", false, 400)
    );

    await expect(
      chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock })
    ).rejects.toMatchObject({ overflow: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("退回成功后记住平台上限：同平台后续请求直接按 8192 发，不再各撞一次 400", async () => {
    const fetchMock = mockFetch(async (_url, init) => {
      const budget = JSON.parse(String((init as InitLike).body)).max_tokens;
      return budget === 8192
        ? jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
        : textResponse(TOO_LARGE, false, 400);
    });

    await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    const second = await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock });

    expect(second).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body).max_tokens).toBe(8192);
  });

  it("首发就成功（没有退回）不记上限：后续请求仍按兜底 32768 发", async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" })
    );

    await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock });
    fetchMock.mockClear();
    await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body).max_tokens).toBe(32768);
  });

  it("退回后仍失败 → 不记上限（一次失败不固化成整会话策略）", async () => {
    const fetchMock = mockFetch(async () => textResponse(TOO_LARGE, false, 400));

    await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock }).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockClear();
    await chatCompletion({ provider: ANTHROPIC, messages: [], fetchImpl: fetchMock }).catch(() => {});

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body).max_tokens).toBe(32768);
  });
});

describe("重试 policy：流式默认 2 次，onRetry 时序", () => {
  it("fetch 抛错 → 重试 2 次（共 3 次调用）后成功；onRetry 依次 attempt 1/2，kind=fetch", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));
    const retries: RetryInfo[] = [];

    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: (info) => retries.push(info)
    });

    expect(result).toEqual({ done: true, finishReason: null });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ attempt: 1, maxRetries: 2, kind: "fetch" });
    expect(retries[1]).toMatchObject({ attempt: 2, maxRetries: 2, kind: "fetch" });
    expect(retries[0].error.message).toBe("网络错误：Failed to fetch");
  });

  it("fetch 抛错耗尽重试 → 抛「网络错误：…」，retryable 与 isRetryableNetworkError 一致", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Failed to fetch");
    });

    const error = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock
    }).catch((e) => e);

    expect(error.message).toBe("网络错误：Failed to fetch");
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("非溢出 HTTP 500 → 重试 2 次（kind=http），耗尽后抛带 status 的错误；401 同样重试（对齐旧 client 现状）", async () => {
    const fetchMock = vi.fn(async () => textResponse("boom", false, 500));
    const retries: RetryInfo[] = [];

    const error = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: (info) => retries.push(info)
    }).catch((e) => e);

    expect(error.message).toBe("HTTP 500: [openai] boom");
    expect(error.status).toBe(500);
    expect(error.retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(retries.map((r) => r.kind)).toEqual(["http", "http"]);
    expect(retries.map((r) => r.attempt)).toEqual([1, 2]);

    const unauthorized = vi.fn(async () => textResponse("Unauthorized", false, 401));
    const error401 = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: unauthorized
    }).catch((e) => e);
    expect(error401.status).toBe(401);
    expect(error401.retryable).toBe(false);
    expect(unauthorized).toHaveBeenCalledTimes(3);
  });

  it("流式第 2 次 attempt 成功 → 正常完成（前置失败 1 次）", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("network reset"))
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        stream: true,
        retryDelayMs: 0,
        fetchImpl: fetchMock
      })
    ).resolves.toEqual({ done: true, finishReason: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("读流中断（SSE 中途抛错）→ kind=stream 重试，最终成功；耗尽后抛原始错误", async () => {
    const brokenReader = (): Response => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              throw new Error("stream closed");
            }
          };
        }
      }
    } as unknown as Response);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => brokenReader())
      .mockResolvedValueOnce(sseResponse([sseData({ content: "recovered" })]));
    const retries: RetryInfo[] = [];

    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: (info) => retries.push(info),
      onEvent: () => {}
    });

    expect(result).toEqual({ done: true, finishReason: null });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(retries).toEqual([expect.objectContaining({ attempt: 1, maxRetries: 2, kind: "stream" })]);

    const alwaysBroken = vi.fn(async () => brokenReader());
    const error = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: alwaysBroken,
      onEvent: () => {}
    }).catch((e) => e);
    expect(error.message).toBe("stream closed");
    expect(alwaysBroken).toHaveBeenCalledTimes(3);
  });

  it("非流式默认 0 次：!response.ok 直接抛，只调一次 fetch", async () => {
    const fetchMock = vi.fn(async () => textResponse("Unauthorized", false, 401));

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("显式 retries 覆盖默认：非流式 retries=1 时重试一次", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        retries: 1,
        retryDelayMs: 0,
        fetchImpl: fetchMock
      })
    ).resolves.toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("溢出 / abort 不重试", () => {
  it("溢出错误即使还有重试额度也不重试", async () => {
    const fetchMock = vi.fn(async () => textResponse("too many tokens", false, 400));

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        stream: true,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ overflow: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 抛 AbortError → 收束为 { aborted: true }，不重试", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("The user aborted a request");
      e.name = "AbortError";
      throw e;
    });

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], stream: true, fetchImpl: fetchMock })
    ).rejects.toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetch 抛带 aborted 标记的假中止 → 收束为 { aborted: true }，不重试", async () => {
    const fetchMock = vi.fn(async () => {
      const e = new Error("已停止生成");
      (e as Error & { aborted?: boolean }).aborted = true;
      throw e;
    });

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).rejects.toMatchObject({ aborted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("流中途 signal abort → rejects { aborted: true }，不重试、不再发请求", async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let reads = 0;
    const fetchMock = mockFetch(async () => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            async read() {
              reads += 1;
              if (reads === 1) {
                return { value: encoder.encode(sseData({ content: "partial" })), done: false };
              }
              controller.abort();
              return { value: encoder.encode(sseData({ content: "more" })), done: false };
            }
          };
        }
      }
    }));
    const events: StreamChatEvent[] = [];

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        stream: true,
        signal: controller.signal,
        fetchImpl: fetchMock,
        onEvent: (e) => events.push(e)
      })
    ).rejects.toMatchObject({ aborted: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { type: "token", data: "partial" },
      { type: "token", data: "more" }
    ]);
  });

  it("已 abort 的 signal：fetch 抛 AbortError 前不额外发请求（透传 signal）", async () => {
    const controller = new AbortController();
    controller.abort();
    let sawSignal = null;
    const fetchMock = vi.fn(async (_url, init) => {
      sawSignal = init.signal;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });

    await expect(
      chatCompletion({
        provider: PROVIDER,
        messages: [],
        signal: controller.signal,
        fetchImpl: fetchMock
      })
    ).rejects.toMatchObject({ aborted: true });
    expect(sawSignal).toBe(controller.signal);
  });
});

describe("fetchImpl 注入", () => {
  it("注入 fake fetch 时不触碰 globalThis.fetch", async () => {
    const globalFetch = vi.fn();
    vi.stubGlobal("fetch", globalFetch);
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "injected" } }] }));

    await expect(
      chatCompletion({ provider: PROVIDER, messages: [], fetchImpl: fetchMock })
    ).resolves.toBe("injected");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

describe("onStreamReset：读流中断重试的代际重置信号", () => {
  it("kind=stream 重试 → onStreamReset 在新流任何事件前调用恰一次", async () => {
    const brokenReader = (): Response => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              throw new Error("stream closed");
            }
          };
        }
      }
    } as unknown as Response);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => brokenReader())
      .mockResolvedValueOnce(sseResponse([sseData({ content: "二代正文" })]));
    const events: StreamChatEvent[] = [];
    const resets: string[] = [];

    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: () => {},
      onStreamReset: () => resets.push("reset"),
      onEvent: (e) => events.push(e)
    });

    expect(resets).toEqual(["reset"]);
    expect(events).toEqual([{ type: "token", data: "二代正文" }]);
  });

  it("fetch / http 阶段失败重试不触发 onStreamReset（未吐过任何事件）", async () => {
    const fetchFail = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));
    const resetsFetch: number[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchFail,
      onRetry: () => {},
      onStreamReset: () => resetsFetch.push(1),
      onEvent: () => {}
    });
    expect(resetsFetch).toEqual([]);

    const httpFail = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" })
      .mockResolvedValueOnce(sseResponse([sseData({ content: "ok" })]));
    const resetsHttp: number[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: httpFail,
      onRetry: () => {},
      onStreamReset: () => resetsHttp.push(1),
      onEvent: () => {}
    });
    expect(resetsHttp).toEqual([]);
  });

  it("连续两次读流中断（重试耗尽前）→ 每代流开始前各一次 reset；非流式不触发", async () => {
    const brokenReader = (): Response => ({
      ok: true,
      status: 200,
      body: {
        getReader() {
          return {
            read: async () => {
              throw new Error("stream closed");
            }
          };
        }
      }
    } as unknown as Response);
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => brokenReader())
      .mockImplementationOnce(async () => brokenReader())
      .mockResolvedValueOnce(sseResponse([sseData({ content: "三代正文" })]));
    const resets: number[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      retryDelayMs: 0,
      fetchImpl: fetchMock,
      onRetry: () => {},
      onStreamReset: () => resets.push(1),
      onEvent: () => {}
    });
    expect(resets).toEqual([1, 1]);

    const nonStreamFetch = vi.fn()
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const resetsNonStream: number[] = [];
    await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: false,
      retries: 1,
      retryDelayMs: 0,
      fetchImpl: nonStreamFetch,
      onRetry: () => {},
      onStreamReset: () => resetsNonStream.push(1)
    });
    expect(resetsNonStream).toEqual([]);
  });
});

describe("tools 注入与 tool_calls 解析（联网搜索管线，spec §2.1）", () => {
  function sseData(delta: unknown, finishReason?: string) {
    return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n`;
  }
  const TOOL_ROUND = [
    sseData({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] }),
    sseData({}, "tool_calls")
  ];
  const WEB_SEARCH_TOOL: ChatToolDefinition = {
    type: "function",
    function: {
      name: "web_search",
      description: "d",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }
  };

  it("buildChatRequestBody：传 tools 即带 tools + tool_choice: auto；不传不带", () => {
    const withTools = buildOpenAiChatBody({ model: "m", messages: [], tools: [WEB_SEARCH_TOOL] });
    expect(withTools.tools).toEqual([WEB_SEARCH_TOOL]);
    expect(withTools.tool_choice).toBe("auto");
    const without = buildOpenAiChatBody({ model: "m", messages: [] });
    expect(without.tools).toBeUndefined();
    expect(without.tool_choice).toBeUndefined();
  });

  it("流式聚合：跨 chunk 分片按 index 拼接，返回 finishReason + assistantContent + toolCalls，tool-call 事件聚合后逐条吐出", async () => {
    const fetchMock = mockFetch(async () => sseResponse([
      sseData({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "web_search", arguments: '{"qu' } }] }),
      sseData({ content: "先想", tool_calls: [{ index: 0, function: { arguments: 'ery":"x"}' } }] }),
      sseData({}, "tool_calls")
    ]));

    const events: StreamChatEvent[] = [];
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
      tools: [WEB_SEARCH_TOOL],
      fetchImpl: fetchMock,
      onEvent: (e) => events.push(e)
    });

    expect(result).toEqual({
      done: true,
      finishReason: "tool_calls",
      assistantContent: "先想",
      toolCalls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }]
    });
    expect(events.filter((e) => e.type === "tool-call")).toEqual([
      { type: "tool-call", name: "web_search", args: { query: "x" } }
    ]);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as InitLike).body);
    expect(body.tools).toEqual([WEB_SEARCH_TOOL]);
    expect(body.tool_choice).toBe("auto");
  });

  it("流式无 tool_calls：返回 { done: true, finishReason }", async () => {
    const fetchMock = vi.fn(async () => sseResponse([sseData({ content: "ok" }), sseData({}, "stop")]));
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: () => {}
    });
    expect(result).toEqual({ done: true, finishReason: "stop" });
  });

  it("流式 finish_reason=length：返回值直接携带 finishReason: length", async () => {
    const fetchMock = vi.fn(async () => sseResponse([sseData({ content: "半句" }), sseData({}, "length")]));
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: true,
      fetchImpl: fetchMock,
      onEvent: () => {}
    });
    expect(result).toEqual({ done: true, finishReason: "length" });
  });

  it("非流式 tool_calls：读 message.tool_calls，返回 finishReason + assistantContent + toolCalls", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{
        message: {
          content: "",
          tool_calls: [{ id: "call_9", type: "function", function: { name: "web_search", arguments: '{"query":"y"}' } }]
        },
        finish_reason: "tool_calls"
      }]
    }));
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: false,
      tools: [WEB_SEARCH_TOOL],
      fetchImpl: fetchMock
    });
    expect(result).toEqual({
      done: true,
      finishReason: "tool_calls",
      assistantContent: "",
      toolCalls: [{ id: "call_9", type: "function", function: { name: "web_search", arguments: '{"query":"y"}' } }]
    });
  });

  it("非流式无 tool_calls：返回 content 字符串不变", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ choices: [{ message: { content: "ok" } }] }));
    const result = await chatCompletion({
      provider: PROVIDER,
      messages: [],
      stream: false,
      fetchImpl: fetchMock
    });
    expect(result).toBe("ok");
  });
});
