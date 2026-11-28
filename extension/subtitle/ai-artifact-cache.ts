import {
  CacheWriteError,
  buildLruIndexEntryKey,
  listStorageKeysByPrefix,
  type CacheFamilyKeyFields,
  type CacheSaveResult
} from "../core/cache-lru.js";
import {
  YOUTUBE_UNIT_CID,
  isEncodedYoutubeStorageBvid,
  type SiteId
} from "../shared/site.js";
import {
  LEGACY_LOCAL_MIGRATION_DONE_META_KEY,
  parseAiArtifactKey,
  resolveVideoStorageIdentity,
  type AiArtifactFamily,
  type SubtitleIdbStore
} from "./idb-store.js";
import {
  registerSubtitleStoreResetHookForTests,
  resolveActiveSubtitleStore,
  resolveDirectSubtitleStore
} from "./store-client.js";

export interface AiArtifactFamilyOptions<TValue> {
  family: AiArtifactFamily;
  payloadField: string;
  toSourceKey: (subtitleId: unknown, subtitleUrl: unknown, lang: unknown) => string;
  validate?: (value: unknown) => boolean;
  logFailure?: (info: { key: string; error: unknown }) => void;
  directStore?: boolean;
}

export interface AiArtifactKeyFields extends CacheFamilyKeyFields {
  site?: SiteId | unknown;
}

export interface AiArtifactTargetMeta {
  bvid?: unknown;
  cid?: unknown;
  site?: SiteId | unknown;
}

export interface AiArtifactPrefixEntry<TValue> {
  key: string;
  payload: TValue;
  updatedAt: number;
}

export interface AiArtifactFamilyClient<TValue> {
  readonly prefix: AiArtifactFamily;
  key(fields: AiArtifactKeyFields, tail: unknown): string;
  load(key: string): Promise<TValue | null>;
  loadMany(keys: string[]): Promise<Array<TValue | null>>;
  loadByPrefix(
    bvid: string,
    keyPrefix: string,
    site?: SiteId | unknown
  ): Promise<Array<AiArtifactPrefixEntry<TValue>>>;
  save(key: string, value: TValue, meta?: AiArtifactTargetMeta): Promise<CacheSaveResult>;
  remove(key: string, meta?: AiArtifactTargetMeta): Promise<void>;
}

export interface AiArtifactBatchSpec<TValue = unknown> {
  key: string;
  family: AiArtifactFamily;
  payloadField: string;
  bvid?: string;
  cid?: string;
  site?: SiteId | unknown;
  validate?: (value: unknown) => boolean;
}

const MAX_REMEMBERED_KEY_META = 256;
const generatedKeyMeta = new Map<string, { bvid: string; cid: string }>();

registerSubtitleStoreResetHookForTests(() => {
  generatedKeyMeta.clear();
});

function rememberGeneratedKeyMeta(key: string, meta: { bvid: string; cid: string }): void {
  if (!key || !meta.bvid) {
    return;
  }
  if (generatedKeyMeta.has(key)) {
    generatedKeyMeta.delete(key);
  }
  generatedKeyMeta.set(key, meta);
  while (generatedKeyMeta.size > MAX_REMEMBERED_KEY_META) {
    const oldest = generatedKeyMeta.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    generatedKeyMeta.delete(oldest);
  }
}

function resolveArtifactWriteTarget(
  key: string,
  meta?: AiArtifactTargetMeta
): { bvid: string; cid: string } {
  const rawMetaBvid = String(meta?.bvid ?? "").trim();
  if (rawMetaBvid) {
    const resolved = resolveVideoStorageIdentity(rawMetaBvid, meta?.cid, meta?.site);
    return { bvid: resolved.bvid, cid: resolved.cid };
  }
  const remembered = generatedKeyMeta.get(key);
  if (remembered) {
    return remembered;
  }
  const parsed = parseAiArtifactKey(key);
  if (!parsed?.bvid) {
    return { bvid: "", cid: "" };
  }
  const resolved = resolveVideoStorageIdentity(parsed.bvid, parsed.cid, meta?.site);
  return { bvid: resolved.bvid, cid: resolved.cid };
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
  timestamp?: number,
  meta?: AiArtifactTargetMeta
): Promise<{ ok: boolean; bvid: string }> {
  const { bvid, cid } = resolveArtifactWriteTarget(key, meta);
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
  }
}

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
      const migrated = await tryWriteArtifactToIdb(
        store,
        spec.family,
        spec.key,
        extracted.value,
        extracted.timestamp,
        { bvid: spec.bvid, cid: spec.cid, site: spec.site }
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
      const resolved = resolveVideoStorageIdentity(fields.bvid, fields.cid, fields.site);
      const sourceKey = toSourceKey(fields.subtitleId, fields.subtitleUrl, fields.lang);
      const builtKey = `${family}${resolved.bvid}_${resolved.cid}_${sourceKey}_${String(tail)}`;
      rememberGeneratedKeyMeta(builtKey, { bvid: resolved.bvid, cid: resolved.cid });
      return builtKey;
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

    async loadByPrefix(bvid, keyPrefix, site) {
      const rawBvid = String(bvid || "").trim();
      const prefix = String(keyPrefix || "");
      if (!rawBvid || !prefix) {
        return [];
      }
      const parsedPrefix = parseAiArtifactKey(prefix);
      const effectiveSite =
        site !== undefined && site !== null && String(site).trim() !== ""
          ? site
          : parsedPrefix?.cid === YOUTUBE_UNIT_CID || isEncodedYoutubeStorageBvid(parsedPrefix?.bvid)
            ? "youtube"
            : undefined;
      const resolved = resolveVideoStorageIdentity(rawBvid, undefined, effectiveSite);
      const cleanBvid = resolved.bvid;

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
      }

      if (globalThis.chrome?.storage?.local) {
        try {
          const done = await store
            .getStoreMeta<{ version?: unknown }>(LEGACY_LOCAL_MIGRATION_DONE_META_KEY)
            .catch(() => null);
          if (done && Number(done.version) >= 2) {
            return Array.from(byKey.values());
          }
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
                keysToRemove.push(...legacyCleanupKeys(family, legacyKey, cleanBvid));
                continue;
              }
              const migrated = await tryWriteArtifactToIdb(
                store,
                family,
                legacyKey,
                extracted.value,
                extracted.timestamp,
                {
                  bvid: cleanBvid,
                  cid: parsedPrefix?.cid || (resolved.site === "youtube" ? YOUTUBE_UNIT_CID : ""),
                  site: resolved.site
                }
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
        }
      }

      return Array.from(byKey.values());
    },

    async save(key, value, meta) {
      const cleanKey = String(key || "").trim();
      const { bvid, cid } = resolveArtifactWriteTarget(cleanKey, meta);
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

    async remove(key, meta) {
      const cleanKey = String(key || "").trim();
      if (!cleanKey) {
        return;
      }
      try {
        await getStore().deleteAiArtifact(cleanKey);
      } catch {
      }
      const { bvid } = resolveArtifactWriteTarget(cleanKey, meta);
      await removeLegacyKeysSafe(legacyCleanupKeys(family, cleanKey, bvid));
    }
  };
}
