// extension/subtitle/ai-artifact-cache.ts
// AI 派生产物（L1 索引、整份概览、概览分段、分段小结）的 IndexedDB 缓存族与读路径懒迁移：
// - 内容脚本上下文经 `store-client.ts` 走 SW `subtitle-cache` RPC，严禁网页源直连 indexedDB；
// - SW / 扩展页 / 单测直连 `SubtitleIdbStore`（`ai_artifacts` ObjectStore）；
// - 读路径懒迁移严格遵守「先写后删」：IDB 未命中时读旧 `chrome.storage.local`，先成功写入 IDB
//   确认无异常后再删除旧数据键与分键 LRU 索引；若 IDB 写失败则保留旧键并优雅返回旧数据。

import {
  CacheWriteError,
  buildLruIndexEntryKey,
  listStorageKeysByPrefix,
  type CacheFamilyKeyFields,
  type CacheSaveResult
} from "../core/cache-lru.js";
import { parseAiArtifactKey, type AiArtifactFamily, type SubtitleIdbStore } from "./idb-store.js";
import { resolveActiveSubtitleStore, resolveDirectSubtitleStore } from "./store-client.js";

export interface AiArtifactFamilyOptions<TValue> {
  family: AiArtifactFamily;
  /** 旧 chrome.storage.local 封包里的 payload 字段名（{ [payloadField]: value, timestamp }）。 */
  payloadField: string;
  toSourceKey: (subtitleId: unknown, subtitleUrl: unknown, lang: unknown) => string;
  validate?: (value: unknown) => boolean;
  logFailure?: (info: { key: string; error: unknown }) => void;
  /** SW 专用调用方（如 ai/segment-cache.ts）置 true，直连本地 IDB，绝不经 runtime.sendMessage 自调。 */
  directStore?: boolean;
}

export interface AiArtifactPrefixEntry<TValue> {
  key: string;
  payload: TValue;
  updatedAt: number;
}

export interface AiArtifactFamilyClient<TValue> {
  readonly prefix: AiArtifactFamily;
  key(fields: CacheFamilyKeyFields, tail: unknown): string;
  load(key: string): Promise<TValue | null>;
  loadMany(keys: string[]): Promise<Array<TValue | null>>;
  loadByPrefix(bvid: string, keyPrefix: string): Promise<Array<AiArtifactPrefixEntry<TValue>>>;
  save(key: string, value: TValue): Promise<CacheSaveResult>;
  remove(key: string): Promise<void>;
}

export interface AiArtifactBatchSpec<TValue = unknown> {
  key: string;
  family: AiArtifactFamily;
  payloadField: string;
  validate?: (value: unknown) => boolean;
}

function readLegacyEnvelope<TValue>(
  envelope: unknown,
  payloadField: string,
  validate?: (value: unknown) => boolean
): { value: TValue; timestamp?: number } | null {
  if (!envelope || typeof envelope !== "object") {
    return null;
  }
  const value = (envelope as Record<string, unknown>)[payloadField];
  if (value === undefined || value === null) {
    return null;
  }
  if (validate && !validate(value)) {
    return null;
  }
  const rawTs = Number((envelope as { timestamp?: unknown }).timestamp);
  const timestamp = Number.isFinite(rawTs) && rawTs > 0 ? rawTs : undefined;
  return { value: value as TValue, timestamp };
}

function legacyCleanupKeys(family: AiArtifactFamily, key: string, bvid: string): string[] {
  return bvid ? [key, buildLruIndexEntryKey(family, bvid, key)] : [key];
}

async function tryWriteArtifactToIdb(
  store: SubtitleIdbStore,
  family: AiArtifactFamily,
  key: string,
  payload: unknown,
  timestamp?: number
): Promise<{ ok: boolean; bvid: string }> {
  const parsed = parseAiArtifactKey(key);
  const bvid = parsed?.bvid ?? "";
  const cid = parsed?.cid ?? "";
  if (!bvid) {
    return { ok: false, bvid: "" };
  }
  try {
    const res = await store.putAiArtifact({
      key,
      family,
      bvid,
      cid,
      payload,
      ...(timestamp !== undefined ? { createdAt: timestamp, updatedAt: timestamp } : {})
    });
    return { ok: res.ok === true, bvid };
  } catch {
    return { ok: false, bvid };
  }
}

