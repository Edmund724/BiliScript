// ai/adapters/gemini.ts — Gemini 原生 generateContent 协议适配器（ADR-0018）。
// 手撸 fetch + SSE 逐块解析，零新增依赖，天然支持 AbortSignal。
import { makeAbortedError } from "../../shared/error-helpers.js";
import type { ChatRequest, ChatToolDefinition, DrainContext, DrainResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatMessage, ChatToolCall, ChatUsage } from "../types.js";
import type { CompatQuirk } from "../compat-vocab.js";
import { planThinkingWire } from "../plan-thinking.js";

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
/** 宽容解析 tool query（用于 tool-call 事件） */
export function parseToolArgs(rawArguments: string): { query: string } {
  try {
    const parsed = JSON.parse(rawArguments);
    if (parsed && typeof parsed === "object" && typeof (parsed as any).query === "string") {
      return { query: (parsed as any).query };
    }
    return { query: rawArguments };
  } catch {
    return { query: rawArguments };
  }
}

/** 主版本 ≥3 模型判断（按 pi-ai 口径，仅 gemini 主版本 ≥3 回放 id） */
export function isGemini3OrHigher(model: string): boolean {
  const clean = model.replace(/^models\//, "");
  return /^(gemini-[3-9]|gemini-[1-9][0-9]|gemma-[4-9])/i.test(clean);
}

/** 清洗 id 为 [A-Za-z0-9_-] 且 ≤64 字符 */
export function sanitizeGeminiCallId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "call_0";
}

/** 工具声明与配置转换：camelCase 强要求、parametersJsonSchema 完整 JSON Schema */
export function toGeminiToolsAndConfig(tools: ChatToolDefinition[] | undefined): {
  tools?: Array<{ functionDeclarations: Array<{ name: string; description: string; parametersJsonSchema: Record<string, unknown> }> }>;
  toolConfig?: { functionCallingConfig: { mode: "AUTO" } };
} {
  if (!tools || tools.length === 0) return {};
  return {
    tools: [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.function.name,
          description: t.function.description,
          parametersJsonSchema: t.function.parameters
        }))
      }
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO"
      }
    }
  };
}

interface PendingCall {
  id?: string;
  name: string;
  responded: boolean;
}

