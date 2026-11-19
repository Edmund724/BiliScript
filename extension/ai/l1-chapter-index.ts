// extension/ai/l1-chapter-index.ts
// L1 章节目录索引与整份概览产物的统一缓存身份与本机持久化模块（ADR-0003 / ADR-0027）：
// - 纯构建/序列化/校验/封包拆包逻辑住在 ./l1-directory.ts（零存储依赖，可供 offscreen/SW 共用）；
// - 本文件统一收口：
//   1) `biliscript_lvs_l1_index_`（含 16 条内存有界 LRU）与 `biliscript_lvs_analysis_final_` 两个缓存族（纳入 core/cache-lru.ts 统一保留最近 100 个视频）；
//   2) clip / AiContext 的分章来源 + 字幕签名 + 双族键位归一（buildClipOverviewIdentity）；
//   3) 单趟并发读取整份概览产物与内存 LRU 命中的 L1 章节目录（readCachedClipOverviewArtifacts / readCachedClipL1Index）。

import { createCacheFamily, type CacheSaveResult } from "../core/cache-lru.js";
import { resolveChapterSource, type ChapterSource } from "../shared/chapter-outline.js";
import { logError } from "../shared/logging.js";
import { buildSubtitleSignature } from "../subtitle/signature.js";
import { buildSubtitleSourceKey } from "../subtitle/source-key.js";
import {
  DEFAULT_L1_MEMORY_MAX_ENTRIES,
  DEFAULT_L1_PROMPT_MAX_CHARS,
  DEFAULT_L1_PROMPT_MAX_TOKENS,
  L1_INDEX_CACHE_PREFIX,
  L1_INDEX_SCHEMA_VERSION,
  buildL1VideoIndex,
  estimateCompactPromptTokens,
  findL1ChapterForTime,
  isL1VideoIndexCacheRecord,
  serializeL1DirectoryPrompt,
  unwrapL1IndexEnvelope,
  type BuildL1VideoIndexInput,
  type L1ChapterInput,
  type L1QuoteInput,
  type SerializeL1PromptOptions
} from "./l1-directory.js";
import { segmentCacheKeyStringFields } from "./segment-cache-key-fields.js";
import type { OverviewAnalysis } from "./analysis-validate.js";
import type { L1VideoIndexCacheRecord } from "./long-video-hybrid-types.js";

export {
  DEFAULT_L1_MEMORY_MAX_ENTRIES,
  DEFAULT_L1_PROMPT_MAX_CHARS,
  DEFAULT_L1_PROMPT_MAX_TOKENS,
  L1_INDEX_CACHE_PREFIX,
  L1_INDEX_SCHEMA_VERSION,
  buildL1VideoIndex,
  estimateCompactPromptTokens,
  findL1ChapterForTime,
  isL1VideoIndexCacheRecord,
  serializeL1DirectoryPrompt,
  unwrapL1IndexEnvelope
};
export type {
  BuildL1VideoIndexInput,
  L1ChapterInput,
  L1QuoteInput,
  SerializeL1PromptOptions
};

// 整份概览结果缓存键前缀（键形：前缀 + bvid + cid + 字幕轨 source key + 字幕签名）。
export const ANALYSIS_FINAL_PREFIX = "biliscript_lvs_analysis_final_";

export function isOverviewShape(value: unknown): value is OverviewAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { chapters?: unknown }).chapters) &&
      Array.isArray((value as { quotes?: unknown }).quotes)
  );
}

const analysisFinalFamily = createCacheFamily<OverviewAnalysis>({
  prefix: ANALYSIS_FINAL_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BILISCRIPT] failed to save analysis cache after eviction", info)
});

const l1IndexFamily = createCacheFamily<L1VideoIndexCacheRecord>({
  prefix: L1_INDEX_CACHE_PREFIX,
  payloadField: "index",
  toSourceKey: buildSubtitleSourceKey,
  validate: isL1VideoIndexCacheRecord,
  logFailure: (info) => logError("[BILISCRIPT] failed to save L1 chapter index cache after eviction", info)
});

/**
 * 整份概览结果缓存键：bvid + cid + 字幕轨 source key + 字幕签名。
 * 签名随字幕内容（条数/首末时间戳/文本量）与轨道变化，重抓字幕/换轨/切分P 自然 miss。
 */
export function buildAnalysisFinalCacheKey(context: Record<string, unknown> | undefined | null, signature: unknown): string {
  return analysisFinalFamily.key(segmentCacheKeyStringFields(context), String(signature ?? ""));
}

export const loadAnalysisFinal = (key: string): Promise<OverviewAnalysis | null> => analysisFinalFamily.load(key);
export const saveAnalysisFinal = (key: string, analysis: OverviewAnalysis): Promise<CacheSaveResult> =>
  analysisFinalFamily.save(key, analysis);

export interface L1IndexKeyInput {
  bvid: string;
  cid: string;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  subtitleLang?: unknown;
  subtitleSignature: string;
}

