// ai/adapters/openai.ts — OpenAI compatible 协议适配器（multi-protocol-ai）。
// 现有 completion.ts 的 OpenAI 行为迁入本文件，列举项逐字节不变：
// OPENAI_CHAT_PATH / buildChatRequestBody（思考档位查表 + tokenParam 分流 + tools
// 透传）/ drainSseStream（data:-only 行解析、[DONE] 跳过、tool-call-fragment 按
// index 聚合）/ 非流式 choices 提取。唯一新增 extractErrorDetail（错误 envelope
// 提取）——spec 错误归一化要求，core 统一加 `[协议名] ` 前缀与 200 字符截断。
// core（completion.ts）只留重试/中止/溢出/探针骨架。
import { parseSsePayload } from "../sse-parser.js";
import { makeAbortedError } from "../../shared/error-helpers.js";
import { normalizeThinkingLevel, resolveThinkingProfile } from "../thinking-profiles.js";
import type { ChatMessage, ChatToolCall } from "../types.js";
import type { ChatRequest, ChatToolDefinition, DrainContext, DrainResult, ProtocolAdapter } from "../protocol-adapter.js";

// OpenAI 兼容协议 chat 路径。
// 覆盖 OpenAI / DeepSeek / Qwen / Zhipu / Kimi / MiniMax / Mimo / Opencode Go / OpenRouter / Stepfun / Ollama（OpenAI 兼容模式）等。
export const OPENAI_CHAT_PATH = "/chat/completions";

interface BuildChatRequestBodyInput {
  model: string;
  messages: ChatRequest["messages"];
  stream?: boolean;
  thinkingLevel?: string;
  maxTokens?: number | null;
  // 思考参数查表的 provider 识别输入：presetId（preset 词表键）是主路径，
  // baseUrl host 推断兜底（custom/旧记录）。
  baseUrl?: string;
  presetId?: string;
  // 联网搜索管线：传入即随请求体带 tools + tool_choice: "auto"。
  tools?: ChatToolDefinition[];
}

// 带图消息的线格式（image-input 路线 B）：content 从字符串翻成 text / image_url
// 块数组；无图消息保持字符串，线形状与改动前逐字节一致。
type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireMessage extends Omit<ChatMessage, "content" | "images"> {
  content: string | ChatContentPart[];
}

// type 而非 interface：对象字面量类型可隐式赋给 Record<string, unknown>
//（adapter.buildBody 的返回签名），interface 无此隐式索引签名。
type ChatRequestBody = {
  model: string;
  messages: WireMessage[];
  stream: boolean;
  reasoning_effort?: string;
  max_tokens?: number;
  max_completion_tokens?: number;
  thinking?: { type: string };
  enable_thinking?: boolean;
  tools?: ChatToolDefinition[];
  tool_choice?: "auto";
}

