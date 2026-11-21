import { logError } from "../shared/logging.js";
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import { createAiArtifactFamily } from "../subtitle/ai-artifact-cache.js";
import type { EvictionFailure, EvictionResult } from "../core/cache-lru.js";
import { L1_INDEX_CACHE_PREFIX, isL1VideoIndexCacheRecord } from "./l1-directory.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
import { segmentCacheKeyFields, segmentCacheKeyStringFields } from "./segment-cache-key-fields.js";

const SEGMENT_SUMMARY_PREFIX = "biliscript_lvs_summary_";

const summaryFamily = createAiArtifactFamily<string>({
  family: SEGMENT_SUMMARY_PREFIX,
  payloadField: "summary",
  toSourceKey: buildSubtitleSourceKey,
  validate: (value) => typeof value === "string",
  logFailure: (info) => logError("[BILISCRIPT] failed to save segment summary cache after eviction", info),
  directStore: true
});

const l1IndexReaderFamily = createAiArtifactFamily<L1VideoIndexCacheRecord>({
  family: L1_INDEX_CACHE_PREFIX,
  payloadField: "index",
  toSourceKey: buildSubtitleSourceKey,
  validate: isL1VideoIndexCacheRecord,
  directStore: true
});

interface SegmentKeyOptions {
  bvid: unknown;
  cid: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  lang?: unknown;
  segmentIndex: number | string | unknown;
  budgetScale?: number | string | unknown;
}

export function budgetScaleSuffix(budgetScale: unknown): string {
  const scale = Number(budgetScale);
  return Number.isFinite(scale) && scale !== 1 ? `_b${Math.round(scale * 100)}` : "";
}

export function getSegmentSummaryKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "", segmentIndex, budgetScale = 1 }: SegmentKeyOptions): string {
  return summaryFamily.key({ bvid, cid, subtitleId, subtitleUrl, lang }, `${segmentIndex}${budgetScaleSuffix(budgetScale)}`);
}

export { segmentCacheKeyFields, segmentCacheKeyStringFields };

export function buildSegmentSummaryCacheKey(context: Record<string, unknown> | undefined, segmentIndex: number | string | unknown, budgetScale: number | string | unknown = 1): string {
  return getSegmentSummaryKey({ ...segmentCacheKeyFields(context), segmentIndex, budgetScale });
}

export async function loadSegmentSummary(key: string): Promise<string | null> {
  return summaryFamily.load(key);
}

export async function loadSegmentSummariesByKeys(keys: string[]): Promise<(string | null)[]> {
  return summaryFamily.loadMany(keys);
}

type SaveResult = EvictionResult | EvictionFailure;

export async function saveSegmentSummary(key: string, summary: string): Promise<SaveResult> {
  return summaryFamily.save(key, summary);
}

function parseSummarySegmentIndex(key: string, keyPrefix: string, scaleSuffix: string): number | null {
  const tail = String(key).slice(keyPrefix.length);
  if (!tail) {
    return null;
  }
  if (!scaleSuffix) {
    if (/_b\d+$/.test(tail)) {
      return null;
    }
    const n = Number(tail);
    return Number.isFinite(n) ? n : null;
  }
  if (!tail.endsWith(scaleSuffix)) {
    return null;
  }
  const indexPart = tail.slice(0, tail.length - scaleSuffix.length);
  if (!indexPart) {
    return null;
  }
  const n = Number(indexPart);
  return Number.isFinite(n) ? n : null;
}

interface LoadStoredSegmentSummariesInput {
  bvid?: string;
  cid?: string;
  subtitleId?: string;
  subtitleUrl?: string;
  lang?: string;
  budgetScale?: number | string | unknown;
}

export async function loadStoredSegmentSummaries({
  bvid,
  cid,
  subtitleId = "",
  subtitleUrl = "",
  lang = "",
  budgetScale = 1
}: LoadStoredSegmentSummariesInput = {}): Promise<string[]> {
  try {
    if (!bvid || !cid) {
      return [];
    }
    const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
    const keyPrefix = `${SEGMENT_SUMMARY_PREFIX}${bvid}_${cid}_${sourceKey}_`;
    const scaleSuffix = budgetScaleSuffix(budgetScale);
    const items = await summaryFamily.loadByPrefix(bvid, keyPrefix);

    const entries: Array<{ index: number; summary: string }> = [];
    for (const item of items) {
      if (!item.key.startsWith(keyPrefix)) {
        continue;
      }
      const segmentIndex = parseSummarySegmentIndex(item.key, keyPrefix, scaleSuffix);
      if (segmentIndex === null) {
        continue;
      }
      if (typeof item.payload === "string" && item.payload.trim().length > 0) {
        entries.push({ index: segmentIndex, summary: item.payload });
      }
    }
    entries.sort((a, b) => a.index - b.index);
    return entries.map((entry) => entry.summary);
  } catch {
    return [];
  }
}

interface LoadStoredL1IndexInput {
  bvid?: string;
  cid?: string;
  subtitleId?: string;
  subtitleUrl?: string;
  lang?: string;
}

export async function loadStoredL1Index({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }: LoadStoredL1IndexInput = {}): Promise<L1VideoIndexCacheRecord | null> {
  try {
    if (!bvid || !cid) {
      return null;
    }
    const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
    const keyPrefix = `${L1_INDEX_CACHE_PREFIX}${bvid}_${cid}_${sourceKey}_`;
    const items = await l1IndexReaderFamily.loadByPrefix(bvid, keyPrefix);
    let best: L1VideoIndexCacheRecord | null = null;
    for (const item of items) {
      if (!item.key.startsWith(keyPrefix)) {
        continue;
      }
      const candidate = item.payload;
      if (!isL1VideoIndexCacheRecord(candidate)) {
        continue;
      }
      if (!best || (candidate.updatedAt || 0) >= (best.updatedAt || 0)) {
        best = candidate;
      }
    }
    return best;
  } catch {
    return null;
  }
}
