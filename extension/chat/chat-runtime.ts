import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { AiContext, CaptureCurrentVideoFrame, ImagePart } from "../ai/types.js";
import type { InteractionAnchorHint } from "../ai/chat-hybrid-retrieval.js";
import { buildContextKey, generateConversationId } from "../ai/conversation.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { resolveWebSearchOptIn, SEARCH_OPT_IN_DECLINED_NOTICE } from "../search/opt-in-notice.js";
import type { ConversationStore } from "./conversation-store.js";
import {
  appendChatHistory,
  applyConversationIdentity,
  chatSessionState,
  clearConversationIdentity,
  ensureConversationId,
  type ChatSessionMessage
} from "./chat-state.js";
import { consumeRuntimeLastError } from "../shared/messaging.js";
import { sanitizeFileName } from "../shared/string-utils.js";
import type { ChatPortMessage } from "./protocol.js";
import type { GateOutcome } from "./send-gate.js";
import type { ViewResetIntent } from "./view-intent.js";
import { classifyOverviewSetupError, type OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { createTurnLifecycle, type SendVerdict } from "./turn-lifecycle.js";
import { createChatStreamRenderer, type ChatAssistantTurn, type ChatInPlaceSession } from "./chat-stream-render.js";
import { imageUnsupportedErrorHint } from "./image-support.js";
import { createChatSpeechController, type ChatSpeechEngine } from "./chat-speech.js";

const STREAM_SLOW_NOTICE_MS = 15000;

export interface SendTurnOptions {
  preserveInputDraft?: boolean;
  interactionAnchor?: InteractionAnchorHint;
}

export interface ChatPort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

export type { ChatPortMessage };

export interface ChatRuntimeStore {
  isCurrent(id: string): boolean;
  persistCurrent(): Promise<void>;
}

export interface ChatRuntimeUi {
  setStreamingUiState: (isStreaming: boolean, options?: { stopping?: boolean }) => void;
  showConversationContextNotice: (
    message: string,
    autoHideMs?: number,
    options?: {
      openSettingsAction?: boolean;
      spinner?: boolean;
      settingsTarget?: "asr";
      placement?: "input";
      action?: { label: string; onClick: () => void };
    }
  ) => void;
  removeConversationContextNotice: () => void;
  hideHistoryPopover: () => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  requestViewReset: (intent: ViewResetIntent) => void;
  autosizeInput: () => void;
  onTurnFailedRestoreDraft?: (draft: { text: string; images: ImagePart[]; isSetupError: boolean }) => void;
  onSetupRequired?: (errorClass: OverviewSetupErrorClass, providerId: string) => void;
}

export interface CreateChatRuntimeDeps {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  store: ChatRuntimeStore;
  ui: ChatRuntimeUi;
  ensureCurrentContextForSend: () => Promise<GateOutcome>;
  getProviderId: () => string;
  getSelectedModel: () => string;
  getInputImages?: () => ImagePart[];
  takeInputImages?: (snapshot: ImagePart[]) => ImagePart[];
  canUseVideoFrameTool?: () => Promise<boolean>;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  getPlaybackCursorSeconds?: () => number | undefined;
  getTimestampNavDeps: () => TimestampNavDeps;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  connectPort: () => Promise<ChatPort> | ChatPort;
  confirmCostGuard?: (message: string) => boolean | Promise<boolean>;
  confirmRegenerationContext?: (message: string) => boolean | Promise<boolean>;
  speechEngine?: ChatSpeechEngine;
  getSpeechVolume?: () => number | undefined;
  smoothStream?: boolean;
  onContinue?: (historyIndex: number, node: HTMLDivElement) => void;
}

export function createChatRuntime(deps: CreateChatRuntimeDeps) {
  let activePort: ChatPort | null = null;
  type BranchKind = "regenerate" | "continue-empty" | "continue-append";
  interface ActiveBranch {
    kind: BranchKind;
    originalHistory: ChatSessionMessage[];
    userIndex: number;
    historyIndex: number;
    initialRaw: string;
    userPrompt: string;
    hasNewOutput: boolean;
    context: AiContext | null;
    contextKey: string;
    contextMismatched: boolean;
    session: ChatInPlaceSession;
  }

  let activeTurn: ChatAssistantTurn | null = null;
  let activeBranch: ActiveBranch | null = null;
  let activeUserPrompt = "";
  let activeUserNode: HTMLDivElement | null = null;
  let activeTurnProviderId = "";
  let activeUserImages: ImagePart[] = [];
  let activeUserContextKey = "";
  let pendingToolMessages: ChatSessionMessage[] = [];
  let turnTruncatedNotice = "";
  let activeConversationId = "";
  let streamSlowNoticeTimer = 0;
  let streamFirstTokenReceived = false;
  let sendInFlight = false;
  let acceptanceEpoch = 0;
  let pendingRetryDraft: { images: ImagePart[] } | null = null;
  let pendingSendOptions: SendTurnOptions | null = null;
  let activePreserveInputDraft = false;
  let lastAckedContextKey: string | null = null;
  const pendingVideoFrames = new Map<string, AbortController>();
  const activeToolCalls = new Set<string>();
  let activeToolGeneration = 0;

  const turn = createTurnLifecycle({
    accepting: {
      get: () => sendInFlight,
      set: (value) => {
        sendInFlight = value;
      }
    },
    isStreaming: () => activePort !== null,
    stopStream: () => stopStreamNow(),
    forceReset: () => {
      resetStreamState();
      setStreamingUiState(false);
    },
    runAcceptance: (text) => runAcceptance(text)
  });

  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    deps.ui.setStreamingUiState(isStreaming, { stopping });
    messageArea.setRegenerationDisabled(isStreaming || turn.isActive() || activeBranch !== null);
  }
  function noteBranchOutput(chunk: unknown): void {
    if (activeBranch && String(chunk ?? "").length > 0) {
      activeBranch.hasNewOutput = true;
    }
  }
  function getBranchSliceEnd(branch: ActiveBranch): number {
    return branch.kind === "continue-append" ? branch.historyIndex : branch.userIndex + 1;
  }
  function buildBranchRequestHistory(branch: ActiveBranch): ChatSessionMessage[] {
    if (branch.kind === "continue-append") {
      return [
        ...branch.originalHistory.slice(0, branch.userIndex),
        branch.originalHistory[branch.userIndex],
        { role: "assistant", content: branch.initialRaw }
      ];
    }
    return branch.originalHistory.slice(0, branch.userIndex);
  }
  function settleActiveBranchSession(committed: boolean): void {
    if (!activeBranch) {
      return;
    }
    if (committed) {
      activeBranch.session.commit();
    } else {
      activeBranch.session.restore();
    }
  }
  function abortAllVideoFrames(): void {
    const controllers = [...pendingVideoFrames.values()];
    pendingVideoFrames.clear();
    for (const controller of controllers) controller.abort();
  }
  const speech = createChatSpeechController({
    engine: deps.speechEngine,
    getVolume: deps.getSpeechVolume,
    onError: (message) => deps.ui.showConversationContextNotice(message, 4000)
  });
  const { scrollToBottom, setAutoScroll, messageArea } = createChatStreamRenderer({
    ...deps,
    onRegenerate: (historyIndex, node) => startBranch("regenerate", historyIndex, node),
    onContinue: (historyIndex, node) => {
      deps.onContinue?.(historyIndex, node);
      startBranch("continue", historyIndex, node);
    },
    onExport: exportAssistant,
    onNotice: (message) => deps.ui.showConversationContextNotice(message, 4000),
    onSpeak: (messageId, button, text) => speech.toggle(button, text, { messageId }),
    onClear: () => speech.stop(),
    isRegenerationDisabled: () => turn.isActive() || activeBranch !== null
  });
  function dispatchChatPortMessage(msg: ChatPortMessage | null | undefined, port: ChatPort | null): void {
    if (!msg) return;
    if (typeof msg.cachedContextKey === "string" && msg.cachedContextKey) {
      lastAckedContextKey = msg.cachedContextKey;
    }
    if (msg.type === "video-frame-cancel") {
      const controller = pendingVideoFrames.get(msg.requestId);
      pendingVideoFrames.delete(msg.requestId);
      controller?.abort();
      return;
    }
    if (msg.type === "video-frame-request") {
      if (!port) return;
      const controller = new AbortController();
      pendingVideoFrames.get(msg.requestId)?.abort();
      pendingVideoFrames.set(msg.requestId, controller);
      void (async () => {
        try {
          if (!deps.captureCurrentVideoFrame) {
            throw new Error("当前页面不支持视频截图");
          }
          const captureResult = await deps.captureCurrentVideoFrame(msg.targetTime, controller.signal);
          if (controller.signal.aborted || pendingVideoFrames.get(msg.requestId) !== controller) return;
          port.postMessage({
            action: "video-frame-result",
            requestId: msg.requestId,
            ...(Array.isArray(captureResult)
              ? { frames: captureResult }
              : { image: captureResult.image, currentTime: captureResult.currentTime })
          });
        } catch (error) {
          if (controller.signal.aborted) return;
          try {
            port.postMessage({
              action: "video-frame-result",
              requestId: msg.requestId,
              error: String((error as Error)?.message || error)
            });
          } catch {}
        } finally {
          if (pendingVideoFrames.get(msg.requestId) === controller) {
            pendingVideoFrames.delete(msg.requestId);
          }
        }
      })();
      return;
    }
    if (msg.type === "reasoning") {
      handleFirstStreamToken();
      noteBranchOutput(msg.data);
      activeTurn?.appendThinking(msg.data);
    } else if (msg.type === "token") {
      handleFirstStreamToken();
      noteBranchOutput(msg.data);
      activeTurn?.appendToken(msg.data);
    } else if (msg.type === "token-batch") {
      handleFirstStreamToken();
      for (const token of Array.isArray(msg.data) ? msg.data : []) {
        if (typeof token === "string") {
          noteBranchOutput(token);
          activeTurn?.appendToken(token);
        }
      }
    } else if (msg.type === "stream-reset") {
      const nextGeneration = typeof msg.generation === "number" ? msg.generation : activeToolGeneration + 1;
      if (nextGeneration <= activeToolGeneration) {
        return;
      }
      activeToolGeneration = nextGeneration;
      pendingToolMessages = [];
      turnTruncatedNotice = "";
      if (activeBranch) {
        activeBranch.hasNewOutput = false;
      }
      activeToolCalls.clear();
      activeTurn?.reset();
    } else if (msg.type === "done") {
      finalizeAssistant(activeTurn);
    } else if (msg.type === "stopped") {
      handleAssistantStopped(activeTurn, msg.reason || "已停止生成");
    } else if (msg.type === "error") {
      if (msg.code === "subtitle-body-missing") {
        lastAckedContextKey = null;
      }
      const setupErrorClass = classifyOverviewSetupError(msg.error);
      const setupProviderId = activeTurnProviderId;
      showAssistantError(activeTurn, msg.error || "未知错误");
      if (setupErrorClass) {
        deps.ui.onSetupRequired?.(setupErrorClass, setupProviderId);
      }
    } else if (msg.type === "notice") {
      if (msg.code === "truncated") {
        turnTruncatedNotice = String(msg.data || "");
      } else {
        deps.ui.showConversationContextNotice(msg.data, 4000);
      }
    } else if (msg.type === "tool-status") {
      if (typeof msg.generation === "number" && msg.generation !== activeToolGeneration) {
        return;
      }
      const activityId = msg.callId || `${msg.tool || "web_search"}:${msg.query}`;
      if (msg.status === "searching") {
        activeToolCalls.add(activityId);
        clearStreamSlowNoticeTimer();
        deps.ui.removeConversationContextNotice();
      } else {
        activeToolCalls.delete(activityId);
        if (!activeToolCalls.size && activePort && !streamFirstTokenReceived) {
          armStreamSlowNoticeTimer();
        }
      }
      activeTurn?.applySearchStatus(msg);
    } else if (msg.type === "tool-turn") {
      if (typeof msg.generation === "number" && msg.generation !== activeToolGeneration) {
        return;
      }
      if (Array.isArray(msg.messages)) {
        pendingToolMessages.push(
          ...msg.messages.filter((m) => Boolean(m && typeof m === "object" && typeof (m as { role?: unknown }).role === "string"))
        );
      }
    } else if (msg.type === "cost-guard") {
      const confirmCostGuard = deps.confirmCostGuard || ((message: string) => confirmDialog({ message, confirmText: "继续" }));
      const replyPort = port;
      const guardMessage =
        typeof msg.data?.message === "string" && msg.data.message
          ? msg.data.message
          : "预计会有多次调用，是否继续？";
      void Promise.resolve(confirmCostGuard(guardMessage)).then((ok) => {
        try {
          replyPort?.postMessage({ action: "cost-guard-confirm", ok: Boolean(ok) });
        } catch {
        }
      });
    }
  }

  async function sendTurn(text: string, options?: SendTurnOptions): Promise<SendVerdict> {
    const canAttempt = Boolean(String(text ?? "").trim()) && !turn.isActive();
    if (canAttempt) {
      pendingSendOptions = options ?? null;
    }
    messageArea.setRegenerationDisabled(true);
    try {
      return await turn.send(text);
    } finally {
      if (canAttempt) {
        pendingSendOptions = null;
      }
      if (!turn.isActive()) {
        messageArea.setRegenerationDisabled(false);
      }
    }
  }

  function resolveBranchContext(originalHistory: ChatSessionMessage[], userIndex: number): {
    context: AiContext | null;
    contextKey: string;
    contextMismatched: boolean;
  } | null {
    const userMessage = originalHistory[userIndex];
    const meta = chatSessionState.currentConversationMeta;
    const contextKey = String(userMessage?.contextKey || meta?.contextKey || chatSessionState.currentContextKey || "").trim();
    const contextCandidates = [
      meta?.resolvedContext,
      ...(!meta || meta.resolvedContext ? [chatSessionState.contextData] : [])
    ];
    const originalContext = contextKey
      ? contextCandidates.find((candidate) => candidate && buildContextKey(candidate) === contextKey)
      : meta?.resolvedContext || chatSessionState.contextData;
    if (contextKey && !originalContext) {
      return null;
    }
    const currentPageKey = String(chatSessionState.liveContextKey || chatSessionState.currentContextKey || "").trim();
    return {
      context: originalContext ? { ...originalContext } : null,
      contextKey,
      contextMismatched: Boolean(contextKey && currentPageKey && contextKey !== currentPageKey)
    };
  }

  function startBranch(action: "regenerate" | "continue", historyIndex: number, node: HTMLDivElement): void {
    if (turn.isActive() || activeBranch) {
      return;
    }
    const originalHistory = [...chatSessionState.chatHistory];
    const targetMessage = originalHistory[historyIndex];
    if (targetMessage?.role !== "assistant") {
      return;
    }
    let userIndex = historyIndex - 1;
    while (userIndex >= 0 && originalHistory[userIndex]?.role !== "user") {
      userIndex -= 1;
    }
    if (userIndex < 0) {
      return;
    }
    const userPrompt = originalHistory[userIndex]?.content?.trim() || "";
    if (!userPrompt) {
      return;
    }
    const branchContext = resolveBranchContext(originalHistory, userIndex);
    if (!branchContext) {
      deps.ui.showConversationContextNotice(
        action === "regenerate"
          ? "原消息的视频或分P上下文不可用，无法重新生成。"
          : "原消息的视频或分P上下文不可用，无法继续生成。",
        4000
      );
      return;
    }
    speech.stop();
    const isRegenerate = action === "regenerate";
    const hasBody = !isRegenerate && Boolean(targetMessage.content?.trim());
    const kind: BranchKind = isRegenerate
      ? "regenerate"
      : hasBody
        ? "continue-append"
        : "continue-empty";
    const initialRaw = kind === "continue-append" ? targetMessage.content! : "";
    const initialThinking = isRegenerate ? "" : (targetMessage.thinking || "");
    const branch: ActiveBranch = {
      kind,
      originalHistory,
      userIndex,
      historyIndex,
      initialRaw,
      userPrompt,
      hasNewOutput: false,
      context: branchContext.context,
      contextKey: branchContext.contextKey,
      contextMismatched: branchContext.contextMismatched,
      session: messageArea.beginInPlaceTurn(node, {
        mode: isRegenerate ? "replace" : "continue",
        initialRaw,
        thinking: initialThinking
      })
    };
    activeBranch = branch;
    messageArea.setRegenerationDisabled(true);
    const sendPrompt = kind === "continue-append" ? "继续" : userPrompt;
    void turn.send(sendPrompt).then((verdict) => {
      if (verdict === "accepted" || activeBranch !== branch) {
        return;
      }
      branch.session.restore();
      activeBranch = null;
      messageArea.setRegenerationDisabled(false);
    });
  }

  function exportAssistant(historyIndex: number, raw: string): void {
    const answerNumber = chatSessionState.chatHistory.slice(0, historyIndex + 1).filter((message) => (
      message.role === "assistant" && !(Array.isArray(message.tool_calls) && message.tool_calls.length && !String(message.content || "").trim())
    )).length || 1;
    const videoTitle = String(chatSessionState.currentConversationMeta?.contextTitle || chatSessionState.contextData?.title || "");
    const safeTitle = sanitizeFileName(videoTitle) || "BiliScript";
    const filename = `${safeTitle}-回答-${answerNumber}.md`;
    const blob = new Blob([raw], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  function imagesEqual(a: readonly ImagePart[], b: readonly ImagePart[]): boolean {
    return a.length === b.length && a.every((item, index) => item.mime === b[index]?.mime && item.data === b[index]?.data);
  }

  function retryFailedTurn(prompt: string, images: ImagePart[]): void {
    if (turn.isActive()) {
      return;
    }
    pendingRetryDraft = { images: images.map((img) => ({ ...img })) };
    void turn.send(prompt).then((verdict) => {
      if (verdict !== "accepted" && pendingRetryDraft) {
        pendingRetryDraft = null;
      }
    });
  }

  async function runAcceptance(text: string): Promise<SendVerdict> {
    const epoch = acceptanceEpoch;
    const retryDraft = pendingRetryDraft;
    pendingRetryDraft = null;
    const sendOptions = pendingSendOptions;
    pendingSendOptions = null;
    const preserveInputDraft = Boolean(sendOptions?.preserveInputDraft);
    const interactionAnchor = sendOptions?.interactionAnchor;
    try {
      deps.ui.hideHistoryPopover();

      const providerId = deps.getProviderId();
      const selectedModel = deps.getSelectedModel();
      if (!providerId || !selectedModel) {
        deps.ui.requestViewReset({ kind: "setup" });
        return "blocked";
      }

      const branch = activeBranch;
      const branched = branch !== null;
      const inputSnapshot = deps.input.value;
      const imageSnapshot = branched || preserveInputDraft
        ? []
        : (retryDraft ? retryDraft.images : (deps.getInputImages?.() ?? []));
      if (branch?.contextMismatched) {
        const confirmBranchContext = deps.confirmRegenerationContext || ((message: string) => confirmDialog({
          message,
          confirmText: "继续生成"
        }));
        const confirmed = await Promise.resolve(confirmBranchContext(
          "当前页面与原消息的视频或分P不一致。继续生成将使用原消息的上下文，是否继续？"
        ));
        if (epoch !== acceptanceEpoch || !confirmed) {
          return "blocked";
        }
      }
      const outcome = branch?.contextMismatched
        ? { pass: true as const }
        : await deps.ensureCurrentContextForSend();
      if (epoch !== acceptanceEpoch) {
        return "blocked";
      }
      if (!outcome.pass) {
        return "blocked";
      }
      const currentMeta = chatSessionState.currentConversationMeta;
      if (!branched && !currentMeta?.pinnedContext && currentMeta?.contextKey && currentMeta.contextKey !== chatSessionState.currentContextKey) {
        clearConversationIdentity();
      }

      deps.ui.removeCenteredState();
      deps.ui.removeSuggestions();
      const optIn = await resolveWebSearchOptIn(chatSessionState.webSearchEnabled);
      if (epoch !== acceptanceEpoch || optIn === "view-destroyed") {
        return "blocked";
      }
      const webSearchEnabled = optIn === "granted";
      let preserveSnapshotNotice = false;
      if (!branched) {
        messageArea.clearUncommittedFailedTurns?.();
        const appendedUserNode = messageArea.appendUserMessage(text, { source: "live", images: imageSnapshot });
        activeUserNode = appendedUserNode instanceof HTMLDivElement ? appendedUserNode : null;
        if (preserveInputDraft) {
        } else if (retryDraft) {
          if (deps.input.value === text) {
            deps.input.value = "";
            deps.ui.autosizeInput();
          }
          if (retryDraft.images.length > 0 && deps.getInputImages && deps.takeInputImages) {
            const currentImages = deps.getInputImages();
            if (imagesEqual(currentImages, retryDraft.images)) {
              deps.takeInputImages(currentImages);
            }
          }
        } else {
          preserveSnapshotNotice = deps.input.value !== inputSnapshot;
          if (!preserveSnapshotNotice) {
            deps.input.value = "";
          }
          deps.ui.autosizeInput();
        }
      } else {
        activeUserNode = null;
      }

      const images = branch
        ? (branch.originalHistory[branch.userIndex]?.images ?? [])
        : preserveInputDraft
          ? []
          : retryDraft
            ? retryDraft.images
            : deps.takeInputImages?.(imageSnapshot) ?? [];
      if (!branch && !retryDraft && !preserveInputDraft) {
        preserveSnapshotNotice ||= (deps.getInputImages?.().length ?? 0) > 0;
      }

      setStreamingUiState(true);
      activeUserPrompt = text;
      activeUserImages = images;
      activePreserveInputDraft = preserveInputDraft;
      activeTurnProviderId = providerId;
      pendingToolMessages = [];
      turnTruncatedNotice = "";
      if (!chatSessionState.currentConversationId) {
        ensureConversationId(generateConversationId());
      }
      activeConversationId = chatSessionState.currentConversationId;
      activeTurn = branch?.session.turn ?? messageArea.appendAssistantMessage({ source: "live" });
      activeToolCalls.clear();
      startStreamSlowNoticeTimer();
      if (preserveSnapshotNotice) {
        deps.ui.showConversationContextNotice("已发送原文，保留了后来修改的草稿与图片", 4000);
      }
      if (optIn === "declined") {
        deps.ui.showConversationContextNotice(SEARCH_OPT_IN_DECLINED_NOTICE, 4000, { placement: "input" });
      }
      streamFirstTokenReceived = false;

      const port = await deps.connectPort();
      if (epoch !== acceptanceEpoch) {
        try { port.disconnect(); } catch {}
        return "blocked";
      }
      activePort = port;

      port.onMessage.addListener((msg) => {
        if (activePort !== port) return;
        dispatchChatPortMessage(msg as ChatPortMessage, port);
      });

      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        if (activePort !== port) return;
        activePort = null;
        lastAckedContextKey = null;
        if (activeTurn) {
          const disconnectingTurn = activeTurn;
          activeTurn = null;
          showAssistantError(disconnectingTurn, "对话连接已中断，请重试", { searchStatus: "cancelled" });
          return;
        }
        resetStreamState();
        setStreamingUiState(false);
      });

      const context = {
        ...(branch?.context || chatSessionState.contextData),
        aiSystemPrompt: chatSessionState.aiPrefs.aiSystemPrompt
      };
      const subtitleCount = Array.isArray(context.subtitleBody) ? context.subtitleBody.length : 0;
      if (subtitleCount > 0) {
        activeTurn?.setSubtitleContextCount?.(subtitleCount);
      }
      const contextKey = branch?.contextKey || String(chatSessionState.currentContextKey || "").trim();
      activeUserContextKey = contextKey;
      if (contextKey && lastAckedContextKey === contextKey) {
        delete context.subtitleBody;
      }
      const livePageKey = String(chatSessionState.liveContextKey || "").trim();
      const sameLiveVideo = !livePageKey || !contextKey || contextKey === livePageKey;
      const rawPlaybackCursor = !branch?.contextMismatched && sameLiveVideo ? deps.getPlaybackCursorSeconds?.() : undefined;
      const playbackCursorSeconds =
        typeof rawPlaybackCursor === "number" && Number.isFinite(rawPlaybackCursor) && rawPlaybackCursor >= 0
          ? rawPlaybackCursor
          : undefined;
      const videoFrameToolEnabled = !branch?.contextMismatched && sameLiveVideo && await deps.canUseVideoFrameTool?.() === true;
      if (epoch !== acceptanceEpoch) {
        try { port.disconnect(); } catch {}
        if (activePort === port) {
          activePort = null;
        }
        return "blocked";
      }

      port.postMessage({
        action: "chat",
        providerId,
        model: deps.getSelectedModel() || "",
        conversationId: chatSessionState.currentConversationId,
        thinkingLevel: chatSessionState.aiThinkingLevel,
        webSearchEnabled,
        ...(videoFrameToolEnabled ? { videoFrameToolEnabled: true } : {}),
        ...(interactionAnchor ? { interactionAnchor } : {}),
        ...(playbackCursorSeconds !== undefined ? { playbackCursorSeconds } : {}),
        context,
        contextKey,
        prompt: text,
        ...(images.length ? { images } : {}),
        history: branch ? buildBranchRequestHistory(branch) : chatSessionState.chatHistory
      });

      turn.flushDeferredStop();
    } catch (err) {
      if (epoch !== acceptanceEpoch) {
        return "blocked";
      }
      console.error("[chat-runtime] runAcceptance 失败：", err);
      const streamTurn = activeTurn;
      if (streamTurn) {
        showAssistantError(streamTurn, (err as Error)?.message || String(err));
      } else {
        resetStreamState();
        setStreamingUiState(false);
      }
      activeTurn = null;
      turn.resolve();
      return "accepted";
    }
    return "accepted";
  }

  function endStream(streamTurn: ChatAssistantTurn, renderStep: ((turn: ChatAssistantTurn) => void) | undefined): void {
    abortAllVideoFrames();
    clearStreamRuntimeState();
    if (renderStep) {
      renderStep(streamTurn);
    }
    pendingToolMessages = [];
    activeBranch = null;
    activeUserPrompt = "";
    activeUserNode = null;
    activeUserImages = [];
    activePreserveInputDraft = false;
    activeUserContextKey = "";
    activeTurnProviderId = "";
    activeToolCalls.clear();
    activeToolGeneration = 0;
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    setStreamingUiState(false);
    if (!deps.input.inert && !deps.input.closest("[inert]")) {
      deps.input.focus({ preventScroll: true });
    }
    scrollToBottom();
    turn.resolve();
  }

  function getActiveAssistantHistoryIndex(): number {
    const baseIndex = activeBranch
      ? getBranchSliceEnd(activeBranch)
      : chatSessionState.chatHistory.length + 1;
    return baseIndex + pendingToolMessages.length;
  }

  function commitAssistantTurn(
    raw: string,
    opts: { thinking?: string; stopped?: boolean } = {}
  ): boolean {
    const thinkingText = typeof opts.thinking === "string" && opts.thinking.trim() ? opts.thinking : undefined;
    const hasContent = Boolean(raw && raw.trim());
    const hasThinking = Boolean(thinkingText);
    const isStopped = Boolean(opts.stopped);

    const assistantMsg: ChatSessionMessage = {
      role: "assistant",
      content: raw || ""
    };
    if (hasThinking) {
      assistantMsg.thinking = thinkingText;
    }
    if (isStopped) {
      assistantMsg.stopped = true;
    }

    if (activeBranch) {
      if (!deps.store.isCurrent(activeConversationId)) {
        pendingToolMessages = [];
        return false;
      }
      if (isStopped && (!activeBranch.hasNewOutput || (!hasContent && !hasThinking))) {
        pendingToolMessages = [];
        return false;
      }
      const history = activeBranch.originalHistory.slice(0, getBranchSliceEnd(activeBranch));
      history.push(...pendingToolMessages, assistantMsg);
      applyConversationIdentity({ history });
      void deps.store.persistCurrent();
      pendingToolMessages = [];
      return true;
    }

    if (activeUserPrompt && deps.store.isCurrent(activeConversationId)) {
      appendChatHistory(
        {
          role: "user",
          content: activeUserPrompt,
          ...(activeUserImages.length ? { images: activeUserImages } : {}),
          ...(activeUserContextKey ? { contextKey: activeUserContextKey } : {})
        },
        ...pendingToolMessages,
        assistantMsg
      );
      void deps.store.persistCurrent();
    }
    pendingToolMessages = [];
    return true;
  }

  function finalizeAssistant(streamTurn: ChatAssistantTurn | null): void {
    if (!streamTurn) {
      return;
    }
    endStream(streamTurn, (turn) => {
      const raw = turn.finish({
        userPrompt: activeBranch?.userPrompt || activeUserPrompt,
        historyIndex: getActiveAssistantHistoryIndex()
      });
      const thinking = turn.getThinking?.();
      appendTruncatedBadge(turn);
      const committed = commitAssistantTurn(raw, { thinking });
      settleActiveBranchSession(committed);
    });
  }

  function appendTruncatedBadge(turn: ChatAssistantTurn): void {
    if (!turnTruncatedNotice) {
      return;
    }
    turn.markTruncated(turnTruncatedNotice);
  }

  function showAssistantError(
    streamTurn: ChatAssistantTurn | null,
    error: unknown,
    opts?: { searchStatus?: "failed" | "cancelled" }
  ): void {
    if (!streamTurn) {
      return;
    }
    const isNewTurn = !activeBranch && (Boolean(activeUserPrompt) || activeUserImages.length > 0);
    const failedPrompt = activeUserPrompt;
    const failedImages = activeUserImages.map((img) => ({ ...img }));
    const restoreDraftOnFail = !activePreserveInputDraft;
    const failedUserNode = activeUserNode;
    const errorText = String(error ?? "");
    const isSetupError = classifyOverviewSetupError(errorText) !== null;
    endStream(streamTurn, (turn) => {
      const message = `${error}${imageUnsupportedErrorHint(error, activeUserImages)}`;
      const onRetry = isNewTurn && !isSetupError
        ? () => retryFailedTurn(failedPrompt, failedImages)
        : undefined;
      turn.fail(`错误：${message}`, {
        ...(onRetry ? { onRetry } : {}),
        ...(opts?.searchStatus ? { searchStatus: opts.searchStatus } : {})
      });
      if (isNewTurn) {
        if (failedUserNode) {
          failedUserNode.dataset.uncommittedFailedTurn = "1";
        }
        if (turn.node) {
          turn.node.dataset.uncommittedFailedTurn = "1";
        }
        if (restoreDraftOnFail) {
          deps.ui.onTurnFailedRestoreDraft?.({
            text: failedPrompt,
            images: failedImages,
            isSetupError
          });
        }
      }
      if (activeBranch) {
        const prefix = activeBranch.kind === "regenerate" ? "重新生成失败" : "继续生成失败";
        deps.ui.showConversationContextNotice(`${prefix}：${message}`, 4000);
      }
    });
  }

  function handleAssistantStopped(streamTurn: ChatAssistantTurn | null, reason: string): void {
    if (!streamTurn) {
      return;
    }
    endStream(streamTurn, (turn) => {
      const { raw } = turn.stop(reason, {
        userPrompt: activeBranch?.userPrompt || activeUserPrompt,
        historyIndex: getActiveAssistantHistoryIndex()
      });
      const thinking = turn.getThinking?.();
      const committed = commitAssistantTurn(raw, { thinking, stopped: true });
      settleActiveBranchSession(committed);
    });
  }

  function stopActiveStream(): void {
    if (!turn.isActive()) {
      return;
    }
    setStreamingUiState(true, { stopping: true });
    turn.stop();
  }

  function stopStreamNow(): void {
    if (!activePort) {
      return;
    }
    setStreamingUiState(true, { stopping: true });
    try {
      activePort.postMessage({ action: "stop" });
    } catch {
      resetStreamState();
      setStreamingUiState(false);
    }
  }

  function clearStreamSlowNoticeTimer(): void {
    if (streamSlowNoticeTimer) {
      window.clearTimeout(streamSlowNoticeTimer);
      streamSlowNoticeTimer = 0;
    }
  }

  function armStreamSlowNoticeTimer(): void {
    clearStreamSlowNoticeTimer();
    streamSlowNoticeTimer = window.setTimeout(() => {
      if (!activePort || streamFirstTokenReceived || activeToolCalls.size > 0) {
        return;
      }
      deps.ui.showConversationContextNotice("模型响应较慢，可能正在思考，请稍候…", 0);
    }, STREAM_SLOW_NOTICE_MS);
  }

  function startStreamSlowNoticeTimer(): void {
    clearStreamRuntimeState();
    armStreamSlowNoticeTimer();
  }

  function handleFirstStreamToken(): void {
    if (streamFirstTokenReceived) {
      return;
    }
    streamFirstTokenReceived = true;
    clearStreamRuntimeState();
  }

  function clearStreamRuntimeState(): void {
    clearStreamSlowNoticeTimer();
    deps.ui.removeConversationContextNotice();
  }

  function isStreaming(): boolean {
    return activePort !== null;
  }

  function isTurnActive(): boolean {
    return turn.isActive();
  }

  function settleTurn(): Promise<void> {
    return turn.settled();
  }

  function hasPendingUserPrompt(): boolean {
    return activeUserPrompt !== "";
  }

  function stopSpeech(): void {
    speech.stop();
  }

  function closeImageViewer(opts?: { restoreFocus?: boolean }): void {
    messageArea.closeImageViewer?.(opts);
  }

  function resetStreamState(): void {
    acceptanceEpoch += 1;
    pendingRetryDraft = null;
    pendingSendOptions = null;
    speech.stop();
    abortAllVideoFrames();
    activeTurn?.discard();
    activeBranch?.session.restore();
    activeBranch = null;
    pendingToolMessages = [];
    clearStreamRuntimeState();
    if (activePort) {
      try { activePort.disconnect(); } catch {}
      activePort = null;
    }
    activeTurn = null;
    activeUserPrompt = "";
    activeUserNode = null;
    activeUserImages = [];
    activePreserveInputDraft = false;
    activeUserContextKey = "";
    activeTurnProviderId = "";
    activeToolCalls.clear();
    activeToolGeneration = 0;
    turn.discard();
  }

  return {
    sendTurn,
    stopActiveStream,
    stopSpeech,
    closeImageViewer,
    setAutoScroll,
    scrollToBottom,
    isStreaming,
    isTurnActive,
    settleTurn,
    hasPendingUserPrompt,
    resetStreamState,
    messageArea
  };
}
