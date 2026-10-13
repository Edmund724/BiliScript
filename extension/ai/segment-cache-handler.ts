// 段缓存 SW 端消息 handler（arch-review-2026-09/05）：storage 真实宿主是 SW，
// offscreen（Map-Reduce / 追问链）的段缓存读写经 runtime 消息落到此处，
// 直调 ./segment-cache.js 单源——键位装配（segmentCacheKeyFields → 族键）也在
// SW 完成，offscreen 侧不 import segment-cache（ladder chunk 不含 cache-lru）。
// 本模块只有本族的声明（type / op 表 / 未知 op 文案）与六个 op 分支体；handler 壳与
// withOkResponse 信封单源在 core/storage-message-family.ts 的存储消息族工厂，
// 组合根只登记工厂实例。
// 键入口：每次读写都用 segment-cache.ts 的便捷形 buildSegmentSummaryCacheKey /
// buildRawSegmentCacheKey（吃 AI 上下文 + 段号 + 预算档，内部经键位叶投影），
// 字段清单与预算代后缀约定仍单源在那边，本模块不再手拼 {...字段, segmentIndex,
// budgetScale}。

import { defineStorageMessageFamily } from "../core/storage-message-family.js";
import {
  buildRawSegmentCacheKey,
  buildSegmentSummaryCacheKey,
  loadSegmentSummary,
  loadSegmentSummariesByKeys,
  saveSegmentSummary,
  saveRawSegments,
  saveSegmentSummaryWithRaw,
  loadStoredRawSegments,
  segmentCacheKeyFields
} from "./segment-cache.js";
import { retrieveRawSegments } from "./raw-retrieval.js";
import type { SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";

// 回包形参按本条消息收型（段缓存响应形状），返回 void——segment-cache 登记为
// async，回包时机归注册表 reply、入口 resolveReplyKeepOpen 兑现（此前的
// `: boolean` + `return true` 是死布尔，随 handler 面收型一并清掉）。
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
        // 08 票批量读：N 段 1 次消息 + 1 次批量 storage.get（追问路径从 N 次往返降为常数级）
        const indexes = Array.isArray(message.segmentIndexes) ? message.segmentIndexes : [];
        const keys = indexes.map((segmentIndex) =>
          buildSegmentSummaryCacheKey(message.context, segmentIndex, message.budgetScale)
        );
        return { ok: true, summaries: await loadSegmentSummariesByKeys(keys) };
      },
      "save-raw": async (message) => {
        const key = buildRawSegmentCacheKey(message.context, message.segmentIndex, message.budgetScale);
        const result = await saveRawSegments(key, Array.isArray(message.segments) ? message.segments : []);
        return result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存原始段写入失败") };
      },
      "save-summary-raw": async (message) => {
        // 写聚合（段缓存写聚合 ticket）：offscreen proxy 缓冲的 saveRaw 随
        // saveSummary 合成的合并 op——两族一次落盘（索引/清单打包一次 set，
        // 每段 1 get + 3 set）；键位装配与 budgetScale 归一仍在本单源完成。
        // per-op 结果粗粒度同果（bundle 写整体成败），保住失败可观测性。
        const summaryKey = buildSegmentSummaryCacheKey(message.context, message.segmentIndex, message.budgetScale);
        const rawKey = buildRawSegmentCacheKey(message.context, message.segmentIndex, message.budgetScale);
        const result = await saveSegmentSummaryWithRaw(
          summaryKey,
          String(message.summary ?? ""),
          rawKey,
          Array.isArray(message.segments) ? message.segments : []
        );
        const opResult = result.ok ? { ok: true } : { ok: false, error: String(result.error || "段缓存合并写入失败") };
        return { ok: result.ok, summarySaved: opResult, rawSaved: opResult };
      },
      "load-stored-raw": async (message) => {
        // String 归一与迁移前 followup-context 调用点的口径逐字一致
        const fields = segmentCacheKeyFields(message.context);
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
    }
  });
}
