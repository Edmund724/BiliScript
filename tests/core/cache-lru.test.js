// core/cache-lru.js 统一 LRU 淘汰测试：
// (a) 索引记录（经 readFamilyKeys 读回验证）+ pruneToRecentVideos 每族保留最近 3 个
//     视频、删除更旧视频的全部键；
// (b) writeWithEviction 失败后先淘汰再重试一次，重试成功返回 { ok:true }，
//     重试仍失败返回 distinct 的 CacheWriteError（{ ok:false }，不抛异常）；
// (c) 一次机制覆盖两族（boc_lvs_* 与 boc_subtitle_cache_*）。
// 注：recordCacheWrite / readLruIndex / LRU_INDEX_KEY 已收模块私有（09 票），
// 用例以 readFamilyKeys 读回验证，或直接以字面量键 boc_cache_lru_index 读写索引。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

let mod;
let storage;

// 内存 Map 实现的 chrome.storage.local：get 需支持 null（全量枚举，供前缀扫描）。
function createMemoryStorage() {
  const map = new Map();
  const local = {
    get: vi.fn(async (keys) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      const want = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of want) {
        if (map.has(k)) {
          out[k] = map.get(k);
        }
      }
      return out;
    }),
    set: vi.fn(async (items) => {
      for (const [key, value] of Object.entries(items)) {
        map.set(key, value);
      }
    }),
    remove: vi.fn(async (keys) => {
      const want = Array.isArray(keys) ? keys : [keys];
      for (const k of want) {
        map.delete(k);
      }
    })
  };
  return { map, local };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
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
      "boc_lvs_raw_BV1a_1_a_1",
      "boc_lvs_raw_BV1a_1_b_2",
      "boc_lvs_raw_BV1a_9_z_9"
    ];
    const items = {};
    for (const key of dataKeys) {
      items[`boc_cache_lru_index:boc_lvs_raw_:BV1a:${key}`] = { ts: 100 };
    }
    await storage.local.set(items);

    const keys = await mod.readFamilyKeys("boc_lvs_raw_", "BV1a", "boc_lvs_raw_BV1a_1_");
    expect(keys).toEqual(["boc_lvs_raw_BV1a_1_a_1", "boc_lvs_raw_BV1a_1_b_2"]);
    // 省略 keyPrefix → 返回该 bvid 的全部索引键
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).toEqual(dataKeys);
  });

  it("条目缺失 / 旧格式（数值 ts 无 keys）→ 回退 null（消费方 get(null) 前缀扫描）", async () => {
    await storage.local.set({
      boc_cache_lru_index: { boc_lvs_raw_: { BV1old: 100 } }
    });

    // 条目缺失（该 bvid 无条目）
    await expect(mod.readFamilyKeys("boc_lvs_raw_", "BV1none", "boc_lvs_raw_")).resolves.toBeNull();
    // 旧格式条目：normalize 兼容为 { ts, keys: [] } → 无 keys 同路回退
    await expect(mod.readFamilyKeys("boc_lvs_raw_", "BV1old", "boc_lvs_raw_")).resolves.toBeNull();
    // 整个索引缺失
    await expect(mod.readFamilyKeys("boc_lvs_raw_", "BV1a", "boc_lvs_raw_")).resolves.toBeNull();
  });

  it("回退告警只发一次（跨消费方共享标志）：logWarn 恰一次，返回值不受影响", async () => {
    // logWarn 受调试门控（shared/logging 缺省关）：测试注册常开门
    const logging = await import("../../extension/shared/logging.js");
    logging.registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).resolves.toBeNull();
      await expect(mod.readFamilyKeys("boc_lvs_raw_", "BV1b")).resolves.toBeNull();
      // 跨消费方共享同一份标志：subtitle 族条目缺失不再重复告警
      await expect(mod.readFamilyKeys("boc_subtitle_cache_", "BV1c")).resolves.toBeNull();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith("[BOC] cache-lru index missing for family=boc_lvs_raw_ bvid=BV1a, fallback to full storage scan");
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("索引记录（family → bvid → { ts, keys }）", () => {
  it("writeWithEviction 更新索引（合并去重 keys）；readFamilyKeys 读回；读失败走回退", async () => {
    await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1a",
      keys: ["boc_lvs_raw_BV1a_1_a_1"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1a_1_a_1: { v: "a" } })
    });
    await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1b",
      keys: ["boc_lvs_raw_BV1b_1_a_1"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1b_1_a_1: { v: "b" } })
    });
    // 同 bvid 再次写入：keys 合并去重
    await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1a",
      keys: ["boc_lvs_raw_BV1a_1_a_1", "boc_lvs_raw_BV1a_1_b_2"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1a_1_b_2: { v: "b2" } })
    });
    await mod.writeWithEviction({
      family: "boc_subtitle_cache_",
      bvid: "BV1a",
      keys: ["boc_subtitle_cache_BV1a_1_id_x"],
      write: async () => storage.local.set({ boc_subtitle_cache_BV1a_1_id_x: { v: "s" } })
    });
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).toEqual([
      "boc_lvs_raw_BV1a_1_a_1",
      "boc_lvs_raw_BV1a_1_b_2"
    ]);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1b")).toEqual(["boc_lvs_raw_BV1b_1_a_1"]);
    expect(await mod.readFamilyKeys("boc_subtitle_cache_", "BV1a")).toEqual(["boc_subtitle_cache_BV1a_1_id_x"]);

    // 读失败 → 回退 null（索引是启发式元数据，允许丢）
    storage.local.get.mockRejectedValueOnce(new Error("boom"));
    await expect(mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).resolves.toBeNull();
  });

  it("parseBvidFromCacheKey：取 family 前缀后第一段（BV 号不含下划线）", () => {
    expect(mod.parseBvidFromCacheKey("boc_lvs_raw_BV1xx2_9_id_sub-1_3", "boc_lvs_raw_")).toBe("BV1xx2");
    expect(mod.parseBvidFromCacheKey("boc_subtitle_cache_BV1a_7_url_a.b.com_p_1", "boc_subtitle_cache_")).toBe("BV1a");
    expect(mod.parseBvidFromCacheKey("no_prefix_BV1c_1_x")).toBe("no");
  });
});

