// ai/adapters/anthropic.ts — Anthropic Messages API 协议适配器（multi-protocol-ai
// 第二部分）。线格式对照 research/anthropic-wire-mapping.md（issues/02），底稿为
// 评审过的 prototype adapters/anthropic.ts，实现期修正四处：
// - probe 不发 thinking（探针 maxTokens=1，budget_tokens 必须 < max_tokens，发了必 400）；
// - off 判定覆盖全部关思考词汇（enable_thinking:false / thinking:{type:"disabled"}
//   / reasoning_effort:"none"），prototype 只认 effort 词表会把 off 误发成开；
// - 流内不吐 done（对齐 openai adapter：done 由 client/map-reduce 收口单发，
//   prototype 的 message_stop 发 done 会与调用方收口双发）；
// - stop_reason 必须映射回 OpenAI 词表（tool_use→"tool_calls" 等）：tool-loop 对
//   finishReason 精确匹配 "tool_calls"（tool-loop.ts），原词会让联网轮提前返回；
//   research「保留原词」的建议与真实消费方矛盾，spec「编排层零改动」优先。
// 另修正 prototype 的线形状错误：message_delta 的 stop_reason 在 delta 内。
// 聚合形状与 openai adapter 同型（DrainResult），编排层零改动。
import { makeAbortedError } from "../../shared/error-helpers.js";
import { normalizeThinkingLevel, resolveThinkingProfile } from "../thinking-profiles.js";
import { parseToolArgs } from "./openai.js";
import type { ChatRequest, DrainContext, DrainResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatMessage, ChatToolCall } from "../types.js";

// Anthropic max_tokens 必填且无默认：调用方未传时 adapter 兜底（research 限制点 1）。
const DEFAULT_MAX_TOKENS = 4096;
// 开思考的 budget_tokens 下限（Anthropic 硬性要求 ≥1024）与默认预算；
// budget 计入 max_tokens，故必须 < max_tokens。
const MIN_BUDGET_TOKENS = 1024;
const DEFAULT_BUDGET_TOKENS = 2048;

// 思考档位改写：chat 形状字段 → Anthropic thinking 形状（research 限制点 11）。
// thinking-profiles 表本身不改（OpenAI 词汇），改写发生在此；关思考的三种词汇
// 殊途同归——Anthropic 默认即关，一律不发字段。
function applyThinkingFields(body: Record<string, unknown>, request: ChatRequest): void {
  // 探针不发 thinking：探针 maxTokens=1，而 budget_tokens ≥1024 且必须 < max_tokens，
  // 任何 thinking 字段都会把探针打成 400（探针语义 = 测连通，成功判定 response.ok）。
  if (request.probe) return;
  const thinking = resolveThinkingProfile({
    presetId: request.presetId,
    baseUrl: request.baseUrl,
    model: request.model,
    level: normalizeThinkingLevel(request.thinkingLevel),
    stream: request.stream
  });
  const fields = thinking.fields;
  const off =
    !Object.keys(fields).length ||
    fields.reasoning_effort === "none" ||
    fields.enable_thinking === false ||
    (fields.thinking as { type?: unknown } | undefined)?.type === "disabled";
  if (off) return;
  // 开思考：{ type: "enabled", budget_tokens }；budget 夹在 [1024, max_tokens) 内，
  // 放不下（调用方 maxTokens 过小）则不发——软失败优于硬 400。
  const maxTokens = (body.max_tokens as number) ?? DEFAULT_MAX_TOKENS;
  const budget = Math.min(DEFAULT_BUDGET_TOKENS, maxTokens - 1);
  if (budget < MIN_BUDGET_TOKENS) return;
  body.thinking = { type: "enabled", budget_tokens: budget };
}

// system 剥出：Anthropic messages 数组不允许 system 角色（research 限制点 2）；
// 多条按出现顺序 \n\n 拼接（契约点）。
function extractSystem(messages: ChatMessage[]): { system: string | undefined; rest: ChatMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    rest: messages.filter((m) => m.role !== "system")
  };
}

