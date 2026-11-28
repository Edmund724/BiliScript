import { state } from "../core/state.js";
import { normalizeSettingField } from "../core/settings-store.js";
import { normalizeNoteExportTarget } from "../core/validators.js";
import { activeById, getActiveReaderWindow, onActiveHostChange } from "../shared/active-host.js";
import { safeRemoveListener } from "../shared/cross-doc.js";
import { computeCurrentClipSignature, extractVideoId } from "../bilibili/video-id-shared.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import { getSiteCapabilities } from "../shared/site.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { confirmDialog, dismissConfirmDialog } from "../ui/confirm-dialog.js";
import { buildVideoNotePrompt } from "../notes/note-prompts.js";
import {
  captureLiveClipSignature,
  handleCommittedChatTurnForNotes
} from "../notes/auto-export-controller.js";
import { syncSaveNoteButtons } from "../chat/render/message-actions.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  bindChatDisplaySliders,
  watchChatDisplaySettings,
  type ChatDisplaySettingsPatch
} from "./chat-display-settings.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { createDisposableContext, type DisposableContext } from "../shared/typed-event-bus.js";
import {
  CONVERSATIONS_STORAGE_KEY,
  CONVERSATIONS_SYNC_SIGNAL_KEY,
  OFFSCREEN_CHAT_PORT_NAME,
  applyConversationSyncSignal,
  applyLiveContextToMain,
  chatSessionState,
  createChatTabDomain,
  detachConversationIdentity,
  parseModelOptionValue,
  syncSavedConversationsFromStorage,
  type ChatTurnKind
} from "../chat/tab-domain.js";
import { subscribeQuickPromptsChange } from "../chat/quick-prompt-cache.js";
import { contentEventBus } from "../shared/content-event-bus.js";
import { subscribeSubtitleStatusPhase } from "../shared/subtitle-status-bus.js";
import { isReaderTranscribing } from "./transcribe-banner.js";
import { createExplainIntentController } from "./explain-intent.js";
import { createReaderChatLists } from "./chat-lists.js";
import { createReaderChatFeedback } from "./chat-notices.js";
import { createChatNoteBar } from "./chat-note-bar.js";
import { createChatSuggestionsSlot } from "./chat-suggestions-slot.js";
import { createReaderChatModelPanel } from "./chat-model-panel.js";
import { createReaderChatPopovers } from "./chat-popovers.js";
import { createChatSetupFlow } from "./chat-setup-flow.js";
import { createChatLiveBridge } from "./chat-live-bridge.js";
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
import { getSiteRuntimeVideoElement } from "../core/site-video-probe.js";
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
  root: activeById(ids.readingChatRoot) as HTMLElement,
  modelChip: activeById<HTMLButtonElement>(ids.readingChatModelChip) as HTMLButtonElement,
  modelPanel: activeById(ids.readingChatModelPanel) as HTMLElement,
  modelPanelList: activeById(ids.readingChatModelList) as HTMLElement,
  thinkingToggle: activeById(ids.readingChatThinkingToggle) as HTMLElement,
  thinkingRow: activeById(ids.readingChatThinkingRow) as HTMLElement,
  thinkingRowValue: activeById(ids.readingChatThinkingRowValue) as HTMLElement,
  webSearchPill: activeById(ids.readingChatWebSearchPill),
  toolsBtn: activeById<HTMLButtonElement>(ids.readingChatToolsBtn),
  toolsMenu: activeById(ids.readingChatToolsMenu),
  newChatBtn: activeById<HTMLButtonElement>(ids.readingChatNewBtn) as HTMLButtonElement,
  historyBtn: activeById<HTMLButtonElement>(ids.readingChatHistoryBtn) as HTMLButtonElement,
  moreBtn: activeById<HTMLButtonElement>(ids.readingChatMoreBtn),
  moreMenu: activeById(ids.readingChatMoreMenu),
  displaySettingsBtn: activeById<HTMLButtonElement>(ids.readingChatDisplaySettingsBtn),
  lineHeightSlider: activeById<HTMLInputElement>(ids.readingChatLineHeight),
  lineHeightValue: activeById(ids.readingChatLineHeightValue),
  lineHeightResetBtn: activeById<HTMLButtonElement>(ids.readingChatLineHeightResetBtn),
  paraSpacingSlider: activeById<HTMLInputElement>(ids.readingChatParagraphSpacing),
  paraSpacingValue: activeById(ids.readingChatParagraphSpacingValue),
  paraSpacingResetBtn: activeById<HTMLButtonElement>(ids.readingChatParagraphSpacingResetBtn),
  historyPopover: activeById(ids.readingChatHistoryPopover) as HTMLElement,
  historyList: activeById(ids.readingChatHistoryList) as HTMLElement,
  historyClearBtn: activeById<HTMLButtonElement>(ids.readingChatHistoryClearBtn),
  historyBackBtn: activeById<HTMLButtonElement>(ids.readingChatHistoryBackBtn),
  messages: activeById(ids.readingChatMessages) as HTMLElement,
  scrollBottomBtn: activeById<HTMLButtonElement>(ids.readingChatScrollBottomBtn) as HTMLButtonElement,
  noteBar: activeById(ids.readingChatNoteBar),
  input: activeById<HTMLTextAreaElement>(ids.readingChatInput) as HTMLTextAreaElement,
  imageStrip: activeById(ids.readingChatImageStrip),
  sendBtn: activeById<HTMLButtonElement>(ids.readingChatSendBtn) as HTMLButtonElement,
  asrNotice: activeById(ids.readingChatAsrNotice),
  liveStatus: activeById(ids.readingChatLiveStatus),
  intentCard: activeById(ids.readingChatIntent),
  speechVolume: activeById(ids.readingChatSpeechVolume),
  speechVolumeInput: activeById<HTMLInputElement>(ids.readingChatSpeechVolumeInput),
  speechVolumeValue: activeById(ids.readingChatSpeechVolumeValue),
  speechVolumeResetBtn: activeById<HTMLButtonElement>(ids.readingChatSpeechVolumeResetBtn)
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

