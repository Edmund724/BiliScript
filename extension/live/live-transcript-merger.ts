// extension/live/live-transcript-merger.ts
// 实时全双工语音问答双端字幕归并器：
// 1. 麦克风语音门控：只有在最近检测到用户麦克风语音活动（含尾音滑动窗口）或当前轮用户气泡已在活跃期内建立时，
//    才将 input.transcript.updated / input.transcript.done 渲染为用户消息并写入对话历史；纯视频对白转写不显示在用户消息位置
// 2. 独立消息 ID 与 runId 绑定：每次用户输入使用独立消息 ID（data-message-id），每轮 Agent 回复绑定对应的 run_id，持续向下追加，绝不覆盖此前内容
// 3. 将 AI 侧 output.transcript.updated（按 runId+turnId 路由，全量替换转增量或重置）交给 ChatAssistantTurn 流式渲染，output.transcript.done / response.ended 时落盘进 chatHistory
// 4. 乱序保护：若 AI 字幕先于用户 input.transcript.done 到达，自动先行提交非空待定用户气泡，保证 user -> assistant 顺序与原位修正
// 5. 挂断隔离：dispose() 后清理未落盘半截气泡，并拦截一切迟到事件写入对话

import { generateConversationId } from "../ai/conversation.js";
import {
  appendChatHistory,
  applyConversationIdentity,
  chatSessionState,
  ensureConversationId
} from "../chat/chat-state.js";
import type { ChatAssistantTurn, ChatMessageArea } from "../chat/chat-stream-render.js";
import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";

export interface LiveTranscriptMergerDeps {
  messagesContainer: HTMLElement;
  messageArea: Pick<ChatMessageArea, "appendAssistantMessage">;
  store: {
    persistCurrent(): Promise<void>;
  };
  scrollToBottom?: (force?: boolean, opts?: { instant?: boolean }) => void;
  onActivity?: () => void;
  isVoiceRecentlyActive?: () => boolean;
}

export interface LiveTranscriptMerger {
  handleEvent(event: MossLiveTranscriptEvent): void;
  resetActiveTurns?(): void;
  dispose(): void;
}

interface AssistantTurnRecord {
  turnKey: string;
  runId: string;
  turn: ChatAssistantTurn;
  renderedText: string;
  finalized: boolean;
}

