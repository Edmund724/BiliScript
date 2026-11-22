import {
  buildAiContextRef,
  buildContextPlaceholder,
  buildConversationTitle,
  generateConversationId,
  normalizeConversations,
  normalizeImageParts,
  retainLatestImage,
  resolveConversationStorageKey,
  normalizeConversationTitle,
  doesConversationMatchCurrentContext,
  MAX_SAVED_CONVERSATIONS
} from "../ai/conversation.js";
import { extractPageIndexFromUrl } from "../bilibili/video-id-shared.js";
import { isLiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import {
  HISTORY_STORAGE_KEY,
  readConversationHistory,
  updateConversationHistory
} from "./conversation-storage.js";
import type { AiContext } from "../ai/types.js";
import { confirmDialog } from "../ui/confirm-dialog.js";
import {
  applyContextToMain,
  applyConversationIdentity,
  applyLiveContextToMain,
  chatSessionState,
  detachConversationIdentity,
  pinCurrentContextKey,
  setSavedConversations,
  type CurrentConversationMeta
} from "./chat-state.js";
import type {
  ChatSessionMessage,
  ChatSessionSavedConversation,
  OrdinaryConversation
} from "./conversation-types.js";

export type Conversation = ChatSessionSavedConversation;

function normalizeHistoryMessage(item: ChatSessionMessage): ChatSessionMessage {
  const base: ChatSessionMessage = { role: item.role, content: String(item.content || "") };
  const images = normalizeImageParts(item.images);
  if (images) {
    base.images = images;
  }
  if (typeof item.contextKey === "string" && item.contextKey.trim()) {
    base.contextKey = item.contextKey;
  }
  if (typeof item.thinking === "string" && item.thinking.trim()) {
    base.thinking = item.thinking;
  }
  if (item.stopped === true) {
    base.stopped = true;
  }
  if (Array.isArray(item.tool_calls) && item.tool_calls.length) {
    return { ...base, tool_calls: item.tool_calls };
  }
  if (typeof item.tool_call_id === "string" && item.tool_call_id) {
    return { ...base, tool_call_id: item.tool_call_id };
  }
  return base;
}

export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: boolean;
  pinnedContext: boolean;
  contextRef: AiContext | null;
  resolvedContext?: AiContext | null;
}

export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface LoadContextStateOptions {
  forceRefresh?: boolean;
  silent?: boolean;
  preserveInput?: boolean;
}

export interface HydratePinnedOptions {
  silent?: boolean;
  preserveInput?: boolean;
}

export interface ConversationChange {
  historyCleared?: boolean;
  resetView?: boolean;
}

export type ConversationContextNotice =
  | { kind: "pending"; message: string }
  | { kind: "clear" }
  | { kind: "error"; message: string };

export interface CreateConversationStoreDeps {
  loadContextState: (opts: LoadContextStateOptions) => Promise<boolean | object>;
  resolveAiConversationRef: (
    contextRef: AiContext,
    purpose: "context" | "page"
  ) => Promise<Record<string, unknown>>;
  onConversationChanged: (change: ConversationChange) => void;
  onStreamInterrupted: () => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  storage?: StorageArea;
  syncStorage?: StorageArea;
  isCleanEnabled?: () => Promise<boolean> | boolean;
  confirmClearAll?: (message: string) => boolean | Promise<boolean>;
}

export interface ConversationDeletion {
  id: string;
  undo: () => Promise<void>;
}

export interface ConversationStore {
  loadAll: () => Promise<void>;
  isCurrent: (id: string) => boolean;
  persistCurrent: () => Promise<void>;
  applyById: (id: string) => void;
  deleteById: (id: string) => Promise<ConversationDeletion | null>;
  clearAll: () => Promise<void>;
  restoreLatest: () => Promise<boolean>;
  detachForRestart: () => void;
  hydratePinned: (opts?: HydratePinnedOptions) => Promise<boolean>;
}

