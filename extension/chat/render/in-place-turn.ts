import { isHtmlElement } from "../../shared/cross-doc.js";
import type {
  BeginInPlaceTurnOptions,
  ChatAssistantTurn,
  ChatInPlaceSession
} from "../chat-stream-render.js";

export interface InPlaceTurnTokenStreamDeps {
  cancelFlush: () => void;
  resetState: (node: HTMLElement) => void;
  mountCursor: (node: HTMLDivElement) => void;
  flushSyncInitial: (node: HTMLDivElement, initialRaw: string) => void;
}

export interface InPlaceTurnThoughtChainDeps {
  beginInPlaceEdit: (node: HTMLDivElement, mode: "replace" | "continue") => () => void;
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
    if (isHtmlElement(next)) {
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
    const following = createFollowingVisibilityScope(node);

    deps.tokenStream.cancelFlush();
    const restoreThoughtChain = deps.thoughtChain.beginInPlaceEdit(node, options.mode);
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
      restoreThoughtChain();
      node.innerHTML = "";
      originalChildren.forEach((child) => node.appendChild(child));
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
