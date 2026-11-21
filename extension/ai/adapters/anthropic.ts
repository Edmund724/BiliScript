import { makeAbortedError } from "../../shared/error-helpers.js";
import { DEFAULT_MAX_TOKENS } from "../output-budget.js";
import { listOpenAiCompatibleModels, parseToolArgs } from "./openai.js";
import type { ChatRequest, DrainContext, DrainResult, ListModelsInput, ListModelsResult, ProtocolAdapter } from "../protocol-adapter.js";
import type { ChatMessage, ChatToolCall, ChatUsage } from "../types.js";

function extractSystem(messages: ChatMessage[]): { system: string | undefined; rest: ChatMessage[] } {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    rest: messages.filter((m) => m.role !== "system")
  };
}

function toAnthropicMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const call of message.tool_calls) {
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
    } else if (message.images?.length) {
      const blocks: unknown[] = [];
      if (message.content) blocks.push({ type: "text", text: message.content });
      for (const image of message.images) {
        blocks.push({ type: "image", source: { type: "base64", media_type: image.mime, data: image.data } });
      }
      out.push({ role: message.role, content: blocks });
    } else {
      out.push({ role: message.role, content: message.content });
    }
  }
  return out;
}

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
  delta?: { type?: string; text?: string; thinking?: string; partial_json?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
  content_block?: { type?: string; id?: string; name?: string };
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
    "thinkingSignatureNotReplayed",
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
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toAnthropicMessages(rest),
      stream: request.stream,
      [wire.tokenParam]: maxTokens
    };
    if (system) body.system = system;
    const tools = toAnthropicTools(request.tools);
    if (tools) {
      body.tools = tools;
      body.tool_choice = { type: "auto", disable_parallel_tool_use: true };
    }
    Object.assign(body, wire.fields);
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
        if (!data || data === "[DONE]") continue;

        let event: AnthropicStreamEvent;
        try {
          event = JSON.parse(data) as AnthropicStreamEvent;
        } catch {
          continue;
        }
        switch (event.type) {
          case "content_block_start":
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
            break;
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
    for (const call of toolCalls) {
      ctx.onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
    }
    return { content, toolCalls, finishReason, ...(usage ? { usage } : {}) };
  },

  parseResponse(json: unknown): DrainResult {
    const data = json as {
      content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>;
      stop_reason?: unknown;
      usage?: unknown;
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
    const usage = usageFromContainer(data.usage);
    return {
      content,
      toolCalls,
      finishReason: typeof data.stop_reason === "string" && data.stop_reason ? mapStopReason(data.stop_reason) : null,
      ...(usage ? { usage } : {})
    };
  },

  listModels(input: ListModelsInput): Promise<ListModelsResult> {
    return listOpenAiCompatibleModels(input);
  }
};
