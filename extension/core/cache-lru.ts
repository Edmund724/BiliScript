import { logWarn } from "../shared/logging.js";

export const LRU_MANIFEST_STORAGE_KEY = "biliscript_cache_lru_index";
const LRU_INDEX_ENTRY_PREFIX = "biliscript_cache_lru_index:";
export function buildLruIndexEntryKey(family: string, bvid: string, cacheKey: string): string {
  return `${LRU_INDEX_ENTRY_PREFIX}${family}:${bvid}:${cacheKey}`;
}
export const CACHE_FAMILIES = [
  "biliscript_lvs_raw_",
  "biliscript_lvs_summary_",
  "biliscript_subtitle_cache_",
  "biliscript_lvs_analysis_",
  "biliscript_lvs_analysis_final_",
  "biliscript_lvs_l1_index_"
];
const LRU_KEEP_VIDEOS = 3;

export const FAMILY_KEEP_VIDEOS: Record<string, number> = {
  biliscript_lvs_l1_index_: 100,
  biliscript_lvs_analysis_final_: 100,
  biliscript_lvs_summary_: 20,
  biliscript_lvs_analysis_: 20,
  biliscript_subtitle_cache_: 3,
  biliscript_lvs_raw_: 3
};

export function getKeepVideosForFamily(family: string, explicitKeep?: number): number {
  if (explicitKeep !== undefined) {
    const parsed = Math.floor(Number(explicitKeep));
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed;
    }
  }
  return FAMILY_KEEP_VIDEOS[family] ?? LRU_KEEP_VIDEOS;
}

const FAMILIES_BY_PREFIX_LENGTH = [...CACHE_FAMILIES].sort((a, b) => b.length - a.length);

function familyOfCacheKey(key: string): string | null {
  return FAMILIES_BY_PREFIX_LENGTH.find((family) => key.startsWith(family)) || null;
}

type LruManifest = Record<string, Record<string, number>>;

export interface EvictionResult {
  ok: true;
}

export interface EvictionFailure {
  ok: false;
  error: CacheWriteError;
}

export class CacheWriteError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CacheWriteError";
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function parseBvidFromCacheKey(key: unknown, familyPrefix = ""): string {
  let rest = String(key == null ? "" : key);
  if (familyPrefix && rest.startsWith(familyPrefix)) {
    rest = rest.slice(familyPrefix.length);
  }
  const cut = rest.indexOf("_");
  return cut === -1 ? rest : rest.slice(0, cut);
}

type StorageAreaWithGetKeys = chrome.storage.StorageArea & {
  getKeys?: () => Promise<string[]>;
};

function requireStorageLocal(): StorageAreaWithGetKeys {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error("chrome.storage.local 不可用");
  }
  return globalThis.chrome.storage.local as StorageAreaWithGetKeys;
}

async function listAllStorageKeys(
  storage: StorageAreaWithGetKeys
): Promise<{ keys: string[]; snapshot: Record<string, unknown> | null }> {
  if (typeof storage.getKeys === "function") {
    const rawKeys = await storage.getKeys();
    const keys = Array.isArray(rawKeys)
      ? rawKeys.filter((key): key is string => typeof key === "string")
      : [];
    return { keys, snapshot: null };
  }
  const snapshot = (await storage.get(null)) || {};
  return { keys: Object.keys(snapshot), snapshot };
}

export async function listStorageKeysByPrefix(keyPrefix = ""): Promise<string[]> {
  const storage = requireStorageLocal();
  const { keys } = await listAllStorageKeys(storage);
  const prefix = typeof keyPrefix === "string" ? keyPrefix : "";
  return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
}

export async function getStorageItemsByPrefix(keyPrefix = ""): Promise<Record<string, unknown>> {
  const storage = requireStorageLocal();
  const { keys, snapshot } = await listAllStorageKeys(storage);
  const prefix = typeof keyPrefix === "string" ? keyPrefix : "";
  const matchedKeys = prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
  if (matchedKeys.length === 0) {
    return {};
  }
  if (snapshot !== null) {
    const out: Record<string, unknown> = {};
    for (const key of matchedKeys) {
      if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
        out[key] = snapshot[key];
      }
    }
    return out;
  }
  return (await storage.get(matchedKeys)) || {};
}

function normalizeEntryTs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === "object") {
    const ts = Number((value as { ts?: unknown }).ts);
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  return null;
}

async function readManifest(): Promise<LruManifest> {
  try {
    const result = await requireStorageLocal().get(LRU_MANIFEST_STORAGE_KEY);
    return normalizeManifest(result?.[LRU_MANIFEST_STORAGE_KEY]);
  } catch {
    return {};
  }
}