describe("pruneToRecentVideos：每族保留最近 3 个视频", () => {
  // 直写分键索引 + 清单（显式 ts 保证排名确定，绕过 writeWithEviction 以免种子
  // 写入提前触发淘汰）+ 每视频两条数据键（模拟 raw/summary 的多段、字幕缓存的平台+ASR 轨）。
  async function seedFamily(family, bvids) {
    const lruKey = "boc_cache_lru_index";
    const currentManifest = (await storage.local.get(lruKey))[lruKey] || {};
    const familyManifest = {};
    const items = {};
    for (const [bvid, ts] of bvids) {
      familyManifest[bvid] = ts;
      for (const suffix of ["1_a_1", "1_b_2"]) {
        const key = `${family}${bvid}_${suffix}`;
        items[key] = { v: `${bvid}-${suffix}` };
        items[`boc_cache_lru_index:${family}:${bvid}:${key}`] = { ts };
      }
    }
    items[lruKey] = { ...currentManifest, [family]: familyManifest };
    await storage.local.set(items);
  }

  it("删除每族时间戳最旧视频的全部键，保留最近 3 个；索引同步收缩", async () => {
    await seedFamily("boc_lvs_raw_", [
      ["BV1old", 10],
      ["BV1a", 100],
      ["BV1b", 200],
      ["BV1c", 300]
    ]);

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    expect(removed.boc_lvs_raw_).toEqual(
      expect.arrayContaining(["boc_lvs_raw_BV1old_1_a_1", "boc_lvs_raw_BV1old_1_b_2"])
    );
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1old_1_b_2")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_b_2")).toBe(true);

    // 索引收缩：BV1old 条目移除，其余保留（键面原样）
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).toEqual([
      "boc_lvs_raw_BV1a_1_a_1",
      "boc_lvs_raw_BV1a_1_b_2"
    ]);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1old")).toBeNull();
  });

  it("多族一次淘汰：raw 族索引内 3 新 + 1 遗留键（无索引按最旧）→ 仅遗留被删；不足 keep 的族不动", async () => {
    // 旧格式索引（数值 ts，无 keys）→ 该族回退 get(null) 前缀扫描，storage 里的
    // 遗留键（索引缺失 → 时间戳 0 → 最旧）随扫描一并进入淘汰清单
    await storage.local.set({
      boc_cache_lru_index: { boc_lvs_raw_: { BV1a: 100, BV1b: 200, BV1c: 300 } },
      boc_lvs_raw_BV1a_1_a_1: { v: "a-1" },
      boc_lvs_raw_BV1a_1_b_2: { v: "a-2" },
      boc_lvs_raw_BV1b_1_a_1: { v: "b-1" },
      boc_lvs_raw_BV1b_1_b_2: { v: "b-2" },
      boc_lvs_raw_BV1c_1_a_1: { v: "c-1" },
      boc_lvs_raw_BV1c_1_b_2: { v: "c-2" },
      boc_lvs_raw_BV1legacy_1_a_1: { v: "legacy" },
      // summary 族不在索引：注册但从未写入 → 跳过，数据键不动
      boc_lvs_summary_BV1a_1_a_1: { v: "summary" }
    });

    const removed = await mod.pruneToRecentVideos(mod.CACHE_FAMILIES, 3);
    expect(removed.boc_lvs_raw_).toContain("boc_lvs_raw_BV1legacy_1_a_1");
    expect(storage.map.has("boc_lvs_raw_BV1legacy_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
    // summary 族不足 keep 个 → 无删除
    expect(removed.boc_lvs_summary_).toBeUndefined();
    expect(storage.map.has("boc_lvs_summary_BV1a_1_a_1")).toBe(true);
  });

  it("不足 keep 个时不动任何键；淘汰失败静默返回 {}", async () => {
    await seedFamily("boc_lvs_raw_", [["BV1a", 1]]);
    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"], 3);
    expect(removed).toEqual({});
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);

    // 枚举失败 → 静默返回 {}
    storage.local.get.mockRejectedValue(new Error("boom"));
    await expect(mod.pruneToRecentVideos(["boc_lvs_raw_"])).resolves.toEqual({});
  });
});

