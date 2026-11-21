import { defineStorageMessageFamily } from "../core/storage-message-family.js";
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

export function createSegmentCacheHandler(): (
  message: SegmentCacheMessage,
  sender: unknown,
  sendResponse: (response: SegmentCacheResponse) => void
) => void {
  return defineStorageMessageFamily<SegmentCacheMessage, SegmentCacheResponse>({
    type: "segment-cache",
    unknownOpText: "不支持的段缓存操作：",
    ops: {
      "load-summary": async (message) => {
        const key = buildSegmentSummaryCacheKey(message.context, message.segmentIndex, message.budgetScale);
        return { ok: true, summary: await loadSegmentSummary(key) };
      },
      "save-summary": async (message) => {
        const key = buildSegmentSummaryCacheKey(message.context, message.segmentIndex, message.budgetScale);
        const result = await saveSegmentSummary(key, String(message.summary ?? ""));
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
          budgetScale: message.budgetScale
        });
        return { ok: true, summaries };
      },
      "load-l1-index": async (message) => {
        const l1Index = await loadStoredL1Index(segmentCacheKeyStringFields(message.context));
        return { ok: true, l1Index };
      }
    }
  });
}
