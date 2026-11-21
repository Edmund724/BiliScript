import { type CacheSaveResult } from "../core/cache-lru.js";
import { resolveChapterSource, type ChapterSource } from "../shared/chapter-outline.js";
import { logError } from "../shared/logging.js";
import { createAiArtifactFamily, loadAiArtifactsBatch } from "../subtitle/ai-artifact-cache.js";
import {
  registerSubtitleStoreResetHookForTests,
  registerVideoCacheClearHook
} from "../subtitle/store-client.js";
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

export const ANALYSIS_FINAL_PREFIX = "biliscript_lvs_analysis_final_";

export function isOverviewShape(value: unknown): value is OverviewAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { chapters?: unknown }).chapters) &&
      Array.isArray((value as { quotes?: unknown }).quotes)
  );
}

const analysisFinalFamily = createAiArtifactFamily<OverviewAnalysis>({
  family: ANALYSIS_FINAL_PREFIX,
  payloadField: "analysis",
  toSourceKey: buildSubtitleSourceKey,
  validate: isOverviewShape,
  logFailure: (info) => logError("[BILISCRIPT] failed to save analysis cache after eviction", info)
});

const l1IndexFamily = createAiArtifactFamily<L1VideoIndexCacheRecord>({
  family: L1_INDEX_CACHE_PREFIX,
  payloadField: "index",
  toSourceKey: buildSubtitleSourceKey,
  validate: isL1VideoIndexCacheRecord,
  logFailure: (info) => logError("[BILISCRIPT] failed to save L1 chapter index cache after eviction", info)
});

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
  clearMemoryByVideo(bvid: string, cid?: string): void;
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

export function createL1IndexCacheStore(options: CreateL1IndexCacheStoreOptions = {}): L1IndexCacheStore {
  const maxMemoryEntries = Math.max(
    1,
    Math.floor(Number(options.maxMemoryEntries ?? DEFAULT_L1_MEMORY_MAX_ENTRIES) || DEFAULT_L1_MEMORY_MAX_ENTRIES)
  );
  const persistLoad = options.persistLoad ?? ((key: string) => l1IndexFamily.load(key));
  const persistSave = options.persistSave ?? ((key: string, record: L1VideoIndexCacheRecord) => l1IndexFamily.save(key, record));
  const persistRemove = options.persistRemove ?? ((key: string) => l1IndexFamily.remove(key));

  const memoryCache = new Map<string, L1VideoIndexCacheRecord>();

  function getMemory(key: string): L1VideoIndexCacheRecord | null {
    const hit = memoryCache.get(key);
    if (!hit) {
      return null;
    }
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

  function clearMemoryByVideo(bvid: string, cid?: string): void {
    const cleanBvid = String(bvid || "").trim();
    const cleanCid = cid !== undefined && cid !== null ? String(cid).trim() : "";
    if (!cleanBvid) {
      return;
    }
    const keyPrefix = cleanCid
      ? `${L1_INDEX_CACHE_PREFIX}${cleanBvid}_${cleanCid}_`
      : `${L1_INDEX_CACHE_PREFIX}${cleanBvid}_`;
    for (const [key, record] of memoryCache.entries()) {
      const matchesRecord =
        record.bvid === cleanBvid && (!cleanCid || record.cid === cleanCid);
      if (matchesRecord || key.startsWith(keyPrefix)) {
        memoryCache.delete(key);
      }
    }
  }

  return {
    getMemory,
    setMemory,
    clearMemory(): void {
      memoryCache.clear();
    },
    clearMemoryByVideo,
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
registerVideoCacheClearHook((bvid, cid) => {
  defaultL1Store.clearMemoryByVideo(bvid, cid);
});
registerSubtitleStoreResetHookForTests(() => {
  defaultL1Store.clearMemory();
});

export const loadL1Index = (key: string) => defaultL1Store.load(key);
export const saveL1Index = (key: string, record: L1VideoIndexCacheRecord) => defaultL1Store.save(key, record);
export const removeL1Index = (key: string) => defaultL1Store.remove(key);
export const clearL1IndexMemoryCache = () => defaultL1Store.clearMemory();
export const clearL1IndexMemoryForVideo = (bvid: string, cid?: string) =>
  defaultL1Store.clearMemoryByVideo(bvid, cid);

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

export async function readCachedClipOverviewArtifacts(
  input: ClipOverviewIdentityInput | null | undefined
): Promise<CachedClipOverviewArtifacts> {
  const identity = buildClipOverviewIdentity(input);
  if (!identity.hasCacheIdentity) {
    return { analysisFinal: null, l1Index: null };
  }
  const memL1 = defaultL1Store.getMemory(identity.l1Key);
  try {
    if (memL1) {
      const analysisFinal = await loadAnalysisFinal(identity.finalKey);
      return { analysisFinal, l1Index: memL1 };
    }
    const [rawAnalysis, rawL1] = await loadAiArtifactsBatch([
      {
        key: identity.finalKey,
        family: ANALYSIS_FINAL_PREFIX,
        payloadField: "analysis",
        validate: isOverviewShape
      },
      {
        key: identity.l1Key,
        family: L1_INDEX_CACHE_PREFIX,
        payloadField: "index",
        validate: isL1VideoIndexCacheRecord
      }
    ]);
    const analysisFinal = isOverviewShape(rawAnalysis) ? rawAnalysis : null;
    const l1Index = isL1VideoIndexCacheRecord(rawL1) ? rawL1 : null;
    if (l1Index) {
      defaultL1Store.setMemory(identity.l1Key, l1Index);
    }
    return { analysisFinal, l1Index };
  } catch {
    return { analysisFinal: null, l1Index: memL1 };
  }
}
