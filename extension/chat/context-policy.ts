export interface LoadContextResponse {
  ok?: boolean;
  error?: unknown;
  payload?: { unchanged?: unknown; [key: string]: unknown } | null;
}

export interface CurrentConversationMetaLike {
  pinnedContext?: unknown;
}

export const LOAD_CONTEXT_ACTION = Object.freeze({
  NO_TAB: "no-tab",
  SKIP_UNCHANGED: "skip-unchanged",
  ERROR: "error",
  APPLY_PINNED: "apply-pinned",
  BLOCKED_STREAMING: "blocked-streaming",
  APPLY_LIVE_SESSION: "apply-live-session",
  APPLY_LIVE: "apply-live"
} as const);

export interface LoadContextPlan {
  action: (typeof LOAD_CONTEXT_ACTION)[keyof typeof LOAD_CONTEXT_ACTION];
  clearContext?: boolean;
  resetView?: boolean;
  message?: unknown;
  returnValue: boolean;
}

export const NO_TAB_MESSAGE = "找不到当前标签页。";
export const CONTEXT_READ_FAILED_MESSAGE = "当前页面上下文读取失败。";

export function isPinnedContextStrict(currentConversationMeta: CurrentConversationMetaLike | null | undefined): boolean {
  return currentConversationMeta?.pinnedContext === true;
}

export function resolveNoTabPlan({
  hasPinnedConversation = false,
  silent = false,
  isLiveActive = false
}: {
  hasPinnedConversation?: boolean;
  silent?: boolean;
  isLiveActive?: boolean;
} = {}): LoadContextPlan {
  return {
    action: LOAD_CONTEXT_ACTION.NO_TAB,
    clearContext: !hasPinnedConversation,
    resetView: !silent && !hasPinnedConversation && !isLiveActive,
    message: NO_TAB_MESSAGE,
    returnValue: false
  };
}

export interface ResolveLoadContextActionOptions {
  response?: LoadContextResponse | null;
  hasPinnedConversation?: boolean;
  silent?: boolean;
  isStreaming?: boolean;
  hasPendingUserPrompt?: boolean;
  isLiveActive?: boolean;
}

export function resolveLoadContextAction({
  response = null,
  hasPinnedConversation = false,
  silent = false,
  isStreaming = false,
  hasPendingUserPrompt = false,
  isLiveActive = false
}: ResolveLoadContextActionOptions = {}): LoadContextPlan {
  if (response?.ok && response?.payload?.unchanged === true) {
    return { action: LOAD_CONTEXT_ACTION.SKIP_UNCHANGED, returnValue: true };
  }

  if (!response?.ok || !response.payload) {
    return {
      action: LOAD_CONTEXT_ACTION.ERROR,
      clearContext: !hasPinnedConversation,
      resetView: !silent && !hasPinnedConversation && !isLiveActive,
      message: response?.error || CONTEXT_READ_FAILED_MESSAGE,
      returnValue: false
    };
  }

  if (hasPinnedConversation && !isLiveActive) {
    return { action: LOAD_CONTEXT_ACTION.APPLY_PINNED, returnValue: true };
  }

  if (isStreaming || hasPendingUserPrompt) {
    return { action: LOAD_CONTEXT_ACTION.BLOCKED_STREAMING, returnValue: true };
  }

  if (isLiveActive) {
    return { action: LOAD_CONTEXT_ACTION.APPLY_LIVE_SESSION, returnValue: true };
  }

  return { action: LOAD_CONTEXT_ACTION.APPLY_LIVE, returnValue: true };
}
