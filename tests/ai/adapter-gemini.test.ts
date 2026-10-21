// tests/ai/adapter-gemini.test.ts
// Gemini 原生 generateContent 协议适配器单测（ADR-0018 / issues/02）。
// 覆盖：端点拼接、鉴权头、请求体组装、错误提取与 429 分类、finishReason 全映射、
// 流式 SSE 解析（文本块/usage块/无finishReason报错/中止）、非流式解析。

import { describe, expect, it, vi } from "vitest";
import {
  geminiAdapter,
  classifyGeminiError,
  extractGeminiErrorDetail,
  mapGeminiFinishReason,
  parseGeminiUsage
} from "../../extension/ai/adapters/gemini.js";
import { PROTOCOL_ADAPTERS, resolveAdapter } from "../../extension/ai/protocol-adapter.js";
import type { ChatRequest } from "../../extension/ai/protocol-adapter.js";
import { planThinkingWire } from "../../extension/ai/plan-thinking.js";
import { isAbortedMarkerError } from "../../extension/shared/error-helpers.js";
import type { StreamChatEvent } from "../../extension/ai/types.js";

// 生产上 thinkingWire 由唯一 fetch 点（completion.ts）经思考装配边装配注入；本文件直接
// 驱动 buildBody 的用例按同一口径先跑装配边（planThinkingWire），再驱动请求构造。
type GeminiBodyFacts = Omit<ChatRequest, "thinkingWire"> & {
  baseUrl?: string;
  presetId?: string;
  thinkingLevel?: unknown;
  probe?: boolean;
};
function geminiBody({ baseUrl, presetId, thinkingLevel, probe, ...request }: GeminiBodyFacts) {
  return geminiAdapter.buildBody({
    ...request,
    thinkingWire: planThinkingWire({
      protocol: "gemini",
      model: request.model,
      presetId,
      baseUrl,
      level: thinkingLevel,
      stream: request.stream,
      probe: probe ?? false
    })
  });
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

function geminiSseData(payload: Record<string, unknown>) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe("geminiAdapter: capabilities & 注册表", () => {
  it("capabilities 与 consumes 声明符合规范（consumes 为空）", () => {
    expect(geminiAdapter.protocol).toBe("gemini");
    expect(geminiAdapter.capabilities.tools).toBe(true);
    expect(geminiAdapter.capabilities.thinkingProfiles).toBe(true);
    expect(geminiAdapter.capabilities.unsupported).toEqual({});
    expect(geminiAdapter.consumes).toEqual([]);
  });

  it("注册表：resolveAdapter(\"gemini\") 命中 geminiAdapter", () => {
    expect(resolveAdapter("gemini")).toBe(PROTOCOL_ADAPTERS.gemini);
    expect(PROTOCOL_ADAPTERS.gemini).toBe(geminiAdapter);
  });
});

describe("geminiAdapter: endpoint & authHeaders", () => {
  it("endpoint 拼流式与非流式端点，baseUrl 为 host 根", () => {
    expect(
      geminiAdapter.endpoint("https://generativelanguage.googleapis.com", {
        model: "gemini-2.5-flash",
        stream: true
      })
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );

    expect(
      geminiAdapter.endpoint("https://generativelanguage.googleapis.com", {
        model: "gemini-2.5-flash",
        stream: false
      })
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"
    );
  });

  it("baseUrl 带尾斜杠或 /v1beta 时自去尾，避免 /v1beta/v1beta 拼重", () => {
    expect(
      geminiAdapter.endpoint("https://my-proxy.com/v1beta/", {
        model: "gemini-3-pro",
        stream: true
      })
    ).toBe("https://my-proxy.com/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse");
  });

  it("model 带 models/ 前缀时自动剥离", () => {
    expect(
      geminiAdapter.endpoint("https://generativelanguage.googleapis.com", {
        model: "models/gemini-2.5-flash",
        stream: true
      })
    ).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
    );
  });

  it("缺省 options 时端点含 {model} 占位符", () => {
    expect(geminiAdapter.endpoint("https://generativelanguage.googleapis.com")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse"
    );
  });

  it("authHeaders: x-goog-api-key 头随行，无 key 返回空对象", () => {
    expect(geminiAdapter.authHeaders("AIzaSyTestKey")).toEqual({
      "x-goog-api-key": "AIzaSyTestKey"
    });
    expect(geminiAdapter.authHeaders(undefined)).toEqual({});
    expect(geminiAdapter.authHeaders("")).toEqual({});
  });
});

