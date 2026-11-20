// extension/subtitle/store-client.ts
// 扩展源 IndexedDB 仓库的传输桥接与活跃实例解析：
// - 内容脚本上下文（bilibili.com，http:/https:）严禁直连 indexedDB，统一经既有 `subtitle-cache` 消息族走 SW RPC；
// - Service Worker / 扩展页 / 单测环境直连本地 `SubtitleIdbStore`；
// - 轻量无 UI/state 依赖，供 subtitle/cache.ts 与 subtitle/ai-artifact-cache.ts 共享，避免 SW 静态图拖入 subtitle/cache.ts。

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
import type { SubtitleBodyItem } from "../ai/types.js";
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
      // ignore test reset errors
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

async function sendSubtitleStoreRpc(
  message: SubtitleCacheMessage
): Promise<SubtitleCacheResponse | null> {
  const outcome = await sendSubtitleStoreRpcDetailed(message);
  return outcome.status === "handled" ? outcome.response : null;
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
    async getPageRecord(bvid, cid) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-page",
        bvid,
        cid
      });
      return viaBg ? viaBg.page ?? null : fallbackStore.getPageRecord(bvid, cid);
    },
    listPageRecords() {
      return fallbackStore.listPageRecords();
    },
    async getRawTrack(bvid, cid, trackKey) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-raw",
        bvid,
        cid,
        trackKey
      });
      return viaBg ? viaBg.items ?? null : fallbackStore.getRawTrack(bvid, cid, trackKey);
    },
    async putRawTrack(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "put-raw",
        bvid: input.bvid,
        cid: input.cid,
        trackKey: input.trackKey,
        ...(input.lang ? { lang: input.lang } : {}),
        ...(input.kind ? { kind: input.kind } : {}),
        items: input.items as SubtitleBodyItem[]
      });
      return viaBg
        ? toRpcWriteResult(viaBg, "写入原生字幕缓存失败")
        : fallbackStore.putRawTrack(input);
    },
    async getSegmentedTrack(bvid, cid, trackKey, segmentationSig) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-segmented",
        bvid,
        cid,
        trackKey,
        segmentationSig
      });
      return viaBg
        ? viaBg.items ?? null
        : fallbackStore.getSegmentedTrack(bvid, cid, trackKey, segmentationSig);
    },
    async putSegmentedTrack(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "put-segmented",
        bvid: input.bvid,
        cid: input.cid,
        trackKey: input.trackKey,
        segmentationSig: input.segmentationSig,
        items: input.items as SubtitleBodyItem[]
      });
      return viaBg
        ? toRpcWriteResult(viaBg, "写入重断句缓存失败")
        : fallbackStore.putSegmentedTrack(input);
    },
    async getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-translated",
        bvid,
        cid,
        sourceTrackKey,
        targetLang,
        ...(translationSig ? { translationSig } : {})
      });
      return viaBg
        ? viaBg.items ?? null
        : fallbackStore.getTranslatedTrack(bvid, cid, sourceTrackKey, targetLang, translationSig);
    },
    async upsertTranslatedTrack(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "upsert-translated",
        bvid: input.bvid,
        cid: input.cid,
        sourceTrackKey: input.sourceTrackKey,
        targetLang: input.targetLang,
        translationSig: input.translationSig,
        ...(input.mode ? { mode: input.mode } : {}),
        items: input.items as SubtitleBodyItem[],
        ...(input.replaceRange ? { replaceRange: input.replaceRange } : {})
      });
      return viaBg
        ? toRpcWriteResult(viaBg, "写入译文缓存失败")
        : fallbackStore.upsertTranslatedTrack(input);
    },
    async deleteTrackEntry(input) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "delete-entry",
        bvid: input.bvid,
        cid: input.cid,
        tier: input.tier,
        key: input.key
      });
      return viaBg ? Boolean(viaBg.ok) : fallbackStore.deleteTrackEntry(input);
    },
    async pruneAsrVariants(args) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "prune-asr",
        bvid: args.bvid,
        cid: args.cid,
        ...(args.keepTrackKey !== undefined ? { keepTrackKey: args.keepTrackKey } : {})
      });
      return viaBg ? viaBg.removedKeys ?? [] : fallbackStore.pruneAsrVariants(args);
    },
    async clearTranslatedTracksForPage(args) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "clear-translated",
        bvid: args.bvid,
        cid: args.cid,
        ...(args.sourceTrackKey ? { sourceTrackKey: args.sourceTrackKey } : {})
      });
      return viaBg ? viaBg.removedKeys ?? [] : fallbackStore.clearTranslatedTracksForPage(args);
    },

    async getAiArtifact<TPayload = unknown>(key: string): Promise<AiArtifactRecord<TPayload> | null> {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-ai-artifact",
        key
      });
      return viaBg
        ? ((viaBg.artifact ?? null) as AiArtifactRecord<TPayload> | null)
        : fallbackStore.getAiArtifact<TPayload>(key);
    },
    async getAiArtifactsMany<TPayload = unknown>(
      keys: string[]
    ): Promise<Array<AiArtifactRecord<TPayload> | null>> {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "get-ai-artifacts",
        keys
      });
      return viaBg
        ? ((viaBg.artifacts ?? keys.map(() => null)) as Array<AiArtifactRecord<TPayload> | null>)
        : fallbackStore.getAiArtifactsMany<TPayload>(keys);
    },
    async putAiArtifact(input) {
      const viaBg = await sendSubtitleStoreRpc({
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
      return viaBg
        ? toRpcAiWriteResult(viaBg, "写入 AI 产物缓存失败")
        : fallbackStore.putAiArtifact(input);
    },
    async deleteAiArtifact(key) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "delete-ai-artifact",
        key
      });
      return viaBg ? Boolean(viaBg.deleted) : fallbackStore.deleteAiArtifact(key);
    },
    async listAiArtifactsByFamilyBvid(family, bvid, keyPrefix) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "list-ai-artifacts",
        family,
        bvid,
        ...(keyPrefix ? { keyPrefix } : {})
      });
      if (viaBg) {
        return (viaBg.artifacts ?? []).filter((item): item is AiArtifactRecord => item !== null);
      }
      return fallbackStore.listAiArtifactsByFamilyBvid(family, bvid, keyPrefix);
    },
    listAiArtifactsByBvid(bvid) {
      return fallbackStore.listAiArtifactsByBvid(bvid);
    },
    listAllAiArtifacts() {
      return fallbackStore.listAllAiArtifacts();
    },
    async clearVideo(bvid, cid) {
      const viaBg = await sendSubtitleStoreRpc({
        type: "subtitle-cache",
        op: "clear-video",
        bvid,
        ...(cid ? { cid } : {})
      });
      if (viaBg) {
        return {
          removedPageIds: viaBg.removedPageIds ?? [],
          removedArtifactKeys: viaBg.removedArtifactKeys ?? []
        };
      }
      return fallbackStore.clearVideo(bvid, cid);
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

// ===== 视频级内存缓存联动清理钩子（避免 subtitle/cache 与 ai/l1-chapter-index 循环依赖）=====

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
      // 内存清理钩子异常不阻断后续 IDB / legacy 清理
    }
  }
}