const noteBar = createChatNoteBar({
  host: els.noteBar,
  hasSelectableModels: () => modelPanel.hasSelectableModels(),
  onPickVideoNote: () => {
    void runVideoNotePrompt();
  },
  onOpenMenu: () => {
    popovers.hideModelPanel({ restoreFocus: false });
    popovers.hideMoreMenu();
    popovers.hideToolsMenu({ restoreFocus: false });
  }
});

const feedback = createReaderChatFeedback({
  messages: els.messages,
  inputCard: els.input.closest(".chat-input-card"),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (handle) => window.clearTimeout(handle),
  scrollToBottom: () => chatDomain.scrollToBottom(),
  onOpenSettings: (settingsTarget) => liveBridge.openChatSettings(settingsTarget)
});
const {
  messagesNotice,
  inputNotice,
  clearAllNotices,
  showConversationContextError,
  removeCenteredState
} = feedback;

const liveBridge = createChatLiveBridge({
  liveStatusRoot: els.liveStatus,
  getTimestampNavDeps: () => chatDomain.getTimestampNavDeps(),
  showNotice: (message, autoHideMs) => messagesNotice.show(message, autoHideMs),
  stopSpeech: () => chatDomain.stopSpeech(),
  isTurnActive: () => chatDomain.isTurnActive(),
  stopActiveStream: () => chatDomain.stopActiveStream(),
  updateSendBtnState: () => composer.updateSendBtnState(),
  hideHistoryPopover: () => popovers.hideHistoryPopover({ focus: "none" }),
  hideMoreMenu: () => popovers.hideMoreMenu()
});

const inputImages = createChatInputImages({
  strip: els.imageStrip,
  isStreaming: () => chatDomain.isStreaming(),
  onReject: (message) => messagesNotice.show(message, 4000),
  onPendingChange: () => composer.updateSendBtnState(),
  focusInput: () => els.input.focus({ preventScroll: true })
});

