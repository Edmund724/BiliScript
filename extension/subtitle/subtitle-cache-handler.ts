import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import {
  defaultSubtitleIdbStore,
  isAiArtifactFamily,
  type SubtitleIdbStore
} from "./idb-store.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../shared/messaging-protocol.js";

export interface SubtitleCacheHandlerOptions {
  resolveVideoCacheMaxBytes?: () => Promise<number>;
}

const str = (v: unknown): string => String(v || "");
const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const ok = (extra: Omit<SubtitleCacheResponse, "ok" | "handled"> = {}): SubtitleCacheResponse => ({
  ok: true,
  handled: true,
  ...extra
});
const fail = (error: string): SubtitleCacheResponse => ({ ok: false, handled: true, error });

export function createSubtitleCacheHandler(
  store: SubtitleIdbStore = defaultSubtitleIdbStore,
  options: SubtitleCacheHandlerOptions = {}
): (
  message: SubtitleCacheMessage,
  sender: unknown,
  sendResponse: (response: SubtitleCacheResponse) => void
) => void {
  let maxBytesSynced = false;
  let syncMaxBytesPromise: Promise<void> | null = null;

  async function ensureVideoCacheMaxBytesSynced(): Promise<void> {
    if (maxBytesSynced || typeof options.resolveVideoCacheMaxBytes !== "function") return;
    if (!syncMaxBytesPromise) {
      syncMaxBytesPromise = (async () => {
        try {
          const bytes = await options.resolveVideoCacheMaxBytes!();
          if (Number.isFinite(bytes) && bytes > 0) store.syncVideoCacheMaxBytes(bytes);
          maxBytesSynced = true;
        } catch {
        } finally {
          syncMaxBytesPromise = null;
        }
      })();
    }
    await syncMaxBytesPromise;
  }

  return defineStorageMessageFamily<SubtitleCacheMessage, SubtitleCacheResponse>({
    type: "subtitle-cache",
    unknownOpText: "不支持的字幕缓存操作：",
    ops: {
      "get-page": async (m) => ok({ page: await store.getPageRecord(str(m.bvid), str(m.cid)) }),
      "get-raw": async (m) => ok({ items: await store.getRawTrack(str(m.bvid), str(m.cid), str(m.trackKey)) }),
      "put-raw": async (m) => {
        await ensureVideoCacheMaxBytesSynced();
        const res = await store.putRawTrack({
          bvid: str(m.bvid),
          cid: str(m.cid),
          trackKey: str(m.trackKey),
          ...(m.lang ? { lang: m.lang } : {}),
          ...(m.kind ? { kind: m.kind } : {}),
          items: arr(m.items)
        });
        return res.ok ? ok({ evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }) : fail(res.error?.message || "写入原生字幕缓存失败");
      },
      "get-segmented": async (m) =>
        ok({ items: await store.getSegmentedTrack(str(m.bvid), str(m.cid), str(m.trackKey), str(m.segmentationSig)) }),
      "put-segmented": async (m) => {
        await ensureVideoCacheMaxBytesSynced();
        const res = await store.putSegmentedTrack({
          bvid: str(m.bvid),
          cid: str(m.cid),
          trackKey: str(m.trackKey),
          segmentationSig: str(m.segmentationSig),
          items: arr(m.items)
        });
        return res.ok ? ok({ evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }) : fail(res.error?.message || "写入重断句缓存失败");
      },
      "get-translated": async (m) =>
        ok({ items: await store.getTranslatedTrack(str(m.bvid), str(m.cid), str(m.sourceTrackKey), str(m.targetLang), m.translationSig) }),
      "upsert-translated": async (m) => {
        await ensureVideoCacheMaxBytesSynced();
        const res = await store.upsertTranslatedTrack({
          bvid: str(m.bvid),
          cid: str(m.cid),
          sourceTrackKey: str(m.sourceTrackKey),
          targetLang: str(m.targetLang),
          translationSig: str(m.translationSig),
          ...(m.mode ? { mode: m.mode } : {}),
          items: arr(m.items),
          ...(m.replaceRange ? { replaceRange: m.replaceRange } : {})
        });
        return res.ok ? ok({ evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }) : fail(res.error?.message || "写入译文缓存失败");
      },
      "delete-entry": async (m) => {
        await store.deleteTrackEntry({ bvid: str(m.bvid), cid: str(m.cid), tier: m.tier || "rawTracks", key: str(m.key) });
        return ok();
      },
      "prune-asr": async (m) => ok({ removedKeys: await store.pruneAsrVariants({ bvid: str(m.bvid), cid: str(m.cid), keepTrackKey: m.keepTrackKey }) }),
      "clear-translated": async (m) =>
        ok({ removedKeys: await store.clearTranslatedTracksForPage({ bvid: str(m.bvid), cid: str(m.cid), sourceTrackKey: m.sourceTrackKey }) }),
      "get-ai-artifact": async (m) => ok({ artifact: await store.getAiArtifact(str(m.key)) }),
      "get-ai-artifacts": async (m) => ok({ artifacts: await store.getAiArtifactsMany(arr(m.keys)) }),
      "put-ai-artifact": async (m) => {
        await ensureVideoCacheMaxBytesSynced();
        const res = await store.putAiArtifact({
          key: str(m.key),
          ...(isAiArtifactFamily(m.family) ? { family: m.family } : {}),
          ...(m.bvid !== undefined ? { bvid: String(m.bvid) } : {}),
          ...(m.cid !== undefined ? { cid: String(m.cid) } : {}),
          payload: m.payload,
          ...(m.createdAt !== undefined ? { createdAt: m.createdAt } : {}),
          ...(m.updatedAt !== undefined ? { updatedAt: m.updatedAt } : {}),
          ...(m.lastUsedAt !== undefined ? { lastUsedAt: m.lastUsedAt } : {})
        });
        return res.ok ? ok({ evictedKeys: res.evictedKeys, estimatedBytes: res.estimatedBytes }) : fail(res.error?.message || "写入 AI 产物缓存失败");
      },
      "delete-ai-artifact": async (m) => ok({ deleted: await store.deleteAiArtifact(str(m.key)) }),
      "list-ai-artifacts": async (m) =>
        ok({
          artifacts: isAiArtifactFamily(m.family)
            ? await store.listAiArtifactsByFamilyBvid(m.family, str(m.bvid), m.keyPrefix ? String(m.keyPrefix) : "")
            : []
        }),
      "clear-video": async (m) => {
        const res = await store.clearVideo(str(m.bvid), m.cid !== undefined && m.cid !== "" ? String(m.cid) : undefined);
        return ok({ removedPageIds: res.removedPageIds, removedArtifactKeys: res.removedArtifactKeys });
      },
      "get-chat-image": async (m) => ok({ chatImage: await store.getChatImage(str(m.id)) }),
      "get-chat-images": async (m) => ok({ chatImages: await store.getChatImagesMany(arr(m.ids)) }),
      "put-chat-image": async (m) => {
        const input = m.chatImage;
        if (!input || typeof input !== "object") return fail("缺少对话图片写入参数");
        const res = await store.putChatImage({
          id: str(input.id),
          conversationId: str(input.conversationId),
          ...(input.bvid !== undefined ? { bvid: String(input.bvid) } : {}),
          ...(input.cid !== undefined ? { cid: String(input.cid) } : {}),
          ...(input.site !== undefined ? { site: input.site } : {}),
          mime: typeof input.mime === "string" ? input.mime : "",
          data: typeof input.data === "string" ? input.data : "",
          ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
          ...(input.updatedAt !== undefined ? { updatedAt: input.updatedAt } : {}),
          ...(input.lastUsedAt !== undefined ? { lastUsedAt: input.lastUsedAt } : {})
        });
        return res.ok ? ok({ evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }) : fail(res.error?.message || "写入对话图片缓存失败");
      },
      "delete-chat-images": async (m) => ok({ removedIds: await store.deleteChatImages(arr(m.ids)) }),
      "delete-chat-images-by-conversations": async (m) => ok({ removedIds: await store.deleteChatImagesByConversationIds(arr(m.conversationIds)) }),
      "prune-chat-images": async (m) =>
        ok({
          removedIds: await store.pruneChatImages({
            validConversationIds: arr(m.validConversationIds),
            ...(Array.isArray(m.keepImageIds) ? { keepImageIds: m.keepImageIds } : {})
          })
        }),
      "clear-chat-images": async () => ok({ removedIds: await store.clearAllChatImages() }),
      "get-video-cache-usage": async () => {
        await ensureVideoCacheMaxBytesSynced();
        return ok({ usage: await store.getVideoCacheUsage() });
      },
      "set-video-cache-limit": async (m) => {
        const maxBytes = Number(m.maxBytes);
        if (!Number.isFinite(maxBytes) || maxBytes <= 0) return fail("无效的缓存上限参数");
        maxBytesSynced = true;
        const res = await store.setVideoCacheMaxBytes(maxBytes);
        return ok({ evictedPageIds: res.evictedPageIds, evictedKeys: res.evictedArtifactKeys, usage: res.usage });
      },
      "get-conversation": async (m) => ok({ conversation: await store.getConversation(str(m.id)) }),
      "list-conversations": async () => ok({ conversations: await store.listConversations() }),
      "count-conversations": async () => ok({ count: await store.countConversations() }),
      "put-conversation": async (m) => {
        if (!m.conversation || typeof m.conversation !== "object") return fail("缺少对话写入参数");
        await store.putConversation(m.conversation);
        return ok();
      },
      "put-conversations": async (m) => {
        await store.putConversationsMany(arr(m.conversations));
        return ok();
      },
      "delete-conversations": async (m) => ok({ removedIds: await store.deleteConversations(arr(m.ids)) }),
      "clear-conversations": async () => ok({ removedIds: await store.clearAllConversations() }),
      "prune-conversations": async (m) => {
        const res = await store.pruneConversationsToLimit(Number(m.maxCount ?? 0));
        return ok({ removedIds: res.removedIds, keptCount: res.keptCount });
      }
    }
  });
}
