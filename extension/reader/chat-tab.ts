import { state } from "../core/state.js";
import { computeCurrentClipSignature, extractBvid } from "../bilibili/video-id-shared.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { confirmDialog, dismissConfirmDialog } from "../ui/confirm-dialog.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  bindChatDisplaySliders,
  watchChatDisplaySettings,
  type ChatDisplaySettingsPatch
} from "./chat-display-settings.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { normalizeMarkdownForSectionPaste } from "../notes/paste.js";
import {
  CONVERSATIONS_STORAGE_KEY,
  OFFSCREEN_CHAT_PORT_NAME,
  applyLiveContextToMain,
  chatSessionState,
  createChatTabDomain,
  hasExternalizedChatImages,
  parseModelOptionValue,
  readConversationHistory,
  syncSavedConversationsFromStorage
} from "../chat/tab-domain.js";
import { subscribeQuickPromptsChange } from "../chat/quick-prompt-cache.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { createExplainIntentController } from "./explain-intent.js";
import { createReaderChatLists } from "./chat-lists.js";
import { createReaderChatFeedback } from "./chat-notices.js";
import { createReaderChatSessionTriggers } from "./chat-session-triggers.js";
import { createChatSuggestionsSlot } from "./chat-suggestions-slot.js";
import { createReaderChatModelPanel } from "./chat-model-panel.js";
import { createReaderChatPopovers } from "./chat-popovers.js";
import { createChatSetupFlow } from "./chat-setup-flow.js";
import { createChatLiveBridge } from "./chat-live-bridge.js";
import { createChatContextOrchestrator } from "./chat-context-orchestrator.js";
import { createChatInputImages } from "../chat/chat-input-images.js";
import { createReaderChatComposer } from "./chat-tab-composer.js";
import { createScrollFollowController } from "./chat-scroll-follow.js";
import { createImageSupportGate } from "../chat/image-support.js";

import { requestSubtitleRefresh, subscribeReaderPresenter, setChatTabOutsideClickHandler } from "./reader-bus.js";
import { activateScriptTab } from "./script-tab-activation.js";
import { kickSubtitleFetch } from "../subtitle/kick-subtitle-fetch.js";
import { logWarn } from "../shared/logging.js";
import { ensureReaderChatStyles } from "../shared/style-injector.js";
import { ids } from "./state.js";
import {
  ensureFullscreenOverlay,
  getFullscreenLiveOverlay,
  getLiveController,
  startLiveCompanion,
  stopLiveCompanion
} from "../live/live-companion-session.js";
import { capturePageVideoFrame } from "../live/page-video-frame-capture.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { encodeBase64Bytes } from "../live/moss-live-protocol.js";
import { captureHistoricalVideoFrame } from "../chat/historical-video-frame.js";
import { seekReadingTarget } from "./sync.js";

export {
  ensureFullscreenOverlay,
  getFullscreenLiveOverlay,
  getLiveController,
  startLiveCompanion,
  stopLiveCompanion
};

ensureReaderChatStyles();

