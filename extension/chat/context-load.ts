import { buildContextKey, type AiContext } from "../ai/conversation.js";
import {
  applyContextSnapshot,
  applyLiveContextSnapshot,
  applyLiveContextToMain,
  chatSessionState,
  clearMainContext,
  noteLiveTabUrl,
  resetLiveContext
} from "./chat-state.js";
import type { ChatSessionContextSnapshot } from "./chat-state.js";
import type { ContextFetch, ContextFetchOutcome } from "../core/context-assembly.js";
import type { LoadContextStateOptions, StreamInterruptOptions } from "./conversation-store.js";
import type { ViewResetIntent } from "./view-intent.js";

export const NO_TAB_MESSAGE = "找不到当前标签页。";
export const CONTEXT_READ_FAILED_MESSAGE = "当前页面上下文读取失败。";

export function isPinnedContextStrict(
  currentConversationMeta: { pinnedContext?: unknown } | null | undefined
): boolean {
  return currentConversationMeta?.pinnedContext === true;
}

export interface CreateContextLoadDeps {
  fetchContext: ContextFetch;
  renderHistoryList: () => void;
  renderInitialState: () => void;
  renderSuggestions: () => void;
  requestViewReset: (intent: ViewResetIntent) => void;
  restoreLatest: (opts?: StreamInterruptOptions) => Promise<boolean>;
  isStreaming: () => boolean;
  hasPendingUserPrompt: () => boolean;
  isLiveActive?: () => boolean;
}

export interface ContextLoad {
  loadContextState: (opts?: LoadContextStateOptions) => Promise<boolean>;
}

export function createContextLoad(deps: CreateContextLoadDeps): ContextLoad {
  async function loadContextState({ forceRefresh = false, silent = false, preserveInput = false }: LoadContextStateOptions = {}): Promise<boolean> {
    const hasPinnedConversation = isPinnedContextStrict(chatSessionState.currentConversationMeta);
    const isLiveActive = Boolean(deps.isLiveActive?.());
    const outcome = await deps
      .fetchContext({ forceRefresh, ifSignature: String(chatSessionState.liveContextData?.signature || "") })
      .catch((error: unknown) => ({ kind: "error", error: (error as Error)?.message }) as ContextFetchOutcome);

    if (outcome.kind === "no-tab") {
      resetLiveContext();
      if (!hasPinnedConversation) {
        clearMainContext();
      }
      if (!silent && !hasPinnedConversation && !isLiveActive) {
        deps.requestViewReset({ kind: "state", html: NO_TAB_MESSAGE });
      }
      return false;
    }

    noteLiveTabUrl(outcome.tabUrl || "");

    if (outcome.kind === "payload" && (outcome.payload as { unchanged?: unknown } | null)?.unchanged === true) {
      return true;
    }

    if (outcome.kind !== "payload" || !outcome.payload) {
      const rawError = outcome.kind === "error" ? outcome.error : undefined;
      const message = typeof rawError === "string" && rawError ? rawError : CONTEXT_READ_FAILED_MESSAGE;
      applyLiveContextSnapshot(null);
      if (!hasPinnedConversation) {
        clearMainContext();
      }
      if (!silent && !hasPinnedConversation && !isLiveActive) {
        deps.requestViewReset({ kind: "state", html: message });
      }
      return false;
    }

    const payload = outcome.payload as ChatSessionContextSnapshot;
    applyLiveContextSnapshot(payload);

    if (hasPinnedConversation && !isLiveActive) {
      deps.renderHistoryList();
      return true;
    }

    if (deps.isStreaming() || deps.hasPendingUserPrompt()) {
      deps.renderHistoryList();
      return true;
    }

    if (isLiveActive) {
      const oldKey = chatSessionState.currentContextKey;
      const nextKey = buildContextKey(payload as AiContext);
      const isVideoSwitch = Boolean(oldKey && nextKey && nextKey !== oldKey);

      if (isVideoSwitch) {
        const contextChanged = applyContextPayload(payload, preserveInput);
        deps.renderHistoryList();
        if (contextChanged) {
          await (preserveInput ? deps.restoreLatest({ preserveStream: true }) : deps.restoreLatest());
          deps.renderInitialState();
        }
        return true;
      }

      applyLiveContextToMain();
      deps.renderHistoryList();
      return true;
    }

    const contextChanged = applyContextPayload(payload, preserveInput);
    deps.renderHistoryList();
    if (contextChanged) {
      await (preserveInput ? deps.restoreLatest({ preserveStream: true }) : deps.restoreLatest());
      deps.renderInitialState();
    }
    return true;
  }

  function applyContextPayload(payload: ChatSessionContextSnapshot | null, preserveInput: boolean): boolean {
    const contextChanged = applyContextSnapshot(payload);

    if (contextChanged) {
      deps.requestViewReset({ kind: "restart", keepContext: true, preserveInput });
    } else {
      deps.renderSuggestions();
    }
    return contextChanged;
  }

  return { loadContextState };
}
