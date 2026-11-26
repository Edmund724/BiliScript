import type { Settings } from "../core/defaults.js";
import type {
  AiProviderPreset,
  AsrProviderPreset,
  SearchProviderAccess,
  SearchProviderPreset,
  SearchProviderType
} from "../core/presets.js";
import type { AiProvider, CapturedVideoFrame, ImagePart, SubtitleBodyItem } from "../ai/types.js";
import type { AsrProvider } from "../asr/asr-provider-store.js";
import type { SearchProvider } from "../search/search-provider-normalize.js";
import type { NormalizedSearchResult } from "../search/adapters/types.js";
import type { SegmentCacheContextFields } from "../ai/segment-cache-key-fields.js";
import type { L1VideoIndexCacheRecord } from "../ai/long-video-hybrid-types.js";
import type {
  AiArtifactFamily,
  AiArtifactRecord,
  ChatImageRecord,
  PutChatImageInput,
  SubtitlePageRecord,
  SubtitleTrackStorageKind
} from "../subtitle/idb-store.js";
import type {
  AgentBridgeContentCommentsResult,
  AgentBridgeContentSubtitlesResult,
  AgentBridgeFramesResult,
  AgentBridgeTabSnapshot
} from "../agent-bridge/protocol.js";

export type ReaderEnterMessage = {
  type: "reader-enter";
  readerUrl?: string;
  chat?: { prompt?: string };
};

export type ReaderEnterResponse = { ok: boolean; error?: string };

export type ReaderCloseMessage = {
  type: "reader-close";
};

export type ReaderCloseResponse = { ok: boolean; error?: string };

export type ReaderToggleMessage = {
  type: "reader-toggle";
  readerUrl?: string;
};

export type ReaderToggleResponse = { ok: boolean; open?: boolean; error?: string };

export type ReaderRestoreMessage = {
  type: "reader-restore";
  readerUrl?: string;
};

export type ReaderRestoreResponse = { ok: boolean; error?: string };

export type LiveSessionTakeoverMessage = {
  type: "live-session-takeover";
};
export type LiveSessionTakeoverResponse = { ok: boolean };

export type AgentBridgeSnapshotMessage = { type: "agent-bridge-snapshot" };
export type AgentBridgeSnapshotResponse = {
  ok: boolean;
  snapshot?: Omit<AgentBridgeTabSnapshot, "tabId">;
  error?: string;
};
export type AgentBridgeSubtitlesMessage = { type: "agent-bridge-subtitles" };
export type AgentBridgeSubtitlesResponse = {
  ok: boolean;
  result?: AgentBridgeContentSubtitlesResult;
  error?: string;
};
export type AgentBridgeCommentsMessage = { type: "agent-bridge-comments" };
export type AgentBridgeCommentsResponse = {
  ok: boolean;
  result?: AgentBridgeContentCommentsResult;
  error?: string;
};
export type AgentBridgeFrameMessage = {
  type: "agent-bridge-frame";
  bvid: string;
  cid: string;
  targetTime?: number;
};
export type AgentBridgeFrameResponse = {
  ok: boolean;
  result?: AgentBridgeFramesResult;
  error?: string;
};

export type ContentScriptMessage =
  | ReaderEnterMessage
  | ReaderCloseMessage
  | ReaderToggleMessage
  | ReaderRestoreMessage
  | LiveSessionTakeoverMessage
  | AgentBridgeSnapshotMessage
  | AgentBridgeSubtitlesMessage
  | AgentBridgeCommentsMessage
  | AgentBridgeFrameMessage;

export type ContentScriptMessageType = ContentScriptMessage["type"];

export type GetSettingsMessage = { type: "get-settings" };
export type GetSettingsResponse = {
  ok: boolean;
  settings?: Settings;
  error?: string;
};
export type SaveSettingsMessage = { type: "save-settings"; settings?: unknown };
export type SaveSettingsResponse = { ok: boolean; error?: string };
export type AgentBridgeStatusMessage = { type: "agent-bridge-status" };
export type AgentBridgeStatusResponse = { ok: boolean; connected?: boolean; error?: string };
export type AgentBridgeConnectMessage = { type: "agent-bridge-connect" };
export type AgentBridgeConnectResponse = { ok: boolean; connected?: boolean; error?: string };
export type AgentBridgeTestMessage = { type: "agent-bridge-test"; url?: unknown };
export type AgentBridgeTestResponse = { ok: boolean; connected?: boolean; error?: string };
export type RequestProviderOriginsMessage = {
  type: "request-provider-origins";
  baseUrls?: unknown;
};
export type RequestProviderOriginsResponse = { ok: boolean; error?: string };
export type CheckProviderOriginMessage = {
  type: "check-provider-origin";
  origin?: unknown;
};
export type CheckProviderOriginStatus = "granted" | "denied" | "invalid-origin";
export type CheckProviderOriginResponse =
  | { granted: true; status: "granted" }
  | { granted: false; status: "denied" | "invalid-origin" };
