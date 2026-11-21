import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { buildLruIndexEntryKey, LRU_MANIFEST_STORAGE_KEY } from "../../extension/core/cache-lru.js";
import type * as CacheLruModule from "../../extension/core/cache-lru.js";

let mod: typeof CacheLruModule;
let storage: ChromeHost;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = installChromeHost();
  mod = await import("../../extension/core/cache-lru.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("readFamilyKeys：索引驱动取该族该 bvid 的缓存键（读端原语）", () => {
  it("分键索引含该 bvid 条目 → 返回其缓存键清单（按 keyPrefix 过滤）", async () => {
    const dataKeys = [
      "biliscript_lvs_raw_BV1a_1_a_1",
      "biliscript_lvs_raw_BV1a_1_b_2",
      "biliscript_lvs_raw_BV1a_9_z_9"
    ];
    for (const key of dataKeys) {
      storage.seedIndexEntry("biliscript_lvs_raw_", "BV1a", key, 100);
    }

    const keys = await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_BV1a_1_");
    expect(keys).toEqual(["biliscript_lvs_raw_BV1a_1_a_1", "biliscript_lvs_raw_BV1a_1_b_2"]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual(dataKeys);
  });

  it("条目缺失 / 旧格式清单 → 回退 null（消费方 get(null) 前缀扫描）", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 100);

    await expect(mod.readFamilyKeys("biliscript_lvs_raw_", "BV1none", "biliscript_lvs_raw_")).resolves.toBeNull();
    await expect(mod.readFamilyKeys("biliscript_lvs_raw_", "BV1old", "biliscript_lvs_raw_")).resolves.toBeNull();
    await expect(mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a", "biliscript_lvs_raw_")).resolves.toBeNull();
  });

  it("回退告警只发一次（跨消费方共享标志）：logWarn 恰一次，返回值不受影响", async () => {
    const logging = await import("../../extension/shared/logging.js");
    logging.registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).resolves.toBeNull();
      await expect(mod.readFamilyKeys("biliscript_lvs_raw_", "BV1b")).resolves.toBeNull();
      await expect(mod.readFamilyKeys("biliscript_subtitle_cache_", "BV1c")).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] cache-lru index missing for family=biliscript_lvs_raw_ bvid=BV1a, fallback to full storage scan");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("索引记录（分键索引 + 汇总清单）", () => {
  it("writeWithEviction 更新索引（合并去重 keys）；readFamilyKeys 读回；读失败走回退", async () => {
    await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1a",
      keys: ["biliscript_lvs_raw_BV1a_1_a_1"],
      write: async () => storage.local.set({ biliscript_lvs_raw_BV1a_1_a_1: { v: "a" } })
    });
    await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1b",
      keys: ["biliscript_lvs_raw_BV1b_1_a_1"],
      write: async () => storage.local.set({ biliscript_lvs_raw_BV1b_1_a_1: { v: "b" } })
    });
    await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1a",
      keys: ["biliscript_lvs_raw_BV1a_1_a_1", "biliscript_lvs_raw_BV1a_1_b_2"],
      write: async () => storage.local.set({ biliscript_lvs_raw_BV1a_1_b_2: { v: "b2" } })
    });
    await mod.writeWithEviction({
      family: "biliscript_subtitle_cache_",
      bvid: "BV1a",
      keys: ["biliscript_subtitle_cache_BV1a_1_id_x"],
      write: async () => storage.local.set({ biliscript_subtitle_cache_BV1a_1_id_x: { v: "s" } })
    });
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual([
      "biliscript_lvs_raw_BV1a_1_a_1",
      "biliscript_lvs_raw_BV1a_1_b_2"
    ]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1b")).toEqual(["biliscript_lvs_raw_BV1b_1_a_1"]);
    expect(await mod.readFamilyKeys("biliscript_subtitle_cache_", "BV1a")).toEqual(["biliscript_subtitle_cache_BV1a_1_id_x"]);

    storage.local.getKeys.mockRejectedValueOnce(new Error("boom"));
    await expect(mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).resolves.toBeNull();
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0);
  });

  it("parseBvidFromCacheKey：取 family 前缀后第一段（BV 号不含下划线）", () => {
    expect(mod.parseBvidFromCacheKey("biliscript_lvs_raw_BV1xx2_9_id_sub-1_3", "biliscript_lvs_raw_")).toBe("BV1xx2");
    expect(mod.parseBvidFromCacheKey("biliscript_subtitle_cache_BV1a_7_url_a.b.com_p_1", "biliscript_subtitle_cache_")).toBe("BV1a");
    expect(mod.parseBvidFromCacheKey("no_prefix_BV1c_1_x")).toBe("no");
  });
});

