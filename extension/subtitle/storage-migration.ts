// extension/subtitle/storage-migration.ts
// 启动 / 安装 / 更新一次性幂等迁移：
// 分批将旧 `chrome.storage.local` 中的历史 `biliscript_lvs_*` AI 产物与 `biliscript_subtitle_cache_*`
// 遗留字幕键迁入 IndexedDB v2（`subtitle_pages` + `ai_artifacts`），严格遵守先写后删：
// - 每批先成功写入 IDB，确认无异常后再删除该批旧数据键及对应分键 LRU 索引；
// - 任一条写入失败时保留对应旧键，且不落完成标记，下次启动安全续跑；
// - 全部完成后清理已退役族的残余 LRU 索引条目与汇总清单，再写完成标记保护后续启动零扫描。

import {
  CACHE_FAMILIES,
  LRU_MANIFEST_STORAGE_KEY,
  buildLruIndexEntryKey,
  listStorageKeysByPrefix,
  parseBvidFromCacheKey
} from "../core/cache-lru.js";
import { isL1VideoIndexCacheRecord } from "../ai/l1-directory.js";
import {
  defaultSubtitleIdbStore,
  parseAiArtifactKey,
  type AiArtifactFamily,
  type SubtitleIdbStore
} from "./idb-store.js";
import { SUBTITLE_CACHE_KEY_PREFIX, parseSubtitleCacheKey } from "./legacy-key.js";

export const STORAGE_TO_IDB_MIGRATION_DONE_KEY = "biliscript_idb_v2_migration_done";
export const DEFAULT_MIGRATION_BATCH_SIZE = 20;

const LEGACY_RAW_PREFIX = "biliscript_lvs_raw_";
const LRU_INDEX_ENTRY_PREFIX = "biliscript_cache_lru_index:";

export interface LegacyStorageMigrationOptions {
  store?: SubtitleIdbStore;
  batchSize?: number;
  now?: () => number;
  force?: boolean;
}

export interface LegacyStorageMigrationResult {
  skipped: boolean;
  completed: boolean;
  migratedArtifacts: number;
  migratedSubtitles: number;
  removedLegacyKeys: number;
  failedKeys: string[];
}

function isOverviewAnalysisShape(value: unknown): boolean {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as { chapters?: unknown }).chapters) &&
      Array.isArray((value as { quotes?: unknown }).quotes)
  );
}

function extractAiArtifactPayload(
  family: AiArtifactFamily,
  envelope: unknown
): { valid: true; payload: unknown; timestamp?: number } | { valid: false } {
  if (!envelope || typeof envelope !== "object") {
    return { valid: false };
  }
  const obj = envelope as Record<string, unknown>;
  const rawTs = Number(obj.timestamp);
  const timestamp = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : undefined;

  if (family === "biliscript_lvs_l1_index_") {
    return isL1VideoIndexCacheRecord(obj.index)
      ? { valid: true, payload: obj.index, timestamp }
      : { valid: false };
  }
  if (family === "biliscript_lvs_analysis_final_" || family === "biliscript_lvs_analysis_") {
    return isOverviewAnalysisShape(obj.analysis)
      ? { valid: true, payload: obj.analysis, timestamp }
      : { valid: false };
  }
  if (family === "biliscript_lvs_summary_") {
    return typeof obj.summary === "string"
      ? { valid: true, payload: obj.summary, timestamp }
      : { valid: false };
  }
  return { valid: false };
}

function chunkKeys(keys: readonly string[], batchSize: number): string[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: string[][] = [];
  for (let i = 0; i < keys.length; i += size) {
    batches.push(keys.slice(i, i + size));
  }
  return batches;
}

function collectKeyWithIndex(
  target: string[],
  removedSet: Set<string>,
  allKeysSet: Set<string>,
  family: string,
  bvid: string,
  dataKey: string
): void {
  if (!removedSet.has(dataKey)) {
    removedSet.add(dataKey);
    target.push(dataKey);
  }
  if (family && bvid) {
    const idxKey = buildLruIndexEntryKey(family, bvid, dataKey);
    if (allKeysSet.has(idxKey) && !removedSet.has(idxKey)) {
      removedSet.add(idxKey);
      target.push(idxKey);
    }
  }
}

let inflightDefaultMigration: Promise<LegacyStorageMigrationResult> | null = null;