// 消息翻译（research §4）：
// - assistant 带 tool_calls → content 块数组：text 块 + 每 call 一个 tool_use 块
//   （arguments JSON.parse 失败兜底 { query: 原文 }，对齐 parseToolArgs 宽容风格，
//   限制点 4）。
// - role:"tool" 消息 → 合并进 user 消息的 tool_result 块（连续多条合并进同一条）；
//   前置条件：须紧跟对应 assistant(tool_use) 消息，孤立 tool 消息由平台 400 兜底
//   （调用方消息序列由编排层保证，限制点 3）。
function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
        // arguments → input：合法对象透传，其余（非 JSON / 非对象 / 缺 query）统一
        // 走 parseToolArgs 的 { query } 兜底（与出参方向、tool-loop 回填单源）。
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolArgs(call.function.arguments) });
      }
      out.push({ role: "assistant", content: blocks });
    } else if (message.role === "tool") {
      const resultBlock = { type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content };
      const last = out[out.length - 1] as { role?: string; content?: unknown[] } | undefined;
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.some((b) => (b as { type?: string }).type === "tool_result")
      ) {
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

// input_schema 直接改名透传（压平并行的 disable_parallel_tool_use 在 buildBody
// 的 tool_choice 上，spec「被有意不支持的能力」parallel-tool-use-flattened）。
// 原生服务端工具（名字带日期版本后缀，如 web_search_20250305）不走 tool-loop，
// 显式不翻译（server-tools 限制点；只翻译编排层发来的客户端 function 工具）。
const NATIVE_TOOL_NAME = /_\d{8}$/;

function toAnthropicTools(tools: ChatRequest["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const translated = tools
    .filter((t) => !NATIVE_TOOL_NAME.test(t.function.name))
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  return translated.length ? translated : undefined;
}

// stop_reason 词表映射回 OpenAI 词表（research §3 映射表）：tool-loop 对
// finishReason 精确匹配 "tool_calls"，原词会让联网轮提前返回——spec「编排层
// 零改动」要求此处翻译而非改消费方；未列出的新词原样透传。
function mapStopReason(reason: string): string {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
    case "refusal":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    default:
      return reason;
  }
}

interface AnthropicStreamEvent {
  type?: string;
  index?: number;
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
  content_block?: { type?: string; id?: string; name?: string };
}

export const anthropicAdapter: ProtocolAdapter = {
  protocol: "anthropic",
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {
      // 稳定键 → 给人读的说明（spec「被有意不支持的能力」逐条落点）。
      "parallel-tool-use-flattened": "并行 tool_use 已按协议压平（disable_parallel_tool_use: true）；未来需要并行时聚合层按 index 已天然支持",
      "thinking-roundtrip": "thinking 块的 signature 不回传 ChatMessage，多轮回传 thinking 会 400；本场景（单轮总结 + 单轮 tool loop）无此需求",
      "server-tools": "Anthropic 原生服务端工具（web_search_20250305 等）不走 tool-loop，adapter 只翻译客户端 function 工具"
    }
  },

  endpoint(baseUrl: string): string {
    return `${baseUrl}/v1/messages`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    // 非 Bearer：x-api-key + anthropic-version（research 限制点 5）。
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    const { system, rest } = extractSystem(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toAnthropicMessages(rest),
      stream: request.stream,
      // max_tokens 必填（限制点 1）：调用方未传兜底 4096；探针由 core 代劳传 1。
      max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS
    };
    if (system) body.system = system;
    const tools = toAnthropicTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
    applyThinkingFields(body, request);
    return body;
  },

  extractErrorDetail(bodyText: string): string {
    // Anthropic 错误体：{ type: "error", error: { type, message } }（research §6）；
    // core 统一加 `[Anthropic] ` 前缀与 200 字符截断。
    try {
      const parsed = JSON.parse(bodyText) as { error?: { type?: unknown; message?: unknown } };
      const type = typeof parsed.error?.type === "string" ? parsed.error.type : "";
      const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
      if (type && message) return `${type}: ${message}`;
      if (message) return message;
      if (type) return type;
    } catch {}
    return bodyText;
  },

  async drainStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
    // 事件映射（research §3）。data: 行自带 type 字段，无需解析 event: 行；
    // 无 [DONE] 哨兵——流读完即收束，done 由调用方（client/map-reduce）收口单发。
    // 中止抛 makeAbortedError（与 openai adapter 同型），由 core 统一收束。
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    const fragments = new Map<number, { id: string; name: string; args: string }>();

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
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        // Anthropic 不发 [DONE]；跳过逻辑保留无害。
        if (!data || data === "[DONE]") continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          // 坏行宽容忽略（契约级约定：不抛错）。
          continue;
        }
        switch (event.type) {
          case "content_block_start":
            // tool_use 块起始：记录 { index, id, name }；text/thinking 块忽略
            // （首字在 delta 里）。
            if (event.content_block?.type === "tool_use") {
              fragments.set(event.index ?? 0, {
                id: event.content_block.id ?? "",
                name: event.content_block.name ?? "",
                args: ""
              });
            }
            break;
          case "content_block_delta":
            if (event.delta?.type === "text_delta") {
              content += event.delta.text ?? "";
              ctx.onEvent?.({ type: "token", data: event.delta.text ?? "" });
            } else if (event.delta?.type === "thinking_delta") {
              ctx.onEvent?.({ type: "reasoning", data: event.delta.thinking ?? "" });
            } else if (event.delta?.type === "input_json_delta") {
              const existing = fragments.get(event.index ?? 0) || { id: "", name: "", args: "" };
              existing.args += event.delta.partial_json ?? "";
              fragments.set(event.index ?? 0, existing);
            }
            // signature_delta 忽略（thinking 不回传，限制点 thinking-roundtrip）。
            break;
          case "message_delta":
            // stop_reason 在 delta 内（message_delta 形状）；词表经 mapStopReason
            // 映射回 OpenAI 词表（tool-loop 精确匹配 "tool_calls"，见文件头）。
            if (typeof event.delta?.stop_reason === "string" && event.delta.stop_reason) {
              finishReason = mapStopReason(event.delta.stop_reason);
            }
            break;
          case "error":
            // 流内错误（如 overloaded_error，research 限制点 12）：抛出走 core 的
            // 读流中断重试（流式 2 次，retryable 语义与 http ≥500 对齐）；前缀对齐
            // core HTTP 路径的 `[协议名] ` 形状。继续读完只会把截断内容当成功返回。
            throw new Error(`[anthropic] ${event.error?.type ?? "error"}: ${event.error?.message ?? ""}`);
          // message_start / content_block_stop / ping / 未知事件：一律忽略
          // （官方要求 graceful 处理未知类型）。
        }
      }
    }

    // 聚合的 tool_use 按 index 升序吐 tool-call 事件（与 openai adapter 同型，
    // client 侧吞掉不出 port）并随结果带回。
    const toolCalls: ChatToolCall[] = [...fragments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, fragment]) => ({
        id: fragment.id || `tool_call_${index}`,
        type: "function" as const,
        function: { name: fragment.name, arguments: fragment.args }
      }));
    for (const call of toolCalls) {
      ctx.onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
    }
    return { content, toolCalls, finishReason };
  },

  parseResponse(json: unknown): DrainResult {
    // 非流式：content 块数组——text 块顺序拼接无分隔符（research 限制点 13），
    // tool_use 块回转为 ChatToolCall（research §5）。
    const data = json as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: unknown;
    };
    let content = "";
    const toolCalls: ChatToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") content += block.text;
      if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" && block.id ? block.id : `tool_call_${toolCalls.length}`,
          type: "function" as const,
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) }
        });
      }
    }
    return {
      content,
      toolCalls,
      finishReason: typeof data.stop_reason === "string" && data.stop_reason ? mapStopReason(data.stop_reason) : null
    };
  }
};
