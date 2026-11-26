import {
  scheduleMigratingFrame,
  type MigratingFrameHandle,
} from "../../shared/cross-doc.js";

const THINKING_NEAR_BOTTOM_PX = 24;

export interface ThinkingDisplayState {
  text: string;
  renderedText: string;
  scrollFrame: MigratingFrameHandle | null;
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
    if (state?.scrollFrame) {
      const frame = state.scrollFrame;
      state.scrollFrame = null;
      frame.cancel();
    }
  }

  function scheduleThinkingScroll(textNode: Element, state: ThinkingDisplayState): void {
    if (state.scrollFrame) {
      return;
    }
    let fired = false;
    const frame = scheduleMigratingFrame(
      () => {
        fired = true;
        state.scrollFrame = null;
        flushThinkingText(textNode, state);
        if (state.pinned) {
          const height = textNode.scrollHeight;
          textNode.scrollTop = height;
          state.syncedHeight = height;
          state.lastTop = textNode.scrollTop;
        }
        deps.scrollToBottom(false, { instant: true });
      },
      { targetNode: textNode }
    );
    if (!fired) {
      state.scrollFrame = frame;
    }
  }

  function append(textNode: Element | null, text: unknown): void {
    if (!textNode) {
      return;
    }
    let state = thinkingDisplayStates.get(textNode);
    if (!state) {
      state = { text: "", renderedText: "", scrollFrame: null, pinned: true, lastTop: 0, syncedHeight: 0 };
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
