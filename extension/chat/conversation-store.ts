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
  doesConversationMatchCurrentContext
} from "../ai/conversation.js";
import { extractPageIndexFromUrl } from "../bilibili/video-id-shared.js";
import {
  YOUTUBE_CACHE_EVICTED,
  YOUTUBE_CACHE_EVICTED_MESSAGE,
  isYoutubeCacheEvictedError
} from "../ai/context-resolver.js";
import { isLiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
import { supportsLiveCompanion } from "../shared/runtime-capabilities.js";
import { detectSiteFromUrl, normalizeSiteId } from "../shared/site.js";
import {
  CONVERSATIONS_SYNC_SIGNAL_KEY,
  HISTORY_STORAGE_KEY,
  clearConversationHistory,
  deleteConversationEntry,
  getTabClientId,
  listConversationSummaries,
  patchSavedConversationSummaries,
  readConversationById,
  resolveChatHistoryMaxCount,
  saveConversationEntry,
  type ConversationSyncSignal
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
import {
  isLiveTextToolSummary,
  toConversationSummaryItem,
  type ChatSessionMessage,
  type ChatSessionSavedConversation,
  type ConversationSummaryItem,
  type OrdinaryConversation
} from "./conversation-types.js";
import type { ChatTranscriptMode } from "./protocol.js";

export type Conversation = ChatSessionSavedConversation;

const evictedYoutubeContextKeys = new Set<string>();

export function markPinnedYoutubeCacheEvicted(contextKey: unknown): void {
  const cleanKey = String(contextKey || "").trim();
  if (cleanKey) {
    evictedYoutubeContextKeys.add(cleanKey);
  }
}

export function clearPinnedYoutubeCacheEvicted(contextKey?: unknown): void {
  if (contextKey === undefined) {
    evictedYoutubeContextKeys.clear();
    return;
  }
  const cleanKey = String(contextKey || "").trim();
  if (cleanKey) {
    evictedYoutubeContextKeys.delete(cleanKey);
  }
}

export function isPinnedYoutubeCacheEvicted(meta: CurrentConversationMeta | null | undefined): boolean {
  if (!meta || !meta.pinnedContext || meta.resolvedContext) {
    return false;
  }
  const key = String(meta.contextKey || "").trim();
  if (!key || !evictedYoutubeContextKeys.has(key)) {
    return false;
  }
  const site = normalizeSiteId(meta.contextRef?.site ?? detectSiteFromUrl(meta.contextRef?.url || meta.contextUrl));
  return site === "youtube";
}

function normalizeHistoryMessage(item: ChatSessionMessage): ChatSessionMessage {
  const base: ChatSessionMessage = { role: item.role, content: String(item.content || "") };
  if (typeof item.id === "string" && item.id.trim()) {
    base.id = item.id.trim();
  }
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
  transcriptMode?: ChatTranscriptMode;
}

export interface StorageArea {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
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

export interface StreamInterruptOptions {
  preserveStream?: boolean;
}

export interface CreateConversationStoreDeps {
  loadContextState: (opts: LoadContextStateOptions) => Promise<boolean | object>;
  resolveAiConversationRef: (
    contextRef: AiContext,
    purpose: "context" | "page"
  ) => Promise<Record<string, unknown>>;
  onConversationChanged: (change: ConversationChange) => void;
  onStreamInterrupted: (opts?: StreamInterruptOptions) => void;
  onContextNotice: (notice: ConversationContextNotice) => void;
  storage?: StorageArea;
  syncStorage?: StorageArea;
  getMaxCount?: () => Promise<number> | number;
  confirmClearAll?: (message: string) => boolean | Promise<boolean>;
  clientId?: string;
}

export interface ConversationDeletion {
  id: string;
  undo: () => Promise<void>;
}

export interface PersistCurrentOptions {
  transcriptMode?: ChatTranscriptMode;
}

export interface ConversationStore {
  loadAll: () => Promise<void>;
  isCurrent: (id: string) => boolean;
  persistCurrent: (opts?: PersistCurrentOptions) => Promise<void>;
  applyById: (id: string) => Promise<boolean>;
  deleteById: (id: string) => Promise<ConversationDeletion | null>;
  clearAll: () => Promise<void>;
  restoreLatest: (opts?: StreamInterruptOptions) => Promise<boolean>;
  detachForRestart: (opts?: StreamInterruptOptions) => void;
  hydratePinned: (opts?: HydratePinnedOptions) => Promise<boolean>;
}

export function needsConversationPageHydration(
  conversation: Conversation | OrdinaryConversation | null | undefined
): boolean {
  if (!conversation?.isVideoContext || isLiveTextToolSummary(conversation)) {
    return false;
  }
  const site = normalizeSiteId(
    conversation.contextRef?.site ?? detectSiteFromUrl(conversation.contextUrl || conversation.contextRef?.url)
  );
  if (site !== "bilibili") {
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
export { CONVERSATIONS_SYNC_SIGNAL_KEY };

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
  const storage = deps.storage || (typeof chrome !== "undefined" && (chrome?.storage?.local as StorageArea)) || undefined;
  const confirmClearAll = deps.confirmClearAll || ((message: string) => confirmDialog({ message, confirmText: "清空", danger: true }));
  const clientId = deps.clientId;
  let applySeq = 0;

  function emitChange(change: ConversationChange = {}): void {
    onConversationChanged(change);
  }

  function saved(): ConversationSummaryItem[] {
    return chatSessionState.savedConversations;
  }
  function commitSaved(next: readonly ConversationSummaryItem[]): void {
    setSavedConversations(next);
  }

  function detachCurrent(opts?: StreamInterruptOptions): void {
    applySeq += 1;
    onStreamInterrupted(opts);
    detachConversationIdentity();
  }

  function repopulateLive(): void {
    applyLiveContextToMain();
  }

  async function resolveExplicitMaxCount(): Promise<number | undefined> {
    if (typeof deps.getMaxCount === "function") {
      const value = Math.floor(Number(await deps.getMaxCount()));
      return Number.isFinite(value) && value > 0 ? value : 0;
    }
    if (deps.syncStorage) {
      return resolveChatHistoryMaxCount(deps.syncStorage);
    }
    return undefined;
  }

  async function loadAll(): Promise<void> {
    const summaries = await listConversationSummaries(storage);
    commitSaved(summaries);
    emitChange({});
  }

  async function hydrateConversationPage(conversation: OrdinaryConversation): Promise<boolean> {
    const contextRef = conversation.contextRef || null;
    const site = normalizeSiteId(
      contextRef?.site ?? detectSiteFromUrl(conversation.contextUrl || contextRef?.url)
    );
    if (site !== "bilibili" || !contextRef?.bvid || !contextRef?.cid) {
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
    const maxCount = await resolveExplicitMaxCount();
    await saveConversationEntry(hydrated, {
      storage,
      ...(maxCount !== undefined ? { maxCount } : {}),
      ...(clientId ? { clientId } : {})
    });
    emitChange({});
  }

  async function savePersistedConversation(nextConversation: OrdinaryConversation): Promise<void> {
    const maxCount = await resolveExplicitMaxCount();
    await saveConversationEntry(nextConversation, {
      storage,
      ...(maxCount !== undefined ? { maxCount } : {}),
      ...(clientId ? { clientId } : {})
    });
    emitChange({});
  }

  async function restoreLatest(opts?: StreamInterruptOptions): Promise<boolean> {
    const targetContextKey = chatSessionState.liveContextKey || chatSessionState.currentContextKey;
    const currentRef = chatSessionState.liveContextData || chatSessionState.contextData;
    const conversations = saved();
    const latest = conversations.find((item) =>
      doesConversationMatchCurrentContext(item, currentRef, targetContextKey)
    );
    if (!latest || isLiveTextToolSummary(latest)) {
      detachCurrent(opts);
      return false;
    }
    const seq = ++applySeq;
    const full = await readConversationById(latest.id, storage);
    if (seq !== applySeq) {
      return false;
    }
    if (!full || isLiveTextToolHistoryEntry(full)) {
      detachCurrent(opts);
      return false;
    }
    if (needsConversationPageHydration(full) && (await hydrateConversationPage(full))) {
      if (seq !== applySeq) {
        return false;
      }
      await saveHydratedConversation(full);
      if (seq !== applySeq) {
        return false;
      }
    }
    apply(full);
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
      resolvedContext: matchesLive && liveData ? { ...liveData } : null,
      ...(conversation.transcriptMode ? { transcriptMode: conversation.transcriptMode } : {})
    };
    applyConversationIdentity({
      id: conversation.id,
      meta,
      history: Array.isArray(conversation.messages)
        ? conversation.messages.map((item) => normalizeHistoryMessage(item))
        : []
    });
    if (matchesLive && liveData) {
      clearPinnedYoutubeCacheEvicted(conversation.contextKey);
      applyContextToMain({ ...liveData }, liveKey);
    } else if (conversation.contextRef) {
      applyContextToMain(buildContextPlaceholder(conversation.contextRef), conversation.contextKey);
    }
    emitChange(change);
  }

  async function applyById(id: string): Promise<boolean> {
    const summary = saved().find((item) => item.id === id);
    if (!summary || isLiveTextToolSummary(summary)) {
      return false;
    }
    const seq = ++applySeq;
    const full = await readConversationById(id, storage);
    if (seq !== applySeq) {
      return false;
    }
    if (!full || isLiveTextToolHistoryEntry(full)) {
      return false;
    }
    apply(full, { resetView: true });
    if (full.contextKey && full.contextKey !== chatSessionState.liveContextKey) {
      onContextNotice({ kind: "pending", message: "正在加载原视频上下文..." });
      void hydratePinned({ silent: true });
    }
    return true;
  }

  async function deleteById(id: string): Promise<ConversationDeletion | null> {
    const initialIndex = saved().findIndex((item) => item.id === id);
    if (initialIndex < 0) {
      return null;
    }
    const fullRecord = await readConversationById(id, storage);
    const currentIndex = saved().findIndex((item) => item.id === id);
    if (currentIndex < 0) {
      return null;
    }
    const summarySnapshot = saved()[currentIndex];
    const wasCurrent = id === chatSessionState.currentConversationId;
    if (wasCurrent) {
      detachCurrent();
    } else {
      applySeq += 1;
    }
    const next = saved().filter((item) => item.id !== id);
    commitSaved(next);
    await deleteConversationEntry(id, {
      storage,
      ...(clientId ? { clientId } : {})
    });
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
        if (fullRecord) {
          const maxCount = await resolveExplicitMaxCount();
          const saveRes = await saveConversationEntry(fullRecord, {
            storage,
            ...(maxCount !== undefined ? { maxCount } : {}),
            ...(clientId ? { clientId } : {})
          });
          const prunedSet = new Set(saveRes.prunedIds);
          const restored = saved().filter((item) => item.id !== id && !prunedSet.has(item.id));
          const restoredSummary = saveRes.summary ?? summarySnapshot;
          if (!prunedSet.has(id)) {
            restored.splice(Math.min(currentIndex, restored.length), 0, restoredSummary);
          }
          commitSaved(restored);
          emitChange({});
          if (wasCurrent && !isLiveTextToolHistoryEntry(fullRecord) && !prunedSet.has(id)) {
            apply(fullRecord, { resetView: true });
          }
          return;
        }
        const restored = saved().filter((item) => item.id !== id);
        restored.splice(Math.min(currentIndex, restored.length), 0, summarySnapshot);
        commitSaved(restored);
        emitChange({});
      }
    };
  }

  async function clearAll(): Promise<void> {
    if (!saved().length) {
      return;
    }
    const confirmMessage =
      supportsLiveCompanion() || saved().some(isLiveTextToolSummary)
        ? "确定要清空全部历史记录吗？普通对话和伴看记录都会删除。"
        : "确定要清空全部历史记录吗？";
    if (!(await confirmClearAll(confirmMessage))) {
      return;
    }
    commitSaved([]);
    detachCurrent();
    await clearConversationHistory({
      storage,
      ...(clientId ? { clientId } : {})
    });
    emitChange({});
    repopulateLive();
    emitChange({ historyCleared: true, resetView: true });
  }

  function detachForRestart(opts?: StreamInterruptOptions): void {
    detachCurrent(opts);
  }

  function isCurrent(id: string): boolean {
    return id === chatSessionState.currentConversationId;
  }

  async function persistCurrent(opts?: PersistCurrentOptions): Promise<void> {
    const chat = chatSessionState.chatHistory;
    const context = chatSessionState.contextData;
    if (!chat.length || !context) {
      return;
    }
    const now = Date.now();
    let currentId = chatSessionState.currentConversationId;
    let meta = chatSessionState.currentConversationMeta;
    const resolvedTranscriptMode = opts?.transcriptMode ?? meta?.transcriptMode;
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
        resolvedContext: { ...context },
        ...(resolvedTranscriptMode ? { transcriptMode: resolvedTranscriptMode } : {})
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
      messages: retainLatestImage(chat.map((item) => normalizeHistoryMessage(item))),
      ...(resolvedTranscriptMode ? { transcriptMode: resolvedTranscriptMode } : {})
    };
    const nextSummary = toConversationSummaryItem(nextConversation);
    if (nextSummary) {
      const filtered = saved().filter((item) => item.id !== currentId);
      commitSaved([nextSummary, ...filtered]);
    }
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
        resolvedContext: meta?.resolvedContext ? { ...meta.resolvedContext } : { ...context },
        ...(resolvedTranscriptMode ? { transcriptMode: resolvedTranscriptMode } : {})
      }
    });
    await savePersistedConversation(nextConversation);
  }

  async function hydratePinned({ silent = false, preserveInput = false }: HydratePinnedOptions = {}): Promise<boolean> {
    const startSeq = applySeq;
    const startConvId = chatSessionState.currentConversationId;
    const isStaleHydrate = () =>
      startSeq !== applySeq || chatSessionState.currentConversationId !== startConvId;
    let meta = chatSessionState.currentConversationMeta;
    const targetKey = String(meta?.contextKey || "").trim();
    const cachedResolvedContext = meta?.resolvedContext;
    if (cachedResolvedContext && typeof cachedResolvedContext === "object") {
      clearPinnedYoutubeCacheEvicted(targetKey);
      applyContextToMain({ ...cachedResolvedContext }, targetKey);
      emitChange();
      onContextNotice({ kind: "clear" });
      return true;
    }

    if (targetKey && chatSessionState.liveContextKey && targetKey === chatSessionState.liveContextKey) {
      const ok = await loadContextState({ forceRefresh: false, silent: true, preserveInput });
      if (isStaleHydrate()) {
        return false;
      }
      const liveContext = chatSessionState.liveContextData;
      const context =
        liveContext && Array.isArray(liveContext.subtitleBody) && liveContext.subtitleBody.length > 0
          ? liveContext
          : chatSessionState.contextData;
      const isYoutubeEmptyPlaceholder =
        normalizeSiteId(meta?.contextRef?.site ?? detectSiteFromUrl(meta?.contextRef?.url || meta?.contextUrl)) === "youtube" &&
        !(Array.isArray(context?.subtitleBody) && context.subtitleBody.length > 0);
      if (ok && context && !isYoutubeEmptyPlaceholder) {
        clearPinnedYoutubeCacheEvicted(targetKey);
        applyContextToMain({ ...context }, targetKey);
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

    const response: { ok?: boolean; payload?: unknown; error?: string; code?: string } = await resolveContext(
      contextRef
    ).catch((error: unknown) => ({
      ok: false,
      error: (error as Error)?.message || String(error || ""),
      ...(isYoutubeCacheEvictedError(error) ? { code: YOUTUBE_CACHE_EVICTED } : {})
    }));
    if (isStaleHydrate()) {
      return false;
    }
    if (!response?.ok || !response.payload) {
      onContextNotice({ kind: "clear" });
      const isYoutubeEvicted =
        response?.code === YOUTUBE_CACHE_EVICTED ||
        isYoutubeCacheEvictedError({ code: response?.code, message: response?.error }) ||
        response?.error === YOUTUBE_CACHE_EVICTED_MESSAGE;
      if (isYoutubeEvicted) {
        if (targetKey) {
          markPinnedYoutubeCacheEvicted(targetKey);
        }
        return false;
      }
      if (!silent) {
        onContextNotice({ kind: "error", message: `历史视频上下文获取失败：${response?.error || "未知错误"}` });
      }
      return false;
    }

    clearPinnedYoutubeCacheEvicted(targetKey);
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
  ): Promise<{ ok?: boolean; payload?: unknown; error?: string; code?: string }> {
    try {
      const payload = await resolveAiConversationRef(contextRef, "context");
      return { ok: true, payload };
    } catch (error: unknown) {
      return {
        ok: false,
        error: (error as Error)?.message || String(error || ""),
        ...(isYoutubeCacheEvictedError(error) ? { code: YOUTUBE_CACHE_EVICTED } : {})
      };
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
  left: readonly ConversationSummaryItem[],
  right: readonly ConversationSummaryItem[]
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i];
    const b = right[i];
    if (
      a.id !== b.id ||
      a.kind !== b.kind ||
      Number(a.updatedAt) !== Number(b.updatedAt) ||
      a.title !== b.title ||
      a.contextKey !== b.contextKey ||
      a.messageCount !== b.messageCount ||
      a.recordCount !== b.recordCount ||
      a.hasImages !== b.hasImages ||
      a.transcriptMode !== b.transcriptMode
    ) {
      return false;
    }
  }
  return true;
}

export function syncSavedConversationsFromStorage(rawValue: unknown): boolean {
  const next = normalizeConversations(rawValue)
    .map((item) => toConversationSummaryItem(item))
    .filter((item): item is ConversationSummaryItem => item !== null);
  if (areSavedConversationsEquivalent(chatSessionState.savedConversations, next)) {
    return false;
  }
  setSavedConversations(next);
  return true;
}

export interface ApplyConversationSyncSignalOptions {
  storage?: StorageArea;
  clientId?: string;
  onCurrentUpdated?: () => void;
}

function isStorageAreaLike(value: unknown): value is StorageArea {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { get?: unknown }).get === "function" &&
      typeof (value as { set?: unknown }).set === "function"
  );
}

