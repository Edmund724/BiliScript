import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { ImagePart } from "../ai/types.js";
import { createChatImageViewer } from "./chat-image-viewer.js";
import type { ChatToolStatusEvent } from "./protocol.js";
import type { ChatSearchSource, HistorySearchTurn } from "./search-sources.js";
import { createInPlaceTurnController } from "./render/in-place-turn.js";
import { createMessageActionsController } from "./render/message-actions.js";
import { createSourcePreviewController } from "./render/source-preview.js";
import { createThinkingBufferController } from "./render/thinking-buffer.js";
import { createThoughtChainController } from "./render/thought-chain.js";
import { createTokenStreamController } from "./render/token-stream.js";

export interface ChatStreamRendererDeps {
  messages: HTMLElement;
  getTimestampNavDeps: () => TimestampNavDeps;
  smoothStream?: boolean;
  onRegenerate?: (historyIndex: number, node: HTMLDivElement) => void;
  onContinue?: (historyIndex: number, node: HTMLDivElement) => void;
  onExport?: (historyIndex: number, raw: string) => void;
  onSpeak?: (messageId: string, button: HTMLButtonElement, content: HTMLElement) => Promise<void> | void;
  onClear?: () => void;
  isRegenerationDisabled?: () => boolean;
  onNotice?: (message: string) => void;
}

export type ChatMessageSource = "live" | "replay";

export interface ChatInPlaceSession {
  turn: ChatAssistantTurn;
  commit: () => void;
  restore: () => void;
}

export interface BeginInPlaceTurnOptions {
  mode: "replace" | "continue";
  initialRaw?: string;
  thinking?: string;
}

export interface ChatMessageArea {
  appendUserMessage: (text: string, opts?: { source?: ChatMessageSource; messageId?: string; images?: ImagePart[] }) => HTMLDivElement | void;
  appendAssistantMessage: (opts?: { source?: ChatMessageSource; runId?: string; messageId?: string }) => ChatAssistantTurn;
  beginInPlaceTurn: (node: HTMLDivElement, options: BeginInPlaceTurnOptions) => ChatInPlaceSession;
  setRegenerationDisabled: (disabled: boolean) => void;
  clearUncommittedFailedTurns?: () => void;
  closeImageViewer?: (opts?: { restoreFocus?: boolean }) => void;
  clear: () => void;
}

export interface ChatAssistantTurn {
  node?: HTMLDivElement;
  setSubtitleContextCount?: (count: number) => void;
  appendToken: (token: unknown) => void;
  appendThinking: (text: unknown) => void;
  getThinking?: () => string;
  reset: () => void;
  discard: () => void;
  finish: (opts?: { raw?: unknown; thinking?: string; stopped?: boolean; userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number }) => string;
  fail: (text: string, opts?: { onRetry?: () => void; searchStatus?: "failed" | "cancelled" }) => void;
  stop: (reason: string, opts?: { userPrompt?: string; historyIndex?: number }) => { raw: string; body: boolean };
  markTruncated: (text: string) => void;
  applySearchStatus: (msg: ChatToolStatusEvent) => void;
  attachSearchTimelineCard: (turn: HistorySearchTurn) => void;
}

export interface ChatStreamRenderer {
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
  setAutoScroll: (value: boolean) => void;
  messageArea: ChatMessageArea;
}