describe("pruneToRecentVideos：每族保留最近 3 个视频", () => {
  function seedFamily(family: string, bvids: [string, number][]) {
    for (const [bvid, ts] of bvids) {
      storage.seedLegacyManifest(family, bvid, ts);
      for (const suffix of ["1_a_1", "1_b_2"]) {
        const key = `${family}${bvid}_${suffix}`;
        storage.seedCacheEntry(key, { v: `${bvid}-${suffix}` }, ts);
        storage.seedIndexEntry(family, bvid, key, ts);
      }
    }
  }

  it("删除每族时间戳最旧视频的全部键，保留最近 3 个；索引同步收缩", async () => {
    await seedFamily("biliscript_lvs_raw_", [
      ["BV1old", 10],
      ["BV1a", 100],
      ["BV1b", 200],
      ["BV1c", 300]
    ]);

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_raw_"]);
    expect(removed.biliscript_lvs_raw_).toEqual(
      expect.arrayContaining(["biliscript_lvs_raw_BV1old_1_a_1", "biliscript_lvs_raw_BV1old_1_b_2"])
    );
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_b_2")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_raw_BV1c_1_b_2")).toBe(true);

    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual([
      "biliscript_lvs_raw_BV1a_1_a_1",
      "biliscript_lvs_raw_BV1a_1_b_2"
    ]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1old")).toBeNull();
  });

  it("多族一次淘汰：raw 族索引内 3 新 + 1 遗留键（无索引按最旧）→ 仅遗留被删；不足 keep 的族不动", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1a", 100);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1b", 200);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1c", 300);
    await storage.local.set({
      biliscript_lvs_raw_BV1a_1_a_1: { v: "a-1" },
      biliscript_lvs_raw_BV1a_1_b_2: { v: "a-2" },
      biliscript_lvs_raw_BV1b_1_a_1: { v: "b-1" },
      biliscript_lvs_raw_BV1b_1_b_2: { v: "b-2" },
      biliscript_lvs_raw_BV1c_1_a_1: { v: "c-1" },
      biliscript_lvs_raw_BV1c_1_b_2: { v: "c-2" },
      biliscript_lvs_raw_BV1legacy_1_a_1: { v: "legacy" },
      biliscript_lvs_summary_BV1a_1_a_1: { v: "summary" }
    });

    const removed = await mod.pruneToRecentVideos(mod.CACHE_FAMILIES, 3);
    expect(removed.biliscript_lvs_raw_).toContain("biliscript_lvs_raw_BV1legacy_1_a_1");
    expect(storage.map.has("biliscript_lvs_raw_BV1legacy_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(true);
    expect(removed.biliscript_lvs_summary_).toBeUndefined();
    expect(storage.map.has("biliscript_lvs_summary_BV1a_1_a_1")).toBe(true);
  });

  it("前缀撞车族：analysis_final_ 键归 final 族自身，不被段族前缀扫描误淘汰（审查回归）", async () => {
    await seedNewFormatIndex("biliscript_lvs_analysis_", [
      ["BV1old", 10, ["biliscript_lvs_analysis_BV1old_1_a_1"]],
      ["BV1a", 100, ["biliscript_lvs_analysis_BV1a_1_a_1"]],
      ["BV1b", 200, ["biliscript_lvs_analysis_BV1b_1_a_1"]],
      ["BV1c", 300, ["biliscript_lvs_analysis_BV1c_1_a_1"]]
    ]);
    await seedNewFormatIndex("biliscript_lvs_analysis_final_", [
      ["BV1a", 100, ["biliscript_lvs_analysis_final_BV1a_1_a_1"]]
    ]);

    const removed = await mod.pruneToRecentVideos(mod.CACHE_FAMILIES, 3);
    expect(storage.map.has("biliscript_lvs_analysis_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_analysis_BV1a_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_analysis_final_BV1a_1_a_1")).toBe(true);
    expect(removed["biliscript_lvs_analysis_"] || []).not.toContain("biliscript_lvs_analysis_final_BV1a_1_a_1");
  });

  it("不足 keep 个时不动任何键；淘汰失败静默返回 {}", async () => {
    await seedFamily("biliscript_lvs_raw_", [["BV1a", 1]]);
    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_raw_"], 3);
    expect(removed).toEqual({});
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(true);

    storage.local.getKeys.mockRejectedValue(new Error("boom"));
    await expect(mod.pruneToRecentVideos(["biliscript_lvs_raw_"])).resolves.toEqual({});
  });
});

async function seedNewFormatIndex(family: string, entries: [string, number, string[]][]) {
  for (const [bvid, ts, keys] of entries) {
    storage.seedLegacyManifest(family, bvid, ts);
    for (const key of keys) {
      storage.seedCacheEntry(key, { v: key }, ts);
      storage.seedIndexEntry(family, bvid, key, ts);
    }
  }
}