const els = {
  root: document.getElementById(ids.readingChatRoot) as HTMLElement,
  modelSelect: document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement,
  modelChip: document.getElementById(ids.readingChatModelChip) as HTMLButtonElement,
  modelPanel: document.getElementById(ids.readingChatModelPanel) as HTMLElement,
  modelPanelList: document.getElementById(ids.readingChatModelList) as HTMLElement,
  thinkingToggle: document.getElementById(ids.readingChatThinkingToggle) as HTMLElement,
  thinkingRow: document.getElementById(ids.readingChatThinkingRow) as HTMLElement,
  thinkingRowValue: document.getElementById(ids.readingChatThinkingRowValue) as HTMLElement,
  webSearchPill: document.getElementById(ids.readingChatWebSearchPill) as HTMLElement | null,
  newChatBtn: document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement,
  historyBtn: document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement,
  moreBtn: document.getElementById(ids.readingChatMoreBtn) as HTMLButtonElement | null,
  moreMenu: document.getElementById(ids.readingChatMoreMenu) as HTMLElement | null,
  displaySettingsBtn: document.getElementById(ids.readingChatDisplaySettingsBtn) as HTMLButtonElement | null,
  lineHeightSlider: document.getElementById(ids.readingChatLineHeight) as HTMLInputElement | null,
  lineHeightValue: document.getElementById(ids.readingChatLineHeightValue) as HTMLElement | null,
  lineHeightResetBtn: document.getElementById(ids.readingChatLineHeightResetBtn) as HTMLButtonElement | null,
  paraSpacingSlider: document.getElementById(ids.readingChatParagraphSpacing) as HTMLInputElement | null,
  paraSpacingValue: document.getElementById(ids.readingChatParagraphSpacingValue) as HTMLElement | null,
  paraSpacingResetBtn: document.getElementById(ids.readingChatParagraphSpacingResetBtn) as HTMLButtonElement | null,
  historyPopover: document.getElementById(ids.readingChatHistoryPopover) as HTMLElement,
  historyList: document.getElementById(ids.readingChatHistoryList) as HTMLElement,
  historyClearBtn: document.getElementById(ids.readingChatHistoryClearBtn) as HTMLButtonElement | null,
  historyBackBtn: document.getElementById(ids.readingChatHistoryBackBtn) as HTMLButtonElement | null,
  messages: document.getElementById(ids.readingChatMessages) as HTMLElement,
  scrollBottomBtn: document.getElementById(ids.readingChatScrollBottomBtn) as HTMLButtonElement,
  input: document.getElementById(ids.readingChatInput) as HTMLTextAreaElement,
  imageStrip: document.getElementById(ids.readingChatImageStrip) as HTMLElement | null,
  sendBtn: document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement,
  asrNotice: document.getElementById(ids.readingChatAsrNotice) as HTMLElement | null,
  liveStatus: document.getElementById(ids.readingChatLiveStatus) as HTMLElement | null,
  intentCard: document.getElementById(ids.readingChatIntent) as HTMLElement | null,
  speechVolume: document.getElementById(ids.readingChatSpeechVolume) as HTMLElement | null,
  speechVolumeInput: document.getElementById(ids.readingChatSpeechVolumeInput) as HTMLInputElement | null,
  speechVolumeValue: document.getElementById(ids.readingChatSpeechVolumeValue) as HTMLElement | null,
  speechVolumeResetBtn: document.getElementById(ids.readingChatSpeechVolumeResetBtn) as HTMLButtonElement | null
};

function requireShell(): void {
  if (!els.root || !els.messages || !els.input) {
    throw new Error("AI 对话 tab 壳未就绪（readingChat* DOM 缺失）");
  }
}

let initialized = false;
let eventsBound = false;
let sessionGeneration = 0;
let initInFlight: Promise<void> | null = null;
let syncMoreMenuSlidersFromState = (): void => {};
let syncMoreMenuSlidersPatch = (_patch: ChatDisplaySettingsPatch): void => {};
let sessionClosed = false;

const suggestionsSlot = createChatSuggestionsSlot({
  messages: els.messages,
  id: ids.readingChatSuggestions,
  onPick: (prompt) => {
    void composer.sendViaInputBox(prompt);
  }
});

const feedback = createReaderChatFeedback({
  messages: els.messages,
  inputCard: els.input.closest(".chat-input-card"),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  scrollToBottom: () => chatRuntime.scrollToBottom(),
  suggestions: suggestionsSlot,
  onOpenSettings: (settingsTarget) => liveBridge.openChatSettings(settingsTarget)
});
const {
  showConversationContextNotice,
  removeConversationContextNotice,
  removePersistentContextNotice,
  showConversationContextError,
  removeCenteredState,
  removeSuggestions,
  isMessagesNearBottom,
  getMessagesBottomOffset
} = feedback;

