// 测试共享宿主：一台自成一体（self-contained）的 chrome double。
//
// chrome.storage 的读写语义由 ./memory-storage-area.js 的内存面兑现，本文件在其上装盘上布局：
//   - 读三形状：单键 / 键数组 / null（undefined 同义）⇒ 全量快照；缺失键不出现；
//   - 值形状 { body, timestamp } 由 seedCacheEntry 单源派生；
//   - 盘上读走 readEntry / hasEntry（按 { body, timestamp } 条目形状取单键），map
//     只留给需要 Map 语义的用例（entries / keys / delete / size）；
//   - 族索引两种落盘格式各有 seed 原语、互不现代化：seedIndexEntry（现代分键条目，
//     键经 core/cache-lru 的装配点 buildLruIndexEntryKey，值 { ts }）与
//     seedLegacyManifest（旧汇总清单，数值 ts，回归夹具）；
//   - failNextWrite() 让下一次 set 拒绝一次（LRU 淘汰重试用例的写失败注入）。
//
// get/set/remove 都是 vi.fn：既有用例直接改写实现（mockImplementation /
// mockRejectedValue / getMockImplementation 包裹）并断言调用记录，不能换成普通闭包。
// seed 原语写盘不经 set 桩：arrange 不进 mock 调用记录，也不会被用例改写过的写实现吞掉。
//
// 装法：每次调用都重建一份完整 chrome（runtime + 请求的 storage 面 + storage.onChanged），
// 经 vi.stubGlobal 安装；既有 globalThis.chrome 的其余成员（runtime.sendMessage 等）按层合并，
// 用例 vi.unstubAllGlobals() 之后不会被 setup 的守卫重新装回，故宿主必须在每个
// beforeEach（或用例体）内现装，不得提到模块顶层。

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
  /** local 的盘上内容（既有用例直读的 Map 语义）。 */
  map: Map<string, unknown>;
  syncMap: Map<string, unknown>;
  /** local 全量快照（get(null) 的语义）。 */
  snapshot(): Record<string, unknown>;
  /** local 单键的落盘值（{ body, timestamp } 视图）——消费方按条目读，不必手转 map。 */
  readEntry(key: string): CacheEntry | undefined;
  /** local 盘上是否存在该键。 */
  hasEntry(key: string): boolean;
  /** 预置一条缓存条目（值形状 { body, timestamp } 单源派生）。 */
  seedCacheEntry(key: string, body: unknown, timestamp?: number): void;
  /** 预置现代分键索引条目（键经生产装配点，值 { ts }）。 */
  seedIndexEntry(family: string, bvid: string, cacheKey: string, ts?: number): void;
  /** 预置旧汇总清单条目（数值 ts，回归夹具）。 */
  seedLegacyManifest(family: string, bvid: string, ts: number): void;
  /** 让下一次 set（任一已装面）拒绝一次。 */
  failNextWrite(): void;
}

export interface ChromeHostOptions {
  /** 装哪些 storage 面；缺省两个都装。未装的面按既有 globalThis.chrome.storage 原样保留。 */
  areas?: Array<"local" | "sync">;
  /** 与既有 chrome.runtime 合并的覆盖面（按 type 分发的 sendMessage 桩经此注入）。 */
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