describe("索引驱动淘汰：优先 getKeys() 零全库反序列化，旧环境回退 get(null)", () => {
  it("索引健康时淘汰走 getKeys() + 定点拉取元数据，绝不触发 get(null) 且不读取数据键", async () => {
    await seedNewFormatIndex("biliscript_lvs_raw_", [
      ["BV1old", 10, ["biliscript_lvs_raw_BV1old_1_a_1", "biliscript_lvs_raw_BV1old_1_b_2"]],
      ["BV1a", 100, ["biliscript_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["biliscript_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["biliscript_lvs_raw_BV1c_1_a_1"]]
    ]);

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_raw_"]);
    expect(storage.local.getKeys).toHaveBeenCalledTimes(1);
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0);
    const requestedKeys = storage.local.get.mock.calls.flatMap(([keys]) =>
      Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : []
    );
    expect(requestedKeys.some((key) => key.startsWith("biliscript_lvs_raw_"))).toBe(false);
    expect(removed.biliscript_lvs_raw_).toEqual(
      expect.arrayContaining(["biliscript_lvs_raw_BV1old_1_a_1", "biliscript_lvs_raw_BV1old_1_b_2"])
    );
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1c_1_a_1")).toBe(true);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual(["biliscript_lvs_raw_BV1a_1_a_1"]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1old")).toBeNull();
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0);
  });

  it("writeWithEviction 传 keys：越界写入触发一次 prune（走 getKeys），淘汰最旧视频且不触发 get(null)", async () => {
    await seedNewFormatIndex("biliscript_lvs_raw_", [
      ["BV1old", 10, ["biliscript_lvs_raw_BV1old_1_a_1"]],
      ["BV1a", 100, ["biliscript_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["biliscript_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["biliscript_lvs_raw_BV1c_1_a_1"]]
    ]);
    await seedNewFormatIndex("biliscript_lvs_summary_", [["BV1s", 5, ["biliscript_lvs_summary_BV1s_1_a_1"]]]);
    await seedNewFormatIndex("biliscript_subtitle_cache_", [["BV1s", 5, ["biliscript_subtitle_cache_BV1s_1_id_x"]]]);

    const result = await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1new",
      keys: ["biliscript_lvs_raw_BV1new_1_a_1"],
      write: async () => storage.local.set({ biliscript_lvs_raw_BV1new_1_a_1: { v: "new" } })
    });

    expect(result).toEqual({ ok: true });
    expect(storage.local.getKeys).toHaveBeenCalledTimes(1);
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(0);
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1new_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_raw_BV1c_1_a_1")).toBe(true);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1old")).toBeNull();
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1new")).toEqual(["biliscript_lvs_raw_BV1new_1_a_1"]);
  });

  it("索引条目缺 keys（旧格式/混合状态）→ 经 getKeys() 扫描数据键名淘汰且不触发 get(null)", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 10);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1a", 100);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1b", 200);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1c", 300);
    await storage.local.set({
      biliscript_lvs_raw_BV1old_1_a_1: { v: "old" },
      biliscript_lvs_raw_BV1a_1_a_1: { v: "a" },
      biliscript_lvs_raw_BV1b_1_a_1: { v: "b" },
      biliscript_lvs_raw_BV1c_1_a_1: { v: "c" }
    });

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_raw_"]);
    expect(storage.local.getKeys).toHaveBeenCalledTimes(1);
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(false);
    expect(removed.biliscript_lvs_raw_).toEqual(["biliscript_lvs_raw_BV1old_1_a_1"]);
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1c_1_a_1")).toBe(true);
  });

  it("不支持 getKeys() 的极老运行环境（Chrome 120–129）→ 平滑回退单次 get(null) 完成枚举与淘汰", async () => {
    (storage.local as unknown as { getKeys?: unknown }).getKeys = undefined;

    await seedNewFormatIndex("biliscript_lvs_raw_", [
      ["BV1old", 10, ["biliscript_lvs_raw_BV1old_1_a_1"]],
      ["BV1a", 100, ["biliscript_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["biliscript_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["biliscript_lvs_raw_BV1c_1_a_1"]]
    ]);

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_raw_"]);
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(1);
    expect(removed.biliscript_lvs_raw_).toEqual(["biliscript_lvs_raw_BV1old_1_a_1"]);
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);

    storage.local.get.mockClear();
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual(["biliscript_lvs_raw_BV1a_1_a_1"]);
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(1);

    storage.local.get.mockClear();
    const items = await mod.getStorageItemsByPrefix("biliscript_lvs_raw_BV1b_");
    expect(Object.keys(items)).toEqual(["biliscript_lvs_raw_BV1b_1_a_1"]);
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(1);
  });

  it("getStorageItemsByPrefix：支持 getKeys() 时仅按命中键定点 get，无命中直接返回 {} 不发 get", async () => {
    await storage.local.set({
      biliscript_lvs_summary_BV1a_1_id_1_0: { summary: "s0", timestamp: 1 },
      biliscript_lvs_summary_BV1b_1_id_1_0: { summary: "other", timestamp: 2 },
      unrelated_large_payload: { big: "x".repeat(1024) }
    });
    storage.local.get.mockClear();
    storage.local.getKeys.mockClear();

    const matched = await mod.getStorageItemsByPrefix("biliscript_lvs_summary_BV1a_");
    expect(Object.keys(matched)).toEqual(["biliscript_lvs_summary_BV1a_1_id_1_0"]);
    expect(storage.local.getKeys).toHaveBeenCalledTimes(1);
    expect(storage.local.get).toHaveBeenCalledWith(["biliscript_lvs_summary_BV1a_1_id_1_0"]);
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(false);

    storage.local.get.mockClear();
    const empty = await mod.getStorageItemsByPrefix("biliscript_lvs_summary_BV1missing_");
    expect(empty).toEqual({});
    expect(storage.local.get).not.toHaveBeenCalled();
  });

  it("索引 keys 指向已删键的幽灵条目：keep 内无害保留，keep 外被垃圾回收出索引（自愈）", async () => {
    await seedNewFormatIndex("biliscript_lvs_raw_", [
      ["BV1a", 100, ["biliscript_lvs_raw_BV1a_1_a_1"]],
      ["BV1ghost", 200, ["biliscript_lvs_raw_BV1ghost_1_a_1"]]
    ]);
    storage.map.delete("biliscript_lvs_raw_BV1ghost_1_a_1");
    await expect(mod.pruneToRecentVideos(["biliscript_lvs_raw_"])).resolves.toEqual({});
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(true);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1ghost")).toEqual(["biliscript_lvs_raw_BV1ghost_1_a_1"]);

    await seedNewFormatIndex("biliscript_lvs_raw_", [
      ["BV1a", 100, ["biliscript_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["biliscript_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["biliscript_lvs_raw_BV1c_1_a_1"]],
      ["BV1ghost", 10, ["biliscript_lvs_raw_BV1ghost_1_a_1"]]
    ]);
    storage.map.delete("biliscript_lvs_raw_BV1ghost_1_a_1");
    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_raw_"]);
    expect(removed.biliscript_lvs_raw_).toEqual(["biliscript_lvs_raw_BV1ghost_1_a_1"]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1ghost")).toBeNull();
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual(["biliscript_lvs_raw_BV1a_1_a_1"]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1b")).toEqual(["biliscript_lvs_raw_BV1b_1_a_1"]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1c")).toEqual(["biliscript_lvs_raw_BV1c_1_a_1"]);
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(true);
  });
});