export function createLiveTranscriptMerger(deps: LiveTranscriptMergerDeps): LiveTranscriptMerger {
  let disposed = false;
  let userMessageSequence = 0;
  let pendingUserNode: HTMLDivElement | null = null;
  let pendingUserText = "";
  let pendingUserHistoryIndex: number | null = null;
  const assistantTurns = new Map<string, AssistantTurnRecord>();
  const interruptedTurnKeys = new Set<string>();

  function ensureActiveConversationId(): void {
    if (!chatSessionState.currentConversationId) {
      ensureConversationId(generateConversationId());
    }
  }

  function canAcceptUserInputTranscript(): boolean {
    // 若当前轮用户气泡已在活跃期内建立，允许继续更新或完成本轮
    if (pendingUserNode !== null) {
      return true;
    }
    // 否则检查最近是否检测到麦克风语音活动（纯视频对白转写被拦截）
    if (deps.isVoiceRecentlyActive) {
      return deps.isVoiceRecentlyActive();
    }
    return true;
  }

  function ensurePendingUserNode(): HTMLDivElement {
    if (!pendingUserNode) {
      userMessageSequence += 1;
      const messageId = `live-user-${Date.now()}-${userMessageSequence}-${Math.random().toString(36).slice(2, 6)}`;
      const node = document.createElement("div");
      node.className = "chat-msg chat-msg-user chat-msg-live-pending";
      node.setAttribute("data-message-id", messageId);
      deps.messagesContainer.appendChild(node);
      pendingUserNode = node;
    }
    return pendingUserNode;
  }

  /**
   * 乱序守卫：若服务端在发出 input.transcript.done 之前已经开始推流 output.transcript.*，
   * 先把当前非空的待定用户气泡写入 chatHistory，锁住 user -> assistant 顺序；
   * 随后迟到的 input.transcript.done 会按 pendingUserHistoryIndex 原位更新文本而不重复插入。
   */
  function flushPendingUserBeforeAssistantIfNeeded(): void {
    const trimmed = pendingUserText.trim();
    if (!pendingUserNode || !trimmed || pendingUserHistoryIndex !== null) {
      return;
    }
    ensureActiveConversationId();
    pendingUserHistoryIndex = chatSessionState.chatHistory.length;
    appendChatHistory({ role: "user", content: trimmed });
    void deps.store.persistCurrent();
  }

  function handleInputUpdated(text: string): void {
    if (!canAcceptUserInputTranscript()) {
      return;
    }
    const clean = String(text || "");
    if (!clean.trim() && !pendingUserNode) {
      return;
    }
    deps.onActivity?.();
    const node = ensurePendingUserNode();
    pendingUserText = clean;
    node.textContent = clean;
    deps.scrollToBottom?.(false, { instant: true });
  }

  function handleInputDone(text: string): void {
    if (!canAcceptUserInputTranscript()) {
      return;
    }
    const finalText = String(text || pendingUserText || "").trim();
    if (!finalText) {
      if (pendingUserNode && pendingUserHistoryIndex === null) {
        pendingUserNode.remove();
      }
      pendingUserNode = null;
      pendingUserText = "";
      pendingUserHistoryIndex = null;
      return;
    }

    deps.onActivity?.();
    const node = ensurePendingUserNode();
    node.textContent = finalText;
    node.classList.remove("chat-msg-live-pending");

    ensureActiveConversationId();

    if (pendingUserHistoryIndex !== null && chatSessionState.chatHistory[pendingUserHistoryIndex]?.role === "user") {
      const nextHistory = [...chatSessionState.chatHistory];
      nextHistory[pendingUserHistoryIndex] = {
        ...nextHistory[pendingUserHistoryIndex],
        content: finalText
      };
      applyConversationIdentity({ history: nextHistory });
    } else {
      appendChatHistory({ role: "user", content: finalText });
    }

    void deps.store.persistCurrent();
    pendingUserNode = null;
    pendingUserText = "";
    pendingUserHistoryIndex = null;
    deps.scrollToBottom?.(true, { instant: true });
  }

  function getTurnKey(runId: string, turnId: string): string {
    return `${runId || "default"}:${turnId || "default"}`;
  }

  function handleOutputUpdated(text: string, runId: string, turnId: string): void {
    const nextText = String(text || "");
    const turnKey = getTurnKey(runId, turnId);
    let record = assistantTurns.get(turnKey);
    if (interruptedTurnKeys.has(turnKey) || record?.finalized) {
      return;
    }
    if (!nextText && !record) {
      return;
    }

    flushPendingUserBeforeAssistantIfNeeded();
    deps.onActivity?.();

    if (!record) {
      const turn = deps.messageArea.appendAssistantMessage({ source: "live", runId });
      record = {
        turnKey,
        runId,
        turn,
        renderedText: "",
        finalized: false
      };
      assistantTurns.set(turnKey, record);
    }

    if (nextText === record.renderedText) {
      return;
    }

    // MOSS-LIVE 的 output.transcript.updated 中 data.text 为当前全量文本（可能修正前文）
    if (nextText.startsWith(record.renderedText)) {
      const delta = nextText.slice(record.renderedText.length);
      if (delta) {
        record.turn.appendToken(delta);
      }
    } else {
      record.turn.reset();
      if (nextText) {
        record.turn.appendToken(nextText);
      }
    }
    record.renderedText = nextText;
    deps.scrollToBottom?.(false, { instant: true });
  }

  function finalizeAssistantTurn(
    record: AssistantTurnRecord,
    explicitText?: string,
    interrupted = false
  ): void {
    if (record.finalized) return;
    record.finalized = true;

    const finalText = String(explicitText ?? record.renderedText ?? "").trim();
    if (!finalText && !interrupted) {
      record.turn.discard();
      return;
    }

    // 在用户已收到正式回答时，若待定用户气泡曾被乱序守卫提交但尚未收到 input.done，剥去 pending 样式并归零句柄
    if (pendingUserNode && pendingUserHistoryIndex !== null) {
      pendingUserNode.classList.remove("chat-msg-live-pending");
      pendingUserNode = null;
      pendingUserText = "";
      pendingUserHistoryIndex = null;
    }

    ensureActiveConversationId();
    const historyIndex = chatSessionState.chatHistory.length;
    const raw = interrupted
      ? record.turn.stop("已打断", { historyIndex }).raw
      : record.turn.finish({ raw: finalText, historyIndex });
    const content = (raw || finalText).trim();
    if (content) {
      appendChatHistory({ role: "assistant", content });
      void deps.store.persistCurrent();
    }
    deps.scrollToBottom?.(false, { instant: true });
  }

  function handleOutputDone(text: string, runId: string, turnId: string): void {
    const turnKey = getTurnKey(runId, turnId);
    let record = assistantTurns.get(turnKey);
    if (interruptedTurnKeys.has(turnKey) || record?.finalized) {
      return;
    }

    const finalText = String(text || record?.renderedText || "").trim();
    if (!finalText && !record) {
      return;
    }

    flushPendingUserBeforeAssistantIfNeeded();
    deps.onActivity?.();

    if (!record) {
      const turn = deps.messageArea.appendAssistantMessage({ source: "live", runId });
      record = {
        turnKey,
        runId,
        turn,
        renderedText: finalText,
        finalized: false
      };
      assistantTurns.set(turnKey, record);
    }

    finalizeAssistantTurn(record, finalText);
  }

  function handleResponseInterrupted(runId: string, turnId: string): void {
    const turnKey = getTurnKey(runId, turnId);
    interruptedTurnKeys.add(turnKey);
    const record = assistantTurns.get(turnKey);
    if (!record || record.finalized) return;
    deps.onActivity?.();
    finalizeAssistantTurn(record, record.renderedText, true);
  }

  function handleResponseEnded(status: string, runId: string, turnId: string): void {
    if (status === "interrupted") {
      handleResponseInterrupted(runId, turnId);
      return;
    }
    const turnKey = getTurnKey(runId, turnId);
    const record = assistantTurns.get(turnKey);
    if (!record || record.finalized) {
      return;
    }
    finalizeAssistantTurn(record, record.renderedText);
  }

  function handleEvent(event: MossLiveTranscriptEvent): void {
    if (disposed || !event) return;

    switch (event.kind) {
      case "input.updated":
        handleInputUpdated(event.text);
        break;
      case "input.done":
        handleInputDone(event.text);
        break;
      case "output.updated":
        handleOutputUpdated(event.text, event.runId, event.turnId);
        break;
      case "output.done":
        handleOutputDone(event.text, event.runId, event.turnId);
        break;
      case "response.interrupted":
        handleResponseInterrupted(event.runId, event.turnId);
        break;
      case "response.ended":
        handleResponseEnded(event.status, event.runId, event.turnId);
        break;
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    if (pendingUserNode) {
      if (pendingUserHistoryIndex === null) {
        pendingUserNode.remove();
      } else {
        pendingUserNode.classList.remove("chat-msg-live-pending");
      }
      pendingUserNode = null;
      pendingUserText = "";
      pendingUserHistoryIndex = null;
    }

    for (const record of assistantTurns.values()) {
      if (!record.finalized) {
        record.finalized = true;
        record.turn.discard();
      }
    }
    assistantTurns.clear();
    interruptedTurnKeys.clear();
  }

  function resetActiveTurns(): void {
    pendingUserNode = null;
    pendingUserText = "";
    pendingUserHistoryIndex = null;
    assistantTurns.clear();
    interruptedTurnKeys.clear();
  }

  return {
    handleEvent,
    resetActiveTurns,
    dispose
  };
}