export function needsConversationPageHydration(conversation: Conversation | null | undefined): boolean {
  if (!conversation?.isVideoContext) {
    return false;
  }
  if (/-P\d+$/i.test(String(conversation.title || "").trim())) {
    return false;
  }
  const pageIndex = Number(conversation.contextRef?.pageIndex || 0) || 0;
  if (pageIndex > 1) {
    return true;
  }
  const urlPageIndex = extractPageIndexFromUrl(conversation.contextUrl || conversation.contextRef?.url || "");
  if (urlPageIndex > 1) {
    return true;
  }
  return Boolean(conversation.contextRef?.bvid && conversation.contextRef?.cid);
}

export const CONVERSATIONS_STORAGE_KEY = HISTORY_STORAGE_KEY;
export const CONVERSATION_RETENTION_MS = 30 * 86400 * 1000;

export function getConversationTimestamp(conversation: {
  updatedAt?: unknown;
  createdAt?: unknown;
}): number {
  const updatedAt =
    typeof conversation?.updatedAt === "number" && !Number.isNaN(conversation.updatedAt)
      ? conversation.updatedAt
      : Number(conversation?.updatedAt);
  if (!Number.isNaN(updatedAt) && updatedAt > 0) {
    return updatedAt;
  }
  const createdAt =
    typeof conversation?.createdAt === "number" && !Number.isNaN(conversation.createdAt)
      ? conversation.createdAt
      : Number(conversation?.createdAt);
  if (!Number.isNaN(createdAt) && createdAt > 0) {
    return createdAt;
  }
  return 0;
}

export function isConversationOlderThanRetention(
  conversation: { updatedAt?: unknown; createdAt?: unknown },
  now: number = Date.now(),
  retentionMs: number = CONVERSATION_RETENTION_MS
): boolean {
  const ts = getConversationTimestamp(conversation);
  return ts < now - retentionMs;
}

export function filterExpiredConversations<T extends { updatedAt?: unknown; createdAt?: unknown }>(
  conversations: T[],
  now: number = Date.now(),
  retentionMs: number = CONVERSATION_RETENTION_MS
): { kept: T[]; pruned: T[]; prunedCount: number } {
  const cutoff = now - retentionMs;
  const kept: T[] = [];
  const pruned: T[] = [];
  for (const item of conversations) {
    const ts = getConversationTimestamp(item);
    if (ts < cutoff) {
      pruned.push(item);
    } else {
      kept.push(item);
    }
  }
  return { kept, pruned, prunedCount: pruned.length };
}

export interface CleanExpiredConversationsResult {
  prunedCount: number;
  kept: Conversation[];
}

export async function cleanExpiredConversations(
  storage?: StorageArea,
  now: number = Date.now(),
  retentionMs: number = CONVERSATION_RETENTION_MS
): Promise<CleanExpiredConversationsResult> {
  const targetStorage = storage || (typeof chrome !== "undefined" && (chrome?.storage?.local as StorageArea)) || undefined;
  if (!targetStorage) {
    return { prunedCount: 0, kept: [] };
  }
  const list = await readConversationHistory(targetStorage);
  const initial = filterExpiredConversations(list, now, retentionMs);
  let kept = initial.kept;
  let prunedCount = initial.prunedCount;
  if (initial.prunedCount > 0) {
    let prunedIds = new Set(initial.pruned.map((conversation) => conversation.id));
    kept = await updateConversationHistory(targetStorage, (current) => {
      const filtered = filterExpiredConversations(current, now, retentionMs);
      prunedIds = new Set(filtered.pruned.map((conversation) => conversation.id));
      prunedCount = filtered.prunedCount;
      return filtered.kept;
    });
    if (chatSessionState.currentConversationId && prunedIds.has(chatSessionState.currentConversationId)) {
      detachConversationIdentity();
      applyLiveContextToMain();
    }
  }
  return { prunedCount, kept };
}

