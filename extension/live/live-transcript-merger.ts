// extension/live/live-transcript-merger.ts
// 实时全双工语音问答浮窗字幕归并器与共享轮次状态机：
// 1. 麦克风语音门控：只有在最近检测到用户麦克风语音活动（含尾音滑动窗口）或当前轮用户气泡已在活跃期内建立时，
//    才将 input.transcript.updated / input.transcript.done 渲染为用户消息；纯视频对白转写不显示在用户消息位置
// 2. 将 AI 侧 output.transcript.updated（按 runId+turnId 路由，全量替换转增量或重置）交给视图层流式渲染，output.transcript.done / response.ended 时定稿
// 3. 乱序保护：若 AI 字幕先于用户 input.transcript.done 到达，自动先行提交非空待定用户气泡，保证 user -> assistant 顺序与原位修正
// 4. 挂断隔离：dispose() 后清理未落盘半截气泡，并拦截一切迟到事件

import type { MossLiveTranscriptEvent } from "./moss-live-protocol.js";

export interface LiveOverlayTranscriptMergerDeps {
  getMessagesContainer: () => HTMLElement | null;
  scrollToBottom: () => void;
  isVoiceRecentlyActive?: () => boolean;
}

export interface LiveTranscriptMerger {
  handleEvent(event: MossLiveTranscriptEvent): void;
  resetActiveTurns?(): void;
  dispose(): void;
}

interface TranscriptTurnSink<TUserHandle, TAssistantHandle> {
  isVoiceRecentlyActive?: () => boolean;
  onActivity?: () => void;
  createUserTurn(): TUserHandle | null;
  updateUserTurn(handle: TUserHandle, text: string): void;
  commitPendingUserBeforeAssistant?(handle: TUserHandle, text: string): void;
  finalizeUserTurn(handle: TUserHandle, finalText: string, wasCommittedEarly: boolean): void;
  discardUserTurn(handle: TUserHandle, wasCommittedEarly: boolean): void;
  settleEarlyCommittedUserTurnOnAssistantFinish?(handle: TUserHandle): void;
  createAssistantTurn(runId: string, turnKey: string): TAssistantHandle | null;
  updateAssistantTurn(handle: TAssistantHandle, prevText: string, nextText: string): void;
  finalizeAssistantTurn(handle: TAssistantHandle, finalText: string, interrupted: boolean): void;
  discardAssistantTurn(handle: TAssistantHandle): void;
  onReset?(): void;
}

interface AssistantTurnRecord<TAssistantHandle> {
  turnKey: string;
  runId: string;
  handle: TAssistantHandle;
  renderedText: string;
  finalized: boolean;
}

function getTurnKey(runId: string, turnId: string): string {
  return `${runId || "default"}:${turnId || "default"}`;
}

