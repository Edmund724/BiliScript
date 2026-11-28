import type { NoteExportTarget } from "../core/defaults.js";
import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import { isTagElement } from "../shared/cross-doc.js";
import type { AiContext, CaptureCurrentVideoFrame, ConversationSummaryAnchor, ImagePart } from "../ai/types.js";
import type { InteractionAnchorHint } from "../ai/chat-hybrid-retrieval.js";
import {
  isCompleteUserTurnBoundary,
  isSummaryAnchorValidForMessages,
  planConversationCompaction,
  shouldInvalidateSummaryAnchor,
  type SummaryAnchorLike
} from "../ai/compaction.js";
import { buildContextKey, generateConversationId } from "../ai/conversation.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import { resolveWebSearchOptIn, SEARCH_OPT_IN_DECLINED_NOTICE } from "../search/opt-in-notice.js";
import {
  appendChatHistory,
  applyConversationIdentity,
  chatSessionState,
  clearConversationIdentity,
  ensureConversationId,
  type ChatSessionMessage
} from "./chat-state.js";
import { consumeRuntimeLastError } from "../shared/messaging.js";
import type { ChatPortMessage, ChatTranscriptMode, ChatTurnKind } from "./protocol.js";
import type { GateOutcome } from "./send-gate.js";
import type { ChatNoticeSlot } from "../reader/chat-notices.js";
import { classifyOverviewSetupError, type OverviewSetupErrorClass } from "../core/overview-setup-error.js";
import { createChatStreamRenderer, type ChatAssistantTurn, type ChatInPlaceSession } from "./chat-stream-render.js";
import type { SaveNoteActionResult } from "./render/message-actions.js";
import { imageUnsupportedErrorHint } from "./image-support.js";
import { createChatSpeechController, type ChatSpeechEngine } from "./chat-speech.js";
import { dispatchNoteExport } from "../notes/export-actions.js";
import {
  bindCapturedFramesToMessage,
  capturedVideoFramesToCandidates,
  getCapturedFramesForHistoryIndex,
  getCapturedFramesForMessage,
  type NoteKeyframeCandidate
} from "../notes/turn-frame-cache.js";

const STREAM_SLOW_NOTICE_MS = 15000;
export const STREAM_SLOW_NOTICE_TAG = "stream-slow";

export type SendVerdict = "accepted" | "blocked" | "ignored";

export type { ChatTurnKind, ChatTranscriptMode };

export const TURN_SETTLE_FALLBACK_MS = 4000;

export interface SendTurnOptions {
  preserveInputDraft?: boolean;
  interactionAnchor?: InteractionAnchorHint;
  turnKind?: ChatTurnKind;
  transcriptMode?: ChatTranscriptMode;
  expectedClipSignature?: string;
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
  persistCurrent(opts?: { transcriptMode?: ChatTranscriptMode; clearSummaryAnchor?: boolean }): Promise<void>;
}

export interface ChatRuntimeUi {
  setStreamingUiState: (isStreaming: boolean, options?: { stopping?: boolean }) => void;
  messagesNotice: ChatNoticeSlot;
  inputNotice: ChatNoticeSlot;
  hideHistoryPopover: () => void;
  removeCenteredState: () => void;
  removeSuggestions: () => void;
  showSetupBlockedState: () => void;
  autosizeInput: () => void;
  onTurnFailedRestoreDraft?: (draft: { text: string; images: ImagePart[]; isSetupError: boolean }) => void;
  onSetupRequired?: (errorClass: OverviewSetupErrorClass, providerId: string) => void;
}