function isLiveCompanionAllowed(): boolean {
  return supportsLiveCompanion() && getSiteCapabilities(state.clip.site).supportsLiveCompanion;
}

const composerLiveProps = isLiveCompanionAllowed() ? liveBridge.getComposerLiveProps() : {};

const composer = createReaderChatComposer({
  els: {
    input: els.input,
    sendBtn: els.sendBtn
  },
  chatRuntime: {
    sendTurn: (text, options) => {
      pendingQuickActionRetry = null;
      setupFlow.clearViewHold();
      return chatDomain.sendTurn(text, options);
    },
    isTurnActive: () => chatDomain.isTurnActive(),
    stopActiveStream: () => {
      chatDomain.stopActiveStream();
    }
  },
  onPasteImage: (e) => inputImages.handlePaste(e),
  onCancelSubtitleWait: () => chatDomain.cancelSubtitleWait(),
  onNotice: messagesNotice.show,
  isImageProcessing: () => inputImages.isPending(),
  hasInputImages: () => inputImages.count() > 0,
  prepareManualPrompt: (text) => explainIntentController.buildFollowUpPrompt(text),
  getManualPromptAnchor: () => explainIntentController.getPendingFollowUpAnchor(),
  onManualPromptAccepted: () => explainIntentController.completePendingFollowUp(),
  ...(composerLiveProps.onStartLive
    ? {
        getLiveState: () =>
          isLiveCompanionAllowed() && composerLiveProps.getLiveState
            ? composerLiveProps.getLiveState()
            : "idle",
        onStartLive: () => {
          if (isLiveCompanionAllowed()) {
            composerLiveProps.onStartLive?.();
          }
        }
      }
    : {})
});

const explainIntentController = createExplainIntentController({
  card: els.intentCard,
  sendPrompt: (prompt, options) =>
    composer.sendViaInputBox(prompt, {
      preserveDraft: true,
      restoreOnReject: true,
      ...(options?.interactionAnchor ? { interactionAnchor: options.interactionAnchor } : {})
    }),
  isTurnActive: () => chatDomain.isTurnActive(),
  onNotice: messagesNotice.show,
  onFocusInput: () => els.input?.focus?.({ preventScroll: true })
});

const imageSupportGate = createImageSupportGate({
  getSelectedModelValue: () => modelPanel.getSelectedValue(),
  notify: (message) => messagesNotice.show(message, 4000)
});

const setupFlow = createChatSetupFlow({
  isSessionClosed: () => sessionClosed,
  isInitialized: () => initialized,
  hasSelectableModels: () => modelPanel.hasSelectableModels(),
  resolveSetupTarget: () => modelPanel.resolveSetupTarget(),
  reloadModelPanel: () => modelPanel.reload(),
  renderInitialState: () => chatDomain.renderInitialState(),
  autosizeInput: () => composer.autosizeInput(),
  focusInput: () => els.input?.focus?.({ preventScroll: true }),
  showNotice: messagesNotice.show
});

