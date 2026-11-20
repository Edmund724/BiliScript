import { normalizeConversations } from "../ai/conversation.js";
import type { ImagePart } from "../ai/types.js";
import { isLiveTextToolHistoryEntry } from "../live/live-text-tool-history.js";
import { logWarn } from "../shared/logging.js";
import { fnv1a32 } from "../shared/text-primitives.js";
import type { ChatImageRecord, SubtitleIdbStore } from "../subtitle/idb-store.js";
import { resolveActiveSubtitleStore } from "../subtitle/store-client.js";
import { setSavedConversations } from "./chat-state.js";
import type { StorageArea } from "./conversation-store.js";

export type StoredConversation = ReturnType<typeof normalizeConversations>[number];
export const HISTORY_STORAGE_KEY = "biliscript_ai_conversations_v1";

export interface PersistedImageRef {
  mime: string;
  idbRef: string;
}

export type PersistedImageEntry = ImagePart | PersistedImageRef;

const queues = new WeakMap<StorageArea, Promise<unknown>>();

function isBrowserLocalStorage(storage: StorageArea): boolean {
  return typeof chrome !== "undefined" && storage === chrome.storage?.local;
}

function runWithCrossTabLock<T>(storage: StorageArea, task: () => Promise<T>): Promise<T> {
  if (
    isBrowserLocalStorage(storage) &&
    typeof navigator !== "undefined" &&
    typeof navigator.locks?.request === "function"
  ) {
    return navigator.locks.request(HISTORY_STORAGE_KEY, () => task());
  }
  return task();
}

function enqueue<T>(storage: StorageArea, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(storage) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => runWithCrossTabLock(storage, task));
  queues.set(storage, next);
  return next.finally(() => {
    if (queues.get(storage) === next) queues.delete(storage);
  });
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

function extractConversationBvid(item: unknown): string {
  if (!item || typeof item !== "object") {
    return "";
  }
  const obj = item as {
    bvid?: unknown;
    contextRef?: { bvid?: unknown } | null;
    contextSnapshot?: { bvid?: unknown } | null;
  };
  return String(obj.contextRef?.bvid || obj.contextSnapshot?.bvid || obj.bvid || "").trim();
}

interface VerifiedChatImage {
  conversationId: string;
  mime: string;
  data: string;
}

