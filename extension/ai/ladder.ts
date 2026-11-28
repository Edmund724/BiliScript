import { streamChat as _streamChat } from "./client.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { orchestrateMapReduce as _orchestrateMapReduce } from "./map-reduce.js";
import { resolveFollowupContext as _resolveFollowupContext, trimRecentTurns as _trimRecentTurns } from "./followup-context.js";
import { runCostGuard } from "./cost-guard.js";
import { acquireSwKeepalive as _acquireSwKeepalive, type SwKeepaliveHandle } from "./sw-keepalive.js";
import { estimateTokensFromChars } from "./usage-stats.js";
import { normalizeImageParts } from "./conversation.js";
import { loadL1IndexViaProxy } from "./segment-cache-proxy.js";
import { normalizeL0SubtitleLines } from "./l0-bm25.js";
import {
  detectInteractionAnchorPlan,
  doesPromptNeedVisualFrame,
  isLongVideoForHybridChat,
  resolveLongVideoHybridContext,
  type InteractionAnchorHint
} from "./chat-hybrid-retrieval.js";
import type { chatCompletion as ChatCompletionFn } from "./completion.js";
import type { ChatPort } from "../chat/protocol.js";
import type { WebSearchRuntime } from "../search/search-runtime.js";
import { formatClock } from "../shared/clock-text.js";
import { isAbortedMarkerError, isAbortNamedError } from "../shared/error-helpers.js";
import { detectSiteFromUrl, getSiteCapabilities, normalizeSiteId } from "../shared/site.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import type {
  AiContext,
  AiProvider,
  BudgetPlan,
  CaptureCurrentVideoFrame,
  CapturedVideoFrame,
  ChatMessage,
  ImagePart
} from "./types.js";
import type { FetchHotCommentsFn } from "./tool-loop.js";

export type ChatContext = AiContext;

export interface ChatMsg {
  context?: AiContext;
  history?: ChatMessage[];
  prompt?: string;
  thinkingLevel?: ThinkingLevelInput;
  images?: unknown;
  [key: string]: unknown;
}

export type ChatProvider = AiProvider;
export type { ChatPort, BudgetPlan, WebSearchRuntime };

export type StreamChatFn = typeof _streamChat;
export type StreamChatArgs = Parameters<typeof _streamChat>[0];
export type OrchestrateMapReduceFn = typeof _orchestrateMapReduce;
export type ResolveFollowupContextFn = typeof _resolveFollowupContext;
export type TrimRecentTurnsFn = typeof _trimRecentTurns;

export interface RunLadderChatArgs {
  msg: ChatMsg;
  provider: AiProvider;
  port: ChatPort;
  signal: AbortSignal | null;
  webSearch?: WebSearchRuntime;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  fetchHotComments?: FetchHotCommentsFn;
}

export interface RunLadderChatDeps {
  streamChat?: typeof _streamChat;
  orchestrateMapReduce?: typeof _orchestrateMapReduce;
  resolveFollowupContext?: typeof _resolveFollowupContext;
  buildBudgetPlan?: typeof _buildBudgetPlan;
  trimRecentTurns?: typeof _trimRecentTurns;
  askCostGuard: (port: ChatPort, message: string) => Promise<unknown>;
  onActivity?: () => void;
  pauseIdleTimeout?: () => void;
  acquireSwKeepalive?: () => SwKeepaliveHandle | null;
  loadL1Index?: (context: AiContext) => Promise<L1VideoIndexCacheRecord | null>;
  routeChatCompletion?: typeof ChatCompletionFn;
  routerTimeoutMs?: number;
}

function defaultLoadL1Index(context: AiContext): Promise<L1VideoIndexCacheRecord | null> {
  if (context?.l1Index && typeof context.l1Index === "object") {
    return Promise.resolve(context.l1Index);
  }
  if (!context?.bvid || !context?.cid) {
    return Promise.resolve(null);
  }
  return loadL1IndexViaProxy({ context }).catch(() => null);
}

