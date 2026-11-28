import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import { defaultSubtitleIdbStore, type SubtitleIdbStore } from "../subtitle/idb-store.js";
import {
  buildSegmentSummaryCacheKey,
  loadSegmentSummary,
  loadSegmentSummariesByKeys,
  saveSegmentSummary,
  loadStoredSegmentSummaries,
  loadStoredL1Index,
  segmentCacheKeyStringFields
} from "./segment-cache.js";
import type { SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";

export interface SegmentCacheHandlerOptions {
  store?: SubtitleIdbStore;
  resolveVideoCacheMaxBytes?: () => Promise<number>;
}

export function createSegmentCacheHandler(
  options: SegmentCacheHandlerOptions = {}
): (
  message: SegmentCacheMessage,
  sender: unknown,
  sendResponse: (response: SegmentCacheResponse) => void
) => void {
  const store = options.store ?? defaultSubtitleIdbStore;
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

  return defineStorageMessageFamily<SegmentCacheMessage, SegmentCacheResponse>({
    type: "segment-cache",
    unknownOpText: "不支持的段缓存操作：",
    ops: {
      "load-summary": async (message) => {
        const key = buildSegmentSummaryCacheKey(message.context, message.segmentIndex, message.budgetScale);
        return { ok: true, summary: await loadSegmentSummary(key) };
      },
      "save-summary": async (message) => {
        await ensureVideoCacheMaxBytesSynced();
        const fields = segmentCacheKeyStringFields(message.context);
        const key = buildSegmentSummaryCacheKey(message.context, message.segmentIndex, message.budgetScale);
        const result = await saveSegmentSummary(key, String(message.summary ?? ""), {
          bvid: fields.bvid,
          cid: fields.cid,
          site: message.context?.site
        });
        return result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存小结写入失败") };
      },
      "load-summaries": async (message) => {
        const indexes = Array.isArray(message.segmentIndexes) ? message.segmentIndexes : [];
        const keys = indexes.map((segmentIndex) =>
          buildSegmentSummaryCacheKey(message.context, segmentIndex, message.budgetScale)
        );
        return { ok: true, summaries: await loadSegmentSummariesByKeys(keys) };
      },
      "load-stored-summaries": async (message) => {
        const summaries = await loadStoredSegmentSummaries({
          ...segmentCacheKeyStringFields(message.context),
          site: message.context?.site,
          budgetScale: message.budgetScale
        });
        return { ok: true, summaries };
      },
      "load-l1-index": async (message) => {
        const l1Index = await loadStoredL1Index({
          ...segmentCacheKeyStringFields(message.context),
          site: message.context?.site
        });
        return { ok: true, l1Index };
      }
    }
  });
}