describe("并发写入竞态（11 票回归）：索引分键后并发写互不覆盖", () => {
  it("同 bvid 3 段并发 writeWithEviction：索引无丢键（readFamilyKeys 全量读回）", async () => {
    await Promise.all(
      [1, 2, 3].map((i) =>
        mod.writeWithEviction({
          family: "biliscript_lvs_raw_",
          bvid: "BV1race",
          keys: [`biliscript_lvs_raw_BV1race_1_a_${i}`],
          write: async () => storage.local.set({ [`biliscript_lvs_raw_BV1race_1_a_${i}`]: { v: i } })
        })
      )
    );
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1race")).toEqual([
      "biliscript_lvs_raw_BV1race_1_a_1",
      "biliscript_lvs_raw_BV1race_1_a_2",
      "biliscript_lvs_raw_BV1race_1_a_3"
    ]);
    for (const i of [1, 2, 3]) {
      expect(storage.map.has(`biliscript_lvs_raw_BV1race_1_a_${i}`)).toBe(true);
    }
  });

  it("并发 3 段经真实 segment-cache 路径（saveSegmentSummary）：IDB 无丢键", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    await Promise.all(
      [0, 1, 2].map((i) =>
        seg.saveSegmentSummary(
          seg.getSegmentSummaryKey({ bvid: "BV1seg", cid: "1", subtitleId: "s", segmentIndex: i }),
          `段${i}`
        )
      )
    );
    expect(await seg.loadStoredSegmentSummaries({ bvid: "BV1seg", cid: "1", subtitleId: "s" })).toEqual([
      "段0",
      "段1",
      "段2"
    ]);
  });

  it("并发跨族写入（raw × summary × subtitle）：各族互不干扰", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    await Promise.all([
      mod.writeWithEviction({
        family: "biliscript_lvs_raw_",
        bvid: "BV1x",
        keys: ["biliscript_lvs_raw_BV1x_1_id_s_0"],
        write: async () => storage.local.set({ biliscript_lvs_raw_BV1x_1_id_s_0: { segments: [], timestamp: 1 } })
      }),
      seg.saveSegmentSummary(seg.getSegmentSummaryKey({ bvid: "BV1x", cid: "1", subtitleId: "s", segmentIndex: 0 }), "小"),
      mod.writeWithEviction({
        family: "biliscript_subtitle_cache_",
        bvid: "BV1x",
        keys: ["biliscript_subtitle_cache_BV1x_1_id_x"],
        write: async () => storage.local.set({ biliscript_subtitle_cache_BV1x_1_id_x: { v: "s" } })
      })
    ]);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1x")).toEqual(["biliscript_lvs_raw_BV1x_1_id_s_0"]);
    expect(await seg.loadSegmentSummary(seg.getSegmentSummaryKey({ bvid: "BV1x", cid: "1", subtitleId: "s", segmentIndex: 0 }))).toBe("小");
    expect(await mod.readFamilyKeys("biliscript_subtitle_cache_", "BV1x")).toEqual(["biliscript_subtitle_cache_BV1x_1_id_x"]);
  });

  it("并发写入后淘汰行为不变：第 4 个视频写入后最旧视频整族被淘汰", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      for (const bvid of ["BV1c1", "BV1c2", "BV1c3"]) {
        now += 1000;
        vi.setSystemTime(now);
        await Promise.all(
          [0, 1, 2].map((i) =>
            mod.writeWithEviction({
              family: "biliscript_lvs_raw_",
              bvid,
              keys: [`biliscript_lvs_raw_${bvid}_1_a_${i}`],
              write: async () => storage.local.set({ [`biliscript_lvs_raw_${bvid}_1_a_${i}`]: { v: i } })
            })
          )
        );
      }
      now += 1000;
      vi.setSystemTime(now);
      await mod.writeWithEviction({
        family: "biliscript_lvs_raw_",
        bvid: "BV1c4",
        keys: ["biliscript_lvs_raw_BV1c4_1_a_0"],
        write: async () => storage.local.set({ biliscript_lvs_raw_BV1c4_1_a_0: { v: 0 } })
      });

      for (const i of [0, 1, 2]) {
        expect(storage.map.has(`biliscript_lvs_raw_BV1c1_1_a_${i}`)).toBe(false);
      }
      expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1c1")).toBeNull();
      expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1c4")).toEqual(["biliscript_lvs_raw_BV1c4_1_a_0"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("writeWithEviction：失败淘汰重试 + distinct 失败", () => {
  it("首次成功：写一次、更新索引、并维持每族最近 3 个视频", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 1);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1a", 10);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1b", 20);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1c", 30);
    await storage.local.set({
      biliscript_lvs_raw_BV1old_1_a_1: { v: "BV1old" },
      biliscript_lvs_raw_BV1a_1_a_1: { v: "BV1a" },
      biliscript_lvs_raw_BV1b_1_a_1: { v: "BV1b" },
      biliscript_lvs_raw_BV1c_1_a_1: { v: "BV1c" }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "biliscript_lvs_raw_BV1new_1_a_1": { v: "new" } });
    });
    const result = await mod.writeWithEviction({ family: "biliscript_lvs_raw_", bvid: "BV1new", write });

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(storage.map.has("biliscript_lvs_raw_BV1new_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);
    const manifest = (await storage.local.get(LRU_MANIFEST_STORAGE_KEY))[LRU_MANIFEST_STORAGE_KEY] as Record<
      string,
      Record<string, number>
    >;
    expect(manifest.biliscript_lvs_raw_.BV1new).toEqual(expect.any(Number));
  });

  it("写入失败 → 先淘汰再重试一次，重试成功返回 { ok:true }", async () => {
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1old", 1);
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1m", 2);
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1n", 3);
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1a", 4);
    storage.seedCacheEntry("biliscript_subtitle_cache_BV1old_1_id_x", [], 1);
    storage.seedCacheEntry("biliscript_subtitle_cache_BV1m_1_id_x", [], 2);
    storage.seedCacheEntry("biliscript_subtitle_cache_BV1n_1_id_x", [], 3);
    let dataWriteAttempts = 0;

    storage.local.set.mockImplementation(async (items) => {
      if ("biliscript_subtitle_cache_BV1a_2_id_y" in items) {
        dataWriteAttempts += 1;
        if (dataWriteAttempts === 1) {
          throw new Error("quota");
        }
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "biliscript_subtitle_cache_BV1a_2_id_y": { body: [], timestamp: 5 } });
    });
    const result = await mod.writeWithEviction({ family: "biliscript_subtitle_cache_", bvid: "BV1a", write });

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(storage.map.has("biliscript_subtitle_cache_BV1old_1_id_x")).toBe(false);
    expect(storage.map.has("biliscript_subtitle_cache_BV1m_1_id_x")).toBe(true);
    expect(storage.map.has("biliscript_subtitle_cache_BV1a_2_id_y")).toBe(true);
  });

  it("重试仍失败 → 返回 { ok:false, error: CacheWriteError }，不抛异常", async () => {
    storage.local.set.mockImplementation(async (items) => {
      if ("biliscript_lvs_raw_BV1a_1_a_1" in items) {
        throw new Error("quota");
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "biliscript_lvs_raw_BV1a_1_a_1": { v: "x" } });
    });
    const result = await mod.writeWithEviction({ family: "biliscript_lvs_raw_", bvid: "BV1a", write });

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBeInstanceOf(mod.CacheWriteError);
      expect(result.error.name).toBe("CacheWriteError");
    }
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("write 非函数 → { ok:false }；keep 可自定义", async () => {
    const bad = await mod.writeWithEviction({ family: "biliscript_lvs_raw_", bvid: "BV1a" });
    expect(bad.ok).toBe(false);
    if (bad.ok === false) {
      expect(bad.error).toBeInstanceOf(mod.CacheWriteError);
    }

    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1a", 1);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1b", 2);
    await storage.local.set({
      biliscript_lvs_raw_BV1a_1_a_1: { v: "a" },
      biliscript_lvs_raw_BV1b_1_a_1: { v: "b" }
    });
    await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1b",
      keep: 1,
      write: async () => storage.local.set({ "biliscript_lvs_raw_BV1b_1_b_2": { v: "b2" } })
    });
    expect(storage.map.has("biliscript_lvs_raw_BV1a_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1b_1_a_1")).toBe(true);
  });

  it("成功写入后各族索引条目都 ≤ keep → prune 短路（不跑完整淘汰）", async () => {
    await seedNewFormatIndex("biliscript_lvs_raw_", [["BV1a", 100, ["biliscript_lvs_raw_BV1a_1_a_1"]]]);
    await seedNewFormatIndex("biliscript_lvs_summary_", [["BV1s", 5, ["biliscript_lvs_summary_BV1s_1_a_1"]]]);
    await seedNewFormatIndex("biliscript_subtitle_cache_", [["BV1s", 5, ["biliscript_subtitle_cache_BV1s_1_id_x"]]]);
    storage.local.get.mockClear();

    const result = await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1b",
      keys: ["biliscript_lvs_raw_BV1b_1_a_1"],
      write: async () => storage.local.set({ biliscript_lvs_raw_BV1b_1_a_1: { v: "b" } })
    });

    expect(result).toEqual({ ok: true });
    expect(storage.local.remove).not.toHaveBeenCalled();
    const indexReads = storage.local.get.mock.calls.filter(([keys]) => keys === LRU_MANIFEST_STORAGE_KEY).length;
    expect(indexReads).toBe(1);
  });

  it("旧格式条目（数值 ts）同样计数：族条目超 keep 时不短路、照常淘汰", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 10);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1a", 100);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1b", 200);
    await storage.local.set({
      biliscript_lvs_raw_BV1old_1_a_1: { v: "old" },
      biliscript_lvs_raw_BV1a_1_a_1: { v: "a" },
      biliscript_lvs_raw_BV1b_1_a_1: { v: "b" }
    });

    const result = await mod.writeWithEviction({
      family: "biliscript_lvs_raw_",
      bvid: "BV1n",
      keys: ["biliscript_lvs_raw_BV1n_1_a_1"],
      write: async () => storage.local.set({ biliscript_lvs_raw_BV1n_1_a_1: { v: "n" } })
    });

    expect(result).toEqual({ ok: true });
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("biliscript_lvs_raw_BV1b_1_a_1")).toBe(true);
  });
});

