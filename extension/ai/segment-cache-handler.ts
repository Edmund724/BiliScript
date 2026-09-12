// 段缓存 SW 端消息 handler（arch-review-2026-09/05）：storage 真实宿主是 SW，
// offscreen（Map-Reduce / 追问链）的段缓存读写经 runtime 消息落到此处，
// 直调 ./segment-cache.js 单源——键位装配（segmentCacheKeyFields → 族键）也在
// SW 完成，offscreen 侧不 import segment-cache（ladder chunk 不含 cache-lru）。
// handler 工厂形态照 core/provider-handlers.ts 的 withOkResponse 先例。

import { withOkResponse } from "../core/provider-handlers.js";
import {
  getSegmentSummaryKey,
  getRawSegmentKey,
  loadSegmentSummary,
  loadSegmentSummariesByKeys,
  saveSegmentSummary,
  saveRawSegments,
  loadStoredRawSegments,
  segmentCacheKeyFields
} from "./segment-cache.js";
import { retrieveRawSegments } from "./raw-retrieval.js";
import type { SegmentCacheMessage, SendResponse } from "../shared/messaging-protocol.js";

export function createSegmentCacheHandler(): (
  message: SegmentCacheMessage,
  sender: unknown,
  sendResponse: SendResponse
) => boolean {
  return function handleSegmentCache(
    message: SegmentCacheMessage,
    _sender: unknown,
    sendResponse: SendResponse
  ): boolean {
    withOkResponse(
      (async () => {
        const fields = segmentCacheKeyFields(message.context || {});
        if (message.op === "load-summary" || message.op === "save-summary") {
          const key = getSegmentSummaryKey({
            ...fields,
            segmentIndex: message.segmentIndex,
            budgetScale: message.budgetScale
          });
          if (message.op === "load-summary") {
            return { ok: true, summary: await loadSegmentSummary(key) };
          }
          const result = await saveSegmentSummary(key, String(message.summary ?? ""));
          return result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存小结写入失败") };
        }
        if (message.op === "load-summaries") {
          // 08 票批量读：N 段 1 次消息 + 1 次批量 storage.get（追问路径从 N 次往返降为常数级）
          const indexes = Array.isArray(message.segmentIndexes) ? message.segmentIndexes : [];
          const keys = indexes.map((segmentIndex) =>
            getSegmentSummaryKey({ ...fields, segmentIndex, budgetScale: message.budgetScale })
          );
          return { ok: true, summaries: await loadSegmentSummariesByKeys(keys) };
        }
        if (message.op === "save-raw") {
          const key = getRawSegmentKey({
            ...fields,
            segmentIndex: message.segmentIndex,
            budgetScale: message.budgetScale
          });
          const result = await saveRawSegments(key, Array.isArray(message.segments) ? message.segments : []);
          return result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存原始段写入失败") };
        }
        if (message.op === "load-stored-raw") {
          // String 归一与迁移前 followup-router 调用点的口径逐字一致
          const stored = await loadStoredRawSegments({
            bvid: String(fields.bvid || ""),
            cid: String(fields.cid || ""),
            subtitleId: String(fields.subtitleId || ""),
            subtitleUrl: String(fields.subtitleUrl || ""),
            lang: String(fields.lang || "")
          });
          // 08 票命中段预过滤：消费侧 retrieveRaw 只被调用一次且参数即 userPrompt，
          // SW 侧用同一 prompt + context.chapters 预过滤后，非命中段剥离 items 再过线
          // （整篇数 MB → 仅命中段过线）；段元数据（index/from/to）保留，消费侧重放
          // 检索结果逐字节一致。不带 prompt → 整篇回传（旧行为）。
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
        }
        throw new Error("不支持的段缓存操作：" + String((message as { op?: unknown }).op));
      })(),
      sendResponse
    );
    return true;
  };
}
