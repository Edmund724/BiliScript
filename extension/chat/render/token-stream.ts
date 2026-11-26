import { getActiveReaderDocument } from "../../shared/active-host.js";
import {
  resolveNodeDocument,
  scheduleMigratingFrame,
  yieldToActiveMainThread,
  type MigratingFrameHandle,
} from "../../shared/cross-doc.js";
import {
  createMarkdownStreamSession,
  renderMarkdownStripped,
  type MarkdownRenderOptions,
  type MarkdownStreamSession
} from "../../ui/markdown.js";

export const CHAT_MARKDOWN_OPTIONS: MarkdownRenderOptions = { dropHeadingAdjacentHr: true };

const STREAM_FRAME_BUDGET_MS = 50;

export interface TokenStreamState {
  pending: string[];
  charQueue: string;
  stableEl: HTMLDivElement | null;
  tailEl: HTMLDivElement | null;
  cursor: HTMLSpanElement | null;
  session: MarkdownStreamSession | null;
}

export interface TokenStreamDeps {
  isSmoothStream: () => boolean;
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
  onBodyStart: (node: HTMLDivElement) => void;
}

export interface TokenStreamController {
  getState: (node: HTMLElement) => TokenStreamState;
  resetState: (node: HTMLElement) => void;
  getRaw: (node: HTMLElement) => string;
  appendToken: (node: HTMLDivElement | null, token: unknown) => void;
  cancelFlush: () => void;
  initNodeCursor: (node: HTMLDivElement) => void;
  mountCursor: (node: HTMLDivElement) => void;
  flushSyncInitial: (node: HTMLDivElement, initialRaw: string) => void;
  resetStreamPreservingCursor: (node: HTMLElement) => void;
  detachStreamDom: (node: HTMLElement) => void;
}

export function createStreamCursor(doc: Document = getActiveReaderDocument()): HTMLSpanElement {
  const cursor = doc.createElement("span");
  cursor.className = "chat-msg-cursor";
  for (let i = 0; i < 3; i += 1) {
    cursor.appendChild(doc.createElement("i"));
  }
  return cursor;
}

function freshTokenStreamState(): TokenStreamState {
  return {
    pending: [],
    charQueue: "",
    stableEl: null,
    tailEl: null,
    cursor: null,
    session: null
  };
}

