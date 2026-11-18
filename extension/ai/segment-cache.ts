// 「段缓存」模块：分段小结按 (bvid, cid, 字幕轨 source key, 段序号) 落盘 chrome.storage.local，
// 二次总结/追问按需命中复用，中止/失败后已落盘的段小结下次复用、不重复付费；
// 同时提供 SW 宿主存储中的 L1 章节目录索引读取。
// 容错语义：读取失败静默返回 null / []；写入经 core/cache-lru.ts 的统一 LRU 淘汰
// （分段小结保留最近 20 个视频），淘汰后重试仍失败时 logError 并返回 { ok:false }
// 供调用方按各自通道上浮一次；全程不抛异常。

import { logError } from "../shared/logging.js";
// 三字段 → source key 的便捷形（位置参数签名与 core/cache-lru 的注入面同一份）：
// 身份编码单点在键位叶 subtitle/source-key，本模块不再经存储族模块取它。
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import { createCacheFamily, readFamilyKeys } from "../core/cache-lru.js";
import type { EvictionFailure, EvictionResult } from "../core/cache-lru.js";
import { L1_INDEX_CACHE_PREFIX, unwrapL1IndexEnvelope } from "./l1-directory.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";
// 键位字段清单与「上下文 → 键位」投影的单源在零依赖叶：SW 侧装配 / offscreen
// 出站点 / 协议载荷类型 / 概览键位装配都从它派生，本模块只消费、不再手抄字段清单。
import { segmentCacheKeyFields, segmentCacheKeyStringFields } from "./segment-cache-key-fields.js";

// 分段小结缓存键前缀。
const SEGMENT_SUMMARY_PREFIX = "biliscript_lvs_summary_";

