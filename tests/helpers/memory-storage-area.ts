import { vi, type Mock } from "vitest";

export type CacheEntry = { body?: unknown; timestamp?: number };

export interface ChromeHostStorageArea {
  get: Mock<(keys?: string | string[] | null) => Promise<Record<string, unknown>>>;
  getKeys: Mock<() => Promise<string[]>>;
  set: Mock<(items: Record<string, unknown>) => Promise<void>>;
  remove: Mock<(keys: string | string[]) => Promise<void>>;
}

export type MemoryAreaHooks = {
  beforeSet?: () => void;
};

export function createMemoryStorageArea(
  map: Map<string, unknown> = new Map(),
  hooks: MemoryAreaHooks = {}
): ChromeHostStorageArea {
  return {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      const want = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of want) {
        if (map.has(key)) {
          out[key] = map.get(key);
        }
      }
      return out;
    }),
    getKeys: vi.fn(async () => Array.from(map.keys())),
    set: vi.fn(async (items: Record<string, unknown>) => {
      hooks.beforeSet?.();
      for (const [key, value] of Object.entries(items ?? {})) {
        map.set(key, value);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        map.delete(key);
      }
    })
  };
}
