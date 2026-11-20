// extension/chat/render/in-place-turn.ts — 原位重新生成/续写的可恢复 DOM 事务

import type {
  BeginInPlaceTurnOptions,
  ChatAssistantTurn,
  ChatInPlaceSession
} from "../chat-stream-render.js";
import type { ThoughtChainState } from "./thought-chain.js";

export interface InPlaceTurnTokenStreamDeps {
  cancelFlush: () => void;
  resetState: (node: HTMLElement) => void;
  mountCursor: (node: HTMLDivElement) => void;
  flushSyncInitial: (node: HTMLDivElement, initialRaw: string) => void;
}

export interface InPlaceTurnThoughtChainDeps {
  getChain: (node: HTMLElement) => ThoughtChainState | null;
  setChain: (node: HTMLElement, chain: ThoughtChainState) => void;
  deleteChain: (node: HTMLElement) => void;
  clearSettled: (node: HTMLElement) => void;
  cancelChainThinkingFrames: (chain: ThoughtChainState) => void;
  clearThoughtChain: (node: HTMLDivElement | null) => void;
}

export interface InPlaceTurnControllerDeps {
  messages: HTMLElement;
  setAutoScroll: (value: boolean) => void;
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
  tokenStream: InPlaceTurnTokenStreamDeps;
  thoughtChain: InPlaceTurnThoughtChainDeps;
  createTurnHandle: (node: HTMLDivElement, opts?: { initialThinking?: string }) => ChatAssistantTurn;
}

export interface InPlaceTurnController {
  beginInPlaceTurn: (node: HTMLDivElement, options: BeginInPlaceTurnOptions) => ChatInPlaceSession;
}

function createFollowingVisibilityScope(node: HTMLElement): { restore: () => void; remove: () => void } {
  const following: HTMLElement[] = [];
  let next = node.nextElementSibling;
  while (next) {
    if (next instanceof HTMLElement) {
      next.hidden = true;
      following.push(next);
    }
    next = next.nextElementSibling;
  }
  return {
    restore() {
      following.forEach((element) => {
        element.hidden = false;
      });
    },
    remove() {
      following.forEach((element) => element.remove());
    }
  };
}

export function createInPlaceTurnController(deps: InPlaceTurnControllerDeps): InPlaceTurnController {
  function beginInPlaceTurn(
    node: HTMLDivElement,
    options: BeginInPlaceTurnOptions
  ): ChatInPlaceSession {
    const savedScrollTop = deps.messages.scrollTop;
    const originalStreaming = node.classList.contains("chat-msg-streaming");
    const originalChildren = Array.from(node.childNodes);
    const originalThoughtChain = deps.thoughtChain.getChain(node);
    const following = createFollowingVisibilityScope(node);

    deps.tokenStream.cancelFlush();
    if (originalThoughtChain) {
      deps.thoughtChain.cancelChainThinkingFrames(originalThoughtChain);
    }
    if (options.mode === "replace") {
      deps.thoughtChain.deleteChain(node);
    }
    deps.thoughtChain.clearSettled(node);
    deps.tokenStream.resetState(node);

    if (options.mode === "replace") {
      originalChildren.forEach((child) => {
        if (child.parentNode === node) {
          node.removeChild(child);
        }
      });
      deps.tokenStream.mountCursor(node);
    } else {
      node.querySelectorAll(".chat-msg-stopped, .chat-msg-truncated, .chat-msg-actions").forEach((el) => el.remove());

      const existingBody = node.querySelector(".chat-msg-assistant-body");
      if (existingBody) {
        existingBody.remove();
      }
      const initialRaw = String(options.initialRaw || "");
      if (initialRaw.trim()) {
        deps.tokenStream.flushSyncInitial(node, initialRaw);
      } else {
        deps.tokenStream.mountCursor(node);
      }
      deps.setAutoScroll(true);
      deps.scrollToBottom(true, { instant: true });
    }

    deps.messages
      .querySelectorAll(".chat-msg-assistant.chat-msg-streaming")
      .forEach((el) => el.classList.remove("chat-msg-streaming"));
    node.classList.add("chat-msg-streaming");

    const baseTurn = deps.createTurnHandle(
      node,
      options.mode === "continue" ? { initialThinking: options.thinking } : undefined
    );
    let settled = false;

    function restore(): void {
      if (settled) {
        return;
      }
      settled = true;
      baseTurn.discard();
      deps.thoughtChain.clearThoughtChain(node);
      node.innerHTML = "";
      originalChildren.forEach((child) => node.appendChild(child));
      if (originalThoughtChain) {
        deps.thoughtChain.setChain(node, originalThoughtChain);
      }
      following.restore();
      node.classList.toggle("chat-msg-streaming", originalStreaming);
      deps.messages.scrollTop = savedScrollTop;
    }

    const turn: ChatAssistantTurn = {
      ...baseTurn,
      discard: restore,
      fail() {
        restore();
      }
    };

    return {
      turn,
      commit() {
        if (settled) {
          return;
        }
        settled = true;
        following.remove();
      },
      restore
    };
  }

  return {
    beginInPlaceTurn
  };
}