// 直接以字面量分键索引 + 清单写索引与数据键（绕过 writeWithEviction 便于精确控制键面）。
async function seedNewFormatIndex(family, entries) {
  const lruKey = "boc_cache_lru_index";
  const currentManifest = (await storage.local.get(lruKey))[lruKey] || {};
  const familyManifest = {};
  const items = { [lruKey]: { ...currentManifest, [family]: familyManifest } };
  for (const [bvid, ts, keys] of entries) {
    familyManifest[bvid] = ts;
    for (const key of keys) {
      items[key] = { v: key };
      items[`boc_cache_lru_index:${family}:${bvid}:${key}`] = { ts };
    }
  }
  await storage.local.set(items);
}

describe("索引驱动淘汰：单次 get(null) 快照内完成（11 票分键布局）", () => {
  it("索引健康时淘汰恰做一次全量快照，结果与扫描路径等价", async () => {
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1old", 10, ["boc_lvs_raw_BV1old_1_a_1", "boc_lvs_raw_BV1old_1_b_2"]],
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["boc_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["boc_lvs_raw_BV1c_1_a_1"]]
    ]);

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    // 分键布局：prune 单次快照枚举（读端 readFamilyKeys 亦走同一快照机制，
    // 全程恰一次 get(null)，无第二次全量枚举）
    const nullScans = storage.local.get.mock.calls.filter(([keys]) => keys === null);
    expect(nullScans).toHaveLength(1);
    expect(removed.boc_lvs_raw_).toEqual(
      expect.arrayContaining(["boc_lvs_raw_BV1old_1_a_1", "boc_lvs_raw_BV1old_1_b_2"])
    );
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_a_1")).toBe(true);
    // 索引同步收缩：被淘汰 bvid 整条移除
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).toEqual(["boc_lvs_raw_BV1a_1_a_1"]);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1old")).toBeNull();
  });

  it("writeWithEviction 传 keys：越界写入触发一次 prune（单快照），淘汰最旧视频", async () => {
    // 三族索引均健康（有条目），写路径清单显示 raw 族已越界 → 触发一次淘汰
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1old", 10, ["boc_lvs_raw_BV1old_1_a_1"]],
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["boc_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["boc_lvs_raw_BV1c_1_a_1"]]
    ]);
    await seedNewFormatIndex("boc_lvs_summary_", [["BV1s", 5, ["boc_lvs_summary_BV1s_1_a_1"]]]);
    await seedNewFormatIndex("boc_subtitle_cache_", [["BV1s", 5, ["boc_subtitle_cache_BV1s_1_id_x"]]]);

    const result = await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1new",
      keys: ["boc_lvs_raw_BV1new_1_a_1"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1new_1_a_1: { v: "new" } })
    });

    expect(result).toEqual({ ok: true });
    // 越界写入触发一次 prune：恰一次全量快照（清单读不算）
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(1);
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false); // 最旧被淘汰
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(false); // 次旧同样超出 keep=3
    expect(storage.map.has("boc_lvs_raw_BV1new_1_a_1")).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_a_1")).toBe(true);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1old")).toBeNull();
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1new")).toEqual(["boc_lvs_raw_BV1new_1_a_1"]);
  });

  it("索引条目缺 keys（旧格式/混合状态）→ 该族回退 get(null) 前缀扫描", async () => {
    await storage.local.set({
      // 旧格式索引（数值 ts，无 keys）
      boc_cache_lru_index: {
        boc_lvs_raw_: { BV1old: 10, BV1a: 100, BV1b: 200, BV1c: 300 }
      },
      boc_lvs_raw_BV1old_1_a_1: { v: "old" },
      boc_lvs_raw_BV1a_1_a_1: { v: "a" },
      boc_lvs_raw_BV1b_1_a_1: { v: "b" },
      boc_lvs_raw_BV1c_1_a_1: { v: "c" }
    });

    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(true);
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1c_1_a_1")).toBe(true);
  });

  it("索引 keys 指向已删键的幽灵条目：keep 内无害保留，keep 外被垃圾回收出索引（自愈）", async () => {
    // keep 内：幽灵条目照常参与排序，不产生删除、条目保留（键面以索引为准）
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      // BV1ghost 的键已被外部删除，storage 只剩索引条目
      ["BV1ghost", 200, ["boc_lvs_raw_BV1ghost_1_a_1"]]
    ]);
    storage.map.delete("boc_lvs_raw_BV1ghost_1_a_1");
    await expect(mod.pruneToRecentVideos(["boc_lvs_raw_"])).resolves.toEqual({});
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1ghost")).toEqual(["boc_lvs_raw_BV1ghost_1_a_1"]);

    // keep 外：幽灵键照常流入淘汰清单（remove 对不存在键是 no-op，报告可列出
    // 已不存在的键），其索引条目被收缩步骤一并清出
    await seedNewFormatIndex("boc_lvs_raw_", [
      ["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]],
      ["BV1b", 200, ["boc_lvs_raw_BV1b_1_a_1"]],
      ["BV1c", 300, ["boc_lvs_raw_BV1c_1_a_1"]],
      ["BV1ghost", 10, ["boc_lvs_raw_BV1ghost_1_a_1"]]
    ]);
    storage.map.delete("boc_lvs_raw_BV1ghost_1_a_1");
    const removed = await mod.pruneToRecentVideos(["boc_lvs_raw_"]);
    expect(removed.boc_lvs_raw_).toEqual(["boc_lvs_raw_BV1ghost_1_a_1"]);
    // 索引收缩：ghost 条目整条清出，keep 内 bvid 的键面原样保留
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1ghost")).toBeNull();
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1a")).toEqual(["boc_lvs_raw_BV1a_1_a_1"]);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1b")).toEqual(["boc_lvs_raw_BV1b_1_a_1"]);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1c")).toEqual(["boc_lvs_raw_BV1c_1_a_1"]);
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(true);
  });
});