const chatDomain = createChatTabDomain({
  messages: els.messages,
  input: els.input,
  ui: {
    setStreamingUiState: composer.setStreamingUiState,
    messagesNotice,
    inputNotice,
    hideHistoryPopover: () => popovers.hideHistoryPopover(),
    removeCenteredState,
    removeSuggestions: () => {
      suggestionsSlot.clear();
      noteBar.refresh();
    },
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
  view: {
    hasSelectableModels: () => modelPanel.hasSelectableModels(),
    getSetupStateHtml: () => setupFlow.setupStateHtml(),
    focusSetupAction: () => activeById(ids.readingChatOpenSettings)?.focus({ preventScroll: true }),
    getInputImageCount: () => inputImages.count(),
    clearInputImages: () => inputImages.clear(),
    suggestions: {
      refresh: () => {
        suggestionsSlot.refresh();
        noteBar.refresh();
      },
      clear: () => {
        suggestionsSlot.clear();
        noteBar.refresh();
      },
      reset: () => {
        suggestionsSlot.reset();
        noteBar.refresh();
      }
    },
    resetScrollFollow: () => scrollFollow.reset(),
    prepareForNewConversation: () => {
      setupFlow.invalidate();
      popovers.hideHistoryPopover({ focus: "none" });
      popovers.hideModelPanel();
      noteBar.closeMenu();
    },
    seekReadingTarget: (seconds) => seekReadingTarget(seconds)
  },
  onConversationChanged: (change) => {
    pendingQuickActionRetry = null;
    if (change.historyCleared) {
      lists.settlePendingDeletion();
    }
    lists.renderHistoryList();
    noteBar.refresh();
    if (change.historyCleared) {
      els.historyList.querySelector<HTMLButtonElement>(".chat-history-start-new")?.focus({ preventScroll: true });
    }
  },
  onContextNotice: (notice) => {
    if (notice.kind === "pending") {
      messagesNotice.show(notice.message);
    } else if (notice.kind === "clear") {
      clearAllNotices();
    } else {
      showConversationContextError(notice.message);
    }
  },
  renderHistoryList: () => lists.renderHistoryList(),
  storage: chrome.storage.local,
  clip: () => state.clip,
  settings: () => state.settings,
  isSessionClosed: () => sessionClosed,
  isReaderTranscribing,
  asrNotice: els.asrNotice,
  pageBvid: () => extractVideoId(location.href),
  startSubtitleFetch,
  subscribeStatusPhase: subscribeSubtitleStatusPhase,
  onWaitingChange: (waiting) => composer.setSubtitleWaitUi(waiting),
  onRetrySubtitleReady: async () => {
    const pending = pendingQuickActionRetry;
    if (
      !pending ||
      sessionClosed ||
      pending.clipSignature !== computeCurrentClipSignature() ||
      chatDomain.isTurnActive()
    ) {
      return false;
    }
    pendingQuickActionRetry = null;
    return composer.sendDetachedPrompt(pending.prompt, {
      turnKind: pending.turnKind,
      expectedClipSignature: pending.expectedClipSignature
    });
  },
  getProviderId: () => parseModelOptionValue(modelPanel.getSelectedValue()).providerId,
  getSelectedModel: () => parseModelOptionValue(modelPanel.getSelectedValue()).model,
  getInputImages: () => inputImages.getImages(),
  takeInputImages: (snapshot) => {
    const images = inputImages.takeImages(snapshot);
    imageSupportGate.check(images);
    return images;
  },
  canUseVideoFrameTool: () => imageSupportGate.supportsImages(),
  getPlaybackCursorSeconds: () => {
    const video =
      state.clip.site === "youtube"
        ? getSiteRuntimeVideoElement()
        : getSiteRuntimeVideoElement() || state.reader.readingVideoEl;
    const currentTime = video?.currentTime;
    return typeof currentTime === "number" && Number.isFinite(currentTime) && currentTime >= 0
      ? currentTime
      : undefined;
  },
  captureCurrentVideoFrame: async (targetTime?: number, signal?: AbortSignal) => {
    if (targetTime === undefined) {
      const frame = await capturePageVideoFrame({ getVideo: getSiteRuntimeVideoElement });
      return {
        image: { mime: "image/jpeg", data: encodeBase64Bytes(frame.jpegBytes) },
        currentTime: frame.currentTime
      };
    }
    if (!getSiteCapabilities(state.clip.site).supportsHistoricalFrameCapture) {
      throw new Error(`当前站点不支持历史时间点截帧: ${state.clip.site}`);
    }
    const frames = await captureHistoricalVideoFrame(
      { site: state.clip.site, bvid: state.clip.bvid, cid: state.clip.cid, targetTime },
      { signal }
    );
    return frames.map((frame) => ({
      image: { mime: "image/jpeg", data: encodeBase64Bytes(frame.jpegBytes) },
      currentTime: frame.currentTime
    }));
  },
  getSpeechVolume: () => CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.normalize(state.settings?.speechVoiceVolume) / 100,
  connectPort: async () => {
    if (sessionClosed) {
      throw new Error("阅读模式已关闭，对话已中止。");
    }
    await sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null);
    return chrome.runtime.connect({ name: OFFSCREEN_CHAT_PORT_NAME });
  },
  isLiveActive: () => isLiveCompanionAllowed() && liveBridge.isActive(),
  getNoteExportTarget: () => normalizeNoteExportTarget(state.settings?.noteExportTarget),
  onTurnCommitted: (info) => {
    void handleCommittedChatTurnForNotes(info, {
      isSessionClosed: () => sessionClosed,
      onNotice: (message, autoHideMs, options) => messagesNotice.show(message, autoHideMs, options)
    });
  }
});