const summaryFamily = createCacheFamily<string>({
  prefix: SEGMENT_SUMMARY_PREFIX,
  payloadField: "summary",
  toSourceKey: buildSubtitleSourceKey,
  logFailure: (info) => logError("[BILISCRIPT] failed to save segment summary cache after eviction", info)
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

// 段序号之外的预算代后缀：同一 (bvid, cid, 字幕轨) 在不同预算档下的分段边界不同，
// 段序号相同不代表内容相同——不带代标记的 key 会命中错位小结（内容串段）。
// budgetScale=1（常态档）不带后缀，key 形状与历史逐字节一致，已有缓存零迁移。
// 导出供同族键位（如 ai/analysis-orchestrate.ts 的 biliscript_lvs_analysis_ 族）继承同一预算代约定。
export function budgetScaleSuffix(budgetScale: unknown): string {
  const scale = Number(budgetScale);
  return Number.isFinite(scale) && scale !== 1 ? `_b${Math.round(scale * 100)}` : "";
}

/**
 * 分段小结缓存键：bvid + cid + 字幕轨 source key + 段序号 [+ 预算代]。
 * source key 随字幕轨（subtitleId / subtitleUrl / lang）区分，切换字幕轨不串。
 */
export function getSegmentSummaryKey({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "", segmentIndex, budgetScale = 1 }: SegmentKeyOptions): string {
  return summaryFamily.key({ bvid, cid, subtitleId, subtitleUrl, lang }, `${segmentIndex}${budgetScaleSuffix(budgetScale)}`);
}

// 「AI 上下文对象 → 段缓存键位字段」的清单与投影已下沉零依赖叶
// ai/segment-cache-key-fields.ts：上下文字段名 selectedSubtitleId/Url/subtitleLang
// 映射为键位入参 subtitleId/subtitleUrl/lang 的事实只在该叶声明一份，落盘、
// 复用与概览键位装配共用同一份投影，键位不再各自手拼。本模块保留
// SW 侧出口（handler / 测试从段缓存模块取键位装配），实现单源在叶，无第二份清单。
export { segmentCacheKeyFields, segmentCacheKeyStringFields };

/**
 * 从 AI 上下文 + 段序号拼分段小结缓存键（与 getSegmentSummaryKey 手拼逐字节一致）。
 * budgetScale：预算档（默认 1 = 常态档，key 不带代后缀）；溢出放宽预算重跑（0.5）等
 * 非常态档带代后缀，与常态档的段序号空间隔离，防止段边界漂移后命中错位小结。
 */
export function buildSegmentSummaryCacheKey(context: Record<string, unknown> | undefined, segmentIndex: number | string | unknown, budgetScale: number | string | unknown = 1): string {
  return getSegmentSummaryKey({ ...segmentCacheKeyFields(context), segmentIndex, budgetScale });
}

/**
 * 读取已落盘的分段小结：命中返回 item.summary（string），未命中/读失败返回 null。
 */
export async function loadSegmentSummary(key: string): Promise<string | null> {
  return summaryFamily.load(key);
}

/**
 * 批量读取分段小结：一次 storage.get 取 N 键，返回与 keys 按序对齐的
 * 数组（未命中/读失败为 null）。读口径出自 createCacheFamily.loadMany 单源，
 * 容错语义同 loadSegmentSummary（静默、不抛）。
 */
export async function loadSegmentSummariesByKeys(keys: string[]): Promise<(string | null)[]> {
  return summaryFamily.loadMany(keys);
}

type SaveResult = EvictionResult | EvictionFailure;

/**
 * 保存分段小结：落盘 { summary, timestamp }。写入走统一 LRU 淘汰
 * （写失败先淘汰旧视频再重试一次）；最终失败 logError、不抛异常，
 * 返回 { ok:false, error } 供调用方上浮，成功返回 { ok:true }。
 */
export async function saveSegmentSummary(key: string, summary: string): Promise<SaveResult> {
  return summaryFamily.save(key, summary);
}

// 从分段小结缓存键尾段解析段序号；常态档排除 `_b\d+` 后缀，非常态档要求匹配对应预算代后缀。
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

/**
 * 直接按 (bvid, cid, 字幕轨 source key[, budgetScale]) 枚举已落盘的分段小结，
 * 按段序号升序返回非空小结数组（常态档排除 `_b\d+` 后缀）。
 * 枚举走 core/cache-lru 的 readFamilyKeys + get(null) 回退扫描；缺参 / 无命中 / 读失败 → []。
 */
export async function loadStoredSegmentSummaries({
  bvid,
  cid,
  subtitleId = "",
  subtitleUrl = "",
  lang = "",
  budgetScale = 1
}: LoadStoredSegmentSummariesInput = {}): Promise<string[]> {
  try {
    if (!bvid || !cid || !globalThis.chrome?.storage?.local) {
      return [];
    }
    const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
    const keyPrefix = `${SEGMENT_SUMMARY_PREFIX}${bvid}_${cid}_${sourceKey}_`;
    const scaleSuffix = budgetScaleSuffix(budgetScale);
    const indexKeys = await readFamilyKeys(SEGMENT_SUMMARY_PREFIX, bvid, keyPrefix);
    const all = indexKeys
      ? await chrome.storage.local.get(indexKeys)
      : await chrome.storage.local.get(null);

    const entries: Array<{ index: number; summary: string }> = [];
    for (const [key, envelope] of Object.entries(all || {})) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      const segmentIndex = parseSummarySegmentIndex(key, keyPrefix, scaleSuffix);
      if (segmentIndex === null) {
        continue;
      }
      const summary = (envelope as { summary?: unknown } | undefined)?.summary;
      if (typeof summary === "string" && summary.trim().length > 0) {
        entries.push({ index: segmentIndex, summary });
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

/**
 * 读取 SW 宿主存储中的 L1 章节目录索引：按 (bvid, cid, 字幕轨 source key) 枚举并校验，
 * 返回最新一条有效记录；缺参 / 未命中 / 读失败 → null（绝不抛错）。
 */
export async function loadStoredL1Index({ bvid, cid, subtitleId = "", subtitleUrl = "", lang = "" }: LoadStoredL1IndexInput = {}): Promise<L1VideoIndexCacheRecord | null> {
  try {
    if (!bvid || !cid || !globalThis.chrome?.storage?.local) {
      return null;
    }
    const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
    const keyPrefix = `${L1_INDEX_CACHE_PREFIX}${bvid}_${cid}_${sourceKey}_`;
    const indexKeys = await readFamilyKeys(L1_INDEX_CACHE_PREFIX, bvid, keyPrefix);
    const all = indexKeys
      ? await chrome.storage.local.get(indexKeys)
      : await chrome.storage.local.get(null);
    let best: L1VideoIndexCacheRecord | null = null;
    for (const [key, envelope] of Object.entries(all || {})) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      const candidate = unwrapL1IndexEnvelope(envelope);
      if (!candidate) {
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