interface HydrationScanResult {
  hydratedRaw: unknown;
  verifiedRefs: Map<string, VerifiedChatImage>;
  /** 仅在读盘 RPC 瞬态失败时记录受影响消息的原始轻引用，避免并发写另一条会话时擦除未修改会话的 idbRef。 */
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
      hydratedRaw: rawValue,
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
          // 缺失、损坏或 RPC 失败时安全跳过该单张图片，不影响文本及其他正常图片
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

async function lazyMigrateLegacyInlineImages(
  rawValue: unknown,
  normalizedConversations: readonly StoredConversation[],
  storage: StorageArea,
  store: SubtitleIdbStore
): Promise<void> {
  if (!Array.isArray(rawValue) || typeof storage.set !== "function") {
    return;
  }

  const validConvIds = new Set<string>();
  for (const conv of normalizedConversations) {
    if (!isLiveTextToolHistoryEntry(conv) && conv.id) {
      validConvIds.add(conv.id);
    }
  }
  if (validConvIds.size === 0) {
    return;
  }

  const now = Date.now();
  let migratedCount = 0;
  const migratedRaw: unknown[] = [];

  for (const item of rawValue) {
    if (!item || typeof item !== "object" || isLiveTextToolHistoryEntry(item)) {
      migratedRaw.push(item);
      continue;
    }
    const obj = item as {
      id?: unknown;
      createdAt?: unknown;
      updatedAt?: unknown;
      messages?: unknown;
      [key: string]: unknown;
    };
    const convId = String(obj.id || "").trim();
    if (!convId || !validConvIds.has(convId) || !Array.isArray(obj.messages)) {
      migratedRaw.push(item);
      continue;
    }

    const bvid = extractConversationBvid(obj);
    const createdAt = Number(obj.createdAt) || now;
    const updatedAt = Number(obj.updatedAt) || createdAt;
    let convChanged = false;
    const nextMessages: unknown[] = [];

    for (const msg of obj.messages) {
      if (!msg || typeof msg !== "object") {
        nextMessages.push(msg);
        continue;
      }
      const msgObj = msg as { images?: unknown; [key: string]: unknown };
      if (!Array.isArray(msgObj.images)) {
        nextMessages.push(msg);
        continue;
      }

      let msgChanged = false;
      const nextImages: unknown[] = [];
      for (const entry of msgObj.images) {
        if (isPersistedImageRef(entry)) {
          // 保留既有 idbRef 原样，不覆盖
          nextImages.push(entry);
          continue;
        }
        if (isInlineImagePart(entry)) {
          const mime = entry.mime.trim();
          const idbRef = computeChatImageId(convId, mime, entry.data);
          // 先写 IDB，确认落盘成功后再将 storage.local 对应条目替换为轻引用
          const writeRes = await putChatImageSafe(store, {
            id: idbRef,
            conversationId: convId,
            bvid,
            mime,
            data: entry.data,
            createdAt,
            updatedAt,
            lastUsedAt: now
          });
          if (writeRes.ok) {
            nextImages.push({ mime, idbRef } satisfies PersistedImageRef);
            msgChanged = true;
            migratedCount += 1;
          } else {
            logWarn(
              "[BILISCRIPT] failed to lazily migrate inline chat image to IndexedDB; keeping inline base64",
              { conversationId: convId, imageId: idbRef, error: writeRes.error }
            );
            nextImages.push(entry);
          }
          continue;
        }
        nextImages.push(entry);
      }

      if (msgChanged) {
        convChanged = true;
        nextMessages.push({ ...msgObj, images: nextImages });
      } else {
        nextMessages.push(msg);
      }
    }

    migratedRaw.push(convChanged ? { ...obj, messages: nextMessages } : item);
  }

  if (migratedCount > 0) {
    try {
      await storage.set({ [HISTORY_STORAGE_KEY]: migratedRaw });
    } catch (error) {
      logWarn("[BILISCRIPT] failed to persist lazily migrated chat image references", {
        migratedCount,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}

interface ExternalizeResult {
  persisted: unknown[];
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
  const persisted: unknown[] = [];

  for (const conv of conversations) {
    if (isLiveTextToolHistoryEntry(conv)) {
      persisted.push(conv);
      continue;
    }

    const bvid = extractConversationBvid(conv);
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

        // 先将图片写入 chat_images 并落盘确认成功，再把轻引用写入对话存储；
        // 写入失败时回退保留原内联 base64，绝不写悬空 idbRef。
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

    persisted.push(convChanged ? { ...conv, messages: nextMessages } : conv);
  }

  return {
    persisted,
    activeImageIds,
    newlyWrittenImageIds,
    externalizedCount
  };
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

    // 1) 清空全部普通会话：直接清空 chat_images，零孤儿残留
    if (nextConversationIds.size === 0) {
      if (rawConversationIds.size > 0 || rawImageRefs.size > 0 || next.length === 0) {
        await store.clearAllChatImages();
      }
      return;
    }

    // 2) 删除单条会话或超 60 条上限淘汰最旧会话：同步按 by_conversationId 索引删除
    const removedConversationIds: string[] = [];
    for (const prevId of rawConversationIds) {
      if (!nextConversationIds.has(prevId)) {
        removedConversationIds.push(prevId);
      }
    }
    if (removedConversationIds.length > 0) {
      await store.deleteChatImagesByConversationIds(removedConversationIds);
    }

    // 3) 覆盖保存（某张图被移除/替换）与兜底孤儿清理：
    //    仅在读盘未发生瞬态 RPC 失败时按全量存活集合裁剪，避免瞬态抖动误删正常图片。
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

export function readConversationHistory(storage: StorageArea): Promise<StoredConversation[]> {
  return enqueue(storage, async () => {
    const store = resolveActiveSubtitleStore();
    const data = await storage.get([HISTORY_STORAGE_KEY]).catch(() => ({} as Record<string, unknown>));
    const rawValue = data?.[HISTORY_STORAGE_KEY];
    const hydration = await hydrateRawConversations(rawValue, store);
    const conversations = normalizeConversations(hydration.hydratedRaw);
    if (hydration.hasLegacyInlineImages) {
      await lazyMigrateLegacyInlineImages(rawValue, conversations, storage, store);
    }
    setSavedConversations(conversations);
    return conversations;
  });
}

export function updateConversationHistory(
  storage: StorageArea,
  update: (current: StoredConversation[]) => StoredConversation[]
): Promise<StoredConversation[]> {
  return enqueue(storage, async () => {
    const store = resolveActiveSubtitleStore();
    const data = await storage.get([HISTORY_STORAGE_KEY]);
    const rawCurrent = data?.[HISTORY_STORAGE_KEY];
    const hydration = await hydrateRawConversations(rawCurrent, store);
    const current = normalizeConversations(hydration.hydratedRaw);
    const next = normalizeConversations(update(current));
    const externalized = await externalizeConversationsForStorage(
      next,
      hydration.verifiedRefs,
      hydration.preservedRefsOnRpcFailure,
      store
    );

    try {
      await storage.set({ [HISTORY_STORAGE_KEY]: externalized.persisted });
    } catch (error) {
      // storage.set 失败时尽力回滚本次新写入 IDB 的图片，避免残留无主记录
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
    return next;
  });
}

/**
 * 兜底孤儿图片清理：扫描当前持久化会话列表中的存活会话与引用，回收 IDB 中所有无主图片。
 */
export function pruneOrphanChatImages(storage: StorageArea): Promise<string[]> {
  return enqueue(storage, async () => {
    const store = resolveActiveSubtitleStore();
    const data = await storage.get([HISTORY_STORAGE_KEY]).catch(() => ({} as Record<string, unknown>));
    const rawValue = data?.[HISTORY_STORAGE_KEY];
    const validConversationIds: string[] = [];
    const keepImageIds: string[] = [];

    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (!item || typeof item !== "object" || isLiveTextToolHistoryEntry(item)) {
          continue;
        }
        const convId = String((item as { id?: unknown }).id || "").trim();
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
    }

    if (validConversationIds.length === 0) {
      return store.clearAllChatImages();
    }
    return store.pruneChatImages({ validConversationIds, keepImageIds });
  });
}