const lists = createReaderChatLists({
  historyList: els.historyList,
  historyClearBtn: els.historyClearBtn,
  applyById: (id) => chatDomain.openConversation(id),
  settleTurn: () => (chatDomain.isTurnActive() ? chatDomain.settleTurn() : undefined),
  deleteById: (id) => chatDomain.deleteConversation(id),
  isTurnActive: () => chatDomain.isTurnActive(),
  confirmDeleteCurrent: (message) => confirmDialog({ message, confirmText: "删除", danger: true }),
  startNewConversation: () => chatDomain.startNewConversation(),
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
  toolsBtn: els.toolsBtn,
  toolsMenu: els.toolsMenu,
  renderHistoryList: (options) => lists.renderHistoryList(options),
  settlePendingDeletion: () => lists.settlePendingDeletion(),
  cancelPendingSwitch: () => lists.cancelPendingSwitch(),
  exitLiveHistoryDetail: () => lists.exitLiveHistoryDetail(),
  resetLiveHistoryDetail: () => lists.resetLiveHistoryDetail(),
  renderModelPanel: () => modelPanel.renderPanel()
});

const modelPanel = createReaderChatModelPanel({
  chip: els.modelChip,
  chipModel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-model") as HTMLElement,
  chipLevel: els.modelChip.querySelector<HTMLElement>(".chat-model-chip-level") as HTMLElement,
  panelList: els.modelPanelList,
  panel: els.modelPanel,
  thinkingToggle: els.thinkingToggle,
  thinkingRow: els.thinkingRow,
  thinkingRowValue: els.thinkingRowValue,
  thinkingHint: activeById(ids.readingChatThinkingHint),
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
  setAutoScroll: (autoScroll) => chatDomain.setAutoScroll(autoScroll),
  scrollToBottom: (smooth) => chatDomain.scrollToBottom(smooth)
});

let sessionTriggerScope: DisposableContext | null = null;

