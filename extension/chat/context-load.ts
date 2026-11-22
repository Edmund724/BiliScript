import {
  CONTEXT_READ_FAILED_MESSAGE,
  LOAD_CONTEXT_ACTION,
  NO_TAB_MESSAGE,
  isPinnedContextStrict,
  resolveLoadContextAction,
  resolveNoTabPlan
} from "./context-policy.js";
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
import type { LoadContextStateOptions } from "./conversation-store.js";
import type { ViewResetIntent } from "./view-intent.js";

export interface CreateContextLoadDeps {
  fetchContext: ContextFetch;
  renderHistoryList: () => void;
  renderInitialState: () => void;
  renderSuggestions: () => void;
  requestViewReset: (intent: ViewResetIntent) => void;
  restartChat: (opts?: { keepContext?: boolean; preserveInput?: boolean }) => void;
  restoreLatest: () => Promise<boolean>;
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
      const plan = resolveNoTabPlan({ hasPinnedConversation, silent, isLiveActive });
      resetLiveContext();
      if (plan.clearContext) {
        clearMainContext();
      }
      if (plan.resetView) {
        deps.requestViewReset({ kind: "state", html: plan.message ?? NO_TAB_MESSAGE });
      }
      return plan.returnValue;
    }

    noteLiveTabUrl(outcome.tabUrl || "");

    const resp = outcome.kind === "error"
      ? { ok: false as const, error: outcome.error }
      : { ok: true as const, payload: outcome.payload };

    const plan = resolveLoadContextAction({
      response: resp,
      hasPinnedConversation,
      silent,
      isStreaming: deps.isStreaming(),
      hasPendingUserPrompt: deps.hasPendingUserPrompt(),
      isLiveActive
    });

    if (plan.action === LOAD_CONTEXT_ACTION.SKIP_UNCHANGED) {
      return plan.returnValue;
    }

    if (plan.action === LOAD_CONTEXT_ACTION.ERROR) {
      applyLiveContextSnapshot(null);
      if (plan.clearContext) {
        clearMainContext();
      }
      if (plan.resetView) {
        deps.requestViewReset({ kind: "state", html: plan.message ?? CONTEXT_READ_FAILED_MESSAGE });
      }
      return plan.returnValue;
    }

    applyLiveContextSnapshot(resp.payload as ChatSessionContextSnapshot);

    if (plan.action === LOAD_CONTEXT_ACTION.APPLY_LIVE_SESSION) {
      const oldKey = chatSessionState.currentContextKey;
      const nextKey = buildContextKey(resp.payload as AiContext);
      const isVideoSwitch = Boolean(oldKey && nextKey && nextKey !== oldKey);

      if (isVideoSwitch) {
        const contextChanged = applyContextPayload(resp.payload as ChatSessionContextSnapshot | null, preserveInput);
        deps.renderHistoryList();
        if (contextChanged) {
          await deps.restoreLatest();
          deps.renderInitialState();
        }
        return plan.returnValue;
      }

      applyLiveContextToMain();
      deps.renderHistoryList();
      return plan.returnValue;
    }

    if (
      plan.action === LOAD_CONTEXT_ACTION.APPLY_PINNED ||
      plan.action === LOAD_CONTEXT_ACTION.BLOCKED_STREAMING
    ) {
      deps.renderHistoryList();
      return plan.returnValue;
    }

    const contextChanged = applyContextPayload(resp.payload as ChatSessionContextSnapshot | null, preserveInput);
    deps.renderHistoryList();
    if (contextChanged) {
      await deps.restoreLatest();
      deps.renderInitialState();
    }
    return plan.returnValue;
  }

  function applyContextPayload(payload: ChatSessionContextSnapshot | null, preserveInput: boolean): boolean {
    const contextChanged = applyContextSnapshot(payload);

    if (contextChanged) {
      deps.restartChat({ keepContext: true, preserveInput });
    } else {
      deps.renderSuggestions();
    }
    return contextChanged;
  }

  return { loadContextState };
}
