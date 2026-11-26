import { resolveNodeDocument } from "../shared/cross-doc.js";
import { findSubtitlePreviewAtTime, type TimestampNavDeps } from "../ui/timestamp-nav.js";
import { confirmDialog as defaultConfirmDialog, type ConfirmDialogOptions } from "../ui/confirm-dialog.js";
import type { CaptureCurrentVideoFrame, ImagePart } from "../ai/types.js";
import type { ClipState } from "../core/state.js";
import type { Settings } from "../core/defaults.js";
import {
  createInProcessContextFetch,
  createInProcessPinnedContextResolver,
  type ContextFetch
} from "../core/context-assembly.js";
import { resolveAiConversationContext, resolveAiConversationPageRef } from "../ai/context-resolver.js";
import {
  applyLiveContextToMain,
  chatSessionState
} from "./chat-state.js";
import {
  createChatRuntime,
  type ChatPort,
  type ChatRuntimeUi,
  type SendTurnOptions,
  type SendVerdict
} from "./chat-runtime.js";
import {
  createConversationStore,
  type ConversationChange,
  type ConversationContextNotice,
  type ConversationDeletion,
  type LoadContextStateOptions,
  type StorageArea,
  type StreamInterruptOptions
} from "./conversation-store.js";
import { createContextLoad, isPinnedContextStrict } from "./context-load.js";
import { createSendGate, type StartSubtitleFetchOptions } from "./send-gate.js";
import { createConversationReplay } from "./replay.js";

export {
  chatSessionState,
  applyLiveContextToMain,
  rebuildCurrentContextKeyFromContext
} from "./chat-state.js";
export { OFFSCREEN_CHAT_PORT_NAME } from "./protocol.js";
export {
  CONVERSATIONS_STORAGE_KEY,
  syncSavedConversationsFromStorage
} from "./conversation-store.js";
export {
  hasExternalizedChatImages,
  readConversationHistory
} from "./conversation-storage.js";
export { parseModelOptionValue } from "../shared/selected-provider.js";

export const NON_VIDEO_CONTEXT_MESSAGE = "当前不是视频播放页，<br>无法获取视频信息，<br>仅支持常规对话。";

export interface ScheduleLiveContextSyncOptions {
  forceRefresh?: boolean;
  preserveInput?: boolean;
}

export type ChatTabDomainUi = Omit<ChatRuntimeUi, "showSetupBlockedState">;

export interface ChatTabViewAdapter {
  hasSelectableModels: () => boolean;
  getSetupStateHtml: () => string;
  focusSetupAction?: () => void;
  getInputImageCount: () => number;
  clearInputImages: () => void;
  suggestions: {
    refresh: () => void;
    clear: () => void;
    reset: () => void;
  };
  resetScrollFollow: () => void;
  prepareForNewConversation: () => void;
  seekReadingTarget: (seconds: number) => number | null;
  confirmDialog?: (options: ConfirmDialogOptions) => Promise<boolean>;
}

export interface CreateChatTabDomainDeps {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  ui: ChatTabDomainUi;
  view: ChatTabViewAdapter;
  onConversationChanged: (change: ConversationChange) => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  renderHistoryList: () => void;
  storage?: StorageArea;
  clip: () => Partial<ClipState>;
  settings: () => Partial<Settings>;
  fetchContext?: ContextFetch;
  isSessionClosed: () => boolean;
  isReaderTranscribing: () => boolean;
  asrNotice: HTMLElement | null;
  pageBvid: () => string | null;
  startSubtitleFetch: (options?: StartSubtitleFetchOptions) => Promise<boolean>;
  subscribeStatusPhase: (listener: (phase: string) => void) => () => void;
  onWaitingChange?: (waiting: boolean) => void;
  onRetrySubtitleReady?: () => boolean | Promise<boolean>;
  getProviderId: () => string;
  getSelectedModel: () => string;
  getInputImages?: () => ImagePart[];
  takeInputImages?: (snapshot: ImagePart[]) => ImagePart[];
  canUseVideoFrameTool?: () => Promise<boolean>;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  getPlaybackCursorSeconds?: () => number | undefined;
  connectPort: () => Promise<ChatPort> | ChatPort;
  getSpeechVolume?: () => number | undefined;
  isLiveActive?: () => boolean;
  syncDebounceMs?: number;
}

