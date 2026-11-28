import { makeAbortedError } from "../../shared/error-helpers.js";
import { DEFAULT_MAX_TOKENS } from "../output-budget.js";
import { listOpenAiCompatibleModels, parseToolArgs } from "./openai.js";
import type { ChatRequest, DrainContext, DrainResult, ListModelsInput, ListModelsResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatMessage, ChatToolCall, ChatUsage, ThinkingBlock } from "../types.js";

function extractSystem(messages: ChatMessage[]): { system: string | undefined; rest: ChatMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    rest: messages.filter((m) => m.role !== "system")
  };
}

function parseToolInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawArguments);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return { query: rawArguments };
}

const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" } as const;

const CACHEABLE_BLOCK_TYPES = new Set(["text", "tool_result", "tool_use", "image"]);

interface AnthropicContentBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral" };
  [key: string]: unknown;
}

interface AnthropicMessage {
  role: string;
  content: string | AnthropicContentBlock[];
}

function attachRollingCacheBreakpoint(messages: AnthropicMessage[]): void {
  if (messages.length < 2) return;
  const target = messages[messages.length - 2];
  if (typeof target.content === "string") {
    if (!target.content) return;
    target.content = [{ type: "text", text: target.content, cache_control: { ...EPHEMERAL_CACHE_CONTROL } }];
    return;
  }
  if (!Array.isArray(target.content)) return;
  for (let i = target.content.length - 1; i >= 0; i -= 1) {
    const block = target.content[i];
    if (!block || !CACHEABLE_BLOCK_TYPES.has(block.type)) continue;
    if (block.type === "text" && !block.text) continue;
    block.cache_control = { ...EPHEMERAL_CACHE_CONTROL };
    return;
  }
}

function toAnthropicMessages(messages: ChatMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && (message.tool_calls?.length || message.thinkingBlocks?.length)) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.thinkingBlocks?.length) {
        for (const block of message.thinkingBlocks) {
          if (block.type === "thinking" && block.signature) {
            blocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
          } else if (block.type === "redacted_thinking" && block.data) {
            blocks.push({ type: "redacted_thinking", data: block.data });
          }
        }
      }
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: parseToolInput(call.function.arguments) });
      }
      out.push({ role: "assistant", content: blocks.length ? blocks : message.content });
    } else if (message.role === "tool") {
      const resultBlock: AnthropicContentBlock = { type: "tool_result", tool_use_id: message.tool_call_id ?? "", content: message.content };
      const last = out[out.length - 1];
      if (
        last?.role === "user" &&
        Array.isArray(last.content) &&
        last.content.some((b) => b.type === "tool_result")
      ) {
        last.content.push(resultBlock);
      } else {
        out.push({ role: "user", content: [resultBlock] });
      }
    } else if (message.images?.length) {
      const blocks: AnthropicContentBlock[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const image of message.images) {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
      }
      const last = out[out.length - 1];
      if (message.role === "user" && last?.role === "user") {
        if (typeof last.content === "string") {
          const prevBlocks: AnthropicContentBlock[] = last.content ? [{ type: "text", text: last.content }] : [];
          last.content = [...prevBlocks, ...blocks];
        } else {
          last.content.push(...blocks);
        }
      } else {
        out.push({ role: message.role, content: blocks });
      }
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

function toAnthropicTools(tools: ChatRequest["tools"]): unknown[] | undefined {
  if (!tools?.length) return undefined;
  const translated = tools
    .filter((t) => t.execution !== "server")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters
    }));
  return translated.length ? translated : undefined;
}

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
  message?: { usage?: unknown };
  usage?: unknown;
  delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
  content_block?: { type?: string; id?: string; name?: string; thinking?: string; signature?: string; data?: string };
}