function activateSessionTriggers(): void {
  if (sessionTriggerScope && !sessionTriggerScope.isDisposed()) {
    return;
  }
  const scope = createDisposableContext();
  sessionTriggerScope = scope;

  scope.track(chatDomain.bindStatusBus());

  let clipSignature = computeCurrentClipSignature();
  scope.track(contentEventBus.on("host:url-change", () => {
    const nextSignature = computeCurrentClipSignature();
    if (nextSignature === clipSignature) {
      return;
    }
    clipSignature = nextSignature;
    quickActionGeneration += 1;
    pendingQuickActionRetry = null;
    setupFlow.invalidate();
    deactivateChatTabOverlays();
    dismissConfirmDialog();
    lists.settlePendingDeletion();
    chatDomain.handleHostClipChanged();
  }));

  scope.track(subscribeReaderPresenter((event) => {
    if (event.kind === "subtitle-ready") {
      chatDomain.scheduleLiveContextSync({ forceRefresh: false, preserveInput: true });
    }
  }));

  const unwatchProviders = watchStorageKeys(() => {
    void refreshProvidersAndPrefsAfterExternalChange();
    if (isLiveCompanionAllowed()) {
      void liveBridge.refreshTarget();
    }
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
    if (CONVERSATIONS_SYNC_SIGNAL_KEY in changes) {
      const signal = changes[CONVERSATIONS_SYNC_SIGNAL_KEY]?.newValue;
      const local = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
      void applyConversationSyncSignal(signal, {
        storage: local,
        onCurrentUpdated: () => {
          chatDomain.renderInitialState();
        }
      })
        .then((changed) => {
          if (changed) {
            lists.renderHistoryList();
          }
        })
        .catch(() => {});
      return;
    }
    if (!(CONVERSATIONS_STORAGE_KEY in changes)) {
      return;
    }
    const rawNext = changes[CONVERSATIONS_STORAGE_KEY]?.newValue;
    if (!Array.isArray(rawNext) || rawNext.length === 0) {
      return;
    }
    if (syncSavedConversationsFromStorage(rawNext)) {
      lists.renderHistoryList();
    }
  }, {
    local: [CONVERSATIONS_SYNC_SIGNAL_KEY, CONVERSATIONS_STORAGE_KEY]
  });
  const unwatchNoteSettings = watchStorageKeys((changes) => {
    const patch: Record<string, unknown> = {};
    const keys = [
      "notePromptPreset",
      "noteCustomPrompt",
      "noteExportTarget",
      "noteDownloadSubdir",
      "noteIncludeKeyframes",
      "playerAiActionMode",
      "playerAiAutoExportNote"
    ] as const;
    for (const key of keys) {
      if (key in changes) {
        patch[key] = normalizeSettingField(key, changes[key]?.newValue);
      }
    }
    if (Object.keys(patch).length > 0) {
      state.patchSettings(patch);
    }
    if ("notePromptPreset" in patch) {
      noteBar.refresh();
    }
    if ("noteExportTarget" in patch) {
      syncSaveNoteButtons(els.messages, patch.noteExportTarget);
    }
  }, {
    sync: [
      "notePromptPreset",
      "noteCustomPrompt",
      "noteExportTarget",
      "noteDownloadSubdir",
      "noteIncludeKeyframes",
      "playerAiActionMode",
      "playerAiAutoExportNote"
    ]
  });
  scope.track(() => {
    unwatchNoteSettings();
    unwatchConversations();
    unwatchPresentation();
    unwatchProviders();
  });

  scope.track(subscribeQuickPromptsChange(() => {
    if (!initialized || chatDomain.isStreaming()) {
      return;
    }
    suggestionsSlot.refresh();
  }));

  setChatTabOutsideClickHandler((event) => {
    popovers.handleDocumentClick(event);
    noteBar.handleOutsideClick(event);
  });
  scope.track(() => setChatTabOutsideClickHandler(null));

  let boundWin: Window | null = getActiveReaderWindow();
  const onWindowUnload = (): void => {
    lists.resetLiveHistoryDetail();
    detachConversationIdentity();
    if (els.messages) {
      els.messages.innerHTML = "";
    }
  };
  boundWin.addEventListener("keydown", onWindowEscapeKey);
  boundWin.addEventListener("pagehide", onWindowUnload);
  const stopHostWatch = onActiveHostChange((ctx) => {
    noteBar.closeMenu();
    safeRemoveListener(boundWin, "keydown", onWindowEscapeKey);
    safeRemoveListener(boundWin, "pagehide", onWindowUnload);
    boundWin = ctx.win;
    boundWin.addEventListener("keydown", onWindowEscapeKey);
    boundWin.addEventListener("pagehide", onWindowUnload);
  });
  scope.track(() => {
    stopHostWatch();
    safeRemoveListener(boundWin, "keydown", onWindowEscapeKey);
    safeRemoveListener(boundWin, "pagehide", onWindowUnload);
    boundWin = null;
  });
}

function deactivateSessionTriggers(): void {
  const current = sessionTriggerScope;
  sessionTriggerScope = null;
  current?.dispose();
}