export type RevokeProviderOriginMessage = {
  type: "revoke-provider-origin";
  origin?: unknown;
};
export type RevokeProviderOriginResponse = {
  origins: string[];
  revoked: boolean;
};
export type EnsureOffscreenChatMessage = { type: "ensure-offscreen-chat" };
export type EnsureOffscreenChatResponse = {
  ok: boolean;
  ensured?: boolean;
  error?: string;
};
export type PlayerAiQuickActionMessage = {
  type: "player-ai-quick-action";
  tabId?: number;
};
export type PlayerAiQuickActionResponse = { ok: boolean; error?: string };
export type FetchJsonMessage = { type: "fetch-json"; url?: string };
export type FetchJsonResponse = {
  ok: boolean;
  data?: unknown;
  error?: string;
};

export type ProviderListEntry = AiProvider & { hasSavedKey: boolean };
export type AsrProviderListEntry = AsrProvider & { hasSavedKey: boolean };
export type SearchProviderListEntry = SearchProvider & { hasSavedKey: boolean };

export type AiProvidersListMessage = { type: "ai-providers-list" };
export type AiProvidersListResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiPresetsListMessage = { type: "ai-presets-list" };
export type AiPresetsListResponse = {
  ok: boolean;
  presets?: AiProviderPreset[];
  error?: string;
};
export type GetAiProviderKeyMessage = {
  type: "get-ai-provider-key";
  providerId?: string;
};
export type GetAiProviderKeyResponse = {
  ok: boolean;
  apiKey?: string;
  error?: string;
};
export type AiProvidersSaveMessage = { type: "ai-providers-save"; providers?: unknown };
export type AiProvidersSaveResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type AiProvidersDeleteMessage = {
  type: "ai-providers-delete";
  providerId?: string;
};
export type AiProvidersDeleteResponse = {
  ok: boolean;
  providers?: ProviderListEntry[];
  error?: string;
};
export type ProviderHttpMessage = {
  type: "provider-http";
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};
export type ProviderHttpResponse = {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
};
export type ResolveAiProviderMessage = {
  type: "resolve-ai-provider";
  providerId?: string;
};
export type ResolveAiProviderResponse = {
  ok: boolean;
  provider?: ProviderListEntry;
  apiKey?: string;
  model?: string;
  isFallback?: boolean;
  error?: string;
};

export type ResolveSubtitleTranslateProviderMessage = {
  type: "resolve-subtitle-translate-provider";
};

export type ResolveSubtitleTranslateProviderResponse = {
  ok: boolean;
  provider?: ProviderListEntry;
  apiKey?: string;
  model?: string;
  isFallback?: boolean;
  error?: string;
};

export type SubtitleTranslateSiliconFlowKeyStatusMessage = {
  type: "subtitle-translate-siliconflow-key-status";
};

export type SubtitleTranslateSiliconFlowKeySaveMessage = {
  type: "subtitle-translate-siliconflow-key-save";
  apiKey: string;
};

export type SubtitleTranslateSiliconFlowKeyResponse = {
  ok: boolean;
  hasOwnKey?: boolean;
  hasAsrKey?: boolean;
  error?: string;
};

export type SubtitleTranslateSiliconFlowKeyStatusResponse = SubtitleTranslateSiliconFlowKeyResponse;
export type SubtitleTranslateSiliconFlowKeySaveResponse = SubtitleTranslateSiliconFlowKeyResponse;

export type SegmentCacheContext = SegmentCacheContextFields;
export type SegmentCacheMessage = {
  type: "segment-cache";
  op: "load-summary" | "load-summaries" | "save-summary" | "load-stored-summaries" | "load-l1-index";
  context?: SegmentCacheContext;
  segmentIndex?: number | string;
  segmentIndexes?: Array<number | string>;
  budgetScale?: unknown;
  summary?: string;
};
export type SegmentCacheResponse = {
  ok: boolean;
  summary?: string | null;
  summaries?: (string | null)[];
  l1Index?: L1VideoIndexCacheRecord | null;
  error?: string;
};

