// ai/adapters/responses.ts — OpenAI Responses API 协议适配器（multi-protocol-ai
// 第三部分）。只走无状态形态：完整 input 数组、store: false、不发
// previous_response_id（research/responses-wire-mapping.md，issues/03）。底稿为
// 评审过的 prototype adapters/responses.ts，实现期修正五处：
// - 线形状：delta 与 arguments 字段在事件 payload 顶层——output_text.delta 的
//   delta 是字符串本体（prototype 当 delta.text 读恒为 undefined）；
//   function_call_arguments.done 的完整 arguments 也在顶层（prototype 当
//   delta.arguments 读）；
// - 流内不吐 done/stopped（对齐 openai/anthropic adapter：done 由 client/
//   map-reduce 收口单发）；response.incomplete 只落在 finishReason="length"；
//   response.failed 与 SSE error 事件抛错走 core 读流中断重试（对齐 anthropic
//   adapter 流内 error 处理：继续读完只会把截断内容当成功返回）；
// - finishReason 合成回 OpenAI 词表（toolCalls.length → "tool_calls"、
//   incomplete → "length"、其余 "stop"）：tool-loop 对 finishReason 精确匹配
//   "tool_calls"（tool-loop.ts），research「消费方只看 toolCalls.length」与真实
//   消费方矛盾，spec「编排层零改动」优先（与 anthropic stop_reason 映射同判）；
// - 探针不发 reasoning（maxTokens=1 与 reasoning 并存有被 400 的风险，对齐
//   anthropic adapter 探针特化）；chat-completions 系思考字段（enable_thinking /
//   thinking）不属于 Responses 词表，不透传，只翻译 reasoning_effort →
//   reasoning.effort（L9）；
// - L1 加固：function_call 聚合不依赖 output_item.added——arguments delta/done
//   懒建条目，output_item.done 回填 name/call_id/完整 arguments（兼容端点漏发
//   added 时调用仍有名字可搜）；
// - 终态事件是收束判据（research §2）：连接关闭仍未收到 completed/failed/
//   incomplete/error → 抛错走 core 读流中断重试（stream-reset），不把截断内容
//   当成功返回；非流式 status:"failed" 同判抛错；
// - 思考词表归一：开关型 off 词汇（enable_thinking:false / thinking:{type:
//   "disabled"}）翻译成 reasoning.effort:"none"（Responses 默认开思考，丢弃会让
//   off 静默变成默认开）；非官方 effort 值归一（xhigh → high，词表外值丢弃，
//   软失败优于硬 400）。
// 聚合形状与 openai/anthropic adapter 同型（DrainResult），编排层零改动。
import { makeAbortedError } from "../../shared/error-helpers.js";
import { normalizeThinkingLevel, resolveThinkingProfile } from "../thinking-profiles.js";
import { parseToolArgs } from "./openai.js";
import type { ChatRequest, DrainContext, DrainResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatMessage, ChatToolCall } from "../types.js";

// system 必须在边界剥出为顶层 instructions（L3）；多条按出现顺序 \n\n 拼接
// （契约点，与 anthropic adapter 同规则）。
function extractInstructions(messages: ChatMessage[]): { instructions: string | undefined; rest: ChatMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return {
    instructions: systemParts.length ? systemParts.join("\n\n") : undefined,
    rest: messages.filter((m) => m.role !== "system")
  };
}