const liveBridge = createChatLiveBridge({
  liveStatusRoot: els.liveStatus,
  getTimestampNavDeps: () => contextOrchestrator.getTimestampNavDeps(),
  showNotice: (message, autoHideMs) => showConversationContextNotice(message, autoHideMs),
  stopSpeech: () => chatRuntime.stopSpeech(),
  isTurnActive: () => chatRuntime.isTurnActive(),
  stopActiveStream: () => chatRuntime.stopActiveStream(),
  updateSendBtnState: () => composer.updateSendBtnState(),
  hideHistoryPopover: () => popovers.hideHistoryPopover({ focus: "none" }),
  hideMoreMenu: () => popovers.hideMoreMenu()
});

const inputImages = createChatInputImages({
  strip: els.imageStrip,
  isStreaming: () => chatRuntime.isStreaming(),
  onReject: (message) => showConversationContextNotice(message, 4000),
  onPendingChange: () => composer.updateSendBtnState(),
  focusInput: () => els.input.focus({ preventScroll: true })
});

const composer = createReaderChatComposer({
  els: {
    input: els.input,
    sendBtn: els.sendBtn
  },
  chatRuntime: {
    sendTurn: (text, options) => {
      setupFlow.clearViewHold();
      return chatRuntime.sendTurn(text, options);
    },
    isTurnActive: () => chatRuntime.isTurnActive(),
    stopActiveStream: () => {
      chatRuntime.stopActiveStream();
    }
  },
  onPasteImage: (e) => inputImages.handlePaste(e),
  onCancelSubtitleWait: () => sendGate.cancel(),
  onNotice: showConversationContextNotice,
  isImageProcessing: () => inputImages.isPending(),
  hasInputImages: () => inputImages.count() > 0,
  prepareManualPrompt: (text) => explainIntentController.buildFollowUpPrompt(text),
  getManualPromptAnchor: () => explainIntentController.getPendingFollowUpAnchor(),
  onManualPromptAccepted: () => explainIntentController.completePendingFollowUp(),
  ...liveBridge.getComposerLiveProps()
});

const explainIntentController = createExplainIntentController({
  card: els.intentCard,
  sendPrompt: (prompt, options) =>
    composer.sendViaInputBox(prompt, {
      preserveDraft: true,
      restoreOnReject: true,
      ...(options?.interactionAnchor ? { interactionAnchor: options.interactionAnchor } : {})
    }),
  isTurnActive: () => chatRuntime.isTurnActive(),
  onNotice: showConversationContextNotice,
  onFocusInput: () => els.input?.focus?.({ preventScroll: true })
});

const imageSupportGate = createImageSupportGate({
  getSelectedModelValue: () => els.modelSelect.value,
  notify: (message) => showConversationContextNotice(message, 4000)
});

const setupFlow = createChatSetupFlow({
  isSessionClosed: () => sessionClosed,
  isInitialized: () => initialized,
  hasSelectableModels: () => modelPanel.hasSelectableModels(),
  resolveSetupTarget: () => modelPanel.resolveSetupTarget(),
  reloadModelPanel: () => modelPanel.reload(),
  renderInitialState: () => contextOrchestrator.renderInitialState(),
  autosizeInput: () => composer.autosizeInput(),
  focusInput: () => els.input?.focus?.({ preventScroll: true }),
  showNotice: showConversationContextNotice
});

const contextOrchestrator = createChatContextOrchestrator({
  messagesEl: els.messages,
  inputEl: els.input,
  openSettingsId: ids.readingChatOpenSettings,
  isSessionClosed: () => sessionClosed,
  loadContextState: (opts) => contextLoad.loadContextState(opts),
  detachForRestart: () => conversationStore.detachForRestart(),
  isTurnActive: () => chatRuntime.isTurnActive(),
  setAutoScroll: (autoScroll) => chatRuntime.setAutoScroll(autoScroll),
  scrollToBottom: (force) => chatRuntime.scrollToBottom(force),
  renderReplay: () => conversationReplay.render(),
  invalidateReplay: () => conversationReplay.invalidate(),
  updateLayout: updateChatLayoutState,
  autosizeInput: () => composer.autosizeInput(),
  setStreamingUiState: (isStreaming) => composer.setStreamingUiState(isStreaming),
  getInputImageCount: () => inputImages.count(),
  clearInputImages: () => inputImages.clear(),
  resetSuggestionsShell: () => suggestionsSlot.render([]),
  renderSuggestions: () => lists.renderSuggestions(),
  resetScrollFollow: () => scrollFollow.reset(),
  hasSelectableModels: () => modelPanel.hasSelectableModels(),
  getSetupStateHtml: () => setupFlow.setupStateHtml(),
  invalidateSetupFlow: () => setupFlow.invalidate(),
  showNotice: showConversationContextNotice,
  hideOverlaysForNewChat: () => {
    popovers.hideHistoryPopover({ focus: "none" });
    popovers.hideModelPanel();
  },
  seekReadingTarget: (seconds) => seekReadingTarget(seconds)
});