describe("writeBundleWithEviction：跨族合并写（段缓存写聚合 ticket）", () => {
  const RAW_KEY = "biliscript_lvs_raw_BV1a_1_s_1";
  const SUMMARY_KEY = "biliscript_lvs_summary_BV1a_1_s_1";
  const bundleWrite = (write: () => Promise<void>) =>
    mod.writeBundleWithEviction(
      [
        { family: "biliscript_lvs_raw_", bvid: "BV1a", cacheKeys: [RAW_KEY] },
        { family: "biliscript_lvs_summary_", bvid: "BV1a", cacheKeys: [SUMMARY_KEY] }
      ],
      write
    );

  it("两族索引与 manifest 打包成一次 set；数据写一次；两族索引可读回", async () => {
    const setCalls: string[][] = [];
    const origSet = storage.local.set.getMockImplementation();
    storage.local.set.mockImplementation(async (items) => {
      setCalls.push(Object.keys(items));
      await origSet?.(items);
    });
    const write = vi.fn(async () => {
      await storage.local.set({ [RAW_KEY]: { segments: [], timestamp: 1 } });
      await storage.local.set({ [SUMMARY_KEY]: { summary: "小", timestamp: 1 } });
    });

    const result = await bundleWrite(write);

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    const indexSet = setCalls.find((keys) => keys.includes(LRU_MANIFEST_STORAGE_KEY));
    expect(indexSet).toBeDefined();
    expect(indexSet).toContain(buildLruIndexEntryKey("biliscript_lvs_raw_", "BV1a", RAW_KEY));
    expect(indexSet).toContain(buildLruIndexEntryKey("biliscript_lvs_summary_", "BV1a", SUMMARY_KEY));
    const indexReads = storage.local.get.mock.calls.filter(([keys]) => keys === LRU_MANIFEST_STORAGE_KEY).length;
    expect(indexReads).toBe(1);
    expect(storage.map.has(RAW_KEY)).toBe(true);
    expect(storage.map.has(SUMMARY_KEY)).toBe(true);
    expect(await mod.readFamilyKeys("biliscript_lvs_raw_", "BV1a")).toEqual([RAW_KEY]);
    expect(await mod.readFamilyKeys("biliscript_lvs_summary_", "BV1a")).toEqual([SUMMARY_KEY]);
    const manifest = (await storage.local.get(LRU_MANIFEST_STORAGE_KEY))[LRU_MANIFEST_STORAGE_KEY] as Record<
      string,
      Record<string, number>
    >;
    expect(manifest.biliscript_lvs_raw_.BV1a).toEqual(expect.any(Number));
    expect(manifest.biliscript_lvs_summary_.BV1a).toEqual(expect.any(Number));
  });

  it("数据写首次失败 → 先淘汰再重试一次，重试成功返回 { ok:true }", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 1);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1m", 2);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1n", 3);
    storage.seedCacheEntry("biliscript_lvs_raw_BV1old_1_s_1", [], 1);
    storage.seedCacheEntry("biliscript_lvs_raw_BV1m_1_s_1", [], 2);
    storage.seedCacheEntry("biliscript_lvs_raw_BV1n_1_s_1", [], 3);
    let dataWriteAttempts = 0;
    storage.local.set.mockImplementation(async (items) => {
      if (RAW_KEY in items || SUMMARY_KEY in items) {
        dataWriteAttempts += 1;
        if (dataWriteAttempts === 1) {
          throw new Error("quota");
        }
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ [RAW_KEY]: { segments: [], timestamp: 5 } });
      await storage.local.set({ [SUMMARY_KEY]: { summary: "小", timestamp: 5 } });
    });

    const result = await bundleWrite(write);

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_s_1")).toBe(false);
    expect(storage.map.has(RAW_KEY)).toBe(true);
    expect(storage.map.has(SUMMARY_KEY)).toBe(true);
  });

  it("重试仍失败 → 返回 { ok:false, error: CacheWriteError }，不抛异常", async () => {
    storage.local.set.mockImplementation(async (items) => {
      if (RAW_KEY in items || SUMMARY_KEY in items) {
        throw new Error("quota");
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ [RAW_KEY]: { segments: [], timestamp: 5 } });
    });

    const result = await bundleWrite(write);

    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBeInstanceOf(mod.CacheWriteError);
    }
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("entries 为空 / write 非函数 → { ok:false }，不触碰存储", async () => {
    const empty = await mod.writeBundleWithEviction([], async () => {});
    expect(empty.ok).toBe(false);
    if (empty.ok === false) {
      expect(empty.error).toBeInstanceOf(mod.CacheWriteError);
    }
    const bad = await mod.writeBundleWithEviction(
      [{ family: "biliscript_lvs_raw_", bvid: "BV1a", cacheKeys: [] }],
      undefined as unknown as () => Promise<void>
    );
    expect(bad.ok).toBe(false);
    if (bad.ok === false) {
      expect(bad.error).toBeInstanceOf(mod.CacheWriteError);
    }
    expect(storage.local.set).not.toHaveBeenCalled();
  });

  it("一族越界即触发淘汰（短路检查覆盖写入涉及的全部族）", async () => {
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1old", 1);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1m", 2);
    storage.seedLegacyManifest("biliscript_lvs_raw_", "BV1n", 3);
    storage.seedLegacyManifest("biliscript_lvs_summary_", "BV1a", 10);
    storage.seedCacheEntry("biliscript_lvs_raw_BV1old_1_s_1", [], 1);
    storage.seedCacheEntry("biliscript_lvs_raw_BV1m_1_s_1", [], 2);
    storage.seedCacheEntry("biliscript_lvs_raw_BV1n_1_s_1", [], 3);
    const write = vi.fn(async () => {
      await storage.local.set({ [RAW_KEY]: { segments: [], timestamp: 5 } });
      await storage.local.set({ [SUMMARY_KEY]: { summary: "小", timestamp: 5 } });
    });

    const result = await bundleWrite(write);

    expect(result).toEqual({ ok: true });
    expect(storage.map.has("biliscript_lvs_raw_BV1old_1_s_1")).toBe(false);
    expect(storage.map.has(RAW_KEY)).toBe(true);
    expect(storage.map.has(SUMMARY_KEY)).toBe(true);
  });
});