export type SubtitleTimeRange = { from: number; to: number };
export type SubtitleCacheTier = "rawTracks" | "segmentedTracks" | "translatedTracks";
export type SubtitleCacheOp =
  | "get-page"
  | "get-raw"
  | "put-raw"
  | "get-segmented"
  | "put-segmented"
  | "get-translated"
  | "upsert-translated"
  | "delete-entry"
  | "prune-asr"
  | "clear-translated"
  | "get-ai-artifact"
  | "get-ai-artifacts"
  | "put-ai-artifact"
  | "delete-ai-artifact"
  | "list-ai-artifacts"
  | "clear-video"
  | "get-chat-image"
  | "get-chat-images"
  | "put-chat-image"
  | "delete-chat-images"
  | "delete-chat-images-by-conversations"
  | "prune-chat-images"
  | "clear-chat-images";

export type SubtitleCacheMessage = {
  type: "subtitle-cache";
  op: SubtitleCacheOp;
  bvid?: string;
  cid?: string;
  trackKey?: string;
  sourceTrackKey?: string;
  keepTrackKey?: string;
  targetLang?: string;
  lang?: string;
  kind?: SubtitleTrackStorageKind;
  segmentationSig?: string;
  translationSig?: string;
  mode?: "boundary-v3" | "cc-json";
  tier?: SubtitleCacheTier;
  key?: string;
  keys?: string[];
  id?: string;
  ids?: string[];
  conversationIds?: string[];
  validConversationIds?: string[];
  keepImageIds?: string[];
  chatImage?: PutChatImageInput;
  family?: AiArtifactFamily;
  keyPrefix?: string;
  payload?: unknown;
  createdAt?: number;
  updatedAt?: number;
  lastUsedAt?: number;
  items?: readonly SubtitleBodyItem[];
  replaceRange?: SubtitleTimeRange;
};

export type SubtitleCacheResponse = {
  ok: boolean;
  handled?: boolean;
  page?: SubtitlePageRecord | null;
  items?: SubtitleBodyItem[] | null;
  artifact?: AiArtifactRecord | null;
  artifacts?: Array<AiArtifactRecord | null>;
  chatImage?: ChatImageRecord | null;
  chatImages?: Array<ChatImageRecord | null>;
  deleted?: boolean;
  removedKeys?: string[];
  removedIds?: string[];
  evictedIds?: string[];
  evictedKeys?: string[];
  removedPageIds?: string[];
  removedArtifactKeys?: string[];
  estimatedBytes?: number;
  error?: string;
};

export type AsrPresetsListMessage = { type: "asr-presets-list" };
export type AsrPresetsListResponse = {
  ok: boolean;
  presets?: AsrProviderPreset[];
  error?: string;
};
export type AsrProvidersListMessage = { type: "asr-providers-list" };
export type AsrProvidersListResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type AsrProvidersSaveMessage = { type: "asr-providers-save"; providers?: unknown };
export type AsrProvidersSaveResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type AsrProvidersDeleteMessage = {
  type: "asr-providers-delete";
  providerId?: string;
};
export type AsrProvidersDeleteResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  error?: string;
};
export type GetAsrRuntimeConfigMessage = { type: "get-asr-runtime-config" };
export type GetAsrRuntimeConfigResponse = {
  ok: boolean;
  providers?: AsrProviderListEntry[];
  activeAsrProviderId?: string;
  activeKey?: string;
  asrLanguage?: string;
  asrAutoFallback?: boolean;
  error?: string;
};

export type SearchProvidersListMessage = { type: "search-providers-list" };
export type SearchProvidersListResponse = {
  ok: boolean;
  providers?: SearchProviderListEntry[];
  error?: string;
};
export type SearchProvidersSaveMessage = { type: "search-providers-save"; providers?: unknown };
export type SearchProvidersSaveResponse = {
  ok: boolean;
  providers?: SearchProviderListEntry[];
  error?: string;
};
export type SearchProvidersDeleteMessage = {
  type: "search-providers-delete";
  providerId?: string;
};
export type SearchProvidersDeleteResponse = {
  ok: boolean;
  providers?: SearchProviderListEntry[];
  error?: string;
};

export type LiveProviderListEntry = {
  id: string;
  presetId: string;
  name: string;
  type: string;
  baseUrl: string;
  model: string;
  enabled: boolean;
  hasSavedKey: boolean;
};

