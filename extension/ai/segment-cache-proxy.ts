// 段缓存消息代理（arch-review-2026-09/05）：段缓存宿主是 SW（storage 所在），
// offscreen 的 Map-Reduce / 追问链经 runtime 消息调用（SW 端 handler 见
// ./segment-cache-handler.js，键位装配在 SW 的 segment-cache 单源完成）。
// 本模块是 offscreen 侧唯一出站点；容错口径与直连 segment-cache 一致——
// 读失败/无回执按未命中（null / []），saveSummary 写失败以 { ok:false } 上浮，
// 全程不抛。
//
// 写单元 run-scoped（段缓存写聚合 ticket 重构）：写路径由 createSegmentCacheWriteSession
// 产出的会话承担——会话自有缓冲（不再有模块级 Map），saveRaw 同步入缓冲、不做
// per-op 成败声明；saveSummary 命中缓冲时合成一条 save-summary-raw 合并 op
//（Map-Reduce 未命中段写路径 3N→2N），未命中则直通 save-summary；close() 把残留
// 缓冲按 save-raw 逐条 await 落盘，失败经 onWriteError 上浮（不抛）。会话随运行
// 生灭：由编排层在本次运行的收尾统一 close；port 断开 / offscreen 自关不 close
//（会话随文档销毁废弃，丢弃语义显式化）。
//
// 出站点收窄：所有消息载荷的 context 都是「AiContext → SW 键位字段」投影后的窄
// 对象（字段清单与 SW 端 segment-cache.ts 的 segmentCacheKeyFields 同源；本模块
// 不 import storage 层，清单就地写并注明口径同源），整份 AiContext（含 ≥200k 字符
// 的 subtitleBody）不再过线。

import type { SegmentCacheContext, SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";

export interface SegmentCacheOps {
  loadSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown }): Promise<string | null>;
  // 08 票批量读：一次消息取 N 段小结（与 segmentIndexes 按序对齐，未命中为 null）
  loadSummaries(input: { context?: Record<string, unknown>; segmentIndexes?: Array<number | string>; budgetScale?: unknown }): Promise<(string | null)[]>;
  saveSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; summary: string }): Promise<{ ok: boolean; error?: unknown }>;
  // 出站点如实声明：saveRaw 只把同段原始段放进写会话缓冲，不发消息、不做 per-op
  // 成败声明（落盘统一在会话 close；命中 saveSummary 时由合并 op 一并写入）。
  saveRaw(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; segments: unknown[] }): void;
  // userPrompt 非空时 SW 侧预过滤，只回传命中段的 items（08 票）；缺省整篇回传
  loadStoredRaw(input: { context?: Record<string, unknown>; userPrompt?: unknown }): Promise<unknown[]>;
}

// 读半边（追问链只读）：写路径全部走 run-scoped 写会话，proxy 不再暴露写 op。
export type SegmentCacheReadOps = Pick<SegmentCacheOps, "loadSummary" | "loadSummaries" | "loadStoredRaw">;

// run-scoped 写会话：读三 op 与 proxy 同路径直通；写两 op 由会话缓冲承接，
// close 是残留缓冲的唯一落盘点（等待全部发送结算）。
export interface SegmentCacheWriteSession extends SegmentCacheOps {
  close(): Promise<void>;
}

// context 投影：AiContext → SW 键位字段（bvid/cid + 字幕轨三元组）。字段名与 SW
// 端 segment-cache.ts 的 segmentCacheKeyFields 消费的上下文字段同源（那边把
// selectedSubtitleId/Url/subtitleLang 映射为键位入参 subtitleId/subtitleUrl/lang），
// 键位口径仍由 SW 单源装配，本模块只负责把无关字段（title/subtitleBody/…）挡在
// 传输层之外。键位字段恒在（与 segmentCacheKeyFields 同形），值缺失即 undefined。
function projectSegmentCacheContext(context?: Record<string, unknown> | null): SegmentCacheContext {
  if (!context) {
    return {
      bvid: undefined,
      cid: undefined,
      selectedSubtitleId: undefined,
      selectedSubtitleUrl: undefined,
      subtitleLang: undefined
    };
  }
  return {
    bvid: context.bvid,
    cid: context.cid,
    selectedSubtitleId: context.selectedSubtitleId,
    selectedSubtitleUrl: context.selectedSubtitleUrl,
    subtitleLang: context.subtitleLang
  };
}

