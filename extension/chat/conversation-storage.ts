import { normalizeConversations } from "../ai/conversation.js";
import type { ImagePart } from "../ai/types.js";
import { normalizeChatHistoryMaxCount } from "../core/validators.js";
import { isLiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
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
  PersistedConversationRecord,
  PruneConversationsResult,
  SubtitleIdbStore
} from "../subtitle/idb-store.js";
import { resolveActiveSubtitleStore } from "../subtitle/store-client.js";
import {
  applyLiveContextToMain,
  chatSessionState,
  detachConversationIdentity,
  setSavedConversations
} from "./chat-state.js";
import type { StorageArea } from "./conversation-store.js";

export type StoredConversation = ReturnType<typeof normalizeConversations>[number];
export const HISTORY_STORAGE_KEY = "biliscript_ai_conversations_v1";
export const CONVERSATIONS_SYNC_SIGNAL_KEY = "biliscript_ai_conversations_sync_v2";

export interface ConversationSyncSignal {
  rev: number;
  op: "put" | "delete" | "clear" | "prune" | "replace";
  id?: string;
  ids?: string[];
}

export interface PersistedImageRef {
  mime: string;
  idbRef: string;
}

export type PersistedImageEntry = ImagePart | PersistedImageRef;

const storeQueues = new WeakMap<SubtitleIdbStore, Promise<unknown>>();
let syncSignalSeq = 0;

function resolveDefaultLocalStorage(storage?: StorageArea): StorageArea | undefined {
  if (storage) {
    return storage;
  }
  return typeof chrome !== "undefined" ? (chrome.storage?.local as StorageArea | undefined) : undefined;
}

function isBrowserLocalStorage(storage?: StorageArea): boolean {
  return Boolean(storage) && typeof chrome !== "undefined" && storage === chrome.storage?.local;
}

function runWithCrossTabLock<T>(storage: StorageArea | undefined, task: () => Promise<T>): Promise<T> {
  if (
    (!storage || isBrowserLocalStorage(storage)) &&
    typeof navigator !== "undefined" &&
    typeof navigator.locks?.request === "function"
  ) {
    return navigator.locks.request(HISTORY_STORAGE_KEY, () => task());
  }
  return task();
}

function enqueue<T>(
  store: SubtitleIdbStore,
  storage: StorageArea | undefined,
  task: () => Promise<T>
): Promise<T> {
  const previous = storeQueues.get(store) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => runWithCrossTabLock(storage, task));
  storeQueues.set(store, next);
  return next.finally(() => {
    if (storeQueues.get(store) === next) {
      storeQueues.delete(store);
    }
  });
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

export function hasExternalizedChatImages(rawValue: unknown): boolean {
  if (!Array.isArray(rawValue)) {
    return false;
  }
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
      if (images.some(isPersistedImageRef)) {
        return true;
      }
    }
  }
  return false;
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

interface VerifiedChatImage {
  conversationId: string;
  mime: string;
  data: string;
}

interface HydrationScanResult {
  hydratedRaw: unknown[];
  verifiedRefs: Map<string, VerifiedChatImage>;
  preservedRefsOnRpcFailure: Map<string, PersistedImageRef[]>;
  rawConversationIds: Set<string>;
  rawImageRefs: Set<string>;
  hasLegacyInlineImages: boolean;
  readRpcFailed: boolean;
}

function buildMessageRefKey(conversationId: string, msgIndex: number, role: string, content: string): string {
  return `${conversationId}\u0000${msgIndex}\u0000${role}\u0000${content}`;
}

