// 段缓存消息代理：段缓存宿主是 SW（storage 所在），
// offscreen 的 Map-Reduce / 追问链经 runtime 消息调用（SW 端 handler 见
// ./segment-cache-handler.js，键位装配在 SW 的 segment-cache 单源完成）。
// 本模块是 offscreen 侧唯一出站点；容错口径与直连 segment-cache 一致——
// 读失败/无回执按未命中（null / []），saveSummary 写失败以 { ok:false } 上浮，
// 全程不抛。
//
// 出站点收窄：所有消息载荷的 context 都是「AiContext → SW 键位字段」投影后的窄
// 对象——字段清单与投影实现单源在零依赖叶 ai/segment-cache-key-fields.ts
// （offscreen 侧引用它不会引入 storage 层），整份 AiContext（含 ≥200k 字符的
// subtitleBody）不再过线。

import type { SegmentCacheContext, SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import { projectSegmentCacheContext } from "./segment-cache-key-fields.js";

export interface SegmentCacheOps {
  loadSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown }): Promise<string | null>;
  loadSummaries(input: { context?: Record<string, unknown>; segmentIndexes?: Array<number | string>; budgetScale?: unknown }): Promise<(string | null)[]>;
  loadStoredSummaries(input: { context?: Record<string, unknown>; budgetScale?: unknown }): Promise<string[]>;
  saveSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; summary: string }): Promise<{ ok: boolean; error?: unknown }>;
  // userPrompt 非空时 SW 侧预过滤，只回传命中段的 items；缺省整篇回传
  loadStoredRaw(input: { context?: Record<string, unknown>; userPrompt?: unknown }): Promise<unknown[]>;
}

// 读半边（追问链只读）。
export type SegmentCacheReadOps = Pick<SegmentCacheOps, "loadSummary" | "loadSummaries" | "loadStoredSummaries" | "loadStoredRaw">;

// 读 op（load-stored-raw）的命中段预过滤在 SW 侧走同一检索规则的章节名档
// （retrieveRawSegments 的 chapters 入参）；键位维度本身由叶的 projectSegmentCacheContext 投影。
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

/**
 * offscreen 段缓存代理（读/写直通 SW 消息，载荷 context 收窄为键位字段）。
 */
export const segmentCacheProxy: SegmentCacheOps = {
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
  async loadStoredSummaries({ context, budgetScale }) {
    const response = await segmentCacheRequest("load-stored-summaries", {
      context: projectSegmentCacheContext(context),
      budgetScale
    });
    if (!response.ok || !Array.isArray(response.summaries)) {
      return [];
    }
    return response.summaries.filter((item): item is string => typeof item === "string");
  },
  async saveSummary({ context, segmentIndex, budgetScale, summary }) {
    const response = await segmentCacheRequest("save-summary", {
      context: projectSegmentCacheContext(context),
      segmentIndex,
      budgetScale,
      summary
    });
    return response.ok ? { ok: true } : { ok: false, error: response.error };
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
 * 从 SW 宿主读取当前视频对应的 L1 章节目录缓存；未命中/失败返回 null（绝不抛错）。
 */
export async function loadL1IndexViaProxy(input: { context?: Record<string, unknown> }): Promise<L1VideoIndexCacheRecord | null> {
  const response = await segmentCacheRequest("load-l1-index", {
    context: projectSegmentCacheContext(input.context)
  });
  if (!response.ok || !response.l1Index) {
    return null;
  }
  return response.l1Index;
}