// ChatMessage[] → Responses input 项（research §1）：
// - user → { role:"user", content:[{type:"input_text", text}] }；带 images 时
//   content 追加 input_image 项（image-input 路线 B），无图消息线形状逐字节不变。
// - assistant 纯文本 → { role:"assistant", content:[{type:"output_text", text}] }
//   （assistant 带 images 不翻译图片：assistant 轮的 content 块词表只有
//   output_text/refusal，图片只可能来自用户粘贴——02 号票入口）
// - assistant 带 tool_calls → 每条 call 拆一项 {type:"function_call", call_id,
//   name, arguments}（Responses 的 Items 是拆开的，research §3）
// - tool → {type:"function_call_output", call_id, output}（output 必须是字符串，L5；
//   本扩展 tool 消息 content 天然是字符串）
function toResponsesInput(messages: ChatMessage[]): unknown[] {
  const input: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      // 有意不保留 message.content（若有）：Responses 的 assistant 轮按 Items
      // 拆开回放，research §1 只钉 function_call 项（与 anthropic adapter 保留
      // text 块不同——Anthropic 线格式要求 content 与 tool_use 同块）。
      for (const call of message.tool_calls) {
        input.push({ type: "function_call", call_id: call.id, name: call.function.name, arguments: call.function.arguments });
      }
    } else if (message.role === "tool") {
      input.push({ type: "function_call_output", call_id: message.tool_call_id ?? "", output: message.content });
    } else if (message.role === "user" && message.images?.length) {
      // 图片输入（image-input 路线 B）：input_text 项 + 每张图一个 input_image 项
      //（image_url 为 data:<mime>;base64,<b64>）；text 项仅在正文非空时发出
      //（空 text 块各端点宽容度不一，省掉最稳）。
      const content: unknown[] = [];
      if (message.content) content.push({ type: "input_text", text: message.content });
      for (const image of message.images) {
        content.push({ type: "input_image", image_url: `data:${image.mime};base64,${image.data}` });
      }
      input.push({ role: "user", content });
    } else if (message.role === "user") {
      input.push({ role: "user", content: [{ type: "input_text", text: message.content }] });
    } else if (message.role === "assistant") {
      input.push({ role: "assistant", content: [{ type: "output_text", text: message.content }] });
    }
  }
  return input;
}

// tools 内联标签（去掉 function 包裹层）+ 显式 strict: false（省略时 Responses
// 会尝试严格模式，宽松 schema 可能不兼容，research §1）。
function toResponsesTools(tools: ChatRequest["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
    strict: false
  }));
}

// 思考档位二次改写：chat 形状字段名 → Responses 形状（L9：表不改写，改写在
// adapter）。两类词汇要归一（research 只钉了 effort 改名，实现期补）：
// - 开关型 off 词汇（enable_thinking:false / thinking:{type:"disabled"}）→
//   reasoning.effort:"none"：Responses 推理模型默认开思考，直接丢弃会让用户的
//   「关思考」静默落成服务端默认档（off 变 on）；
// - effort 值归一到官方词表（none/minimal/low/medium/high）：qwen 系的 xhigh
//   直通会被 Responses 端 400，映射到 high；词表外值丢弃（软失败优于硬 400）。
// enable_thinking / thinking 等 chat-completions 系字段名不属于 Responses 词表，
// 不透传。探针不发：探针 maxTokens=1，reasoning 与过低输出上限并存在被 400
// 的风险（对齐 anthropic adapter 探针特化）。
const RESPONSES_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);

function normalizeEffort(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (RESPONSES_EFFORTS.has(value)) return value;
  if (value === "xhigh") return "high";
  return undefined;
}

function applyThinkingFields(body: Record<string, unknown>, request: ChatRequest): void {
  if (request.probe) return;
  const thinking = resolveThinkingProfile({
    presetId: request.presetId,
    baseUrl: request.baseUrl,
    model: request.model,
    level: normalizeThinkingLevel(request.thinkingLevel),
    stream: request.stream
  });
  const fields = thinking.fields as Record<string, unknown>;
  const offVocab =
    fields.enable_thinking === false ||
    (fields.thinking as { type?: unknown } | undefined)?.type === "disabled";
  const effort = offVocab ? "none" : normalizeEffort(fields.reasoning_effort);
  if (effort) {
    body.reasoning = { effort };
  }
}

interface ResponsesStreamPayload {
  type?: string;
  item_id?: unknown;
  item?: { id?: string; type?: string; call_id?: string; name?: string; arguments?: string };
  delta?: unknown;
  arguments?: unknown;
  message?: unknown;
  response?: {
    status?: string;
    error?: { code?: unknown; message?: unknown };
    incomplete_details?: { reason?: unknown };
  };
}

// function_call 聚合条目：键为 item_id（output_item.added 提供关联键）。
interface FunctionCallFragment {
  callId: string;
  name: string;
  args: string;
}