// 读 op（load-stored-raw）的命中段预过滤在 SW 侧走同一检索规则的章节名档
// （retrieveRawSegments 的 chapters 入参）：该档读路径的既有输入，收窄时保留，
// 读行为与迁移前逐字一致。
function projectStoredRawContext(context?: Record<string, unknown> | null): SegmentCacheContext {
  const projected = projectSegmentCacheContext(context);
  return Array.isArray(context?.chapters) ? { ...projected, chapters: context.chapters } : projected;
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

// 缓冲键：投影后 context（短键，不再逐段序列化整份 AiContext）+ 段序号 + 预算档。
// 并发池内同段只会缓冲一条（map-reduce 每段一次 saveRaw），同键后写覆盖先写
// （内容同源同段，等价）。
function rawBufferKey(input: { context: SegmentCacheContext; segmentIndex?: number | string; budgetScale?: unknown }): string {
  return JSON.stringify([input.context, String(input.segmentIndex ?? ""), String(input.budgetScale ?? "")]);
}

interface BufferedRawSave {
  context: SegmentCacheContext;
  segmentIndex?: number | string;
  budgetScale?: unknown;
  segments: unknown[];
}

// 合并写回包的 per-op 结果汇入单一口径：任一失败 → { ok:false, error }（与单族
// 写失败同一可观测通道，编排层去重后只提示一次）。
function mergedSaveResult(response: SegmentCacheResponse): { ok: boolean; error?: unknown } {
  if (!response.ok) {
    const failed = [response.summarySaved, response.rawSaved].find((r) => r && r.ok === false);
    return { ok: false, error: failed?.error || response.error };
  }
  return { ok: true };
}

/**
 * 读半边出站点（追问链只读）：三 op 直通消息到 SW，载荷 context 收窄为键位字段
 *（load-stored-raw 另带 chapters，见 projectStoredRawContext）。容错口径与迁移前
 * 一致：读失败/无回执按未命中，不抛。
 */
export const segmentCacheProxy: SegmentCacheReadOps = {
  async loadSummary({ context, segmentIndex, budgetScale }) {
    const response = await segmentCacheRequest("load-summary", {
      context: projectSegmentCacheContext(context),
      segmentIndex,
      budgetScale
    });
    if (!response.ok) {
      return null;
    }
    return typeof response.summary === "string" ? response.summary : null;
  },
  async loadSummaries({ context, segmentIndexes, budgetScale }) {
    const response = await segmentCacheRequest("load-summaries", {
      context: projectSegmentCacheContext(context),
      segmentIndexes,
      budgetScale
    });
    if (!response.ok || !Array.isArray(response.summaries)) {
      return [];
    }
    return response.summaries;
  },
  async loadStoredRaw({ context, userPrompt }) {
    const prompt = typeof userPrompt === "string" && userPrompt.trim() ? userPrompt : undefined;
    const response = await segmentCacheRequest("load-stored-raw", {
      context: projectStoredRawContext(context),
      prompt
    });
    if (!response.ok || !Array.isArray(response.storedSegments)) {
      return [];
    }
    return response.storedSegments;
  }
};

/**
 * run-scoped 写会话（Map-Reduce 等编排在一次运行内唯一持有的写单元）：
 * - saveRaw：同步入会话缓冲（不发消息、不声明 per-op 成败）；缓冲键按投影后短键，
 *   subtitleBody 等大字段既不进键也不进载荷；
 * - saveSummary：命中缓冲 → 合成 save-summary-raw 合并 op（仅在发送成功后消费缓冲，
 *   失败保留待 close 补落）；未命中 → 直通 save-summary。返回真实 { ok, error? }；
 * - 读三 op：与 segmentCacheProxy 同路径、同容错口径；
 * - close：残留缓冲按 save-raw 逐条 await 落盘（载荷已从整份 AiContext 降到键位
 *   字段，await 代价可忽略），单条失败经 onWriteError 上浮、不抛；重复 close 为
 *   空操作。会话随 offscreen 文档销毁即废弃（port 断开/自关不 close）。
 */
export function createSegmentCacheWriteSession(
  options: { onWriteError?: (error: unknown) => void } = {}
): SegmentCacheWriteSession {
  const onWriteError = options.onWriteError;
  const bufferedRawSaves = new Map<string, BufferedRawSave>();

  return {
    loadSummary: (input) => segmentCacheProxy.loadSummary(input),
    loadSummaries: (input) => segmentCacheProxy.loadSummaries(input),
    loadStoredRaw: (input) => segmentCacheProxy.loadStoredRaw(input),

    async saveSummary({ context, segmentIndex, budgetScale, summary }) {
      const projected = projectSegmentCacheContext(context);
      const bufferKey = rawBufferKey({ context: projected, segmentIndex, budgetScale });
      const buffered = bufferedRawSaves.get(bufferKey);
      if (!buffered) {
        const response = await segmentCacheRequest("save-summary", { context: projected, segmentIndex, budgetScale, summary });
        return response.ok ? { ok: true } : { ok: false, error: response.error };
      }
      // 命中缓冲：合成 save-summary-raw 合并 op（两族一次落盘）。仅在发送成功后
      // 才消费缓冲——失败时保留，会话收尾的 close 按 save-raw 补落。
      const response = await segmentCacheRequest("save-summary-raw", {
        context: projected,
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

    saveRaw({ context, segmentIndex, budgetScale, segments }) {
      // 落盘时点推迟：缓冲在会话内存，随 saveSummary 合并发出；本次运行收尾时由
      // close 把残留按 save-raw 落盘（offscreen 文档在运行中被销毁才丢弃）。
      const projected = projectSegmentCacheContext(context);
      bufferedRawSaves.set(rawBufferKey({ context: projected, segmentIndex, budgetScale }), {
        context: projected,
        segmentIndex,
        budgetScale,
        segments: Array.isArray(segments) ? segments : []
      });
    },

    async close() {
      const pending = [...bufferedRawSaves.values()];
      bufferedRawSaves.clear();
      for (const buffered of pending) {
        const response = await segmentCacheRequest("save-raw", {
          context: buffered.context,
          segmentIndex: buffered.segmentIndex,
          budgetScale: buffered.budgetScale,
          segments: buffered.segments
        });
        if (!response.ok && typeof onWriteError === "function") {
          onWriteError(response.error);
        }
      }
    }
  };
}