export interface CommittedChatTurnInfo {
  raw: string;
  historyIndex: number;
  message: ChatSessionMessage;
  stopped: boolean;
  capturedFrames: NoteKeyframeCandidate[];
  turnKind: ChatTurnKind;
  transcriptMode?: ChatTranscriptMode;
  expectedClipSignature: string;
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
  connectPort: () => Promise<ChatPort> | ChatPort;
  isCostGuardEnabled?: () => boolean;
  confirmCostGuard?: (message: string) => boolean | Promise<boolean>;
  confirmRegenerationContext?: (message: string) => boolean | Promise<boolean>;
  speechEngine?: ChatSpeechEngine;
  getSpeechVolume?: () => number | undefined;
  smoothStream?: boolean;
  onContinue?: (historyIndex: number, node: HTMLDivElement) => void;
  onSaveNote?: (
    historyIndex: number,
    raw: string,
    button: HTMLButtonElement
  ) => Promise<SaveNoteActionResult | boolean | void> | SaveNoteActionResult | boolean | void;
  getNoteExportTarget?: () => NoteExportTarget;
  onTurnCommitted?: (info: CommittedChatTurnInfo) => void;
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
  let activeTurnKind: ChatTurnKind = "user";
  let activeTurnTranscriptMode: ChatTranscriptMode | undefined = undefined;
  let lastResolvedTranscriptMode: { conversationId: string; mode: ChatTranscriptMode } | null = null;
  let activeExpectedClipSignature = "";
  let activeUserImages: ImagePart[] = [];
  let activeUserContextKey = "";
  let pendingToolMessages: ChatSessionMessage[] = [];
  let activeTurnCapturedFrames: NoteKeyframeCandidate[] = [];
  let turnTruncatedNotice = "";
  let activeConversationId = "";
  let streamSlowNoticeTimer = 0;
  let streamFirstTokenReceived = false;
  let sendInFlight = false;
  let pendingSettles: Array<() => void> = [];
  let stopWhenPortReady = false;
  let settleWatchdogTimer = 0;
  let acceptanceEpoch = 0;
  let pendingRetryDraft: { images: ImagePart[] } | null = null;
  let pendingSendOptions: SendTurnOptions | null = null;
  let activePreserveInputDraft = false;
  let lastAckedContextKey: string | null = null;
  const pendingVideoFrames = new Map<string, AbortController>();
  const activeToolCalls = new Set<string>();
  const inFlightCompactions = new Set<string>();
  let activeToolGeneration = 0;

  function isTurnActive(): boolean {
    return sendInFlight || activePort !== null;
  }

  function resolveTurnSettles(): void {
    if (settleWatchdogTimer) {
      window.clearTimeout(settleWatchdogTimer);
      settleWatchdogTimer = 0;
    }
    stopWhenPortReady = false;
    if (!pendingSettles.length) {
      return;
    }
    const resolvers = pendingSettles;
    pendingSettles = [];
    for (const resolveSettle of resolvers) {
      resolveSettle();
    }
  }

  function requestTurnStop(): void {
    if (activePort === null) {
      if (sendInFlight) {
        stopWhenPortReady = true;
      }
      return;
    }
    stopStreamNow();
  }

  function flushDeferredTurnStop(): boolean {
    if (!stopWhenPortReady) {
      return false;
    }
    stopWhenPortReady = false;
    requestTurnStop();
    return true;
  }

  function settleTurn(): Promise<void> {
    if (!isTurnActive()) {
      return Promise.resolve();
    }
    const settledPromise = new Promise<void>((resolveSettle) => {
      pendingSettles.push(resolveSettle);
    });
    requestTurnStop();
    if (!settleWatchdogTimer) {
      settleWatchdogTimer = window.setTimeout(() => {
        settleWatchdogTimer = 0;
        resetStreamState();
        setStreamingUiState(false);
        resolveTurnSettles();
      }, TURN_SETTLE_FALLBACK_MS);
    }
    return settledPromise;
  }

  async function sendTurnInternal(text: string): Promise<SendVerdict> {
    const prompt = String(text ?? "").trim();
    if (!prompt || isTurnActive()) {
      return "ignored";
    }
    sendInFlight = true;
    let verdict: SendVerdict;
    try {
      verdict = await runAcceptance(prompt);
    } finally {
      sendInFlight = false;
    }
    if (verdict === "blocked") {
      resolveTurnSettles();
    }
    return verdict;
  }