export interface ChatTabDomain {
  sendTurn: (text: string, options?: SendTurnOptions) => Promise<SendVerdict>;
  stopActiveStream: () => void;
  settleTurn: () => Promise<void>;
  isTurnActive: () => boolean;
  isStreaming: () => boolean;
  cancelSubtitleWait: () => void;
  isNoSubtitleBlocked: () => boolean;
  stopSpeech: () => void;
  closeImageViewer: (opts?: { restoreFocus?: boolean }) => void;
  setAutoScroll: (autoScroll: boolean) => void;
  scrollToBottom: (force?: boolean, opts?: { instant?: boolean }) => void;
  getTimestampNavDeps: () => TimestampNavDeps;
  loadConversations: () => Promise<void>;
  restoreLatestConversation: () => Promise<boolean>;
  loadContextState: (opts?: LoadContextStateOptions) => Promise<boolean>;
  renderInitialState: () => void;
  scheduleLiveContextSync: (opts?: ScheduleLiveContextSyncOptions) => void;
  handleHostClipChanged: () => void;
  startNewConversation: () => Promise<boolean>;
  openConversation: (id: string) => void;
  deleteConversation: (id: string) => Promise<ConversationDeletion | null>;
  clearConversations: () => Promise<void>;
  bindStatusBus: () => () => void;
  closeSession: (opts?: { resetRuntime?: boolean }) => void;
}

