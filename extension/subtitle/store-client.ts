import { sendRuntimeMessage } from "../shared/messaging.js";
import {
  base64ToChatImageBlob,
  chatImageBlobToBase64,
  chatImageDataUrlToParts,
  chatImageToDataUrl,
  clearSharedMemoryDbsForTests,
  defaultSubtitleIdbStore,
  type AiArtifactRecord,
  type AiArtifactWriteResult,
  type ChatImageRecord,
  type ChatImageWriteResult,
  type PutChatImageInput,
  type SubtitleIdbStore,
  type SubtitleStoreWriteInterceptor,
  type SubtitleStoreWriteResult
} from "./idb-store.js";
import type {
  SubtitleCacheMessage,
  SubtitleCacheResponse,
  WireChatImageRecord
} from "../shared/messaging-protocol.js";

let storeOverrideForTests: SubtitleIdbStore | null = null;
declare const SUBTITLE_STORE_RESET_KEY: unique symbol;
const SUBTITLE_STORE_RESET_SYMBOL: typeof SUBTITLE_STORE_RESET_KEY = Symbol.for(
  "biliscript.subtitleStoreReset"
) as typeof SUBTITLE_STORE_RESET_KEY;
const extraResetHooks = new Set<() => void>();

type SubtitleStoreResetGlobal = typeof globalThis & {
  [SUBTITLE_STORE_RESET_SYMBOL]?: () => void;
};

export function configureSubtitleCacheStoreForTests(store: SubtitleIdbStore | null): void {
  storeOverrideForTests = store;
}

export function setSubtitleCacheWriteInterceptorForTests(
  interceptor: SubtitleStoreWriteInterceptor | null
): void {
  (storeOverrideForTests ?? defaultSubtitleIdbStore).setWriteInterceptorForTests(interceptor);
}

export function registerSubtitleStoreResetHookForTests(hook: () => void): void {
  extraResetHooks.add(hook);
}

export function resetSubtitleStoreClientForTests(): void {
  storeOverrideForTests = null;
  for (const hook of extraResetHooks) {
    try {
      hook();
    } catch {
    }
  }
  clearSharedMemoryDbsForTests();
  void defaultSubtitleIdbStore.clearAll();
}

(globalThis as SubtitleStoreResetGlobal)[SUBTITLE_STORE_RESET_SYMBOL] =
  resetSubtitleStoreClientForTests;

export function shouldRouteViaBackground(): boolean {
  if (storeOverrideForTests) return false;
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") return false;
  if (typeof window === "undefined") return false;
  const protocol = String(window.location?.protocol || "").toLowerCase();
  if (protocol === "chrome-extension:" || protocol === "moz-extension:") return false;
  return protocol === "http:" || protocol === "https:";
}

type SubtitleRpcOutcome =
  | { status: "handled"; response: SubtitleCacheResponse }
  | { status: "unhandled" }
  | { status: "error"; error: Error };

async function sendSubtitleStoreRpcDetailed(message: SubtitleCacheMessage): Promise<SubtitleRpcOutcome> {
  try {
    const response = await sendRuntimeMessage(message);
    if (response && response.handled === true) return { status: "handled", response };
    return { status: "unhandled" };
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err : new Error(String(err)) };
  }
}

async function callSubtitleStoreRpcOrFallback<T>(
  message: SubtitleCacheMessage,
  onHandled: (response: SubtitleCacheResponse) => T,
  onUnhandled: () => Promise<T>,
  fallbackErrorMessage: string
): Promise<T> {
  const outcome = await sendSubtitleStoreRpcDetailed(message);
  if (outcome.status === "handled") {
    if (!outcome.response.ok) throw new Error(outcome.response.error || fallbackErrorMessage);
    return onHandled(outcome.response);
  }
  if (outcome.status === "error") throw outcome.error;
  return onUnhandled();
}

async function callSubtitleStoreWriteOrFallback(
  message: SubtitleCacheMessage,
  onUnhandled: () => Promise<SubtitleStoreWriteResult>,
  fallbackErrorMessage: string
): Promise<SubtitleStoreWriteResult> {
  const outcome = await sendSubtitleStoreRpcDetailed(message);
  if (outcome.status === "handled") return toRpcWriteResult(outcome.response, fallbackErrorMessage);
  if (outcome.status === "error") return { ok: false, evictedIds: [], error: outcome.error };
  return onUnhandled();
}

function toRpcChatImageWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): ChatImageWriteResult {
  if (response.ok) {
    return { ok: true, evictedIds: response.evictedIds ?? [], estimatedBytes: response.estimatedBytes };
  }
  return { ok: false, evictedIds: [], error: new Error(response.error || fallbackErrorMessage) };
}

function toRpcWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): SubtitleStoreWriteResult {
  if (response.ok) {
    return { ok: true, evictedIds: response.evictedIds ?? [], estimatedBytes: response.estimatedBytes };
  }
  return { ok: false, evictedIds: [], error: new Error(response.error || fallbackErrorMessage) };
}

function toRpcAiWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): AiArtifactWriteResult {
  if (response.ok) {
    return { ok: true, evictedKeys: response.evictedKeys ?? [], estimatedBytes: response.estimatedBytes };
  }
  return { ok: false, evictedKeys: [], error: new Error(response.error || fallbackErrorMessage) };
}

function fromWireChatImage(wire: WireChatImageRecord | null | undefined): ChatImageRecord | null {
  if (!wire) return null;
  const parts =
    typeof wire.dataUrl === "string" && wire.dataUrl
      ? chatImageDataUrlToParts(wire.dataUrl, wire.mime)
      : { mime: wire.mime, data: typeof wire.data === "string" ? wire.data : "" };
  if (!parts.data) return null;
  const mime = parts.mime || wire.mime;
  const blob = base64ToChatImageBlob(parts.data, mime);
  return {
    id: wire.id,
    conversationId: wire.conversationId,
    bvid: wire.bvid,
    mime,
    data: parts.data,
    blob,
    byteLength: wire.byteLength || blob.size,
    estimatedBytes: wire.estimatedBytes || blob.size,
    createdAt: wire.createdAt,
    updatedAt: wire.updatedAt
  };
}

async function toWirePutChatImageInput(input: PutChatImageInput): Promise<PutChatImageInput> {
  if (typeof Blob !== "undefined" && input.blob instanceof Blob) {
    const b64 = await chatImageBlobToBase64(input.blob);
    const mime = input.mime || input.blob.type || "application/octet-stream";
    return {
      id: input.id,
      conversationId: input.conversationId,
      ...(input.bvid !== undefined ? { bvid: input.bvid } : {}),
      ...(input.cid !== undefined ? { cid: input.cid } : {}),
      ...(input.site !== undefined ? { site: input.site } : {}),
      mime,
      dataUrl: chatImageToDataUrl(mime, b64),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {})
    };
  }
  if (typeof input.dataUrl === "string" && input.dataUrl) {
    return { ...input, blob: undefined };
  }
  if (typeof input.data === "string" && input.data) {
    return {
      id: input.id,
      conversationId: input.conversationId,
      ...(input.bvid !== undefined ? { bvid: input.bvid } : {}),
      ...(input.cid !== undefined ? { cid: input.cid } : {}),
      ...(input.site !== undefined ? { site: input.site } : {}),
      mime: input.mime,
      dataUrl: input.data.startsWith("data:") ? input.data : chatImageToDataUrl(input.mime, input.data),
      ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
      ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {})
    };
  }
  return input;
}