async function removeLegacyKeysSafe(keys: string[]): Promise<void> {
  if (keys.length === 0 || !globalThis.chrome?.storage?.local) {
    return;
  }
  try {
    await chrome.storage.local.remove(keys);
  } catch {
    // 清理旧键失败不影响已写入 IDB 的结果
  }
}

/**
 * 单趟批量读取多族 AI 产物（如 `readCachedClipOverviewArtifacts` 同时读 `finalKey` 与 `l1Key`）：
 * 优先一次 IDB/RPC 批量读取；仅对未命中的键回查旧 `chrome.storage.local` 并执行先写后删懒迁移。
 */
export async function loadAiArtifactsBatch(
  specs: readonly AiArtifactBatchSpec[],
  options: { directStore?: boolean } = {}
): Promise<Array<unknown | null>> {
  if (!Array.isArray(specs) || specs.length === 0) {
    return [];
  }
  const store = options.directStore ? resolveDirectSubtitleStore() : resolveActiveSubtitleStore();
  const keys = specs.map((spec) => spec.key);
  const results: Array<unknown | null> = specs.map(() => null);
  const missedIndices: number[] = [];

  try {
    const idbHits = await store.getAiArtifactsMany(keys);
    for (let i = 0; i < specs.length; i += 1) {
      const hit = idbHits[i];
      const spec = specs[i];
      if (
        hit &&
        hit.payload !== undefined &&
        hit.payload !== null &&
        (!spec.validate || spec.validate(hit.payload))
      ) {
        results[i] = hit.payload;
      } else {
        missedIndices.push(i);
      }
    }
  } catch {
    for (let i = 0; i < specs.length; i += 1) {
      missedIndices.push(i);
    }
  }

  if (missedIndices.length === 0 || !globalThis.chrome?.storage?.local) {
    return results;
  }

  try {
    const missedKeys = missedIndices.map((idx) => specs[idx].key);
    const legacyStored = (await chrome.storage.local.get(missedKeys)) || {};
    const keysToRemove: string[] = [];

    for (const idx of missedIndices) {
      const spec = specs[idx];
      const extracted = readLegacyEnvelope(legacyStored[spec.key], spec.payloadField, spec.validate);
      if (!extracted) {
        continue;
      }
      // 先写后删：确认写入 IDB 无异常后再将旧键及分键 LRU 索引加入删除队列
      const migrated = await tryWriteArtifactToIdb(
        store,
        spec.family,
        spec.key,
        extracted.value,
        extracted.timestamp
      );
      if (migrated.ok) {
        keysToRemove.push(...legacyCleanupKeys(spec.family, spec.key, migrated.bvid));
      }
      results[idx] = extracted.value;
    }

    if (keysToRemove.length > 0) {
      await removeLegacyKeysSafe(keysToRemove);
    }
  } catch {
    // 遗留读失败保持已命中的 IDB 结果
  }

  return results;
}

