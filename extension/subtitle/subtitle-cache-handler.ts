// 字幕与 AI 产物分层 IndexedDB 仓库的 SW 端消息 handler：
// 页面内容脚本无扩展源 IndexedDB 访问权限（按页面 origin 隔离会无法与 SW/agent-bridge 共享），
// 故经本消息族在扩展源（Service Worker）读写 `biliscript-subtitle-store`（subtitle_pages + ai_artifacts）。

import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import {
  defaultSubtitleIdbStore,
  isAiArtifactFamily,
  type SubtitleIdbStore
} from "./idb-store.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../shared/messaging-protocol.js";

export function createSubtitleCacheHandler(
  store: SubtitleIdbStore = defaultSubtitleIdbStore
): (
  message: SubtitleCacheMessage,
  sender: unknown,
  sendResponse: (response: SubtitleCacheResponse) => void
) => void {
  return defineStorageMessageFamily<SubtitleCacheMessage, SubtitleCacheResponse>({
    type: "subtitle-cache",
    unknownOpText: "不支持的字幕缓存操作：",
    ops: {
      "get-page": async (message) => ({
        ok: true,
        handled: true,
        page: await store.getPageRecord(String(message.bvid || ""), String(message.cid || ""))
      }),
      "get-raw": async (message) => ({
        ok: true,
        handled: true,
        items: await store.getRawTrack(
          String(message.bvid || ""),
          String(message.cid || ""),
          String(message.trackKey || "")
        )
      }),
      "put-raw": async (message) => {
        const res = await store.putRawTrack({
          bvid: String(message.bvid || ""),
          cid: String(message.cid || ""),
          trackKey: String(message.trackKey || ""),
          ...(message.lang ? { lang: message.lang } : {}),
          ...(message.kind ? { kind: message.kind } : {}),
          items: Array.isArray(message.items) ? message.items : []
        });
        return res.ok
          ? { ok: true, handled: true, evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }
          : { ok: false, handled: true, error: res.error?.message || "写入原生字幕缓存失败" };
      },
      "get-segmented": async (message) => ({
        ok: true,
        handled: true,
        items: await store.getSegmentedTrack(
          String(message.bvid || ""),
          String(message.cid || ""),
          String(message.trackKey || ""),
          String(message.segmentationSig || "")
        )
      }),
      "put-segmented": async (message) => {
        const res = await store.putSegmentedTrack({
          bvid: String(message.bvid || ""),
          cid: String(message.cid || ""),
          trackKey: String(message.trackKey || ""),
          segmentationSig: String(message.segmentationSig || ""),
          items: Array.isArray(message.items) ? message.items : []
        });
        return res.ok
          ? { ok: true, handled: true, evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }
          : { ok: false, handled: true, error: res.error?.message || "写入重断句缓存失败" };
      },
      "get-translated": async (message) => ({
        ok: true,
        handled: true,
        items: await store.getTranslatedTrack(
          String(message.bvid || ""),
          String(message.cid || ""),
          String(message.sourceTrackKey || ""),
          String(message.targetLang || ""),
          message.translationSig
        )
      }),
      "upsert-translated": async (message) => {
        const res = await store.upsertTranslatedTrack({
          bvid: String(message.bvid || ""),
          cid: String(message.cid || ""),
          sourceTrackKey: String(message.sourceTrackKey || ""),
          targetLang: String(message.targetLang || ""),
          translationSig: String(message.translationSig || ""),
          ...(message.mode ? { mode: message.mode } : {}),
          items: Array.isArray(message.items) ? message.items : [],
          ...(message.replaceRange ? { replaceRange: message.replaceRange } : {})
        });
        return res.ok
          ? { ok: true, handled: true, evictedIds: res.evictedIds, estimatedBytes: res.estimatedBytes }
          : { ok: false, handled: true, error: res.error?.message || "写入译文缓存失败" };
      },
      "delete-entry": async (message) => {
        await store.deleteTrackEntry({
          bvid: String(message.bvid || ""),
          cid: String(message.cid || ""),
          tier: message.tier || "rawTracks",
          key: String(message.key || "")
        });
        return { ok: true, handled: true };
      },
      "prune-asr": async (message) => ({
        ok: true,
        handled: true,
        removedKeys: await store.pruneAsrVariants({
          bvid: String(message.bvid || ""),
          cid: String(message.cid || ""),
          keepTrackKey: message.keepTrackKey
        })
      }),
      "clear-translated": async (message) => ({
        ok: true,
        handled: true,
        removedKeys: await store.clearTranslatedTracksForPage({
          bvid: String(message.bvid || ""),
          cid: String(message.cid || ""),
          sourceTrackKey: message.sourceTrackKey
        })
      }),
      "get-ai-artifact": async (message) => ({
        ok: true,
        handled: true,
        artifact: await store.getAiArtifact(String(message.key || ""))
      }),
      "get-ai-artifacts": async (message) => ({
        ok: true,
        handled: true,
        artifacts: await store.getAiArtifactsMany(Array.isArray(message.keys) ? message.keys : [])
      }),
      "put-ai-artifact": async (message) => {
        const res = await store.putAiArtifact({
          key: String(message.key || ""),
          ...(isAiArtifactFamily(message.family) ? { family: message.family } : {}),
          ...(message.bvid !== undefined ? { bvid: String(message.bvid) } : {}),
          ...(message.cid !== undefined ? { cid: String(message.cid) } : {}),
          payload: message.payload,
          ...(message.createdAt !== undefined ? { createdAt: message.createdAt } : {}),
          ...(message.updatedAt !== undefined ? { updatedAt: message.updatedAt } : {}),
          ...(message.lastUsedAt !== undefined ? { lastUsedAt: message.lastUsedAt } : {})
        });
        return res.ok
          ? { ok: true, handled: true, evictedKeys: res.evictedKeys, estimatedBytes: res.estimatedBytes }
          : { ok: false, handled: true, error: res.error?.message || "写入 AI 产物缓存失败" };
      },
      "delete-ai-artifact": async (message) => ({
        ok: true,
        handled: true,
        deleted: await store.deleteAiArtifact(String(message.key || ""))
      }),
      "list-ai-artifacts": async (message) => {
        if (!isAiArtifactFamily(message.family)) {
          return { ok: true, handled: true, artifacts: [] };
        }
        const artifacts = await store.listAiArtifactsByFamilyBvid(
          message.family,
          String(message.bvid || ""),
          message.keyPrefix ? String(message.keyPrefix) : ""
        );
        return { ok: true, handled: true, artifacts };
      },
      "clear-video": async (message) => {
        const res = await store.clearVideo(
          String(message.bvid || ""),
          message.cid !== undefined && message.cid !== "" ? String(message.cid) : undefined
        );
        return {
          ok: true,
          handled: true,
          removedPageIds: res.removedPageIds,
          removedArtifactKeys: res.removedArtifactKeys
        };
      }
    }
  });
}