/** 历史角色转换与严格交替合并、1:1 配对校验 */
export function convertGeminiMessages(
  messages: ChatMessage[],
  model: string
): {
  systemInstruction?: { parts: Array<{ text: string }> };
  contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }>;
} {
  const isG3 = isGemini3OrHigher(model);

  // 1. 提取顶层首条 system 消息作为 systemInstruction（仅在遇到非 system 消息之前）
  let systemInstruction: { parts: Array<{ text: string }> } | undefined;
  let topSystemIdx = -1;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "system") {
      topSystemIdx = i;
      break;
    } else {
      break;
    }
  }
  if (topSystemIdx !== -1) {
    const sysMsg = messages[topSystemIdx];
    if (typeof sysMsg.content === "string" && sysMsg.content.trim()) {
      systemInstruction = { parts: [{ text: sysMsg.content }] };
    }
  }

  // 2. 遍历消息并处理 1:1 配对与角色转换
  const intermediateTurns: Array<{
    role: "user" | "model";
    parts: Array<Record<string, unknown>>;
  }> = [];

  let pendingCalls: PendingCall[] = [];
  let hasEncounteredNonSystem = false;

  for (let i = 0; i < messages.length; i++) {
    // 忽略被提取为 systemInstruction 的顶层首条 system 消息
    if (i === topSystemIdx) {
      continue;
    }

    const msg = messages[i];

    if (msg.role === "system") {
      if (!hasEncounteredNonSystem) {
        continue;
      }
      // 中段 system 消息：包进 user turn
      if (typeof msg.content === "string" && msg.content !== "") {
        intermediateTurns.push({
          role: "user",
          parts: [{ text: msg.content }]
        });
      }
      continue;
    }

    hasEncounteredNonSystem = true;

    if (msg.role === "assistant") {
      // 遇到新的 assistant (model) 消息前，上轮 calls 必须全部已响应
      const unresponded = pendingCalls.find((c) => !c.responded);
      if (unresponded) {
        throw new Error(`Gemini 工具响应与调用未 1:1 配对: 工具调用 '${unresponded.name}' 缺失响应`);
      }
      pendingCalls = [];

      const parts: Array<Record<string, unknown>> = [];

      if (Array.isArray(msg.parts) && msg.parts.length > 0) {
        for (const rawPart of msg.parts) {
          if (!rawPart || typeof rawPart !== "object") continue;
          const p = rawPart as Record<string, unknown>;
          if (p.functionCall && typeof p.functionCall === "object") {
            const rawFc = p.functionCall as Record<string, unknown>;
            const fcName = String(rawFc.name || "");
            const fcId = typeof rawFc.id === "string" ? rawFc.id : undefined;
            const fcArgs = typeof rawFc.args === "object" && rawFc.args !== null ? rawFc.args : {};
            const fc: Record<string, unknown> = {
              name: fcName,
              args: fcArgs
            };
            if (isG3 && fcId) {
              fc.id = sanitizeGeminiCallId(fcId);
            }
            parts.push({ functionCall: fc });
            pendingCalls.push({ id: fcId, name: fcName, responded: false });
          } else if (p.thoughtSignature) {
            parts.push({ ...p });
          } else if (typeof p.text === "string") {
            if (p.text !== "") {
              parts.push({ ...p });
            }
          } else {
            parts.push({ ...p });
          }
        }
      } else {
        // 先放文本或思考
        if (msg.thoughtSignature) {
          parts.push({
            ...(typeof msg.content === "string" ? { text: msg.content } : { text: "" }),
            thoughtSignature: msg.thoughtSignature
          });
        } else if (typeof msg.content === "string" && msg.content !== "") {
          parts.push({ text: msg.content });
        }
      }

      // 再放 tool_calls（兼容 parts 只存放了 thought/text 的 assistant 消息）
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          if (parts.some((p) => p.functionCall && (p.functionCall as any).id === call.id)) {
            continue;
          }
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = { query: call.function.arguments };
          }
          if (!args || typeof args !== "object" || Array.isArray(args)) {
            args = { query: String(call.function.arguments) };
          }
          const fc: Record<string, unknown> = {
            name: call.function.name,
            args
          };
          if (isG3 && call.id) {
            fc.id = sanitizeGeminiCallId(call.id);
          }
          parts.push({ functionCall: fc });
          pendingCalls.push({ id: call.id, name: call.function.name, responded: false });
        }
      }

      if (parts.length > 0) {
        intermediateTurns.push({ role: "model", parts });
      }
    } else if (msg.role === "tool") {
      // 工具响应必须配对前一轮 call
      if (pendingCalls.length === 0) {
        throw new Error("Gemini 工具响应与调用未 1:1 配对: 收到多余的工具响应（未发起调用）");
      }

      let matchedCall: PendingCall | undefined;
      if (msg.tool_call_id) {
        matchedCall = pendingCalls.find((c) => c.id === msg.tool_call_id);
        if (!matchedCall) {
          throw new Error(`Gemini 工具响应与调用未 1:1 配对: 找不到对应 id '${msg.tool_call_id}' 的工具调用`);
        }
        if (matchedCall.responded) {
          throw new Error(`Gemini 工具响应与调用未 1:1 配对: 工具调用 '${msg.tool_call_id}' 收到重复响应`);
        }
      } else {
        matchedCall = pendingCalls.find((c) => !c.responded);
        if (!matchedCall) {
          throw new Error("Gemini 工具响应与调用未 1:1 配对: 收到多余的工具响应");
        }
      }

      matchedCall.responded = true;

      let responseObj: Record<string, unknown>;
      try {
        const parsed = JSON.parse(msg.content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          responseObj = parsed;
        } else {
          responseObj = { output: msg.content };
        }
      } catch {
        responseObj = { output: msg.content };
      }

      const fr: Record<string, unknown> = {
        name: matchedCall.name,
        response: responseObj
      };
      if (isG3 && (matchedCall.id || msg.tool_call_id)) {
        fr.id = sanitizeGeminiCallId(matchedCall.id || msg.tool_call_id!);
      }

      intermediateTurns.push({
        role: "user",
        parts: [{ functionResponse: fr }]
      });
    } else {
      // user 角色
      const parts: Array<Record<string, unknown>> = [];
      if (Array.isArray(msg.parts) && msg.parts.length > 0) {
        for (const rawPart of msg.parts) {
          if (!rawPart || typeof rawPart !== "object") continue;
          const p = rawPart as Record<string, unknown>;
          if (p.thoughtSignature) {
            parts.push({ ...p });
          } else if (typeof p.text === "string") {
            if (p.text !== "") {
              parts.push({ ...p });
            }
          } else {
            parts.push({ ...p });
          }
        }
      } else {
        if (msg.thoughtSignature) {
          parts.push({
            ...(typeof msg.content === "string" ? { text: msg.content } : { text: "" }),
            thoughtSignature: msg.thoughtSignature
          });
        } else if (typeof msg.content === "string" && msg.content !== "") {
          parts.push({ text: msg.content });
        }
      }

      if (parts.length > 0) {
        intermediateTurns.push({ role: "user", parts });
      }
    }
  }

  // 3. 所有消息遍历完毕后，检查是否还有未响应的 call
  const unresponded = pendingCalls.find((c) => !c.responded);
  if (unresponded) {
    throw new Error(`Gemini 工具响应与调用未 1:1 配对: 工具调用 '${unresponded.name}' 缺失响应`);
  }

  // 4. user/model 严格交替与合并：连续同角色合并
  const contents: Array<{ role: "user" | "model"; parts: Array<Record<string, unknown>> }> = [];

  for (const turn of intermediateTurns) {
    if (contents.length > 0 && contents[contents.length - 1].role === turn.role) {
      contents[contents.length - 1].parts.push(...turn.parts);
    } else {
      contents.push({ role: turn.role, parts: [...turn.parts] });
    }
  }

  // 针对每个 user turn，将 functionResponse 排在最前面，其余 parts 保持相对顺序
  for (const content of contents) {
    if (content.role === "user") {
      const funcResponses: Array<Record<string, unknown>> = [];
      const others: Array<Record<string, unknown>> = [];
      for (const part of content.parts) {
        if ("functionResponse" in part) {
          funcResponses.push(part);
        } else {
          others.push(part);
        }
      }
      content.parts = [...funcResponses, ...others];
    }
  }

  return { systemInstruction, contents };
}