// 消息翻译（image-input 路线 B）：带 images 的消息把 content 翻成 content parts
//（text 块 + 每张图一个 image_url 块，url 为 data:<mime>;base64,<b64>）；text 块
// 仅在正文非空时发出——空 text 块部分兼容端点会 400。无图消息的线形状与改动前
// 逐字节一致（images 字段不上线，是个纯本地字段）。
function toWireMessages(messages: ChatMessage[]): WireMessage[] {
  return messages.map(({ images, ...message }) => {
    if (!images?.length) return message;
    const parts: ChatContentPart[] = [];
    if (message.content) parts.push({ type: "text", text: message.content });
    for (const image of images) {
      parts.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.data}` } });
    }
    return { ...message, content: parts };
  });
}

/**
 * 构造 chat/completions 请求体（纯函数，便于单测；请求构造单点）。
 * stream 显式传递（流式 true / 非流式 false）；maxTokens 供探针传 1。
 * 思考字段由 thinking-profiles 的 resolveThinkingProfile 查表决定：平台
 * （presetId / baseUrl host）× 模型（例外表 >> 模式表）→ 档位 patch；查不到
 * 事实（unknown 哨兵）或缺档一律不发字段——软失败优于硬 400。resolver 返回的
 * offUnavailable / thinkingClass（03 对话提示）本函数不消费；tokenParam（04
 * token 参数映射）在 maxTokens 写入时消费：openai-reasoning 系写
 * max_completion_tokens，其余类与 unknown 维持 max_tokens 现状。
 * messages 经 toWireMessages 翻译：带图消息的 content → text/image_url 块数组，
 * 无图消息原字段原值透传。
 */
export function buildChatRequestBody({ model, messages, stream = false, thinkingLevel, maxTokens, baseUrl, presetId, tools }: BuildChatRequestBodyInput): ChatRequestBody {
  const body: ChatRequestBody = { model, messages: toWireMessages(messages), stream };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  const thinking = resolveThinkingProfile({
    presetId,
    baseUrl,
    model,
    level: normalizeThinkingLevel(thinkingLevel),
    stream
  });
  Object.assign(body, thinking.fields);
  if (maxTokens != null) {
    // token 上限参数名随表（04 号票）：openai-reasoning 系不认 max_tokens（严格
    // 400），写 max_completion_tokens；其余类与 unknown（resolver 不返回
    // tokenParam）维持 max_tokens 现状。探针（maxTokens 默认 1）与概览/分析的
    // 估算预算（含空正文加倍重试）同走此接缝，自动生效、无需调用方特判。
    body[thinking.tokenParam ?? "max_tokens"] = maxTokens;
  }
  return body;
}

// 从 arguments JSON 宽容解析 query（spec §2.2 的 args 形状）：对象带 query 字符串
// 直取；其余（含非 JSON / 非对象）以原文包 { query } 兜底，工具调用方总有词可搜。
// tool-loop 回填 tool 消息时复用同一解析（收口单源；经 completion.js re-export
// 保住既有 import 路径）。
export function parseToolArgs(rawArguments: string): { query: string } {
  try {
    const parsed = JSON.parse(rawArguments) as { query?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.query === "string") {
      return { query: parsed.query };
    }
  } catch {}
  return { query: rawArguments };
}

/**
 * 读取并解析单个 SSE 响应，逐事件经 onEvent 吐出（不依赖 port/DOM）。
 * 手动 buffer 按行切、data: 前缀、[DONE] 跳过；解析出的事件（reasoning/content）
 * 归一为 { type: "token" | "reasoning", data }（port 协议词表，适配层可直透）。
 * 联网搜索扩展：delta.tool_calls 分片按 index 聚合（id/name/arguments 跨 chunk
 * 拼接），流结束时逐条吐 onEvent({ type: "tool-call", name, args: { query } })
 * （spec §2.2 聚合后发出），并随返回值带回聚合结果。
 * 中止时抛 makeAbortedError，由调用方统一收束。
 * 产物形状即契约 DrainResult：content 为 content 增量拼接（tool 轮 assistant
 * 消息回填用）；toolCalls 为按 index 聚合的 tool_calls；finishReason 取最后一个
 * finish 事件（"stop" | "tool_calls" | ...，缺失为 null）。
 */
async function drainSseStream({ response, signal, onEvent }: { response: Response } & DrainContext): Promise<DrainResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  const fragments = new Map<number, { id: string; name: string; args: string }>();

  while (true) {
    if (signal?.aborted) {
      throw makeAbortedError();
    }

    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.length ? lines.pop()! : "";

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;

      const events = parseSsePayload(data);
      for (const event of events) {
        if (event.type === "reasoning" || event.type === "content") {
          if (event.type === "content") {
            content += event.data;
          }
          onEvent?.({
            type: event.type === "reasoning" ? "reasoning" : "token",
            data: event.data
          });
        } else if (event.type === "tool-call-fragment") {
          const existing = fragments.get(event.index) || { id: "", name: "", args: "" };
          if (event.id) existing.id = event.id;
          if (event.name) existing.name = event.name;
          existing.args += event.argsFragment;
          fragments.set(event.index, existing);
        } else if (event.type === "finish") {
          finishReason = event.reason;
        }
      }
    }
  }

  // 聚合的 tool_calls 按流内顺序（index 升序）吐 tool-call 事件并随结果带回。
  const toolCalls: ChatToolCall[] = [...fragments.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, fragment]) => ({
      id: fragment.id || `tool_call_${index}`,
      type: "function" as const,
      function: { name: fragment.name, arguments: fragment.args }
    }));
  for (const call of toolCalls) {
    onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
  }
  return { content, toolCalls, finishReason };
}

export const openaiAdapter: ProtocolAdapter = {
  protocol: "openai",
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },

  endpoint(baseUrl: string): string {
    return `${baseUrl}${OPENAI_CHAT_PATH}`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    // Bearer 仅在 apiKey 存在时注入（现状：requiresKey=false 的平台允许空 key）。
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    // 迁入现有 buildChatRequestBody：thinking-profiles 查表（presetId 主路径 +
    // baseUrl host 兜底）+ tokenParam 分流（openai-reasoning 系写 max_completion_tokens）
    // + tools 透传。行为与迁移前逐字节一致。
    return buildChatRequestBody({
      model: request.model,
      messages: request.messages,
      stream: request.stream,
      thinkingLevel: request.thinkingLevel,
      maxTokens: request.maxTokens,
      baseUrl: request.baseUrl,
      presetId: request.presetId,
      tools: request.tools
    });
  },

  extractErrorDetail(bodyText: string): string {
    // OpenAI error envelope：{ error: { message, type, ... } }；缺失回落整段 body。
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    } catch {}
    return bodyText;
  },

  async drainStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
    return drainSseStream({ response, signal: ctx.signal, onEvent: ctx.onEvent });
  },

  parseResponse(json: unknown): DrainResult {
    // 迁入现有非流式提取：choices[0].message.content / tool_calls 宽容归一。
    const choice = (json as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }> })?.choices?.[0];
    const content = choice?.message?.content;
    const rawToolCalls = Array.isArray(choice?.message?.tool_calls) ? choice!.message!.tool_calls : [];
    const toolCalls = (rawToolCalls as Array<Record<string, unknown>>).map((call, index) => {
      const fn = (call.function || {}) as { name?: unknown; arguments?: unknown };
      return {
        id: typeof call.id === "string" && call.id ? call.id : `tool_call_${index}`,
        type: "function" as const,
        function: {
          name: typeof fn.name === "string" ? fn.name : "",
          arguments: typeof fn.arguments === "string" ? fn.arguments : "{}"
        }
      };
    });
    return {
      content: typeof content === "string" ? content : "",
      toolCalls,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null
    };
  }
};