export type LiveProvidersListMessage = { type: "live-providers-list" };
export type LiveProvidersListResponse = {
  ok: boolean;
  providers?: LiveProviderListEntry[];
  error?: string;
};
export type LiveProvidersSaveMessage = { type: "live-providers-save"; providers?: unknown };
export type LiveProvidersSaveResponse = {
  ok: boolean;
  providers?: LiveProviderListEntry[];
  error?: string;
};
export type LiveProvidersDeleteMessage = {
  type: "live-providers-delete";
  providerId?: string;
};
export type LiveProvidersDeleteResponse = {
  ok: boolean;
  providers?: LiveProviderListEntry[];
  error?: string;
};
export type LiveSessionPrepareMessage = {
  type: "live-session-prepare";
  sessionId?: string;
};
export type LiveSessionPrepareResponse = {
  ok: boolean;
  provider?: LiveProviderListEntry;
  liveGeminiNativeSearch?: boolean;
  liveLowBandwidth?: boolean;
  sessionId?: string;
  error?: string;
};
export type LiveSessionCleanupMessage = {
  type: "live-session-cleanup";
  sessionId: string;
};
export type LiveSessionCleanupResponse = {
  ok: boolean;
  error?: string;
};

export type ResolveSearchProviderMessage = { type: "resolve-search-provider" };

export type SearchChainCandidate = {
  provider: {
    id: string;
    presetId: string;
    name: string;
    type: SearchProviderType;
    baseUrl: string;
    access?: SearchProviderAccess;
  };
  apiKey: string;
};

export type ResolveSearchProviderResponse = {
  ok: boolean;
  chain?: SearchChainCandidate[];
  maxToolCalls?: number;
  chainEmptyReason?: "cooldown";
  error?: string;
};

export type SearchCacheMessage = {
  type: "search-cache";
  op: "get" | "put";
  query?: string;
  results?: NormalizedSearchResult[];
  platform?: string;
};
export type SearchCacheResponse = {
  ok: boolean;
  hit?: boolean;
  entry?: { results: NormalizedSearchResult[]; platform: string };
  error?: string;
};

export type SearchHealthMessage = {
  type: "search-health";
  op: "record";
  presetId?: string;
  ok?: boolean;
  latencyMs?: number;
};
export type SearchHealthResponse = { ok: boolean; error?: string };

export type OffloadTaskMessage = {
  type: "offload-task";
  taskType?: string;
  [key: string]: unknown;
};
export type OffloadTaskResponse = {
  ok: boolean;
  ruleId?: number;
  error?: string;
};

export type OffscreenCloseReason = "asr-idle" | "media-idle" | "light-idle" | "no-bilibili-tabs";

export type OffscreenRequestCloseMessage = {
  type: "offscreen-request-close";
  reason?: OffscreenCloseReason;
  onlyIfNoBilibiliTabs?: boolean;
};
export type OffscreenRequestCloseResponse = { ok: boolean; closed?: boolean; error?: string };

export type GetDebugLogGateMessage = { type: "get-debug-log-gate" };
export type GetDebugLogGateResponse = {
  ok: boolean;
  enabled?: boolean;
  error?: string;
};

export type OpenOnboardingMessage = { type: "open-onboarding" };
export type OpenOnboardingResponse = { ok: boolean; error?: string };

export type PermissionGrantResultMessage = {
  type: "permission-grant-result";
  reqId: string;
  ok: boolean;
  error?: string;
};
export type PermissionGrantResultResponse = { ok: boolean; error?: string };

export type YoutubeCaptionTrackSnapshot = {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind?: string;
  vssId?: string;
  isTranslatable?: boolean;
};

export type YoutubeChapterSnapshot = {
  title: string;
  from: number;
  to?: number;
};

export type YoutubePageSnapshot = {
  videoId: string;
  title: string;
  author: string;
  description: string;
  duration: number;
  publishDate: string;
  isLiveContent: boolean;
  isLiveNow: boolean;
  captionTracks: YoutubeCaptionTrackSnapshot[];
  chapters: YoutubeChapterSnapshot[];
  innertubeContext: Record<string, unknown> | null;
  innertubeApiKey: string;
  transcriptParams: string;
  modernTranscriptParams?: string;
  commentsContinuation?: string;
  commentsDisabled?: boolean;
  observedTimedtextUrls: string[];
};

export type YoutubePageSnapshotMessage = {
  type: "youtube-page-snapshot";
};
export type YoutubePageSnapshotResponse = {
  ok: boolean;
  snapshot?: YoutubePageSnapshot;
  error?: string;
};

export type YoutubeCaptureTimedtextPotMessage = {
  type: "youtube-capture-timedtext-pot";
  expectedVideoId?: string;
  languageCode?: string;
  kind?: string;
};
export type YoutubeCaptureTimedtextPotResponse = {
  ok: boolean;
  observedTimedtextUrls?: string[];
  skippedReason?: string;
  error?: string;
};

export type YoutubeEnsureSabrWorkerMessage = {
  type: "youtube-ensure-sabr-worker";
};
export type YoutubeEnsureSabrWorkerResponse = {
  ok: boolean;
  error?: string;
};

