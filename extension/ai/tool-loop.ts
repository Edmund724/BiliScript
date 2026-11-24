import {
  chatCompletion,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type ChatCompletionStreamResult
} from "./completion.js";
import { parseToolArgs } from "./adapters/openai.js";
import type { ChatToolDefinition } from "./protocol-adapter.js";
import type { CaptureCurrentVideoFrame, CapturedVideoFrame, ChatMessage, ProviderRequest, StreamChatEvent } from "./types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import { isAbortedMarkerError, isAbortNamedError } from "../shared/error-helpers.js";
import { formatClock } from "../shared/clock-text.js";
import type { NormalizedSearchResult } from "../search/adapters/types.js";
import { formatPaidFallbackNotice, type PaidSearchFallback } from "../search/search-chain.js";

export const CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME = "capture_current_video_frame";
export const CAPTURE_CURRENT_VIDEO_FRAME_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME,
    description: "截取当前视频播放位置的一帧画面。只有当回答必须依赖当前可见画面、图表、代码或操作界面时调用；不要用于回顾其他时间点。每轮最多调用一次。",
    parameters: { type: "object", properties: {} }
  }
};

export const CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME = "capture_video_frame_at_time";
export const CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
    description: "当字幕不足以回答某个历史时间点的问题，且当时的画面、图表、代码或操作界面可能有帮助时，自主截取该时间点前、中、后三帧（前后各间隔 2 秒，视频边界处截断）。targetTime 必须是字幕或用户问题所指的视频秒数，不要猜测。不会改变用户播放器。每次提问最多补充三帧。",
    parameters: {
      type: "object",
      properties: {
        targetTime: { type: "number", description: "目标视频时间点，单位为秒" }
      },
      required: ["targetTime"]
    }
  }
};

export const FETCH_HOT_COMMENTS_TOOL_NAME = "fetch_hot_comments";
export const FETCH_HOT_COMMENTS_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: FETCH_HOT_COMMENTS_TOOL_NAME,
    description: "获取当前对话所关联视频的前 20 条热门评论，包含作者、点赞数和评论正文。用户询问评论区、观众反响、高赞观点或争议时调用；不要用于总结视频正文。每次提问最多调用一次。",
    parameters: { type: "object", properties: {} }
  }
};

export const WEB_SEARCH_TOOL: ChatToolDefinition = webSearchTool();

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

export const MAX_SEARCH_RESULTS_PER_TOOL = 8;
export const TOOL_CONTENT_MAX_CHARS = 4000;
export const TOOL_MESSAGE_MAX_CHARS = 2000;

export interface ToolLoopSearchOutcome {
  results: NormalizedSearchResult[];
  platform: string;
  downgradedFrom?: string;
  paid?: boolean;
  paidFallback?: PaidSearchFallback;
}

export type ExecuteSearchFn = (query: string) => Promise<ToolLoopSearchOutcome>;
export interface ToolLoopHotComment {
  uname?: string;
  like?: number;
  message?: string;
}
export type FetchHotCommentsFn = () => Promise<ToolLoopHotComment[]>;

export interface ToolStatusPayload {
  status: "searching" | "done" | "failed" | "cancelled";
  query: string;
  tool?: "web_search" | "capture_video_frame_at_time";
  callId?: string;
  targetTime?: number;
  resultCount?: number;
  expectedCount?: number;
  frames?: CapturedVideoFrame[];
  platform?: string;
  sources?: NormalizedSearchResult[];
  paid?: boolean;
  paidFallbackNotice?: string;
}

export interface ToolLoopRequestProfile
  extends Pick<
    ChatCompletionInput,
    | "provider"
    | "stream"
    | "signal"
    | "thinkingLevel"
    | "maxTokens"
    | "retries"
    | "onEvent"
    | "onRetry"
    | "onStreamReset"
    | "retryDelayMs"
    | "fetchImpl"
  > {
  toolDefinition?: ChatToolDefinition;
  includeWebSearchTool?: boolean;
  includeHistoricalFrameTool?: boolean;
}