function onWindowEscapeKey(event: KeyboardEvent): void {
  noteBar.handleEscapeKey(event);
  popovers.handleEscapeKey(event);
}

async function initChatTab({ consumeIntent }: { consumeIntent: boolean }): Promise<void> {
  const generation = ++sessionGeneration;
  sessionClosed = false;
  const isStale = () => sessionClosed || generation !== sessionGeneration;
  requireShell();
  bindEvents();
  activateSessionTriggers();
  await Promise.all([
    sendRuntimeMessage({ type: "ensure-offscreen-chat" }).catch(() => null),
    modelPanel.reload(),
    chatDomain.loadConversations(),
    chatDomain.loadContextState(),
    isLiveCompanionAllowed() ? liveBridge.refreshTarget() : Promise.resolve()
  ]);
  if (isStale()) {
    deactivateSessionTriggers();
    return;
  }
  await chatDomain.restoreLatestConversation();
  if (isStale()) {
    deactivateSessionTriggers();
    return;
  }
  chatDomain.renderInitialState();
  noteBar.refresh();
  initialized = true;
  if (consumeIntent) {
    await explainIntentController.consumeIfPending();
  }
}

async function restoreChatSession(): Promise<void> {
  const generation = ++sessionGeneration;
  const isStale = () => sessionClosed || generation !== sessionGeneration;
  if (isLiveCompanionAllowed()) {
    liveBridge.bindHooksIfSupported();
  }
  await modelPanel.reload().catch(() => null);
  if (isStale()) {
    return;
  }
  if (isLiveCompanionAllowed()) {
    void liveBridge.refreshTarget();
  }
  const ok = await chatDomain.loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
  if (!ok || isStale()) {
    return;
  }
  const restored = await chatDomain.restoreLatestConversation();
  if (isStale()) {
    return;
  }
  if (!restored && chatSessionState.liveContextData) {
    applyLiveContextToMain();
  }
  chatDomain.renderInitialState();
  noteBar.refresh();
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
    activateSessionTriggers();
    await restoreChatSession();
  }
  if (consumeIntent && !sessionClosed) {
    await explainIntentController.consumeIfPending();
  }
}

export function stopChatSpeech(): void {
  chatDomain.stopSpeech();
}

export function deactivateChatTabOverlays(): void {
  noteBar.closeMenu();
  popovers.hideToolsMenu({ restoreFocus: false });
  popovers.hideMoreMenu();
  popovers.hideModelPanel({ restoreFocus: false });
  popovers.hideHistoryPopover({ focus: "none" });
  chatDomain.closeImageViewer({ restoreFocus: false });
  inputImages.closeViewer(false);
}

export function closeChatSession(): void {
  sessionGeneration += 1;
  sessionClosed = true;
  initInFlight = null;
  quickActionGeneration += 1;
  pendingQuickActionRetry = null;
  setupFlow.invalidate();
  chatDomain.closeSession({ resetRuntime: initialized });
  liveBridge.closeSession();
  if (!initialized) {
    deactivateSessionTriggers();
    return;
  }
  deactivateChatTabOverlays();
  lists.cancelPendingSwitch();
  lists.settlePendingDeletion();
  lists.resetLiveHistoryDetail();
  clearAllNotices();
  explainIntentController.hide();
  deactivateSessionTriggers();
}

let quickActionInFlight: Promise<boolean> | null = null;
let quickActionGeneration = 0;
let pendingQuickActionRetry: {
  prompt: string;
  clipSignature: string;
  turnKind: ChatTurnKind;
  expectedClipSignature: string;
} | null = null;