describe("并发写入竞态（11 票回归）：索引分键后并发写互不覆盖", () => {
  it("同 bvid 3 段并发 writeWithEviction：索引无丢键（readFamilyKeys 全量读回）", async () => {
    await Promise.all(
      [1, 2, 3].map((i) =>
        mod.writeWithEviction({
          family: "boc_lvs_raw_",
          bvid: "BV1race",
          keys: [`boc_lvs_raw_BV1race_1_a_${i}`],
          write: async () => storage.local.set({ [`boc_lvs_raw_BV1race_1_a_${i}`]: { v: i } })
        })
      )
    );
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1race")).toEqual([
      "boc_lvs_raw_BV1race_1_a_1",
      "boc_lvs_raw_BV1race_1_a_2",
      "boc_lvs_raw_BV1race_1_a_3"
    ]);
    // 数据键也在
    for (const i of [1, 2, 3]) {
      expect(storage.map.has(`boc_lvs_raw_BV1race_1_a_${i}`)).toBe(true);
    }
  });

  it("并发 3 段经真实 segment-cache 路径（saveRawSegments）：索引无丢键", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    await Promise.all(
      [0, 1, 2].map((i) =>
        seg.saveRawSegments(
          seg.getRawSegmentKey({ bvid: "BV1seg", cid: "1", subtitleId: "s", segmentIndex: i }),
          [{ from: i * 5, to: i * 5 + 5, content: `段${i}` }]
        )
      )
    );
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1seg")).toHaveLength(3);
  });

  it("并发跨族写入（raw × summary × subtitle）：各族索引互不干扰", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    await Promise.all([
      seg.saveRawSegments(seg.getRawSegmentKey({ bvid: "BV1x", cid: "1", subtitleId: "s", segmentIndex: 0 }), []),
      seg.saveSegmentSummary(seg.getSegmentSummaryKey({ bvid: "BV1x", cid: "1", subtitleId: "s", segmentIndex: 0 }), "小"),
      mod.writeWithEviction({
        family: "boc_subtitle_cache_",
        bvid: "BV1x",
        keys: ["boc_subtitle_cache_BV1x_1_id_x"],
        write: async () => storage.local.set({ boc_subtitle_cache_BV1x_1_id_x: { v: "s" } })
      })
    ]);
    expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1x")).toEqual(["boc_lvs_raw_BV1x_1_id_s_0"]);
    expect(await mod.readFamilyKeys("boc_lvs_summary_", "BV1x")).toEqual(["boc_lvs_summary_BV1x_1_id_s_0"]);
    expect(await mod.readFamilyKeys("boc_subtitle_cache_", "BV1x")).toEqual(["boc_subtitle_cache_BV1x_1_id_x"]);
  });

  it("并发写入后淘汰行为不变：第 4 个视频写入后最旧视频整族被淘汰", async () => {
    vi.useFakeTimers();
    try {
      let now = 1000;
      for (const bvid of ["BV1c1", "BV1c2", "BV1c3"]) {
        now += 1000;
        vi.setSystemTime(now);
        // 每个视频 3 段并发写入（真实竞态面）
        await Promise.all(
          [0, 1, 2].map((i) =>
            mod.writeWithEviction({
              family: "boc_lvs_raw_",
              bvid,
              keys: [`boc_lvs_raw_${bvid}_1_a_${i}`],
              write: async () => storage.local.set({ [`boc_lvs_raw_${bvid}_1_a_${i}`]: { v: i } })
            })
          )
        );
      }
      now += 1000;
      vi.setSystemTime(now);
      await mod.writeWithEviction({
        family: "boc_lvs_raw_",
        bvid: "BV1c4",
        keys: ["boc_lvs_raw_BV1c4_1_a_0"],
        write: async () => storage.local.set({ boc_lvs_raw_BV1c4_1_a_0: { v: 0 } })
      });

      // 最旧的 BV1c1 整族（3 段数据键 + 索引）被淘汰，新视频保留
      for (const i of [0, 1, 2]) {
        expect(storage.map.has(`boc_lvs_raw_BV1c1_1_a_${i}`)).toBe(false);
      }
      expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1c1")).toBeNull();
      expect(await mod.readFamilyKeys("boc_lvs_raw_", "BV1c4")).toEqual(["boc_lvs_raw_BV1c4_1_a_0"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("writeWithEviction：失败淘汰重试 + distinct 失败", () => {
  it("首次成功：写一次、更新索引、并维持每族最近 3 个视频", async () => {
    // 直写索引（显式 ts）+ 数据键：BV1old 最旧，写入目标 BV1new 由 write 内部记录
    await storage.local.set({
      boc_cache_lru_index: { boc_lvs_raw_: { BV1old: 1, BV1a: 10, BV1b: 20, BV1c: 30 } },
      boc_lvs_raw_BV1old_1_a_1: { v: "BV1old" },
      boc_lvs_raw_BV1a_1_a_1: { v: "BV1a" },
      boc_lvs_raw_BV1b_1_a_1: { v: "BV1b" },
      boc_lvs_raw_BV1c_1_a_1: { v: "BV1c" }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "boc_lvs_raw_BV1new_1_a_1": { v: "new" } });
    });
    const result = await mod.writeWithEviction({ family: "boc_lvs_raw_", bvid: "BV1new", write });

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(1);
    expect(storage.map.has("boc_lvs_raw_BV1new_1_a_1")).toBe(true);
    // 刚写入的 bvid 是最近写入 → 保留；最旧的 BV1old 被淘汰
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    // write 未传 keys → BV1new 仅在清单记录 ts（无分键索引条目，readFamilyKeys
    // 会回退，故此处直读清单）
    const manifest = (await storage.local.get("boc_cache_lru_index")).boc_cache_lru_index;
    expect(manifest.boc_lvs_raw_.BV1new).toEqual(expect.any(Number));
  });

  it("写入失败 → 先淘汰再重试一次，重试成功返回 { ok:true }", async () => {
    // 直写索引（旧格式条目，数值 ts）注入 4 个视频：BV1old 最旧，写入目标 BV1a
    await storage.local.set({
      boc_cache_lru_index: {
        boc_subtitle_cache_: { BV1old: 1, BV1m: 2, BV1n: 3, BV1a: 4 }
      },
      boc_subtitle_cache_BV1old_1_id_x: { body: [], timestamp: 1 },
      boc_subtitle_cache_BV1m_1_id_x: { body: [], timestamp: 2 },
      boc_subtitle_cache_BV1n_1_id_x: { body: [], timestamp: 3 }
    });
    let dataWriteAttempts = 0;

    storage.local.set.mockImplementation(async (items) => {
      // 仅数据键首次写入失败（模拟容量不足），索引记录正常
      if ("boc_subtitle_cache_BV1a_2_id_y" in items) {
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
      await storage.local.set({ "boc_subtitle_cache_BV1a_2_id_y": { body: [], timestamp: 5 } });
    });
    const result = await mod.writeWithEviction({ family: "boc_subtitle_cache_", bvid: "BV1a", write });

    expect(result).toEqual({ ok: true });
    expect(write).toHaveBeenCalledTimes(2);
    // 淘汰发生了：最旧的 BV1old 键被清理，重试写入成功
    expect(storage.map.has("boc_subtitle_cache_BV1old_1_id_x")).toBe(false);
    expect(storage.map.has("boc_subtitle_cache_BV1m_1_id_x")).toBe(true);
    expect(storage.map.has("boc_subtitle_cache_BV1a_2_id_y")).toBe(true);
  });

  it("重试仍失败 → 返回 { ok:false, error: CacheWriteError }，不抛异常", async () => {
    // 仅数据键写入失败（模拟容量不足），索引记录正常 → 写入共尝试两次
    storage.local.set.mockImplementation(async (items) => {
      if ("boc_lvs_raw_BV1a_1_a_1" in items) {
        throw new Error("quota");
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });
    const write = vi.fn(async () => {
      await storage.local.set({ "boc_lvs_raw_BV1a_1_a_1": { v: "x" } });
    });
    const result = await mod.writeWithEviction({ family: "boc_lvs_raw_", bvid: "BV1a", write });

    expect(result.ok).toBe(false);
    expect(result.error).toBeInstanceOf(mod.CacheWriteError);
    expect(result.error.name).toBe("CacheWriteError");
    expect(write).toHaveBeenCalledTimes(2); // 首次 + 淘汰后重试一次
  });

  it("write 非函数 → { ok:false }；keep 可自定义", async () => {
    const bad = await mod.writeWithEviction({ family: "boc_lvs_raw_", bvid: "BV1a" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBeInstanceOf(mod.CacheWriteError);

    // 直写索引（旧格式条目）+ 数据键：BV1a 最旧，写入目标 BV1b
    await storage.local.set({
      boc_cache_lru_index: { boc_lvs_raw_: { BV1a: 1, BV1b: 2 } },
      boc_lvs_raw_BV1a_1_a_1: { v: "a" },
      boc_lvs_raw_BV1b_1_a_1: { v: "b" }
    });
    await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1b",
      keep: 1,
      write: async () => storage.local.set({ "boc_lvs_raw_BV1b_1_b_2": { v: "b2" } })
    });
    expect(storage.map.has("boc_lvs_raw_BV1a_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1b_1_a_1")).toBe(true);
  });

  it("成功写入后各族索引条目都 ≤ keep → prune 短路（不跑完整淘汰）", async () => {
    await seedNewFormatIndex("boc_lvs_raw_", [["BV1a", 100, ["boc_lvs_raw_BV1a_1_a_1"]]]);
    await seedNewFormatIndex("boc_lvs_summary_", [["BV1s", 5, ["boc_lvs_summary_BV1s_1_a_1"]]]);
    await seedNewFormatIndex("boc_subtitle_cache_", [["BV1s", 5, ["boc_subtitle_cache_BV1s_1_id_x"]]]);
    storage.local.get.mockClear();

    const result = await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1b",
      keys: ["boc_lvs_raw_BV1b_1_a_1"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1b_1_a_1: { v: "b" } })
    });

    expect(result).toEqual({ ok: true });
    expect(storage.local.remove).not.toHaveBeenCalled();
    // 清单读取恰 1 次（attempt 内快照，兼作短路检查）；跑完整 prune 会再多一次全量快照
    const indexReads = storage.local.get.mock.calls.filter(([keys]) => keys === "boc_cache_lru_index").length;
    expect(indexReads).toBe(1);
  });

  it("旧格式条目（数值 ts）同样计数：族条目超 keep 时不短路、照常淘汰", async () => {
    await storage.local.set({
      boc_cache_lru_index: { boc_lvs_raw_: { BV1old: 10, BV1a: 100, BV1b: 200 } },
      boc_lvs_raw_BV1old_1_a_1: { v: "old" },
      boc_lvs_raw_BV1a_1_a_1: { v: "a" },
      boc_lvs_raw_BV1b_1_a_1: { v: "b" }
    });

    const result = await mod.writeWithEviction({
      family: "boc_lvs_raw_",
      bvid: "BV1n",
      keys: ["boc_lvs_raw_BV1n_1_a_1"],
      write: async () => storage.local.set({ boc_lvs_raw_BV1n_1_a_1: { v: "n" } })
    });

    expect(result).toEqual({ ok: true });
    expect(storage.map.has("boc_lvs_raw_BV1old_1_a_1")).toBe(false);
    expect(storage.map.has("boc_lvs_raw_BV1b_1_a_1")).toBe(true);
  });
});

describe("一次机制覆盖两族：真实写路径（segment-cache / subtitle cache）", () => {
  it("subtitle/cache.js saveSubtitleToCache 更新索引并淘汰第 4 个旧视频", async () => {
    const cache = await import("../../extension/subtitle/cache.js");
    // 假时钟步进：逐次落盘的写入时间戳严格递增（排除同毫秒 ts 并列的排名不确定）
    vi.useFakeTimers();
    try {
      let now = 1000;
      vi.setSystemTime(now);
      for (const bvid of ["BV1v1", "BV1v2", "BV1v3"]) {
        now += 1000;
        vi.setSystemTime(now);
        await cache.saveSubtitleToCache(`boc_subtitle_cache_${bvid}_1_id_x`, [{ from: 0, to: 1, content: "x" }]);
      }
      now += 1000;
      vi.setSystemTime(now);
      await cache.saveSubtitleToCache("boc_subtitle_cache_BV1v4_1_id_x", [{ from: 0, to: 1, content: "new" }]);

      expect(storage.map.has("boc_subtitle_cache_BV1v1_1_id_x")).toBe(false);
      expect(storage.map.has("boc_subtitle_cache_BV1v4_1_id_x")).toBe(true);
      expect(await mod.readFamilyKeys("boc_subtitle_cache_", "BV1v1")).toBeNull();
      expect(await mod.readFamilyKeys("boc_subtitle_cache_", "BV1v4")).toEqual(["boc_subtitle_cache_BV1v4_1_id_x"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("segment-cache.js saveRawSegments/saveSegmentSummary 同样记录索引并淘汰旧视频", async () => {
    const seg = await import("../../extension/ai/segment-cache.js");
    // 假时钟步进理由同上：BV1s1 的 raw 键被淘汰依赖时间戳排名
    vi.useFakeTimers();
    try {
      let now = 1000;
      for (const bvid of ["BV1s1", "BV1s2", "BV1s3"]) {
        now += 1000;
        vi.setSystemTime(now);
        await seg.saveRawSegments(seg.getRawSegmentKey({ bvid, cid: "1", subtitleId: "s", segmentIndex: 1 }), []);
        await seg.saveSegmentSummary(seg.getSegmentSummaryKey({ bvid, cid: "1", subtitleId: "s", segmentIndex: 1 }), "小");
      }
      now += 1000;
      vi.setSystemTime(now);
      await seg.saveRawSegments(seg.getRawSegmentKey({ bvid: "BV1s4", cid: "1", subtitleId: "s", segmentIndex: 1 }), [
        { from: 0, to: 5, content: "x" }
      ]);

      expect(storage.map.has("boc_lvs_raw_BV1s1_1_id_s_1")).toBe(false);
      expect(storage.map.has("boc_lvs_raw_BV1s4_1_id_s_1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
