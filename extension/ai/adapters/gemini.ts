// ai/adapters/gemini.ts — Gemini 原生 generateContent 协议适配器（ADR-0018）。
// 手撸 fetch + SSE 逐块解析，零新增依赖，天然支持 AbortSignal。
import { makeAbortedError } from "../../shared/error-helpers.js";
import type { ChatRequest, DrainContext, DrainResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatToolCall, ChatUsage } from "../types.js";
import type { CompatQuirk } from "../compat-vocab.js";

export const GEMINI_ERROR_FINISH_REASONS = new Set([
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
]);

/** finishReason 映射（借 pi-ai mapStopReason） */
export function mapGeminiFinishReason(reason: string): string {
  switch (reason) {
    case "STOP":
      return "stop";
    case "MAX_TOKENS":
      return "length";
    default:
      if (GEMINI_ERROR_FINISH_REASONS.has(reason)) {
        return "error";
      }
      throw new Error(`未穷举的 Gemini finishReason: ${reason}`);
  }
}

/** 429 错误分类：看 error.status/code 字段分流 quota 终态与限流，不只正则 message */
export type GeminiErrorCategory = "quota" | "rate_limit" | "other";

export function classifyGeminiError(bodyText: string): GeminiErrorCategory {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; message?: unknown; status?: unknown };
    };
    const code = Number(parsed.error?.code);
    const status = String(parsed.error?.status || "");
    const message = String(parsed.error?.message || "");

    const is429 = code === 429 || status === "RESOURCE_EXHAUSTED";
    if (is429) {
      if (/quota/i.test(message)) {
        return "quota";
      }
      return "rate_limit";
    }
  } catch {}
  return "other";
}

/** HTTP 错误体提取：按 { error: { code, message, status } } 提取 */
export function extractGeminiErrorDetail(bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as {
      error?: { code?: unknown; message?: unknown; status?: unknown };
    };
    const status = typeof parsed.error?.status === "string" ? parsed.error.status : "";
    const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
    if (status && message) return `${status}: ${message}`;
    if (message) return message;
    if (status) return status;
  } catch {}
  return bodyText;
}

/** 响应 usage 采集：input = promptTokenCount - cachedContentTokenCount，output = candidatesTokenCount + thoughtsTokenCount */
export function parseGeminiUsage(metadata: unknown): ChatUsage | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  const promptTokenCount = typeof m.promptTokenCount === "number" && Number.isFinite(m.promptTokenCount) ? m.promptTokenCount : 0;
  const cachedContentTokenCount = typeof m.cachedContentTokenCount === "number" && Number.isFinite(m.cachedContentTokenCount) ? m.cachedContentTokenCount : 0;
  const candidatesTokenCount = typeof m.candidatesTokenCount === "number" && Number.isFinite(m.candidatesTokenCount) ? m.candidatesTokenCount : 0;
  const thoughtsTokenCount = typeof m.thoughtsTokenCount === "number" && Number.isFinite(m.thoughtsTokenCount) ? m.thoughtsTokenCount : undefined;

  const inputTokens = Math.max(0, promptTokenCount - cachedContentTokenCount);
  const outputTokens = candidatesTokenCount + (thoughtsTokenCount ?? 0);

  const usage: ChatUsage = {};
  if (inputTokens > 0 || promptTokenCount > 0) usage.inputTokens = inputTokens;
  if (outputTokens > 0 || candidatesTokenCount > 0) usage.outputTokens = outputTokens;
  if (thoughtsTokenCount !== undefined) usage.reasoningTokens = thoughtsTokenCount;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** 端点拼装：baseUrl 为 host 根，去尾部版本段避免 /v1beta/v1beta */
export function buildGeminiEndpoint(baseUrl: string, options?: { model?: string; stream?: boolean }): string {
  const cleanBaseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1beta$/, "");
  const model = (options?.model ?? "{model}").replace(/^models\//, "");
  const action = options?.stream === false ? "generateContent" : "streamGenerateContent?alt=sse";
  return `${cleanBaseUrl}/v1beta/models/${model}:${action}`;
}

