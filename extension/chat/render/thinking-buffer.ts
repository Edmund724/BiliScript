// extension/chat/render/thinking-buffer.ts — 思考文本流式缓冲与钉底滚动

const THINKING_NEAR_BOTTOM_PX = 24;

export interface ThinkingDisplayState {
  text: string;
  renderedText: string;
  scrollFrame: number;
  pinned: boolean;
  lastTop: number;
  syncedHeight: number;
}

export interface ThinkingBufferDeps {
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
}

export interface ThinkingBufferController {
  append: (textNode: Element | null, text: unknown) => void;
  flushNode: (textNode: Element | null) => void;
  cancelFrame: (textNode: Element | null) => void;
}

function flushThinkingText(textNode: Element, state: ThinkingDisplayState): void {
  if (state.renderedText !== state.text) {
    textNode.textContent = state.text;
    state.renderedText = state.text;
  }
}

export function createThinkingBufferController(deps: ThinkingBufferDeps): ThinkingBufferController {
  const thinkingDisplayStates = new WeakMap<Element, ThinkingDisplayState>();

  function flushNode(textNode: Element | null): void {
    if (!textNode) {
      return;
    }
    const state = thinkingDisplayStates.get(textNode);
    if (state) {
      flushThinkingText(textNode, state);
    }
  }

  function cancelFrame(textNode: Element | null): void {
    if (!textNode) {
      return;
    }
    const state = thinkingDisplayStates.get(textNode);
    if (state && state.scrollFrame) {
      if (typeof window.cancelAnimationFrame === "function") {
        window.cancelAnimationFrame(state.scrollFrame);
      } else {
        window.clearTimeout(state.scrollFrame);
      }
      state.scrollFrame = 0;
    }
  }

  function scheduleThinkingScroll(textNode: Element, state: ThinkingDisplayState): void {
    if (state.scrollFrame) {
      return;
    }
    const scroll = () => {
      state.scrollFrame = 0;
      flushThinkingText(textNode, state);
      if (state.pinned) {
        const height = textNode.scrollHeight;
        textNode.scrollTop = height;
        state.syncedHeight = height;
        state.lastTop = textNode.scrollTop;
      }
      deps.scrollToBottom(false, { instant: true });
    };
    if (typeof window.requestAnimationFrame === "function") {
      state.scrollFrame = window.requestAnimationFrame(scroll);
    } else {
      state.scrollFrame = window.setTimeout(scroll, 16);
    }
  }

  function append(textNode: Element | null, text: unknown): void {
    if (!textNode) {
      return;
    }
    let state = thinkingDisplayStates.get(textNode);
    if (!state) {
      state = { text: "", renderedText: "", scrollFrame: 0, pinned: true, lastTop: 0, syncedHeight: 0 };
      thinkingDisplayStates.set(textNode, state);
      textNode.addEventListener("scroll", () => {
        const st = thinkingDisplayStates.get(textNode);
        if (!st) {
          return;
        }
        const top = textNode.scrollTop;
        if (top < st.lastTop) {
          st.pinned = false;
        } else if (top > st.lastTop || textNode.scrollHeight === st.syncedHeight) {
          st.pinned = top + textNode.clientHeight >= textNode.scrollHeight - THINKING_NEAR_BOTTOM_PX;
        }
        st.lastTop = top;
      });
    }
    state.text += String(text || "");
    scheduleThinkingScroll(textNode, state);
  }

  return {
    append,
    flushNode,
    cancelFrame
  };
}
