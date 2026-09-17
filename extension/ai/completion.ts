// ai/completion.ts — AI chat 单一 fetch 点的 core 骨架（multi-protocol-ai 缝，
// spec 契约章）：对外签名、重试循环（流式 2 / 非流式 0）、中止收束、
// isContextLengthOverflow 判定、探针语义（成功 = response.ok 不读体）、读流
// 中断重试 + stream-reset 代际信号，全部留在这里不动。
// 随协议变化的事（endpoint / authHeaders / buildBody / extractErrorDetail /
// drainStream / parseResponse）委托 ProtocolAdapter（protocol-adapter.ts 注册表，
// resolveAdapter 单点解析，缺字段/未知值兜底 openai——存量记录零变化）；
// 编排层（client 流式 / map-reduce 非流式 / tool-loop）面对统一 ChatMessage[] 与
// StreamChatEvent，零改动。OpenAI 兼容行为整体迁入 adapters/openai.ts。
// 纯协议层约束：不 import port/DOM/offscreen 任何东西——流式增量经 onEvent
// 回调吐出，port 回吐留在调用方适配器；完成值与错误走返回/throw。
//
// 错误模型（house style 类型化标记，唯一写点在本文件）：
// - context-length 溢出 → makeOverflowError（err.overflow = true，不重试）
// - 中止 → makeAbortedError（err.aborted = true，不重试）
// - 网络/HTTP 失败 → err.status（HTTP 状态）/ err.cause（原始抛出物）
//   结构化字段，err.retryable 与 isRetryableNetworkError 语义一致；
//   重试触发条件与旧 client 现状一致：fetch 抛错与非溢出 !response.ok
//   （及流式读流中断）都重试，与状态码无关。
import { makeAbortedError, isRetryableNetworkError } from "../shared/error-helpers.js";
import { resolveAdapter } from "./protocol-adapter.js";
import type { AiProtocol, ChatRequest, ChatToolDefinition, DrainResult } from "./protocol-adapter.js";
import type { ChatMessage, ChatToolCall, StreamChatEvent } from "./types.js";

// 思考档位词表唯一主人在 thinking-profiles（表与档位同域）；此处 re-export
// 保住既有 import 路径（completion 曾是词表主人）。
export { normalizeThinkingLevel } from "./thinking-profiles.js";

// OpenAI 兼容协议的请求构造/路径/tool-args 解析随迁 adapters/openai.ts，此处
// re-export 保住既有 import 路径（行为不变）。
export { buildChatRequestBody, OPENAI_CHAT_PATH, parseToolArgs } from "./adapters/openai.js";

// tools 定义词表随迁 protocol-adapter.ts（adapter 内翻译成协议线格式），
// 此处 re-export 保住既有 import 路径。
export type { ChatToolDefinition } from "./protocol-adapter.js";

interface OverflowError extends Error {
  overflow: true;
}

/**
 * 溢出错误工厂：err.overflow = true 的唯一写点。
 * message 沿用触发场景的原始文案（HTTP 详情 / 预算回落提示），供日志排查；
 * 消费方按 err.overflow 标记分流（ladder 转 Map-Reduce 或报错），不读 message。
 */
export function makeOverflowError(message = "上下文超出模型限制"): OverflowError {
  const error = new Error(message) as OverflowError;
  error.overflow = true;
  return error;
}

/**
 * 判定一段错误文案是否属于 context-length 溢出（纯函数，自 client.js 迁入）。
 * 粗判：命中常见溢出子串，或「长度/上下文/令牌」语义 + 「超限」语义同时出现。
 * 非溢出错误（401/404/500/网络错误/限流等）返回 false，仍走既有重试/报错路径。
 */
export function isContextLengthOverflow(detailOrError: unknown): boolean {
  const text = String(detailOrError ?? "").toLowerCase();
  if (!text) return false;

  const directPatterns = [
    "context_length",
    "context length",
    "maximum context length",
    "max context length",
    "context window",
    "too many tokens",
    "too long",
    "too large",
    "max_tokens",
    "max tokens",
    "token limit",
    "最大上下文",
    "上下文长度",
    "上下文超出",
    "超出上下文",
    "超出长度",
    "超过上下文",
    "令牌超限",
    "token超限",
    "超出上限"
  ];

  for (const pattern of directPatterns) {
    if (text.includes(pattern)) return true;
  }

  const subjectPattern = /(context|tokens?|length|上下文|长度|令牌|窗口)/;
  const overflowPattern = /(exceed|limit|maximum|too many|too long|overflow|超出|超过|超限|上限|最大)/;
  return subjectPattern.test(text) && overflowPattern.test(text);
}

interface HttpError extends Error {
  status: number;
  retryable: boolean;
}

// HTTP 非 2xx 错误：文案与 formatProbeHttpError 同型（detail 截前 200 字符），
// 附 status 结构化字段与 retryable 语义（408/429/≥500 可重试）。
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

