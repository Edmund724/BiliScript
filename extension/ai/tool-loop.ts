import {
  chatCompletion,
  type ChatCompletionInput,
  type ChatCompletionResult,
  type ChatCompletionStreamResult
} from "./completion.js";
import { parseToolArgs } from "./adapters/openai.js";
import type { ChatToolDefinition } from "./protocol-adapter.js";
import type { HistoricalFrameRequestSpec } from "../chat/historical-video-frame.js";
import type { CaptureCurrentVideoFrame, CapturedVideoFrame, ChatMessage, ProviderRequest, StreamChatEvent } from "./types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import { isAbortedMarkerError, isAbortNamedError } from "../shared/error-helpers.js";
import { formatClock } from "../shared/clock-text.js";
import type { NormalizedSearchResult } from "../search/adapters/types.js";
import { formatPaidFallbackNotice, type PaidSearchFallback } from "../search/search-chain.js";

export const MAX_CAPTURED_FRAMES_PER_TURN = 6;
export const MAX_FRAME_TOOL_CALLS_PER_TURN = 2;
export const MAX_HISTORICAL_SPAN_SECONDS = 8;
const FRAME_DEDUP_EPSILON_SEC = 0.25;

export interface ParsedHistoricalFrameArgs {
  times: number[];
  spanSeconds: number;
}

interface PlannedFrameTarget {
  anchorTime: number;
  targetTime: number;
}

export function parseHistoricalFrameArgs(rawArguments: string): ParsedHistoricalFrameArgs {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawArguments);
  } catch {
    throw new Error("历史截帧参数必须是合法 JSON 对象");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("历史截帧参数必须是合法 JSON 对象");
  }
  const record = parsed as Record<string, unknown>;
  if (record.times !== undefined) {
    if (!Array.isArray(record.times) || record.times.length === 0) {
      throw new Error("times 必须是非空的时间点数组");
    }
    const times: number[] = [];
    for (const item of record.times) {
      if (typeof item !== "number" || !Number.isFinite(item) || item < 0) {
        throw new Error("times 中的每个时间点必须是大于或等于 0 的有限秒数");
      }
      times.push(item);
    }
    const spanSeconds = record.spanSeconds === undefined ? 0 : record.spanSeconds;
    if (
      typeof spanSeconds !== "number" ||
      !Number.isFinite(spanSeconds) ||
      spanSeconds < 0 ||
      spanSeconds > MAX_HISTORICAL_SPAN_SECONDS
    ) {
      throw new Error(`spanSeconds 必须是 0 到 ${MAX_HISTORICAL_SPAN_SECONDS} 之间的有限秒数`);
    }
    return { times, spanSeconds };
  }
  if (record.targetTime !== undefined) {
    const targetTime = record.targetTime;
    if (typeof targetTime !== "number" || !Number.isFinite(targetTime) || targetTime < 0) {
      throw new Error("targetTime 必须是大于或等于 0 的有限秒数");
    }
    return { times: [targetTime], spanSeconds: 0 };
  }
  throw new Error("times 必须是非空的时间点数组");
}

function planHistoricalTargets(
  times: readonly number[],
  spanSeconds: number,
  maxFrames: number
): { targets: PlannedFrameTarget[]; truncatedTargets: PlannedFrameTarget[] } {
  const expanded: Array<PlannedFrameTarget & { isCenter: boolean }> = [];
  for (const anchorTime of times) {
    if (spanSeconds > 0) {
      expanded.push({ anchorTime, targetTime: Math.max(0, anchorTime - spanSeconds), isCenter: false });
      expanded.push({ anchorTime, targetTime: anchorTime, isCenter: true });
      expanded.push({ anchorTime, targetTime: anchorTime + spanSeconds, isCenter: false });
    } else {
      expanded.push({ anchorTime, targetTime: anchorTime, isCenter: true });
    }
  }
  expanded.sort((a, b) => {
    if (a.targetTime !== b.targetTime) return a.targetTime - b.targetTime;
    if (a.isCenter !== b.isCenter) return a.isCenter ? -1 : 1;
    return a.anchorTime - b.anchorTime;
  });
  const deduped: Array<PlannedFrameTarget & { isCenter: boolean }> = [];
  for (const item of expanded) {
    const last = deduped[deduped.length - 1];
    if (last && item.targetTime - last.targetTime < FRAME_DEDUP_EPSILON_SEC) {
      if (!last.isCenter && item.isCenter) {
        deduped[deduped.length - 1] = item;
      }
      continue;
    }
    deduped.push(item);
  }
  const allTargets = deduped.map(({ anchorTime, targetTime }) => ({ anchorTime, targetTime }));
  const limit = Math.max(0, Math.floor(maxFrames));
  if (allTargets.length > limit) {
    return {
      targets: allTargets.slice(0, limit),
      truncatedTargets: allTargets.slice(limit)
    };
  }
  return { targets: allTargets, truncatedTargets: [] };
}

