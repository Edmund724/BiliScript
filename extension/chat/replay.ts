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

  function yieldToMainThread(): Promise<void> {
    const schedulerApi = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof schedulerApi?.yield === "function") {
      return schedulerApi.yield();
    }
    return new Promise((resolve) => window.setTimeout(resolve, 0));
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
    await new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve());
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