function createSubtitleCacheRpcAdapter(fallbackStore: SubtitleIdbStore): SubtitleIdbStore {
  return {
    getPageRecord: (bvid, cid) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-page", bvid, cid },
        (response) => response.page ?? null,
        () => fallbackStore.getPageRecord(bvid, cid),
        "读取字幕页缓存失败"
      ),
    listPageRecords: () => fallbackStore.listPageRecords(),
    getRawTrack: (bvid, cid, trackKey) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-raw", bvid, cid, trackKey },
        (response) => response.items ?? null,
        () => fallbackStore.getRawTrack(bvid, cid, trackKey),
        "读取原生字幕缓存失败"
      ),
    putRawTrack: (input) =>
      callSubtitleStoreWriteOrFallback(
        {
          type: "subtitle-cache",
          op: "put-raw",
          bvid: input.bvid,
          cid: input.cid,
          trackKey: input.trackKey,
          ...(input.lang ? { lang: input.lang } : {}),
          ...(input.kind ? { kind: input.kind } : {}),
          items: input.items
        },
        () => fallbackStore.putRawTrack(input),
        "写入原生字幕缓存失败"
      ),
    getSegmentedTrack: (bvid, cid, trackKey, segmentationSig) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-segmented", bvid, cid, trackKey, segmentationSig },
        (response) => response.items ?? null,
        () => fallbackStore.getSegmentedTrack(bvid, cid, trackKey, segmentationSig),
        "读取重断句缓存失败"
      ),
    putSegmentedTrack: (input) =>
      callSubtitleStoreWriteOrFallback(
        {
          type: "subtitle-cache",
          op: "put-segmented",
          bvid: input.bvid,
          cid: input.cid,
          trackKey: input.trackKey,
          segmentationSig: input.segmentationSig,
          items: input.items
        },
        () => fallbackStore.putSegmentedTrack(input),
        "写入重断句缓存失败"
      ),
    getTranslatedTrack: (bvid, cid, sourceTrackKey, targetLang, translationSig) =>
      callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "get-translated",
          bvid,
          cid,
          sourceTrackKey,
          targetLang,
          ...(translationSig ? { translationSig } : {})
        },
        (response) => response.items ?? null,
        () => fallbackStore.getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig),
        "读取译文缓存失败"
      ),
    upsertTranslatedTrack: (input) =>
      callSubtitleStoreWriteOrFallback(
        {
          type: "subtitle-cache",
          op: "upsert-translated",
          bvid: input.bvid,
          cid: input.cid,
          sourceTrackKey: input.sourceTrackKey,
          targetLang: input.targetLang,
          translationSig: input.translationSig,
          ...(input.mode ? { mode: input.mode } : {}),
          items: input.items,
          ...(input.replaceRange ? { replaceRange: input.replaceRange } : {})
        },
        () => fallbackStore.upsertTranslatedTrack(input),
        "写入译文缓存失败"
      ),
    deleteTrackEntry: (input) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "delete-entry", bvid: input.bvid, cid: input.cid, tier: input.tier, key: input.key },
        (response) => Boolean(response.ok),
        () => fallbackStore.deleteTrackEntry(input),
        "删除字幕缓存条目失败"
      ),
    pruneAsrVariants: (args) =>
      callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "prune-asr",
          bvid: args.bvid,
          cid: args.cid,
          ...(args.keepTrackKey !== undefined ? { keepTrackKey: args.keepTrackKey } : {})
        },
        (response) => response.removedKeys ?? [],
        () => fallbackStore.pruneAsrVariants(args),
        "清理过期 ASR 字幕缓存失败"
      ),
    clearTranslatedTracksForPage: (args) =>
      callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "clear-translated",
          bvid: args.bvid,
          cid: args.cid,
          ...(args.sourceTrackKey ? { sourceTrackKey: args.sourceTrackKey } : {})
        },
        (response) => response.removedKeys ?? [],
        () => fallbackStore.clearTranslatedTracksForPage(args),
        "清理译文缓存失败"
      ),

    getAiArtifact: <TPayload = unknown>(key: string) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-ai-artifact", key },
        (response) => (response.artifact ?? null) as AiArtifactRecord<TPayload> | null,
        () => fallbackStore.getAiArtifact<TPayload>(key),
        "读取 AI 产物缓存失败"
      ),
    readAiArtifactPayloadRaw: <TPayload = unknown>(key: string) =>
      fallbackStore.readAiArtifactPayloadRaw<TPayload>(key),
    getAiArtifactsMany: <TPayload = unknown>(keys: string[]) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-ai-artifacts", keys },
        (response) => (response.artifacts ?? keys.map(() => null)) as Array<AiArtifactRecord<TPayload> | null>,
        () => fallbackStore.getAiArtifactsMany<TPayload>(keys),
        "批量读取 AI 产物缓存失败"
      ),
    async putAiArtifact(input) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "put-ai-artifact",
        key: input.key,
        ...(input.family ? { family: input.family } : {}),
        ...(input.bvid !== undefined ? { bvid: input.bvid } : {}),
        ...(input.cid !== undefined ? { cid: input.cid } : {}),
        payload: input.payload,
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
        ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt } : {})
      });
      if (outcome.status === "handled") return toRpcAiWriteResult(outcome.response, "写入 AI 产物缓存失败");
      if (outcome.status === "error") return { ok: false, evictedKeys: [], error: outcome.error };
      return fallbackStore.putAiArtifact(input);
    },
    deleteAiArtifact: (key) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "delete-ai-artifact", key },
        (response) => Boolean(response.deleted),
        () => fallbackStore.deleteAiArtifact(key),
        "删除 AI 产物缓存失败"
      ),
    listAiArtifactsByFamilyBvid: (family, bvid, keyPrefix) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "list-ai-artifacts", family, bvid, ...(keyPrefix ? { keyPrefix } : {}) },
        (response) => (response.artifacts ?? []).filter((item): item is AiArtifactRecord => item !== null),
        () => fallbackStore.listAiArtifactsByFamilyBvid(family, bvid, keyPrefix),
        "列举 AI 产物缓存失败"
      ),
    listAiArtifactsByBvid: (bvid) => fallbackStore.listAiArtifactsByBvid(bvid),
    listAllAiArtifacts: () => fallbackStore.listAllAiArtifacts(),
    clearVideo: (bvid, cid) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "clear-video", bvid, ...(cid ? { cid } : {}) },
        (response) => ({
          removedPageIds: response.removedPageIds ?? [],
          removedArtifactKeys: response.removedArtifactKeys ?? []
        }),
        () => fallbackStore.clearVideo(bvid, cid),
        "清理视频缓存失败"
      ),

    getChatImage: (id) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-chat-image", id },
        (response) => fromWireChatImage(response.chatImage),
        () => fallbackStore.getChatImage(id),
        "读取对话图片缓存失败"
      ),
    getChatImagesMany: (ids) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-chat-images", ids },
        (response) => (response.chatImages ?? ids.map(() => null)).map(fromWireChatImage),
        () => fallbackStore.getChatImagesMany(ids),
        "批量读取对话图片缓存失败"
      ),
    async putChatImage(input) {
      const wireInput = await toWirePutChatImageInput(input);
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "put-chat-image",
        chatImage: wireInput
      });
      if (outcome.status === "handled") return toRpcChatImageWriteResult(outcome.response, "写入对话图片缓存失败");
      if (outcome.status === "error") return { ok: false, evictedIds: [], error: outcome.error };
      return fallbackStore.putChatImage(input);
    },
    async deleteChatImages(ids) {
      const outcome = await sendSubtitleStoreRpcDetailed({ type: "subtitle-cache", op: "delete-chat-images", ids });
      if (outcome.status === "handled") return outcome.response.removedIds ?? [];
      if (outcome.status === "error") return [];
      return fallbackStore.deleteChatImages(ids);
    },
    async deleteChatImagesByConversationIds(conversationIds) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "delete-chat-images-by-conversations",
        conversationIds
      });
      if (outcome.status === "handled") return outcome.response.removedIds ?? [];
      if (outcome.status === "error") return [];
      return fallbackStore.deleteChatImagesByConversationIds(conversationIds);
    },
    async pruneChatImages(input) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "prune-chat-images",
        validConversationIds: [...input.validConversationIds],
        ...(input.keepImageIds ? { keepImageIds: [...input.keepImageIds] } : {})
      });
      if (outcome.status === "handled") return outcome.response.removedIds ?? [];
      if (outcome.status === "error") return [];
      return fallbackStore.pruneChatImages(input);
    },
    async clearAllChatImages() {
      const outcome = await sendSubtitleStoreRpcDetailed({ type: "subtitle-cache", op: "clear-chat-images" });
      if (outcome.status === "handled") return outcome.response.removedIds ?? [];
      if (outcome.status === "error") return [];
      return fallbackStore.clearAllChatImages();
    },
    listChatImagesByConversationId: (conversationId) => fallbackStore.listChatImagesByConversationId(conversationId),
    listAllChatImages: () => fallbackStore.listAllChatImages(),

    getVideoCacheUsage: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-video-cache-usage" },
        (response) =>
          response.usage ?? {
            totalBytes: 0,
            subtitleBytes: 0,
            artifactBytes: 0,
            subtitlePageCount: 0,
            artifactCount: 0,
            maxBytes: 0
          },
        () => fallbackStore.getVideoCacheUsage(),
        "读取缓存占用失败"
      ),
    syncVideoCacheMaxBytes: (maxBytes) => fallbackStore.syncVideoCacheMaxBytes(maxBytes),
    setVideoCacheMaxBytes: (maxBytes) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "set-video-cache-limit", maxBytes },
        (response) => ({
          evictedPageIds: response.evictedPageIds ?? [],
          evictedArtifactKeys: response.evictedKeys ?? [],
          usage: response.usage ?? {
            totalBytes: 0,
            subtitleBytes: 0,
            artifactBytes: 0,
            subtitlePageCount: 0,
            artifactCount: 0,
            maxBytes
          }
        }),
        () => fallbackStore.setVideoCacheMaxBytes(maxBytes),
        "更新缓存上限失败"
      ),

    getConversation: (id) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-conversation", id },
        (response) => response.conversation ?? null,
        () => fallbackStore.getConversation(id),
        "读取历史对话失败"
      ),
    listConversationMetas: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "list-conversation-metas" },
        (response) => response.conversationMetas ?? [],
        () => fallbackStore.listConversationMetas(),
        "读取历史对话头列表失败"
      ),
    listConversations: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "list-conversations" },
        (response) => response.conversations ?? [],
        () => fallbackStore.listConversations(),
        "读取历史对话列表失败"
      ),
    countConversations: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "count-conversations" },
        (response) => Number(response.count) || 0,
        () => fallbackStore.countConversations(),
        "统计历史对话数量失败"
      ),
    putConversation: (record) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "put-conversation", conversation: record },
        () => undefined,
        () => fallbackStore.putConversation(record),
        "保存历史对话失败"
      ),
    putConversationsMany: (records) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "put-conversations", conversations: records },
        () => undefined,
        () => fallbackStore.putConversationsMany(records),
        "批量保存历史对话失败"
      ),
    deleteConversations: (ids) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "delete-conversations", ids },
        (response) => response.removedIds ?? [],
        () => fallbackStore.deleteConversations(ids),
        "删除历史对话失败"
      ),
    clearAllConversations: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "clear-conversations" },
        (response) => response.removedIds ?? [],
        () => fallbackStore.clearAllConversations(),
        "清空历史对话失败"
      ),
    pruneConversationsToLimit: (maxCount) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "prune-conversations", maxCount },
        (response) => ({
          removedIds: response.removedIds ?? [],
          keptCount: Number(response.keptCount) || 0
        }),
        () => fallbackStore.pruneConversationsToLimit(maxCount),
        "裁剪历史对话失败"
      ),
    async upsertConversationAtomic(input) {
      const wireImages = Array.isArray(input.images) && input.images.length > 0
        ? await Promise.all(input.images.map(toWirePutChatImageInput))
        : undefined;
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "upsert-conversation-atomic",
          conversation: input.conversation,
          ...(wireImages ? { chatImages: wireImages } : {}),
          ...(input.maxCount !== undefined ? { maxCount: input.maxCount } : {})
        },
        (response) => {
          if (!response.summary) throw new Error("保存历史对话失败");
          return { summary: response.summary, prunedIds: response.prunedIds ?? [] };
        },
        () => fallbackStore.upsertConversationAtomic(input),
        "保存历史对话失败"
      );
    },
    upsertLiveTextToolItemAtomic: (input) =>
      callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "upsert-live-text-tool-item-atomic",
          liveTextToolRecord: input.record,
          ...(input.maxRecordsPerVideo !== undefined ? { maxRecordsPerVideo: input.maxRecordsPerVideo } : {})
        },
        (response) => ({ summary: response.summary ?? null }),
        () => fallbackStore.upsertLiveTextToolItemAtomic(input),
        "保存伴看记录失败"
      ),
    patchConversationSummaryAnchor: (input) =>
      callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "patch-conversation-summary-anchor",
          id: input.id,
          summaryAnchor: input.summaryAnchor,
          ...(input.expectedCoveredMessageIds
            ? { expectedCoveredMessageIds: [...input.expectedCoveredMessageIds] }
            : {}),
          ...(input.expectedBoundaryContent !== undefined
            ? { expectedBoundaryContent: input.expectedBoundaryContent }
            : {})
        },
        (response) => ({
          updated: Boolean(response.updated),
          ...(response.summaryAnchor ? { summaryAnchor: response.summaryAnchor } : {})
        }),
        () => fallbackStore.patchConversationSummaryAnchor(input),
        "更新会话摘要锚点失败"
      ),
    deleteConversationAtomic: (ids) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "delete-conversation-atomic", ids },
        (response) => ({
          removedIds: response.removedIds ?? [],
          removedImageIds: response.removedImageIds ?? []
        }),
        () => fallbackStore.deleteConversationAtomic(ids),
        "删除历史对话失败"
      ),
    clearConversationsAtomic: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "clear-conversations-atomic" },
        (response) => ({
          removedIds: response.removedIds ?? [],
          removedImageIds: response.removedImageIds ?? []
        }),
        () => fallbackStore.clearConversationsAtomic(),
        "清空历史对话失败"
      ),
    async migrateLegacyConversationsAtomic(input) {
      const wireImages = Array.isArray(input.images) && input.images.length > 0
        ? await Promise.all(input.images.map(toWirePutChatImageInput))
        : undefined;
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "migrate-legacy-conversations",
          conversations: [...input.conversations],
          ...(wireImages ? { chatImages: wireImages } : {})
        },
        (response) => ({
          migrated: Boolean(response.migrated),
          importedCount: Number(response.importedCount) || 0
        }),
        () => fallbackStore.migrateLegacyConversationsAtomic(input),
        "迁移旧版历史对话失败"
      );
    },

    getNoteHighlights: (videoKey) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-note-highlights", videoKey },
        (response) => response.noteHighlights ?? null,
        () => fallbackStore.getNoteHighlights(videoKey),
        "读取划词高亮失败"
      ),
    putNoteHighlights: (record) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "put-note-highlights", noteHighlights: record },
        () => undefined,
        () => fallbackStore.putNoteHighlights(record),
        "保存划词高亮失败"
      ),
    putNoteHighlightsMany: (records, markMetaKey, markMetaValue) =>
      callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "put-note-highlights-many",
          noteHighlightsList: [...records],
          ...(markMetaKey !== undefined ? { markMetaKey } : {}),
          ...(markMetaValue !== undefined ? { markMetaValue } : {})
        },
        () => undefined,
        () => fallbackStore.putNoteHighlightsMany(records, markMetaKey, markMetaValue),
        "批量保存划词高亮失败"
      ),
    deleteNoteHighlights: (videoKey) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "delete-note-highlights", videoKey },
        (response) => Boolean(response.deleted),
        () => fallbackStore.deleteNoteHighlights(videoKey),
        "删除划词高亮失败"
      ),
    listNoteHighlights: () =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "list-note-highlights" },
        (response) => response.noteHighlightsList ?? [],
        () => fallbackStore.listNoteHighlights(),
        "列举划词高亮失败"
      ),

    getStoreMeta: <T = unknown>(key: string) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "get-store-meta", key },
        (response) => (response.metaValue ?? null) as T | null,
        () => fallbackStore.getStoreMeta<T>(key),
        "读取元数据失败"
      ),
    putStoreMeta: (key, value) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "put-store-meta", key, metaValue: value },
        () => undefined,
        () => fallbackStore.putStoreMeta(key, value),
        "写入元数据失败"
      ),
    deleteStoreMeta: (key) =>
      callSubtitleStoreRpcOrFallback(
        { type: "subtitle-cache", op: "delete-store-meta", key },
        () => undefined,
        () => fallbackStore.deleteStoreMeta(key),
        "删除元数据失败"
      ),

    clearAll: () => fallbackStore.clearAll(),
    setWriteInterceptorForTests: (interceptor) => fallbackStore.setWriteInterceptorForTests(interceptor)
  };
}

const rpcSubtitleIdbStore = createSubtitleCacheRpcAdapter(defaultSubtitleIdbStore);

export function resolveDirectSubtitleStore(): SubtitleIdbStore {
  return storeOverrideForTests ?? defaultSubtitleIdbStore;
}

export function resolveActiveSubtitleStore(): SubtitleIdbStore {
  if (storeOverrideForTests) return storeOverrideForTests;
  return shouldRouteViaBackground() ? rpcSubtitleIdbStore : defaultSubtitleIdbStore;
}

export type VideoCacheClearHook = (bvid: string, cid?: string) => void;

const videoCacheClearHooks = new Set<VideoCacheClearHook>();

export function registerVideoCacheClearHook(hook: VideoCacheClearHook): () => void {
  videoCacheClearHooks.add(hook);
  return () => {
    videoCacheClearHooks.delete(hook);
  };
}

export function runVideoCacheClearHooks(bvid: string, cid?: string): void {
  for (const hook of videoCacheClearHooks) {
    try {
      hook(bvid, cid);
    } catch {
    }
  }
}
