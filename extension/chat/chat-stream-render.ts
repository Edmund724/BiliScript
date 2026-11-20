// extension/chat/chat-stream-render.ts — chat 消息 DOM 渲染/滚动/水合门面
// 组合 extension/chat/render/* 六个子模块，向 chat-runtime / replay 提供窄门面。
// 所有按节点/实例隔离的 WeakMap 与帧调度状态均封装在各控制器工厂闭包内，实例间互不共享。

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

// chat-stream-render 消费的最窄 deps 面：messages 滚动容器 + 终态渲染与消息操作回调。
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
  // 消息操作反馈（导出失败等）：由装配方接到对话 tab 自己的通知通道
  //（reader 侧 showConversationContextNotice），不借全局状态条——反馈留在对话上下文。
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

// 回合节点句柄：一个助手消息节点的操作面（状态机不再出现选择器与节点创建；
// 一代际的 token 缓冲、思考节点状态都由本句柄闭包持有）。
export interface ChatAssistantTurn {
  /** 助手消息节点元素 */
  node?: HTMLDivElement;
  /** 登记本回合字幕条数（供思维链自动补齐「读取字幕」前置步骤，不单独创建 DOM）。 */
  setSubtitleContextCount?: (count: number) => void;
  /** 灌入 token 增量（帧合批；未 flush 的增量同样进终态原文）。 */
  appendToken: (token: unknown) => void;
  /** 灌入思考增量；并入当前回合的思维链状态条。 */
  appendThinking: (text: unknown) => void;
  /** 获取本回合累积的思考文本。 */
  getThinking?: () => string;
  /** 重置流式（读流中断重试整体重放）：清已渲染容器 / 思维链状态条与累加器，内部自动取消挂起帧，光标归位。 */
  reset: () => void;
  /** 丢弃在途回合（拆除清场）：内部自动取消挂起渲染帧并释放累加器，不破坏已落定 DOM。 */
  discard: () => void;
  /** 收尾成终态形态（正文 + 操作行，自动折叠思维链为单行摘要；内部自动取消挂起帧）；返回本次渲染所用原文。 */
  finish: (opts?: { raw?: unknown; thinking?: string; stopped?: boolean; userPrompt?: string; sources?: ChatSearchSource[]; historyIndex?: number }) => string;
  /** 挂错误占位（内部自动取消挂起帧；收口在途工具并展示错误文案与可选原位重试操作）。 */
  fail: (text: string, opts?: { onRetry?: () => void; searchStatus?: "failed" | "cancelled" }) => void;
  /** 挂停止态：内部自动取消挂起帧；有正文则收尾成形态 + 停止徽标，无正文保留已展开思维链或仅留徽标。 */
  stop: (reason: string, opts?: { userPrompt?: string; historyIndex?: number }) => { raw: string; body: boolean };
  /** 挂截断徽标（收尾之后追加，位置与停止徽标一致）。 */
  markTruncated: (text: string) => void;
  /** 工具 tool-status → 汇入本回合思维链状态条。 */
  applySearchStatus: (msg: ChatToolStatusEvent) => void;
  /** 回放：把该回合的静态检索步骤与来源合并/挂载进本节点思维链状态条。 */
  attachSearchTimelineCard: (turn: HistorySearchTurn) => void;
}

export interface ChatStreamRenderer {
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
  setAutoScroll: (value: boolean) => void;
  messageArea: ChatMessageArea;
}

/**
 * createChatStreamRenderer(deps) — chat 消息 DOM 渲染/滚动/水合的工厂。
 *
 * 由 createChatRuntime(deps) 在工厂体内调用一次；闭包状态（自动滚动标志 /
 * flush 帧调度 / 按节点 WeakMap）随实例隔离。
 */
export function createChatStreamRenderer(deps: ChatStreamRendererDeps): ChatStreamRenderer {
  const imageViewer = createChatImageViewer();
  let shouldAutoScrollMessages = true;

  // instant=true 显式 behavior:"instant" 覆盖 CSS scroll-behavior:smooth，
  // 避免流式期间与发送路径扫掠 c-v 塌缩块引发跳变（behavior:"auto" 在规范下压不住 smooth）。
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