export interface RunToolLoopInput {
  requestProfile: ToolLoopRequestProfile;
  messages: ChatMessage[];
  maxToolCalls: number;
  executeSearch: ExecuteSearchFn;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  fetchHotComments?: FetchHotCommentsFn;
  onNotice?: (text: string) => void;
  onToolStatus?: (payload: ToolStatusPayload) => void;
  onToolTurn?: (messages: ChatMessage[]) => void;
}

export function serializeSearchResults(results: NormalizedSearchResult[]): string {
  const capped = results.slice(0, MAX_SEARCH_RESULTS_PER_TOOL);
  let payload = JSON.stringify(capped);
  while (payload.length > TOOL_CONTENT_MAX_CHARS && capped.length > 1) {
    capped.pop();
    payload = JSON.stringify(capped);
  }
  return payload.slice(0, TOOL_CONTENT_MAX_CHARS);
}

export const HOT_COMMENT_MESSAGE_MAX_CHARS = 500;
export const HOT_COMMENTS_CONTENT_MAX_CHARS = 12000;

export function serializeHotComments(comments: ToolLoopHotComment[]): string {
  const capped = comments.slice(0, 20).map((comment) => ({
    uname: String(comment.uname || "匿名"),
    like: Number(comment.like || 0),
    message: String(comment.message || "").slice(0, HOT_COMMENT_MESSAGE_MAX_CHARS)
  }));
  let payload = JSON.stringify(capped);
  while (payload.length > HOT_COMMENTS_CONTENT_MAX_CHARS && capped.length > 1) {
    capped.pop();
    payload = JSON.stringify(capped);
  }
  return payload;
}

