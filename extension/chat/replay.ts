import { getActiveReaderWindow, onActiveHostChange } from "../shared/active-host.js";
import {
  scheduleActiveAnimationFrame,
  type ActiveAnimationFrameHandle,
} from "../shared/cross-doc.js";
import { chatSessionState } from "./chat-state.js";
import { collectHistorySearchTurns, type HistorySearchTurn } from "./search-sources.js";
import type { ChatMessageArea } from "./chat-stream-render.js";

const REPLAY_FRAME_BUDGET_MS = 50;

export interface ConversationReplayRenderer {
  messageArea: ChatMessageArea;
  setAutoScroll: (value: boolean) => void;
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
}

export interface CreateConversationReplayDeps {
  renderer: ConversationReplayRenderer;
  updateLayout: () => void;
  clearSuggestions: () => void;
}

export interface ConversationReplay {
  render: () => void;
  invalidate: () => void;
  readonly inFlight: Promise<void> | null;
}

export function createConversationReplay(deps: CreateConversationReplayDeps): ConversationReplay {
  let generation = 0;
  let inFlight: Promise<void> | null = null;
  let cancelPendingRafWait: (() => void) | null = null;

  function yieldToMainThread(): Promise<void> {
    const activeWin = getActiveReaderWindow();
    try {
      const schedulerApi =
        (activeWin && !activeWin.closed
          ? (activeWin as (Window & { scheduler?: { yield?: () => Promise<void> } }) | null)?.scheduler
          : undefined) ??
        (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
      if (typeof schedulerApi?.yield === "function") {
        return schedulerApi.yield();
      }
    } catch {
    }
    return new Promise((resolve) => {
      try {
        if (activeWin && !activeWin.closed && typeof activeWin.setTimeout === "function") {
          activeWin.setTimeout(resolve, 0);
          return;
        }
      } catch {
      }
      setTimeout(resolve, 0);
    });
  }

  async function renderConversationMessages(): Promise<void> {
    const task = runConversationReplay();
    inFlight = task;
    try {
      await task;
    } finally {
      if (inFlight === task) {
        inFlight = null;
      }
    }
  }

  function findPreviousUserPrompt(index: number): string {
    for (let i = Number(index) - 1; i >= 0; i -= 1) {
      const item = chatSessionState.chatHistory[i];
      if (item?.role === "user" && typeof item.content === "string") {
        return item.content;
      }
    }
    return "";
  }

  function invalidateReplay(): void {
    generation += 1;
    cancelPendingRafWait?.();
    cancelPendingRafWait = null;
  }

  async function runConversationReplay(): Promise<void> {
    deps.updateLayout();
    deps.renderer.messageArea.clear();
    deps.clearSuggestions();
    invalidateReplay();
    const replayGeneration = generation;
    const history = chatSessionState.chatHistory;
    const searchTurnByAssistantIndex = new Map(
      collectHistorySearchTurns(history).map((turn) => [turn.assistantIndex, turn])
    );
    const total = history.length;
    let deadline = performance.now() + REPLAY_FRAME_BUDGET_MS;
    for (let index = 0; index < total; index += 1) {
      if (replayGeneration !== generation) {
        return;
      }
      const message = history[index];
      if (message.role === "user") {
        deps.renderer.messageArea.appendUserMessage(message.content, {
          source: "replay",
          ...(message.images?.length ? { images: message.images } : {})
        });
      } else if (message.role === "tool" || (Array.isArray(message.tool_calls) && message.tool_calls.length && !String(message.content || "").trim())) {
        continue;
      } else {
        const searchTurn = searchTurnByAssistantIndex.get(index);
        const streamTurn = deps.renderer.messageArea.appendAssistantMessage({ source: "replay" });
        streamTurn.finish({
          raw: String(message.content || ""),
          userPrompt: findPreviousUserPrompt(index),
          sources: searchTurn ? searchTurn.sources : [],
          historyIndex: index,
          ...(message.thinking ? { thinking: message.thinking } : {}),
          ...(message.stopped ? { stopped: true } : {})
        });
        if (searchTurn) {
          streamTurn.attachSearchTimelineCard(searchTurn);
        }
      }
      if (performance.now() >= deadline) {
        await yieldToMainThread();
        if (replayGeneration !== generation) {
          return;
        }
        deadline = performance.now() + REPLAY_FRAME_BUDGET_MS;
      }
    }
    if (replayGeneration !== generation) {
      return;
    }
    await yieldToMainThread();
    if (replayGeneration !== generation) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let handle: ActiveAnimationFrameHandle | null = null;
      let stopHostWatch: (() => void) | null = null;

      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (cancelPendingRafWait === finish) {
          cancelPendingRafWait = null;
        }
        stopHostWatch?.();
        stopHostWatch = null;
        if (handle) {
          try {
            handle.cancel();
          } catch {
          }
          handle = null;
        }
        resolve();
      };

      const scheduleOn = (win: Window | null | undefined) => {
        if (settled) {
          return;
        }
        if (handle) {
          try {
            handle.cancel();
          } catch {
          }
          handle = null;
        }
        const targetWin = win ?? getActiveReaderWindow();
        if (typeof targetWin?.requestAnimationFrame === "function") {
          handle = scheduleActiveAnimationFrame(() => {
            handle = null;
            finish();
          }, targetWin);
          return;
        }
        let cleared = false;
        let timerId: ReturnType<typeof setTimeout> | number;
        let usedWin = false;
        try {
          if (typeof targetWin?.setTimeout === "function") {
            timerId = targetWin.setTimeout(finish, 0);
            usedWin = true;
          } else {
            timerId = setTimeout(finish, 0);
          }
        } catch {
          timerId = setTimeout(finish, 0);
        }
        handle = {
          window: targetWin,
          cancel() {
            if (cleared) return;
            cleared = true;
            if (usedWin) {
              try {
                targetWin.clearTimeout(timerId as number);
                return;
              } catch {
              }
            }
            clearTimeout(timerId);
          }
        };
      };

      cancelPendingRafWait = finish;
      stopHostWatch = onActiveHostChange((ctx) => {
        if (settled) {
          return;
        }
        if (replayGeneration !== generation) {
          finish();
          return;
        }
        scheduleOn(ctx.win);
      });
      scheduleOn(getActiveReaderWindow());
    });
    if (replayGeneration !== generation) {
      return;
    }
    deps.renderer.setAutoScroll(true);
    deps.renderer.scrollToBottom(true, { instant: true });
  }

  return {
    render: () => {
      void renderConversationMessages();
    },
    invalidate: invalidateReplay,
    get inFlight() {
      return inFlight;
    }
  };
}