export function createChatStreamRenderer(deps: ChatStreamRendererDeps): ChatStreamRenderer {
  const imageViewer = createChatImageViewer();
  let shouldAutoScrollMessages = true;

  function scrollToBottom(force = false, { instant = false }: { instant?: boolean } = {}): void {
    if (!force && !shouldAutoScrollMessages) {
      return;
    }
    const target = deps.messages.scrollHeight;
    if (instant && typeof deps.messages.scrollTo === "function") {
      deps.messages.scrollTo({ top: target, behavior: "instant" });
    } else {
      deps.messages.scrollTop = target;
    }
  }

  function setAutoScroll(value: boolean): void {
    shouldAutoScrollMessages = Boolean(value);
  }

  const sourcePreview = createSourcePreviewController({ messages: deps.messages });
  const thinkingBuffer = createThinkingBufferController({ scrollToBottom });
  const thoughtChain = createThoughtChainController({
    messages: deps.messages,
    imageViewer,
    thinkingBuffer,
    sourcePreview
  });
  const tokenStream = createTokenStreamController({
    isSmoothStream: () => Boolean(deps.smoothStream),
    scrollToBottom,
    onBodyStart: (node) => thoughtChain.collapseOnBodyStart(node)
  });
  const messageActions = createMessageActionsController({
    messages: deps.messages,
    imageViewer,
    getTimestampNavDeps: deps.getTimestampNavDeps,
    onRegenerate: deps.onRegenerate,
    onContinue: deps.onContinue,
    onExport: deps.onExport,
    onSpeak: deps.onSpeak,
    isRegenerationDisabled: deps.isRegenerationDisabled,
    onNotice: deps.onNotice,
    onLiveAppend: () => {
      setAutoScroll(true);
      scrollToBottom(true, { instant: true });
    },
    tokenStream,
    sourcePreview,
    thoughtChain
  });

  function createTurnHandle(node: HTMLDivElement, opts?: { initialThinking?: string }): ChatAssistantTurn {
    let thinkingEnded = false;
    let accumulatedThinking = opts?.initialThinking || "";
    let terminalHistoryIndex: number | undefined;

    function setSubtitleContextCount(count: number): void {
      thoughtChain.setSubtitleContextCount(node, count);
    }

    function appendToken(token: unknown): void {
      thinkingEnded = true;
      tokenStream.appendToken(node, token);
    }

    function appendThinking(text: unknown): void {
      accumulatedThinking += String(text ?? "");
      const forceNewStep = thinkingEnded;
      if (thinkingEnded) {
        thinkingEnded = false;
      }
      thoughtChain.appendThinkingStep(node, text, forceNewStep);
    }

    function getThinking(): string {
      return accumulatedThinking;
    }

    function reset(): void {
      accumulatedThinking = "";
      tokenStream.cancelFlush();
      thoughtChain.clearThoughtChain(node);
      tokenStream.resetStreamPreservingCursor(node);
      thinkingEnded = false;
    }

    function finish({
      raw,
      thinking,
      stopped = false,
      userPrompt = "",
      sources,
      historyIndex
    }: {
      raw?: unknown;
      thinking?: string;
      stopped?: boolean;
      userPrompt?: string;
      sources?: ChatSearchSource[];
      historyIndex?: number;
    } = {}): string {
      terminalHistoryIndex = historyIndex;
      thoughtChain.flushPendingThinking(node);
      tokenStream.cancelFlush();
      thoughtChain.settleTools(node, "cancelled");
      const text = raw === undefined ? tokenStream.getRaw(node) : String(raw ?? "");
      const finalThinking = typeof thinking === "string" && thinking.trim() ? thinking : accumulatedThinking;
      if (stopped) {
        const label = "已停止生成";
        if (text.trim()) {
          messageActions.renderAssistantMessage(node, text, {
            userPrompt,
            sources: sources ?? thoughtChain.takeSearchSources(node),
            historyIndex,
            stopped: true,
            thinking: finalThinking
          });
          messageActions.appendBadge(node, "chat-msg-stopped", label);
          return text;
        }
        node.innerHTML = "";
        const chainRoot = thoughtChain.applyTerminalThinkingFallback(node, {
          mode: "stopped-without-body",
          thinking: finalThinking,
          createIfMissing: true
        });
        if (chainRoot) {
          node.appendChild(chainRoot);
        }
        node.appendChild(messageActions.createActionBar(node, { stopped: true, historyIndex }));
        messageActions.appendBadge(node, "chat-msg-stopped", label);
        return text;
      }
      messageActions.renderAssistantMessage(node, text, {
        userPrompt,
        sources: sources ?? thoughtChain.takeSearchSources(node),
        historyIndex,
        thinking: finalThinking
      });
      return text;
    }

    function fail(text: string, failOpts?: { onRetry?: () => void; searchStatus?: "failed" | "cancelled" }): void {
      thoughtChain.flushPendingThinking(node);
      tokenStream.cancelFlush();
      thoughtChain.settleTools(node, failOpts?.searchStatus ?? "failed");
      thoughtChain.cancelAllThinkingFrames(node);
      const keptChainRoot = thoughtChain.applyTerminalThinkingFallback(node, { mode: "failed" });
      node.innerHTML = "";
      if (keptChainRoot) {
        node.appendChild(keptChainRoot);
      }
      messageActions.appendBadge(node, "chat-msg-error", text);
      if (failOpts?.onRetry) {
        node.appendChild(messageActions.createRetryActionBar(failOpts.onRetry));
      }
    }

    function stop(
      reason: string,
      { userPrompt = "", historyIndex }: { userPrompt?: string; historyIndex?: number } = {}
    ): { raw: string; body: boolean } {
      terminalHistoryIndex = historyIndex;
      thoughtChain.flushPendingThinking(node);
      tokenStream.cancelFlush();
      thoughtChain.settleTools(node, "cancelled");
      const text = tokenStream.getRaw(node);
      const label = reason || "已停止生成";
      if (text.trim()) {
        messageActions.renderAssistantMessage(node, text, {
          userPrompt,
          sources: thoughtChain.takeSearchSources(node),
          historyIndex,
          stopped: true,
          thinking: accumulatedThinking
        });
        messageActions.appendBadge(node, "chat-msg-stopped", label);
        return { raw: text, body: true };
      }
      thoughtChain.cancelAllThinkingFrames(node);
      const keptRoot = thoughtChain.applyTerminalThinkingFallback(node, {
        mode: "stopped-without-body",
        createIfMissing: false
      });
      if (keptRoot) {
        tokenStream.detachStreamDom(node);
        node.appendChild(messageActions.createActionBar(node, { stopped: true, historyIndex }));
        messageActions.appendBadge(node, "chat-msg-stopped", label);
        return { raw: text, body: false };
      }
      node.innerHTML = "";
      messageActions.appendBadge(node, "chat-msg-stopped", label);
      return { raw: text, body: false };
    }

    function markTruncated(text: string): void {
      messageActions.markTruncated(node, text, terminalHistoryIndex);
    }

    function applySearchStatus(msg: ChatToolStatusEvent): void {
      thoughtChain.applySearchStatus(node, msg);
    }

    function attachSearchTimelineCard(turn: HistorySearchTurn): void {
      thoughtChain.attachHistorySearchToThoughtChain(node, turn);
    }

    function discard(): void {
      tokenStream.cancelFlush();
      thoughtChain.settleTools(node, "cancelled");
      thoughtChain.cancelAllThinkingFrames(node);
      tokenStream.resetState(node);
    }

    return {
      node,
      setSubtitleContextCount,
      appendToken,
      appendThinking,
      getThinking,
      reset,
      discard,
      finish,
      fail,
      stop,
      markTruncated,
      applySearchStatus,
      attachSearchTimelineCard
    };
  }

  const inPlaceTurn = createInPlaceTurnController({
    messages: deps.messages,
    setAutoScroll,
    scrollToBottom,
    tokenStream,
    thoughtChain,
    createTurnHandle
  });

  const messageArea: ChatMessageArea = {
    appendUserMessage(text, { source = "live", messageId, images = [] } = {}) {
      return messageActions.appendUserMessageNode(text, source, messageId, images);
    },
    appendAssistantMessage({ source = "live", runId, messageId } = {}) {
      return createTurnHandle(messageActions.appendAssistantMessageNode(source, runId, messageId));
    },
    beginInPlaceTurn: inPlaceTurn.beginInPlaceTurn,
    setRegenerationDisabled(disabled) {
      deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-regenerate-btn, .chat-msg-continue-btn, .chat-msg-retry-btn").forEach((button) => {
        button.disabled = disabled;
      });
    },
    clearUncommittedFailedTurns() {
      deps.messages.querySelectorAll('[data-uncommitted-failed-turn="1"]').forEach((el) => el.remove());
    },
    closeImageViewer(opts) {
      imageViewer.close(opts?.restoreFocus);
    },
    clear() {
      deps.onClear?.();
      imageViewer.close(false);
      deps.messages.innerHTML = "";
    }
  };

  return {
    scrollToBottom,
    setAutoScroll,
    messageArea
  };
}