export type ContentStyleInsertMessage = {
  type: "content-style-insert";
  files: string[];
};
export type ContentStyleInsertResponse = {
  ok: boolean;
  styles?: Record<string, string>;
  error?: string;
};

export type ContentStyleRemoveMessage = {
  type: "content-style-remove";
  files: string[];
};
export type ContentStyleRemoveResponse = {
  ok: boolean;
  error?: string;
};

export type ContentStyleReadMessage = {
  type: "content-style-read";
  files: string[];
};
export type ContentStyleReadResponse = {
  ok: boolean;
  styles?: Record<string, string>;
  error?: string;
};

export type ContentChunkLoadMessage = {
  type: "content-chunk-load";
  chunkId: string;
};
export type ContentChunkLoadResponse = {
  ok: boolean;
  error?: string;
};

export type BackgroundMessage =
  | GetSettingsMessage
  | SaveSettingsMessage
  | AgentBridgeStatusMessage
  | AgentBridgeConnectMessage
  | AgentBridgeTestMessage
  | RequestProviderOriginsMessage
  | CheckProviderOriginMessage
  | RevokeProviderOriginMessage
  | EnsureOffscreenChatMessage
  | PlayerAiQuickActionMessage
  | FetchJsonMessage
  | AiProvidersListMessage
  | AiPresetsListMessage
  | GetAiProviderKeyMessage
  | AiProvidersSaveMessage
  | AiProvidersDeleteMessage
  | ProviderHttpMessage
  | ResolveAiProviderMessage
  | ResolveSubtitleTranslateProviderMessage
  | SubtitleTranslateSiliconFlowKeyStatusMessage
  | SubtitleTranslateSiliconFlowKeySaveMessage
  | AsrPresetsListMessage
  | AsrProvidersListMessage
  | AsrProvidersSaveMessage
  | AsrProvidersDeleteMessage
  | GetAsrRuntimeConfigMessage
  | SearchProvidersListMessage
  | SearchProvidersSaveMessage
  | SearchProvidersDeleteMessage
  | LiveProvidersListMessage
  | LiveProvidersSaveMessage
  | LiveProvidersDeleteMessage
  | LiveSessionPrepareMessage
  | LiveSessionCleanupMessage
  | ResolveSearchProviderMessage
  | SearchCacheMessage
  | SearchHealthMessage
  | SegmentCacheMessage
  | SubtitleCacheMessage
  | OffloadTaskMessage
  | OffscreenRequestCloseMessage
  | GetDebugLogGateMessage
  | OpenOnboardingMessage
  | PermissionGrantResultMessage
  | YoutubePageSnapshotMessage
  | YoutubeCaptureTimedtextPotMessage
  | YoutubeEnsureSabrWorkerMessage
  | ContentStyleInsertMessage
  | ContentStyleRemoveMessage
  | ContentStyleReadMessage
  | ContentChunkLoadMessage;

export type BackgroundMessageType = BackgroundMessage["type"];

export type DebugLogGateChangedBroadcast = {
  type: "debug-log-gate-changed";
  enabled: boolean;
};

export type OffscreenChatMessage = {
  action: "chat";
  providerId?: string;
  model?: string;
  conversationId?: string;
  webSearchEnabled?: boolean;
  videoFrameToolEnabled?: boolean;
  interactionAnchor?: {
    kind: "explain-selection";
    from: number;
    lineContent?: string;
    selection?: string;
  };
  playbackCursorSeconds?: number;
  images?: ImagePart[];
  subtitleBody?: unknown;
  [key: string]: unknown;
};

export type OffscreenStopMessage = { action: "stop" };

export type OffscreenCostGuardConfirmMessage = {
  action: "cost-guard-confirm";
  ok?: boolean;
};

export type OffscreenVideoFrameResultMessage = {
  action: "video-frame-result";
  requestId: string;
  image?: ImagePart;
  currentTime?: number;
  frames?: CapturedVideoFrame[];
  error?: string;
};

export type OffscreenChatPortMessage =
  | OffscreenChatMessage
  | OffscreenStopMessage
  | OffscreenCostGuardConfirmMessage
  | OffscreenVideoFrameResultMessage;

export type OffscreenAsrPortMessage =
  | {
      action: "asr-decode";
      task: {
        sourceMode?: "url" | "stream";
        trigger?: "auto" | "manual";
        audioUrl?: string;
        backupUrls?: string[];
        [key: string]: unknown;
      };
    }
  | {
      action: "asr-stream-init";
      dataBase64: string;
    }
  | {
      action: "asr-stream-chunk";
      seq: number;
      dataBase64: string;
    }
  | {
      action: "asr-stream-end";
    }
  | {
      action: "asr-stream-error";
      error: string;
      kind?: string;
    }
  | {
      action: "asr-probe";
      task: {
        type?: string;
        baseUrl?: string;
        model?: string;
        apiKey?: string;
        language?: string;
      };
    };

