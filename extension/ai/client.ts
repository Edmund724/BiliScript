import { buildMessages } from "./context.js";
import { chatCompletion, validateProviderBasics } from "./completion.js";
import { runToolLoop, type FetchHotCommentsFn, type ToolStatusPayload, type ToolLoopSearchOutcome } from "./tool-loop.js";
import type { AiContext, AiProvider, CaptureCurrentVideoFrame, ImagePart, StreamChatEvent } from "./types.js";
import type { ChatPort, ChatPortMessage } from "../chat/protocol.js";
import type { ThinkingLevelInput } from "./thinking-levels.js";
import { TokenBatcher } from "./token-batcher.js";
import { isEmptyTextRetryable, retryBudget } from "./empty-text-retry.js";
import { isAbortedMarkerError } from "../shared/error-helpers.js";

export const TRUNCATED_NOTICE = "回答被截断（达到模型输出上限）";

interface StreamChatInput {
  provider: AiProvider;
  context?: AiContext | null;
  userPrompt?: string;
  history?: unknown[];
  userImages?: ImagePart[];
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  port: ChatPort;
  signal?: AbortSignal | null;
  onActivity?: () => void;
  thinkingLevel?: ThinkingLevelInput;
  webSearch?: { maxToolCalls: number; executeSearch: (query: string) => Promise<ToolLoopSearchOutcome> };
  fetchHotComments?: FetchHotCommentsFn;
}

export async function streamChat({ provider, context, userPrompt, history, userImages, captureCurrentVideoFrame, fetchHotComments, port, signal, onActivity, thinkingLevel, webSearch }: StreamChatInput): Promise<{ done: true } | undefined> {
  if (!port) return;

  try {
    validateProviderBasics(provider);
  } catch (error) {
    port.postMessage({ type: "error", error: (error as Error).message } satisfies ChatPortMessage);
    return;
  }

  const messages = buildMessages({
    context,
    userPrompt,
    history,
    images: userImages,
    systemPrompt: context?.aiSystemPrompt,
    includeToolHistory: Boolean(webSearch || fetchHotComments)
  });

  const tokenBatcher = new TokenBatcher({
    onFlush: (tokens) => {
      if (tokens.length === 1) {
        port.postMessage({ type: "token", data: tokens[0] } satisfies ChatPortMessage);
      } else {
        port.postMessage({ type: "token-batch", data: tokens } satisfies ChatPortMessage);
      }
    }
  });
  const flushTokens = () => tokenBatcher.flush();

  let lastFinishReason: string | null = null;
  let emittedNoText = true;
  const hasToolLoop = Boolean(webSearch || captureCurrentVideoFrame || fetchHotComments);
  let toolGeneration = 0;
  const emitStreamReset = () => {
    onActivity?.();
    flushTokens();
    toolGeneration += 1;
    port.postMessage({
      type: "stream-reset",
      ...(hasToolLoop ? { generation: toolGeneration } : {})
    } satisfies ChatPortMessage);
  };

  try {
    const streamCallbacks = {
      onEvent: (event: StreamChatEvent) => {
        onActivity?.();
        if (event.type === "token") {
          if (event.data.trim()) emittedNoText = false;
          tokenBatcher.push(event.data);
          return;
        }
        flushTokens();
        if (event.type === "tool-call") {
          return;
        }
        port.postMessage(event);
      },
      onStreamReset: emitStreamReset,
      onRetry: ({ attempt, maxRetries, kind, error }: { attempt: number; maxRetries: number; kind: string; error: Error }) => {
        if (kind === "stream") {
          return;
        }
        port.postMessage({
          type: "notice",
          data: kind === "http"
            ? `${error.message}，正在重试...`
            : `连接中断，正在重新连接（${attempt}/${maxRetries}）...`
        } satisfies ChatPortMessage);
      },
      onFinishReason: (reason: string | null) => {
        lastFinishReason = reason;
      }
    };

    const runTurn = (maxTokens?: number) => hasToolLoop
      ? runToolLoop({
          requestProfile: {
            provider,
            stream: true,
            signal,
            thinkingLevel,
            maxTokens,
            includeWebSearchTool: Boolean(webSearch),
            ...streamCallbacks
          },
          messages: messages.slice(),
          maxToolCalls: webSearch?.maxToolCalls ?? 1,
          executeSearch: webSearch?.executeSearch ?? (async () => {
            throw new Error("本轮未启用联网搜索");
          }),
          captureCurrentVideoFrame,
          fetchHotComments,
          onNotice: (text) => {
            onActivity?.();
            flushTokens();
            port.postMessage({ type: "notice", data: text } satisfies ChatPortMessage);
          },
          onToolStatus: (payload: ToolStatusPayload) => {
            onActivity?.();
            flushTokens();
            port.postMessage({ type: "tool-status", ...payload, generation: toolGeneration } satisfies ChatPortMessage);
          },
          onToolTurn: (toolMessages) => {
            port.postMessage({ type: "tool-turn", messages: toolMessages, generation: toolGeneration } satisfies ChatPortMessage);
          }
        })
      : chatCompletion({
          provider,
          messages,
          stream: true,
          signal,
          thinkingLevel,
          maxTokens,
          ...streamCallbacks
        });

    await runTurn();
    if (isEmptyTextRetryable({ finishReason: lastFinishReason, hasBody: !emittedNoText })) {
      emitStreamReset();
      lastFinishReason = null;
      await runTurn(retryBudget());
    }
  } catch (e) {
    if ((e as { overflow?: boolean })?.overflow) {
      throw e;
    }
    if (isAbortedMarkerError(e) || signal?.aborted) {
      flushTokens();
      port.postMessage({ type: "stopped", reason: "已停止生成" } satisfies ChatPortMessage);
      return;
    }
    flushTokens();
    port.postMessage({ type: "error", error: String((e as { message?: unknown })?.message ?? e) } satisfies ChatPortMessage);
    return;
  }

  flushTokens();
  if (lastFinishReason === "length") {
    port.postMessage({ type: "notice", data: TRUNCATED_NOTICE, code: "truncated" } satisfies ChatPortMessage);
  }
  port.postMessage({ type: "done" } satisfies ChatPortMessage);
  return { done: true };
}
