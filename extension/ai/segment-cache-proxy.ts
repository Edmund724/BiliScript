// 段缓存消息代理（arch-review-2026-09/05）：段缓存宿主是 SW（storage 所在），
// offscreen 的 Map-Reduce / 追问链经 runtime 消息调用（SW 端 handler 见
// ./segment-cache-handler.js，键位装配在 SW 的 segment-cache 单源完成）。
// 本模块是 offscreen 侧唯一出站点；容错口径与直连 segment-cache 一致——
// 读失败/无回执按未命中（null / []），写失败以 { ok:false } 上浮，全程不抛。
//
// 写聚合（段缓存写聚合 ticket）：本模块从纯直通变有状态——saveRaw 不再立即
// 发消息，而是按 (context, segmentIndex, budgetScale) 键缓冲同段原始段；
// 紧随其后的 saveSummary 命中缓冲时合成一条 save-summary-raw 合并 op
// （Map-Reduce 未命中段写路径 3N→2N）。缓冲是内存态、随 offscreen 文档生灭：
// port 断开 / offscreen 自关即丢弃（与今天 saveRaw 静默失败同量级）；abort /
// 异常路径由宿主调 flushSegmentCacheRawBuffer 把残留缓冲按 save-raw 逐个
// 发出，保住「用户主动停止」主场景的跨会话复用。

import type { SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";

export interface SegmentCacheOps {
  loadSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown }): Promise<string | null>;
  // 08 票批量读：一次消息取 N 段小结（与 segmentIndexes 按序对齐，未命中为 null）
  loadSummaries(input: { context?: Record<string, unknown>; segmentIndexes?: Array<number | string>; budgetScale?: unknown }): Promise<(string | null)[]>;
  saveSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; summary: string }): Promise<{ ok: boolean; error?: unknown }>;
  saveRaw(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; segments: unknown[] }): Promise<{ ok: boolean; error?: unknown }>;
  // userPrompt 非空时 SW 侧预过滤，只回传命中段的 items（08 票）；缺省整篇回传
  loadStoredRaw(input: { context?: Record<string, unknown>; userPrompt?: unknown }): Promise<unknown[]>;
}

async function segmentCacheRequest(
  op: SegmentCacheMessage["op"],
  payload: Omit<SegmentCacheMessage, "type" | "op">
): Promise<SegmentCacheResponse> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: "segment-cache", op, ...payload })) as
      | SegmentCacheResponse
      | undefined;
    return response || { ok: false, error: "段缓存消息无回执" };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// 缓冲键：context 全量序列化 + 段序号 + 预算档。并发池内同段只会缓冲一条
// （map-reduce 每段一次 saveRaw），同键后写覆盖先写（内容同源同段，等价）。
function rawBufferKey(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown }): string {
  return JSON.stringify([input.context ?? {}, String(input.segmentIndex ?? ""), String(input.budgetScale ?? "")]);
}

interface BufferedRawSave {
  context?: Record<string, unknown>;
  segmentIndex?: number | string;
  budgetScale?: unknown;
  segments: unknown[];
}

// 同段 saveRaw 缓冲表（模块级、随文档生灭；port 断开 / offscreen 自关即丢弃）。
const bufferedRawSaves = new Map<string, BufferedRawSave>();

// 合并写回包的 per-op 结果汇入单一口径：任一失败 → { ok:false, error }（与单族
// 写失败同一可观测通道，编排层去重后只提示一次）。
function mergedSaveResult(response: SegmentCacheResponse): { ok: boolean; error?: unknown } {
  if (!response.ok) {
    const failed = [response.summarySaved, response.rawSaved].find((r) => r && r.ok === false);
    return { ok: false, error: failed?.error || response.error };
  }
  return { ok: true };
}

export const segmentCacheProxy: SegmentCacheOps = {
  async loadSummary({ context, segmentIndex, budgetScale }) {
    const response = await segmentCacheRequest("load-summary", { context, segmentIndex, budgetScale });
    if (!response.ok) {
      return null;
    }
    return typeof response.summary === "string" ? response.summary : null;
  },
  async loadSummaries({ context, segmentIndexes, budgetScale }) {
    const response = await segmentCacheRequest("load-summaries", { context, segmentIndexes, budgetScale });
    if (!response.ok || !Array.isArray(response.summaries)) {
      return [];
    }
    return response.summaries;
  },
  async saveSummary({ context, segmentIndex, budgetScale, summary }) {
    const bufferKey = rawBufferKey({ context, segmentIndex, budgetScale });
    const buffered = bufferedRawSaves.get(bufferKey);
    if (!buffered) {
      const response = await segmentCacheRequest("save-summary", { context, segmentIndex, budgetScale, summary });
      return response.ok ? { ok: true } : { ok: false, error: response.error };
    }
    // 命中缓冲：合成 save-summary-raw 合并 op（两族一次落盘）。仅在发送成功后
    // 才消费缓冲——失败时保留，abort/异常路径的 flush 会按 save-raw 补落，
    // 把丢失口径收窄到 offscreen 崩溃一档（spec Q2）。
    const response = await segmentCacheRequest("save-summary-raw", {
      context,
      segmentIndex,
      budgetScale,
      summary,
      segments: buffered.segments
    });
    if (response.ok) {
      bufferedRawSaves.delete(bufferKey);
      return { ok: true };
    }
    return mergedSaveResult(response);
  },
  async saveRaw({ context, segmentIndex, budgetScale, segments }) {
    // 落盘时点推迟：缓冲在内存，随 saveSummary 合并发出；abort/异常路径经
    // flushSegmentCacheRawBuffer 落盘，offscreen 崩溃丢失（与今天 saveRaw
    // 静默失败同量级，追问时多一次模型调用）。
    bufferedRawSaves.set(rawBufferKey({ context, segmentIndex, budgetScale }), {
      context,
      segmentIndex,
      budgetScale,
      segments: Array.isArray(segments) ? segments : []
    });
    return { ok: true };
  },
  async loadStoredRaw({ context, userPrompt }) {
    const prompt = typeof userPrompt === "string" && userPrompt.trim() ? userPrompt : undefined;
    const response = await segmentCacheRequest("load-stored-raw", { context, prompt });
    if (!response.ok || !Array.isArray(response.storedSegments)) {
      return [];
    }
    return response.storedSegments;
  }
};

/**
 * abort / 异常路径的缓冲落盘（宿主在 offscreen 停止/超时/出错时调用）：
 * 残留缓冲按 save-raw 逐个 fire-and-forget 发出并清空。失败静默（缓冲仍清空，
 * 不重试——与今天 saveRaw fire-and-forget 失败同口径）；全程不抛，不阻断 abort 收束。
 */
export async function flushSegmentCacheRawBuffer(): Promise<void> {
  const pending = [...bufferedRawSaves.values()];
  bufferedRawSaves.clear();
  for (const buffered of pending) {
    try {
      await segmentCacheRequest("save-raw", {
        context: buffered.context,
        segmentIndex: buffered.segmentIndex,
        budgetScale: buffered.budgetScale,
        segments: buffered.segments
      });
    } catch {
      // 单条 flush 失败静默（sendMessage 已内层兜成 { ok:false }，此处双保险）
    }
  }
}