export const responsesAdapter: ProtocolAdapter = {
  protocol: "responses",
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {
      // 稳定键 → 给人读的说明（spec「被有意不支持的能力」逐条落点）。
      "finish-reason-synthetic": "Responses 无 finish_reason；finishReason 为合成值（toolCalls.length → tool_calls / incomplete → length / 其余 stop），仅保证 tool-loop 精确匹配 tool_calls 的语义，不承载协议级状态",
      "reasoning-replay": "store:false 下 reasoning 项不持久，encrypted_content 送不回 ChatMessage；tool-loop 轮间 reasoning 上下文丢失，可接受（L4）",
      "sequence-reorder": "sequence_number 不校验重排，按到达顺序追加（L8；SSE 本身有序）"
    }
  },

  endpoint(baseUrl: string): string {
    return `${baseUrl}/responses`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    // 同 OpenAI：Bearer；requiresKey=false 的平台允许空 key。
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    const { instructions, rest } = extractInstructions(request.messages);
    const body: Record<string, unknown> = {
      model: request.model,
      input: toResponsesInput(rest),
      stream: request.stream,
      // 无状态形态显式声明（research §1：Responses 默认 store:true）。
      store: false
    };
    if (instructions) body.instructions = instructions;
    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    const tools = toResponsesTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    applyThinkingFields(body, request);
    return body;
  },

  extractErrorDetail(bodyText: string): string {
    // 与 chat completions 同型 error envelope：{ error: { message, ... } }；
    // core 统一加 `[responses] ` 前缀与 200 字符截断。
    try {
      const parsed = JSON.parse(bodyText) as { error?: { message?: unknown } };
      if (typeof parsed.error?.message === "string") return parsed.error.message;
    } catch {}
    return bodyText;
  },

  async drainStream(response: Response, ctx: DrainContext): Promise<DrainResult> {
    // 事件映射（research §2）。与 chat completions 不同：每块有 event: 行（按空行
    // 重置，块外不串名）；无 [DONE]——终态事件 completed/failed/incomplete/error
    // 为准；连接关闭未收终态 → core 按读流中断路径重试（stream-reset）。
    // 流内只吐 token/reasoning/tool-call：done/stopped 由调用方收口单发
    // （对齐 openai/anthropic adapter）；failed/error 抛错走重试。
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventName = "";
    let content = "";
    let incomplete = false;
    // 终态事件是收束判据（research §2）：连接关闭仍未收到终态 → 抛错走 core
    // 读流中断重试（stream-reset），不把截断内容当成功返回。
    let sawTerminal = false;
    // 到达顺序即追加顺序（L8 不重排），Map 保留插入序。
    const fragments = new Map<string, FunctionCallFragment>();

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
        if (!line) {
          eventName = "";
          continue;
        }
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        let payload: ResponsesStreamPayload;
        try {
          payload = JSON.parse(data) as ResponsesStreamPayload;
        } catch {
          // L7：坏行宽容忽略，不抛错不重试。
          continue;
        }
        // 事件 payload 的 delta 是字符串本体（官方线格式），非 { text } 包裹。
        const deltaText = typeof payload.delta === "string" ? payload.delta : "";
        const itemId = typeof payload.item_id === "string" ? payload.item_id : "";
        switch (eventName) {
          case "response.output_text.delta":
            content += deltaText;
            ctx.onEvent?.({ type: "token", data: deltaText });
            break;
          case "response.reasoning_summary_text.delta":
          case "response.reasoning_text.delta":
            // 后者为第三方兼容端点事件（如 DeepSeek），宽容处理。
            ctx.onEvent?.({ type: "reasoning", data: deltaText });
            break;
          case "response.refusal.delta":
            // refusal 当正文 token 流出（L6 主观映射，写进契约）。
            content += deltaText;
            ctx.onEvent?.({ type: "token", data: deltaText });
            break;
          case "response.output_item.added": {
            // function_call 项提供 call_id/name（聚合键 item.id）。
            const item = payload.item;
            if (item?.type === "function_call" && item.id) {
              fragments.set(item.id, { callId: item.call_id ?? "", name: item.name ?? "", args: "" });
            }
            break; // 结构性事件，不吐事件（L1：不得依赖其存在）
          }
          case "response.output_item.done": {
            // L1 加固：兼容端点漏发 added 时，done 项带完整 name/call_id/
            // arguments，回填或整体建条目。
            const item = payload.item;
            if (item?.type === "function_call" && item.id) {
              const existing = fragments.get(item.id) ?? { callId: "", name: "", args: "" };
              if (!existing.callId) existing.callId = item.call_id ?? "";
              if (!existing.name) existing.name = item.name ?? "";
              if (typeof item.arguments === "string") existing.args = item.arguments;
              fragments.set(item.id, existing);
            }
            break;
          }
          case "response.function_call_arguments.delta": {
            // 懒建条目：漏发 added 的兼容端点也能聚合（name 靠 output_item.done 回填）。
            const existing = fragments.get(itemId) ?? { callId: "", name: "", args: "" };
            existing.args += deltaText;
            fragments.set(itemId, existing);
            break;
          }
          case "response.function_call_arguments.done": {
            // done 的完整 arguments 在 payload 顶层（官方线格式），覆盖累积串更稳。
            const existing = fragments.get(itemId) ?? { callId: "", name: "", args: "" };
            if (typeof payload.arguments === "string") existing.args = payload.arguments;
            fragments.set(itemId, existing);
            break;
          }
          case "response.completed":
            // 终态：正常收束；done 由调用方（client/map-reduce）收口单发。
            sawTerminal = true;
            break;
          case "response.incomplete":
            // 终态：截断（如 max_output_tokens）落在 finishReason="length"；
            // 不发 stopped 事件（收口纪律同 done）。
            incomplete = true;
            sawTerminal = true;
            break;
          case "response.failed": {
            // 终态失败：抛错走 core 读流中断重试（流式 2 次）；前缀对齐 core
            // HTTP 路径的 `[responses] ` 形状。
            const error = payload.response?.error;
            const code = typeof error?.code === "string" ? error.code : "response_failed";
            const message = typeof error?.message === "string" ? error.message : "";
            throw new Error(`[responses] ${code}: ${message}`);
          }
          case "error": {
            // SSE 层级错误（{ code, message, ... }）：同 response.failed 抛错走重试。
            const message = typeof payload.message === "string" ? payload.message : "error";
            throw new Error(`[responses] ${message}`);
          }
          // created/in_progress/queued、added/done 其余结构性事件、内置工具
          // 事件（web_search_call 等）与未知事件：一律忽略（L1/L7）。
        }
      }
    }

    // 连接关闭仍未收到终态事件：按读流中断处理（research §2）——抛错让 core
    // 走流式重试（2 次）+ stream-reset；继续聚合只会把截断内容当成功返回。
    if (!sawTerminal) {
      throw new Error("[responses] stream closed before terminal event (completed/failed/incomplete)");
    }

    // 聚合的 function_call 按到达顺序吐 tool-call 事件（与 openai/anthropic
    // adapter 同型，client 侧吞掉不出 port）并随结果带回。
    const toolCalls: ChatToolCall[] = [...fragments.values()].map((fragment, index) => ({
      id: fragment.callId || `tool_call_${index}`,
      type: "function" as const,
      function: { name: fragment.name, arguments: fragment.args }
    }));
    for (const call of toolCalls) {
      ctx.onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
    }
    // finishReason 合成回 OpenAI 词表：tool-loop 精确匹配 "tool_calls"（见文件头）。
    return { content, toolCalls, finishReason: toolCalls.length ? "tool_calls" : incomplete ? "length" : "stop" };
  },

  parseResponse(json: unknown): DrainResult {
    // 非流式：遍历 output——message 项拼 output_text（refusal part 并入，research
    // §5），function_call 项回转为 ChatToolCall（research §3）。
    const data = json as {
      status?: unknown;
      error?: { code?: unknown; message?: unknown };
      output?: Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string }>;
        call_id?: string;
        name?: string;
        arguments?: string;
      }>;
    };
    let content = "";
    const toolCalls: ChatToolCall[] = [];
    for (const item of data.output ?? []) {
      if (item.type === "message") {
        for (const part of item.content ?? []) {
          if ((part.type === "output_text" || part.type === "refusal") && typeof part.text === "string") content += part.text;
        }
      } else if (item.type === "function_call") {
        toolCalls.push({
          id: item.call_id || `tool_call_${toolCalls.length}`,
          type: "function" as const,
          function: { name: item.name ?? "", arguments: item.arguments ?? "{}" }
        });
      }
    }
    // 非流式终态失败（HTTP 200 + status:"failed"）：与流内 response.failed 同判
    // 抛错，不当成功返回（非流式 core 无重试，错误直达调用方错误通道）。
    if (data.status === "failed") {
      const code = typeof data.error?.code === "string" ? data.error.code : "response_failed";
      const message = typeof data.error?.message === "string" ? data.error.message : "";
      throw new Error(`[responses] ${code}: ${message}`);
    }
    // usage 字段名不同（input/output_tokens）但本扩展不消费（research §5）。
    return {
      content,
      toolCalls,
      finishReason: toolCalls.length ? "tool_calls" : data.status === "incomplete" ? "length" : "stop"
    };
  }
};
