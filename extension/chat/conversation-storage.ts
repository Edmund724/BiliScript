import { normalizeConversations } from "../ai/conversation.js";
import type { ImagePart } from "../ai/types.js";
import { normalizeChatHistoryMaxCount } from "../core/validators.js";
import { isLiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
import type { LiveTextToolRecord } from "../live/live-text-tool-records.js";
import { logWarn } from "../shared/logging.js";
import {
  YOUTUBE_UNIT_CID,
  detectSiteFromUrl,
  extractYoutubeVideoId,
  normalizeSiteId,
  resolveVideoStorageKey
} from "../shared/site.js";
import { fnv1a32 } from "../shared/text-primitives.js";
import type {
  ChatImageRecord,
  PatchConversationSummaryAnchorInput,
  PatchConversationSummaryAnchorResult,
  PersistedConversationRecord,
  PruneConversationsResult,
  PutChatImageInput,
  SubtitleIdbStore
} from "../subtitle/idb-store.js";
import { resolveActiveSubtitleStore, shouldRouteViaBackground } from "../subtitle/store-client.js";
import {
  applyLiveContextToMain,
  chatSessionState,
  detachConversationIdentity,
  setSavedConversations
} from "./chat-state.js";
import {
  toConversationSummaryItem,
  type ConversationSummaryItem
} from "./conversation-types.js";
import type { StorageArea } from "./conversation-store.js";

export type StoredConversation = ReturnType<typeof normalizeConversations>[number];
export const HISTORY_STORAGE_KEY = "biliscript_ai_conversations_v1";
export const CONVERSATIONS_SYNC_SIGNAL_KEY = "biliscript_ai_conversations_sync_v2";

export interface ConversationSyncSignal {
  op: "upsert" | "delete" | "clear";
  originClientId: string;
  seq: number;
  summary?: ConversationSummaryItem;
  prunedIds?: string[];
  deletedIds?: string[];
}

export interface PersistedImageRef {
  mime: string;
  idbRef: string;
}

export type PersistedImageEntry = ImagePart | PersistedImageRef;

export function createTabClientId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

const TAB_CLIENT_ID = createTabClientId();
let syncSignalSeq = 0;

export function getTabClientId(): string {
  return TAB_CLIENT_ID;
}

function resolveDefaultLocalStorage(storage?: StorageArea): StorageArea | undefined {
  if (storage) {
    return storage;
  }
  return typeof chrome !== "undefined" ? (chrome.storage?.local as StorageArea | undefined) : undefined;
}

export async function resolveChatHistoryMaxCount(syncStorage?: StorageArea): Promise<number> {
  const sync =
    syncStorage ||
    (typeof chrome !== "undefined" ? (chrome.storage?.sync as StorageArea | undefined) : undefined);
  if (!sync?.get) {
    return 0;
  }
  try {
    const res = await sync.get(["chatHistoryMaxCount"]);
    return normalizeChatHistoryMaxCount(res?.chatHistoryMaxCount);
  } catch {
    return 0;
  }
}

export function isPersistedImageRef(value: unknown): value is PersistedImageRef {
  if (!value || typeof value !== "object") {
    return false;
  }
  const part = value as { mime?: unknown; idbRef?: unknown };
  return (
    typeof part.mime === "string" &&
    Boolean(part.mime.trim()) &&
    typeof part.idbRef === "string" &&
    Boolean(part.idbRef.trim())
  );
}

export function isInlineImagePart(value: unknown): value is ImagePart {
  if (!value || typeof value !== "object") {
    return false;
  }
  const part = value as { mime?: unknown; data?: unknown };
  return (
    typeof part.mime === "string" &&
    Boolean(part.mime.trim()) &&
    typeof part.data === "string" &&
    Boolean(part.data)
  );
}

export function computeChatImageId(conversationId: string, mime: string, data: string): string {
  const cleanConvId = String(conversationId || "").trim();
  const cleanMime = String(mime || "").trim();
  const h1 = fnv1a32(`${cleanMime}\u0000${data}`).toString(36);
  const h2 = fnv1a32(
    `${data.length}\u0000${data.slice(0, 64)}\u0000${data.slice(-64)}\u0000${cleanMime}`
  ).toString(36);
  return `img_${cleanConvId}_${h1}_${h2}_${data.length.toString(36)}`;
}

function extractConversationStorageBvid(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const obj = item as {
    site?: unknown;
    bvid?: unknown;
    cid?: unknown;
    url?: unknown;
    contextUrl?: unknown;
    contextRef?: { site?: unknown; bvid?: unknown; cid?: unknown; url?: unknown } | null;
    contextSnapshot?: { site?: unknown; bvid?: unknown; cid?: unknown; url?: unknown } | null;
  };
  const url = String(
    obj.contextRef?.url || obj.contextSnapshot?.url || obj.contextUrl || obj.url || ""
  ).trim();
  const rawBvid = String(
    obj.contextRef?.bvid || obj.contextSnapshot?.bvid || obj.bvid || ""
  ).trim();
  const rawCid = String(
    obj.contextRef?.cid || obj.contextSnapshot?.cid || obj.cid || ""
  ).trim();
  const rawSite =
    obj.contextRef?.site ||
    obj.contextSnapshot?.site ||
    obj.site ||
    (rawCid === YOUTUBE_UNIT_CID ? "youtube" : detectSiteFromUrl(url));
  const site = normalizeSiteId(rawSite);
  const videoId = rawBvid || (site === "youtube" ? extractYoutubeVideoId(url) : "");
  if (!videoId) {
    return "";
  }
  return resolveVideoStorageKey(site, videoId, rawCid).bvid;
}

interface HydrationScanResult {
  hydratedRaw: unknown[];
  hasLegacyInlineImages: boolean;
  readRpcFailed: boolean;
}

async function hydrateRawConversations(
  rawValue: unknown,
  store: SubtitleIdbStore
): Promise<HydrationScanResult> {
  let hasLegacyInlineImages = false;
  let readRpcFailed = false;

  if (!Array.isArray(rawValue)) {
    return {
      hydratedRaw: [],
      hasLegacyInlineImages,
      readRpcFailed
    };
  }

  const refsToFetch: string[] = [];
  const seenRefs = new Set<string>();

  for (const item of rawValue) {
    if (!item || typeof item !== "object" || isLiveTextToolHistoryEntry(item)) {
      continue;
    }
    const messages = (item as { messages?: unknown }).messages;
    if (!Array.isArray(messages)) {
      continue;
    }
    for (const msg of messages) {
      const images = (msg as { images?: unknown } | null)?.images;
      if (!Array.isArray(images)) {
        continue;
      }
      for (const entry of images) {
        if (isPersistedImageRef(entry)) {
          const refId = entry.idbRef.trim();
          if (!seenRefs.has(refId)) {
            seenRefs.add(refId);
            refsToFetch.push(refId);
          }
        } else if (isInlineImagePart(entry)) {
          hasLegacyInlineImages = true;
        }
      }
    }
  }

  const resolvedById = new Map<string, ChatImageRecord>();
  const missingRefs: string[] = [];

  if (refsToFetch.length > 0) {
    try {
      const records = await store.getChatImagesMany(refsToFetch);
      for (let i = 0; i < refsToFetch.length; i += 1) {
        const refId = refsToFetch[i];
        const rec = Array.isArray(records) ? records[i] : null;
        if (
          rec &&
          typeof rec.mime === "string" &&
          Boolean(rec.mime.trim()) &&
          typeof rec.data === "string" &&
          Boolean(rec.data)
        ) {
          resolvedById.set(refId, rec);
        } else {
          missingRefs.push(refId);
        }
      }
      if (missingRefs.length > 0) {
        logWarn(
          "[BILISCRIPT] chat image records missing or corrupted in IndexedDB; degrading affected images only",
          { missingCount: missingRefs.length, missingIds: missingRefs.slice(0, 5) }
        );
      }
    } catch (error) {
      readRpcFailed = true;
      logWarn(
        "[BILISCRIPT] failed to hydrate chat images from IndexedDB; continuing without externalized images",
        {
          count: refsToFetch.length,
          error: error instanceof Error ? error.message : String(error)
        }
      );
    }
  }

  if (refsToFetch.length === 0) {
    return {
      hydratedRaw: rawValue,
      hasLegacyInlineImages,
      readRpcFailed
    };
  }

  const hydratedRaw = rawValue.map((item) => {
    if (!item || typeof item !== "object" || isLiveTextToolHistoryEntry(item)) {
      return item;
    }
    const obj = item as { messages?: unknown; [key: string]: unknown };
    if (!Array.isArray(obj.messages)) {
      return item;
    }
    let convChanged = false;
    const nextMessages = obj.messages.map((msg) => {
      if (!msg || typeof msg !== "object") {
        return msg;
      }
      const msgObj = msg as { images?: unknown; [key: string]: unknown };
      if (!Array.isArray(msgObj.images)) {
        return msg;
      }
      let msgHasRef = false;
      const hydratedImages: ImagePart[] = [];
      for (const entry of msgObj.images) {
        if (isPersistedImageRef(entry)) {
          msgHasRef = true;
          const refId = entry.idbRef.trim();
          const hit = resolvedById.get(refId);
          if (hit) {
            const mime = hit.mime.trim() || entry.mime.trim();
            hydratedImages.push({ mime, data: hit.data });
          } else if (isInlineImagePart(entry)) {
            hydratedImages.push({ mime: entry.mime, data: entry.data });
          }
        } else if (isInlineImagePart(entry)) {
          hydratedImages.push({ mime: entry.mime, data: entry.data });
        }
      }
      if (!msgHasRef) {
        return msg;
      }
      convChanged = true;
      const nextMsg = { ...msgObj };
      if (hydratedImages.length > 0) {
        nextMsg.images = hydratedImages;
      } else {
        delete nextMsg.images;
      }
      return nextMsg;
    });
    return convChanged ? { ...obj, messages: nextMessages } : item;
  });

  return {
    hydratedRaw,
    hasLegacyInlineImages,
    readRpcFailed
  };
}

function extractImagesForAtomicWrite(
  conversations: readonly StoredConversation[]
): {
  persisted: PersistedConversationRecord[];
  images: PutChatImageInput[];
} {
  const images: PutChatImageInput[] = [];
  const seenImageIds = new Set<string>();
  const now = Date.now();
  const persisted: PersistedConversationRecord[] = [];

  for (const conv of conversations) {
    if (isLiveTextToolHistoryEntry(conv)) {
      persisted.push(conv as unknown as PersistedConversationRecord);
      continue;
    }
    const bvid = extractConversationStorageBvid(conv);
    let convChanged = false;
    const nextMessages: unknown[] = [];

    for (const msg of conv.messages) {
      if (!Array.isArray(msg.images) || msg.images.length === 0) {
        nextMessages.push(msg);
        continue;
      }
      const nextImages: PersistedImageEntry[] = [];
      for (const img of msg.images) {
        if (!isInlineImagePart(img)) {
          continue;
        }
        const mime = img.mime.trim();
        const idbRef = computeChatImageId(conv.id, mime, img.data);
        nextImages.push({ mime, idbRef });
        convChanged = true;
        if (!seenImageIds.has(idbRef)) {
          seenImageIds.add(idbRef);
          images.push({
            id: idbRef,
            conversationId: conv.id,
            bvid,
            mime,
            data: img.data,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            lastUsedAt: now
          });
        }
      }
      if (nextImages.length > 0) {
        nextMessages.push({ ...msg, images: nextImages });
      } else {
        const stripped = { ...msg };
        delete stripped.images;
        nextMessages.push(stripped);
      }
    }

    const record = convChanged ? { ...conv, messages: nextMessages } : conv;
    persisted.push(record as unknown as PersistedConversationRecord);
  }

  return { persisted, images };
}

function sortSummariesDesc(list: ConversationSummaryItem[]): ConversationSummaryItem[] {
  return list.sort((a, b) => {
    const bUpdated = Number(b.updatedAt) || 0;
    const aUpdated = Number(a.updatedAt) || 0;
    if (bUpdated !== aUpdated) return bUpdated - aUpdated;
    const bCreated = Number(b.createdAt) || 0;
    const aCreated = Number(a.createdAt) || 0;
    if (bCreated !== aCreated) return bCreated - aCreated;
    return a.id.localeCompare(b.id);
  });
}

export function patchSavedConversationSummaries(
  summary: ConversationSummaryItem,
  prunedIds: readonly string[] = []
): ConversationSummaryItem[] {
  const prunedSet = new Set(prunedIds);
  const next = sortSummariesDesc([
    summary,
    ...chatSessionState.savedConversations.filter(
      (item) => item.id !== summary.id && !prunedSet.has(item.id)
    )
  ]);
  setSavedConversations(next);
  return next;
}

async function emitConversationSyncSignal(
  storage: StorageArea | undefined,
  signal: Omit<ConversationSyncSignal, "seq">
): Promise<void> {
  if (!storage?.set) {
    return;
  }
  const payload: ConversationSyncSignal = {
    seq: ++syncSignalSeq,
    ...signal
  };
  try {
    await storage.set({ [CONVERSATIONS_SYNC_SIGNAL_KEY]: payload });
  } catch (error) {
    logWarn("[BILISCRIPT] failed to broadcast conversation sync signal", {
      op: signal.op,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function clearLegacyLocalHistoryKey(storage: StorageArea | undefined): Promise<void> {
  if (!storage) {
    return;
  }
  try {
    if (typeof storage.remove === "function") {
      await storage.remove(HISTORY_STORAGE_KEY);
    } else if (typeof storage.set === "function") {
      await storage.set({ [HISTORY_STORAGE_KEY]: [] });
    }
  } catch (error) {
    logWarn("[BILISCRIPT] failed to clear legacy local conversation history key", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

async function migrateLegacyLocalHistoryIfNeeded(
  storage: StorageArea | undefined,
  store: SubtitleIdbStore
): Promise<void> {
  if (!storage?.get) {
    return;
  }
  const data = await storage.get([HISTORY_STORAGE_KEY]).catch(() => ({} as Record<string, unknown>));
  const rawLegacy = data?.[HISTORY_STORAGE_KEY];
  if (!Array.isArray(rawLegacy) || rawLegacy.length === 0) {
    return;
  }

  const hydration = await hydrateRawConversations(rawLegacy, store);
  const legacyNormalized = normalizeConversations(hydration.hydratedRaw);
  if (legacyNormalized.length === 0) {
    await clearLegacyLocalHistoryKey(storage);
    return;
  }

  const { persisted, images } = extractImagesForAtomicWrite(legacyNormalized);
  await store.migrateLegacyConversationsAtomic({
    conversations: persisted,
    images
  });
  await clearLegacyLocalHistoryKey(storage);
}

async function lazyMigrateInlineImagesInIdb(
  conversation: StoredConversation,
  store: SubtitleIdbStore
): Promise<void> {
  const { persisted, images } = extractImagesForAtomicWrite([conversation]);
  const record = persisted[0];
  if (!record || images.length === 0) {
    return;
  }
  try {
    await store.upsertConversationAtomic({
      conversation: record,
      images,
      maxCount: 0
    });
  } catch (error) {
    logWarn("[BILISCRIPT] failed to persist lazily migrated chat image references to IndexedDB", {
      conversationId: conversation.id,
      migratedCount: images.length,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export async function listConversationSummaries(
  storage?: StorageArea
): Promise<ConversationSummaryItem[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  const metas = await store.listConversationMetas();
  const summaries = sortSummariesDesc(
    metas
      .map((meta) => toConversationSummaryItem(meta))
      .filter((item): item is ConversationSummaryItem => item !== null)
  );
  setSavedConversations(summaries);
  return summaries;
}

export async function readConversationById(
  id: string,
  storage?: StorageArea
): Promise<StoredConversation | null> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  const raw = await store.getConversation(id);
  if (!raw) {
    return null;
  }
  const hydration = await hydrateRawConversations([raw], store);
  const normalized = normalizeConversations(hydration.hydratedRaw);
  const item = normalized[0] ?? null;
  if (item && hydration.hasLegacyInlineImages && !hydration.readRpcFailed) {
    await lazyMigrateInlineImagesInIdb(item, store);
  }
  return item;
}

export async function countConversationHistory(storage?: StorageArea): Promise<number> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  return store.countConversations();
}

export interface SaveConversationEntryOptions {
  storage?: StorageArea;
  maxCount?: number;
  clientId?: string;
  clearSummaryAnchor?: boolean;
}

export async function saveConversationEntry(
  conversation: StoredConversation,
  options: SaveConversationEntryOptions = {}
): Promise<{
  conversation: StoredConversation | null;
  summary: ConversationSummaryItem | null;
  prunedIds: string[];
}> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  const normalizedList = normalizeConversations([conversation]);
  const normalized = normalizedList[0];
  if (!normalized) {
    return { conversation: null, summary: null, prunedIds: [] };
  }

  const { persisted, images } = extractImagesForAtomicWrite([normalized]);
  const record = persisted[0];
  if (!record) {
    return { conversation: null, summary: null, prunedIds: [] };
  }
  if (options.clearSummaryAnchor) {
    record.summaryAnchor = null;
  }

  let resolvedMaxCount = options.maxCount;
  if (resolvedMaxCount === undefined && !shouldRouteViaBackground()) {
    resolvedMaxCount = await resolveChatHistoryMaxCount();
  }

  const res = await store.upsertConversationAtomic({
    conversation: record,
    images,
    ...(resolvedMaxCount !== undefined ? { maxCount: resolvedMaxCount } : {})
  });
  const summary = toConversationSummaryItem(res.summary) ?? toConversationSummaryItem(normalized);
  if (summary) {
    patchSavedConversationSummaries(summary, res.prunedIds);
    await emitConversationSyncSignal(targetStorage, {
      op: "upsert",
      originClientId: options.clientId || TAB_CLIENT_ID,
      summary,
      ...(res.prunedIds.length > 0 ? { prunedIds: res.prunedIds } : {})
    });
  }

  return { conversation: normalized, summary, prunedIds: res.prunedIds };
}

export async function saveLiveTextToolRecordEntry(
  record: LiveTextToolRecord,
  options: { storage?: StorageArea; clientId?: string } = {}
): Promise<ConversationSummaryItem | null> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  const res = await store.upsertLiveTextToolItemAtomic({
    record: record as unknown as Record<string, unknown>
  });
  if (!res.summary) {
    return null;
  }
  const summary = toConversationSummaryItem(res.summary);
  if (!summary) {
    return null;
  }
  patchSavedConversationSummaries(summary);
  await emitConversationSyncSignal(targetStorage, {
    op: "upsert",
    originClientId: options.clientId || TAB_CLIENT_ID,
    summary
  });
  return summary;
}

export async function patchConversationSummaryAnchorEntry(
  input: PatchConversationSummaryAnchorInput
): Promise<PatchConversationSummaryAnchorResult> {
  return resolveActiveSubtitleStore().patchConversationSummaryAnchor(input);
}

export async function deleteConversationEntry(
  id: string,
  options: { storage?: StorageArea; clientId?: string } = {}
): Promise<string[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  const cleanId = String(id || "").trim();
  if (!cleanId) {
    return [];
  }
  const res = await store.deleteConversationAtomic([cleanId]);
  setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== cleanId));
  await emitConversationSyncSignal(targetStorage, {
    op: "delete",
    originClientId: options.clientId || TAB_CLIENT_ID,
    deletedIds: [cleanId]
  });
  return res.removedIds;
}

export async function clearConversationHistory(
  options: { storage?: StorageArea; clientId?: string } = {}
): Promise<string[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  await clearLegacyLocalHistoryKey(targetStorage);
  const res = await store.clearConversationsAtomic();
  setSavedConversations([]);
  await emitConversationSyncSignal(targetStorage, {
    op: "clear",
    originClientId: options.clientId || TAB_CLIENT_ID
  });
  return res.removedIds;
}

export async function pruneConversationHistoryToLimit(
  maxCount: number,
  options: { storage?: StorageArea; clientId?: string } = {}
): Promise<PruneConversationsResult> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
  const result = await store.pruneConversationsToLimit(maxCount);
  if (result.removedIds.length > 0) {
    const removedSet = new Set(result.removedIds);
    const nextMemory = chatSessionState.savedConversations.filter((item) => !removedSet.has(item.id));
    setSavedConversations(nextMemory);
    if (chatSessionState.currentConversationId && removedSet.has(chatSessionState.currentConversationId)) {
      detachConversationIdentity();
      applyLiveContextToMain();
    }
    await emitConversationSyncSignal(targetStorage, {
      op: "delete",
      originClientId: options.clientId || TAB_CLIENT_ID,
      deletedIds: result.removedIds
    });
  }
  return result;
}