/** 构造 L1 索引唯一缓存键（按视频 bvid/cid + 字幕轨身份 + 字幕签名隔离）。 */
export function buildL1IndexCacheKey(input: L1IndexKeyInput): string {
  return l1IndexFamily.key(
    {
      bvid: String(input.bvid || "").trim(),
      cid: String(input.cid || "").trim(),
      subtitleId: input.subtitleId,
      subtitleUrl: input.subtitleUrl,
      lang: input.subtitleLang
    },
    String(input.subtitleSignature || "").trim()
  );
}

export interface ClipOverviewIdentityInput {
  bvid?: unknown;
  cid?: unknown;
  description?: unknown;
  videoDescription?: unknown;
  hotComments?: unknown;
  chapters?: unknown;
  selectedSubtitleId?: unknown;
  selectedSubtitleUrl?: unknown;
  selectedSubtitleLang?: unknown;
  subtitleLang?: unknown;
  subtitleBody?: unknown;
}

export interface ClipOverviewIdentity {
  bvid: string;
  cid: string;
  subtitleId: unknown;
  subtitleUrl: unknown;
  subtitleLang: unknown;
  body: unknown[];
  chapterSource: ChapterSource;
  signature: string;
  finalKey: string;
  l1Key: string;
  hasCacheIdentity: boolean;
}

/**
 * 统一归一 clipState（description / selectedSubtitleLang）与 AiContext（videoDescription / subtitleLang）
 * 的身份字段，单源推导分章来源、字幕签名与概览/L1 双族缓存键。
 */
export function buildClipOverviewIdentity(
  input: ClipOverviewIdentityInput | null | undefined
): ClipOverviewIdentity {
  const bvid = String(input?.bvid ?? "").trim();
  const cid = String(input?.cid ?? "").trim();
  const subtitleId = input?.selectedSubtitleId;
  const subtitleUrl = input?.selectedSubtitleUrl;
  const subtitleLang =
    input?.selectedSubtitleLang !== undefined &&
    input.selectedSubtitleLang !== null &&
    input.selectedSubtitleLang !== ""
      ? input.selectedSubtitleLang
      : (input?.subtitleLang ?? input?.selectedSubtitleLang);
  const description = input?.description !== undefined ? input.description : input?.videoDescription;
  const body = Array.isArray(input?.subtitleBody) ? input.subtitleBody : [];

  const chapterSource = resolveChapterSource(description, input?.hotComments, input?.chapters);
  const signature = buildSubtitleSignature({
    lang: subtitleLang,
    subtitleId,
    subtitleUrl,
    body,
    chapters: chapterSource.signatureChapters,
    chapterOutline: chapterSource.chapters
  });
  const finalKey = buildAnalysisFinalCacheKey(
    {
      bvid,
      cid,
      selectedSubtitleId: subtitleId,
      selectedSubtitleUrl: subtitleUrl,
      subtitleLang
    },
    signature
  );
  const l1Key = buildL1IndexCacheKey({
    bvid,
    cid,
    subtitleId,
    subtitleUrl,
    subtitleLang,
    subtitleSignature: signature
  });

  return {
    bvid,
    cid,
    subtitleId,
    subtitleUrl,
    subtitleLang,
    body,
    chapterSource,
    signature,
    finalKey,
    l1Key,
    hasCacheIdentity: Boolean(bvid && cid && body.length > 0)
  };
}

export interface L1IndexCacheStore {
  getMemory(key: string): L1VideoIndexCacheRecord | null;
  setMemory(key: string, record: L1VideoIndexCacheRecord): void;
  clearMemory(): void;
  load(key: string): Promise<L1VideoIndexCacheRecord | null>;
  save(key: string, record: L1VideoIndexCacheRecord): Promise<CacheSaveResult>;
  remove(key: string): Promise<void>;
}

export interface CreateL1IndexCacheStoreOptions {
  maxMemoryEntries?: number;
  persistLoad?: (key: string) => Promise<L1VideoIndexCacheRecord | null>;
  persistSave?: (key: string, record: L1VideoIndexCacheRecord) => Promise<CacheSaveResult>;
  persistRemove?: (key: string) => Promise<void>;
}

async function defaultPersistRemove(key: string): Promise<void> {
  try {
    if (globalThis.chrome?.storage?.local) {
      await chrome.storage.local.remove(key);
    }
  } catch {
    // 清理失败静默容错
  }
}

/**
 * 创建 L1 章节目录缓存管理器：
 * 1. 内存层为有界 LRU Map（默认 16 条），保证同会话热查询零 IPC/storage 往返；
 * 2. 持久化层严格绑定 `chrome.storage.local`（不进 `chrome.storage.sync`，不含凭据），
 *    由 `core/cache-lru.ts` 统一维持 L1 索引最近 100 个视频的 LRU 淘汰。
 */