const { runtime: chatRuntime, store: conversationStore, contextLoad, sendGate, replay: conversationReplay } = createChatTabDomain({
  messages: els.messages,
  input: els.input,
  updateChatLayoutState,
  suggestions: {
    render: () => lists.renderSuggestions(),
    clear: () => suggestionsSlot.clear()
  },
  ui: {
    setStreamingUiState: composer.setStreamingUiState,
    showConversationContextNotice,
    removeConversationContextNotice: removePersistentContextNotice,
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions,
    requestViewReset: contextOrchestrator.requestViewReset,
    autosizeInput: composer.autosizeInput,
    onTurnFailedRestoreDraft: ({ text, images }) => {
      if (els.input.value.trim() === "" && text) {
        els.input.value = text;
      }
      if (inputImages.count() === 0 && !inputImages.isPending() && images.length > 0) {
        inputImages.restoreImages(images);
      }
      composer.autosizeInput();
    },
    onSetupRequired: setupFlow.showSetupAction
  },
  onConversationChanged: (change) => {
    if (change.historyCleared) {
      lists.settlePendingDeletion();
    }
    lists.renderHistoryList();
    if (change.historyCleared) {
      els.historyList.querySelector<HTMLButtonElement>(".chat-history-start-new")?.focus({ preventScroll: true });
    }
    if (change.resetView) {
      contextOrchestrator.renderInitialState();
    }
  },
  onStreamInterrupted: () => {
    if (!contextOrchestrator.isRestartForContextFollow()) {
      chatRuntime.resetStreamState();
    }
    contextOrchestrator.resetConversationView();
    composer.setStreamingUiState(false);
  },
  onContextNotice: (notice) => {
    if (notice.kind === "pending") {
      showConversationContextNotice(notice.message);
    } else if (notice.kind === "clear") {
      removeConversationContextNotice();
    } else {
      showConversationContextError(notice.message);
    }
  },
  renderHistoryList: () => lists.renderHistoryList(),
  renderInitialState: contextOrchestrator.renderInitialState,
  restartChat: contextOrchestrator.restartChat,
  requestViewReset: contextOrchestrator.requestViewReset,
  storage: chrome.storage.local,
  clip: () => state.clip,
  settings: () => state.settings,
  isSessionClosed: () => sessionClosed,
  isReaderTranscribing,
  asrNotice: els.asrNotice,
  pageBvid: () => extractBvid(location.href),
  startSubtitleFetch,
  subscribeStatusPhase: subscribeSubtitleStatusPhase,
  onWaitingChange: (waiting) => composer.setSubtitleWaitUi(waiting),
  getProviderId: () => parseModelOptionValue(els.modelSelect.value).providerId,
  getSelectedModel: () => parseModelOptionValue(els.modelSelect.value).model,
  getInputImages: () => inputImages.getImages(),
  takeInputImages: (snapshot) => {
    const images = inputImages.takeImages(snapshot);
    imageSupportGate.check(images);
    return images;
  },
  canUseVideoFrameTool: () => imageSupportGate.supportsImages(),
  getPlaybackCursorSeconds: () => {
    const video = getRuntimeVideoElement() || state.reader.readingVideoEl;
    const currentTime = video?.currentTime;
    return typeof currentTime === "number" && Number.isFinite(currentTime) && currentTime >= 0
      ? currentTime
      : undefined;
  },
  captureCurrentVideoFrame: async (targetTime?: number, signal?: AbortSignal) => {
    if (targetTime === undefined) {
      const frame = await capturePageVideoFrame();
      return {
        image: { mime: "image/jpeg", data: encodeBase64Bytes(frame.jpegBytes) },
        currentTime: frame.currentTime
      };
    }
    const frames = await captureHistoricalVideoFrame({ bvid: state.clip.bvid, cid: state.clip.cid, targetTime }, { signal });
    return frames.map((frame) => ({
      image: { mime: "image/jpeg", data: encodeBase64Bytes(frame.jpegBytes) },
      currentTime: frame.currentTime
    }));
  },
  getTimestampNavDeps: contextOrchestrator.getTimestampNavDeps,
  normalizeMarkdownForSectionPaste,
  getSpeechVolume: () => CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.normalize(state.settings?.speechVoiceVolume) / 100,
  connectPort: async () => {
    if (sessionClosed) {
      throw new Error("阅读模式已关闭，对话已中止。");
    }
    await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
    return chrome.runtime.connect({ name: OFFSCREEN_CHAT_PORT_NAME });
  },
  isLiveActive: () => liveBridge.isActive()
});