function createTranscriptTurnStateMachine<TUserHandle, TAssistantHandle>(
  sink: TranscriptTurnSink<TUserHandle, TAssistantHandle>
): LiveTranscriptMerger {
  let disposed = false;
  let pendingUserHandle: TUserHandle | null = null;
  let pendingUserText = "";
  let pendingUserCommittedEarly = false;
  const assistantTurns = new Map<string, AssistantTurnRecord<TAssistantHandle>>();
  const interruptedTurnKeys = new Set<string>();

  function canAcceptUserInputTranscript(): boolean {
    if (pendingUserHandle !== null) {
      return true;
    }
    if (sink.isVoiceRecentlyActive) {
      return sink.isVoiceRecentlyActive();
    }
    return true;
  }

  function flushPendingUserBeforeAssistantIfNeeded(): void {
    const trimmed = pendingUserText.trim();
    if (pendingUserHandle === null || !trimmed || pendingUserCommittedEarly) {
      return;
    }
    pendingUserCommittedEarly = true;
    sink.commitPendingUserBeforeAssistant?.(pendingUserHandle, trimmed);
  }

  function handleInputUpdated(text: string): void {
    if (!canAcceptUserInputTranscript()) {
      return;
    }
    const clean = String(text || "");
    if (!clean.trim() && pendingUserHandle === null) {
      return;
    }
    if (pendingUserHandle === null) {
      const created = sink.createUserTurn();
      if (created === null) {
        return;
      }
      pendingUserHandle = created;
    }
    sink.onActivity?.();
    pendingUserText = clean;
    sink.updateUserTurn(pendingUserHandle, clean);
  }

  function handleInputDone(text: string): void {
    if (!canAcceptUserInputTranscript()) {
      return;
    }
    const finalText = String(text || pendingUserText || "").trim();
    if (!finalText) {
      if (pendingUserHandle !== null) {
        sink.discardUserTurn(pendingUserHandle, pendingUserCommittedEarly);
      }
      pendingUserHandle = null;
      pendingUserText = "";
      pendingUserCommittedEarly = false;
      return;
    }

    if (pendingUserHandle === null) {
      const created = sink.createUserTurn();
      if (created === null) {
        return;
      }
      pendingUserHandle = created;
    }

    sink.onActivity?.();
    sink.finalizeUserTurn(pendingUserHandle, finalText, pendingUserCommittedEarly);
    pendingUserHandle = null;
    pendingUserText = "";
    pendingUserCommittedEarly = false;
  }

  function finalizeTurnRecord(
    record: AssistantTurnRecord<TAssistantHandle>,
    explicitText?: string,
    interrupted = false
  ): void {
    if (record.finalized) return;
    record.finalized = true;

    const finalText = String(explicitText ?? record.renderedText ?? "").trim();
    if (!finalText && !interrupted) {
      sink.discardAssistantTurn(record.handle);
      return;
    }

    if (pendingUserHandle !== null && pendingUserCommittedEarly) {
      sink.settleEarlyCommittedUserTurnOnAssistantFinish?.(pendingUserHandle);
      pendingUserHandle = null;
      pendingUserText = "";
      pendingUserCommittedEarly = false;
    }

    sink.finalizeAssistantTurn(record.handle, finalText, interrupted);
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

    if (!record) {
      const handle = sink.createAssistantTurn(runId, turnKey);
      if (handle === null) {
        return;
      }
      record = {
        turnKey,
        runId,
        handle,
        renderedText: "",
        finalized: false
      };
      assistantTurns.set(turnKey, record);
    }

    sink.onActivity?.();
    if (nextText === record.renderedText) {
      return;
    }

    const prevText = record.renderedText;
    record.renderedText = nextText;
    sink.updateAssistantTurn(record.handle, prevText, nextText);
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
    sink.onActivity?.();

    if (!record) {
      const handle = sink.createAssistantTurn(runId, turnKey);
      if (handle === null) {
        return;
      }
      record = {
        turnKey,
        runId,
        handle,
        renderedText: finalText,
        finalized: false
      };
      assistantTurns.set(turnKey, record);
    }

    finalizeTurnRecord(record, finalText, false);
  }

  function handleResponseInterrupted(runId: string, turnId: string): void {
    const turnKey = getTurnKey(runId, turnId);
    interruptedTurnKeys.add(turnKey);
    const record = assistantTurns.get(turnKey);
    if (!record || record.finalized) return;
    sink.onActivity?.();
    finalizeTurnRecord(record, record.renderedText, true);
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
    finalizeTurnRecord(record, record.renderedText, false);
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

    if (pendingUserHandle !== null) {
      sink.discardUserTurn(pendingUserHandle, pendingUserCommittedEarly);
      pendingUserHandle = null;
      pendingUserText = "";
      pendingUserCommittedEarly = false;
    }

    for (const record of assistantTurns.values()) {
      if (!record.finalized) {
        record.finalized = true;
        sink.discardAssistantTurn(record.handle);
      }
    }
    assistantTurns.clear();
    interruptedTurnKeys.clear();
    sink.onReset?.();
  }

  function resetActiveTurns(): void {
    pendingUserHandle = null;
    pendingUserText = "";
    pendingUserCommittedEarly = false;
    assistantTurns.clear();
    interruptedTurnKeys.clear();
    sink.onReset?.();
  }

  return {
    handleEvent,
    resetActiveTurns,
    dispose
  };
}

export function createLiveOverlayTranscriptMerger(
  deps: LiveOverlayTranscriptMergerDeps
): LiveTranscriptMerger {
  return createTranscriptTurnStateMachine<HTMLDivElement, HTMLDivElement>({
    isVoiceRecentlyActive: deps.isVoiceRecentlyActive,
    createUserTurn() {
      const container = deps.getMessagesContainer();
      if (!container) return null;
      const bubble = document.createElement("div");
      bubble.className = "live-overlay-bubble live-overlay-bubble-user is-pending";
      container.appendChild(bubble);
      return bubble;
    },
    updateUserTurn(bubble, text) {
      bubble.textContent = text;
      deps.scrollToBottom();
    },
    finalizeUserTurn(bubble, finalText) {
      bubble.textContent = finalText;
      bubble.classList.remove("is-pending");
      deps.scrollToBottom();
    },
    discardUserTurn(bubble, wasCommittedEarly) {
      if (!wasCommittedEarly) {
        bubble.remove();
      } else {
        bubble.classList.remove("is-pending");
      }
    },
    settleEarlyCommittedUserTurnOnAssistantFinish(bubble) {
      bubble.classList.remove("is-pending");
    },
    createAssistantTurn() {
      const container = deps.getMessagesContainer();
      if (!container) return null;
      const bubble = document.createElement("div");
      bubble.className = "live-overlay-bubble live-overlay-bubble-assistant is-streaming";
      container.appendChild(bubble);
      return bubble;
    },
    updateAssistantTurn(bubble, _prevText, nextText) {
      bubble.textContent = nextText;
      deps.scrollToBottom();
    },
    finalizeAssistantTurn(bubble, finalText, interrupted) {
      if (finalText) {
        bubble.textContent = finalText;
      }
      bubble.classList.remove("is-streaming");
      if (!interrupted) {
        deps.scrollToBottom();
      }
    },
    discardAssistantTurn(bubble) {
      bubble.remove();
    }
  });
}
