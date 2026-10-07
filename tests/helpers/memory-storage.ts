// 测试共享宿主：内存版 chrome.storage.local。
//
// 真实 subtitle/cache.js 与 core/cache-lru.js 跑在这台 Map 之上——cache-lru 需要
// get(null) 全量枚举（见其模块头注的测试约定），故 keys 为 null 时返回整份快照。
// 字幕缓存（biliscript_subtitle_cache_*）、ASR 变体缓存与 LRU 索引/清单键共用
// 同一台 storage：预置条目即「缓存命中」，直读返回的 Map 即「盘上留下了什么」，
// 于是取体 / 落缓存 / 清键都能按真实键与真实落盘形状断言，而不必整体替换
// subtitle/cache.js（整体替换会连键装配一起换掉，把键的回归藏起来）。
//
// 消费方：tests/subtitle/{asr-fallback, asr-fallback-concurrent, secondary-track,
// reset-fetch-runid, fetcher-no-subtitle-reason}.test.ts。

import { vi } from "vitest";

// 落盘值形状：cache.js 写 { body, timestamp }；LRU 索引/清单键写各自的元数据。
export type CacheEntry = { body?: unknown; timestamp?: number };

export function installMemoryStorage(): Map<string, CacheEntry> {
  const memory = new Map<string, CacheEntry>();
  const storage = globalThis.chrome.storage.local;
  vi.mocked(storage.get).mockImplementation(async (keys) => {
    if (keys === null || keys === undefined) {
      return Object.fromEntries(memory);
    }
    const list = Array.isArray(keys) ? keys : [keys as string];
    const out: Record<string, unknown> = {};
    for (const key of list) {
      if (memory.has(key)) {
        out[key] = memory.get(key);
      }
    }
    return out;
  });
  vi.mocked(storage.set).mockImplementation(async (entries) => {
    for (const [key, value] of Object.entries(entries)) {
      memory.set(key, value as CacheEntry);
    }
  });
  vi.mocked(storage.remove).mockImplementation(async (keys) => {
    const list = Array.isArray(keys) ? keys : [keys];
    for (const key of list) {
      memory.delete(key);
    }
  });
  return memory;
}

// 预置一条缓存条目（镜像 cache.js 的写入形状 { body, timestamp }）
export async function seedCache(key: string, body: unknown[]): Promise<void> {
  await globalThis.chrome.storage.local.set({ [key]: { body, timestamp: Date.now() } });
}