const { loadContextState } = contextLoad;

function openConversationById(id: string): void {
  chatRuntime.stopSpeech();
  conversationStore.applyById(id);
}

const lists = createReaderChatLists({
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  applyById: openConversationById,
  settleTurn: () => (chatRuntime.isTurnActive() ? chatRuntime.settleTurn() : undefined),
  deleteById: (id) => {
    contextOrchestrator.clearRestartForContextFollow();
    return conversationStore.deleteById(id);
  },
  isTurnActive: () => chatRuntime.isTurnActive(),
  confirmDeleteCurrent: (message) => confirmDialog({ message, confirmText: "删除", danger: true }),
  startNewConversation: contextOrchestrator.startNewConversation,
  suggestions: suggestionsSlot,
  hideHistoryPopover: () => popovers.hideHistoryPopover({ focus: "input" })
});

const popovers = createReaderChatPopovers({
  historyPopover: els.historyPopover,
  modelPanel: els.modelPanel,
  historyBtn: els.historyBtn,
  modelChipBtn: els.modelChip,
  historyBackBtn: els.historyBackBtn,
  conversationInput: els.input,
  historyExitFocusEl: els.moreBtn,
  moreBtn: els.moreBtn,
  moreMenu: els.moreMenu,
  renderHistoryList: (options) => lists.renderHistoryList(options),
  settlePendingDeletion: () => lists.settlePendingDeletion(),
  cancelPendingSwitch: () => lists.cancelPendingSwitch(),
  exitLiveHistoryDetail: () => lists.exitLiveHistoryDetail(),
  resetLiveHistoryDetail: () => lists.resetLiveHistoryDetail(),
  renderModelPanel: () => modelPanel.renderPanel()
});

const modelPanel = createReaderChatModelPanel({
  modelSelect: els.modelSelect,
  chip: els.modelChip,
  chipModel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-model") as HTMLElement,
  chipLevel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-level") as HTMLElement,
  panelList: els.modelPanelList,
  panel: els.modelPanel,
  thinkingToggle: els.thinkingToggle,
  thinkingRow: els.thinkingRow,
  thinkingRowValue: els.thinkingRowValue,
  thinkingHint: document.getElementById(ids.readingChatThinkingHint) as HTMLElement | null,
  webSearchPill: els.webSearchPill,
  storage: chrome.storage.local,
  hidePanel: () => popovers.hideModelPanel(),
  openSettings: () => {
    const { errorClass, providerId } = modelPanel.resolveSetupTarget();
    setupFlow.beginSetup(errorClass, { providerId });
  }
});