export function createConversationStore(deps: CreateConversationStoreDeps): ConversationStore {
  for (const key of [
    "loadContextState",
    "resolveAiConversationRef",
    "onConversationChanged",
    "onStreamInterrupted",
    "onContextNotice"
  ] as const) {
    if (typeof deps[key] !== "function") {
      throw new Error(`createConversationStore: deps.${key} is required (must be a function)`);
    }
  }
  const { loadContextState, resolveAiConversationRef, onConversationChanged, onStreamInterrupted, onContextNotice } = deps;
  const storage = deps.storage || (typeof chrome !== "undefined" && chrome?.storage?.local) || undefined;
  const confirmClearAll = deps.confirmClearAll || ((message: string) => confirmDialog({ message, confirmText: "清空", danger: true }));
  const conversationsStorageKey = CONVERSATIONS_STORAGE_KEY;
  const maxSavedConversations = MAX_SAVED_CONVERSATIONS;

  function emitChange(change: ConversationChange = {}): void {
    onConversationChanged(change);
  }

  function saved(): Conversation[] {
    return chatSessionState.savedConversations;
  }
  function commitSaved(next: Conversation[]): void {
    setSavedConversations(next);
  }

  function detachCurrent(): void {
    onStreamInterrupted();
    detachConversationIdentity();
  }

  function repopulateLive(): void {
    applyLiveContextToMain();
  }

  async function checkCleanOlderThan30DaysEnabled(): Promise<boolean> {
    if (typeof deps.isCleanEnabled === "function") {
      return Boolean(await deps.isCleanEnabled());
    }
    const sync = deps.syncStorage || (typeof chrome !== "undefined" && (chrome?.storage?.sync as StorageArea)) || undefined;
    if (!sync?.get) {
      return false;
    }
    try {
      const res = await sync.get(["cleanConversationsOlderThan30Days"]);
      return Boolean(res?.cleanConversationsOlderThan30Days);
    } catch {
      return false;
    }
  }

  async function loadAll(): Promise<void> {
    let normalized = storage ? await readConversationHistory(storage) : [];
    const isCleanEnabled = await checkCleanOlderThan30DaysEnabled();
    if (isCleanEnabled) {
      const initial = filterExpiredConversations(normalized);
      if (initial.prunedCount > 0) {
        let prunedIds = new Set(initial.pruned.map((conversation) => conversation.id));
        normalized = storage ? await updateConversationHistory(storage, (current) => {
          const filtered = filterExpiredConversations(current);
          prunedIds = new Set(filtered.pruned.map((conversation) => conversation.id));
          return filtered.kept;
        }) : initial.kept;
        if (chatSessionState.currentConversationId && prunedIds.has(chatSessionState.currentConversationId)) {
          detachCurrent();
          repopulateLive();
        }
      }
    }
    commitSaved(normalized);
    emitChange({});
  }

  async function hydrateConversationPage(conversation: OrdinaryConversation): Promise<boolean> {
    const contextRef = conversation.contextRef || null;
    if (!contextRef?.bvid || !contextRef?.cid) {
      return false;
    }
    let response: { ok?: boolean; payload?: unknown; error?: string } = { ok: false };
    try {
      const payload = await resolveAiConversationRef(contextRef, "page");
      response = { ok: true, payload };
    } catch (error: unknown) {
      response = { ok: false, error: (error as Error)?.message || String(error || "") };
    }
    if (!response.ok || !response.payload) {
      return false;
    }

    const payload = response.payload as {
      pageIndex?: number;
      url?: string;
      cid?: string;
      pageTitle?: string;
    };
    const nextPageIndex = Number(payload.pageIndex) > 0 ? Number(payload.pageIndex) : 1;
    const nextUrl = String(payload.url || conversation.contextUrl || contextRef.url || "").trim();
    const nextContextRef: AiContext = {
      ...contextRef,
      url: nextUrl,
      cid: String(payload.cid || contextRef.cid || "").trim(),
      pageIndex: nextPageIndex,
      pageTitle: String(payload.pageTitle || contextRef.pageTitle || "").trim()
    };
    const nextTitle = normalizeConversationTitle(
      conversation.title,
      conversation.contextTitle,
      nextContextRef,
      nextUrl
    );
    const nextContextKey = resolveConversationStorageKey(conversation.contextKey, nextContextRef, nextUrl);
    if (
      nextTitle === conversation.title &&
      nextUrl === conversation.contextUrl &&
      nextContextKey === conversation.contextKey &&
      Number(conversation.contextRef?.pageIndex || 1) === nextPageIndex
    ) {
      return false;
    }

    conversation.title = nextTitle;
    conversation.contextUrl = nextUrl;
    conversation.contextKey = nextContextKey;
    conversation.contextRef = nextContextRef;
    return true;
  }

  async function saveHydratedConversation(hydrated: OrdinaryConversation): Promise<void> {
    if (storage) {
      await updateConversationHistory(storage, (current) => {
        const hasTarget = current.some((item) => !isLiveTextToolHistoryEntry(item) && item.id === hydrated.id);
        if (hasTarget) {
          return current.map((item) =>
            !isLiveTextToolHistoryEntry(item) && item.id === hydrated.id ? hydrated : item
          );
        }
        const localOrdinary = saved().filter((item) => !isLiveTextToolHistoryEntry(item));
        const localIds = new Set(localOrdinary.map((item) => item.id));
        const extraCurrentOrdinary = current.filter(
          (item) => !isLiveTextToolHistoryEntry(item) && !localIds.has(item.id)
        );
        const mergedOrdinary = [...localOrdinary, ...extraCurrentOrdinary].slice(0, maxSavedConversations);
        return [...mergedOrdinary, ...current.filter(isLiveTextToolHistoryEntry)];
      });
    }
    emitChange({});
  }

  async function savePersistedConversation(nextConversation: OrdinaryConversation): Promise<void> {
    if (storage) {
      await updateConversationHistory(storage, (current) => {
        const currentOrdinary = current.filter((item) => !isLiveTextToolHistoryEntry(item));
        const liveEntries = current.filter(isLiveTextToolHistoryEntry);
        const mergedOrdinary = [
          nextConversation,
          ...currentOrdinary.filter((item) => item.id !== nextConversation.id)
        ].slice(0, maxSavedConversations);
        return [...mergedOrdinary, ...liveEntries];
      });
    }
    emitChange({});
  }

  async function restoreLatest(): Promise<boolean> {
    const targetContextKey = chatSessionState.liveContextKey || chatSessionState.currentContextKey;
    const currentRef = chatSessionState.liveContextData || chatSessionState.contextData;
    const conversations = saved();
    const latest = conversations.find((item) =>
      doesConversationMatchCurrentContext(item, currentRef, targetContextKey)
    );
    if (!latest || isLiveTextToolHistoryEntry(latest)) {
      detachCurrent();
      return false;
    }
    if (needsConversationPageHydration(latest) && (await hydrateConversationPage(latest))) {
      await saveHydratedConversation(latest);
    }
    apply(latest);
    return true;
  }

  function apply(conversation: OrdinaryConversation | null | undefined, change: ConversationChange = {}): void {
    if (!conversation) {
      return;
    }
    const liveData = chatSessionState.liveContextData;
    const liveKey = chatSessionState.liveContextKey;
    const matchesLive = Boolean(liveData && conversation.contextKey && conversation.contextKey === liveKey);
    const meta: CurrentConversationMeta = {
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      contextKey: conversation.contextKey,
      contextTitle: conversation.contextTitle,
      contextUrl: conversation.contextUrl,
      isVideoContext: conversation.isVideoContext !== false,
      pinnedContext: true,
      contextRef: conversation.contextRef || null,
      resolvedContext: matchesLive && liveData ? { ...liveData } : null
    };
    applyConversationIdentity({
      id: conversation.id,
      meta,
      history: Array.isArray(conversation.messages)
        ? conversation.messages.map((item) => normalizeHistoryMessage(item))
        : []
    });
    if (matchesLive && liveData) {
      applyContextToMain({ ...liveData }, liveKey);
    } else if (conversation.contextRef) {
      applyContextToMain(buildContextPlaceholder(conversation.contextRef), conversation.contextKey);
    }
    emitChange(change);
  }

  function applyById(id: string): void {
    const conversation = saved().find((item) => item.id === id);
    if (!conversation || isLiveTextToolHistoryEntry(conversation)) {
      return;
    }
    apply(conversation, { resetView: true });
    if (conversation.contextKey && conversation.contextKey !== chatSessionState.liveContextKey) {
      onContextNotice({ kind: "pending", message: "正在加载原视频上下文..." });
      void hydratePinned({ silent: true });
    }
  }

  async function deleteById(id: string): Promise<ConversationDeletion | null> {
    const index = saved().findIndex((item) => item.id === id);
    if (index < 0) {
      return null;
    }
    const conversation = saved()[index];
    const wasCurrent = id === chatSessionState.currentConversationId;
    if (wasCurrent) {
      detachCurrent();
    }
    const next = saved().filter((item) => item.id !== id);
    commitSaved(next);
    if (storage) {
      await updateConversationHistory(storage, (current) => current.filter((item) => item.id !== id));
    }
    emitChange({});
    if (wasCurrent) {
      repopulateLive();
      emitChange({ resetView: true });
    }

    let consumed = false;
    return {
      id,
      undo: async () => {
        if (consumed) {
          return;
        }
        consumed = true;
        const restored = saved().filter((item) => item.id !== id);
        restored.splice(Math.min(index, restored.length), 0, conversation);
        commitSaved(restored);
        if (storage) {
          await updateConversationHistory(storage, (current) => {
            const next = current.filter((item) => item.id !== id);
            next.splice(Math.min(index, next.length), 0, conversation);
            return next;
          });
        }
        emitChange({});
        if (wasCurrent) {
          applyById(id);
        }
      }
    };
  }

  async function clearAll(): Promise<void> {
    if (!saved().length) {
      return;
    }
    const confirmMessage =
      supportsLiveCompanion() || saved().some(isLiveTextToolHistoryEntry)
        ? "确定要清空全部历史记录吗？普通对话和伴看记录都会删除。"
        : "确定要清空全部历史记录吗？";
    if (!(await confirmClearAll(confirmMessage))) {
      return;
    }
    commitSaved([]);
    detachCurrent();
    if (storage) {
      await updateConversationHistory(storage, () => []);
    }
    emitChange({});
    repopulateLive();
    emitChange({ historyCleared: true, resetView: true });
  }

  function detachForRestart(): void {
    detachCurrent();
  }

  function isCurrent(id: string): boolean {
    return id === chatSessionState.currentConversationId;
  }

  async function persistCurrent(): Promise<void> {
    const chat = chatSessionState.chatHistory;
    const context = chatSessionState.contextData;
    if (!chat.length || !context) {
      return;
    }
    const now = Date.now();
    let currentId = chatSessionState.currentConversationId;
    let meta = chatSessionState.currentConversationMeta;
    if (!currentId) {
      currentId = generateConversationId();
      meta = {
        id: currentId,
        title: buildConversationTitle(context),
        createdAt: now,
        updatedAt: now,
        contextKey: chatSessionState.currentContextKey,
        contextTitle: String(context.title || "").trim(),
        contextUrl: String(context.url || "").trim(),
        isVideoContext: context.isVideoContext !== false,
        pinnedContext: true,
        contextRef: buildAiContextRef(context),
        resolvedContext: { ...context }
      };
      applyConversationIdentity({ id: currentId, meta });
    }
    const nextConversation: OrdinaryConversation = {
      id: currentId,
      title: meta?.title || buildConversationTitle(context),
      contextKey: String(meta?.contextKey || chatSessionState.currentContextKey || "").trim(),
      contextTitle: String(meta?.contextTitle || context.title || "").trim(),
      contextUrl: String(meta?.contextUrl || context.url || "").trim(),
      isVideoContext: meta?.isVideoContext !== false,
      createdAt: Number(meta?.createdAt) || now,
      updatedAt: now,
      contextRef: meta?.contextRef || buildAiContextRef(context),
      messages: retainLatestImage(chat.map((item) => normalizeHistoryMessage(item)))
    };
    const filtered = saved().filter((item) => item.id !== currentId);
    commitSaved([nextConversation, ...filtered].slice(0, maxSavedConversations));
    applyConversationIdentity({
      meta: {
        id: nextConversation.id,
        title: nextConversation.title,
        createdAt: nextConversation.createdAt,
        updatedAt: nextConversation.updatedAt,
        contextKey: nextConversation.contextKey,
        contextTitle: nextConversation.contextTitle,
        contextUrl: nextConversation.contextUrl,
        isVideoContext: nextConversation.isVideoContext,
        pinnedContext: true,
        contextRef: nextConversation.contextRef,
        resolvedContext: meta?.resolvedContext ? { ...meta.resolvedContext } : { ...context }
      }
    });
    await savePersistedConversation(nextConversation);
  }

  async function hydratePinned({ silent = false, preserveInput = false }: HydratePinnedOptions = {}): Promise<boolean> {
    let meta = chatSessionState.currentConversationMeta;
    const targetKey = String(meta?.contextKey || "").trim();
    const cachedResolvedContext = meta?.resolvedContext;
    if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
      applyContextToMain({ ...cachedResolvedContext }, targetKey);
      emitChange();
      onContextNotice({ kind: "clear" });
      return true;
    }

    if (targetKey && chatSessionState.liveContextKey && targetKey === chatSessionState.liveContextKey) {
      const ok = await loadContextState({ forceRefresh: false, silent: true, preserveInput });
      const context = chatSessionState.contextData;
      if (ok && context) {
        pinCurrentContextKey(targetKey);
        meta = chatSessionState.currentConversationMeta;
        applyConversationIdentity({
          meta: {
            ...meta,
            resolvedContext: { ...context }
          }
        });
        emitChange();
        onContextNotice({ kind: "clear" });
        return true;
      }
    }

    const contextRef = chatSessionState.currentConversationMeta?.contextRef || null;
    if (!contextRef) {
      onContextNotice({ kind: "clear" });
      if (!silent) {
        onContextNotice({ kind: "error", message: "历史对话缺少原视频信息，无法继续。" });
      }
      return false;
    }

    const response: { ok?: boolean; payload?: unknown; error?: string } = await resolveContext(
      contextRef
    ).catch((error: unknown) => ({
      ok: false,
      error: (error as Error)?.message || String(error || "")
    }));
    if (!response?.ok || !response.payload) {
      onContextNotice({ kind: "clear" });
      if (!silent) {
        onContextNotice({ kind: "error", message: `历史视频上下文获取失败：${response?.error || "未知错误"}` });
      }
      return false;
    }

    const resolved = response.payload as AiContext;
    applyContextToMain(resolved, targetKey);
    meta = chatSessionState.currentConversationMeta;
    applyConversationIdentity({
      meta: {
        ...meta,
        contextKey: chatSessionState.currentContextKey,
        contextTitle: String(resolved.title || meta?.contextTitle || "").trim(),
        contextUrl: String(resolved.url || meta?.contextUrl || "").trim(),
        contextRef: buildAiContextRef(resolved),
        resolvedContext: { ...resolved }
      }
    });
    emitChange();
    onContextNotice({ kind: "clear" });
    return true;
  }

  async function resolveContext(
    contextRef: AiContext
  ): Promise<{ ok?: boolean; payload?: unknown; error?: string }> {
    try {
      const payload = await resolveAiConversationRef(contextRef, "context");
      return { ok: true, payload };
    } catch (error: unknown) {
      return { ok: false, error: (error as Error)?.message || String(error || "") };
    }
  }

  return {
    loadAll,
    isCurrent,
    persistCurrent,
    applyById,
    deleteById,
    clearAll,
    restoreLatest,
    detachForRestart,
    hydratePinned
  };
}

function areSavedConversationsEquivalent(
  left: readonly ChatSessionSavedConversation[],
  right: readonly ChatSessionSavedConversation[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.id !== b.id ||
      Number(a.updatedAt) !== Number(b.updatedAt) ||
      a.title !== b.title ||
      a.contextKey !== b.contextKey ||
      (Array.isArray(a.messages) ? a.messages.length : 0) !== (Array.isArray(b.messages) ? b.messages.length : 0)
    ) {
      return false;
    }
    const aRecords = isLiveTextToolHistoryEntry(a) && Array.isArray(a.records) ? a.records.length : -1;
    const bRecords = isLiveTextToolHistoryEntry(b) && Array.isArray(b.records) ? b.records.length : -1;
    if (aRecords !== bRecords) {
      return false;
    }
  }
  return true;
}

export function syncSavedConversationsFromStorage(rawValue: unknown): boolean {
  const next = normalizeConversations(rawValue);
  if (areSavedConversationsEquivalent(chatSessionState.savedConversations, next)) {
    return false;
  }
  setSavedConversations(next);
  return true;
}