  function setStreamingUiState(isStreaming: boolean, { stopping = false }: { stopping?: boolean } = {}): void {
    deps.ui.setStreamingUiState(isStreaming, { stopping });
    messageArea.setRegenerationDisabled(isStreaming || isTurnActive() || activeBranch !== null);
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
    onError: (message) => deps.ui.messagesNotice.show(message, 4000)
  });
  async function saveNoteAssistant(
    historyIndex: number,
    raw: string,
    button: HTMLButtonElement
  ): Promise<SaveNoteActionResult | boolean | void> {
    if (deps.onSaveNote) {
      return deps.onSaveNote(historyIndex, raw, button);
    }
    const indexedFrames = getCapturedFramesForHistoryIndex(historyIndex);
    const message = chatSessionState.chatHistory[historyIndex];
    const capturedFrames = indexedFrames.length ? indexedFrames : getCapturedFramesForMessage(message);
    const result = await dispatchNoteExport({
      aiNoteMarkdown: raw,
      capturedFrames
    });
    if (!result.ok) {
      return {
        ok: false,
        error: result.error || "导出笔记失败"
      };
    }
    if (result.target === "obsidian") {
      return {
        ok: true,
        label: result.usedClipboardFallback ? "已复制并唤起 Obsidian" : "已唤起 Obsidian"
      };
    }
    return {
      ok: true,
      label: "已导出笔记"
    };
  }

  const { scrollToBottom, setAutoScroll, messageArea } = createChatStreamRenderer({
    ...deps,
    onRegenerate: (historyIndex, node) => startBranch("regenerate", historyIndex, node),
    onContinue: (historyIndex, node) => {
      deps.onContinue?.(historyIndex, node);
      startBranch("continue", historyIndex, node);
    },
    onSaveNote: saveNoteAssistant,
    getNoteExportTarget: deps.getNoteExportTarget,
    onNotice: (message) => deps.ui.messagesNotice.show(message, 4000),
    onSpeak: (messageId, button, text) => speech.toggle(button, text, { messageId }),
    onClear: () => speech.stop(),
    isRegenerationDisabled: () => isTurnActive() || activeBranch !== null
  });
  function dispatchChatPortMessage(msg: ChatPortMessage | null | undefined, port: ChatPort | null): void {
    if (!msg) return;
    if (typeof msg.cachedContextKey === "string" && msg.cachedContextKey) {
      lastAckedContextKey = msg.cachedContextKey;
    }
    if (msg.transcriptMode === "full" || msg.transcriptMode === "hybrid") {
      activeTurnTranscriptMode = msg.transcriptMode;
      if (activeConversationId) {
        lastResolvedTranscriptMode = {
          conversationId: activeConversationId,
          mode: msg.transcriptMode
        };
        if (
          chatSessionState.currentConversationId === activeConversationId &&
          chatSessionState.currentConversationMeta
        ) {
          applyConversationIdentity({
            meta: {
              ...chatSessionState.currentConversationMeta,
              transcriptMode: msg.transcriptMode
            }
          });
        }
      }
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
          const captureRequest = Array.isArray(msg.times)
            ? {
                times: msg.times,
                ...(msg.spanSeconds !== undefined ? { spanSeconds: msg.spanSeconds } : {}),
                ...(msg.maxFrames !== undefined ? { maxFrames: msg.maxFrames } : {})
              }
            : msg.targetTime;
          const captureResult = await deps.captureCurrentVideoFrame(captureRequest, controller.signal);
          if (controller.signal.aborted || pendingVideoFrames.get(msg.requestId) !== controller) return;
          const capturedCandidates = capturedVideoFramesToCandidates(captureResult);
          if (capturedCandidates.length > 0) {
            activeTurnCapturedFrames.push(...capturedCandidates);
          }
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
        deps.ui.messagesNotice.show(msg.data, 4000);
      }
    } else if (msg.type === "tool-status") {
      if (typeof msg.generation === "number" && msg.generation !== activeToolGeneration) {
        return;
      }
      const activityId = msg.callId || `${msg.tool || "web_search"}:${msg.query}`;
      if (msg.status === "searching") {
        activeToolCalls.add(activityId);
        clearStreamSlowNoticeTimer();
        deps.ui.messagesNotice.clear(STREAM_SLOW_NOTICE_TAG);
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
      if (deps.isCostGuardEnabled && !deps.isCostGuardEnabled()) {
        try {
          port?.postMessage({ action: "cost-guard-confirm", ok: true });
        } catch {
        }
        return;
      }
      const confirmCostGuard =
        deps.confirmCostGuard ||
        ((message: string) =>
          confirmDialog({
            title: "确认 AI 对话长视频分析",
            message,
            confirmText: "继续"
          }));
      const replyPort = port;
      const guardMessage =
        typeof msg.data?.message === "string" && msg.data.message
          ? msg.data.message
          : "当前视频较长，进行「AI 对话」全片分析预计需要多次调用，是否继续？";
      void Promise.resolve(confirmCostGuard(guardMessage)).then((ok) => {
        try {
          replyPort?.postMessage({ action: "cost-guard-confirm", ok: Boolean(ok) });
        } catch {
        }
      });
    }
  }

  async function sendTurn(text: string, options?: SendTurnOptions): Promise<SendVerdict> {
    const canAttempt = Boolean(String(text ?? "").trim()) && !isTurnActive();
    if (canAttempt) {
      pendingSendOptions = options ?? null;
    }
    messageArea.setRegenerationDisabled(true);
    try {
      return await sendTurnInternal(text);
    } finally {
      if (canAttempt) {
        pendingSendOptions = null;
      }
      if (!isTurnActive()) {
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
    if (isTurnActive() || activeBranch) {
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
      deps.ui.messagesNotice.show(
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
    void sendTurnInternal(sendPrompt).then((verdict) => {
      if (verdict === "accepted" || activeBranch !== branch) {
        return;
      }
      branch.session.restore();
      activeBranch = null;
      messageArea.setRegenerationDisabled(false);
    });
  }

  function imagesEqual(a: readonly ImagePart[], b: readonly ImagePart[]): boolean {
    return a.length === b.length && a.every((item, index) => item.mime === b[index]?.mime && item.data === b[index]?.data);
  }

  function retryFailedTurn(prompt: string, images: ImagePart[]): void {
    if (isTurnActive()) {
      return;
    }
    pendingRetryDraft = { images: images.map((img) => ({ ...img })) };
    void sendTurnInternal(prompt).then((verdict) => {
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
        deps.ui.showSetupBlockedState();
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
        activeUserNode = isTagElement(appendedUserNode, "div") ? appendedUserNode : null;
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
      activeTurnKind = branch ? "user" : (sendOptions?.turnKind ?? "user");
      activeExpectedClipSignature = branch ? "" : String(sendOptions?.expectedClipSignature || "");
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
        deps.ui.messagesNotice.show("已发送原文，保留了后来修改的草稿与图片", 4000);
      }
      if (optIn === "declined") {
        deps.ui.inputNotice.show(SEARCH_OPT_IN_DECLINED_NOTICE, 4000);
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

      const persistedTranscriptMode =
        chatSessionState.currentConversationMeta?.id === activeConversationId
          ? chatSessionState.currentConversationMeta?.transcriptMode
          : undefined;
      const requestedTranscriptMode: ChatTranscriptMode | undefined =
        sendOptions?.transcriptMode ??
        (lastResolvedTranscriptMode && lastResolvedTranscriptMode.conversationId === activeConversationId
          ? lastResolvedTranscriptMode.mode
          : persistedTranscriptMode);
      activeTurnTranscriptMode = requestedTranscriptMode;

      const requestHistory = branch ? buildBranchRequestHistory(branch) : chatSessionState.chatHistory;
      const rawAnchor =
        chatSessionState.currentConversationMeta?.id === activeConversationId
          ? chatSessionState.currentConversationMeta?.summaryAnchor
          : undefined;
      const branchMutationIndex = branch
        ? (branch.kind === "continue-append" ? branch.historyIndex : branch.userIndex)
        : Number.POSITIVE_INFINITY;
      const effectiveSummaryAnchor =
        rawAnchor &&
        !shouldInvalidateSummaryAnchor(rawAnchor, branchMutationIndex, requestHistory) &&
        isSummaryAnchorValidForMessages(requestHistory, rawAnchor)
          ? rawAnchor
          : undefined;

      port.postMessage({
        action: "chat",
        providerId,
        model: deps.getSelectedModel() || "",
        conversationId: chatSessionState.currentConversationId,
        thinkingLevel: chatSessionState.aiThinkingLevel,
        turnKind: activeTurnKind,
        ...(requestedTranscriptMode ? { transcriptMode: requestedTranscriptMode } : {}),
        ...(effectiveSummaryAnchor ? { summaryAnchor: effectiveSummaryAnchor } : {}),
        webSearchEnabled,
        ...(videoFrameToolEnabled ? { videoFrameToolEnabled: true } : {}),
        ...(interactionAnchor ? { interactionAnchor } : {}),
        ...(playbackCursorSeconds !== undefined ? { playbackCursorSeconds } : {}),
        context,
        contextKey,
        prompt: text,
        ...(images.length ? { images } : {}),
        history: requestHistory
      });

      flushDeferredTurnStop();
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
      resolveTurnSettles();
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
    activeTurnCapturedFrames = [];
    activeBranch = null;
    activeUserPrompt = "";
    activeUserNode = null;
    activeUserImages = [];
    activePreserveInputDraft = false;
    activeUserContextKey = "";
    activeTurnProviderId = "";
    activeTurnKind = "user";
    activeTurnTranscriptMode = undefined;
    activeExpectedClipSignature = "";
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
    resolveTurnSettles();
  }

  function getActiveAssistantHistoryIndex(): number {
    const baseIndex = activeBranch
      ? getBranchSliceEnd(activeBranch)
      : chatSessionState.chatHistory.length + 1;
    return baseIndex + pendingToolMessages.length;
  }

  function scheduleBackgroundCompactionIfNeeded(snapshot: {
    conversationId: string;
    providerId: string;
    model: string;
    history: ChatSessionMessage[];
    summaryAnchor?: SummaryAnchorLike;
  }): void {
    const conversationId = String(snapshot.conversationId || "").trim();
    if (!conversationId || snapshot.history.length === 0) {
      return;
    }
    const plan = planConversationCompaction(snapshot.history, snapshot.summaryAnchor);
    if (!plan) {
      return;
    }
    const dedupeKey = `${conversationId}:${plan.coveredMessageCount}`;
    if (inFlightCompactions.has(dedupeKey)) {
      return;
    }
    inFlightCompactions.add(dedupeKey);
    void (async () => {
      let compactPort: ChatPort | null = null;
      let settled = false;
      const cleanup = () => {
        if (settled) {
          return;
        }
        settled = true;
        inFlightCompactions.delete(dedupeKey);
        if (compactPort) {
          try {
            compactPort.disconnect();
          } catch {}
          compactPort = null;
        }
      };
      try {
        compactPort = await deps.connectPort();
        compactPort.onMessage.addListener((rawMsg) => {
          const msg = rawMsg as ChatPortMessage | null;
          if (!msg || msg.type !== "compact-history-result" || msg.conversationId !== conversationId) {
            return;
          }
          if (msg.ok && msg.summaryAnchor) {
            const nextAnchor = msg.summaryAnchor as ConversationSummaryAnchor;
            const currentMeta = chatSessionState.currentConversationMeta;
            const currentHistory = chatSessionState.chatHistory;
            const prevCovered = Number(currentMeta?.summaryAnchor?.coveredMessageCount) || 0;
            const boundaryMatches =
              isCompleteUserTurnBoundary(currentHistory, nextAnchor.coveredMessageCount) &&
              String(currentHistory[nextAnchor.coveredMessageCount - 1]?.content ?? "") ===
                plan.expectedBoundaryContent;
            if (
              chatSessionState.currentConversationId === conversationId &&
              currentMeta &&
              nextAnchor.coveredMessageCount > prevCovered &&
              boundaryMatches
            ) {
              applyConversationIdentity({
                meta: {
                  ...currentMeta,
                  summaryAnchor: { ...nextAnchor }
                }
              });
            }
          }
          cleanup();
        });
        compactPort.onDisconnect.addListener(() => {
          consumeRuntimeLastError();
          cleanup();
        });
        compactPort.postMessage({
          action: "compact-history",
          conversationId,
          providerId: snapshot.providerId,
          model: snapshot.model,
          previousSummaryText: plan.previousSummaryText,
          batchMessages: plan.batchMessages,
          coveredMessageCount: plan.coveredMessageCount,
          ...(plan.expectedCoveredMessageIds
            ? { expectedCoveredMessageIds: plan.expectedCoveredMessageIds }
            : {}),
          expectedBoundaryContent: plan.expectedBoundaryContent
        });
      } catch {
        cleanup();
      }
    })();
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

    const finalizeCommittedAssistant = (
      committedIndex: number,
      clearSummaryAnchor = false
    ): true => {
      const boundFrames = bindCapturedFramesToMessage(
        assistantMsg,
        activeTurnCapturedFrames,
        committedIndex
      );
      const persistOpts: { transcriptMode?: ChatTranscriptMode; clearSummaryAnchor?: boolean } = {
        ...(activeTurnTranscriptMode ? { transcriptMode: activeTurnTranscriptMode } : {}),
        ...(clearSummaryAnchor ? { clearSummaryAnchor: true } : {})
      };
      const compactionSnapshot = !isStopped
        ? {
            conversationId: activeConversationId,
            providerId: activeTurnProviderId,
            model: deps.getSelectedModel() || "",
            history: [...chatSessionState.chatHistory],
            summaryAnchor: clearSummaryAnchor
              ? undefined
              : chatSessionState.currentConversationMeta?.summaryAnchor
          }
        : null;
      void Promise.resolve(
        deps.store.persistCurrent(Object.keys(persistOpts).length > 0 ? persistOpts : undefined)
      )
        .then(() => {
          if (compactionSnapshot) {
            scheduleBackgroundCompactionIfNeeded(compactionSnapshot);
          }
        })
        .catch(() => {});
      pendingToolMessages = [];
      activeTurnCapturedFrames = [];
      deps.onTurnCommitted?.({
        raw: assistantMsg.content,
        historyIndex: committedIndex,
        message: assistantMsg,
        stopped: isStopped,
        capturedFrames: boundFrames,
        turnKind: activeTurnKind,
        ...(activeTurnTranscriptMode ? { transcriptMode: activeTurnTranscriptMode } : {}),
        expectedClipSignature: activeExpectedClipSignature
      });
      return true;
    };

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
      const mutationIndex =
        activeBranch.kind === "continue-append" ? activeBranch.historyIndex : activeBranch.userIndex;
      const currentMeta = chatSessionState.currentConversationMeta;
      const shouldClearAnchor = shouldInvalidateSummaryAnchor(
        currentMeta?.summaryAnchor,
        mutationIndex,
        history
      );
      if (shouldClearAnchor && currentMeta) {
        const nextMeta = { ...currentMeta };
        delete nextMeta.summaryAnchor;
        applyConversationIdentity({ meta: nextMeta, history });
      } else {
        applyConversationIdentity({ history });
      }
      return finalizeCommittedAssistant(history.length - 1, shouldClearAnchor);
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
      return finalizeCommittedAssistant(chatSessionState.chatHistory.length - 1);
    }
    pendingToolMessages = [];
    activeTurnCapturedFrames = [];
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
        deps.ui.messagesNotice.show(`${prefix}：${message}`, 4000);
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
    if (!isTurnActive()) {
      return;
    }
    setStreamingUiState(true, { stopping: true });
    requestTurnStop();
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
      deps.ui.messagesNotice.show("模型响应较慢，可能正在思考，请稍候…", 0, { tag: STREAM_SLOW_NOTICE_TAG });
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
    deps.ui.messagesNotice.clear(STREAM_SLOW_NOTICE_TAG);
  }

  function isStreaming(): boolean {
    return activePort !== null;
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
    activeTurnCapturedFrames = [];
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
    activeTurnKind = "user";
    activeTurnTranscriptMode = undefined;
    lastResolvedTranscriptMode = null;
    activeExpectedClipSignature = "";
    activeToolCalls.clear();
    activeToolGeneration = 0;
    sendInFlight = false;
    resolveTurnSettles();
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
