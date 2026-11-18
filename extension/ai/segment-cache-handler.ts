// 段缓存 SW 端消息 handler：storage 真实宿主是 SW，
// offscreen（Map-Reduce / 追问链）的段缓存读写经 runtime 消息落到此处，
// 直调 ./segment-cache.js 单源——键位装配（segmentCacheKeyFields → 族键）也在
// SW 完成，offscreen 侧不 import segment-cache（ladder chunk 不含 cache-lru）。
// 本模块包含本族声明与 op 分支体；handler 壳与 withOkResponse 信封单源在
// core/storage-message-family.ts，组合根只登记工厂实例。

import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import {
  buildSegmentSummaryCacheKey,
  loadSegmentSummary,
  loadSegmentSummariesByKeys,
  saveSegmentSummary,
  loadStoredSegmentSummaries,
  loadStoredRawSegments,
  loadStoredL1Index,
  segmentCacheKeyStringFields
} from "./segment-cache.js";
import { retrieveRawSegments } from "./raw-retrieval.js";
import type { SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";

// 回包形参按本条消息收型（段缓存响应形状），返回 void——segment-cache 登记为
// async，回包时机归注册表 reply、入口 resolveReplyKeepOpen 兑现。
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
      "load-stored-raw": async (message) => {
        const stored = await loadStoredRawSegments(segmentCacheKeyStringFields(message.context));
        const prompt = typeof message.prompt === "string" ? message.prompt : "";
        if (!prompt.trim()) {
          return { ok: true, storedSegments: stored };
        }
        const hits = retrieveRawSegments({
          prompt,
          chapters: Array.isArray(message.context?.chapters) ? message.context.chapters : [],
          rawSegments: stored
        });
        const hitIndexes = new Set(hits.map((seg) => seg.index));
        return {
          ok: true,
          storedSegments: stored.map((seg) => (hitIndexes.has(seg.index) ? seg : { ...seg, items: [] }))
        };
      },
      "load-l1-index": async (message) => {
        const l1Index = await loadStoredL1Index(segmentCacheKeyStringFields(message.context));
        return { ok: true, l1Index };
      }
    }
  });
}