export function createL1IndexCacheStore(options: CreateL1IndexCacheStoreOptions = {}): L1IndexCacheStore {
  const maxMemoryEntries = Math.max(
    1,
    Math.floor(Number(options.maxMemoryEntries ?? DEFAULT_L1_MEMORY_MAX_ENTRIES) || DEFAULT_L1_MEMORY_MAX_ENTRIES)
  );
  const persistLoad = options.persistLoad ?? ((key: string) => l1IndexFamily.load(key));
  const persistSave = options.persistSave ?? ((key: string, record: L1VideoIndexCacheRecord) => l1IndexFamily.save(key, record));
  const persistRemove = options.persistRemove ?? defaultPersistRemove;

  const memoryCache = new Map<string, L1VideoIndexCacheRecord>();

  function getMemory(key: string): L1VideoIndexCacheRecord | null {
    const hit = memoryCache.get(key);
    if (!hit) {
      return null;
    }
    // 刷新 LRU 近期性
    memoryCache.delete(key);
    memoryCache.set(key, hit);
    return hit;
  }

  function setMemory(key: string, record: L1VideoIndexCacheRecord): void {
    if (!key || !isL1VideoIndexCacheRecord(record)) {
      return;
    }
    if (memoryCache.has(key)) {
      memoryCache.delete(key);
    }
    memoryCache.set(key, record);
    while (memoryCache.size > maxMemoryEntries) {
      const oldestKey = memoryCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      memoryCache.delete(oldestKey);
    }
  }

  return {
    getMemory,
    setMemory,
    clearMemory(): void {
      memoryCache.clear();
    },
    async load(key: string): Promise<L1VideoIndexCacheRecord | null> {
      if (!key) {
        return null;
      }
      const memHit = getMemory(key);
      if (memHit) {
        return memHit;
      }
      const persisted = await persistLoad(key);
      if (persisted && isL1VideoIndexCacheRecord(persisted)) {
        setMemory(key, persisted);
        return persisted;
      }
      return null;
    },
    async save(key: string, record: L1VideoIndexCacheRecord): Promise<CacheSaveResult> {
      if (!key || !isL1VideoIndexCacheRecord(record) || !record.bvid || !record.cid) {
        return {
          ok: false,
          error: new Error("L1 索引缓存写入拒绝：缺少合法的 bvid/cid 或索引结构不合法") as import("../core/cache-lru.js").CacheWriteError
        };
      }
      setMemory(key, record);
      return persistSave(key, record);
    },
    async remove(key: string): Promise<void> {
      if (!key) {
        return;
      }
      memoryCache.delete(key);
      await persistRemove(key);
    }
  };
}

const defaultL1Store = createL1IndexCacheStore();

export const loadL1Index = (key: string) => defaultL1Store.load(key);
export const saveL1Index = (key: string, record: L1VideoIndexCacheRecord) => defaultL1Store.save(key, record);
export const removeL1Index = (key: string) => defaultL1Store.remove(key);
export const clearL1IndexMemoryCache = () => defaultL1Store.clearMemory();

/**
 * 按 clip / AiContext 身份读取已缓存的 L1 章节目录索引（优先命中 16 条内存 LRU，未命中再查 local 并回填 LRU）。
 */
export async function readCachedClipL1Index(
  input: ClipOverviewIdentityInput | null | undefined
): Promise<L1VideoIndexCacheRecord | null> {
  const identity = buildClipOverviewIdentity(input);
  if (!identity.hasCacheIdentity) {
    return null;
  }
  return loadL1Index(identity.l1Key);
}

export interface CachedClipOverviewArtifacts {
  analysisFinal: OverviewAnalysis | null;
  l1Index: L1VideoIndexCacheRecord | null;
}

/**
 * 单趟并发读取当前视频的整份概览产物（`analysisFinal`）与 L1 章节目录（`l1Index`）：
 * 若 L1 已命中内存 LRU，仅向 `chrome.storage.local` 读取 `finalKey`；否则一次批量读取两键并回填内存 LRU。
 */
export async function readCachedClipOverviewArtifacts(
  input: ClipOverviewIdentityInput | null | undefined
): Promise<CachedClipOverviewArtifacts> {
  const identity = buildClipOverviewIdentity(input);
  if (!identity.hasCacheIdentity) {
    return { analysisFinal: null, l1Index: null };
  }
  const memL1 = defaultL1Store.getMemory(identity.l1Key);
  if (!globalThis.chrome?.storage?.local) {
    return { analysisFinal: null, l1Index: memL1 };
  }
  const keysToFetch = memL1 ? [identity.finalKey] : [identity.finalKey, identity.l1Key];
  try {
    const stored = await chrome.storage.local.get(keysToFetch);
    const rawAnalysis = (stored?.[identity.finalKey] as { analysis?: unknown } | undefined)?.analysis;
    const analysisFinal = isOverviewShape(rawAnalysis) ? rawAnalysis : null;
    let l1Index = memL1;
    if (!l1Index) {
      l1Index = unwrapL1IndexEnvelope(stored?.[identity.l1Key]);
      if (l1Index) {
        defaultL1Store.setMemory(identity.l1Key, l1Index);
      }
    }
    return { analysisFinal, l1Index };
  } catch {
    return { analysisFinal: null, l1Index: memL1 };
  }
}