describe("geminiAdapter: buildBody", () => {
  it("camelCase 强要求：systemInstruction 顶层且只取首条 system 消息", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: true,
      probe: false,
      messages: [
        { role: "system", content: "First system" },
        { role: "system", content: "Second system (ignored)" },
        { role: "user", content: "Hello" }
      ]
    });

    expect(body.systemInstruction).toEqual({
      parts: [{ text: "First system" }]
    });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Hello" }] }
    ]);
  });

  it("角色转换：assistant → model，连续同角色合并", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: true,
      probe: false,
      messages: [
        { role: "user", content: "Part 1" },
        { role: "user", content: "Part 2" },
        { role: "assistant", content: "Answer" }
      ]
    });

    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "Part 1" }, { text: "Part 2" }] },
      { role: "model", parts: [{ text: "Answer" }] }
    ]);
  });

  it("maxTokens 落 generationConfig.maxOutputTokens，且 off 档无 thinkingConfig", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: true,
      probe: false,
      maxTokens: 4096,
      messages: [{ role: "user", content: "Hi" }]
    });

    expect(body.generationConfig).toEqual({
      maxOutputTokens: 4096
    });
    expect((body.generationConfig as any)?.thinkingConfig).toBeUndefined();
  });
});

describe("geminiAdapter: 错误提取与 429 分类", () => {
  it("extractErrorDetail: 提取 status 与 message", () => {
    const json = JSON.stringify({
      error: {
        code: 400,
        message: "Invalid field 'xyz'",
        status: "INVALID_ARGUMENT"
      }
    });
    expect(extractGeminiErrorDetail(json)).toBe("INVALID_ARGUMENT: Invalid field 'xyz'");

    const onlyMsg = JSON.stringify({ error: { message: "Some error" } });
    expect(extractGeminiErrorDetail(onlyMsg)).toBe("Some error");

    const nonJson = "Bad Gateway";
    expect(extractGeminiErrorDetail(nonJson)).toBe("Bad Gateway");
  });

  it("429 分类：看 error.status / code 结合 message 分流 quota 终态与限流", () => {
    const quotaError = JSON.stringify({
      error: {
        code: 429,
        message: "Resource has been exhausted (e.g. check quota).",
        status: "RESOURCE_EXHAUSTED"
      }
    });
    expect(classifyGeminiError(quotaError)).toBe("quota");

    const rateLimitError = JSON.stringify({
      error: {
        code: 429,
        message: "Rate limit exceeded. Please try again later.",
        status: "RESOURCE_EXHAUSTED"
      }
    });
    expect(classifyGeminiError(rateLimitError)).toBe("rate_limit");

    const statusOnlyRateLimit = JSON.stringify({
      error: {
        code: 500,
        message: "Busy",
        status: "RESOURCE_EXHAUSTED"
      }
    });
    expect(classifyGeminiError(statusOnlyRateLimit)).toBe("rate_limit");

    const otherError = JSON.stringify({
      error: {
        code: 400,
        message: "Bad request",
        status: "INVALID_ARGUMENT"
      }
    });
    expect(classifyGeminiError(otherError)).toBe("other");
  });
});