export type OffscreenProviderHttpPortMessage = {
  action: "provider-http";
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
};

export type OffscreenProviderHttpPortReply = {
  ok: boolean;
  status?: number;
  chunk?: string;
  done?: boolean;
  error?: string;
  accepted?: boolean;
};

export type OffscreenPortMessage =
  | OffscreenChatPortMessage
  | OffscreenAsrPortMessage
  | OffscreenProviderHttpPortMessage;

export type MessageResponse = unknown;

export type SendResponse = (response?: MessageResponse) => void;

export type MessageSender = {
  tab?: { id?: number; url?: string };
  frameId?: number;
  url?: string;
  id?: string;
};

export type BackgroundHandlerResult<K extends BackgroundMessageType> =
  BackgroundMessageRegistry[K]["reply"] extends "branch" ? MessageReplyDecision : void;

export type HandlerForType<K extends BackgroundMessageType> = (
  message: Extract<BackgroundMessage, { type: K }>,
  sender: MessageSender,
  sendResponse: (response: BackgroundResponseOf<K>) => void
) => BackgroundHandlerResult<K>;

export type BackgroundMessageHandler<K extends BackgroundMessageType> = HandlerForType<K>;

export type BackgroundMessageHandlers = {
  [K in BackgroundMessageType]: HandlerForType<K>;
};

export type MessageReplyMode = "async" | "sync" | "branch";

export type MessageReplyDecision = "answered" | "hold";

export function resolveReplyKeepOpen(mode: MessageReplyMode, handlerResult: MessageReplyDecision | void): boolean {
  if (mode === "async") return true;
  if (mode === "sync") return false;
  return handlerResult === "hold";
}

export type SenderLabel = string;

export type BackgroundMessageRegistration<
  M extends BackgroundMessage,
  R,
  Mode extends MessageReplyMode = MessageReplyMode
> = {
  readonly reply: Mode;
  readonly shape?: (message: unknown) => boolean;
  readonly sender?: SenderLabel;
  readonly __message?: M;
  readonly __response?: R;
};

type BackgroundMessageRegistrationArgument<M extends BackgroundMessage, Mode extends MessageReplyMode> = {
  reply: Mode;
  shape?: (message: Partial<Record<keyof M, unknown>>) => boolean;
  sender?: SenderLabel;
};

function isMessageRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, "async">
): BackgroundMessageRegistration<M, R, "async">;
function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, "sync">
): BackgroundMessageRegistration<M, R, "sync">;
function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, "branch">
): BackgroundMessageRegistration<M, R, "branch">;
function registerBackgroundMessage<M extends BackgroundMessage, R>(
  registration: BackgroundMessageRegistrationArgument<M, MessageReplyMode>
): BackgroundMessageRegistration<M, R> {
  const { shape, ...rest } = registration;
  if (!shape) {
    return rest;
  }
  return {
    ...rest,
    shape: (message) => isMessageRecord(message) && shape(message)
  };
}

function isProvidersArrayOrAbsent(message: {
  providers?: unknown;
}): boolean {
  return message.providers === undefined || Array.isArray(message.providers);
}

function isNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");
}