/** 请求体组装：camelCase 强要求（systemInstruction 顶层且只取首条、maxOutputTokens 落 generationConfig） */
export function buildGeminiRequestBody(request: ChatRequest): Record<string, unknown> {
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  const systemMsg = request.messages.find((m) => m.role === "system");
  const systemInstruction =
    systemMsg && typeof systemMsg.content === "string" && systemMsg.content.trim()
      ? { parts: [{ text: systemMsg.content }] }
      : undefined;

  for (const msg of request.messages) {
    if (msg.role === "system") continue;
    const role: "user" | "model" = msg.role === "assistant" ? "model" : "user";
    const text = typeof msg.content === "string" ? msg.content : "";
    if (contents.length > 0 && contents[contents.length - 1].role === role) {
      contents[contents.length - 1].parts.push({ text });
    } else {
      contents.push({ role, parts: [{ text }] });
    }
  }

  const generationConfig: Record<string, unknown> = {};
  if (typeof request.maxTokens === "number" && Number.isFinite(request.maxTokens)) {
    generationConfig.maxOutputTokens = request.maxTokens;
  }

  const body: Record<string, unknown> = {
    contents
  };
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }

  return body;
}

export async function drainGeminiSseStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("响应没有可读流");
  }
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let usage: ChatUsage | undefined;
  const toolCalls: ChatToolCall[] = [];

  const processLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data) return;

    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed.error) {
      throw new Error(extractGeminiErrorDetail(JSON.stringify(parsed)));
    }

    if (parsed.usageMetadata) {
      const u = parseGeminiUsage(parsed.usageMetadata);
      if (u) usage = u;
    }

    if (Array.isArray(parsed.candidates)) {
      for (const candidate of parsed.candidates) {
        if (candidate.finishReason) {
          finishReason = mapGeminiFinishReason(candidate.finishReason);
        }
        const parts = candidate.content?.parts;
        if (Array.isArray(parts)) {
          for (const part of parts) {
            if (typeof part.text === "string" && part.text) {
              content += part.text;
              ctx.onEvent?.({ type: "token", data: part.text });
            }
          }
        }
      }
    }
  };

  while (true) {
    if (ctx.signal?.aborted) {
      throw makeAbortedError();
    }
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop()! : "";

    for (const rawLine of lines) {
      processLine(rawLine);
    }
  }

  if (buffer.trim()) {
    processLine(buffer.trim());
  }

  if (!finishReason) {
    throw new Error("流结束时未收到 finishReason");
  }

  return {
    content,
    toolCalls,
    finishReason,
    ...(usage ? { usage } : {})
  };
}

export function parseGeminiResponse(json: unknown): DrainResult {
  if (!json || typeof json !== "object") {
    throw new Error("Gemini 响应非合法 JSON 对象");
  }
  const data = json as Record<string, unknown>;
  if (data.error) {
    throw new Error(extractGeminiErrorDetail(JSON.stringify(data)));
  }

  let content = "";
  let finishReason: string | null = null;
  const toolCalls: ChatToolCall[] = [];

  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  if (candidates.length > 0) {
    const candidate = candidates[0] as Record<string, unknown>;
    if (typeof candidate.finishReason === "string") {
      finishReason = mapGeminiFinishReason(candidate.finishReason);
    }
    const parts = (candidate.content as { parts?: unknown[] })?.parts;
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const p = part as Record<string, unknown>;
        if (typeof p.text === "string") {
          content += p.text;
        }
      }
    }
  }

  const usage = parseGeminiUsage(data.usageMetadata);
  return {
    content,
    toolCalls,
    finishReason,
    ...(usage ? { usage } : {})
  };
}

export const geminiAdapter: ProtocolAdapter = {
  protocol: "gemini",
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },
  consumes: [] as readonly CompatQuirk[],
  endpoint(baseUrl: string, options?: { model?: string; stream?: boolean }): string {
    return buildGeminiEndpoint(baseUrl, options);
  },
  authHeaders(apiKey: string | undefined): Record<string, string> {
    return apiKey ? { "x-goog-api-key": apiKey } : {};
  },
  buildBody(request: ChatRequest): Record<string, unknown> {
    return buildGeminiRequestBody(request);
  },
  extractErrorDetail(bodyText: string): string {
    return extractGeminiErrorDetail(bodyText);
  },
  async drainStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
    return drainGeminiSseStream(response, ctx);
  },
  parseResponse(json: unknown): DrainResult {
    return parseGeminiResponse(json);
  }
};