describe("geminiAdapter: finishReason 全映射", () => {
  it("STOP → stop, MAX_TOKENS → length", () => {
    expect(mapGeminiFinishReason("STOP")).toBe("stop");
    expect(mapGeminiFinishReason("MAX_TOKENS")).toBe("length");
  });

  it("安全类/拦截类/未指定枚举 → error", () => {
    const errorReasons = [
      "SAFETY",
      "RECITATION",
      "BLOCKLIST",
      "PROHIBITED_CONTENT",
      "SPII",
      "IMAGE_SAFETY",
      "MALFORMED_FUNCTION_CALL",
      "UNEXPECTED_TOOL_CALL",
      "TOO_MANY_TOOL_CALLS",
      "LANGUAGE",
      "OTHER",
      "FINISH_REASON_UNSPECIFIED"
    ];
    for (const reason of errorReasons) {
      expect(mapGeminiFinishReason(reason), reason).toBe("error");
    }
  });

  it("未穷举值主动报错不静默吞", () => {
    expect(() => mapGeminiFinishReason("NEW_UNKNOWN_REASON")).toThrow("未穷举的 Gemini finishReason");
  });
});

describe("geminiAdapter: parseGeminiUsage", () => {
  it("计算 inputTokens = prompt - cached，outputTokens = candidates + thoughts，thoughts 单列", () => {
    const usage = parseGeminiUsage({
      promptTokenCount: 100,
      cachedContentTokenCount: 30,
      candidatesTokenCount: 50,
      thoughtsTokenCount: 20
    });
    expect(usage).toEqual({
      inputTokens: 70,
      outputTokens: 70,
      reasoningTokens: 20
    });
  });
});

