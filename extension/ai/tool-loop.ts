// tool-loop.ts — 联网搜索的工具调用循环（spec §2.3，offscreen 侧包住
// chatCompletion 的单次调用）。纯编排层：不知道 port / DOM / chrome API，
// 搜索执行经 executeSearch 回调注入（offscreen 注入 search-executor 的闭包，
// SW 经 provider-http 通道发起，密钥不出 SW），port 回吐留在调用方
// （ai/client.ts 的 streamChat，port 适配单源）。
//
// 语义（spec §2.3）：
// - finish_reason=tool_calls 时不回 done：回填 assistant(tool_calls) 消息 →
//   逐条搜索回填 tool 结果消息 → 二次调用继续流式回吐；
// - 单条 tool call 计入配额；达 maxToolCalls 后摘除 tools 并注入「额度用尽」
//   system 提示（不进持久化历史，buildMessages 的历史过滤自动丢弃）；
// - 搜索失败：tool 消息写「搜索失败：<原因>」+ notice，回答不中断；
// - 平台不支持 tools（4xx）：notice + 摘除 tools 无联网重发一次；
// - 中止 / context-length 溢出照 chatCompletion 原语义上抛。
import { chatCompletion, parseToolArgs, type ChatToolDefinition } from "./completion.js";
import type { ChatMessage, ChatToolCall, StreamChatEvent } from "./types.js";
import type { NormalizedSearchResult } from "../search/adapters/types.js";

// web_search 工具定义（spec §2.1 原文）：对话链版本带 §4 引用要求——正文引用
// 搜索结果时以 [n] 标记（n 为该条结果在全部搜索结果中的全局序号，从 1 起按
// 搜索与结果顺序累计——宿主按 tool-status 到达顺序同序编号，两侧对齐）。
export const WEB_SEARCH_TOOL: ChatToolDefinition = webSearchTool();

// 工具定义工厂（选区解释链用）：解释卡无来源 chip 行与内联引用的渲染，[n]
// 标记会悬空，requireCitations=false 时描述不提引用要求。
export function webSearchTool({ requireCitations = true }: { requireCitations?: boolean } = {}): ChatToolDefinition {
  const citations = requireCitations
    ? "回答正文中引用搜索结果时使用 [n] 标记（n 为该条结果在全部搜索结果中的序号，从 1 开始按搜索与结果顺序累计）。"
    : "";
  return {
    type: "function",
    function: {
      name: "web_search",
      description: `搜索互联网获取视频内容之外的信息。需要时效性信息或视频未覆盖的事实时调用。${citations}`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "搜索关键词" } },
        required: ["query"]
      }
    }
  };
}

// 单次搜索注入条数上限（spec §5：超出丢弃）。
export const MAX_SEARCH_RESULTS_PER_TOOL = 8;
// 单次 tool 消息内容注入上限（spec §5，约 4,000 字符）。
export const TOOL_CONTENT_MAX_CHARS = 4000;
// tool 结果持久化截断（spec §2.5：完整结果只活在当轮请求里）。
export const TOOL_MESSAGE_MAX_CHARS = 2000;

// executeSearch 的统一产物：platform 为平台名（tool-status / UI 展示用）。
export interface ToolLoopSearchOutcome {
  results: NormalizedSearchResult[];
  platform: string;
}

export type ExecuteSearchFn = (query: string) => Promise<ToolLoopSearchOutcome>;

export interface ToolStatusPayload {
  status: "searching" | "done" | "failed";
  query: string;
  resultCount?: number;
  platform?: string;
  // 搜索结果（done 时携带，spec §4）：时间线卡 chip 行与内联引用的数据源。
  sources?: NormalizedSearchResult[];
}