export async function runQuickActionPrompt(
  prompt: string,
  opts?: { turnKind?: ChatTurnKind }
): Promise<boolean> {
  if (quickActionInFlight) {
    return false;
  }
  const generation = quickActionGeneration;
  const turnKind: ChatTurnKind = opts?.turnKind ?? "player-ai";
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
    if (chatDomain.isTurnActive()) {
      messagesNotice.show("当前对话正在生成或发送，请稍后再试。", 4000);
      els.input?.focus?.({ preventScroll: true });
      return false;
    }
    const expectedClipSignature = captureLiveClipSignature();
    const accepted = await composer.sendDetachedPrompt(text, {
      turnKind,
      expectedClipSignature
    });
    if (!accepted && !sessionClosed && generation === quickActionGeneration && chatDomain.isNoSubtitleBlocked()) {
      pendingQuickActionRetry = {
        prompt: text,
        clipSignature: computeCurrentClipSignature(),
        turnKind,
        expectedClipSignature
      };
    }
    return accepted;
  })();
  try {
    return await quickActionInFlight;
  } finally {
    quickActionInFlight = null;
  }
}

export async function runVideoNotePrompt(): Promise<boolean> {
  const site = state.clip.site;
  const prompt = buildVideoNotePrompt({
    preset: state.settings?.notePromptPreset,
    customPrompt: state.settings?.noteCustomPrompt,
    site,
    supportsHotComments: getSiteCapabilities(site).supportsHotComments,
    includeKeyframes: Boolean(state.settings?.noteIncludeKeyframes)
  });
  return runQuickActionPrompt(prompt, { turnKind: "video-note" });
}

function bindEvents(): void {
  if (eventsBound) {
    if (isLiveCompanionAllowed()) {
      liveBridge.bindHooksIfSupported();
    }
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
    noteBar.closeMenu();
    syncMoreMenuSlidersFromState();
    popovers.toggleMoreMenu(event);
  });
  els.newChatBtn?.addEventListener("click", () => {
    noteBar.closeMenu();
    popovers.hideMoreMenu();
    void chatDomain.startNewConversation();
  });
  els.historyBtn?.addEventListener("click", (event) => {
    noteBar.closeMenu();
    chatDomain.stopSpeech();
    popovers.toggleHistoryPopover(event);
  });
  els.displaySettingsBtn?.addEventListener("click", () => {
    liveBridge.openChatSettings("appearance");
  });
  els.historyClearBtn?.addEventListener("click", () => {
    void chatDomain.clearConversations();
  });
  els.historyBackBtn?.addEventListener("click", () => {
    popovers.hideHistoryPopover();
  });

  if (isLiveCompanionAllowed()) {
    liveBridge.initEvents();
  }
  els.toolsBtn?.addEventListener("click", (event) => {
    noteBar.closeMenu();
    popovers.toggleToolsMenu(event);
  });
  els.modelChip.addEventListener("click", (event) => {
    noteBar.closeMenu();
    popovers.toggleModelPanel(event);
  });
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
        messagesNotice.show("仅支持拖入图片文件", 4000);
        return;
      }
      inputImages.addFiles(imageFiles);
    });
  }
}

function isConversationViewActive(): boolean {
  return chatDomain.isTurnActive();
}

async function refreshProvidersAndPrefsAfterExternalChange(): Promise<void> {
  const previousProviderId = String(modelPanel.getSelectedValue() || "").trim();
  await modelPanel.reload({ preferredProviderId: previousProviderId || undefined });
  lists.renderHistoryList();
  noteBar.refresh();
  if (isConversationViewActive() || setupFlow.isViewHeld()) {
    return;
  }
  chatDomain.renderInitialState();
}

async function startSubtitleFetch(options?: { forceRefresh?: boolean; awaitRefresh?: boolean }): Promise<boolean> {
  const forceRefresh = options?.forceRefresh === true;
  return kickSubtitleFetch(
    () => requestSubtitleRefresh(forceRefresh ? { forceRefresh: true } : undefined),
    {
      onChainLoadFailed: (error) => logWarn("[BILISCRIPT] subtitle fetch start failed", { error }),
      awaitRefresh: options?.awaitRefresh === true,
      onRefreshFailed: (error) => logWarn("[BILISCRIPT] subtitle refresh failed", { error })
    }
  );
}