export function createChatTabDomain(deps: CreateChatTabDomainDeps): ChatTabDomain {
  let urlChangeSyncTimer = 0;
  let suppressInterruptViewResetDepth = 0;
  let contextLoadRenderSeq = 0;
  const syncDebounceMs = deps.syncDebounceMs ?? 120;
  const confirmPrompt = deps.view.confirmDialog ?? defaultConfirmDialog;

  function cancelPendingSync(): void {
    if (urlChangeSyncTimer) {
      window.clearTimeout(urlChangeSyncTimer);
      urlChangeSyncTimer = 0;
    }
  }

  function resetConversationView(stateHtml = ""): void {
    replay.invalidate();
    deps.ui.autosizeInput();
    deps.messages.innerHTML = "";
    if (stateHtml) {
      const stateNode = resolveNodeDocument(deps.messages).createElement("div");
      stateNode.className = "chat-center-error";
      stateNode.innerHTML = stateHtml;
      deps.messages.appendChild(stateNode);
    }
    deps.view.suggestions.reset();
    runtime.setAutoScroll(true);
    runtime.scrollToBottom(true);
    deps.view.resetScrollFollow();
  }

  function renderInitialState(): void {
    if (!chatSessionState.contextData) {
      resetConversationView("当前页面不是支持的视频页，无法读取视频信息。");
      return;
    }
    if (!chatSessionState.providers.length || !deps.view.hasSelectableModels()) {
      resetConversationView(deps.view.getSetupStateHtml());
      return;
    }
    if (chatSessionState.chatHistory.length) {
      replay.render();
      return;
    }
    if (chatSessionState.contextData.isVideoContext === false) {
      resetConversationView(NON_VIDEO_CONTEXT_MESSAGE);
      return;
    }
    resetConversationView("");
  }

  function showSetupBlockedState(): void {
    resetConversationView(deps.view.getSetupStateHtml());
    deps.view.focusSetupAction?.();
    deps.ui.inputNotice.show("请先配置平台与模型，点击下方「前往设置」", 4000);
  }

  function detachForContextReset({ preserveInput = false }: { preserveInput?: boolean } = {}): void {
    suppressInterruptViewResetDepth += 1;
    try {
      store.detachForRestart(preserveInput ? { preserveStream: true } : undefined);
    } finally {
      suppressInterruptViewResetDepth -= 1;
    }
    if (!preserveInput) {
      deps.input.value = "";
      deps.view.clearInputImages();
    }
  }

  function restoreLatestSilently(opts?: StreamInterruptOptions): Promise<boolean> {
    suppressInterruptViewResetDepth += 1;
    try {
      return store.restoreLatest(opts);
    } finally {
      suppressInterruptViewResetDepth -= 1;
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
    }, syncDebounceMs);
  }

  async function syncLiveContextState(forceRefresh = false, preserveInput = false): Promise<void> {
    if (deps.isSessionClosed()) {
      return;
    }
    const renderSeqBefore = contextLoadRenderSeq;
    const ok = await contextLoad.loadContextState({ forceRefresh, silent: true, preserveInput }).catch(() => false);
    if (deps.isSessionClosed() || isPinnedContextStrict(chatSessionState.currentConversationMeta) || runtime.isTurnActive()) {
      return;
    }
    if (ok && contextLoadRenderSeq > renderSeqBefore) {
      return;
    }
    if (
      !ok
      || !chatSessionState.contextData
      || !chatSessionState.providers.length
      || !deps.view.hasSelectableModels()
      || !chatSessionState.chatHistory.length
    ) {
      renderInitialState();
      return;
    }
    deps.view.suggestions.refresh();
  }

  async function startNewConversation(): Promise<boolean> {
    const turnActive = runtime.isTurnActive();
    const hasDraft = Boolean(deps.input.value);
    const imageCount = deps.view.getInputImageCount();
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
    deps.view.prepareForNewConversation();
    await contextLoad.loadContextState({ forceRefresh: true, silent: true });
    if (chatSessionState.liveContextData) {
      applyLiveContextToMain();
    }
    detachForContextReset();
    renderInitialState();
    deps.input?.focus?.({ preventScroll: true });
    return true;
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
      notice: (message, autoHideMs) => deps.ui.messagesNotice.show(message, autoHideMs),
      seek: (seconds: number) => deps.view.seekReadingTarget(seconds),
      getSubtitlePreview: (seconds: number) => {
        const body =
          chatSessionState.contextData?.subtitleBody ??
          chatSessionState.currentConversationMeta?.resolvedContext?.subtitleBody;
        return findSubtitlePreviewAtTime(body, seconds);
      },
      tooltipContainer: deps.messages
    };
  }

  const resolveConversationContext = createInProcessPinnedContextResolver({
    clip: deps.clip,
    settings: deps.settings,
    resolveNetwork: resolveAiConversationContext
  });
  const store = createConversationStore({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    resolveAiConversationRef: (contextRef, purpose) =>
      purpose === "page" ? resolveAiConversationPageRef(contextRef) : resolveConversationContext(contextRef),
    onConversationChanged: (change) => {
      deps.onConversationChanged(change);
      if (change.resetView) {
        renderInitialState();
      }
    },
    onStreamInterrupted: (opts) => {
      if (!opts?.preserveStream) {
        runtime.resetStreamState();
      }
      deps.ui.setStreamingUiState(false);
      if (suppressInterruptViewResetDepth === 0) {
        resetConversationView();
      }
    },
    onContextNotice: deps.onContextNotice,
    storage: deps.storage
  });
  const contextLoad = createContextLoad({
    fetchContext:
      deps.fetchContext ??
      createInProcessContextFetch({
        clip: deps.clip,
        settings: deps.settings
      }),
    renderHistoryList: deps.renderHistoryList,
    renderInitialState: () => {
      contextLoadRenderSeq += 1;
      renderInitialState();
    },
    renderSuggestions: deps.view.suggestions.refresh,
    showStateMessage: (html) => resetConversationView(html),
    onContextChanged: ({ preserveInput }) => {
      detachForContextReset({ preserveInput });
    },
    restoreLatest: (opts) => restoreLatestSilently(opts),
    isStreaming: () => runtime.isStreaming(),
    hasPendingUserPrompt: () => runtime.hasPendingUserPrompt(),
    isLiveActive: deps.isLiveActive
  });
  const sendGate = createSendGate({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    hydratePinned: (opts) => store.hydratePinned(opts),
    inputNotice: deps.ui.inputNotice,
    replayInFlight: () => replay?.inFlight ?? null,
    isSessionClosed: deps.isSessionClosed,
    isReaderTranscribing: deps.isReaderTranscribing,
    asrNotice: deps.asrNotice,
    pageBvid: deps.pageBvid,
    clip: () => deps.clip() as ClipState,
    startSubtitleFetch: deps.startSubtitleFetch,
    subscribeStatusPhase: deps.subscribeStatusPhase,
    onWaitingChange: deps.onWaitingChange,
    onRetrySubtitleReady: deps.onRetrySubtitleReady
  });
  const runtime = createChatRuntime({
    messages: deps.messages,
    input: deps.input,
    store,
    ui: {
      ...deps.ui,
      showSetupBlockedState
    },
    ensureCurrentContextForSend: () => sendGate.ensureContextForSend(),
    getProviderId: deps.getProviderId,
    getSelectedModel: deps.getSelectedModel,
    getInputImages: deps.getInputImages,
    takeInputImages: deps.takeInputImages,
    canUseVideoFrameTool: deps.canUseVideoFrameTool,
    captureCurrentVideoFrame: deps.captureCurrentVideoFrame,
    getPlaybackCursorSeconds: deps.getPlaybackCursorSeconds,
    getTimestampNavDeps,
    connectPort: deps.connectPort,
    isCostGuardEnabled: () => deps.settings().enableCostGuard === true,
    getSpeechVolume: deps.getSpeechVolume,
    smoothStream: true
  });
  const replay = createConversationReplay({
    renderer: runtime,
    updateLayout: deps.ui.autosizeInput,
    clearSuggestions: deps.view.suggestions.clear
  });

  function openConversation(id: string): void {
    runtime.stopSpeech();
    store.applyById(id);
  }

  function handleHostClipChanged(): void {
    sendGate.cancel();
    store.detachForRestart();
    scheduleLiveContextSync();
  }

  function bindStatusBus(): () => void {
    sendGate.bindStatusBus();
    return () => sendGate.unbindStatusBus();
  }

  function closeSession({ resetRuntime = true }: { resetRuntime?: boolean } = {}): void {
    cancelPendingSync();
    if (!resetRuntime) {
      return;
    }
    runtime.resetStreamState();
    deps.ui.setStreamingUiState(false);
    deps.view.resetScrollFollow();
    sendGate.cancel();
    deps.onWaitingChange?.(false);
    replay.invalidate();
    sendGate.refreshAsrNotice();
  }

  return {
    sendTurn: runtime.sendTurn,
    stopActiveStream: runtime.stopActiveStream,
    settleTurn: runtime.settleTurn,
    isTurnActive: runtime.isTurnActive,
    isStreaming: runtime.isStreaming,
    cancelSubtitleWait: sendGate.cancel,
    isNoSubtitleBlocked: sendGate.isNoSubtitleBlocked,
    stopSpeech: runtime.stopSpeech,
    closeImageViewer: runtime.closeImageViewer,
    setAutoScroll: runtime.setAutoScroll,
    scrollToBottom: runtime.scrollToBottom,
    getTimestampNavDeps,
    loadConversations: store.loadAll,
    restoreLatestConversation: () => restoreLatestSilently(),
    loadContextState: contextLoad.loadContextState,
    renderInitialState,
    scheduleLiveContextSync,
    handleHostClipChanged,
    startNewConversation,
    openConversation,
    deleteConversation: store.deleteById,
    clearConversations: store.clearAll,
    bindStatusBus,
    closeSession
  };
}