function usageTokenCount(container: unknown, field: "input_tokens" | "output_tokens"): number | undefined {
  const value = (container as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function usageFromContainer(container: unknown): ChatUsage | undefined {
  const inputTokens = usageTokenCount(container, "input_tokens");
  const outputTokens = usageTokenCount(container, "output_tokens");
  if (inputTokens == null && outputTokens == null) return undefined;
  return {
    ...(inputTokens != null ? { inputTokens } : {}),
    ...(outputTokens != null ? { outputTokens } : {})
  };
}

export const anthropicAdapter: ProtocolAdapter = {
  protocol: "anthropic",
  defaultMaxTokens: DEFAULT_MAX_TOKENS,
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },

  consumes: [
    "maxTokensRequired",
    "thinkingFormat",
    "thinkingDisabledMustBeExplicit",
    "effortVocabMessages",
    "probeOmitsThinking",
    "systemOutOfBand",
    "toolResultInUserMessage",
    "stopReasonVocabulary",
    "noDoneSentinel",
    "preservedThinkingReplay",
    "parallelToolUseFlattened",
    "serverToolsNotTranslated",
    "contentPartsAsArray",
    "authHeaderScheme"
  ],

  endpoint(baseUrl: string): string {
    return `${baseUrl}/v1/messages`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (apiKey) headers["x-api-key"] = apiKey;
    return headers;
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    const { system, rest } = extractSystem(request.messages);
    const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
    const wire = request.thinkingWire;
    const anthropicMessages = toAnthropicMessages(rest);
    attachRollingCacheBreakpoint(anthropicMessages);
    const body: Record<string, unknown> = {
      model: request.model,
      messages: anthropicMessages,
      stream: request.stream,
      [wire.tokenParam]: maxTokens
    };
    if (system) {
      body.system = [{ type: "text", text: system, cache_control: { ...EPHEMERAL_CACHE_CONTROL } }];
    }
    const tools = toAnthropicTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
    Object.assign(body, wire.fields);
    if (typeof request.temperature === "number" && Number.isFinite(request.temperature)) {
      body.temperature = request.temperature;
    }
    return body;
  },

  extractErrorDetail(bodyText: string): string {
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
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let finishReason: string | null = null;
    let usage: ChatUsage | undefined;
    const fragments = new Map<number, { id: string; name: string; args: string }>();
    const thinkingFragments = new Map<number, ThinkingBlock>();

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
        if (!data) continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        switch (event.type) {
          case "content_block_start": {
            const index = event.index ?? 0;
            if (event.content_block?.type === "tool_use") {
              fragments.set(index, {
                id: event.content_block.id ?? "",
                name: event.content_block.name ?? "",
                args: ""
              });
            } else if (event.content_block?.type === "thinking") {
              const initialThinking = typeof event.content_block.thinking === "string" ? event.content_block.thinking : "";
              const initialSignature = typeof event.content_block.signature === "string" ? event.content_block.signature : "";
              thinkingFragments.set(index, { type: "thinking", thinking: initialThinking, signature: initialSignature });
              if (initialThinking) {
                ctx.onEvent?.({ type: "reasoning", data: initialThinking });
              }
            } else if (event.content_block?.type === "redacted_thinking" && typeof event.content_block.data === "string" && event.content_block.data) {
              thinkingFragments.set(index, { type: "redacted_thinking", data: event.content_block.data });
            }
            break;
          }
          case "content_block_delta": {
            const index = event.index ?? 0;
            if (event.delta?.type === "text_delta") {
              content += event.delta.text ?? "";
              ctx.onEvent?.({ type: "token", data: event.delta.text ?? "" });
            } else if (event.delta?.type === "thinking_delta") {
              const chunk = event.delta.thinking ?? "";
              ctx.onEvent?.({ type: "reasoning", data: chunk });
              const existing = thinkingFragments.get(index);
              if (existing?.type === "thinking") {
                existing.thinking += chunk;
              } else if (!existing) {
                thinkingFragments.set(index, { type: "thinking", thinking: chunk, signature: "" });
              }
            } else if (event.delta?.type === "signature_delta") {
              const sigChunk = event.delta.signature ?? "";
              const existing = thinkingFragments.get(index);
              if (existing?.type === "thinking") {
                existing.signature += sigChunk;
              } else if (!existing) {
                thinkingFragments.set(index, { type: "thinking", thinking: "", signature: sigChunk });
              }
            } else if (event.delta?.type === "input_json_delta") {
              const existing = fragments.get(index) || { id: "", name: "", args: "" };
              existing.args += event.delta.partial_json ?? "";
              fragments.set(index, existing);
            }
            break;
          }
          case "message_delta": {
            if (typeof event.delta?.stop_reason === "string" && event.delta.stop_reason) {
              finishReason = mapStopReason(event.delta.stop_reason);
            }
            const outputTokens = usageTokenCount(event.usage, "output_tokens");
            if (outputTokens != null) usage = { ...usage, outputTokens };
            break;
          }
          case "message_start": {
            const inputTokens = usageTokenCount(event.message?.usage, "input_tokens");
            if (inputTokens != null) usage = { ...usage, inputTokens };
            break;
          }
          case "error":
            throw new Error(`[anthropic] ${event.error?.type ?? "error"}: ${event.error?.message ?? ""}`);
        }
      }
    }

    const toolCalls: ChatToolCall[] = [...fragments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, fragment]) => ({
        id: fragment.id || `tool_call_${index}`,
        type: "function" as const,
        function: { name: fragment.name, arguments: fragment.args }
      }));
    const thinkingBlocks: ThinkingBlock[] = [...thinkingFragments.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, block]) => block)
      .filter((block) => (block.type === "thinking" ? Boolean(block.signature) : Boolean(block.data)));
    for (const call of toolCalls) {
      ctx.onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
    }
    return {
      content,
      toolCalls,
      finishReason,
      ...(usage ? { usage } : {}),
      ...(thinkingBlocks.length ? { thinkingBlocks } : {})
    };
  },

  parseResponse(json: unknown): DrainResult {
    const data = json as {
      content?: Array<{
        type?: string;
        text?: string;
        thinking?: string;
        signature?: string;
        data?: string;
        id?: string;
        name?: string;
        input?: unknown;
      }>;
      stop_reason?: unknown;
      usage?: unknown;
    };
    let content = "";
    const toolCalls: ChatToolCall[] = [];
    const thinkingBlocks: ThinkingBlock[] = [];
    for (const block of data.content ?? []) {
      if (block.type === "text" && typeof block.text === "string") {
        content += block.text;
      } else if (block.type === "thinking" && typeof block.thinking === "string" && typeof block.signature === "string" && block.signature) {
        thinkingBlocks.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.type === "redacted_thinking" && typeof block.data === "string" && block.data) {
        thinkingBlocks.push({ type: "redacted_thinking", data: block.data });
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: typeof block.id === "string" && block.id ? block.id : `tool_call_${toolCalls.length}`,
          type: "function" as const,
          function: { name: block.name ?? "", arguments: JSON.stringify(block.input ?? {}) }
        });
      }
    }
    const usage = usageFromContainer(data.usage);
    return {
      content,
      toolCalls,
      finishReason: typeof data.stop_reason === "string" && data.stop_reason ? mapStopReason(data.stop_reason) : null,
      ...(usage ? { usage } : {}),
      ...(thinkingBlocks.length ? { thinkingBlocks } : {})
    };
  },

  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    return listOpenAiCompatibleModels(input);
  }
};