describe("geminiAdapter: drainStream SSE 解析", () => {
  it("文本块逐块解析并聚合，流结束返回 finishReason 与 usage", async () => {
    const events: StreamChatEvent[] = [];
    const response = sseResponse([
      geminiSseData({
        candidates: [{ content: { parts: [{ text: "Hello" }] } }]
      }),
      geminiSseData({
        candidates: [{ content: { parts: [{ text: " world!" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
      })
    ]);

    const result = await geminiAdapter.drainStream(response, {
      onEvent: (e) => events.push(e)
    });

    expect(result.content).toBe("Hello world!");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(events).toEqual([
      { type: "token", data: "Hello" },
      { type: "token", data: " world!" }
    ]);
  });

  it("流结束无 finishReason 报错", async () => {
    const response = sseResponse([
      geminiSseData({
        candidates: [{ content: { parts: [{ text: "Cut off" }] } }]
      })
    ]);

    await expect(geminiAdapter.drainStream(response, {})).rejects.toThrow("流结束时未收到 finishReason");
  });

  it("signal 中止时抛出 makeAbortedError", async () => {
    const controller = new AbortController();
    controller.abort();

    const response = sseResponse([
      geminiSseData({
        candidates: [{ content: { parts: [{ text: "Abort" }] } }]
      })
    ]);

    await expect(geminiAdapter.drainStream(response, { signal: controller.signal })).rejects.toSatisfy(
      (err) => isAbortedMarkerError(err)
    );
  });
});

describe("geminiAdapter: parseResponse 非流式解析", () => {
  it("解析合法非流式 JSON", () => {
    const result = geminiAdapter.parseResponse({
      candidates: [
        {
          content: { parts: [{ text: "Non-streaming answer" }], role: "model" },
          finishReason: "STOP"
        }
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 }
    });

    expect(result.content).toBe("Non-streaming answer");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
  });

  it("错误 envelope 抛出 detail", () => {
    expect(() =>
      geminiAdapter.parseResponse({
        error: { code: 400, message: "Model not found", status: "NOT_FOUND" }
      })
    ).toThrow("NOT_FOUND: Model not found");
  });
});

describe("geminiAdapter: thinking 档位 × 模型家族表驱动用例", () => {
  const MATRIX: Array<{
    model: string;
    level: string | undefined;
    expectedConfig?: Record<string, unknown>;
  }> = [
    // --- gemini-3 系（离散 thinkingLevel；02 值集 minimal-low-medium-high） ---
    { model: "gemini-3-flash-preview", level: "off", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
    { model: "gemini-3-flash-preview", level: "minimal", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: true } },
    { model: "gemini-3-flash-preview", level: "low", expectedConfig: { thinkingLevel: "LOW", includeThoughts: true } },
    { model: "gemini-3-flash-preview", level: "medium", expectedConfig: { thinkingLevel: "MEDIUM", includeThoughts: true } },
    { model: "gemini-3-flash-preview", level: "high", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3-flash-preview", level: "xhigh", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3-flash-preview", level: "max", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3-flash-preview", level: "default", expectedConfig: undefined },
    { model: "gemini-3-flash-preview", level: undefined, expectedConfig: undefined },

    // --- gemini-flash-latest / lite / 3.8-flash 系列（离散 thinkingLevel） ---
    { model: "gemini-flash-latest", level: "off", expectedConfig: { thinkingLevel: "LOW", includeThoughts: false } },
    { model: "gemini-flash-latest", level: "high", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3.8-flash", level: "off", expectedConfig: { thinkingLevel: "LOW", includeThoughts: false } },
    { model: "gemini-3.8-flash", level: "minimal", expectedConfig: { thinkingLevel: "LOW", includeThoughts: true } },
    { model: "gemini-3.8-flash", level: "high", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-flash-lite-latest", level: "off", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
    { model: "gemini-flash-lite-latest", level: "low", expectedConfig: { thinkingLevel: "LOW", includeThoughts: true } },

    // --- 无可表达写点的模型：fail-closed，一个字段都不发 ---
    // 目录外 id（无任何档位事实）：不按偏好补发 thinkingLevel。
    { model: "gemini-3-flash", level: "high", expectedConfig: undefined },
    { model: "gemma-4-27b-it", level: "medium", expectedConfig: undefined },
    // 上游 toggle 值集，但 gemini 未登记开关形状：没有写点。
    { model: "gemma-4-31b-it", level: "high", expectedConfig: undefined },
    // 2.5 系上游只给区间、没有逐档数值：不发明预算，落平台默认（不干预）。
    { model: "gemini-2.5-pro", level: "off", expectedConfig: undefined },
    { model: "gemini-2.5-pro", level: "high", expectedConfig: undefined },
    { model: "gemini-2.5-flash", level: "medium", expectedConfig: undefined },
    { model: "gemini-2.5-flash-lite", level: "minimal", expectedConfig: undefined },
    { model: "gemini-4-experimental", level: "high", expectedConfig: undefined },
    { model: "gemini-4-experimental", level: "default", expectedConfig: undefined }
  ];

  for (const row of MATRIX) {
    it(`模型 ${row.model} × 档位 ${row.level ?? "undefined"} 映射正确`, () => {
      const body = geminiBody({
        model: row.model,
        baseUrl: "https://generativelanguage.googleapis.com",
        stream: true,
        probe: false,
        thinkingLevel: row.level as any,
        messages: [{ role: "user", content: "Hi" }]
      });

      const genConfig = body.generationConfig as Record<string, unknown> | undefined;
      if (row.expectedConfig) {
        expect(genConfig?.thinkingConfig).toEqual(row.expectedConfig);
      } else {
        expect(genConfig?.thinkingConfig).toBeUndefined();
      }
    });
  }
});

describe("geminiAdapter: thought 块与 thoughtSignature 保留与回放", () => {
  it("SSE 流中 thought: true 块触发 onEvent({ type: 'reasoning' })，content 只保留非 thought 块", async () => {
    const events: StreamChatEvent[] = [];
    const response = sseResponse([
      geminiSseData({
        candidates: [{
          content: {
            parts: [
              { text: "Thinking process...", thought: true },
              { text: "Answer start " }
            ]
          }
        }]
      }),
      geminiSseData({
        candidates: [{
          content: {
            parts: [
              { text: "and finish.", thought: false }
            ]
          },
          finishReason: "STOP"
        }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 15, thoughtsTokenCount: 5 }
      })
    ]);

    const result = await geminiAdapter.drainStream(response, {
      onEvent: (e) => events.push(e)
    });

    expect(result.content).toBe("Answer start and finish.");
    expect(result.finishReason).toBe("stop");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, reasoningTokens: 5 });
    expect(events).toEqual([
      { type: "reasoning", data: "Thinking process..." },
      { type: "token", data: "Answer start " },
      { type: "token", data: "and finish." }
    ]);
  });

  it("流式与非流式解析正确保留 thoughtSignature", async () => {
    const sseResp = sseResponse([
      geminiSseData({
        candidates: [{
          content: {
            parts: [
              { text: "thought", thought: true, thoughtSignature: "sig_stream_123" },
              { text: "answer" }
            ]
          },
          finishReason: "STOP"
        }]
      })
    ]);
    const streamResult = await geminiAdapter.drainStream(sseResp, {});
    expect(streamResult.thoughtSignature).toBe("sig_stream_123");

    const nonStreamResult = geminiAdapter.parseResponse({
      candidates: [{
        content: {
          parts: [
            { text: "thought", thought: true, thoughtSignature: "sig_json_456" },
            { text: "answer" }
          ]
        },
        finishReason: "STOP"
      }]
    });
    expect(nonStreamResult.thoughtSignature).toBe("sig_json_456");
    expect(nonStreamResult.content).toBe("answer");
  });

  it("buildBody: 带 thoughtSignature 的 part 原样保留不合并，空 text 仅在无 signature 时丢弃", () => {
    const body = geminiBody({
      model: "gemini-3-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: true,
      probe: false,
      messages: [
        {
          role: "assistant",
          content: "",
          parts: [
            { text: "", thought: true, thoughtSignature: "sig_empty_thought" },
            { text: "" }, // 空 text 且无 signature -> 丢弃
            { text: "non-empty part" }
          ]
        },
        {
          role: "assistant",
          content: "",
          thoughtSignature: "sig_direct_msg"
        }
      ]
    });

    expect(body.contents).toEqual([
      {
        role: "model",
        parts: [
          { text: "", thought: true, thoughtSignature: "sig_empty_thought" },
          { text: "non-empty part" },
          { text: "", thoughtSignature: "sig_direct_msg" }
        ]
      }
    ]);
  });
});

describe("geminiAdapter: Ticket 05 工具调用与 kimi-code 坑清单 (1)-(8)", () => {
  const sampleTools = [
    {
      type: "function" as const,
      function: {
        name: "web_search",
        description: "Search web for information",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"]
        }
      }
    }
  ];

  it("坑 1 & 7: 请求体一律 camelCase，包含 parametersJsonSchema，无 legacy parameters 与 snake_case 协议键", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: true,
      probe: false,
      messages: [
        { role: "system", content: "Sys prompt" },
        { role: "user", content: "Search for tests" }
      ],
      tools: sampleTools
    });

    expect(body).toHaveProperty("systemInstruction");
    expect(body).not.toHaveProperty("system_instruction");

    expect(body).toHaveProperty("tools");
    const tools = body.tools as any[];
    expect(tools[0]).toHaveProperty("functionDeclarations");
    expect(tools[0]).not.toHaveProperty("function_declarations");

    const decl = tools[0].functionDeclarations[0];
    expect(decl.name).toBe("web_search");
    expect(decl).toHaveProperty("parametersJsonSchema");
    expect(decl).not.toHaveProperty("parameters");
    expect(decl).not.toHaveProperty("parameters_json_schema");

    expect(body).toHaveProperty("toolConfig");
    expect(body).not.toHaveProperty("tool_config");
    expect((body.toolConfig as any).functionCallingConfig).toEqual({ mode: "AUTO" });
    expect(body.toolConfig as any).not.toHaveProperty("function_calling_config");

    const forbiddenSnakeKeys = [
      "system_instruction",
      "function_declarations",
      "parameters_json_schema",
      "tool_config",
      "function_calling_config",
      "max_output_tokens",
      "thinking_config"
    ];
    const str = JSON.stringify(body);
    for (const key of forbiddenSnakeKeys) {
      expect(str).not.toContain(`"${key}"`);
    }
  });

  it("坑 2: assistant 映射为 model，顶层首条 system 走 systemInstruction，中段 system 包进 user turn", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: false,
      probe: false,
      messages: [
        { role: "system", content: "Top system instruction" },
        { role: "user", content: "Query 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "system", content: "Mid-stream quota reached notice" }
      ]
    });

    expect(body.systemInstruction).toEqual({
      parts: [{ text: "Top system instruction" }]
    });

    expect(body.contents).toEqual([
      {
        role: "user",
        parts: [{ text: "Query 1" }]
      },
      {
        role: "model",
        parts: [{ text: "Reply 1" }]
      },
      {
        role: "user",
        parts: [{ text: "Mid-stream quota reached notice" }]
      }
    ]);
  });

  it("坑 3: user/model 严格交替，连续 user 合并且 functionResponse 排在最前面", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: false,
      probe: false,
      messages: [
        { role: "user", content: "Question" },
        {
          role: "assistant",
          content: "Let me search",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "web_search", arguments: JSON.stringify({ query: "ts" }) }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: JSON.stringify({ result: "found" })
        },
        {
          role: "system",
          content: "System notice mid-turn"
        },
        {
          role: "user",
          content: "Additional user note"
        }
      ]
    });

    const contents = body.contents as any[];
    expect(contents).toHaveLength(3);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");

    const userParts = contents[2].parts;
    expect(userParts).toHaveLength(3);
    expect(userParts[0]).toEqual({
      functionResponse: {
        name: "web_search",
        response: { result: "found" }
      }
    });
    expect(userParts[1]).toEqual({ text: "System notice mid-turn" });
    expect(userParts[2]).toEqual({ text: "Additional user note" });
  });

  it("坑 4: 1:1 配对校验，缺失工具响应主动报错", () => {
    expect(() =>
      geminiBody({
        model: "gemini-2.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com",
        stream: false,
        probe: false,
        messages: [
          { role: "user", content: "Query" },
          {
            role: "assistant",
            content: "Searching",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "web_search", arguments: '{"query":"a"}' }
              },
              {
                id: "call_2",
                type: "function",
                function: { name: "web_search", arguments: '{"query":"b"}' }
              }
            ]
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "res 1"
          }
        ]
      })
    ).toThrow(/Gemini 工具响应与调用未 1:1 配对/);
  });

  it("坑 4: 1:1 配对校验，重复工具响应主动报错", () => {
    expect(() =>
      geminiBody({
        model: "gemini-2.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com",
        stream: false,
        probe: false,
        messages: [
          { role: "user", content: "Query" },
          {
            role: "assistant",
            content: "Searching",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "web_search", arguments: '{"query":"a"}' }
              }
            ]
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "res 1"
          },
          {
            role: "tool",
            tool_call_id: "call_1",
            content: "res 1 duplicate"
          }
        ]
      })
    ).toThrow(/Gemini 工具响应与调用未 1:1 配对/);
  });

  it("坑 4: 1:1 配对校验，多余工具响应主动报错", () => {
    expect(() =>
      geminiBody({
        model: "gemini-2.5-flash",
        baseUrl: "https://generativelanguage.googleapis.com",
        stream: false,
        probe: false,
        messages: [
          { role: "user", content: "Query" },
          {
            role: "tool",
            tool_call_id: "call_orphan",
            content: "res"
          }
        ]
      })
    ).toThrow(/Gemini 工具响应与调用未 1:1 配对/);
  });

  it("坑 4: 多个工具结果打包进同一个 user Content", () => {
    const body = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: false,
      probe: false,
      messages: [
        { role: "user", content: "Query" },
        {
          role: "assistant",
          content: "Searching",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "search1", arguments: '{"query":"a"}' }
            },
            {
              id: "call_2",
              type: "function",
              function: { name: "search2", arguments: '{"query":"b"}' }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: "result 1"
        },
        {
          role: "tool",
          tool_call_id: "call_2",
          content: "result 2"
        }
      ]
    });

    const contents = body.contents as any[];
    expect(contents).toHaveLength(3);
    const userTurn = contents[2];
    expect(userTurn.role).toBe("user");
    expect(userTurn.parts).toHaveLength(2);
    expect(userTurn.parts[0].functionResponse.name).toBe("search1");
    expect(userTurn.parts[0].functionResponse.response).toEqual({ output: "result 1" });
    expect(userTurn.parts[1].functionResponse.name).toBe("search2");
    expect(userTurn.parts[1].functionResponse.response).toEqual({ output: "result 2" });
  });

  it("坑 5: 主版本 ≥ 3 回放 id 且清洗为 [A-Za-z0-9_-] ≤ 64；主版本 < 3 不带 id；跨轮 id 冲突不炸", () => {
    const dirtyId = "call@illegal:id!very-long-id-that-exceeds-sixty-four-characters-and-has-symbols#123456789";

    const bodyG3 = geminiBody({
      model: "gemini-3-pro",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: false,
      probe: false,
      messages: [
        { role: "user", content: "Query" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: dirtyId,
              type: "function",
              function: { name: "search", arguments: "{}" }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: dirtyId,
          content: "res"
        }
      ]
    });

    const contentsG3 = bodyG3.contents as any[];
    const g3ModelPart = contentsG3[1].parts[0];
    const g3UserPart = contentsG3[2].parts[0];
    expect(g3ModelPart.functionCall).toHaveProperty("id");
    expect(g3UserPart.functionResponse).toHaveProperty("id");
    expect(g3ModelPart.functionCall.id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(g3UserPart.functionResponse.id).toBe(g3ModelPart.functionCall.id);

    const bodyG2 = geminiBody({
      model: "gemini-2.5-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: false,
      probe: false,
      messages: [
        { role: "user", content: "Query" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_abc",
              type: "function",
              function: { name: "search", arguments: "{}" }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_abc",
          content: "res"
        }
      ]
    });
    const contentsG2 = bodyG2.contents as any[];
    const g2ModelPart = contentsG2[1].parts[0];
    const g2UserPart = contentsG2[2].parts[0];
    expect(g2ModelPart.functionCall.id).toBeUndefined();
    expect(g2UserPart.functionResponse.id).toBeUndefined();

    const bodyMultiRound = geminiBody({
      model: "gemini-3-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      stream: false,
      probe: false,
      messages: [
        { role: "user", content: "R1" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_repeat", type: "function", function: { name: "s", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_repeat", content: "r1" },
        { role: "assistant", content: "R1 done" },
        { role: "user", content: "R2" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_repeat", type: "function", function: { name: "s", arguments: "{}" } }]
        },
        { role: "tool", tool_call_id: "call_repeat", content: "r2" }
      ]
    });
    expect(bodyMultiRound.contents).toHaveLength(7);
  });

  it("坑 7: 思考开启态下 thoughtSignature 原样回放，与 functionCall 同轮不被丢失或拼接入文本", () => {
    const body = geminiBody({
      model: "gemini-3-flash",
      baseUrl: "https://generativelanguage.googleapis.com",
      thinkingLevel: "high",
      stream: true,
      probe: false,
      messages: [
        { role: "user", content: "Solve problem" },
        {
          role: "assistant",
          content: "I will call the search tool",
          thoughtSignature: "sig_turn_123",
          parts: [
            { text: "Detailed internal chain of thought", thought: true, thoughtSignature: "sig_thought_part_1" },
            { text: "I will call the search tool" }
          ],
          tool_calls: [
            {
              id: "call_tool_1",
              type: "function",
              function: { name: "web_search", arguments: '{"query":"problem"}' }
            }
          ]
        },
        {
          role: "tool",
          tool_call_id: "call_tool_1",
          content: '{"result":"solved"}'
        }
      ]
    });

    const contents = body.contents as any[];
    expect(contents).toHaveLength(3);
    const modelParts = contents[1].parts;
    expect(modelParts).toHaveLength(3);
    expect(modelParts[0]).toEqual({
      text: "Detailed internal chain of thought",
      thought: true,
      thoughtSignature: "sig_thought_part_1"
    });
    expect(modelParts[1]).toEqual({
      text: "I will call the search tool"
    });
    expect(modelParts[2]).toEqual({
      functionCall: {
        name: "web_search",
        args: { query: "problem" },
        id: "call_tool_1"
      }
    });
  });

  it("坑 8: 流式与非流式下，工具调用只从 parts[].functionCall 取，有工具调用时 finishReason 归一为 tool_calls 并触发 tool-call 事件", async () => {
    const events: StreamChatEvent[] = [];
    const streamResp = sseResponse([
      geminiSseData({
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: "web_search",
                    args: { query: "vitest gemini" },
                    id: "call_stream_1"
                  }
                }
              ]
            },
            finishReason: "STOP"
          }
        ]
      })
    ]);

    const streamResult = await geminiAdapter.drainStream(streamResp, {
      onEvent: (e) => events.push(e)
    });

    expect(streamResult.finishReason).toBe("tool_calls");
    expect(streamResult.toolCalls).toEqual([
      {
        id: "call_stream_1",
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query: "vitest gemini" })
        }
      }
    ]);
    expect(events).toEqual([
      {
        type: "tool-call",
        name: "web_search",
        args: { query: "vitest gemini" }
      }
    ]);

    const nonStreamResult = geminiAdapter.parseResponse({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "web_search",
                  args: { query: "json query" },
                  id: "call_json_1"
                }
              }
            ]
          },
          finishReason: "STOP"
        }
      ]
    });

    expect(nonStreamResult.finishReason).toBe("tool_calls");
    expect(nonStreamResult.toolCalls).toEqual([
      {
        id: "call_json_1",
        type: "function",
        function: {
          name: "web_search",
          arguments: JSON.stringify({ query: "json query" })
        }
      }
    ]);
  });
});