/** 请求体组装：camelCase 强要求（systemInstruction 顶层且只取首条、maxOutputTokens 落 generationConfig、工具配置） */
export function buildGeminiRequestBody(request: ChatRequest): Record<string, unknown> {
  const { systemInstruction, contents } = convertGeminiMessages(request.messages, request.model);

  const wire = planThinkingWire({
    protocol: "gemini",
    model: request.model,
    presetId: request.presetId,
    baseUrl: request.baseUrl,
    level: request.thinkingLevel,
    stream: request.stream,
    probe: request.probe === true
  });

  const generationConfig: Record<string, unknown> = {};
  if (wire.fields.thinkingConfig) {
    generationConfig.thinkingConfig = wire.fields.thinkingConfig;
  }
  if (typeof request.maxTokens === "number" && Number.isFinite(request.maxTokens)) {
    generationConfig[wire.tokenParam] = request.maxTokens;
  }

  const { tools, toolConfig } = toGeminiToolsAndConfig(request.tools);

  const body: Record<string, unknown> = {
    contents
  };
  if (systemInstruction) {
    body.systemInstruction = systemInstruction;
  }
  if (Object.keys(generationConfig).length > 0) {
    body.generationConfig = generationConfig;
  }
  if (tools) {
    body.tools = tools;
  }
  if (toolConfig) {
    body.toolConfig = toolConfig;
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
  let thoughtSignature: string | undefined;
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
            if (typeof part.thoughtSignature === "string") {
              thoughtSignature = part.thoughtSignature;
            }
            if (part.thought === true) {
              if (typeof part.text === "string" && part.text) {
                ctx.onEvent?.({ type: "reasoning", data: part.text });
              }
            } else if (part.functionCall && typeof part.functionCall === "object") {
              const fc = part.functionCall;
              const name = String(fc.name || "");
              const argsObj = typeof fc.args === "object" && fc.args !== null ? fc.args : {};
              const argsStr = JSON.stringify(argsObj);
              const callId = typeof fc.id === "string" && fc.id ? fc.id : `call_${toolCalls.length}`;
              toolCalls.push({
                id: callId,
                type: "function",
                function: {
                  name,
                  arguments: argsStr
                }
              });
              ctx.onEvent?.({
                type: "tool-call",
                name,
                args: parseToolArgs(argsStr)
              });
            } else if (typeof part.text === "string" && part.text) {
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

  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  }

  if (!finishReason) {
    throw new Error("流结束时未收到 finishReason");
  }

  return {
    content,
    toolCalls,
    finishReason,
    ...(usage ? { usage } : {}),
    ...(thoughtSignature ? { thoughtSignature } : {})
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
  let thoughtSignature: string | undefined;
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
        if (typeof p.thoughtSignature === "string") {
          thoughtSignature = p.thoughtSignature;
        }
        if (p.thought === true) {
          continue;
        }
        if (p.functionCall && typeof p.functionCall === "object") {
          const fc = p.functionCall as Record<string, unknown>;
          const name = String(fc.name || "");
          const argsObj = typeof fc.args === "object" && fc.args !== null ? fc.args : {};
          const argsStr = JSON.stringify(argsObj);
          const callId = typeof fc.id === "string" && fc.id ? fc.id : `call_${toolCalls.length}`;
          toolCalls.push({
            id: callId,
            type: "function",
            function: {
              name,
              arguments: argsStr
            }
          });
        } else if (typeof p.text === "string") {
          content += p.text;
        }
      }
    }
  }

  if (toolCalls.length > 0) {
    finishReason = "tool_calls";
  }

  const usage = parseGeminiUsage(data.usageMetadata);
  return {
    content,
    toolCalls,
    finishReason,
    ...(usage ? { usage } : {}),
    ...(thoughtSignature ? { thoughtSignature } : {})
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