export async function applyConversationSyncSignal(
  rawSignal: unknown,
  storageOrOptions?: StorageArea | ApplyConversationSyncSignalOptions
): Promise<boolean> {
  if (!rawSignal || typeof rawSignal !== "object") {
    return false;
  }
  const opts: ApplyConversationSyncSignalOptions = isStorageAreaLike(storageOrOptions)
    ? { storage: storageOrOptions }
    : (storageOrOptions ?? {});
  const localClientId = opts.clientId || getTabClientId();
  const signal = rawSignal as Partial<ConversationSyncSignal> & { ids?: string[] };

  if (typeof signal.originClientId === "string" && signal.originClientId === localClientId) {
    return false;
  }

  switch (signal.op) {
    case "clear": {
      if (chatSessionState.savedConversations.length === 0 && !chatSessionState.currentConversationId) {
        return false;
      }
      setSavedConversations([]);
      if (chatSessionState.currentConversationId) {
        detachConversationIdentity();
        applyLiveContextToMain();
        opts.onCurrentUpdated?.();
      }
      return true;
    }
    case "delete": {
      const rawIds = Array.isArray(signal.deletedIds)
        ? signal.deletedIds
        : Array.isArray(signal.ids)
          ? signal.ids
          : [];
      const ids = rawIds.map((id) => String(id || "").trim()).filter(Boolean);
      if (ids.length === 0) {
        return false;
      }
      const removedSet = new Set(ids);
      const next = chatSessionState.savedConversations.filter((item) => !removedSet.has(item.id));
      const listChanged = next.length !== chatSessionState.savedConversations.length;
      if (listChanged) {
        setSavedConversations(next);
      }
      let currentChanged = false;
      if (chatSessionState.currentConversationId && removedSet.has(chatSessionState.currentConversationId)) {
        detachConversationIdentity();
        applyLiveContextToMain();
        opts.onCurrentUpdated?.();
        currentChanged = true;
      }
      return listChanged || currentChanged;
    }
    case "upsert": {
      const summary = toConversationSummaryItem(signal.summary);
      if (!summary) {
        return false;
      }
      const prunedIds = Array.isArray(signal.prunedIds)
        ? signal.prunedIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [];
      const prunedSet = new Set(prunedIds);
      const prev = chatSessionState.savedConversations;
      const next = patchSavedConversationSummaries(summary, prunedIds);
      const listChanged = !areSavedConversationsEquivalent(prev, next);

      const currentId = chatSessionState.currentConversationId;
      let currentChanged = false;
      if (currentId && prunedSet.has(currentId)) {
        detachConversationIdentity();
        applyLiveContextToMain();
        opts.onCurrentUpdated?.();
        currentChanged = true;
      } else if (currentId && currentId === summary.id && !isLiveTextToolSummary(summary)) {
        const refreshed = await readConversationById(summary.id, opts.storage);
        if (
          refreshed &&
          !isLiveTextToolHistoryEntry(refreshed) &&
          chatSessionState.currentConversationId === summary.id
        ) {
          const prevMeta = chatSessionState.currentConversationMeta;
          applyConversationIdentity({
            meta: {
              ...prevMeta,
              id: refreshed.id,
              title: refreshed.title,
              createdAt: refreshed.createdAt,
              updatedAt: refreshed.updatedAt,
              contextKey: refreshed.contextKey,
              contextTitle: refreshed.contextTitle,
              contextUrl: refreshed.contextUrl,
              isVideoContext: refreshed.isVideoContext !== false,
              contextRef: refreshed.contextRef || prevMeta?.contextRef || null,
              ...(refreshed.transcriptMode ? { transcriptMode: refreshed.transcriptMode } : {})
            },
            history: refreshed.messages.map((item) => normalizeHistoryMessage(item))
          });
          opts.onCurrentUpdated?.();
          currentChanged = true;
        }
      }
      return listChanged || currentChanged;
    }
    default:
      return false;
  }
}