export function createTokenStreamController(deps: TokenStreamDeps): TokenStreamController {
  let tokenFlushFrame: MigratingFrameHandle | null = null;
  let tokenFlushEpoch = 0;
  const tokenStreamStates = new WeakMap<HTMLElement, TokenStreamState>();

  function resetState(node: HTMLElement): void {
    tokenStreamStates.set(node, freshTokenStreamState());
  }

  function getState(node: HTMLElement): TokenStreamState {
    let state = tokenStreamStates.get(node);
    if (!state) {
      state = freshTokenStreamState();
      tokenStreamStates.set(node, state);
    }
    return state;
  }

  function ensureContainers(node: HTMLDivElement, state: TokenStreamState): void {
    if (state.stableEl && state.tailEl && state.session) {
      return;
    }
    const doc = resolveNodeDocument(node);
    const stableEl = doc.createElement("div");
    stableEl.className = "chat-stream-stable markdown-body";
    const tailEl = doc.createElement("div");
    tailEl.className = "chat-stream-tail markdown-body";
    node.appendChild(stableEl);
    node.appendChild(tailEl);
    state.stableEl = stableEl;
    state.tailEl = tailEl;
    state.session = createMarkdownStreamSession(stableEl, tailEl, {
      ...CHAT_MARKDOWN_OPTIONS,
      renderMarkdown: renderMarkdownStripped
    });
  }

  function getRaw(node: HTMLElement): string {
    const state = tokenStreamStates.get(node);
    if (!state) {
      return "";
    }
    const sessionRaw = state.session ? state.session.rawText : "";
    return sessionRaw + state.pending.join("") + state.charQueue;
  }

  function cancelFlush(): void {
    tokenFlushEpoch++;
    if (!tokenFlushFrame) {
      return;
    }
    const frame = tokenFlushFrame;
    tokenFlushFrame = null;
    frame.cancel();
  }

  const flush = async (node: HTMLDivElement) => {
    const epoch = ++tokenFlushEpoch;
    const state = getState(node);
    let delta: string;
    let smoothStep = 0;
    if (deps.isSmoothStream()) {
      const qLen = state.charQueue.length;
      if (qLen === 0) {
        return;
      }
      smoothStep = Math.min(qLen, Math.max(2, Math.ceil(qLen / 5)));
      delta = state.charQueue.slice(0, smoothStep);
    } else {
      delta = state.pending.join("");
    }
    let deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
    ensureContainers(node, state);
    deps.onBodyStart(node);
    if (deps.isSmoothStream()) {
      state.charQueue = state.charQueue.slice(smoothStep);
    } else {
      state.pending.length = 0;
    }
    const sessionRes = state.session!.flush(delta, {
      cursor: state.cursor,
      shouldYield: () => performance.now() >= deadline,
      yieldToMain: async () => {
        if (epoch !== tokenFlushEpoch) {
          return;
        }
        await yieldToActiveMainThread();
        if (epoch !== tokenFlushEpoch) {
          return;
        }
        deadline = performance.now() + STREAM_FRAME_BUDGET_MS;
      },
      isStale: () => epoch !== tokenFlushEpoch
    });
    if (sessionRes && typeof sessionRes.then === "function") {
      await sessionRes;
    }
    if (epoch !== tokenFlushEpoch) {
      return;
    }
    deps.scrollToBottom(false, { instant: true });
    if (deps.isSmoothStream() && state.charQueue.length > 0 && epoch === tokenFlushEpoch) {
      scheduleTokenFlush(node);
    }
  };

  function scheduleTokenFlush(node: HTMLDivElement): void {
    if (tokenFlushFrame) {
      return;
    }
    let fired = false;
    const frame = scheduleMigratingFrame(
      () => {
        fired = true;
        tokenFlushFrame = null;
        flush(node).catch((err: unknown) => {
          console.error("[chat-runtime] 流式渲染 flush 失败：", err);
        });
      },
      { targetNode: node }
    );
    if (!fired) {
      tokenFlushFrame = frame;
    }
  }

  function appendToken(node: HTMLDivElement | null, token: unknown): void {
    if (!node) {
      return;
    }
    const tokenStr = String(token || "");
    const state = getState(node);
    if (deps.isSmoothStream()) {
      state.charQueue += tokenStr;
    } else {
      state.pending.push(tokenStr);
    }
    scheduleTokenFlush(node);
  }

  function mountCursor(node: HTMLDivElement): void {
    const cursor = createStreamCursor(resolveNodeDocument(node));
    const state = getState(node);
    state.cursor = cursor;
    node.appendChild(cursor);
  }

  function initNodeCursor(node: HTMLDivElement): void {
    resetState(node);
    mountCursor(node);
  }

  function flushSyncInitial(node: HTMLDivElement, initialRaw: string): void {
    const state = getState(node);
    state.cursor = createStreamCursor(resolveNodeDocument(node));
    ensureContainers(node, state);
    state.session!.flush(initialRaw, { cursor: state.cursor });
  }

  function resetStreamPreservingCursor(node: HTMLElement): void {
    const state = getState(node);
    const cursor = state.cursor;
    if (state.stableEl) {
      state.stableEl.remove();
    }
    if (state.tailEl) {
      state.tailEl.remove();
    }
    resetState(node);
    const freshState = getState(node);
    freshState.cursor = cursor;
    if (cursor) {
      node.appendChild(cursor);
    }
  }

  function detachStreamDom(node: HTMLElement): void {
    const state = tokenStreamStates.get(node);
    if (!state) {
      return;
    }
    if (state.cursor?.parentNode === node) {
      state.cursor.remove();
    }
    if (state.stableEl?.parentNode === node) {
      state.stableEl.remove();
    }
    if (state.tailEl?.parentNode === node) {
      state.tailEl.remove();
    }
  }

  return {
    getState,
    resetState,
    getRaw,
    appendToken,
    cancelFlush,
    initNodeCursor,
    mountCursor,
    flushSyncInitial,
    resetStreamPreservingCursor,
    detachStreamDom
  };
}