export function createAiArtifactFamily<TValue>(
  options: AiArtifactFamilyOptions<TValue>
): AiArtifactFamilyClient<TValue> {
  const { family, payloadField, toSourceKey, validate, logFailure, directStore = false } = options;

  function getStore(): SubtitleIdbStore {
    return directStore ? resolveDirectSubtitleStore() : resolveActiveSubtitleStore();
  }

  function isValidPayload(value: unknown): value is TValue {
    if (value === undefined || value === null) {
      return false;
    }
    return validate ? validate(value) : true;
  }

  return {
    prefix: family,

    key(fields, tail) {
      const sourceKey = toSourceKey(fields.subtitleId, fields.subtitleUrl, fields.lang);
      return `${family}${fields.bvid}_${fields.cid}_${sourceKey}_${String(tail)}`;
    },

    async load(key) {
      const cleanKey = String(key || "").trim();
      if (!cleanKey) {
        return null;
      }
      const store = getStore();
      try {
        const hit = await store.getAiArtifact<TValue>(cleanKey);
        if (hit && isValidPayload(hit.payload)) {
          return hit.payload;
        }
      } catch {
        // IDB 读异常时回退检查旧 storage.local
      }

      if (!globalThis.chrome?.storage?.local) {
        return null;
      }
      try {
        const stored = (await chrome.storage.local.get(cleanKey)) || {};
        const extracted = readLegacyEnvelope<TValue>(stored[cleanKey], payloadField, validate);
        if (!extracted) {
          return null;
        }
        const migrated = await tryWriteArtifactToIdb(
          store,
          family,
          cleanKey,
          extracted.value,
          extracted.timestamp
        );
        if (migrated.ok) {
          await removeLegacyKeysSafe(legacyCleanupKeys(family, cleanKey, migrated.bvid));
        }
        return extracted.value;
      } catch {
        return null;
      }
    },

    async loadMany(keys) {
      const list = (Array.isArray(keys) ? keys : []).filter(
        (key): key is string => typeof key === "string" && Boolean(key)
      );
      if (list.length === 0) {
        return [];
      }
      const batch = await loadAiArtifactsBatch(
        list.map((key) => ({
          key,
          family,
          payloadField,
          validate
        })),
        { directStore }
      );
      return batch as Array<TValue | null>;
    },

    async loadByPrefix(bvid, keyPrefix) {
      const cleanBvid = String(bvid || "").trim();
      const prefix = String(keyPrefix || "");
      if (!cleanBvid || !prefix) {
        return [];
      }

      const store = getStore();
      const byKey = new Map<string, AiArtifactPrefixEntry<TValue>>();

      try {
        const idbRecords = await store.listAiArtifactsByFamilyBvid(family, cleanBvid, prefix);
        for (const record of idbRecords) {
          if (isValidPayload(record.payload)) {
            byKey.set(record.key, {
              key: record.key,
              payload: record.payload,
              updatedAt: record.updatedAt
            });
          }
        }
      } catch {
        // IDB 读异常时仍尝试兼容扫描旧 storage.local
      }

      if (globalThis.chrome?.storage?.local) {
        try {
          const matchedLegacyKeys = (await listStorageKeysByPrefix(prefix)).filter((k) =>
            k.startsWith(prefix)
          );
          if (matchedLegacyKeys.length > 0) {
            const legacyItems = (await chrome.storage.local.get(matchedLegacyKeys)) || {};
            const keysToRemove: string[] = [];
            for (const legacyKey of matchedLegacyKeys) {
              const extracted = readLegacyEnvelope<TValue>(
                legacyItems[legacyKey],
                payloadField,
                validate
              );
              if (!extracted) {
                continue;
              }
              if (byKey.has(legacyKey)) {
                // IDB 已有同键数据，直接清理遗留重复副本
                keysToRemove.push(...legacyCleanupKeys(family, legacyKey, cleanBvid));
                continue;
              }
              const migrated = await tryWriteArtifactToIdb(
                store,
                family,
                legacyKey,
                extracted.value,
                extracted.timestamp
              );
              if (migrated.ok) {
                keysToRemove.push(...legacyCleanupKeys(family, legacyKey, migrated.bvid || cleanBvid));
              }
              byKey.set(legacyKey, {
                key: legacyKey,
                payload: extracted.value,
                updatedAt: extracted.timestamp ?? 0
              });
            }
            if (keysToRemove.length > 0) {
              await removeLegacyKeysSafe(keysToRemove);
            }
          }
        } catch {
          // 遗留扫描失败不丢弃已命中的 IDB 数据
        }
      }

      return Array.from(byKey.values());
    },

    async save(key, value) {
      const cleanKey = String(key || "").trim();
      const parsed = parseAiArtifactKey(cleanKey);
      const bvid = parsed?.bvid ?? "";
      const cid = parsed?.cid ?? "";
      try {
        const res = await getStore().putAiArtifact({
          key: cleanKey,
          family,
          bvid,
          cid,
          payload: value
        });
        if (res.ok) {
          return { ok: true };
        }
        const err = new CacheWriteError(res.error?.message || "写入 AI 产物缓存失败", res.error);
        logFailure?.({ key: cleanKey, error: err.message });
        return { ok: false, error: err };
      } catch (error) {
        const err = new CacheWriteError((error as Error)?.message || String(error), error);
        logFailure?.({ key: cleanKey, error: err.message });
        return { ok: false, error: err };
      }
    },

    async remove(key) {
      const cleanKey = String(key || "").trim();
      if (!cleanKey) {
        return;
      }
      try {
        await getStore().deleteAiArtifact(cleanKey);
      } catch {
        // 忽略 IDB 删除错误
      }
      const parsed = parseAiArtifactKey(cleanKey);
      await removeLegacyKeysSafe(legacyCleanupKeys(family, cleanKey, parsed?.bvid ?? ""));
    }
  };
}
