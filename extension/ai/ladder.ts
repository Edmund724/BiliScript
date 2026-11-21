import { streamChat as _streamChat } from "./client.js";
import { buildBudgetPlan as _buildBudgetPlan } from "./budgeter.js";
import { orchestrateMapReduce as _orchestrateMapReduce } from "./map-reduce.js";
import { resolveFollowupContext as _resolveFollowupContext, trimRecentTurns as _trimRecentTurns } from "./followup-context.js";
import { buildCostGuardNotice as _buildCostGuardNotice, runCostGuard } from "./cost-guard.js";
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
import { formatClock } from "../shared/clock-text.js";
import { isAbortedMarkerError, isAbortNamedError } from "../shared/error-helpers.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import type { CaptureCurrentVideoFrame, CapturedVideoFrame, ChatMessage, ImagePart, ProviderRequest } from "./types.js";
import type { FetchHotCommentsFn } from "./tool-loop.js";

export interface ChatContext {
  subtitleBody?: unknown[];
  chapters?: unknown[];
  [key: string]: unknown;
}

export interface ChatMsg {
  context?: ChatContext;
  history?: ChatMessage[];
  prompt?: string;
  thinkingLevel?: ThinkingLevelInput;
  images?: unknown;
  [key: string]: unknown;
}

export interface ChatProvider {
  id?: string;
  apiKey?: string;
  baseUrl?: unknown;
  model?: unknown;
  [key: string]: unknown;
}

export interface ChatPort {
  postMessage(message: unknown): void;
}

export type BudgetPlan = Pick<import("./types.js").BudgetPlan, "mode"> &
  Partial<Pick<import("./types.js").BudgetPlan, "estimatedCalls" | "estimatedTokens" | "totalChars">>;

export interface WebSearchRuntime {
  maxToolCalls: number;
  executeSearch: (query: string) => Promise<{ results: unknown[]; platform: string }>;
}

export interface StreamChatArgs {
  provider: ChatProvider;
  context: ChatContext;
  userPrompt: string;
  history: ChatMessage[];
  userImages?: ImagePart[];
  thinkingLevel?: ThinkingLevelInput;
  port: ChatPort;
  signal: AbortSignal | null;
  onActivity?: () => void;
  webSearch?: WebSearchRuntime;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  fetchHotComments?: FetchHotCommentsFn;
}

export type StreamChatFn = (args: StreamChatArgs) => Promise<unknown>;

export interface OrchestrateMapReduceArgs {
  provider: ChatProvider;
  context: ChatContext;
  plan: BudgetPlan | null;
  port: ChatPort;
  signal: AbortSignal | null;
  thinkingLevel?: ThinkingLevelInput;
  onProgress: (notice: string) => void;
}

export type OrchestrateMapReduceFn = (args: OrchestrateMapReduceArgs) => Promise<unknown>;

export interface ResolveFollowupContextArgs {
  context: ChatContext;
  plan: BudgetPlan;
  history: ChatMessage[];
}

export type ResolveFollowupContextFn = (args: ResolveFollowupContextArgs) => Promise<ChatContext | null>;

type BuildBudgetPlanFn = (args: { body: unknown[]; chapters: unknown[] }) => BudgetPlan;

interface CostGuardNotice {
  shouldPrompt: boolean;
  message: string;
}

type BuildCostGuardNoticeFn = (args: { estimatedCalls?: number; estimatedTokens?: number }) => CostGuardNotice;

export type TrimRecentTurnsFn = (history?: ChatMessage[]) => ChatMessage[];

export interface RunLadderChatArgs {
  msg: ChatMsg;
  provider: ChatProvider;
  port: ChatPort;
  signal: AbortSignal | null;
  webSearch?: WebSearchRuntime;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  fetchHotComments?: FetchHotCommentsFn;
}

export interface RunLadderChatDeps {
  streamChat?: StreamChatFn;
  orchestrateMapReduce?: OrchestrateMapReduceFn;
  resolveFollowupContext?: ResolveFollowupContextFn;
  buildBudgetPlan?: BuildBudgetPlanFn;
  buildCostGuardNotice?: BuildCostGuardNoticeFn;
  trimRecentTurns?: TrimRecentTurnsFn;
  askCostGuard: (port: ChatPort, message: string) => Promise<unknown>;
  onActivity?: () => void;
  pauseIdleTimeout?: () => void;
  acquireSwKeepalive?: () => SwKeepaliveHandle | null;
  loadL1Index?: (context: ChatContext) => Promise<L1VideoIndexCacheRecord | null>;
  routeChatCompletion?: typeof ChatCompletionFn;
  routerTimeoutMs?: number;
}

function defaultLoadL1Index(context: ChatContext): Promise<L1VideoIndexCacheRecord | null> {
  if (context?.l1Index && typeof context.l1Index === "object") {
    return Promise.resolve(context.l1Index as L1VideoIndexCacheRecord);
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
  const streamChat: StreamChatFn = deps.streamChat ?? (_streamChat as unknown as StreamChatFn);
  const orchestrateMapReduce: OrchestrateMapReduceFn = deps.orchestrateMapReduce ?? (_orchestrateMapReduce as unknown as OrchestrateMapReduceFn);
  const resolveFollowupContext: ResolveFollowupContextFn = deps.resolveFollowupContext ?? (_resolveFollowupContext as unknown as ResolveFollowupContextFn);
  const buildBudgetPlan: BuildBudgetPlanFn = deps.buildBudgetPlan ?? _buildBudgetPlan;
  const buildCostGuardNotice: BuildCostGuardNoticeFn = deps.buildCostGuardNotice ?? _buildCostGuardNotice;
  const trimRecentTurns: TrimRecentTurnsFn = deps.trimRecentTurns ?? (_trimRecentTurns as unknown as TrimRecentTurnsFn);
  const loadL1Index = deps.loadL1Index ?? defaultLoadL1Index;
  const { askCostGuard, onActivity, pauseIdleTimeout } = deps;

  const keepalive = (deps.acquireSwKeepalive ?? _acquireSwKeepalive)();
  try {
    const plan = buildBudgetPlan({
      body: Array.isArray(msg.context?.subtitleBody) ? msg.context.subtitleBody : [],
      chapters: Array.isArray(msg.context?.chapters) ? msg.context.chapters : []
    });
    const userImages = normalizeImageParts(msg.images);
    const l0Lines = normalizeL0SubtitleLines(
      Array.isArray(msg.context?.subtitleBody)
        ? (msg.context.subtitleBody as Array<{ from?: unknown; to?: unknown; content?: unknown }>)
        : []
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
        provider: provider as ProviderRequest,
        signal,
        routeChatCompletion: deps.routeChatCompletion,
        routerTimeoutMs: deps.routerTimeoutMs
      });
      const visual = await preCaptureVisualFramesIfNeeded({
        userPrompt,
        coreTimestamp: resolution.coreTimestamp,
        captureCurrentVideoFrame,
        userImages,
        port,
        signal,
        onActivity
      });
      const hybridContext: ChatContext = {
        ...args.baseContext,
        hybridRetrievalMarkdown: resolution.hybridRetrievalMarkdown,
        ...(visual.frameContextNote ? { frameContextNote: visual.frameContextNote } : {}),
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
          fetchHotComments
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
        chapters: Array.isArray(msg.context?.chapters)
          ? (msg.context.chapters as Array<{ title?: unknown; from?: unknown; to?: unknown }>)
          : []
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
        buildNotice: buildCostGuardNotice,
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
        captureCurrentVideoFrame,
        fetchHotComments
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