// 网络层（fetch 抛错）错误：文案对齐旧实现的「网络错误：」前缀；
// 原始抛出物挂 cause（探针适配层据此拼「无法连接：…」），retryable 语义同上。
function makeNetworkError(cause: unknown): NetworkError {
  const causeLike = cause as { message?: unknown } | undefined;
  const error = new Error(`网络错误：${causeLike?.message || cause}`) as NetworkError;
  error.cause = cause;
  error.retryable = isRetryableNetworkError(error);
  return error;
}

// 重试默认策略：流式 2 次（保持旧 client MAX_STREAM_RETRIES=2 现状）；
// 非流式/探针 0（map-reduce 与探针现状无重试；是否给归并链路开重试是后续独立决定）。
function defaultRetries(stream: boolean): number {
  return stream ? 2 : 0;
}

interface RetryPayload {
  attempt: number;
  maxRetries: number;
  kind: "fetch" | "http" | "stream";
  error: Error;
}

interface ChatCompletionToolResult {
  done: true;
  finishReason: string | null;
  assistantContent: string;
  toolCalls: ChatToolCall[];
}

interface ChatCompletionInput {
  // provider 记录形状：presetId 是 preset 词表键（core/ai-provider-store 归一化
  // 缺省 "custom"），思考参数查表的平台识别主路径——02 号票穿线，未命中（custom/
  // 旧记录）回落 baseUrl host 推断。protocol 是平台协议字段（multi-protocol-ai），
  // 缺省/未知值经 resolveAdapter 兜底 openai，存量记录零变化。
  provider: { baseUrl?: string; apiKey?: string; model?: string; presetId?: string; protocol?: AiProtocol };
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  retries?: number;
  probe?: boolean;
  maxTokens?: number | null;
  headers?: Record<string, string>;
  // 联网搜索管线（spec §2.1）：传入即注入 tools + tool_choice: "auto"。
  tools?: ChatToolDefinition[];
  onEvent?: (event: StreamChatEvent) => void;
  onRetry?: (payload: RetryPayload) => void;
  onStreamReset?: () => void;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * chat 单一入口（流式与非流式合一，probe 为探针特化）。
 * 参数：
 * - provider: { baseUrl, apiKey, model, presetId?, protocol? }；baseUrl 去尾斜杠。
 *   protocol 经 resolveAdapter 解析为 ProtocolAdapter：端点 / 鉴权头 / 请求体
 *   （思考档位查表、token 上限参数名、tools 透传）随 adapter 组装；缺省/未知值
 *   兜底 openai（存量行为零变化）。
 * - messages: OpenAI 消息数组（编排层词表，adapter 内翻译；组装留在调用方）。
 * - stream: 流式增量经 onEvent 吐出，成功返回 { done: true }；
 *   非流式成功返回聚合 content（非字符串回落空串，adapter.parseResponse 兜底）。
 *   解析出 tool_calls（联网搜索管线，spec §2.1）时改返回
 *   { done: true, finishReason, assistantContent, toolCalls }——流式与非流式都由
 *   adapter 聚合返回；无 tools 调用方返回值形状不变。
 * - probe: 探针模式——body 强制 token 上限参数（默认 1），成功判定 = response.ok
 *   且不读响应体（某些兼容网关在 max_tokens:1 下返回非 JSON 体，不视为失败）。
 * - retries: 重试次数，默认流式 2 / 非流式 0；退避线性 retryDelayMs × attempt。
 *   溢出/中止不重试；重试前的用户可见提示经 onRetry({ attempt, maxRetries, kind, error })，
 *   kind: "fetch"（网络抛错）| "http"（非溢出 !response.ok）| "stream"（读流中断）。
 * - onStreamReset: 流式专用——读流中断（kind=stream）重试时，在新流任何事件吐出
 *   前调用一次。重试从头生成、已吐事件无法撤回且新流不保证前缀一致，渲染层
 *   收到该信号应清空本条消息的流式缓冲整体重放（避免两代流拼接成重复文本）。
 *   fetch/http 阶段的失败未吐过任何事件，不触发。
 * - headers: 额外请求头（探针的 Accept 等）；Content-Type 固定 JSON，
 *   同键不覆盖调用方注入（Authorization 由 adapter.authHeaders 提供，可被
 *   extraHeaders 覆盖——对齐旧「已存在时不重复注入」语义）。
 * - thinkingLevel / maxTokens / signal / fetchImpl（默认 globalThis.fetch）；
 *   思考字段由 adapter 内经 thinking-profiles 按平台×模型查表。
 * 错误模型见文件头注释；HTTP 错误 detail 经 adapter.extractErrorDetail 提取、
 * core 统一加 `[协议名] ` 前缀并截前 200 字符（spec：错误归一化，调用层零改动）。
 */
/**
 * 请求构造校验单点（arch-slim-3/09）：baseUrl 归一（去空白/去尾斜杠）+ 基础
 * 字段校验的唯一实现，同两条错误文案（"baseUrl 未配置"/"模型未配置"）单点
 * 维护。chatCompletion 直接消费返回值；client 的 port 适配层 catch 后转
 * port 回吐。
 */
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
  headers: extraHeaders,
  tools,
  onEvent,
  onRetry,
  onStreamReset,
  retryDelayMs = 800,
  fetchImpl = globalThis.fetch
}: ChatCompletionInput): Promise<string | { done: true } | ChatCompletionToolResult> {
  const { baseUrl, model } = validateProviderBasics(provider);

  // 协议解析单点（multi-protocol-ai）：存量记录缺 protocol 字段 / 未知值 →
  // openai adapter，行为零变化。
  const adapter = resolveAdapter(provider.protocol);

  const maxRetries = retries ?? defaultRetries(stream);

  // 鉴权头形状由 adapter.authHeaders 全权负责（各协议不同：Bearer / x-api-key
  // 等）；extraHeaders 同键优先（对齐旧「Authorization 已存在时不重复注入」），
  // Content-Type 固定 JSON。
  const headers: Record<string, string> = {
    ...adapter.authHeaders(provider.apiKey),
    ...extraHeaders,
    "Content-Type": "application/json"
  };

  const request: ChatRequest = {
    model,
    messages,
    stream,
    probe,
    baseUrl,
    apiKey: provider.apiKey,
    presetId: provider.presetId,
    thinkingLevel,
    maxTokens: probe ? (maxTokens ?? 1) : maxTokens,
    tools
  };
  const body = adapter.buildBody(request);

  // 上一次失败（kind + 错误）：attempt > 0 时经 onRetry 上报后再退避重试。
  let lastFailure: { kind: "fetch" | "http" | "stream"; error: Error } | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (lastFailure) {
      onRetry?.({ attempt, maxRetries, kind: lastFailure.kind, error: lastFailure.error });
      // 读流中断后的重试流从头生成：在新流任何事件吐出前发代际重置信号，
      // 渲染层据此清空缓冲整体重放（fetch/http 失败未吐过事件，无需重置）。
      if (stream && lastFailure.kind === "stream") {
        onStreamReset?.();
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      lastFailure = null;
    }

    let response: Response;
    try {
      response = await fetchImpl(adapter.endpoint(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal
      });
    } catch (e) {
      // 中止（真实 signal 中止 / 注入实现抛出的中止标记 / AbortError）统一收束。
      if (signal?.aborted || (e as { aborted?: boolean })?.aborted || (e as { name?: string }).name === "AbortError") {
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
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {}
      // 错误 detail 提取进 adapter（协议 error envelope 解析，如 OpenAI 的
      // error.message）；core 统一加 `[协议名] ` 前缀并截前 200 字符
      // （spec：归一化到现有错误形状，调用层零改动）。
      const extracted = adapter.extractErrorDetail(bodyText);
      const detail = extracted ? `[${adapter.protocol}] ${extracted}`.slice(0, 200) : "";
      if (isContextLengthOverflow(detail)) {
        // context-length 溢出：不重试，带 overflow 标记抛出供调用方分流。
        throw makeOverflowError(`HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
      }
      const error = makeHttpError(response.status, detail);
      if (attempt >= maxRetries) {
        throw error;
      }
      lastFailure = { kind: "http", error };
      continue;
    }

    // 探针成功判定 = response.ok，不读响应体（对齐旧 probeAiChatCompletion）。
    if (probe) {
      return "";
    }

    if (stream) {
      let streamResult: DrainResult;
      try {
        streamResult = await adapter.drainStream(response, { signal, onEvent });
      } catch (e) {
        if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
          throw makeAbortedError();
        }
        const error = e instanceof Error ? e : new Error(String((e as { message?: unknown })?.message ?? e));
        if (attempt >= maxRetries) {
          throw error;
        }
        lastFailure = { kind: "stream", error };
        continue;
      }
      if (streamResult.toolCalls.length) {
        return {
          done: true,
          finishReason: streamResult.finishReason,
          assistantContent: streamResult.content,
          toolCalls: streamResult.toolCalls
        };
      }
      return { done: true };
    }

    let json = null;
    try {
      json = await response.json();
    } catch (e) {
      throw new Error(`响应解析失败：${(e as { message?: unknown })?.message || e}`);
    }
    const parsed = adapter.parseResponse(json);
    if (parsed.toolCalls.length) {
      // 非流式 tool_calls（后续解释链接入用）：adapter 已宽容归一为 ChatToolCall[]。
      return {
        done: true,
        finishReason: parsed.finishReason,
        assistantContent: parsed.content,
        toolCalls: parsed.toolCalls
      };
    }
    return parsed.content;
  }
  // 循环内最后一次失败必 throw，此处不可达；防御性兜底满足控制流分析。
  throw lastFailure?.error || new Error("chatCompletion 未能完成");
}