function asInteractionAnchorHint(raw: unknown): InteractionAnchorHint | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.kind !== "explain-selection") {
    return null;
  }
  const from = Number(obj.from);
  if (!Number.isFinite(from) || from < 0) {
    return null;
  }
  return {
    kind: "explain-selection",
    from,
    ...(typeof obj.lineContent === "string" ? { lineContent: obj.lineContent } : {}),
    ...(typeof obj.selection === "string" ? { selection: obj.selection } : {})
  };
}

async function preCaptureVisualFramesIfNeeded(input: {
  userPrompt: string;
  coreTimestamp?: number;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  userImages?: ImagePart[];
  port: ChatPort;
  signal: AbortSignal | null;
  onActivity?: () => void;
}): Promise<{
  finalUserImages?: ImagePart[];
  frameContextNote?: string;
  remainingCaptureFn?: CaptureCurrentVideoFrame;
}> {
  const { userPrompt, coreTimestamp, captureCurrentVideoFrame, userImages, port, signal, onActivity } = input;
  if (
    !captureCurrentVideoFrame ||
    coreTimestamp === undefined ||
    !Number.isFinite(coreTimestamp) ||
    coreTimestamp < 0 ||
    !doesPromptNeedVisualFrame(userPrompt)
  ) {
    return { finalUserImages: userImages, remainingCaptureFn: captureCurrentVideoFrame };
  }

  const targetTime = Math.floor(coreTimestamp);
  const query = formatClock(targetTime, { hours: "auto" });
  const callId = `hybrid-frame-${Date.now()}`;
  onActivity?.();
  port.postMessage({
    type: "tool-status",
    status: "searching",
    tool: "capture_video_frame_at_time",
    query,
    callId,
    targetTime,
    generation: 0
  });

  try {
    const rawResult = await captureCurrentVideoFrame(targetTime, signal ?? undefined);
    const frames: CapturedVideoFrame[] = (Array.isArray(rawResult) ? rawResult : [rawResult]).slice(0, 3);
    if (frames.length === 0) {
      throw new Error("未截取到有效画面");
    }
    onActivity?.();
    port.postMessage({
      type: "tool-status",
      status: "done",
      tool: "capture_video_frame_at_time",
      query,
      callId,
      targetTime,
      resultCount: frames.length,
      expectedCount: Array.isArray(rawResult) ? 3 : 1,
      frames,
      generation: 0
    });
    const actualTimes = frames.map((f) => formatClock(f.currentTime, { hours: "auto" })).join("、");
    const frameImages = frames.map((f) => f.image);
    const mergedImages = [...(userImages ?? []), ...frameImages].slice(0, 4);
    const frameContextNote = `[已联动视频关键帧采样：目标时间点 ${query}，实际截图时间依次为 ${actualTimes}。图片已附带在当前消息中，请结合画面与字幕作答，不要将实际截图时间误述为目标时间点。]`;
    return {
      finalUserImages: mergedImages.length > 0 ? mergedImages : undefined,
      frameContextNote,
      remainingCaptureFn: undefined
    };
  } catch (e) {
    if (isAbortedMarkerError(e) || isAbortNamedError(e) || signal?.aborted) {
      throw e;
    }
    onActivity?.();
    port.postMessage({
      type: "tool-status",
      status: "failed",
      tool: "capture_video_frame_at_time",
      query,
      callId,
      targetTime,
      generation: 0
    });
    return {
      finalUserImages: userImages,
      remainingCaptureFn: undefined
    };
  }
}