export interface RunToolLoopInput {
  provider: { baseUrl?: string; apiKey?: string; model?: string; presetId?: string };
  // 循环中就地追加 assistant(tool_calls) / tool / system 消息（调用方持有数组）。
  messages: ChatMessage[];
  stream?: boolean;
  signal?: AbortSignal | null;
  thinkingLevel?: string;
  maxToolCalls: number;
  executeSearch: ExecuteSearchFn;
  // 工具定义变体：缺省 WEB_SEARCH_TOOL（对话链带 [n] 引用要求）；选区解释链
  // 传 webSearchTool({ requireCitations: false })（解释卡无引用渲染）。
  toolDefinition?: ChatToolDefinition;
  // 透传 chatCompletion 的输出上限（选区解释链钉 320，见 ai/explain.ts）。
  maxTokens?: number;
  // 逐轮透传 chatCompletion 的流事件与重试回调（token 合帧等适配留在调用方）。
  onEvent?: (event: StreamChatEvent) => void;
  onRetry?: (payload: { attempt: number; maxRetries: number; kind: string; error: Error }) => void;
  onStreamReset?: () => void;
  // notice：额度用尽 / 平台不支持 tools / 搜索失败等用户可见提示。
  onNotice?: (text: string) => void;
  onToolStatus?: (payload: ToolStatusPayload) => void;
  // 每轮搜索完成后回吐持久化副本（tool 内容截 TOOL_MESSAGE_MAX_CHARS）。
  onToolTurn?: (messages: ChatMessage[]) => void;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

// 结果数组 JSON 序列化（spec §5）：先截 MAX_SEARCH_RESULTS_PER_TOOL 条，总量
// 超 TOOL_CONTENT_MAX_CHARS 再裁条数，单条仍超限才硬截字符串。
function serializeSearchResults(results: NormalizedSearchResult[]): string {
  const capped = results.slice(0, MAX_SEARCH_RESULTS_PER_TOOL);
  let payload = JSON.stringify(capped);
  while (payload.length > TOOL_CONTENT_MAX_CHARS && capped.length > 1) {
    capped.pop();
    payload = JSON.stringify(capped);
  }
  return payload.slice(0, TOOL_CONTENT_MAX_CHARS);
}

/**
 * 工具调用流式循环：包住 chatCompletion 的多轮调用（spec §2.3）。
 * - 每轮配额未满带 WEB_SEARCH_TOOL；finish_reason=tool_calls 时回填消息续跑；
 * - 达 maxToolCalls 后摘除 tools + 注入「额度用尽」system 提示（一次性）；
 * - 搜索失败降级 + notice；平台 4xx（非溢出/中止）摘除 tools 单次重发 + notice；
 * - 中止/溢出原语义上抛，由调用方（streamChat）既有 catch 收口。
 * 返回最终回答文本（非流式链消费；流式链文本走 onEvent，返回值被忽略）。
 */
export async function runToolLoop(input: RunToolLoopInput): Promise<string> {
  const {
    provider,
    messages,
    stream = true,
    signal,
    thinkingLevel,
    maxToolCalls,
    executeSearch,
    toolDefinition = WEB_SEARCH_TOOL,
    maxTokens,
    onEvent,
    onRetry,
    onStreamReset,
    onNotice,
    onToolStatus,
    onToolTurn,
    retryDelayMs,
    fetchImpl
  } = input;

  let toolCallCount = 0;
  let quotaNoticeInjected = false;
  let retriedWithoutTools = false;
  // 最终回答文本（非流式轮取 chatCompletion 字符串；工具轮取各轮 assistantContent，
  // 后续轮覆盖）。返回值：选区解释链消费（非流式无 onEvent 拼装），流式调用方忽略。
  let finalText = "";

  while (true) {
    const withTools = !retriedWithoutTools && toolCallCount < maxToolCalls;

    let result: string | { done: true } | Awaited<ReturnType<typeof chatCompletion>>;
    try {
      result = await chatCompletion({
        provider,
        messages,
        stream,
        signal,
        thinkingLevel,
        maxTokens,
        tools: withTools ? [toolDefinition] : undefined,
        onEvent,
        onRetry,
        onStreamReset,
        retryDelayMs,
        fetchImpl
      });
    } catch (e) {
      // 中止/溢出原语义上抛；4xx（非溢出/中止）= 平台不支持 tools → 摘除重发一次。
      if ((e as { aborted?: boolean })?.aborted || signal?.aborted) {
        throw e;
      }
      if ((e as { overflow?: boolean })?.overflow) {
        throw e;
      }
      const status = (e as { status?: unknown })?.status;
      // 4xx 且不可重试（400/401/404 等）= 平台不支持 tools；408/429/5xx 仍走
      // chatCompletion 既有重试链（isRetryableNetworkError 语义一致）。
      if (
        withTools &&
        !retriedWithoutTools &&
        !(e as { retryable?: boolean })?.retryable &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500
      ) {
        onNotice?.("当前平台不支持工具调用，本轮未联网");
        retriedWithoutTools = true;
        continue;
      }
      throw e;
    }

    if (typeof result !== "object" || !("toolCalls" in result) || !result.toolCalls?.length) {
      // 普通完成（无 tool_calls / 非流式纯文本）：循环结束，done 由调用方发。
      // 非流式轮 result 为最终文本（选区解释链取它）；流式轮文本已经 onEvent
      // 回吐（调用方拼装），此处返回值无消费方。
      return typeof result === "string" ? result : finalText;
    }

    const { finishReason, assistantContent, toolCalls } = result as {
      finishReason: string | null;
      assistantContent: string;
      toolCalls: ChatToolCall[];
    };
    if (finishReason !== "tool_calls") {
      return typeof result === "string" ? result : finalText;
    }
    // 工具轮的 assistantContent（tool 调用前的前言）不是最终回答；后续轮覆盖。
    finalText = assistantContent;

    // 回填 assistant(tool_calls) 消息，逐条执行搜索并回填 tool 结果。
    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: assistantContent || "",
      tool_calls: toolCalls
    };
    const toolMessages: ChatMessage[] = [];
    for (const call of toolCalls) {
      const query = parseToolArgs(call.function.arguments).query;
      onToolStatus?.({ status: "searching", query });
      let toolContent: string;
      try {
        const outcome = await executeSearch(query);
        toolContent = serializeSearchResults(outcome.results);
        onToolStatus?.({
          status: "done",
          query,
          resultCount: outcome.results.length,
          platform: outcome.platform,
          sources: outcome.results
        });
      } catch (e) {
        // 搜索请求被中止：照 chatCompletion 的中止语义上抛，不伪装成搜索失败。
        if ((e as { aborted?: boolean })?.aborted || (e as { name?: string })?.name === "AbortError" || signal?.aborted) {
          throw e;
        }
        const reason = String((e as { message?: unknown })?.message ?? e);
        toolContent = `搜索失败：${reason}`;
        onToolStatus?.({ status: "failed", query });
        onNotice?.(`联网搜索失败：${reason}`);
      }
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
    }
    messages.push(assistantMessage, ...toolMessages);
    toolCallCount += toolCalls.length;

    // 持久化副本：tool 内容截 2,000 字符（完整结果只活在当轮请求里，spec §2.5）。
    onToolTurn?.([
      assistantMessage,
      ...toolMessages.map((m) => ({ ...m, content: m.content.slice(0, TOOL_MESSAGE_MAX_CHARS) }))
    ]);

    if (toolCallCount >= maxToolCalls) {
      // 额度用尽：摘除 tools（下轮 withTools=false），注入提示后继续作答。
      messages.push({
        role: "system",
        content: `搜索额度已用尽（${maxToolCalls} 次上限），请基于已有搜索结果作答。`
      });
      onNotice?.("搜索额度已用尽，请基于已有搜索结果查看回答");
    }
  }
}
