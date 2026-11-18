// extension/ai/l1-chapter-index.ts
// L1 章节目录索引构建、紧凑 Prompt 序列化与本机缓存适配模块（ADR-0027）：
// - 纯构建/序列化/校验逻辑住在 ./l1-directory.ts（零存储依赖，可供 offscreen/SW 共用）；
// - 本文件提供内存有界 LRU + chrome.storage.local 持久化（纳入 core/cache-lru.ts 统一 3 视频淘汰，绝不写 sync 或携带凭据）。

import { createCacheFamily, type CacheSaveResult } from "../core/cache-lru.js";
import { logError } from "../shared/logging.js";
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
  type BuildL1VideoIndexInput,
  type L1ChapterInput,
  type L1QuoteInput,
  type SerializeL1PromptOptions
} from "./l1-directory.js";
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
  serializeL1DirectoryPrompt
};
export type {
  BuildL1VideoIndexInput,
  L1ChapterInput,
  L1QuoteInput,
  SerializeL1PromptOptions
};

const l1IndexFamily = createCacheFamily<L1VideoIndexCacheRecord>({
  prefix: L1_INDEX_CACHE_PREFIX,
  payloadField: "index",
  toSourceKey: buildSubtitleSourceKey,
  validate: isL1VideoIndexCacheRecord,
  logFailure: (info) => logError("[BILISCRIPT] failed to save L1 chapter index cache after eviction", info)
});

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
 *    由 `core/cache-lru.ts` 统一维持每族最近 3 个视频的 LRU 淘汰。
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
