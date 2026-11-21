import type { TimestampNavDeps } from "../ui/timestamp-nav.js";
import type { CaptureCurrentVideoFrame, ImagePart } from "../ai/types.js";
import type { ClipState } from "../core/state.js";
import type { Settings } from "../core/defaults.js";
import {
  createInProcessContextFetch,
  createInProcessPinnedContextResolver
} from "../core/context-assembly.js";
import { resolveAiConversationContext, resolveAiConversationPageRef } from "../ai/context-resolver.js";
import { createChatRuntime, type ChatPort, type ChatRuntimeUi } from "./chat-runtime.js";
import {
  createConversationStore,
  type ConversationChange,
  type ConversationContextNotice,
  type ConversationStore,
  type StorageArea
} from "./conversation-store.js";
import { createContextLoad, type ContextLoad } from "./context-load.js";
import { createSendGate, type SendGate } from "./send-gate.js";
import { createConversationReplay, type ConversationReplay } from "./replay.js";
import type { ViewResetIntent } from "./view-intent.js";

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
export type { ViewResetIntent } from "./view-intent.js";

export interface CreateChatTabDomainDeps {
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  ui: ChatRuntimeUi;
  onConversationChanged: (change: ConversationChange) => void;
  onStreamInterrupted: () => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  renderHistoryList: () => void;
  renderInitialState: () => void;
  restartChat: (opts?: { keepContext?: boolean; preserveInput?: boolean }) => void;
  requestViewReset: (intent: ViewResetIntent) => void;
  suggestions: {
    render: () => void;
    clear: () => void;
  };
  updateChatLayoutState: () => void;
  storage?: StorageArea;
  clip: () => Partial<ClipState>;
  settings: () => Partial<Settings>;
  isSessionClosed: () => boolean;
  isReaderTranscribing: () => boolean;
  asrNotice: HTMLElement | null;
  pageBvid: () => string | null;
  startSubtitleFetch: () => Promise<boolean>;
  subscribeStatusPhase: (listener: (phase: string) => void) => () => void;
  onWaitingChange?: (waiting: boolean) => void;
  getProviderId: () => string;
  getSelectedModel?: () => string;
  getInputImages?: () => ImagePart[];
  takeInputImages?: (snapshot?: ImagePart[]) => ImagePart[];
  canUseVideoFrameTool?: () => Promise<boolean>;
  captureCurrentVideoFrame?: CaptureCurrentVideoFrame;
  getPlaybackCursorSeconds?: () => number | undefined;
  getTimestampNavDeps: () => TimestampNavDeps;
  normalizeMarkdownForSectionPaste: (raw: string, baseLevel?: number) => string;
  connectPort: () => Promise<ChatPort> | ChatPort;
  getSpeechVolume?: () => number | undefined;
  isLiveActive?: () => boolean;
}

export function createChatTabDomain(deps: CreateChatTabDomainDeps): {
  runtime: ReturnType<typeof createChatRuntime>;
  store: ConversationStore;
  contextLoad: ContextLoad;
  sendGate: SendGate;
  replay: ConversationReplay;
} {
  const resolveConversationContext = createInProcessPinnedContextResolver({
    clip: deps.clip,
    settings: deps.settings,
    resolveNetwork: resolveAiConversationContext
  });
  const store = createConversationStore({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    resolveAiConversationRef: (contextRef, purpose) =>
      purpose === "page" ? resolveAiConversationPageRef(contextRef) : resolveConversationContext(contextRef),
    onConversationChanged: deps.onConversationChanged,
    onStreamInterrupted: deps.onStreamInterrupted,
    onContextNotice: deps.onContextNotice,
    storage: deps.storage
  });
  const contextLoad = createContextLoad({
    fetchContext: createInProcessContextFetch({
      clip: deps.clip,
      settings: deps.settings
    }),
    renderHistoryList: deps.renderHistoryList,
    renderInitialState: deps.renderInitialState,
    renderSuggestions: deps.suggestions.render,
    requestViewReset: deps.requestViewReset,
    restartChat: deps.restartChat,
    restoreLatest: () => store.restoreLatest(),
    isStreaming: () => runtime.isStreaming(),
    hasPendingUserPrompt: () => runtime.hasPendingUserPrompt(),
    isLiveActive: deps.isLiveActive
  });
  const sendGate = createSendGate({
    loadContextState: (opts) => contextLoad.loadContextState(opts),
    hydratePinned: (opts) => store.hydratePinned(opts),
    showContextNotice: deps.ui.showConversationContextNotice,
    removeContextNotice: deps.ui.removeConversationContextNotice,
    replayInFlight: () => replay?.inFlight ?? null,
    isSessionClosed: deps.isSessionClosed,
    isReaderTranscribing: deps.isReaderTranscribing,
    asrNotice: deps.asrNotice,
    pageBvid: deps.pageBvid,
    clip: () => deps.clip() as ClipState,
    startSubtitleFetch: deps.startSubtitleFetch,
    subscribeStatusPhase: deps.subscribeStatusPhase,
    onWaitingChange: deps.onWaitingChange
  });
  const runtime = createChatRuntime({
    messages: deps.messages,
    input: deps.input,
    store,
    ui: deps.ui,
    ensureCurrentContextForSend: () => sendGate.ensureContextForSend(),
    getProviderId: deps.getProviderId,
    getSelectedModel: deps.getSelectedModel,
    getInputImages: deps.getInputImages,
    takeInputImages: deps.takeInputImages,
    canUseVideoFrameTool: deps.canUseVideoFrameTool,
    captureCurrentVideoFrame: deps.captureCurrentVideoFrame,
    getPlaybackCursorSeconds: deps.getPlaybackCursorSeconds,
    getTimestampNavDeps: deps.getTimestampNavDeps,
    normalizeMarkdownForSectionPaste: deps.normalizeMarkdownForSectionPaste,
    connectPort: deps.connectPort,
    getSpeechVolume: deps.getSpeechVolume,
    smoothStream: true
  });
  const replay = createConversationReplay({
    renderer: runtime,
    updateLayout: deps.updateChatLayoutState,
    clearSuggestions: deps.suggestions.clear
  });
  return { runtime, store, contextLoad, sendGate, replay };
}