export async function runToolLoop(input: RunToolLoopInput): Promise<string | ChatCompletionStreamResult> {
  const {
    requestProfile,
    messages,
    maxToolCalls,
    executeSearch,
    captureCurrentVideoFrame,
    fetchHotComments,
    onNotice,
    onToolStatus,
    onToolTurn
  } = input;
  const {
    signal,
    toolDefinition = WEB_SEARCH_TOOL,
    includeWebSearchTool = true,
    includeHistoricalFrameTool = true,
    stream = true
  } = requestProfile;

  let toolCallCount = 0;
  let quotaNoticeInjected = false;
  let retriedWithoutTools = false;
  let captureUsed = false;
  let hotCommentsUsed = false;
  let finalText = "";

  while (true) {
    const searchAvailable = includeWebSearchTool && !retriedWithoutTools && toolCallCount < maxToolCalls;
    const captureAvailable = Boolean(captureCurrentVideoFrame) && !captureUsed && !retriedWithoutTools;
    const hotCommentsAvailable = Boolean(fetchHotComments) && !hotCommentsUsed && !retriedWithoutTools;
    const frameTools = captureAvailable
      ? includeHistoricalFrameTool
        ? [CAPTURE_CURRENT_VIDEO_FRAME_TOOL, CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL]
        : [CAPTURE_CURRENT_VIDEO_FRAME_TOOL]
      : [];
    const tools = [
      ...(searchAvailable ? [toolDefinition] : []),
      ...frameTools,
      ...(hotCommentsAvailable ? [FETCH_HOT_COMMENTS_TOOL] : [])
    ];
    const withTools = tools.length > 0;

    let result: ChatCompletionResult;
    try {
      result = await chatCompletion({
        ...requestProfile,
        stream,
        messages,
        tools: withTools ? tools : undefined
      });
    } catch (e) {
      if (isAbortedMarkerError(e) || signal?.aborted) {
        throw e;
      }
      if ((e as { overflow?: boolean })?.overflow) {
        throw e;
      }
      const status = (e as { status?: unknown })?.status;
      if (
        withTools &&
        !retriedWithoutTools &&
        !(e as { retryable?: boolean })?.retryable &&
        typeof status === "number" &&
        status >= 400 &&
        status < 500
      ) {
        const unavailableActions = [
          ...(includeWebSearchTool ? ["联网"] : []),
          ...(captureCurrentVideoFrame ? ["截取画面"] : []),
          ...(fetchHotComments ? ["获取评论"] : [])
        ];
        onNotice?.(`当前平台不支持工具调用，本轮未${unavailableActions.join("或")}`);
        retriedWithoutTools = true;
        continue;
      }
      throw e;
    }

    if (typeof result !== "object" || !("toolCalls" in result) || !result.toolCalls?.length) {
      return typeof result === "string" ? result : { done: true, finishReason: result.finishReason };
    }

    const { finishReason, assistantContent, toolCalls, thoughtSignature, thinkingBlocks } = result;
    if (finishReason !== "tool_calls") {
      return stream ? { done: true, finishReason } : finalText;
    }
    finalText = assistantContent;

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: assistantContent || "",
      tool_calls: toolCalls,
      ...(thoughtSignature ? { thoughtSignature } : {}),
      ...(thinkingBlocks?.length ? { thinkingBlocks } : {})
    };
    const toolMessages: ChatMessage[] = [];
    const frameMessages: ChatMessage[] = [];
    for (const call of toolCalls) {
      const isCurrentFrame = call.function.name === CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME;
      const isHistoricalFrame = call.function.name === CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME;
      if (isCurrentFrame || isHistoricalFrame) {
        if (isHistoricalFrame && !includeHistoricalFrameTool) {
          toolMessages.push({
            role: "tool",
            tool_call_id: call.id,
            content: "当前站点不支持历史时间点截帧工具，请仅使用 capture_current_video_frame 或基于字幕作答。"
          });
          continue;
        }
        let toolContent = "本轮已调用过视频截图工具，请基于已有画面作答。";
        if (captureCurrentVideoFrame && !captureUsed) {
          captureUsed = true;
          let historicalTargetTime: number | undefined;
          let historicalStatusStarted = false;
          try {
            const targetTime = isHistoricalFrame
              ? Number((JSON.parse(call.function.arguments) as { targetTime?: unknown }).targetTime)
              : undefined;
            if (isHistoricalFrame && (typeof targetTime !== "number" || !Number.isFinite(targetTime) || targetTime < 0)) {
              throw new Error("targetTime 必须是大于或等于 0 的有限秒数");
            }
            if (isHistoricalFrame) {
              historicalTargetTime = targetTime;
              historicalStatusStarted = true;
              onToolStatus?.({
                status: "searching",
                tool: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
                query: formatClock(targetTime, { hours: "auto" }),
                callId: call.id,
                targetTime
              });
            }
            const captureResult = isHistoricalFrame
              ? await captureCurrentVideoFrame(targetTime)
              : await captureCurrentVideoFrame();
            const frames = (Array.isArray(captureResult) ? captureResult : [captureResult]).slice(0, 3);
            if (!frames.length) {
              throw new Error("三个时间点均未截取成功");
            }
            const times = frames.map((frame) => formatClock(frame.currentTime, { hours: "auto" }));
            const target = isHistoricalFrame ? formatClock(targetTime, { hours: "auto" }) : "";
            toolContent = isHistoricalFrame
              ? Array.isArray(captureResult)
                ? frames.length === 3
                  ? `已截取目标时间点 ${target} 附近的前、中、后三帧，实际时间依次为 ${times.join("、")}。`
                  : `目标时间点 ${target} 附近仅成功截取 ${frames.length} 张画面，实际时间依次为 ${times.join("、")}；其余 ${3 - frames.length} 张截取失败。`
                : `已截取视频在 ${times[0]} 的画面（目标时间点 ${target}）。`
              : `已截取视频在 ${times[0]} 的画面。`;
            if (isHistoricalFrame) {
              onToolStatus?.({
                status: "done",
                tool: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
                query: target,
                callId: call.id,
                targetTime: historicalTargetTime,
                resultCount: frames.length,
                expectedCount: Array.isArray(captureResult) ? 3 : 1,
                frames
              });
            }
            frames.forEach((frame, index) => {
              const time = times[index];
              frameMessages.push({
                role: "user",
                content: isHistoricalFrame
                  ? Array.isArray(captureResult)
                    ? `以下是 ${call.function.name} 工具截取的第 ${index + 1} 张，实际截图时间 ${time}；目标时间点 ${target}。图片按时间顺序排列，请结合画面回答用户的问题，不要将实际截图时间误述为目标时间点。`
                    : `以下是 ${call.function.name} 工具截取的视频画面，实际截图时间 ${time}；目标时间点 ${target}。请结合画面回答用户的问题，不要将实际截图时间误述为目标时间点。`
                  : `以下是 ${call.function.name} 工具在 ${time} 截取的视频画面，请结合画面回答用户的问题。`,
                images: [frame.image]
              });
            });
          } catch (e) {
            if (isAbortedMarkerError(e) || isAbortNamedError(e) || signal?.aborted) {
              throw e;
            }
            const reason = String((e as { message?: unknown })?.message ?? e);
            toolContent = `截取视频画面失败：${reason}`;
            if (historicalStatusStarted) {
              onToolStatus?.({
                status: "failed",
                tool: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
                query: formatClock(historicalTargetTime, { hours: "auto" }),
                callId: call.id,
                targetTime: historicalTargetTime
              });
            }
            onNotice?.(toolContent);
          }
        }
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
        continue;
      }

      if (call.function.name === FETCH_HOT_COMMENTS_TOOL_NAME) {
        hotCommentsUsed = true;
        let toolContent = "当前对话没有可获取的视频评论。";
        if (fetchHotComments) {
          try {
            toolContent = serializeHotComments(await fetchHotComments());
          } catch (e) {
            if (isAbortedMarkerError(e) || isAbortNamedError(e) || signal?.aborted) {
              throw e;
            }
            const reason = String((e as { message?: unknown })?.message ?? e);
            toolContent = `获取热门评论失败：${reason}`;
            onNotice?.(toolContent);
          }
        }
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
        continue;
      }

      const query = parseToolArgs(call.function.arguments).query;
      onToolStatus?.({ status: "searching", query, callId: call.id });
      let toolContent: string;
      try {
        const outcome = await executeSearch(query);
        toolContent = serializeSearchResults(outcome.results);
        if (outcome.downgradedFrom) {
          toolContent = `注：首选 ${outcome.downgradedFrom} 未成功，以下结果来自 ${outcome.platform}。\n${toolContent}`;
        }
        onToolStatus?.({
          status: "done",
          query,
          callId: call.id,
          resultCount: outcome.results.length,
          platform: outcome.platform,
          sources: outcome.results,
          ...(outcome.paid ? { paid: true } : {}),
          ...(outcome.paidFallback ? { paidFallbackNotice: formatPaidFallbackNotice(outcome.paidFallback) } : {})
        });
      } catch (e) {
        if (isAbortedMarkerError(e) || isAbortNamedError(e) || signal?.aborted) {
          throw e;
        }
        const reason = String((e as { message?: unknown })?.message ?? e);
        toolContent = `搜索失败：${reason}`;
        onToolStatus?.({ status: "failed", query, callId: call.id });
        onNotice?.(
          (e as { searchFailureClass?: unknown })?.searchFailureClass === "quota"
            ? reason
            : `联网搜索失败：${reason}`
        );
      }
      toolMessages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
    }
    messages.push(assistantMessage, ...toolMessages, ...frameMessages);
    toolCallCount += toolCalls.filter((call) =>
      call.function.name !== CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME &&
      call.function.name !== CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME &&
      call.function.name !== FETCH_HOT_COMMENTS_TOOL_NAME
    ).length;

    onToolTurn?.([
      assistantMessage,
      ...toolMessages.map((m) => ({ ...m, content: m.content.slice(0, TOOL_MESSAGE_MAX_CHARS) }))
    ]);

    if (includeWebSearchTool && toolCallCount >= maxToolCalls && !quotaNoticeInjected) {
      messages.push({
        role: "system",
        content: `本轮的搜索次数已达上限（${maxToolCalls} 次），请基于已有搜索结果作答。`
      });
      quotaNoticeInjected = true;
    }
  }
}
