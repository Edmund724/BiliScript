import { activeById } from "../shared/active-host.js";
import { resolveNodeDocument } from "../shared/cross-doc.js";
import {
  applyLiveContextToMain,
  chatSessionState,
  rebuildCurrentContextKeyFromContext
} from "../chat/chat-state.js";
import { isPinnedContextStrict } from "../chat/context-load.js";
import type { LoadContextStateOptions, StreamInterruptOptions } from "../chat/conversation-store.js";
import type { ViewResetIntent } from "../chat/view-intent.js";
import { confirmDialog as defaultConfirmDialog, type ConfirmDialogOptions } from "../ui/confirm-dialog.js";
import { findSubtitlePreviewAtTime, type TimestampNavDeps } from "../ui/timestamp-nav.js";

export const NON_VIDEO_CONTEXT_MESSAGE = "当前不是视频播放页，<br>无法获取视频信息，<br>仅支持常规对话。";

export interface ScheduleLiveContextSyncOptions {
  forceRefresh?: boolean;
  preserveInput?: boolean;
}

interface RestartChatOptions {
  keepContext?: boolean;
  preserveInput?: boolean;
}

export interface CreateChatContextOrchestratorDeps {
  messagesEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  openSettingsId: string;
  isSessionClosed: () => boolean;
  loadContextState: (opts?: LoadContextStateOptions) => Promise<boolean>;
  detachForRestart: (opts?: StreamInterruptOptions) => void;
  isTurnActive: () => boolean;
  setAutoScroll: (autoScroll: boolean) => void;
  scrollToBottom: (force?: boolean) => void;
  renderReplay: () => void;
  invalidateReplay: () => void;
  updateLayout: () => void;
  autosizeInput: () => void;
  setStreamingUiState: (isStreaming: boolean) => void;
  getInputImageCount: () => number;
  clearInputImages: () => void;
  resetSuggestions: () => void;
  refreshSuggestions: () => void;
  resetScrollFollow: () => void;
  hasSelectableModels: () => boolean;
  getSetupStateHtml: () => string;
  invalidateSetupFlow: () => void;
  showNotice: (
    message: string,
    autoHideMs?: number,
    options?: { placement?: "input" }
  ) => void;
  hideOverlaysForNewChat: () => void;
  seekReadingTarget: (seconds: number) => number | null;
  confirmDialog?: (options: ConfirmDialogOptions) => Promise<boolean>;
}

export interface ChatContextOrchestrator {
  scheduleLiveContextSync: (opts?: ScheduleLiveContextSyncOptions) => void;
  cancelPendingSync: () => void;
  syncLiveContextState: (forceRefresh?: boolean, preserveInput?: boolean) => Promise<void>;
  renderInitialState: () => void;
  resetConversationView: (stateHtml?: string) => void;
  requestViewReset: (intent: ViewResetIntent) => void;
  startNewConversation: () => Promise<boolean>;
  getTimestampNavDeps: () => TimestampNavDeps;
}

