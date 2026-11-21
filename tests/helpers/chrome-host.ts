import { vi } from "vitest";
import { buildLruIndexEntryKey, LRU_MANIFEST_STORAGE_KEY } from "../../extension/core/cache-lru.js";
import {
  createMemoryStorageArea,
  type CacheEntry,
  type ChromeHostStorageArea,
  type MemoryAreaHooks
} from "./memory-storage-area.js";

export { createMemoryStorageArea };
export type { CacheEntry, ChromeHostStorageArea, MemoryAreaHooks } from "./memory-storage-area.js";

export interface ChromeHost {
  local: ChromeHostStorageArea;
  sync: ChromeHostStorageArea;
  map: Map<string, unknown>;
  syncMap: Map<string, unknown>;
  snapshot(): Record<string, unknown>;
  readEntry(key: string): CacheEntry | undefined;
  hasEntry(key: string): boolean;
  seedCacheEntry(key: string, body: unknown, timestamp?: number): void;
  seedIndexEntry(family: string, bvid: string, cacheKey: string, ts?: number): void;
  seedLegacyManifest(family: string, bvid: string, ts: number): void;
  failNextWrite(): void;
}

export interface ChromeHostOptions {
  areas?: Array<"local" | "sync">;
  runtime?: Record<string, unknown>;
}

export function installChromeHost(options: ChromeHostOptions = {}): ChromeHost {
  const areas = options.areas ?? ["local", "sync"];
  const map = new Map<string, unknown>();
  const syncMap = new Map<string, unknown>();
  let failNextWrite = false;
  const hooks: MemoryAreaHooks = {
    beforeSet: () => {
      if (!failNextWrite) {
        return;
      }
      failNextWrite = false;
      throw new Error("chrome-host: failNextWrite 拒绝本次 set");
    }
  };
  const local = createMemoryStorageArea(map, hooks);
  const sync = createMemoryStorageArea(syncMap, hooks);

  const previous = globalThis.chrome as unknown as
    | { runtime?: Record<string, unknown>; storage?: Record<string, unknown> }
    | undefined;
  const previousStorage = (previous?.storage ?? {}) as Record<string, unknown>;
  const storage: Record<string, unknown> = {
    ...previousStorage,
    onChanged: previousStorage.onChanged ?? { addListener: vi.fn(), removeListener: vi.fn() }
  };
  if (areas.includes("local")) {
    storage.local = local;
  }
  if (areas.includes("sync")) {
    storage.sync = sync;
  }

  vi.stubGlobal("chrome", {
    ...previous,
    runtime: { ...previous?.runtime, ...options.runtime },
    storage
  });

  return {
    local,
    sync,
    map,
    syncMap,
    snapshot: () => Object.fromEntries(map.entries()),
    readEntry: (key) => map.get(key) as CacheEntry | undefined,
    hasEntry: (key) => map.has(key),
    seedCacheEntry(key, body, timestamp = Date.now()) {
      map.set(key, { body, timestamp });
    },
    seedIndexEntry(family, bvid, cacheKey, ts = Date.now()) {
      map.set(buildLruIndexEntryKey(family, bvid, cacheKey), { ts });
    },
    seedLegacyManifest(family, bvid, ts) {
      const manifest = (map.get(LRU_MANIFEST_STORAGE_KEY) ?? {}) as Record<string, Record<string, number>>;
      map.set(LRU_MANIFEST_STORAGE_KEY, {
        ...manifest,
        [family]: { ...(manifest[family] ?? {}), [bvid]: ts }
      });
    },
    failNextWrite() {
      failNextWrite = true;
    }
  };
}
