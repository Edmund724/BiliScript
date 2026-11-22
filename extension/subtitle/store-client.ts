import { sendRuntimeMessage } from "../shared/messaging.js";
import {
  defaultSubtitleIdbStore,
  type AiArtifactRecord,
  type AiArtifactWriteResult,
  type ChatImageWriteResult,
  type SubtitleIdbStore,
  type SubtitleStoreWriteInterceptor,
  type SubtitleStoreWriteResult
} from "./idb-store.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../shared/messaging-protocol.js";

let storeOverrideForTests: SubtitleIdbStore | null = null;
const SUBTITLE_STORE_RESET_SYMBOL = Symbol.for("biliscript.subtitleStoreReset");
const extraResetHooks = new Set<() => void>();

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
  void defaultSubtitleIdbStore.clearAll();
}

(globalThis as unknown as Record<symbol, unknown>)[SUBTITLE_STORE_RESET_SYMBOL] =
  resetSubtitleStoreClientForTests;

export function shouldRouteViaBackground(): boolean {
  if (storeOverrideForTests) {
    return false;
  }
  if (typeof chrome === "undefined" || typeof chrome.runtime?.sendMessage !== "function") {
    return false;
  }
  if (typeof window === "undefined") {
    return false;
  }
  const protocol = String(window.location?.protocol || "").toLowerCase();
  if (protocol === "chrome-extension:" || protocol === "moz-extension:") {
    return false;
  }
  return protocol === "http:" || protocol === "https:";
}

type SubtitleRpcOutcome =
  | { status: "handled"; response: SubtitleCacheResponse }
  | { status: "unhandled" }
  | { status: "error"; error: Error };

async function sendSubtitleStoreRpcDetailed(
  message: SubtitleCacheMessage
): Promise<SubtitleRpcOutcome> {
  try {
    const response = await sendRuntimeMessage(message);
    if (response && response.handled === true) {
      return { status: "handled", response };
    }
    return { status: "unhandled" };
  } catch (err) {
    return {
      status: "error",
      error: err instanceof Error ? err : new Error(String(err))
    };
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
    if (!outcome.response.ok) {
      throw new Error(outcome.response.error || fallbackErrorMessage);
    }
    return onHandled(outcome.response);
  }
  if (outcome.status === "error") {
    throw outcome.error;
  }
  return onUnhandled();
}

async function callSubtitleStoreWriteOrFallback(
  message: SubtitleCacheMessage,
  onUnhandled: () => Promise<SubtitleStoreWriteResult>,
  fallbackErrorMessage: string
): Promise<SubtitleStoreWriteResult> {
  const outcome = await sendSubtitleStoreRpcDetailed(message);
  if (outcome.status === "handled") {
    return toRpcWriteResult(outcome.response, fallbackErrorMessage);
  }
  if (outcome.status === "error") {
    return {
      ok: false,
      evictedIds: [],
      error: outcome.error
    };
  }
  return onUnhandled();
}

function toRpcChatImageWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): ChatImageWriteResult {
  if (response.ok) {
    return {
      ok: true,
      evictedIds: response.evictedIds ?? [],
      estimatedBytes: response.estimatedBytes
    };
  }
  return {
    ok: false,
    evictedIds: [],
    error: new Error(response.error || fallbackErrorMessage)
  };
}

function toRpcWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): SubtitleStoreWriteResult {
  if (response.ok) {
    return {
      ok: true,
      evictedIds: response.evictedIds ?? [],
      estimatedBytes: response.estimatedBytes
    };
  }
  return {
    ok: false,
    evictedIds: [],
    error: new Error(response.error || fallbackErrorMessage)
  };
}

function toRpcAiWriteResult(
  response: SubtitleCacheResponse,
  fallbackErrorMessage: string
): AiArtifactWriteResult {
  if (response.ok) {
    return {
      ok: true,
      evictedKeys: response.evictedKeys ?? [],
      estimatedBytes: response.estimatedBytes
    };
  }
  return {
    ok: false,
    evictedKeys: [],
    error: new Error(response.error || fallbackErrorMessage)
  };
}