export const BACKGROUND_MESSAGE_REGISTRY = {
  "get-settings": registerBackgroundMessage<GetSettingsMessage, GetSettingsResponse>({
    reply: "async"
  }),
  "save-settings": registerBackgroundMessage<SaveSettingsMessage, SaveSettingsResponse>({
    reply: "async",
    shape: (message) =>
      message.settings == null
      || (typeof message.settings === "object" && !Array.isArray(message.settings))
  }),
  "agent-bridge-status": registerBackgroundMessage<AgentBridgeStatusMessage, AgentBridgeStatusResponse>({
    reply: "async"
  }),
  "agent-bridge-connect": registerBackgroundMessage<AgentBridgeConnectMessage, AgentBridgeConnectResponse>({
    reply: "async"
  }),
  "agent-bridge-test": registerBackgroundMessage<AgentBridgeTestMessage, AgentBridgeTestResponse>({
    reply: "async"
  }),
  "request-provider-origins": registerBackgroundMessage<
    RequestProviderOriginsMessage,
    RequestProviderOriginsResponse
  >({
    reply: "branch"
  }),
  "check-provider-origin": registerBackgroundMessage<
    CheckProviderOriginMessage,
    CheckProviderOriginResponse
  >({
    reply: "async"
  }),
  "revoke-provider-origin": registerBackgroundMessage<
    RevokeProviderOriginMessage,
    RevokeProviderOriginResponse
  >({
    reply: "async"
  }),
  "ensure-offscreen-chat": registerBackgroundMessage<
    EnsureOffscreenChatMessage,
    EnsureOffscreenChatResponse
  >({
    reply: "async"
  }),
  "player-ai-quick-action": registerBackgroundMessage<
    PlayerAiQuickActionMessage,
    PlayerAiQuickActionResponse
  >({
    reply: "branch",
    shape: (message) => message.tabId === undefined || Number.isFinite(message.tabId)
  }),
  "fetch-json": registerBackgroundMessage<FetchJsonMessage, FetchJsonResponse>({
    reply: "branch"
  }),
  "ai-providers-list": registerBackgroundMessage<AiProvidersListMessage, AiProvidersListResponse>({
    reply: "async"
  }),
  "ai-presets-list": registerBackgroundMessage<AiPresetsListMessage, AiPresetsListResponse>({
    reply: "sync"
  }),
  "get-ai-provider-key": registerBackgroundMessage<GetAiProviderKeyMessage, GetAiProviderKeyResponse>({
    reply: "branch"
  }),
  "ai-providers-save": registerBackgroundMessage<AiProvidersSaveMessage, AiProvidersSaveResponse>({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "ai-providers-delete": registerBackgroundMessage<
    AiProvidersDeleteMessage,
    AiProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "provider-http": registerBackgroundMessage<ProviderHttpMessage, ProviderHttpResponse>({
    reply: "async"
  }),
  "resolve-ai-provider": registerBackgroundMessage<
    ResolveAiProviderMessage,
    ResolveAiProviderResponse
  >({
    reply: "async"
  }),
  "resolve-subtitle-translate-provider": registerBackgroundMessage<
    ResolveSubtitleTranslateProviderMessage,
    ResolveSubtitleTranslateProviderResponse
  >({
    reply: "async"
  }),
  "subtitle-translate-siliconflow-key-status": registerBackgroundMessage<
    SubtitleTranslateSiliconFlowKeyStatusMessage,
    SubtitleTranslateSiliconFlowKeyStatusResponse
  >({
    reply: "async"
  }),
  "subtitle-translate-siliconflow-key-save": registerBackgroundMessage<
    SubtitleTranslateSiliconFlowKeySaveMessage,
    SubtitleTranslateSiliconFlowKeySaveResponse
  >({
    reply: "async"
  }),
  "asr-presets-list": registerBackgroundMessage<AsrPresetsListMessage, AsrPresetsListResponse>({
    reply: "sync"
  }),
  "asr-providers-list": registerBackgroundMessage<
    AsrProvidersListMessage,
    AsrProvidersListResponse
  >({
    reply: "async"
  }),
  "asr-providers-save": registerBackgroundMessage<AsrProvidersSaveMessage, AsrProvidersSaveResponse>({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "asr-providers-delete": registerBackgroundMessage<
    AsrProvidersDeleteMessage,
    AsrProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "get-asr-runtime-config": registerBackgroundMessage<
    GetAsrRuntimeConfigMessage,
    GetAsrRuntimeConfigResponse
  >({
    reply: "async"
  }),
  "search-providers-list": registerBackgroundMessage<
    SearchProvidersListMessage,
    SearchProvidersListResponse
  >({
    reply: "async"
  }),
  "search-providers-save": registerBackgroundMessage<
    SearchProvidersSaveMessage,
    SearchProvidersSaveResponse
  >({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "search-providers-delete": registerBackgroundMessage<
    SearchProvidersDeleteMessage,
    SearchProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "live-providers-list": registerBackgroundMessage<
    LiveProvidersListMessage,
    LiveProvidersListResponse
  >({
    reply: "async"
  }),
  "live-providers-save": registerBackgroundMessage<
    LiveProvidersSaveMessage,
    LiveProvidersSaveResponse
  >({
    reply: "async",
    shape: isProvidersArrayOrAbsent
  }),
  "live-providers-delete": registerBackgroundMessage<
    LiveProvidersDeleteMessage,
    LiveProvidersDeleteResponse
  >({
    reply: "async"
  }),
  "live-session-prepare": registerBackgroundMessage<
    LiveSessionPrepareMessage,
    LiveSessionPrepareResponse
  >({
    reply: "async"
  }),
  "live-session-cleanup": registerBackgroundMessage<
    LiveSessionCleanupMessage,
    LiveSessionCleanupResponse
  >({
    reply: "async"
  }),

  "resolve-search-provider": registerBackgroundMessage<
    ResolveSearchProviderMessage,
    ResolveSearchProviderResponse
  >({
    reply: "async"
  }),
  "search-cache": registerBackgroundMessage<SearchCacheMessage, SearchCacheResponse>({
    reply: "async"
  }),
  "search-health": registerBackgroundMessage<SearchHealthMessage, SearchHealthResponse>({
    reply: "async"
  }),
  "segment-cache": registerBackgroundMessage<SegmentCacheMessage, SegmentCacheResponse>({
    reply: "async",
    sender: "offscreen"
  }),
  "subtitle-cache": registerBackgroundMessage<SubtitleCacheMessage, SubtitleCacheResponse>({
    reply: "async"
  }),
  "offload-task": registerBackgroundMessage<OffloadTaskMessage, OffloadTaskResponse>({
    reply: "branch"
  }),
  "offscreen-request-close": registerBackgroundMessage<
    OffscreenRequestCloseMessage,
    OffscreenRequestCloseResponse
  >({
    reply: "async",
    sender: "offscreen"
  }),
  "get-debug-log-gate": registerBackgroundMessage<
    GetDebugLogGateMessage,
    GetDebugLogGateResponse
  >({
    reply: "async"
  }),
  "open-onboarding": registerBackgroundMessage<
    OpenOnboardingMessage,
    OpenOnboardingResponse
  >({
    reply: "async"
  }),
  "permission-grant-result": registerBackgroundMessage<
    PermissionGrantResultMessage,
    PermissionGrantResultResponse
  >({
    reply: "sync"
  }),
  "youtube-page-snapshot": registerBackgroundMessage<
    YoutubePageSnapshotMessage,
    YoutubePageSnapshotResponse
  >({
    reply: "branch"
  }),
  "youtube-capture-timedtext-pot": registerBackgroundMessage<
    YoutubeCaptureTimedtextPotMessage,
    YoutubeCaptureTimedtextPotResponse
  >({
    reply: "branch"
  }),
  "youtube-ensure-sabr-worker": registerBackgroundMessage<
    YoutubeEnsureSabrWorkerMessage,
    YoutubeEnsureSabrWorkerResponse
  >({
    reply: "branch"
  }),
  "content-style-insert": registerBackgroundMessage<
    ContentStyleInsertMessage,
    ContentStyleInsertResponse
  >({
    reply: "branch",
    shape: (message) => isNonEmptyStringArray(message.files)
  }),
  "content-style-remove": registerBackgroundMessage<
    ContentStyleRemoveMessage,
    ContentStyleRemoveResponse
  >({
    reply: "branch",
    shape: (message) => isNonEmptyStringArray(message.files)
  }),
  "content-style-read": registerBackgroundMessage<
    ContentStyleReadMessage,
    ContentStyleReadResponse
  >({
    reply: "branch",
    shape: (message) => isNonEmptyStringArray(message.files)
  }),
  "content-chunk-load": registerBackgroundMessage<
    ContentChunkLoadMessage,
    ContentChunkLoadResponse
  >({
    reply: "branch",
    shape: (message) => typeof message.chunkId === "string" && message.chunkId.trim().length > 0
  })
} satisfies {
  readonly [K in BackgroundMessageType]: BackgroundMessageRegistration<
    Extract<BackgroundMessage, { type: K }>,
    unknown
  >;
};

export type BackgroundMessageRegistry = typeof BACKGROUND_MESSAGE_REGISTRY;

export const OFFSCREEN_ONLY_MESSAGE_TYPES: ReadonlyArray<BackgroundMessageType> = (
  Object.keys(BACKGROUND_MESSAGE_REGISTRY) as BackgroundMessageType[]
).filter((type) => BACKGROUND_MESSAGE_REGISTRY[type].sender !== undefined);

export type BackgroundResponseOf<K extends BackgroundMessageType> =
  NonNullable<BackgroundMessageRegistry[K]["__response"]>;

export type ResponseOf<M> = M extends ReaderEnterMessage ? ReaderEnterResponse
  : M extends ReaderCloseMessage ? ReaderCloseResponse
  : M extends ReaderToggleMessage ? ReaderToggleResponse
  : M extends ReaderRestoreMessage ? ReaderRestoreResponse
  : M extends LiveSessionTakeoverMessage ? LiveSessionTakeoverResponse
  : M extends AgentBridgeSnapshotMessage ? AgentBridgeSnapshotResponse
  : M extends AgentBridgeSubtitlesMessage ? AgentBridgeSubtitlesResponse
  : M extends AgentBridgeCommentsMessage ? AgentBridgeCommentsResponse
  : M extends AgentBridgeFrameMessage ? AgentBridgeFrameResponse
  : M extends BackgroundMessage ? BackgroundResponseOf<M["type"]>
  : never;

