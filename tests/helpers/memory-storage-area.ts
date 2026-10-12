// 测试共享的内存 storage 面：仅兑现 chrome.storage 读写语义，不依赖任何宿主与生产模块。
//
// 一份实现两处装：tests/setup.ts 的缺省全局桩，以及 tests/helpers/chrome-host.ts 的
// 自装宿主（后者在此之上补盘上布局与 seed 原语），故两者语义同一份契约。
//
// get/set/remove 都是 vi.fn：既有用例直接改写实现（mockImplementation /
// mockRejectedValue / getMockImplementation 包裹）并断言调用记录，不能换成普通闭包。

import { vi, type Mock } from "vitest";

/** 落盘值形状：缓存族写 { body, timestamp }；LRU 索引/清单键写各自的元数据。 */
export type CacheEntry = { body?: unknown; timestamp?: number };

export interface ChromeHostStorageArea {
  get: Mock;
  set: Mock;
  remove: Mock;
}

export type MemoryAreaHooks = {
  /** set 写入前的钩子（抛错即拒绝本次 set）；自带内存实现共用一份。 */
  beforeSet?: () => void;
};

/**
 * 一个内存 storage 面：兑现三形状读（含 get(null) 全量快照）与 set/remove 写入语义。
 */
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