async function writeFourVideosToIdb(cache: typeof import("../../extension/subtitle/cache.js")): Promise<void> {
  let now = 1000;
  for (const bvid of ["BV1v1", "BV1v2", "BV1v3"]) {
    now += 1000;
    vi.setSystemTime(now);
    await cache.saveSubtitleToCache(`biliscript_subtitle_cache_${bvid}_1_id_x`, [{ from: 0, to: 1, content: "x" }]);
  }
  now += 1000;
  vi.setSystemTime(now);
  await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1v4_1_id_x", [{ from: 0, to: 1, content: "new" }]);
}

describe("一次机制覆盖两族：真实写路径（segment-cache / subtitle cache）", () => {
  it("subtitle/cache.js saveSubtitleToCache 写入 IndexedDB 并按 LRU 上限淘汰第 4 个旧视频", async () => {
    const cache = await import("../../extension/subtitle/cache.js");
    cache.configureSubtitleCacheStoreForTests(cache.createSubtitleIdbStore({ maxEntries: 3 }));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1000);
      await writeFourVideosToIdb(cache);

      expect(await cache.loadSubtitleFromCache("biliscript_subtitle_cache_BV1v1_1_id_x")).toBeNull();
      expect(await cache.loadSubtitleFromCache("biliscript_subtitle_cache_BV1v4_1_id_x")).toEqual([
        { from: 0, to: 1, content: "new" }
      ]);
    } finally {
      cache.configureSubtitleCacheStoreForTests(null);
      vi.useRealTimers();
    }
  });

  it("segment-cache.js saveSegmentSummary 与遗留 raw 写入同样记录索引并按各自上限淘汰旧视频", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    vi.useFakeTimers();
    try {
      let now = 1000;
      for (const bvid of ["BV1s1", "BV1s2", "BV1s3"]) {
        now += 1000;
        vi.setSystemTime(now);
        const rawKey = `biliscript_lvs_raw_${bvid}_1_id_s_1`;
        await mod.writeWithEviction({
          family: "biliscript_lvs_raw_",
          bvid,
          keys: [rawKey],
          write: async () => storage.local.set({ [rawKey]: { segments: [], timestamp: now } })
        });
        await seg.saveSegmentSummary(seg.getSegmentSummaryKey({ bvid, cid: "1", subtitleId: "s", segmentIndex: 1 }), "小");
      }
      now += 1000;
      vi.setSystemTime(now);
      await mod.writeWithEviction({
        family: "biliscript_lvs_raw_",
        bvid: "BV1s4",
        keys: ["biliscript_lvs_raw_BV1s4_1_id_s_1"],
        write: async () => storage.local.set({ biliscript_lvs_raw_BV1s4_1_id_s_1: { segments: [{ from: 0, to: 5, content: "x" }], timestamp: now } })
      });

      expect(storage.map.has("biliscript_lvs_raw_BV1s1_1_id_s_1")).toBe(false);
      expect(storage.map.has("biliscript_lvs_raw_BV1s4_1_id_s_1")).toBe(true);
      expect(await seg.loadSegmentSummary(seg.getSegmentSummaryKey({ bvid: "BV1s1", cid: "1", subtitleId: "s", segmentIndex: 1 }))).toBe("小");
    } finally {
      vi.useRealTimers();
    }
  });
});

