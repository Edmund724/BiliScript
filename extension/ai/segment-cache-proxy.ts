import type { SegmentCacheMessage, SegmentCacheResponse } from "../shared/messaging-protocol.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import { projectSegmentCacheContext } from "./segment-cache-key-fields.js";

export interface SegmentCacheOps {
  loadSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown }): Promise<string | null>;
  loadSummaries(input: { context?: Record<string, unknown>; segmentIndexes?: Array<number | string>; budgetScale?: unknown }): Promise<(string | null)[]>;
  loadStoredSummaries(input: { context?: Record<string, unknown>; budgetScale?: unknown }): Promise<string[]>;
  saveSummary(input: { context?: Record<string, unknown>; segmentIndex?: number | string; budgetScale?: unknown; summary: string }): Promise<{ ok: boolean; error?: unknown }>;
}

export type SegmentCacheReadOps = Pick<SegmentCacheOps, "loadSummary" | "loadSummaries" | "loadStoredSummaries">;

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
  }
};

export async function loadL1IndexViaProxy(input: { context?: Record<string, unknown> }): Promise<L1VideoIndexCacheRecord | null> {
  const response = await segmentCacheRequest("load-l1-index", {
    context: projectSegmentCacheContext(input.context)
  });
  if (!response.ok || !response.l1Index) {
    return null;
  }
  return response.l1Index;
}
