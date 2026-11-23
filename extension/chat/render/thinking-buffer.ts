import { onActiveHostChange } from "../../shared/active-host.js";
import {
  resolveNodeWindow,
  scheduleActiveAnimationFrame,
} from "../../shared/cross-doc.js";

const THINKING_NEAR_BOTTOM_PX = 24;

export interface ThinkingDisplayState {
  text: string;
  renderedText: string;
  scrollFrame: number;
  scrollCancel?: (() => void) | null;
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
  const pendingNodes = new Set<Element>();
  let stopHostWatch: (() => void) | null = null;

  function syncHostWatch(): void {
    if (pendingNodes.size === 0) {
      stopHostWatch?.();
      stopHostWatch = null;
      return;
    }
    if (stopHostWatch) {
      return;
    }
    stopHostWatch = onActiveHostChange((ctx) => {
      const nodes = Array.from(pendingNodes);
      for (const node of nodes) {
        const st = thinkingDisplayStates.get(node);
        if (!st || (!st.scrollFrame && !st.scrollCancel)) {
          pendingNodes.delete(node);
          continue;
        }
        try {
          st.scrollCancel?.();
        } catch {
        }
        st.scrollCancel = null;
        st.scrollFrame = 0;
        scheduleThinkingScroll(node, st, ctx.win);
      }
      syncHostWatch();
    });
  }

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
    pendingNodes.delete(textNode);
    const state = thinkingDisplayStates.get(textNode);
    if (state && (state.scrollCancel || state.scrollFrame)) {
      try {
        state.scrollCancel?.();
      } catch {
      }
      state.scrollCancel = null;
      state.scrollFrame = 0;
    }
    syncHostWatch();
  }

  function scheduleThinkingScroll(
    textNode: Element,
    state: ThinkingDisplayState,
    preferredWin?: Window | null
  ): void {
    if (state.scrollFrame || state.scrollCancel) {
      return;
    }
    pendingNodes.add(textNode);
    syncHostWatch();
    const scroll = () => {
      state.scrollFrame = 0;
      state.scrollCancel = null;
      pendingNodes.delete(textNode);
      syncHostWatch();
      flushThinkingText(textNode, state);
      if (state.pinned) {
        const height = textNode.scrollHeight;
        textNode.scrollTop = height;
        state.syncedHeight = height;
        state.lastTop = textNode.scrollTop;
      }
      deps.scrollToBottom(false, { instant: true });
    };
    const win = preferredWin ?? resolveNodeWindow(textNode);
    if (typeof win?.requestAnimationFrame === "function") {
      const handle = scheduleActiveAnimationFrame(scroll, win);
      state.scrollFrame = 1;
      state.scrollCancel = () => handle.cancel();
    } else {
      let cleared = false;
      let timerId: ReturnType<typeof setTimeout> | number;
      let usedWin = false;
      try {
        if (typeof win?.setTimeout === "function") {
          timerId = win.setTimeout(scroll, 16);
          usedWin = true;
        } else {
          timerId = setTimeout(scroll, 16);
        }
      } catch {
        timerId = setTimeout(scroll, 16);
      }
      state.scrollFrame = 1;
      state.scrollCancel = () => {
        if (cleared) return;
        cleared = true;
        if (usedWin) {
          try {
            win.clearTimeout(timerId as number);
            return;
          } catch {
          }
        }
        clearTimeout(timerId);
      };
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
