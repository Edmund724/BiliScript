import { parseOpenAiUsage, parseSsePayload } from "../sse-parser.js";
import { makeAbortedError } from "../../shared/error-helpers.js";
import { formatModelListHttpError } from "./http-error.js";
import type { ThinkingWireOutput } from "../thinking-wire-map.js";
import type { ChatMessage, ChatToolCall, ChatUsage } from "../types.js";
import type { ChatRequest, ChatToolDefinition, DrainContext, DrainResult, ListModelsInput, ListModelsResult, ProtocolAdapter } from "../protocol-adapter.js";

export const OPENAI_CHAT_PATH = "/chat/completions";

interface BuildChatRequestBodyInput {
  model: string;
  messages: ChatRequest["messages"];
  stream?: boolean;
  thinkingWire: ThinkingWireOutput;
  maxTokens?: number | null;
  tools?: ChatToolDefinition[];
}

type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface WireMessage extends Omit<ChatMessage, "content" | "images"> {
  content: string | ChatContentPart[];
}

type ChatRequestBody = {
  model: string;
  messages: WireMessage[];
  stream: boolean;
  tools?: ChatToolDefinition[];
  tool_choice?: "auto";
} & Record<string, unknown>;

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

export function buildChatRequestBody({ model, messages, stream = false, thinkingWire, maxTokens, tools }: BuildChatRequestBodyInput): ChatRequestBody {
  const body: ChatRequestBody = { model, messages: toWireMessages(messages), stream };
  if (tools && tools.length) {
    const clientTools = tools
      .filter((t) => t.execution !== "server")
      .map((t) => ({ type: t.type, function: t.function }));
    if (clientTools.length) {
      body.tools = clientTools;
      body.tool_choice = "auto";
    }
  }
  Object.assign(body, thinkingWire.fields);
  if (maxTokens != null) {
    body[thinkingWire.tokenParam] = maxTokens;
  }
  return body;
}

export function parseToolArgs(rawArguments: string): { query: string } {
  try {
    const parsed = JSON.parse(rawArguments) as { query?: unknown };
    if (parsed && typeof parsed === "object" && typeof parsed.query === "string") {
      return { query: parsed.query };
    }
  } catch {}
  return { query: rawArguments };
}

async function drainSseStream({ response, signal, onEvent }: { response: Response } & DrainContext): Promise<DrainResult> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let usage: ChatUsage | undefined;
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
        } else if (event.type === "usage") {
          usage = event.usage;
        }
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
    onEvent?.({ type: "tool-call", name: call.function.name, args: parseToolArgs(call.function.arguments) });
  }
  return { content, toolCalls, finishReason, ...(usage ? { usage } : {}) };
}

export async function listOpenAiCompatibleModels({ baseUrl, apiKey, fetchImpl }: ListModelsInput): Promise<ListModelsResult> {
  const normalizedBaseUrl = String(baseUrl || "").trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const doFetch = fetchImpl ?? fetch;
  const resp = await doFetch(`${normalizedBaseUrl}/v1/models`, { headers, method: "GET" });
  if (!resp.ok) {
    const text = await resp.text();
    return { ok: false, error: formatModelListHttpError(resp.status, text) };
  }
  const data = (await resp.json()) as { data?: Array<{ id?: string }> };
  const models: string[] = [];
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      if (item?.id) models.push(String(item.id));
    }
  }
  return { ok: true, models };
}

export const openaiAdapter: ProtocolAdapter = {
  protocol: "openai",
  capabilities: {
    tools: true,
    thinkingProfiles: true,
    unsupported: {}
  },

  consumes: [
    "maxTokensField",
    "thinkingFormat",
    "streamingOnlyThinkingOff",
    "contentPartsAsArray",
    "toolCallFragmentsByIndex",
    "sessionHeader",
    "bearerOptionalWithoutKey"
  ],

  endpoint(baseUrl: string): string {
    return `${baseUrl}${OPENAI_CHAT_PATH}`;
  },

  authHeaders(apiKey: string | undefined): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
  },

  buildBody(request: ChatRequest): Record<string, unknown> {
    return buildChatRequestBody({
      model: request.model,
      messages: request.messages,
      stream: request.stream,
      thinkingWire: request.thinkingWire,
      maxTokens: request.maxTokens,
      tools: request.tools
    });
  },

  extractErrorDetail(bodyText: string): string {
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
    const data = json as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>; usage?: unknown };
    const choice = data?.choices?.[0];
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
    const usage = parseOpenAiUsage(data?.usage);
    return {
      content: typeof content === "string" ? content : "",
      toolCalls,
      finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
      ...(usage ? { usage } : {})
    };
  },

  listModels: listOpenAiCompatibleModels
};