const scrollFollow = createScrollFollowController({
  messages: els.messages,
  scrollBottomBtn: els.scrollBottomBtn,
  getBottomOffset: getMessagesBottomOffset,
  isNearBottom: isMessagesNearBottom,
  setAutoScroll: (autoScroll) => chatRuntime.setAutoScroll(autoScroll),
  scrollToBottom: (smooth) => chatRuntime.scrollToBottom(smooth)
});

const sessionTriggers = createReaderChatSessionTriggers({
  statusBus: () => {
    sendGate.bindStatusBus();
    return () => sendGate.unbindStatusBus();
  },
  urlChange: () => {
    let clipSignature = computeCurrentClipSignature();
    const handler = () => {
      const nextSignature = computeCurrentClipSignature();
      if (nextSignature === clipSignature) {
        return;
      }
      clipSignature = nextSignature;
      quickActionGeneration += 1;
      setupFlow.invalidate();
      sendGate.cancel();
      deactivateChatTabOverlays();
      dismissConfirmDialog();
      contextOrchestrator.clearRestartForContextFollow();
      lists.settlePendingDeletion();
      conversationStore.detachForRestart();
      contextOrchestrator.scheduleLiveContextSync();
    };
    return contentEventBus.on("host:url-change", handler);
  },
  clipSettle: () => subscribeReaderPresenter((event) => {
    if (event.kind === "subtitle-ready") {
      contextOrchestrator.scheduleLiveContextSync({ forceRefresh: false, preserveInput: true });
    }
  }),
  storageWatcher: () => {
    const unwatchProviders = watchStorageKeys(() => {
      void refreshProvidersAndPrefsAfterExternalChange();
      void liveBridge.refreshTarget();
    }, {
      sync: [
        "aiProviders",
        "aiSystemPrompt",
        "aiInitialQuickPrompts",
        "defaultModel",
        "defaultAiModel",
        "aiThinkingLevel",
        "liveProviders",
        "activeLiveProviderId",
        "webSearchEnabled"
      ],
      local: ["aiProviderKeys"]
    });
    const unwatchPresentation = watchChatDisplaySettings((patch) => {
      syncMoreMenuSlidersPatch(patch);
    });
    const unwatchConversations = watchStorageKeys((changes) => {
      if (!(CONVERSATIONS_STORAGE_KEY in changes)) {
        return;
      }
      const rawNext = changes[CONVERSATIONS_STORAGE_KEY]?.newValue;
      if (syncSavedConversationsFromStorage(rawNext)) {
        lists.renderHistoryList();
        if (hasExternalizedChatImages(rawNext) && typeof chrome !== "undefined" && chrome.storage?.local) {
          void readConversationHistory(chrome.storage.local)
            .then(() => {
              lists.renderHistoryList();
            })
            .catch(() => {});
        }
      }
    }, {
      local: [CONVERSATIONS_STORAGE_KEY]
    });
    return () => {
      unwatchConversations();
      unwatchPresentation();
      unwatchProviders();
    };
  },
  quickPrompts: () => subscribeQuickPromptsChange(() => {
    if (!initialized || chatRuntime.isStreaming()) {
      return;
    }
    lists.renderSuggestions();
  }),
  outsideClick: () => {
    setChatTabOutsideClickHandler((event) => {
      popovers.handleDocumentClick(event);
    });
    return () => setChatTabOutsideClickHandler(null);
  },
  escapeKey: () => {
    window.addEventListener("keydown", onWindowEscapeKey);
    return () => window.removeEventListener("keydown", onWindowEscapeKey);
  }
});

function onWindowEscapeKey(event: KeyboardEvent): void {
  popovers.handleEscapeKey(event);
}

async function initChatTab({ consumeIntent }: { consumeIntent: boolean }): Promise<void> {
  const generation = ++sessionGeneration;
  sessionClosed = false;
  const isStale = () => sessionClosed || generation !== sessionGeneration;
  requireShell();
  bindEvents();
  sessionTriggers.activate();
  await Promise.all([
    sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null),
    modelPanel.reload(),
    conversationStore.loadAll(),
    loadContextState(),
    liveBridge.refreshTarget()
  ]);
  if (isStale()) {
    sessionTriggers.deactivate();
    return;
  }
  await conversationStore.restoreLatest();
  if (isStale()) {
    sessionTriggers.deactivate();
    return;
  }
  contextOrchestrator.renderInitialState();
  composer.autosizeInput();
  initialized = true;
  if (consumeIntent) {
    await explainIntentController.consumeIfPending();
  }
}