async function runMigration(
  options: LegacyStorageMigrationOptions
): Promise<LegacyStorageMigrationResult> {
  const storage = globalThis.chrome?.storage?.local;
  if (!storage) {
    return {
      skipped: true,
      completed: false,
      migratedArtifacts: 0,
      migratedSubtitles: 0,
      removedLegacyKeys: 0,
      failedKeys: []
    };
  }

  const store = options.store ?? defaultSubtitleIdbStore;
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_MIGRATION_BATCH_SIZE));
  const now = options.now ?? (() => Date.now());

  if (!options.force) {
    const marker = await storage.get(STORAGE_TO_IDB_MIGRATION_DONE_KEY);
    const done = marker?.[STORAGE_TO_IDB_MIGRATION_DONE_KEY] as { version?: unknown } | undefined;
    if (done && Number(done.version) >= 2) {
      return {
        skipped: true,
        completed: true,
        migratedArtifacts: 0,
        migratedSubtitles: 0,
        removedLegacyKeys: 0,
        failedKeys: []
      };
    }
  }

  const allKeys = await listStorageKeysByPrefix("");
  const allKeysSet = new Set(allKeys);

  const aiKeys: string[] = [];
  const subtitleKeys: string[] = [];
  const obsoleteRawKeys: string[] = [];

  for (const key of allKeys) {
    if (key.startsWith(LRU_INDEX_ENTRY_PREFIX) || key === LRU_MANIFEST_STORAGE_KEY) {
      continue;
    }
    if (parseAiArtifactKey(key)) {
      aiKeys.push(key);
    } else if (key.startsWith(SUBTITLE_CACHE_KEY_PREFIX)) {
      subtitleKeys.push(key);
    } else if (key.startsWith(LEGACY_RAW_PREFIX)) {
      obsoleteRawKeys.push(key);
    }
  }

  let migratedArtifacts = 0;
  let migratedSubtitles = 0;
  let removedLegacyKeys = 0;
  const failedKeys: string[] = [];
  const removedSet = new Set<string>();

  // 1) 分批迁移 AI 产物与遗留字幕键（先写 IDB 确认成功，再删同批旧键与分键 LRU 索引）
  const dataKeys = [...aiKeys, ...subtitleKeys];
  for (const batch of chunkKeys(dataKeys, batchSize)) {
    const values = (await storage.get(batch)) || {};
    const keysToRemove: string[] = [];

    for (const key of batch) {
      const parsedAi = parseAiArtifactKey(key);
      if (parsedAi) {
        const extracted = extractAiArtifactPayload(parsedAi.family, values[key]);
        if (extracted.valid) {
          const writeRes = await store.putAiArtifact({
            key,
            family: parsedAi.family,
            bvid: parsedAi.bvid,
            cid: parsedAi.cid,
            payload: extracted.payload,
            ...(extracted.timestamp !== undefined
              ? {
                  createdAt: extracted.timestamp,
                  updatedAt: extracted.timestamp,
                  lastUsedAt: extracted.timestamp
                }
              : {})
          });
          if (writeRes.ok) {
            migratedArtifacts += 1;
            collectKeyWithIndex(
              keysToRemove,
              removedSet,
              allKeysSet,
              parsedAi.family,
              parsedAi.bvid,
              key
            );
          } else {
            failedKeys.push(key);
          }
        } else {
          // 损坏或无法解析封包：作为垃圾键清理，不阻塞迁移完成
          collectKeyWithIndex(
            keysToRemove,
            removedSet,
            allKeysSet,
            parsedAi.family,
            parsedAi.bvid,
            key
          );
        }
        continue;
      }

      if (key.startsWith(SUBTITLE_CACHE_KEY_PREFIX)) {
        const parsedSub = parseSubtitleCacheKey(key);
        const body = (values[key] as { body?: unknown } | undefined)?.body;
        if (parsedSub && Array.isArray(body) && body.length > 0) {
          const writeRes =
            parsedSub.kind === "translated"
              ? await store.upsertTranslatedTrack({
                  bvid: parsedSub.bvid,
                  cid: parsedSub.cid,
                  sourceTrackKey: parsedSub.sourceTrackKey,
                  targetLang: parsedSub.targetLang,
                  translationSig: "legacy",
                  items: body
                })
              : await store.putRawTrack({
                  bvid: parsedSub.bvid,
                  cid: parsedSub.cid,
                  trackKey: parsedSub.trackKey,
                  items: body
                });
          if (writeRes.ok) {
            migratedSubtitles += 1;
            collectKeyWithIndex(
              keysToRemove,
              removedSet,
              allKeysSet,
              SUBTITLE_CACHE_KEY_PREFIX,
              parsedSub.bvid,
              key
            );
          } else {
            failedKeys.push(key);
          }
        } else {
          const bvid = parseBvidFromCacheKey(key, SUBTITLE_CACHE_KEY_PREFIX);
          collectKeyWithIndex(
            keysToRemove,
            removedSet,
            allKeysSet,
            SUBTITLE_CACHE_KEY_PREFIX,
            bvid,
            key
          );
        }
      }
    }

    if (keysToRemove.length > 0) {
      await storage.remove(keysToRemove);
      removedLegacyKeys += keysToRemove.length;
    }
  }

  // 2) 分批清理已废弃的 biliscript_lvs_raw_* 遗留原始段键
  for (const batch of chunkKeys(obsoleteRawKeys, batchSize)) {
    const keysToRemove: string[] = [];
    for (const key of batch) {
      const bvid = parseBvidFromCacheKey(key, LEGACY_RAW_PREFIX);
      collectKeyWithIndex(keysToRemove, removedSet, allKeysSet, LEGACY_RAW_PREFIX, bvid, key);
    }
    if (keysToRemove.length > 0) {
      await storage.remove(keysToRemove);
      removedLegacyKeys += keysToRemove.length;
    }
  }

  if (failedKeys.length > 0) {
    return {
      skipped: false,
      completed: false,
      migratedArtifacts,
      migratedSubtitles,
      removedLegacyKeys,
      failedKeys
    };
  }

  // 3) 清理已退役缓存族的残余孤儿分键 LRU 索引与汇总清单
  const retiredIndexPrefixes = CACHE_FAMILIES.map(
    (family) => `${LRU_INDEX_ENTRY_PREFIX}${family}:`
  );
  const orphanIndexKeys = allKeys.filter(
    (key) =>
      !removedSet.has(key) &&
      retiredIndexPrefixes.some((prefix) => key.startsWith(prefix))
  );
  for (const batch of chunkKeys(orphanIndexKeys, batchSize)) {
    await storage.remove(batch);
    removedLegacyKeys += batch.length;
  }

  if (allKeysSet.has(LRU_MANIFEST_STORAGE_KEY)) {
    const manifestWrap = (await storage.get(LRU_MANIFEST_STORAGE_KEY)) || {};
    const manifest = manifestWrap[LRU_MANIFEST_STORAGE_KEY];
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      const remaining: Record<string, unknown> = {};
      const retiredSet = new Set<string>(CACHE_FAMILIES);
      for (const [family, value] of Object.entries(manifest as Record<string, unknown>)) {
        if (!retiredSet.has(family)) {
          remaining[family] = value;
        }
      }
      if (Object.keys(remaining).length === 0) {
        await storage.remove(LRU_MANIFEST_STORAGE_KEY);
        removedLegacyKeys += 1;
      } else {
        await storage.set({ [LRU_MANIFEST_STORAGE_KEY]: remaining });
      }
    } else {
      await storage.remove(LRU_MANIFEST_STORAGE_KEY);
      removedLegacyKeys += 1;
    }
  }

  // 4) 仅在全部迁移与清理无失败时落完成标记
  await storage.set({
    [STORAGE_TO_IDB_MIGRATION_DONE_KEY]: {
      version: 2,
      completedAt: now()
    }
  });

  return {
    skipped: false,
    completed: true,
    migratedArtifacts,
    migratedSubtitles,
    removedLegacyKeys,
    failedKeys: []
  };
}

export async function migrateLegacyLocalStorageToIdb(
  options: LegacyStorageMigrationOptions = {}
): Promise<LegacyStorageMigrationResult> {
  const isDefaultCall = !options.store && !options.force && options.batchSize === undefined && !options.now;
  if (isDefaultCall && inflightDefaultMigration) {
    return inflightDefaultMigration;
  }
  const promise = runMigration(options);
  if (isDefaultCall) {
    inflightDefaultMigration = promise;
    try {
      return await promise;
    } finally {
      if (inflightDefaultMigration === promise) {
        inflightDefaultMigration = null;
      }
    }
  }
  return promise;
}
