import type { AiContext, ImagePart } from "../ai/types.js";
import { buildContextKey } from "../ai/conversation.js";
import type { ThinkingLevelValue } from "../ai/thinking-levels.js";

export type ChatSessionContextSnapshot = AiContext;

export interface ChatSessionProvider {
  id: string;
  name?: string;
  model?: string;
  models?: string[];
  baseUrl?: string;
  presetId?: string;
  enabled?: boolean;
}

export interface CurrentConversationMeta {
  id?: string;
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  contextKey?: string;
  contextTitle?: string;
  contextUrl?: string;
  isVideoContext?: boolean;
  pinnedContext?: boolean;
  contextRef?: AiContext | null;
  resolvedContext?: AiContext | null;
}

export interface ChatSessionMessage {
  role: string;
  content: string;
  images?: ImagePart[];
  contextKey?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  thinking?: string;
  stopped?: boolean;
}

export interface ChatSessionSavedConversation {
  id: string;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  createdAt: number;
  updatedAt: number;
  contextRef: unknown;
  messages: unknown[];
  [key: string]: unknown;
}

type ChatSessionGuardedState = {
  chatHistory: ChatSessionMessage[];
  savedConversations: ChatSessionSavedConversation[];
  currentConversationId: string;
  currentConversationMeta: CurrentConversationMeta | null;
};

export type ChatThinkingLevel = ThinkingLevelValue;

export interface ChatSessionPreferences {
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  defaultModel?: string;
  defaultAiModel?: string;
}

type ChatSessionOpenState = {
  contextData: ChatSessionContextSnapshot | null;
  currentContextKey: string;
  providers: ChatSessionProvider[];
  liveContextData: ChatSessionContextSnapshot | null;
  liveContextKey: string;
  liveTabUrl: string;
  aiPrefs: ChatSessionPreferences;
  asrTranscribingActive: boolean;
  aiThinkingLevel: ChatThinkingLevel;
  webSearchEnabled: boolean;
};

export type ChatSessionState = Readonly<ChatSessionGuardedState> &
  Readonly<Omit<ChatSessionOpenState, "aiPrefs" | "contextData" | "liveContextData">> & {
    readonly aiPrefs: Readonly<ChatSessionPreferences>;
    readonly contextData: Readonly<ChatSessionContextSnapshot> | null;
    readonly liveContextData: Readonly<ChatSessionContextSnapshot> | null;
  };
type ChatSessionStateWritable = ChatSessionGuardedState & ChatSessionOpenState;

function createInitialChatSessionState(): ChatSessionStateWritable {
  return {
    contextData: null,
    currentContextKey: "",
    providers: [],
    chatHistory: [],
    savedConversations: [],
    currentConversationId: "",
    currentConversationMeta: null,
    liveContextData: null,
    liveContextKey: "",
    liveTabUrl: "",
    aiPrefs: {
      aiSystemPrompt: "",
      aiInitialQuickPrompts: []
    },
    asrTranscribingActive: false,
    aiThinkingLevel: "default",
    webSearchEnabled: false
  };
}

const chatSessionStateMutable: ChatSessionStateWritable = createInitialChatSessionState();

export const chatSessionState: ChatSessionState = chatSessionStateMutable;

export const chatSessionStateForTests = chatSessionStateMutable;

export interface ConversationIdentityInput {
  id?: string;
  meta?: CurrentConversationMeta | null;
  history?: ChatSessionMessage[];
}

export function applyConversationIdentity({ id, meta, history }: ConversationIdentityInput): void {
  if (id !== undefined) {
    chatSessionStateMutable.currentConversationId = id;
  }
  if (meta !== undefined) {
    chatSessionStateMutable.currentConversationMeta = meta;
  }
  if (history !== undefined) {
    chatSessionStateMutable.chatHistory = history;
  }
}

export function detachConversationIdentity(): void {
  applyConversationIdentity({ id: "", meta: null, history: [] });
}

export function clearConversationIdentity(): void {
  applyConversationIdentity({ id: "", meta: null });
}

export function ensureConversationId(id: string): void {
  if (chatSessionStateMutable.currentConversationId) {
    return;
  }
  chatSessionStateMutable.currentConversationId = id;
}

export function appendChatHistory(...messages: ChatSessionMessage[]): void {
  chatSessionStateMutable.chatHistory.push(...messages);
}

export function setSavedConversations(next: ChatSessionSavedConversation[]): void {
  chatSessionStateMutable.savedConversations = next;
}

export function setAsrTranscribingActive(active: boolean): void {
  chatSessionStateMutable.asrTranscribingActive = active;
}

export function rebuildCurrentContextKeyFromContext(): void {
  chatSessionStateMutable.currentContextKey = buildContextKey(chatSessionStateMutable.contextData);
}

export function applyLiveContextToMain(): void {
  if (chatSessionStateMutable.liveContextData) {
    applyContextToMain(
      { ...chatSessionStateMutable.liveContextData },
      chatSessionStateMutable.liveContextKey
    );
  }
}

export function applyContextToMain(next: AiContext | null, preferredKey?: string): void {
  chatSessionStateMutable.contextData = next;
  chatSessionStateMutable.currentContextKey = preferredKey || buildContextKey(next);
}

export function applyContextSnapshot(payload: unknown): boolean {
  const next = payload && typeof payload === "object" ? (payload as AiContext) : null;
  const nextKey = buildContextKey(next);
  const contextChanged = Boolean(
    chatSessionStateMutable.currentContextKey && nextKey && nextKey !== chatSessionStateMutable.currentContextKey
  );
  chatSessionStateMutable.contextData = next;
  chatSessionStateMutable.currentContextKey = nextKey;
  return contextChanged;
}

export function pinCurrentContextKey(key: string): void {
  chatSessionStateMutable.currentContextKey = key;
}

export function clearMainContext(): void {
  chatSessionStateMutable.contextData = null;
  chatSessionStateMutable.currentContextKey = "";
}

export interface ChatSessionPrefsSnapshot {
  providers: ChatSessionProvider[];
  aiPrefs: ChatSessionPreferences;
  aiThinkingLevel: ChatThinkingLevel;
  webSearchEnabled: boolean;
}

export function applyProviderPrefs(snapshot: ChatSessionPrefsSnapshot): void {
  chatSessionStateMutable.providers = snapshot.providers;
  chatSessionStateMutable.aiPrefs = snapshot.aiPrefs;
  chatSessionStateMutable.aiThinkingLevel = snapshot.aiThinkingLevel;
  chatSessionStateMutable.webSearchEnabled = snapshot.webSearchEnabled;
}

export function setAiThinkingLevel(level: ChatThinkingLevel): void {
  chatSessionStateMutable.aiThinkingLevel = level;
}

export function setWebSearchEnabled(enabled: boolean): void {
  chatSessionStateMutable.webSearchEnabled = enabled;
}

export function noteLiveTabUrl(url: string): void {
  chatSessionStateMutable.liveTabUrl = url;
}

export function applyLiveContextSnapshot(payload: ChatSessionContextSnapshot | null): void {
  chatSessionStateMutable.liveContextData = payload;
  chatSessionStateMutable.liveContextKey = buildContextKey(payload);
}

export function resetLiveContext(): void {
  applyLiveContextSnapshot(null);
  chatSessionStateMutable.liveTabUrl = "";
}

export function resetChatSessionStateForTests(): void {
  Object.assign(chatSessionStateMutable, createInitialChatSessionState());
}