describe("geminiAdapter.listModels（Gemini 原生 models.list）", () => {
  function modelsJsonResponse(status: number, body: unknown) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: vi.fn(async () => (typeof body === "string" ? body : JSON.stringify(body))),
      json: vi.fn(async () => body)
    } as unknown as Response;
  }

  it("走 /v1beta/models + x-goog-api-key，剥 models/ 前缀并滤掉非 generateContent 条目", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) =>
      modelsJsonResponse(200, {
        models: [
          { name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/gemini-aqa" }
        ]
      })
    );

    const resp = await geminiAdapter.listModels({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "gk-1",
      fetchImpl: fetchMock
    });

    expect(resp).toEqual({ ok: true, models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-aqa"] });
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(init.headers["x-goog-api-key"]).toBe("gk-1");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("baseUrl 带 /v1beta 尾段不重复拼接；nextPageToken 翻页多程合并", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        modelsJsonResponse(200, {
          models: [{ name: "models/gemini-2.5-pro", supportedGenerationMethods: ["generateContent"] }],
          nextPageToken: "tok-2"
        })
      )
      .mockResolvedValueOnce(
        modelsJsonResponse(200, {
          models: [{ name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] }]
        })
      );

    const resp = await geminiAdapter.listModels({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/",
      apiKey: "gk-1",
      fetchImpl: fetchMock
    });

    expect(resp).toEqual({ ok: true, models: ["gemini-2.5-pro", "gemini-2.5-flash"] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect(fetchMock.mock.calls[1][0]).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageToken=tok-2");
  });

  it("HTTP 错误回 `HTTP <status>: <body 截断>`，不再翻页", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => modelsJsonResponse(403, "API key not valid"));

    const resp = await geminiAdapter.listModels({
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "gk-1",
      fetchImpl: fetchMock
    });

    expect(resp).toEqual({ ok: false, error: "HTTP 403: API key not valid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