export function createChatContextOrchestrator(deps: CreateChatContextOrchestratorDeps): ChatContextOrchestrator {
  let urlChangeSyncTimer = 0;
  const confirmPrompt = deps.confirmDialog ?? defaultConfirmDialog;

  function cancelPendingSync(): void {
    if (urlChangeSyncTimer) {
      window.clearTimeout(urlChangeSyncTimer);
      urlChangeSyncTimer = 0;
    }
  }

  function scheduleLiveContextSync({ forceRefresh = true, preserveInput = false }: ScheduleLiveContextSyncOptions = {}): void {
    if (deps.isSessionClosed()) {
      return;
    }
    if (urlChangeSyncTimer) {
      window.clearTimeout(urlChangeSyncTimer);
    }
    urlChangeSyncTimer = window.setTimeout(() => {
      urlChangeSyncTimer = 0;
      if (deps.isSessionClosed()) {
        return;
      }
      void syncLiveContextState(forceRefresh, preserveInput);
    }, 120);
  }

  async function syncLiveContextState(forceRefresh = false, preserveInput = false): Promise<void> {
    if (deps.isSessionClosed()) {
      return;
    }
    const ok = await deps.loadContextState({ forceRefresh, silent: true, preserveInput }).catch(() => false);
    if (deps.isSessionClosed() || isPinnedContextStrict(chatSessionState.currentConversationMeta) || deps.isTurnActive()) {
      return;
    }
    if (
      !ok
      || !chatSessionState.contextData
      || !chatSessionState.providers.length
      || !deps.hasSelectableModels()
      || !chatSessionState.chatHistory.length
    ) {
      renderInitialState();
      return;
    }
    deps.refreshSuggestions();
  }

  function resetConversationView(stateHtml = ""): void {
    deps.invalidateReplay();
    deps.updateLayout();
    deps.messagesEl.innerHTML = "";
    if (stateHtml) {
      const stateNode = resolveNodeDocument(deps.messagesEl).createElement("div");
      stateNode.className = "chat-center-error";
      stateNode.innerHTML = stateHtml;
      deps.messagesEl.appendChild(stateNode);
    }
    deps.resetSuggestions();
    deps.setAutoScroll(true);
    deps.scrollToBottom(true);
    deps.resetScrollFollow();
  }

  function renderInitialState(): void {
    deps.updateLayout();
    if (!chatSessionState.contextData) {
      resetConversationView("当前页面不是支持的视频页，无法读取视频信息。");
      return;
    }
    if (!chatSessionState.providers.length || !deps.hasSelectableModels()) {
      resetConversationView(deps.getSetupStateHtml());
      return;
    }
    if (chatSessionState.chatHistory.length) {
      deps.renderReplay();
      return;
    }
    if (chatSessionState.contextData.isVideoContext === false) {
      resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
      return;
    }
    resetConversationView("");
  }

  function requestViewReset(intent: ViewResetIntent): void {
    if (intent.kind === "setup") {
      resetConversationView(deps.getSetupStateHtml());
      activeById(deps.openSettingsId)?.focus({ preventScroll: true });
      deps.showNotice("请先配置平台与模型，点击下方「前往设置」", 4000, { placement: "input" });
      return;
    }
    if (intent.kind === "restart") {
      restartChat({ keepContext: intent.keepContext, preserveInput: intent.preserveInput });
      return;
    }
    resetConversationView(intent.html);
  }

  async function startNewConversation(): Promise<boolean> {
    const turnActive = deps.isTurnActive();
    const hasDraft = Boolean(deps.inputEl.value);
    const imageCount = deps.getInputImageCount();
    if (turnActive || hasDraft || imageCount > 0) {
      const risks: string[] = [];
      if (turnActive) risks.push("中断正在生成的回复");
      if (hasDraft) risks.push("清空未发送的草稿");
      if (imageCount > 0) risks.push(`移除 ${imageCount} 张已添加的图片`);
      const confirmed = await confirmPrompt({
        title: "新建会话",
        message: `新建会话会${risks.join("，")}。`,
        confirmText: "新建会话"
      });
      if (!confirmed) return false;
    }
    deps.invalidateSetupFlow();
    deps.hideOverlaysForNewChat();
    await deps.loadContextState({ forceRefresh: true, silent: true });
    if (chatSessionState.liveContextData) {
      applyLiveContextToMain();
    }
    restartChat({ keepContext: true });
    renderInitialState();
    deps.inputEl?.focus?.({ preventScroll: true });
    return true;
  }

  function restartChat({ keepContext = false, preserveInput = false }: RestartChatOptions = {}): void {
    deps.detachForRestart(preserveInput ? { preserveStream: true } : undefined);
    if (!keepContext) {
      rebuildCurrentContextKeyFromContext();
    }
    resetConversationView("");
    deps.setStreamingUiState(false);
    if (!preserveInput) {
      deps.inputEl.value = "";
      deps.clearInputImages();
    }
    deps.autosizeInput();
  }

  function getTimestampNavDeps(): TimestampNavDeps {
    const targetContextKey = String(
      chatSessionState.currentConversationMeta?.contextKey || chatSessionState.currentContextKey || ""
    ).trim();
    return {
      contextUrl: String(chatSessionState.contextData?.url || chatSessionState.currentConversationMeta?.contextUrl || "").trim(),
      isContextValid: () => {
        const liveKey = String(chatSessionState.liveContextKey || "").trim();
        const hasLiveVideo = chatSessionState.liveContextData ? chatSessionState.liveContextData.isVideoContext !== false : true;
        if (!hasLiveVideo) {
          return false;
        }
        return !targetContextKey || !liveKey || targetContextKey === liveKey;
      },
      notice: deps.showNotice,
      seek: (seconds: number) => deps.seekReadingTarget(seconds),
      getSubtitlePreview: (seconds: number) => {
        const body =
          chatSessionState.contextData?.subtitleBody ??
          chatSessionState.currentConversationMeta?.resolvedContext?.subtitleBody;
        return findSubtitlePreviewAtTime(body, seconds);
      },
      tooltipContainer: deps.messagesEl
    };
  }

  return {
    scheduleLiveContextSync,
    cancelPendingSync,
    syncLiveContextState,
    renderInitialState,
    resetConversationView,
    requestViewReset,
    startNewConversation,
    getTimestampNavDeps
  };
}