async function restoreChatSession(): Promise<void> {
  const generation = ++sessionGeneration;
  const isStale = () => sessionClosed || generation !== sessionGeneration;
  liveBridge.bindHooksIfSupported();
  await modelPanel.reload().catch(() => null);
  if (isStale()) {
    return;
  }
  void liveBridge.refreshTarget();
  const ok = await loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
  if (!ok || isStale()) {
    return;
  }
  const restored = await conversationStore.restoreLatest();
  if (isStale()) {
    return;
  }
  if (!restored && chatSessionState.liveContextData) {
    applyLiveContextToMain();
  }
  contextOrchestrator.renderInitialState();
  composer.autosizeInput();
}

export async function ensureChatTabActivated({ consumeIntent = true }: { consumeIntent?: boolean } = {}): Promise<void> {
  if (!initialized) {
    if (!initInFlight) {
      const currentInit = initChatTab({ consumeIntent }).finally(() => {
        if (initInFlight === currentInit) {
          initInFlight = null;
        }
      });
      initInFlight = currentInit;
    }
    await initInFlight;
    return;
  }
  if (sessionClosed) {
    sessionClosed = false;
    sessionTriggers.activate();
    await restoreChatSession();
  }
  if (consumeIntent && !sessionClosed) {
    await explainIntentController.consumeIfPending();
  }
}

export function stopChatSpeech(): void {
  chatRuntime.stopSpeech();
}

export function deactivateChatTabOverlays(): void {
  popovers.hideMoreMenu();
  popovers.hideModelPanel({ restoreFocus: false });
  popovers.hideHistoryPopover({ focus: "none" });
  chatRuntime.closeImageViewer({ restoreFocus: false });
  inputImages.closeViewer(false);
}

export function closeChatSession(): void {
  sessionGeneration += 1;
  sessionClosed = true;
  initInFlight = null;
  contextOrchestrator.clearRestartForContextFollow();
  quickActionGeneration += 1;
  setupFlow.invalidate();
  contextOrchestrator.cancelPendingSync();
  liveBridge.closeSession();
  if (!initialized) {
    sessionTriggers.deactivate();
    return;
  }
  chatRuntime.resetStreamState();
  composer.setStreamingUiState(false);
  scrollFollow.reset();
  sendGate.cancel();
  composer.setSubtitleWaitUi(false);
  conversationReplay.invalidate();
  deactivateChatTabOverlays();
  lists.cancelPendingSwitch();
  lists.settlePendingDeletion();
  removeConversationContextNotice();
  sendGate.refreshAsrNotice();
  explainIntentController.hide();
  sessionTriggers.deactivate();
}

let quickActionInFlight: Promise<boolean> | null = null;
let quickActionGeneration = 0;

export async function runQuickActionPrompt(prompt: string): Promise<boolean> {
  if (quickActionInFlight) {
    return false;
  }
  const generation = quickActionGeneration;
  quickActionInFlight = (async () => {
    await activateScriptTab("chat", { consumeIntent: false });
    if (generation !== quickActionGeneration || sessionClosed) {
      return false;
    }
    const text = String(prompt || "").trim();
    if (!text) {
      composer.autosizeInput();
      els.input?.focus?.({ preventScroll: true });
      return false;
    }
    if (chatRuntime.isTurnActive()) {
      showConversationContextNotice("当前对话正在生成或发送，请稍后再试。", 4000);
      els.input?.focus?.({ preventScroll: true });
      return false;
    }
    return composer.sendDetachedPrompt(text);
  })();
  try {
    return await quickActionInFlight;
  } finally {
    quickActionInFlight = null;
  }
}

