import { makeAbortedError, isRetryableNetworkError, isAbortedMarkerError, isAbortNamedError } from "../shared/error-helpers.js";
import { clampToLearnedMaxTokens, noteLearnedMaxTokens } from "./learned-budget.js";
import { CONSERVATIVE_MAX_TOKENS, isOutputBudgetTooLarge } from "./output-budget.js";
import {
  CONTEXT_OVERFLOW_DIRECT_PATTERNS,
  CONTEXT_OVERFLOW_RE,
  CONTEXT_OVERFLOW_SUBJECT_RE,
  normalizeErrorText
} from "./error-text-norms.js";
import { resolveAdapter } from "./protocol-adapter.js";
import { planThinkingWire } from "./plan-thinking.js";
import { presetRequestHeaders } from "./preset-headers.js";
import { noteUsageSample } from "./usage-stats.js";
import type { ChatToolDefinition, DrainResult } from "./protocol-adapter.js";
import type { ChatMessage, ChatToolCall, ChatUsage, ProviderRequest, StreamChatEvent, ThinkingBlock } from "./types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import type { ProviderTransport } from "../core/provider-http-shared.js";

interface OverflowError extends Error {
  overflow: true;
}

export function makeOverflowError(message = "上下文超出模型限制"): OverflowError {
  const error = new Error(message) as OverflowError;
  error.overflow = true;
  return error;
}

export function isContextLengthOverflow(detailOrError: unknown): boolean {
  const text = normalizeErrorText(detailOrError);
  if (!text) return false;

  for (const pattern of CONTEXT_OVERFLOW_DIRECT_PATTERNS) {
    if (text.includes(pattern)) return true;
  }

  return CONTEXT_OVERFLOW_SUBJECT_RE.test(text) && CONTEXT_OVERFLOW_RE.test(text);
}

interface HttpError extends Error {
  status: number;
  retryable: boolean;
}

function makeHttpError(status: number, detail: string): HttpError {
  const error = new Error(`HTTP ${status}${detail ? `: ${detail}` : ""}`) as HttpError;
  error.status = status;
  error.retryable = isRetryableNetworkError(error);
  return error;
}

interface NetworkError extends Error {
  cause: unknown;
  retryable: boolean;
}

function makeNetworkError(cause: unknown): NetworkError {
  const causeLike = cause as { message?: unknown } | undefined;
  const error = new Error(`网络错误：${causeLike?.message || cause}`) as NetworkError;
  error.cause = cause;
  error.retryable = isRetryableNetworkError(error);
  return error;
}

function defaultRetries(stream: boolean): number {
  return stream ? 2 : 0;
}

interface RetryPayload {
  attempt: number;
  maxRetries: number;
  kind: "fetch" | "http" | "stream";
  error: Error;
}

export interface ChatCompletionStreamResult {
  done: true;
  finishReason: string | null;
}

export interface ChatCompletionToolResult {
  done: true;
  finishReason: string | null;
  assistantContent: string;
  toolCalls: ChatToolCall[];
  thoughtSignature?: string;
  thinkingBlocks?: ThinkingBlock[];
}

export type ChatCompletionResult = string | ChatCompletionStreamResult | ChatCompletionToolResult;

export interface ChatCompletionInput {
  provider: ProviderRequest;
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  retries?: number;
  probe?: boolean;
  maxTokens?: number | null;
  temperature?: number;
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  tools?: ChatToolDefinition[];
  onEvent?: (event: StreamChatEvent) => void;
  onRetry?: (payload: RetryPayload) => void;
  onStreamReset?: () => void;
  retryDelayMs?: number;
  fetchImpl?: ProviderTransport;
}

export function validateProviderBasics(
  provider?: { baseUrl?: unknown; model?: unknown } | null
): { baseUrl: string; model: string } {
  const baseUrl = String(provider?.baseUrl || "").trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("baseUrl 未配置");
  }
  const model = provider?.model;
  if (!model) {
    throw new Error("模型未配置");
  }
  return { baseUrl, model: String(model) };
}