export async function runLadderChat(
  { msg, provider, port, signal, webSearch, captureCurrentVideoFrame, fetchHotComments }: RunLadderChatArgs,
  deps: RunLadderChatDeps
): Promise<void> {
  const streamChat = deps.streamChat ?? _streamChat;
  const orchestrateMapReduce = deps.orchestrateMapReduce ?? _orchestrateMapReduce;
  const resolveFollowupContext = deps.resolveFollowupContext ?? _resolveFollowupContext;
  const buildBudgetPlan = deps.buildBudgetPlan ?? _buildBudgetPlan;
  const trimRecentTurns = deps.trimRecentTurns ?? _trimRecentTurns;
  const loadL1Index = deps.loadL1Index ?? defaultLoadL1Index;
  const { askCostGuard, onActivity, pauseIdleTimeout } = deps;

  const keepalive = (deps.acquireSwKeepalive ?? _acquireSwKeepalive)();
  try {
    const site = normalizeSiteId(
      msg.context?.site ?? (msg.context?.url ? detectSiteFromUrl(msg.context.url) : undefined)
    );
    const capabilities = getSiteCapabilities(site);
    const effectiveCaptureFrame = capabilities.supportsCurrentFrameCapture ? captureCurrentVideoFrame : undefined;
    const effectiveFetchHotComments = capabilities.supportsHotComments ? fetchHotComments : undefined;

    const plan = buildBudgetPlan({
      body: Array.isArray(msg.context?.subtitleBody) ? msg.context.subtitleBody : [],
      chapters: Array.isArray(msg.context?.chapters) ? msg.context.chapters : []
    });
    const userImages = normalizeImageParts(msg.images);
    const l0Lines = normalizeL0SubtitleLines(
      Array.isArray(msg.context?.subtitleBody) ? msg.context.subtitleBody : []
    );
    const isLongVideo = plan.mode === "map-reduce" || isLongVideoForHybridChat(l0Lines, msg.context);
    const interactionAnchor = asInteractionAnchorHint(msg.interactionAnchor);
    const playbackCursorSeconds =
      typeof msg.playbackCursorSeconds === "number" && Number.isFinite(msg.playbackCursorSeconds) && msg.playbackCursorSeconds >= 0
        ? msg.playbackCursorSeconds
        : undefined;
    const rawHistory = Array.isArray(msg.history) ? msg.history : [];
    const userPrompt = msg.prompt || "";

    const runHybridStreamTurn = async (args: {
      baseContext: ChatContext;
      l1Index: L1VideoIndexCacheRecord | null;
      compressedSummaryMarkdown?: string;
    }) => {
      const resolution = await resolveLongVideoHybridContext({
        context: args.baseContext,
        userPrompt,
        history: rawHistory,
        l1Index: args.l1Index,
        compressedSummaryMarkdown: args.compressedSummaryMarkdown,
        interactionAnchor,
        playbackCursorSeconds,
        provider,
        signal,
        routeChatCompletion: deps.routeChatCompletion,
        routerTimeoutMs: deps.routerTimeoutMs
      });
      const visual = capabilities.supportsHistoricalFrameCapture
        ? await preCaptureVisualFramesIfNeeded({
            userPrompt,
            coreTimestamp: resolution.coreTimestamp,
            captureCurrentVideoFrame: effectiveCaptureFrame,
            userImages,
            port,
            signal,
            onActivity
          })
        : {
            finalUserImages: userImages,
            frameContextNote: undefined,
            remainingCaptureFn: effectiveCaptureFrame
          };
      const resolvedContextSite = args.baseContext.site ?? msg.context?.site;
      const hybridContext: ChatContext = {
        ...args.baseContext,
        ...(resolvedContextSite !== undefined ? { site: resolvedContextSite } : {}),
        ...(resolution.staticDirectoryMarkdown ? { staticDirectoryMarkdown: resolution.staticDirectoryMarkdown } : {}),
        hybridRetrievalMarkdown: resolution.hybridRetrievalMarkdown,
        ...(visual.frameContextNote ? { frameContextNote: visual.frameContextNote } : {}),
        ...(resolution.hybridRetrievalMarkdown ? { compressedSummaryMarkdown: undefined } : {}),
        subtitleBody: []
      };
      const trimmedHistory = trimRecentTurns(rawHistory);
      try {
        await streamChat({
          provider,
          context: hybridContext,
          userPrompt,
          history: trimmedHistory,
          userImages: visual.finalUserImages,
          thinkingLevel: msg.thinkingLevel,
          port,
          signal,
          onActivity,
          webSearch,
          captureCurrentVideoFrame: visual.remainingCaptureFn,
          fetchHotComments: effectiveFetchHotComments
        });
      } catch (e) {
        if (!(e as { overflow?: boolean }).overflow) {
          throw e;
        }
        port.postMessage({ type: "error", error: "追问内容仍超出上下文预算，请换个更具体的问题重试" });
      }
    };

    if (isLongVideo && l0Lines.length > 0) {
      const fastPathPlan = detectInteractionAnchorPlan({
        userPrompt,
        interactionAnchor,
        playbackCursorSeconds,
        chapters: Array.isArray(msg.context?.chapters) ? msg.context.chapters : []
      });
      if (fastPathPlan) {
        const l1Index = await loadL1Index(msg.context || {}).catch(() => null);
        await runHybridStreamTurn({
          baseContext: msg.context || {},
          l1Index
        });
        return;
      }
    }

    if (plan.mode === "map-reduce") {
      if (l0Lines.length > 0) {
        const [l1Index, followupContext] = await Promise.all([
          loadL1Index(msg.context || {}).catch(() => null),
          rawHistory.length > 0
            ? resolveFollowupContext({
                context: msg.context || {},
                plan,
                history: rawHistory
              })
            : Promise.resolve(null)
        ]);
        if (l1Index || followupContext) {
          await runHybridStreamTurn({
            baseContext: followupContext ?? (msg.context || {}),
            l1Index,
            compressedSummaryMarkdown: followupContext
              ? String(followupContext.compressedSummaryMarkdown || "")
              : ""
          });
          return;
        }
      }

      const declined = await runCostGuard({
        estimatedCalls: plan.estimatedCalls,
        estimatedTokens: estimateTokensFromChars(provider, plan.totalChars),
        taskLabel: "当前视频较长，进行「AI 对话」全片分析",
        ask: async (message) => {
          pauseIdleTimeout?.();
          return askCostGuard(port, message);
        },
        onDecline: () => {
          port.postMessage({ type: "stopped", reason: "已取消" });
        }
      });
      if (declined) {
        return;
      }

      pauseIdleTimeout?.();
      if (webSearch) {
        port.postMessage({ type: "notice", data: "超长内容归约中，本轮不联网" });
      }
      await orchestrateMapReduce({
        provider,
        context: msg.context || {},
        plan,
        port,
        signal,
        thinkingLevel: msg.thinkingLevel,
        onProgress: function (notice: string) {
          port.postMessage({ type: "notice", data: notice });
        }
      });
      return;
    }

    if (isLongVideo && l0Lines.length > 0) {
      const l1Index = await loadL1Index(msg.context || {}).catch(() => null);
      if (l1Index) {
        await runHybridStreamTurn({
          baseContext: msg.context || {},
          l1Index
        });
        return;
      }
    }

    try {
      await streamChat({
        provider,
        context: msg.context || {},
        userPrompt,
        history: rawHistory,
        userImages,
        thinkingLevel: msg.thinkingLevel,
        port,
        signal,
        onActivity,
        webSearch,
        captureCurrentVideoFrame: effectiveCaptureFrame,
        fetchHotComments: effectiveFetchHotComments
      });
    } catch (e) {
      if (!(e as { overflow?: boolean }).overflow) {
        throw e;
      }
      pauseIdleTimeout?.();
      if (webSearch) {
        port.postMessage({ type: "notice", data: "超长内容归约中，本轮不联网" });
      }
      await orchestrateMapReduce({
        provider,
        context: msg.context || {},
        plan: null,
        port,
        signal,
        thinkingLevel: msg.thinkingLevel,
        onProgress: function (notice: string) {
          port.postMessage({ type: "notice", data: notice });
        }
      });
    }
  } finally {
    keepalive?.release();
  }
}
