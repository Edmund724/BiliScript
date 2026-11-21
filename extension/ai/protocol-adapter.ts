import type { ChatMessage, ChatToolCall, ChatUsage, StreamChatEvent } from "./types.js";
import type { ThinkingWireOutput } from "./thinking-wire-map.js";

export type { AiProtocol } from "./protocol-vocab.js";
import type { AiProtocol } from "./protocol-vocab.js";

export type { CompatQuirk } from "./compat-vocab.js";
import type { CompatQuirk } from "./compat-vocab.js";

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ProtocolCapabilities {
  tools: boolean;
  thinkingProfiles: boolean;
  unsupported: Record<string, string>;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  thinkingWire: ThinkingWireOutput;
  maxTokens?: number | null;
  tools?: ChatToolDefinition[];
}

export interface DrainResult {
  content: string;
  toolCalls: ChatToolCall[];
  finishReason: string | null;
  usage?: ChatUsage;
  thoughtSignature?: string;
}

export interface DrainContext {
  signal?: AbortSignal | null;
  onEvent?: (event: StreamChatEvent) => void;
}

export interface ListModelsInput {
  baseUrl: string;
  apiKey?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export interface ListModelsResult {
  ok: boolean;
  models?: string[];
  error?: string;
}

export interface ProtocolAdapter {
  readonly protocol: AiProtocol;

  readonly defaultMaxTokens?: number;

  readonly capabilities: ProtocolCapabilities;
  readonly consumes: readonly CompatQuirk[];

  endpoint(baseUrl: string, options?: { model?: string; stream?: boolean }): string;

  authHeaders(apiKey: string | undefined): Record<string, string>;

  buildBody(request: ChatRequest): Record<string, unknown>;

  extractErrorDetail(bodyText: string): string;

  drainStream(response: Response, ctx: DrainContext): Promise<DrainResult>;

  parseResponse(json: unknown): DrainResult;

  listModels(input: ListModelsInput): Promise<ListModelsResult>;
}

import { openaiAdapter } from "./adapters/openai.js";
import { anthropicAdapter } from "./adapters/anthropic.js";
import { geminiAdapter } from "./adapters/gemini.js";

export const PROTOCOL_ADAPTERS: Record<AiProtocol, ProtocolAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter
};

export function resolveAdapter(protocol: unknown): ProtocolAdapter {
  if (typeof protocol === "string" && protocol in PROTOCOL_ADAPTERS) {
    return PROTOCOL_ADAPTERS[protocol as AiProtocol];
  }
  return PROTOCOL_ADAPTERS.openai;
}

export const PROTOCOL_OPTIONS: ReadonlyArray<{ value: AiProtocol; label: string }> = [
  { value: "openai", label: "OpenAI Chat Completions" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini GenerateContent" }
];