function normalizeManifest(raw: unknown): LruManifest {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const manifest: LruManifest = {};
  for (const [family, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const bvids: Record<string, number> = {};
    for (const [bvid, value] of Object.entries(entry as Record<string, unknown>)) {
      const ts = normalizeEntryTs(value);
      if (ts !== null) {
        bvids[bvid] = ts;
      }
    }
    manifest[family] = bvids;
  }
  return manifest;
}

function mergeManifestWrites(manifest: LruManifest, writes: Array<{ family: string; bvid: string; ts: number }>): LruManifest {
  const next: LruManifest = { ...manifest };
  for (const { family, bvid, ts } of writes) {
    next[family] = {
      ...(next[family] || {}),
      [bvid]: ts
    };
  }
  return next;
}

let indexFallbackWarned = false;

export async function readFamilyKeys(family: string, bvid: string, keyPrefix = ""): Promise<string[] | null> {
  let keys: string[];
  try {
    const entryPrefix = buildLruIndexEntryKey(family, bvid, "");
    const matchedIndexKeys = await listStorageKeysByPrefix(entryPrefix);
    keys = matchedIndexKeys
      .map((storageKey) => storageKey.slice(entryPrefix.length))
      .sort();
  } catch {
    keys = [];
  }
  if (keys.length === 0) {
    if (!indexFallbackWarned) {
      indexFallbackWarned = true;
      logWarn(`[BILISCRIPT] cache-lru index missing for family=${family} bvid=${bvid}, fallback to full storage scan`);
    }
    return null;
  }
  const prefix = typeof keyPrefix === "string" ? keyPrefix : "";
  return keys.filter((key) => !prefix || key.startsWith(prefix));
}

async function recordCacheWrites(
  writes: Array<{ family: string; bvid: string; cacheKeys: string[] }>,
  timestamp = Date.now(),
  manifestSnapshot: LruManifest = {}
): Promise<void> {
  const storage = requireStorageLocal();
  const items: Record<string, unknown> = {};
  const manifestWrites: Array<{ family: string; bvid: string; ts: number }> = [];
  for (const write of Array.isArray(writes) ? writes : []) {
    const entries: Record<string, { ts: number }> = {};
    for (const key of new Set(Array.isArray(write.cacheKeys) ? write.cacheKeys : [])) {
      if (key) {
        entries[buildLruIndexEntryKey(write.family, write.bvid, key)] = { ts: timestamp };
      }
    }
    Object.assign(items, entries);
    if (write.family && write.bvid) {
      manifestWrites.push({ family: write.family, bvid: write.bvid, ts: timestamp });
    }
  }
  if (manifestWrites.length > 0) {
    items[LRU_MANIFEST_STORAGE_KEY] = mergeManifestWrites(manifestSnapshot, manifestWrites);
  }
  await storage.set(items);
}

function parseIndexEntryKey(
  storageKey: string
): { family: string; bvid: string; cacheKey: string } | null {
  const rest = storageKey.slice(LRU_INDEX_ENTRY_PREFIX.length);
  const familyEnd = rest.indexOf(":");
  if (familyEnd <= 0) {
    return null;
  }
  const bvidEnd = rest.indexOf(":", familyEnd + 1);
  if (bvidEnd <= familyEnd + 1) {
    return null;
  }
  return {
    family: rest.slice(0, familyEnd),
    bvid: rest.slice(familyEnd + 1, bvidEnd),
    cacheKey: rest.slice(bvidEnd + 1)
  };
}

export async function pruneToRecentVideos(
  families: string[] = CACHE_FAMILIES,
  keep?: number
): Promise<Record<string, string[]>> {
  try {
    const storage = requireStorageLocal();
    const familyList = (Array.isArray(families) ? families : []).filter(
      (f): f is string => typeof f === "string" && Boolean(f)
    );
    if (familyList.length === 0) {
      return {};
    }

    const familySet = new Set(familyList);
    const { keys: allKeys, snapshot } = await listAllStorageKeys(storage);

    let metaValues: Record<string, unknown>;
    if (snapshot !== null) {
      metaValues = snapshot;
    } else {
      const metaKeys: string[] = [];
      for (const storageKey of allKeys) {
        if (storageKey === LRU_MANIFEST_STORAGE_KEY) {
          metaKeys.push(storageKey);
          continue;
        }
        if (storageKey.startsWith(LRU_INDEX_ENTRY_PREFIX)) {
          const parsed = parseIndexEntryKey(storageKey);
          if (parsed && familySet.has(parsed.family)) {
            metaKeys.push(storageKey);
          }
        }
      }
      metaValues = metaKeys.length > 0 ? (await storage.get(metaKeys)) || {} : {};
    }

    const manifest = normalizeManifest(metaValues?.[LRU_MANIFEST_STORAGE_KEY]);

    const indexed = new Map<string, Map<string, { ts: number; keys: Set<string> }>>();
    for (const storageKey of allKeys) {
      if (!storageKey.startsWith(LRU_INDEX_ENTRY_PREFIX)) {
        continue;
      }
      const parsed = parseIndexEntryKey(storageKey);
      if (!parsed || !familySet.has(parsed.family)) {
        continue;
      }
      const ts = normalizeEntryTs(metaValues[storageKey]);
      if (ts === null) {
        continue;
      }
      let familyMap = indexed.get(parsed.family);
      if (!familyMap) {
        familyMap = new Map();
        indexed.set(parsed.family, familyMap);
      }
      let entry = familyMap.get(parsed.bvid);
      if (!entry) {
        entry = { ts, keys: new Set() };
        familyMap.set(parsed.bvid, entry);
      }
      entry.ts = Math.max(entry.ts, ts);
      entry.keys.add(parsed.cacheKey);
    }

    const keysToRemove: string[] = [];
    const removed: Record<string, string[]> = {};
    const manifestRewrite: Record<string, Record<string, number>> = {};
    for (const family of familyList) {
      const familyIndexed = indexed.get(family);
      const familyManifest = manifest[family] || {};
      const timestamps = new Map<string, number>();
      if (familyIndexed) {
        for (const [bvid, entry] of familyIndexed) {
          timestamps.set(bvid, Math.max(entry.ts, familyManifest[bvid] ?? 0));
        }
      }
      const candidateKeys = new Set<string>();
      if (familyIndexed) {
        for (const entry of familyIndexed.values()) {
          for (const key of entry.keys) {
            candidateKeys.add(key);
          }
        }
      }
      for (const key of allKeys) {
        if (!key.startsWith(family) || familyOfCacheKey(key) !== family) {
          continue;
        }
        candidateKeys.add(key);
        const bvid = parseBvidFromCacheKey(key, family);
        if (bvid && !timestamps.has(bvid)) {
          timestamps.set(bvid, familyManifest[bvid] ?? 0);
        }
      }
      if (candidateKeys.size === 0 && Object.keys(familyManifest).length === 0) {
        continue;
      }

      const familyKeep = getKeepVideosForFamily(family, keep);
      const ranked = [...timestamps.entries()].sort((a, b) => b[1] - a[1]);
      const keepSet = new Set(ranked.slice(0, familyKeep).map(([bvid]) => bvid));
      const familyRemoved = [...candidateKeys].filter((key) => {
        const bvid = parseBvidFromCacheKey(key, family);
        return !bvid || !keepSet.has(bvid);
      });
      manifestRewrite[family] = Object.fromEntries(ranked.filter(([bvid]) => keepSet.has(bvid)));
      if (familyRemoved.length === 0) {
        continue;
      }
      removed[family] = familyRemoved;
      keysToRemove.push(...familyRemoved);
      for (const [bvid] of ranked) {
        if (keepSet.has(bvid)) {
          continue;
        }
        const entryPrefix = buildLruIndexEntryKey(family, bvid, "");
        for (const storageKey of allKeys) {
          if (storageKey.startsWith(entryPrefix)) {
            keysToRemove.push(storageKey);
          }
        }
      }
    }

    if (keysToRemove.length > 0) {
      await storage.remove(keysToRemove);
      try {
        await storage.set({ [LRU_MANIFEST_STORAGE_KEY]: { ...manifest, ...manifestRewrite } });
      } catch {
      }
    }
    return removed;
  } catch {
    return {};
  }
}

function familiesWithinKeep(manifest: LruManifest, families: string[], keep?: number): boolean {
  const familyList = (Array.isArray(families) ? families : []).filter(
    (f): f is string => typeof f === "string" && Boolean(f)
  );
  return familyList.every(
    (family) => Object.keys(manifest[family] || {}).length <= getKeepVideosForFamily(family, keep)
  );
}

interface WriteWithEvictionOptions {
  family?: string;
  bvid?: string;
  write?: () => Promise<void>;
  keys?: string[];
  keep?: number;
  pruneFamilies?: string[];
}

export interface CacheWriteBundleEntry {
  family: string;
  bvid: string;
  cacheKeys: string[];
}

export async function writeBundleWithEviction(
  entries: CacheWriteBundleEntry[],
  write: () => Promise<void>,
  { keep, pruneFamilies = CACHE_FAMILIES }: { keep?: number; pruneFamilies?: string[] } = {}
): Promise<EvictionResult | EvictionFailure> {
  const bundle = (Array.isArray(entries) ? entries : []).filter(
    (entry): entry is CacheWriteBundleEntry =>
      Boolean(entry) && typeof entry.family === "string" && typeof entry.bvid === "string"
  );
  if (bundle.length === 0) {
    return { ok: false, error: new CacheWriteError("writeBundleWithEviction：entries 不能为空") };
  }
  if (typeof write !== "function") {
    return { ok: false, error: new CacheWriteError("writeBundleWithEviction：write 必须是函数") };
  }

  const timestamp = Date.now();
  const attempt = async () => {
    const manifestSnapshot = await readManifest();
    await recordCacheWrites(bundle, timestamp, manifestSnapshot);
    await write();
    return manifestSnapshot;
  };

  let manifestSnapshot: LruManifest;
  try {
    manifestSnapshot = await attempt();
  } catch (firstError) {
    await pruneToRecentVideos(pruneFamilies, keep);
    try {
      manifestSnapshot = await attempt();
    } catch (retryError) {
      return {
        ok: false,
        error: new CacheWriteError(
          `缓存写入失败（已淘汰旧视频后重试仍失败）：${(retryError as Error | undefined)?.message || retryError}`,
          retryError
        )
      };
    }
  }

  const manifestWrites = bundle
    .filter((entry) => entry.family && entry.bvid)
    .map((entry) => ({ family: entry.family, bvid: entry.bvid, ts: timestamp }));
  if (!familiesWithinKeep(mergeManifestWrites(manifestSnapshot, manifestWrites), pruneFamilies, keep)) {
    await pruneToRecentVideos(pruneFamilies, keep);
  }
  return { ok: true };
}

export async function writeWithEviction({
  family = "",
  bvid = "",
  write,
  keys = [],
  keep,
  pruneFamilies = CACHE_FAMILIES
}: WriteWithEvictionOptions = {}): Promise<EvictionResult | EvictionFailure> {
  if (typeof write !== "function") {
    return { ok: false, error: new CacheWriteError("writeWithEviction：write 必须是函数") };
  }
  return writeBundleWithEviction([{ family, bvid, cacheKeys: keys }], write, { keep, pruneFamilies });
}

export type CacheSaveResult = EvictionResult | EvictionFailure;

export interface CacheFamilyOptions<TValue> {
  prefix: string;
  payloadField: string;
  toSourceKey: (subtitleId: unknown, subtitleUrl: unknown, lang: unknown) => string;
  validate?: (value: unknown) => boolean;
  logFailure?: (info: { key: string; error: unknown }) => void;
}

export interface CacheFamilyKeyFields {
  bvid?: unknown;
  cid?: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  lang?: unknown;
}

export interface CacheFamily<TValue> {
  readonly prefix: string;
  key(fields: CacheFamilyKeyFields, tail: unknown): string;
  load(key: string): Promise<TValue | null>;
  loadMany(keys: string[]): Promise<(TValue | null)[]>;
  save(key: string, value: TValue): Promise<CacheSaveResult>;
}

export function createCacheFamily<TValue>(options: CacheFamilyOptions<TValue>): CacheFamily<TValue> {
  const { prefix, payloadField, toSourceKey, validate, logFailure } = options;
  function readPayload(all: Record<string, unknown>, key: string): TValue | null {
    const value = (all[key] as Record<string, unknown> | undefined)?.[payloadField];
    if (value == null) {
      return null;
    }
    if (validate && !validate(value)) {
      return null;
    }
    return value as TValue;
  }
  return {
    prefix,
    key(fields, tail) {
      const sourceKey = toSourceKey(fields.subtitleId, fields.subtitleUrl, fields.lang);
      return `${prefix}${fields.bvid}_${fields.cid}_${sourceKey}_${String(tail)}`;
    },
    async load(key) {
      try {
        return readPayload(await requireStorageLocal().get(key), key);
      } catch {
        return null;
      }
    },
    async loadMany(keys) {
      const list = (Array.isArray(keys) ? keys : []).filter((key) => typeof key === "string" && Boolean(key));
      if (list.length === 0) {
        return [];
      }
      try {
        const all = await requireStorageLocal().get(list);
        return list.map((key) => readPayload(all, key));
      } catch {
        return list.map(() => null);
      }
    },
    async save(key, value) {
      const result = await writeWithEviction({
        family: prefix,
        bvid: parseBvidFromCacheKey(key, prefix),
        keys: [key],
        write: () =>
          requireStorageLocal().set({
            [key]: {
              [payloadField]: value,
              timestamp: Date.now()
            }
          })
      });
      if (!result.ok) {
        logFailure?.({ key, error: result.error?.message || result.error });
      }
      return result;
    }
  };
}