export async function chatCompletion({
  provider,
  messages,
  stream = false,
  signal,
  thinkingLevel,
  retries,
  probe = false,
  maxTokens,
  temperature,
  extraBody,
  headers: extraHeaders,
  tools,
  onEvent,
  onRetry,
  onStreamReset,
  retryDelayMs = 800,
  fetchImpl = globalThis.fetch
}: ChatCompletionInput): Promise<ChatCompletionResult> {
  const { baseUrl, model } = validateProviderBasics(provider);

  if (stream && fetchImpl.supportsStreaming === false) {
    throw new Error("当前传输通道不支持流式响应");
  }

  const adapter = resolveAdapter(provider.protocol);

  const thinkingWire = planThinkingWire({
    protocol: adapter.protocol,
    model,
    presetId: provider.presetId,
    baseUrl,
    level: thinkingLevel,
    stream,
    probe
  });

  const maxRetries = retries ?? defaultRetries(stream);

  const headers: Record<string, string> = {
    ...adapter.authHeaders(provider.apiKey),
    ...presetRequestHeaders(provider),
    ...extraHeaders,
    "Content-Type": "application/json"
  };

  const budgetScope = { baseUrl, model };
  let effectiveMaxTokens = clampToLearnedMaxTokens(
    probe ? (maxTokens ?? 1) : (maxTokens ?? adapter.defaultMaxTokens ?? null),
    budgetScope
  );

  const buildBody = (): Record<string, unknown> => {
    const built = adapter.buildBody({
      model,
      messages,
      stream,
      thinkingWire,
      maxTokens: effectiveMaxTokens,
      tools
    });
    if (extraBody) {
      Object.assign(built, extraBody);
    }
    if (temperature !== undefined) {
      built.temperature = temperature;
    }
    return built;
  };
  let body = buildBody();

  const noteResponseUsage = (usage: ChatUsage | undefined): void => {
    if (!usage) {
      return;
    }
    const payloadChars = (Array.isArray(messages) ? messages : []).reduce(
      (sum, message) => sum + (typeof message?.content === "string" ? message.content.length : 0),
      0
    );
    noteUsageSample(budgetScope, {
      payloadChars,
      inputTokens: usage.inputTokens
    });
  };

  const errorDetail = (bodyText: string): string => {
    const extracted = adapter.extractErrorDetail(bodyText);
    return extracted ? `[${adapter.protocol}] ${extracted}`.slice(0, 200) : "";
  };

  const sendOnce = async (): Promise<{ response: Response; bodyText: string }> => {
    let sentBudget = effectiveMaxTokens;
    let retreatedTo: number | null = null;
    for (;;) {
      const response = await fetchImpl(adapter.endpoint(baseUrl, { model, stream }), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
      });
      if (response.ok) {
        if (retreatedTo != null) {
          noteLearnedMaxTokens(budgetScope, retreatedTo);
        }
        return { response, bodyText: "" };
      }
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {}
      if (sentBudget != null && sentBudget > CONSERVATIVE_MAX_TOKENS && isOutputBudgetTooLarge(errorDetail(bodyText))) {
        sentBudget = CONSERVATIVE_MAX_TOKENS;
        retreatedTo = sentBudget;
        effectiveMaxTokens = sentBudget;
        body = buildBody();
        continue;
      }
      return { response, bodyText };
    }
  };

  let lastFailure: { kind: "fetch" | "http" | "stream"; error: Error } | null = null;
  for (let attempt = 0; ; attempt++) {
    if (lastFailure) {
      onRetry?.({ attempt, maxRetries, kind: lastFailure.kind, error: lastFailure.error });
      if (stream && lastFailure.kind === "stream") {
        onStreamReset?.();
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      lastFailure = null;
    }

    let response: Response;
    let bodyText = "";
    try {
      ({ response, bodyText } = await sendOnce());
    } catch (e) {
      if (signal?.aborted || isAbortedMarkerError(e) || isAbortNamedError(e)) {
        throw makeAbortedError();
      }
      const error = makeNetworkError(e);
      if (attempt >= maxRetries) {
        throw error;
      }
      lastFailure = { kind: "fetch", error };
      continue;
    }

    if (!response.ok) {
      const detail = errorDetail(bodyText);
      if (!isOutputBudgetTooLarge(detail) && isContextLengthOverflow(detail)) {
        throw makeOverflowError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const error = makeHttpError(response.status, detail);
      if (attempt >= maxRetries) {
        throw error;
      }
      lastFailure = { kind: "http", error };
      continue;
    }

    if (probe) {
      return "";
    }

    if (stream) {
      let streamResult: DrainResult;
      try {
        streamResult = await adapter.drainStream(response, { signal, onEvent });
      } catch (e) {
        if (isAbortedMarkerError(e) || signal?.aborted) {
          throw makeAbortedError();
        }
        const error = e instanceof Error ? e : new Error(String((e as { message?: unknown })?.message ?? e));
        if (attempt >= maxRetries) {
          throw error;
        }
        lastFailure = { kind: "stream", error };
        continue;
      }
      noteResponseUsage(streamResult.usage);
      if (streamResult.toolCalls.length) {
        return {
          done: true,
          finishReason: streamResult.finishReason,
          assistantContent: streamResult.content,
          toolCalls: streamResult.toolCalls,
          ...(streamResult.thoughtSignature ? { thoughtSignature: streamResult.thoughtSignature } : {}),
          ...(streamResult.thinkingBlocks?.length ? { thinkingBlocks: streamResult.thinkingBlocks } : {})
        };
      }
      return { done: true, finishReason: streamResult.finishReason };
    }

    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error(`响应解析失败：${(e as { message?: unknown })?.message || e}`);
    }
    const parsed = adapter.parseResponse(json);
    noteResponseUsage(parsed.usage);
    if (parsed.toolCalls.length) {
      return {
        done: true,
        finishReason: parsed.finishReason,
        assistantContent: parsed.content,
        toolCalls: parsed.toolCalls,
        ...(parsed.thoughtSignature ? { thoughtSignature: parsed.thoughtSignature } : {}),
        ...(parsed.thinkingBlocks?.length ? { thinkingBlocks: parsed.thinkingBlocks } : {})
      };
    }
    return parsed.content;
  }
}