function bindEvents(): void {
  if (eventsBound) {
    liveBridge.bindHooksIfSupported();
    return;
  }
  eventsBound = true;
  composer.bind();
  scrollFollow.bind();
  const chatDisplaySliders = bindChatDisplaySliders({
    chatLineHeight: {
      input: els.lineHeightSlider,
      badge: els.lineHeightValue,
      resetBtn: els.lineHeightResetBtn
    },
    chatParagraphSpacing: {
      input: els.paraSpacingSlider,
      badge: els.paraSpacingValue,
      resetBtn: els.paraSpacingResetBtn
    },
    speechVoiceVolume: {
      input: els.speechVolumeInput,
      badge: els.speechVolumeValue,
      resetBtn: els.speechVolumeResetBtn,
      row: els.speechVolume
    }
  });

  syncMoreMenuSlidersFromState = () => chatDisplaySliders.syncFromState();
  syncMoreMenuSlidersPatch = (patch) => chatDisplaySliders.syncPatch(patch);

  els.moreBtn?.addEventListener("click", (event) => {
    syncMoreMenuSlidersFromState();
    popovers.toggleMoreMenu(event);
  });
  els.newChatBtn?.addEventListener("click", () => {
    popovers.hideMoreMenu();
    void contextOrchestrator.startNewConversation();
  });
  els.historyBtn?.addEventListener("click", (event) => {
    chatRuntime.stopSpeech();
    popovers.toggleHistoryPopover(event);
  });
  els.displaySettingsBtn?.addEventListener("click", () => {
    liveBridge.openChatSettings("appearance");
  });
  els.historyClearBtn?.addEventListener("click", () => {
    void conversationStore.clearAll();
  });
  els.historyBackBtn?.addEventListener("click", () => {
    popovers.hideHistoryPopover();
  });

  liveBridge.initEvents();
  els.modelChip.addEventListener("click", popovers.toggleModelPanel);
  els.root.addEventListener("click", (event) => {
    const target = event.target as HTMLElement | null;
    const removeBtn = target?.closest<HTMLElement>("[data-chat-image-remove]");
    if (removeBtn) {
      inputImages.removeAt(Number(removeBtn.dataset.chatImageRemove));
      return;
    }
    if (target?.closest<HTMLElement>(`[id="${ids.readingChatOpenSettings}"]`)) {
      event.preventDefault();
      event.stopPropagation();
      const { errorClass, providerId } = modelPanel.resolveSetupTarget();
      setupFlow.beginSetup(errorClass, { providerId, mode: "blocked" });
    }
  });
  const inputCard = els.input.closest<HTMLElement>(".chat-input-card");
  if (inputCard) {
    const hasDraggedFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    inputCard.addEventListener("dragover", (event) => {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
    });
    inputCard.addEventListener("drop", (event) => {
      if (!hasDraggedFiles(event)) {
        return;
      }
      event.preventDefault();
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) {
        return;
      }
      const imageFiles = files.filter((file) => /^image\//i.test(String(file.type || "")));
      if (!imageFiles.length) {
        showConversationContextNotice("仅支持拖入图片文件", 4000);
        return;
      }
      inputImages.addFiles(imageFiles);
    });
  }
}

function isConversationViewActive(): boolean {
  return chatRuntime.isTurnActive();
}

async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  const previousProviderId = String(els.modelSelect?.value || "").trim();
  await modelPanel.reload({ preferredProviderId: previousProviderId || undefined });
  lists.renderHistoryList();
  if (isConversationViewActive() || setupFlow.isViewHeld()) {
    return;
  }
  contextOrchestrator.renderInitialState();
}

function updateChatLayoutState(): void {
  if (els.input) {
    composer.autosizeInput();
  }
}

async function startSubtitleFetch(): Promise<boolean> {
  return kickSubtitleFetch(() => requestSubtitleRefresh(), {
    onChainLoadFailed: (error) => logWarn("[BILISCRIPT] subtitle fetch start failed", { error }),
    awaitRefresh: false,
    onRefreshFailed: (error) => logWarn("[BILISCRIPT] subtitle refresh failed", { error })
  });
}