function seedSequentialVideos(family: string, count: number): void {
  for (let i = 1; i <= count; i += 1) {
    const bvid = `BV1v${i}`;
    const ts = i * 1000;
    const key = `${family}${bvid}_1_a_1`;
    storage.seedLegacyManifest(family, bvid, ts);
    storage.seedCacheEntry(key, { v: key }, ts);
    storage.seedIndexEntry(family, bvid, key, ts);
  }
}

describe("分族默认保留上限（FAMILY_KEEP_VIDEOS）：与 IndexedDB 100 分 P 对齐", () => {
  it("biliscript_lvs_l1_index_ 与 biliscript_lvs_analysis_final_ 默认保留最近 100 个视频", async () => {
    expect(mod.FAMILY_KEEP_VIDEOS["biliscript_lvs_l1_index_"]).toBe(100);
    expect(mod.FAMILY_KEEP_VIDEOS["biliscript_lvs_analysis_final_"]).toBe(100);

    seedSequentialVideos("biliscript_lvs_l1_index_", 101);
    seedSequentialVideos("biliscript_lvs_analysis_final_", 101);

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_l1_index_", "biliscript_lvs_analysis_final_"]);
    expect(removed["biliscript_lvs_l1_index_"]).toEqual(["biliscript_lvs_l1_index_BV1v1_1_a_1"]);
    expect(removed["biliscript_lvs_analysis_final_"]).toEqual(["biliscript_lvs_analysis_final_BV1v1_1_a_1"]);
    expect(storage.map.has("biliscript_lvs_l1_index_BV1v2_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_l1_index_BV1v101_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_analysis_final_BV1v2_1_a_1")).toBe(true);
  });

  it("biliscript_lvs_summary_ 与 biliscript_lvs_analysis_ 默认保留最近 20 个视频", async () => {
    expect(mod.FAMILY_KEEP_VIDEOS["biliscript_lvs_summary_"]).toBe(20);
    expect(mod.FAMILY_KEEP_VIDEOS["biliscript_lvs_analysis_"]).toBe(20);

    seedSequentialVideos("biliscript_lvs_summary_", 21);
    seedSequentialVideos("biliscript_lvs_analysis_", 21);

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_summary_", "biliscript_lvs_analysis_"]);
    expect(removed["biliscript_lvs_summary_"]).toEqual(["biliscript_lvs_summary_BV1v1_1_a_1"]);
    expect(removed["biliscript_lvs_analysis_"]).toEqual(["biliscript_lvs_analysis_BV1v1_1_a_1"]);
    expect(storage.map.has("biliscript_lvs_summary_BV1v2_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_analysis_BV1v21_1_a_1")).toBe(true);
  });

  it("显式传入 keep 参数时覆盖分族默认保留上限", async () => {
    seedSequentialVideos("biliscript_lvs_l1_index_", 4);

    const removed = await mod.pruneToRecentVideos(["biliscript_lvs_l1_index_"], 2);
    expect(removed["biliscript_lvs_l1_index_"]).toEqual(
      expect.arrayContaining(["biliscript_lvs_l1_index_BV1v1_1_a_1", "biliscript_lvs_l1_index_BV1v2_1_a_1"])
    );
    expect(storage.map.has("biliscript_lvs_l1_index_BV1v3_1_a_1")).toBe(true);
    expect(storage.map.has("biliscript_lvs_l1_index_BV1v4_1_a_1")).toBe(true);
  });
});