function createSubtitleCacheRpcAdapter(fallbackStore: SubtitleIdbStore): SubtitleIdbStore {
  return {
    getPageRecord(bvid, cid) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "get-page",
          bvid,
          cid
        },
        (response) => response.page ?? null,
        () => fallbackStore.getPageRecord(bvid, cid),
        "读取字幕页缓存失败"
      );
    },
    listPageRecords() {
      return fallbackStore.listPageRecords();
    },
    getRawTrack(bvid, cid, trackKey) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "get-raw",
          bvid,
          cid,
          trackKey
        },
        (response) => response.items ?? null,
        () => fallbackStore.getRawTrack(bvid, cid, trackKey),
        "读取原生字幕缓存失败"
      );
    },
    putRawTrack(input) {
      return callSubtitleStoreWriteOrFallback(
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
      );
    },
    getSegmentedTrack(bvid, cid, trackKey, segmentationSig) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "get-segmented",
          bvid,
          cid,
          trackKey,
          segmentationSig
        },
        (response) => response.items ?? null,
        () => fallbackStore.getSegmentedTrack(bvid, cid, trackKey, segmentationSig),
        "读取重断句缓存失败"
      );
    },
    putSegmentedTrack(input) {
      return callSubtitleStoreWriteOrFallback(
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
      );
    },
    getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig) {
      return callSubtitleStoreRpcOrFallback(
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
      );
    },
    upsertTranslatedTrack(input) {
      return callSubtitleStoreWriteOrFallback(
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
      );
    },
    deleteTrackEntry(input) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "delete-entry",
          bvid: input.bvid,
          cid: input.cid,
          tier: input.tier,
          key: input.key
        },
        (response) => Boolean(response.ok),
        () => fallbackStore.deleteTrackEntry(input),
        "删除字幕缓存条目失败"
      );
    },
    pruneAsrVariants(args) {
      return callSubtitleStoreRpcOrFallback(
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
      );
    },
    clearTranslatedTracksForPage(args) {
      return callSubtitleStoreRpcOrFallback(
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
      );
    },

    getAiArtifact<TPayload = unknown>(key: string): Promise<AiArtifactRecord<TPayload> | null> {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "get-ai-artifact",
          key
        },
        (response) => (response.artifact ?? null) as AiArtifactRecord<TPayload> | null,
        () => fallbackStore.getAiArtifact<TPayload>(key),
        "读取 AI 产物缓存失败"
      );
    },
    getAiArtifactsMany<TPayload = unknown>(
      keys: string[]
    ): Promise<Array<AiArtifactRecord<TPayload> | null>> {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "get-ai-artifacts",
          keys
        },
        (response) =>
          (response.artifacts ?? keys.map(() => null)) as Array<AiArtifactRecord<TPayload> | null>,
        () => fallbackStore.getAiArtifactsMany<TPayload>(keys),
        "批量读取 AI 产物缓存失败"
      );
    },
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
      if (outcome.status === "handled") {
        return toRpcAiWriteResult(outcome.response, "写入 AI 产物缓存失败");
      }
      if (outcome.status === "error") {
        return {
          ok: false,
          evictedKeys: [],
          error: outcome.error
        };
      }
      return fallbackStore.putAiArtifact(input);
    },
    deleteAiArtifact(key) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "delete-ai-artifact",
          key
        },
        (response) => Boolean(response.deleted),
        () => fallbackStore.deleteAiArtifact(key),
        "删除 AI 产物缓存失败"
      );
    },
    listAiArtifactsByFamilyBvid(family, bvid, keyPrefix) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "list-ai-artifacts",
          family,
          bvid,
          ...(keyPrefix ? { keyPrefix } : {})
        },
        (response) =>
          (response.artifacts ?? []).filter((item): item is AiArtifactRecord => item !== null),
        () => fallbackStore.listAiArtifactsByFamilyBvid(family, bvid, keyPrefix),
        "列举 AI 产物缓存失败"
      );
    },
    listAiArtifactsByBvid(bvid) {
      return fallbackStore.listAiArtifactsByBvid(bvid);
    },
    listAllAiArtifacts() {
      return fallbackStore.listAllAiArtifacts();
    },
    clearVideo(bvid, cid) {
      return callSubtitleStoreRpcOrFallback(
        {
          type: "subtitle-cache",
          op: "clear-video",
          bvid,
          ...(cid ? { cid } : {})
        },
        (response) => ({
          removedPageIds: response.removedPageIds ?? [],
          removedArtifactKeys: response.removedArtifactKeys ?? []
        }),
        () => fallbackStore.clearVideo(bvid, cid),
        "清理视频缓存失败"
      );
    },

    async getChatImage(id) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "get-chat-image",
        id
      });
      if (outcome.status === "handled") {
        if (!outcome.response.ok) {
          throw new Error(outcome.response.error || "读取对话图片缓存失败");
        }
        return outcome.response.chatImage ?? null;
      }
      if (outcome.status === "error") {
        throw outcome.error;
      }
      return fallbackStore.getChatImage(id);
    },
    async getChatImagesMany(ids) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "get-chat-images",
        ids
      });
      if (outcome.status === "handled") {
        if (!outcome.response.ok) {
          throw new Error(outcome.response.error || "批量读取对话图片缓存失败");
        }
        return outcome.response.chatImages ?? ids.map(() => null);
      }
      if (outcome.status === "error") {
        throw outcome.error;
      }
      return fallbackStore.getChatImagesMany(ids);
    },
    async putChatImage(input) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "put-chat-image",
        chatImage: input
      });
      if (outcome.status === "handled") {
        return toRpcChatImageWriteResult(outcome.response, "写入对话图片缓存失败");
      }
      if (outcome.status === "error") {
        return {
          ok: false,
          evictedIds: [],
          error: outcome.error
        };
      }
      return fallbackStore.putChatImage(input);
    },
    async deleteChatImages(ids) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "delete-chat-images",
        ids
      });
      if (outcome.status === "handled") {
        return outcome.response.removedIds ?? [];
      }
      if (outcome.status === "error") {
        return [];
      }
      return fallbackStore.deleteChatImages(ids);
    },
    async deleteChatImagesByConversationIds(conversationIds) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "delete-chat-images-by-conversations",
        conversationIds
      });
      if (outcome.status === "handled") {
        return outcome.response.removedIds ?? [];
      }
      if (outcome.status === "error") {
        return [];
      }
      return fallbackStore.deleteChatImagesByConversationIds(conversationIds);
    },
    async pruneChatImages(input) {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "prune-chat-images",
        validConversationIds: [...input.validConversationIds],
        ...(input.keepImageIds ? { keepImageIds: [...input.keepImageIds] } : {})
      });
      if (outcome.status === "handled") {
        return outcome.response.removedIds ?? [];
      }
      if (outcome.status === "error") {
        return [];
      }
      return fallbackStore.pruneChatImages(input);
    },
    async clearAllChatImages() {
      const outcome = await sendSubtitleStoreRpcDetailed({
        type: "subtitle-cache",
        op: "clear-chat-images"
      });
      if (outcome.status === "handled") {
        return outcome.response.removedIds ?? [];
      }
      if (outcome.status === "error") {
        return [];
      }
      return fallbackStore.clearAllChatImages();
    },
    listChatImagesByConversationId(conversationId) {
      return fallbackStore.listChatImagesByConversationId(conversationId);
    },
    listAllChatImages() {
      return fallbackStore.listAllChatImages();
    },

    clearAll() {
      return fallbackStore.clearAll();
    },
    setWriteInterceptorForTests(interceptor) {
      fallbackStore.setWriteInterceptorForTests(interceptor);
    }
  };
}

const rpcSubtitleIdbStore = createSubtitleCacheRpcAdapter(defaultSubtitleIdbStore);

export function resolveDirectSubtitleStore(): SubtitleIdbStore {
  return storeOverrideForTests ?? defaultSubtitleIdbStore;
}

export function resolveActiveSubtitleStore(): SubtitleIdbStore {
  if (storeOverrideForTests) {
    return storeOverrideForTests;
  }
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
