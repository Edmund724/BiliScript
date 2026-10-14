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
import { isAbortedMarkerError } from "../../extension/shared/error-helpers.js";
import type { StreamChatEvent } from "../../extension/ai/types.js";

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
    const body = geminiAdapter.buildBody({
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
    const body = geminiAdapter.buildBody({
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
    const body = geminiAdapter.buildBody({
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

describe("geminiAdapter: thinking 双轨全档位 × 全模型家族表驱动用例", () => {
  const MATRIX: Array<{
    model: string;
    level: string | undefined;
    expectedConfig?: Record<string, unknown>;
  }> = [
    // --- gemini-3 系列 (离散 thinkingLevel) ---
    { model: "gemini-3-flash", level: "off", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
    { model: "gemini-3-flash", level: "minimal", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: true } },
    { model: "gemini-3-flash", level: "low", expectedConfig: { thinkingLevel: "LOW", includeThoughts: true } },
    { model: "gemini-3-flash", level: "medium", expectedConfig: { thinkingLevel: "MEDIUM", includeThoughts: true } },
    { model: "gemini-3-flash", level: "high", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3-flash", level: "xhigh", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3-flash", level: "max", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-3-flash", level: "default", expectedConfig: undefined },
    { model: "gemini-3-flash", level: undefined, expectedConfig: undefined },

    // --- gemini-flash-latest / lite / gemma-4 系列 (离散 thinkingLevel) ---
    { model: "gemini-flash-latest", level: "off", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
    { model: "gemini-flash-latest", level: "high", expectedConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
    { model: "gemini-flash-lite-latest", level: "off", expectedConfig: { thinkingLevel: "MINIMAL", includeThoughts: false } },
    { model: "gemini-flash-lite-latest", level: "low", expectedConfig: { thinkingLevel: "LOW", includeThoughts: true } },
    { model: "gemma-4-27b-it", level: "medium", expectedConfig: { thinkingLevel: "MEDIUM", includeThoughts: true } },

    // --- gemini-2.5-pro (数值 thinkingBudget) ---
    { model: "gemini-2.5-pro", level: "off", expectedConfig: { thinkingBudget: 0, includeThoughts: false } },
    { model: "gemini-2.5-pro", level: "minimal", expectedConfig: { thinkingBudget: 128, includeThoughts: true } },
    { model: "gemini-2.5-pro", level: "low", expectedConfig: { thinkingBudget: 2048, includeThoughts: true } },
    { model: "gemini-2.5-pro", level: "medium", expectedConfig: { thinkingBudget: 8192, includeThoughts: true } },
    { model: "gemini-2.5-pro", level: "high", expectedConfig: { thinkingBudget: 32768, includeThoughts: true } },
    { model: "gemini-2.5-pro", level: "xhigh", expectedConfig: { thinkingBudget: 32768, includeThoughts: true } },
    { model: "gemini-2.5-pro", level: "max", expectedConfig: { thinkingBudget: 32768, includeThoughts: true } },
    { model: "gemini-2.5-pro", level: "default", expectedConfig: undefined },

    // --- gemini-2.5-flash (数值 thinkingBudget) ---
    { model: "gemini-2.5-flash", level: "off", expectedConfig: { thinkingBudget: 0, includeThoughts: false } },
    { model: "gemini-2.5-flash", level: "minimal", expectedConfig: { thinkingBudget: 128, includeThoughts: true } },
    { model: "gemini-2.5-flash", level: "low", expectedConfig: { thinkingBudget: 2048, includeThoughts: true } },
    { model: "gemini-2.5-flash", level: "medium", expectedConfig: { thinkingBudget: 8192, includeThoughts: true } },
    { model: "gemini-2.5-flash", level: "high", expectedConfig: { thinkingBudget: 24576, includeThoughts: true } },
    { model: "gemini-2.5-flash", level: "xhigh", expectedConfig: { thinkingBudget: 24576, includeThoughts: true } },
    { model: "gemini-2.5-flash", level: "max", expectedConfig: { thinkingBudget: 24576, includeThoughts: true } },

    // --- gemini-2.5-flash-lite (数值 thinkingBudget) ---
    { model: "gemini-2.5-flash-lite", level: "off", expectedConfig: { thinkingBudget: 0, includeThoughts: false } },
    { model: "gemini-2.5-flash-lite", level: "minimal", expectedConfig: { thinkingBudget: 512, includeThoughts: true } },
    { model: "gemini-2.5-flash-lite", level: "low", expectedConfig: { thinkingBudget: 2048, includeThoughts: true } },
    { model: "gemini-2.5-flash-lite", level: "medium", expectedConfig: { thinkingBudget: 8192, includeThoughts: true } },
    { model: "gemini-2.5-flash-lite", level: "high", expectedConfig: { thinkingBudget: 24576, includeThoughts: true } },
    { model: "gemini-2.5-flash-lite", level: "xhigh", expectedConfig: { thinkingBudget: 24576, includeThoughts: true } },
    { model: "gemini-2.5-flash-lite", level: "max", expectedConfig: { thinkingBudget: 24576, includeThoughts: true } },

    // --- 其它 / 未识别模型家族（动态 -1） ---
    { model: "gemini-4-experimental", level: "off", expectedConfig: { thinkingBudget: 0, includeThoughts: false } },
    { model: "gemini-4-experimental", level: "minimal", expectedConfig: { thinkingBudget: 128, includeThoughts: true } },
    { model: "gemini-4-experimental", level: "low", expectedConfig: { thinkingBudget: 2048, includeThoughts: true } },
    { model: "gemini-4-experimental", level: "medium", expectedConfig: { thinkingBudget: 8192, includeThoughts: true } },
    { model: "gemini-4-experimental", level: "high", expectedConfig: { thinkingBudget: -1, includeThoughts: true } },
    { model: "gemini-4-experimental", level: "xhigh", expectedConfig: { thinkingBudget: -1, includeThoughts: true } },
    { model: "gemini-4-experimental", level: "max", expectedConfig: { thinkingBudget: -1, includeThoughts: true } },
    { model: "gemini-4-experimental", level: "default", expectedConfig: undefined }
  ];

  for (const row of MATRIX) {
    it(`模型 ${row.model} × 档位 ${row.level ?? "undefined"} 映射正确`, () => {
      const body = geminiAdapter.buildBody({
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
    const body = geminiAdapter.buildBody({
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