function formatSecondsText(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : Number(seconds.toFixed(2)).toString();
}

function formatHistoricalStatusQuery(times: readonly number[], spanSeconds: number): string {
  const formatted = times.map((t) => formatClock(t, { hours: "auto" }));
  if (times.length > 3) {
    return `${formatted[0]}、${formatted[1]} 等 ${times.length} 处`;
  }
  if (times.length === 1 && spanSeconds > 0) {
    return `${formatted[0]} (±${formatSecondsText(spanSeconds)}s)`;
  }
  return formatted.join("、");
}

export const CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME = "capture_current_video_frame";
export const CAPTURE_CURRENT_VIDEO_FRAME_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: CAPTURE_CURRENT_VIDEO_FRAME_TOOL_NAME,
    description: "截取当前视频播放位置的一帧画面。只有当回答必须依赖当前可见画面、图表、代码或操作界面时调用；不要用于回顾其他时间点。与历史截帧工具共享每轮最多 2 次调用、总计 6 帧预算。",
    parameters: { type: "object", properties: {} }
  }
};

export const CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME = "capture_video_frame_at_time";
export const CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL: ChatToolDefinition = {
  type: "function",
  function: {
    name: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
    description: "当字幕不足以回答一个或多个历史时间点的问题，且当时的画面、图表、代码或操作界面可能有帮助时，按时间点数组 times（1 到 6 个非负秒数）自主截取对应画面。默认 spanSeconds 为 0（每个时间点精确截取 1 帧）；仅当需要查看动作变化或口播滞后区间时设置 spanSeconds（0 到 8 秒），为每个时间点补充 [t-s, t, t+s]。times 必须来自字幕或用户问题，不要猜测。不会改变用户播放器。与当前帧工具共享每轮最多 2 次调用、总计 6 帧预算。",
    parameters: {
      type: "object",
      properties: {
        times: {
          type: "array",
          items: { type: "number", minimum: 0 },
          minItems: 1,
          maxItems: MAX_CAPTURED_FRAMES_PER_TURN,
          description: "目标视频时间点列表，单位为秒（非负），支持 1 到 6 个时间点"
        },
        spanSeconds: {
          type: "number",
          minimum: 0,
          maximum: MAX_HISTORICAL_SPAN_SECONDS,
          description: "可选邻域跨度（单位：秒，范围 0 到 8，默认 0）；设为正数时额外截取前后偏移帧"
        }
      },
      required: ["times"]
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
  targetTimes?: number[];
  spanSeconds?: number;
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
  initialFramesUsed?: number;
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
    initialFramesUsed,
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

  const initialFrameTools = captureCurrentVideoFrame
    ? includeHistoricalFrameTool
      ? [CAPTURE_CURRENT_VIDEO_FRAME_TOOL, CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL]
      : [CAPTURE_CURRENT_VIDEO_FRAME_TOOL]
    : [];
  const initialTools: ChatToolDefinition[] = [
    ...(includeWebSearchTool && maxToolCalls > 0 ? [toolDefinition] : []),
    ...initialFrameTools,
    ...(fetchHotComments ? [FETCH_HOT_COMMENTS_TOOL] : [])
  ];

  let toolCallCount = 0;
  let retriedWithoutTools = false;
  let framesUsed = Math.max(
    0,
    Math.min(MAX_CAPTURED_FRAMES_PER_TURN, Math.floor(Number(initialFramesUsed) || 0))
  );
  let frameCallsUsed = 0;
  let hotCommentsUsed = false;
  let finalText = "";

  while (true) {
    const tools = retriedWithoutTools ? [] : initialTools;
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
        const remainingFrames = MAX_CAPTURED_FRAMES_PER_TURN - framesUsed;
        let toolContent: string;
        if (!captureCurrentVideoFrame) {
          toolContent = "本轮未启用视频截图工具，请基于已有内容作答。";
        } else if (frameCallsUsed >= MAX_FRAME_TOOL_CALLS_PER_TURN) {
          toolContent = `本轮视频截图工具调用次数已达上限（${MAX_FRAME_TOOL_CALLS_PER_TURN} 次），请基于已有画面作答。`;
        } else if (remainingFrames <= 0) {
          toolContent = `本轮视频截图帧数已达上限（${MAX_CAPTURED_FRAMES_PER_TURN} 帧），请基于已有画面作答。`;
        } else {
          let historicalStatusStarted = false;
          let parsedHistorical: ParsedHistoricalFrameArgs | undefined;
          let historicalQuery = "";
          try {
            let planned: { targets: PlannedFrameTarget[]; truncatedTargets: PlannedFrameTarget[] } | undefined;
            if (isHistoricalFrame) {
              parsedHistorical = parseHistoricalFrameArgs(call.function.arguments);
              planned = planHistoricalTargets(parsedHistorical.times, parsedHistorical.spanSeconds, remainingFrames);
              historicalQuery = formatHistoricalStatusQuery(parsedHistorical.times, parsedHistorical.spanSeconds);
              historicalStatusStarted = true;
              onToolStatus?.({
                status: "searching",
                tool: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
                query: historicalQuery,
                callId: call.id,
                targetTime: parsedHistorical.times[0],
                targetTimes: [...parsedHistorical.times],
                ...(parsedHistorical.spanSeconds > 0 ? { spanSeconds: parsedHistorical.spanSeconds } : {})
              });
            }
            frameCallsUsed += 1;
            const requestSpec: HistoricalFrameRequestSpec | undefined = parsedHistorical
              ? {
                  times: parsedHistorical.times,
                  spanSeconds: parsedHistorical.spanSeconds,
                  maxFrames: remainingFrames
                }
              : undefined;
            const captureResult = isHistoricalFrame
              ? await captureCurrentVideoFrame(requestSpec)
              : await captureCurrentVideoFrame();
            const frameLimit = isHistoricalFrame ? remainingFrames : 1;
            const frames = (Array.isArray(captureResult) ? captureResult : [captureResult]).slice(0, frameLimit);
            if (!frames.length) {
              throw new Error("目标时间点均未截取成功");
            }
            framesUsed += frames.length;
            const actualClocks = frames.map((frame) => formatClock(frame.currentTime, { hours: "auto" }));
            if (isHistoricalFrame && parsedHistorical && planned) {
              const completedTargetClocks = planned.targets.map((item) =>
                formatClock(item.targetTime, { hours: "auto" })
              );
              const truncatedTargetClocks = planned.truncatedTargets.map((item) =>
                formatClock(item.targetTime, { hours: "auto" })
              );
              const baseSummary =
                frames.length >= planned.targets.length
                  ? `已截取目标时间点 ${completedTargetClocks.join("、")} 共 ${frames.length} 张画面，实际时间依次为 ${actualClocks.join("、")}。`
                  : `目标时间点 ${completedTargetClocks.join("、")} 仅成功截取 ${frames.length} 张画面，实际时间依次为 ${actualClocks.join("、")}；其余 ${planned.targets.length - frames.length} 张截取失败。`;
              const truncationNotice =
                truncatedTargetClocks.length > 0
                  ? `受本轮最多 ${MAX_CAPTURED_FRAMES_PER_TURN} 帧配额限制，未截取以下时间点：${truncatedTargetClocks.join("、")}。`
                  : "";
              toolContent = truncationNotice ? `${baseSummary}${truncationNotice}` : baseSummary;
              onToolStatus?.({
                status: "done",
                tool: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
                query: historicalQuery,
                callId: call.id,
                targetTime: parsedHistorical.times[0],
                targetTimes: [...parsedHistorical.times],
                ...(parsedHistorical.spanSeconds > 0 ? { spanSeconds: parsedHistorical.spanSeconds } : {}),
                resultCount: frames.length,
                expectedCount: planned.targets.length,
                frames
              });
              const itemLines = frames.map((frame, index) => {
                const actualClock = actualClocks[index];
                const fallbackTarget =
                  planned.targets[index]?.targetTime ??
                  parsedHistorical!.times[Math.min(index, parsedHistorical!.times.length - 1)];
                const targetSec = frame.targetTime ?? fallbackTarget;
                const anchorSec = frame.anchorTime ?? planned.targets[index]?.anchorTime ?? targetSec;
                const targetClock = formatClock(targetSec, { hours: "auto" });
                const anchorClock = formatClock(anchorSec, { hours: "auto" });
                const targetPart =
                  Math.abs(anchorSec - targetSec) > 1e-6
                    ? `锚点时间 ${anchorClock}（${formatSecondsText(anchorSec)}s），目标时间点 ${targetClock}（${formatSecondsText(targetSec)}s）`
                    : `目标时间点 ${targetClock}（${formatSecondsText(targetSec)}s）`;
                return `${index + 1}. 第 ${index + 1} 张：${targetPart}，实际截图时间 ${actualClock}（${formatSecondsText(frame.currentTime)}s）`;
              });
              frameMessages.push({
                role: "user",
                content: [
                  `以下是 ${call.function.name} 工具截取的 ${frames.length} 张视频画面（按时间顺序排列）：`,
                  ...itemLines,
                  "请结合画面回答用户的问题，不要将实际截图时间误述为目标时间点。"
                ].join("\n"),
                images: frames.map((frame) => frame.image)
              });
            } else {
              toolContent = `已截取视频在 ${actualClocks[0]} 的画面。`;
              frameMessages.push({
                role: "user",
                content: `以下是 ${call.function.name} 工具在 ${actualClocks[0]} 截取的视频画面，请结合画面回答用户的问题。`,
                images: [frames[0].image]
              });
            }
          } catch (e) {
            if (isAbortedMarkerError(e) || isAbortNamedError(e) || signal?.aborted) {
              throw e;
            }
            const reason = String((e as { message?: unknown })?.message ?? e);
            toolContent = `截取视频画面失败：${reason}`;
            if (historicalStatusStarted && parsedHistorical) {
              onToolStatus?.({
                status: "failed",
                tool: CAPTURE_HISTORICAL_VIDEO_FRAME_TOOL_NAME,
                query: historicalQuery,
                callId: call.id,
                targetTime: parsedHistorical.times[0],
                targetTimes: [...parsedHistorical.times],
                ...(parsedHistorical.spanSeconds > 0 ? { spanSeconds: parsedHistorical.spanSeconds } : {})
              });
            }
            onNotice?.(toolContent);
          }
        }
        toolMessages.push({ role: "tool", tool_call_id: call.id, content: toolContent });
        continue;
      }

      if (call.function.name === FETCH_HOT_COMMENTS_TOOL_NAME) {
        let toolContent: string;
        if (!fetchHotComments) {
          toolContent = "当前对话没有可获取的视频评论。";
        } else if (hotCommentsUsed) {
          toolContent = "本轮已获取过视频热门评论，请基于已有评论内容作答。";
        } else {
          hotCommentsUsed = true;
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

      if (!includeWebSearchTool) {
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "本轮未启用联网搜索，请基于已有内容作答。"
        });
        continue;
      }
      if (toolCallCount >= maxToolCalls) {
        toolMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: `本轮的搜索次数已达上限（${maxToolCalls} 次），请基于已有搜索结果作答。`
        });
        continue;
      }
      toolCallCount += 1;

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

    onToolTurn?.([
      assistantMessage,
      ...toolMessages.map((m) => ({ ...m, content: m.content.slice(0, TOOL_MESSAGE_MAX_CHARS) }))
    ]);
  }
}