async function hydrateRawConversations(
  rawValue: unknown,
  store: SubtitleIdbStore
): Promise<HydrationScanResult> {
  const verifiedRefs = new Map<string, VerifiedChatImage>();
  const preservedRefsOnRpcFailure = new Map<string, PersistedImageRef[]>();
  const rawConversationIds = new Set<string>();
  const rawImageRefs = new Set<string>();
  let hasLegacyInlineImages = false;
  let readRpcFailed = false;

  if (!Array.isArray(rawValue)) {
    return {
      hydratedRaw: [],
      verifiedRefs,
      preservedRefsOnRpcFailure,
      rawConversationIds,
      rawImageRefs,
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
    const convId = String((item as { id?: unknown }).id || "").trim();
    if (convId) {
      rawConversationIds.add(convId);
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
          rawImageRefs.add(refId);
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
      verifiedRefs,
      preservedRefsOnRpcFailure,
      rawConversationIds,
      rawImageRefs,
      hasLegacyInlineImages,
      readRpcFailed
    };
  }

  const hydratedRaw = rawValue.map((item) => {
    if (!item || typeof item !== "object" || isLiveTextToolHistoryEntry(item)) {
      return item;
    }
    const obj = item as { id?: unknown; messages?: unknown; [key: string]: unknown };
    const convId = String(obj.id || "").trim();
    if (!Array.isArray(obj.messages)) {
      return item;
    }
    let convChanged = false;
    let validMsgIndex = 0;
    const nextMessages = obj.messages.map((msg) => {
      if (!msg || typeof msg !== "object") {
        return msg;
      }
      const msgObj = msg as { role?: unknown; content?: unknown; images?: unknown; [key: string]: unknown };
      const isNormalizedMsg =
        (msgObj.role === "user" || msgObj.role === "assistant" || msgObj.role === "tool") &&
        typeof msgObj.content === "string";
      const currentMsgIndex = isNormalizedMsg ? validMsgIndex++ : -1;
      if (!Array.isArray(msgObj.images)) {
        return msg;
      }
      let msgHasRef = false;
      const hydratedImages: ImagePart[] = [];
      const failedRefs: PersistedImageRef[] = [];
      for (const entry of msgObj.images) {
        if (isPersistedImageRef(entry)) {
          msgHasRef = true;
          const refId = entry.idbRef.trim();
          const hit = resolvedById.get(refId);
          if (hit) {
            const mime = hit.mime.trim() || entry.mime.trim();
            hydratedImages.push({ mime, data: hit.data });
            verifiedRefs.set(refId, {
              conversationId: hit.conversationId,
              mime,
              data: hit.data
            });
          } else if (isInlineImagePart(entry)) {
            hydratedImages.push({ mime: entry.mime, data: entry.data });
          } else if (readRpcFailed) {
            failedRefs.push({ mime: entry.mime.trim(), idbRef: refId });
          }
        } else if (isInlineImagePart(entry)) {
          hydratedImages.push({ mime: entry.mime, data: entry.data });
        }
      }
      if (readRpcFailed && convId && currentMsgIndex >= 0 && failedRefs.length > 0) {
        preservedRefsOnRpcFailure.set(
          buildMessageRefKey(convId, currentMsgIndex, String(msgObj.role), String(msgObj.content)),
          failedRefs
        );
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
    verifiedRefs,
    preservedRefsOnRpcFailure,
    rawConversationIds,
    rawImageRefs,
    hasLegacyInlineImages,
    readRpcFailed
  };
}

async function putChatImageSafe(
  store: SubtitleIdbStore,
  input: {
    id: string;
    conversationId: string;
    bvid: string;
    mime: string;
    data: string;
    createdAt?: number;
    updatedAt?: number;
    lastUsedAt?: number;
  }
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await store.putChatImage(input);
    if (res.ok) {
      return { ok: true };
    }
    return { ok: false, error: res.error?.message || "putChatImage returned ok=false" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

interface ExternalizeResult {
  persisted: PersistedConversationRecord[];
  activeImageIds: Set<string>;
  newlyWrittenImageIds: string[];
  externalizedCount: number;
}

async function externalizeConversationsForStorage(
  conversations: readonly StoredConversation[],
  verifiedRefs: ReadonlyMap<string, VerifiedChatImage>,
  preservedRefsOnRpcFailure: ReadonlyMap<string, PersistedImageRef[]>,
  store: SubtitleIdbStore
): Promise<ExternalizeResult> {
  const activeImageIds = new Set<string>();
  const newlyWrittenImageIds: string[] = [];
  const writtenInBatch = new Set<string>();
  let externalizedCount = 0;
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

    for (let msgIndex = 0; msgIndex < conv.messages.length; msgIndex += 1) {
      const msg = conv.messages[msgIndex];
      if (!Array.isArray(msg.images) || msg.images.length === 0) {
        const preserved =
          preservedRefsOnRpcFailure.size > 0
            ? preservedRefsOnRpcFailure.get(
                buildMessageRefKey(conv.id, msgIndex, msg.role, msg.content)
              )
            : undefined;
        if (preserved && preserved.length > 0) {
          for (const ref of preserved) {
            activeImageIds.add(ref.idbRef);
          }
          nextMessages.push({ ...msg, images: preserved });
          convChanged = true;
        } else {
          nextMessages.push(msg);
        }
        continue;
      }

      const nextImages: PersistedImageEntry[] = [];
      for (const img of msg.images) {
        if (!isInlineImagePart(img)) {
          continue;
        }
        const mime = img.mime.trim();
        const idbRef = computeChatImageId(conv.id, mime, img.data);
        const verified = verifiedRefs.get(idbRef);

        if (
          (verified &&
            verified.conversationId === conv.id &&
            verified.mime === mime &&
            verified.data === img.data) ||
          writtenInBatch.has(idbRef)
        ) {
          nextImages.push({ mime, idbRef });
          activeImageIds.add(idbRef);
          convChanged = true;
          continue;
        }

        const writeRes = await putChatImageSafe(store, {
          id: idbRef,
          conversationId: conv.id,
          bvid,
          mime,
          data: img.data,
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt,
          lastUsedAt: now
        });

        if (writeRes.ok) {
          nextImages.push({ mime, idbRef });
          activeImageIds.add(idbRef);
          writtenInBatch.add(idbRef);
          newlyWrittenImageIds.push(idbRef);
          externalizedCount += 1;
          convChanged = true;
        } else {
          logWarn(
            "[BILISCRIPT] failed to externalize chat image to IndexedDB; falling back to inline base64",
            { conversationId: conv.id, imageId: idbRef, error: writeRes.error }
          );
          nextImages.push({ mime, data: img.data });
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

  return {
    persisted,
    activeImageIds,
    newlyWrittenImageIds,
    externalizedCount
  };
}

async function emitConversationSyncSignal(
  storage: StorageArea | undefined,
  signal: Omit<ConversationSyncSignal, "rev">
): Promise<void> {
  if (!storage?.set) {
    return;
  }
  const payload: ConversationSyncSignal = {
    rev: Date.now() * 1000 + (++syncSignalSeq % 1000),
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

  const existingList = await store.listConversations();
  const existingById = new Map(existingList.map((item) => [item.id, item]));
  const toImport: StoredConversation[] = [];
  for (const conv of legacyNormalized) {
    const existing = existingById.get(conv.id);
    if (!existing || (Number(conv.updatedAt) || 0) > (Number(existing.updatedAt) || 0)) {
      toImport.push(conv);
    }
  }

  if (toImport.length > 0) {
    const externalized = await externalizeConversationsForStorage(
      toImport,
      hydration.verifiedRefs,
      hydration.preservedRefsOnRpcFailure,
      store
    );
    await store.putConversationsMany(externalized.persisted);
  }

  await clearLegacyLocalHistoryKey(storage);
}

async function lazyMigrateInlineImagesInIdb(
  conversations: readonly StoredConversation[],
  verifiedRefs: ReadonlyMap<string, VerifiedChatImage>,
  preservedRefsOnRpcFailure: ReadonlyMap<string, PersistedImageRef[]>,
  store: SubtitleIdbStore
): Promise<void> {
  const externalized = await externalizeConversationsForStorage(
    conversations,
    verifiedRefs,
    preservedRefsOnRpcFailure,
    store
  );
  if (externalized.externalizedCount > 0) {
    try {
      await store.putConversationsMany(externalized.persisted);
    } catch (error) {
      logWarn("[BILISCRIPT] failed to persist lazily migrated chat image references to IndexedDB", {
        migratedCount: externalized.externalizedCount,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

async function reclaimOrphanChatImagesAfterWrite(options: {
  store: SubtitleIdbStore;
  next: readonly StoredConversation[];
  rawConversationIds: ReadonlySet<string>;
  rawImageRefs: ReadonlySet<string>;
  activeImageIds: ReadonlySet<string>;
  externalizedCount: number;
  readRpcFailed: boolean;
}): Promise<void> {
  const {
    store,
    next,
    rawConversationIds,
    rawImageRefs,
    activeImageIds,
    externalizedCount,
    readRpcFailed
  } = options;

  try {
    const nextConversationIds = new Set<string>();
    for (const conv of next) {
      if (!isLiveTextToolHistoryEntry(conv) && conv.id) {
        nextConversationIds.add(conv.id);
      }
    }

    if (nextConversationIds.size === 0) {
      if (rawConversationIds.size > 0 || rawImageRefs.size > 0 || next.length === 0) {
        await store.clearAllChatImages();
      }
      return;
    }

    const removedConversationIds: string[] = [];
    for (const prevId of rawConversationIds) {
      if (!nextConversationIds.has(prevId)) {
        removedConversationIds.push(prevId);
      }
    }
    if (removedConversationIds.length > 0) {
      await store.deleteChatImagesByConversationIds(removedConversationIds);
    }

    let hasRemovedRef = false;
    for (const oldRef of rawImageRefs) {
      if (!activeImageIds.has(oldRef)) {
        hasRemovedRef = true;
        break;
      }
    }
    if (
      !readRpcFailed &&
      (removedConversationIds.length > 0 || hasRemovedRef || externalizedCount > 0)
    ) {
      await store.pruneChatImages({
        validConversationIds: Array.from(nextConversationIds),
        keepImageIds: Array.from(activeImageIds)
      });
    }
  } catch (error) {
    logWarn("[BILISCRIPT] failed to reclaim orphan chat images after conversation save", {
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

export function readConversationHistory(storage?: StorageArea): Promise<StoredConversation[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    const rawValue = await store.listConversations();
    const hydration = await hydrateRawConversations(rawValue, store);
    const conversations = normalizeConversations(hydration.hydratedRaw);
    if (hydration.hasLegacyInlineImages) {
      await lazyMigrateInlineImagesInIdb(
        conversations,
        hydration.verifiedRefs,
        hydration.preservedRefsOnRpcFailure,
        store
      );
    }
    setSavedConversations(conversations);
    return conversations;
  });
}

export function readConversationById(
  id: string,
  storage?: StorageArea
): Promise<StoredConversation | null> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    const raw = await store.getConversation(id);
    if (!raw) {
      return null;
    }
    const hydration = await hydrateRawConversations([raw], store);
    const normalized = normalizeConversations(hydration.hydratedRaw);
    return normalized[0] ?? null;
  });
}

export function countConversationHistory(storage?: StorageArea): Promise<number> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    return store.countConversations();
  });
}

export interface SaveConversationEntryOptions {
  storage?: StorageArea;
  maxCount?: number;
}

export function saveConversationEntry(
  conversation: StoredConversation,
  options: SaveConversationEntryOptions = {}
): Promise<{ conversation: StoredConversation | null; prunedIds: string[] }> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    const normalizedList = normalizeConversations([conversation]);
    const normalized = normalizedList[0];
    if (!normalized) {
      return { conversation: null, prunedIds: [] };
    }

    const existing = await store.getConversation(normalized.id);
    const existingHydration = existing
      ? await hydrateRawConversations([existing], store)
      : {
          hydratedRaw: [],
          verifiedRefs: new Map<string, VerifiedChatImage>(),
          preservedRefsOnRpcFailure: new Map<string, PersistedImageRef[]>(),
          rawConversationIds: new Set<string>(),
          rawImageRefs: new Set<string>(),
          hasLegacyInlineImages: false,
          readRpcFailed: false
        };

    const externalized = await externalizeConversationsForStorage(
      [normalized],
      existingHydration.verifiedRefs,
      existingHydration.preservedRefsOnRpcFailure,
      store
    );
    const persisted = externalized.persisted[0];
    if (!persisted) {
      return { conversation: null, prunedIds: [] };
    }

    try {
      await store.putConversation(persisted);
    } catch (error) {
      if (externalized.newlyWrittenImageIds.length > 0) {
        await store.deleteChatImages(externalized.newlyWrittenImageIds).catch(() => {});
      }
      throw error;
    }

    if (!existingHydration.readRpcFailed && existingHydration.rawImageRefs.size > 0) {
      const removedImgIds: string[] = [];
      for (const oldRef of existingHydration.rawImageRefs) {
        if (!externalized.activeImageIds.has(oldRef)) {
          removedImgIds.push(oldRef);
        }
      }
      if (removedImgIds.length > 0) {
        await store.deleteChatImages(removedImgIds).catch(() => {});
      }
    }

    const maxCount = Math.floor(Number(options.maxCount ?? 0));
    let prunedIds: string[] = [];
    if (Number.isFinite(maxCount) && maxCount > 0) {
      const pruneRes = await store.pruneConversationsToLimit(maxCount);
      prunedIds = pruneRes.removedIds;
    }

    const prunedSet = new Set(prunedIds);
    const nextMemory = [
      normalized,
      ...chatSessionState.savedConversations.filter(
        (item) => item.id !== normalized.id && !prunedSet.has(item.id)
      )
    ].sort((a, b) => {
      const bUpdated = Number(b.updatedAt) || 0;
      const aUpdated = Number(a.updatedAt) || 0;
      if (bUpdated !== aUpdated) return bUpdated - aUpdated;
      const bCreated = Number(b.createdAt) || 0;
      const aCreated = Number(a.createdAt) || 0;
      if (bCreated !== aCreated) return bCreated - aCreated;
      return a.id.localeCompare(b.id);
    });
    const boundedMemory =
      Number.isFinite(maxCount) && maxCount > 0 && nextMemory.length > maxCount
        ? nextMemory.slice(0, maxCount)
        : nextMemory;
    setSavedConversations(boundedMemory);

    await emitConversationSyncSignal(targetStorage, {
      op: prunedIds.length > 0 ? "prune" : "put",
      id: normalized.id,
      ...(prunedIds.length > 0 ? { ids: prunedIds } : {})
    });

    return { conversation: normalized, prunedIds };
  });
}

export function deleteConversationEntry(
  id: string,
  options: { storage?: StorageArea } = {}
): Promise<string[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    const cleanId = String(id || "").trim();
    if (!cleanId) {
      return [];
    }
    const removedIds = await store.deleteConversations([cleanId]);
    await store.deleteChatImagesByConversationIds([cleanId]).catch(() => {});
    setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== cleanId));
    await emitConversationSyncSignal(targetStorage, { op: "delete", ids: [cleanId] });
    return removedIds;
  });
}

export function clearConversationHistory(
  options: { storage?: StorageArea } = {}
): Promise<string[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  return enqueue(store, targetStorage, async () => {
    await clearLegacyLocalHistoryKey(targetStorage);
    const removedIds = await store.clearAllConversations();
    await store.clearAllChatImages().catch(() => {});
    setSavedConversations([]);
    await emitConversationSyncSignal(targetStorage, { op: "clear" });
    return removedIds;
  });
}

export function pruneConversationHistoryToLimit(
  maxCount: number,
  options: { storage?: StorageArea } = {}
): Promise<PruneConversationsResult> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(options.storage);
  return enqueue(store, targetStorage, async () => {
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
        op: "prune",
        ids: result.removedIds
      });
    }
    return result;
  });
}

export function updateConversationHistory(
  storage: StorageArea | undefined,
  update: (current: StoredConversation[]) => StoredConversation[],
  options: { maxCount?: number } = {}
): Promise<StoredConversation[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    const rawCurrent = await store.listConversations();
    const hydration = await hydrateRawConversations(rawCurrent, store);
    const current = normalizeConversations(hydration.hydratedRaw);
    const next = normalizeConversations(update(current), {
      ...(options.maxCount !== undefined ? { maxCount: options.maxCount } : {})
    });
    const externalized = await externalizeConversationsForStorage(
      next,
      hydration.verifiedRefs,
      hydration.preservedRefsOnRpcFailure,
      store
    );

    const nextIds = new Set(externalized.persisted.map((item) => item.id));
    const removedIds: string[] = [];
    for (const prev of rawCurrent) {
      if (prev.id && !nextIds.has(prev.id)) {
        removedIds.push(prev.id);
      }
    }

    try {
      if (externalized.persisted.length === 0) {
        await store.clearAllConversations();
      } else {
        await store.putConversationsMany(externalized.persisted);
        if (removedIds.length > 0) {
          await store.deleteConversations(removedIds);
        }
      }
    } catch (error) {
      if (externalized.newlyWrittenImageIds.length > 0) {
        await store.deleteChatImages(externalized.newlyWrittenImageIds).catch(() => {});
      }
      throw error;
    }

    await reclaimOrphanChatImagesAfterWrite({
      store,
      next,
      rawConversationIds: hydration.rawConversationIds,
      rawImageRefs: hydration.rawImageRefs,
      activeImageIds: externalized.activeImageIds,
      externalizedCount: externalized.externalizedCount,
      readRpcFailed: hydration.readRpcFailed
    });

    setSavedConversations(next);
    await emitConversationSyncSignal(targetStorage, {
      op: externalized.persisted.length === 0 ? "clear" : "replace"
    });
    return next;
  });
}

export function pruneOrphanChatImages(storage?: StorageArea): Promise<string[]> {
  const store = resolveActiveSubtitleStore();
  const targetStorage = resolveDefaultLocalStorage(storage);
  return enqueue(store, targetStorage, async () => {
    await migrateLegacyLocalHistoryIfNeeded(targetStorage, store);
    const rawValue = await store.listConversations();
    const validConversationIds: string[] = [];
    const keepImageIds: string[] = [];

    for (const item of rawValue) {
      if (!item || typeof item !== "object" || isLiveTextToolHistoryEntry(item)) {
        continue;
      }
      const convId = String(item.id || "").trim();
      if (!convId) {
        continue;
      }
      validConversationIds.push(convId);
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
            keepImageIds.push(entry.idbRef.trim());
          }
        }
      }
    }

    if (validConversationIds.length === 0) {
      return store.clearAllChatImages();
    }
    return store.pruneChatImages({ validConversationIds, keepImageIds });
  });
}
