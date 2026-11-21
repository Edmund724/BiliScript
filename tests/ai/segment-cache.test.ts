import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type CacheEntry, type ChromeHost } from "../helpers/chrome-host.js";
import { buildSubtitleSourceKey } from "../../extension/subtitle/source-key.js";

let mod: typeof import("../../extension/ai/segment-cache.js");
let storage: ChromeHost;

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = installChromeHost();
  mod = await import("../../extension/ai/segment-cache.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("分段小结落盘读写（命中/未命中）", () => {
  it("未 save 的 key load 返回 null；save 后 load 返回原字符串", async () => {
    const key = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });

    expect(await mod.loadSegmentSummary(key)).toBeNull();

    await mod.saveSegmentSummary(key, "小结一：事实A。");
    expect(await mod.loadSegmentSummary(key)).toBe("小结一：事实A。");
    const { defaultSubtitleIdbStore } = await import("../../extension/subtitle/idb-store.js");
    const stored = await defaultSubtitleIdbStore.getAiArtifact<string>(key);
    expect(stored).toMatchObject({ key, family: "biliscript_lvs_summary_", bvid: "BV1a", cid: "1", payload: "小结一：事实A。" });
    expect(stored?.updatedAt).toEqual(expect.any(Number));
    expect(storage.map.has(key)).toBe(false);
  });

  it("存储的是传入的 summary 原值（含空串，空串命中 ≠ 未命中）", async () => {
    const key = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });
    await mod.saveSegmentSummary(key, "");
    expect(await mod.loadSegmentSummary(key)).toBe("");
  });
});

describe("loadStoredSegmentSummaries：直接枚举分段小结", () => {
  it("按段序号升序枚举小结，常态档自动排除 _b50 等非常态预算档", async () => {
    await mod.saveSegmentSummary(mod.getSegmentSummaryKey({ bvid: "BV1enum", cid: "1", subtitleId: "sub-1", segmentIndex: 10 }), "第10段");
    await mod.saveSegmentSummary(mod.getSegmentSummaryKey({ bvid: "BV1enum", cid: "1", subtitleId: "sub-1", segmentIndex: 2 }), "第2段");
    await mod.saveSegmentSummary(mod.getSegmentSummaryKey({ bvid: "BV1enum", cid: "1", subtitleId: "sub-1", segmentIndex: 1 }), "第1段");
    await mod.saveSegmentSummary(mod.getSegmentSummaryKey({ bvid: "BV1enum", cid: "1", subtitleId: "sub-1", segmentIndex: 1, budgetScale: 0.5 }), "半档第1段");
    await mod.saveSegmentSummary(mod.getSegmentSummaryKey({ bvid: "BV1enum", cid: "1", subtitleId: "sub-2", segmentIndex: 1 }), "别轨第1段");

    const summaries = await mod.loadStoredSegmentSummaries({ bvid: "BV1enum", cid: "1", subtitleId: "sub-1" });
    expect(summaries).toEqual(["第1段", "第2段", "第10段"]);

    const halfScale = await mod.loadStoredSegmentSummaries({ bvid: "BV1enum", cid: "1", subtitleId: "sub-1", budgetScale: 0.5 });
    expect(halfScale).toEqual(["半档第1段"]);
  });

  it("索引缺失时优先走 getKeys() + 定点 get(matchedKeys) 不触发 get(null)，缺参或读失败返回 []", async () => {
    const key = mod.getSegmentSummaryKey({ bvid: "BV1scan", cid: "1", subtitleId: "sub-1", segmentIndex: 1 });
    await storage.local.set({
      [key]: { summary: "扫描小结", timestamp: 1 },
      unrelated_big_key: { data: "ignored" }
    });
    storage.local.get.mockClear();
    storage.local.getKeys.mockClear();

    expect(await mod.loadStoredSegmentSummaries({ bvid: "BV1scan", cid: "1", subtitleId: "sub-1" })).toEqual(["扫描小结"]);
    expect(storage.local.getKeys).toHaveBeenCalled();
    expect(storage.local.get).toHaveBeenCalledWith([key]);
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(false);
    expect(storage.map.has(key)).toBe(false);

    expect(await mod.loadStoredSegmentSummaries({ bvid: "", cid: "1" })).toEqual([]);

    storage.local.getKeys.mockRejectedValue(new Error("boom"));
    expect(await mod.loadStoredSegmentSummaries({ bvid: "BV1unmigrated", cid: "1", subtitleId: "sub-1" })).toEqual([]);
  });

  it("极老运行环境不支持 getKeys() 时平滑回退 get(null) 前缀扫描", async () => {
    const key = mod.getSegmentSummaryKey({ bvid: "BV1legacy", cid: "1", subtitleId: "sub-1", segmentIndex: 1 });
    await storage.local.set({ [key]: { summary: "旧环境扫描小结", timestamp: 1 } });
    (storage.local as unknown as { getKeys?: unknown }).getKeys = undefined;
    storage.local.get.mockClear();

    expect(await mod.loadStoredSegmentSummaries({ bvid: "BV1legacy", cid: "1", subtitleId: "sub-1" })).toEqual(["旧环境扫描小结"]);
    expect(storage.local.get).toHaveBeenCalledWith(null);
  });

  it("loadStoredL1Index：常规与无索引路径均优先走 getKeys() + 定点 get，不触发 get(null)", async () => {
    const l1Key = `biliscript_lvs_l1_index_BV1l1_9_${buildSubtitleSourceKey("sub-1", "", "")}_sig1`;
    const record = {
      schemaVersion: 1,
      bvid: "BV1l1",
      cid: "9",
      sourceKey: buildSubtitleSourceKey("sub-1", "", ""),
      subtitleSignature: "sig1",
      updatedAt: 12345,
      lineCount: 1,
      globalSummary: "摘要",
      chapters: [],
      quotes: []
    };
    await storage.local.set({ [l1Key]: { index: record, timestamp: 12345 } });
    storage.local.get.mockClear();
    storage.local.getKeys.mockClear();

    const loaded = await mod.loadStoredL1Index({ bvid: "BV1l1", cid: "9", subtitleId: "sub-1" });
    expect(loaded).toEqual(record);
    expect(storage.local.getKeys).toHaveBeenCalled();
    expect(storage.local.get).toHaveBeenCalledWith([l1Key]);
    expect(storage.local.get.mock.calls.some(([keys]) => keys === null)).toBe(false);
  });
});

describe("中止复用：已落盘的段小结跨会话/编排可读", () => {
  it("先 save 段1、未 save 段2 → 新会话只命中段1、段2 仍未命中", async () => {
    const key1 = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 0 });
    const key2 = mod.getSegmentSummaryKey({ bvid: "BV1a", cid: "1", subtitleId: "sub-1", segmentIndex: 1 });
    await mod.saveSegmentSummary(key1, "段1小结");

    vi.resetModules();
    const freshMod = await import("../../extension/ai/segment-cache.js");
    expect(await freshMod.loadSegmentSummary(key1)).toBe("段1小结");
    expect(await freshMod.loadSegmentSummary(key2)).toBeNull();
  });
});

describe("换轨不串：缓存键随字幕轨区分", () => {
  it("同一 bvid+cid+段、不同 subtitleId → 不同 key，load 互不可见", async () => {
    const base = { bvid: "BV1a", cid: "1", segmentIndex: 0 };
    const trackA = mod.getSegmentSummaryKey({ ...base, subtitleId: "sub-A" });
    const trackB = mod.getSegmentSummaryKey({ ...base, subtitleId: "sub-B" });
    expect(trackA).not.toBe(trackB);

    await mod.saveSegmentSummary(trackA, "A轨小结");
    expect(await mod.loadSegmentSummary(trackA)).toBe("A轨小结");
    expect(await mod.loadSegmentSummary(trackB)).toBeNull();
  });

  it("source key 区分 id / url / lang 三种来源，id 优先", () => {
    const base = { bvid: "BV1a", cid: "1", segmentIndex: 0 };
    const idKey = mod.getSegmentSummaryKey({ ...base, subtitleId: "sub-1" });
    const urlKey = mod.getSegmentSummaryKey({ ...base, subtitleUrl: "https://s.example.com/sub/1.json" });
    const langKey = mod.getSegmentSummaryKey({ ...base, lang: "zh-CN" });
    expect(new Set([idKey, urlKey, langKey]).size).toBe(3);

    const bothKey = mod.getSegmentSummaryKey({
      ...base,
      subtitleId: "sub-1",
      subtitleUrl: "https://s.example.com/sub/1.json"
    });
    expect(bothKey).toBe(idKey);
  });
});

describe("键含 bvid+cid+段，键风格对齐 getSubtitleCacheKey", () => {
  it("不同 bvid / cid / segmentIndex → 不同 key", () => {
    const k = (bvid: string, cid: string, segmentIndex: number) =>
      mod.getSegmentSummaryKey({ bvid, cid, segmentIndex, subtitleId: "sub-1" });
    const keys = [k("BV1a", "1", 0), k("BV1b", "1", 0), k("BV1a", "2", 0), k("BV1a", "1", 1)];
    expect(new Set(keys).size).toBe(4);
  });

  it("key 中间段即 buildSubtitleSourceKey 产物；换 URL 中 id（路径变化）source key 变，仅换 query 不变", async () => {
    const base = { bvid: "BV1a", cid: "1", segmentIndex: 3 };
    const url = "https://s.example.com/sub/abc.json?auth=1";
    const key = mod.getSegmentSummaryKey({ ...base, subtitleUrl: url });
    expect(key).toBe(`biliscript_lvs_summary_BV1a_1_${buildSubtitleSourceKey("", url, "")}_3`);

    const url2 = "https://s.example.com/sub/def.json?auth=2";
    expect(mod.getSegmentSummaryKey({ ...base, subtitleUrl: url2 })).not.toBe(key);
    expect(mod.getSegmentSummaryKey({ ...base, subtitleUrl: "https://s.example.com/sub/abc.json?auth=999" })).toBe(key);
  });
});

describe("上下文键位构造器：与原手拼键逐字节一致（预热缓存不失效）", () => {
  const context = {
    bvid: "BV1ctx",
    cid: "7",
    selectedSubtitleId: "sub-9",
    selectedSubtitleUrl: "https://s.example.com/sub/9.json?auth=1",
    subtitleLang: "zh-CN",
    title: "测试视频",
    subtitleBody: [{ from: 0, to: 5, content: "x" }]
  };

  it("键位字段从零依赖叶派生：上下文按单源表映射为键位入参，且只挑键位字段", async () => {
    const { SEGMENT_CACHE_KEY_FIELDS, segmentCacheKeyFields: leafKeyFields } = await import(
      "../../extension/ai/segment-cache-key-fields.js"
    );
    expect(mod.segmentCacheKeyFields).toBe(leafKeyFields);
    expect(mod.segmentCacheKeyFields(context)).toEqual(
      Object.fromEntries(SEGMENT_CACHE_KEY_FIELDS.map((field) => [field.key, context[field.context]] as const))
    );
    expect(mod.segmentCacheKeyFields(null)).toEqual(
      Object.fromEntries(SEGMENT_CACHE_KEY_FIELDS.map((field) => [field.key, undefined] as const))
    );
  });

  it("统一构造器落盘 → 手拼键可读回（跨写读方一致）", async () => {
    const summaryKey = mod.buildSegmentSummaryCacheKey(context, 2);
    await mod.saveSegmentSummary(summaryKey, "统一键位小结");

    const legacySummaryKey = mod.getSegmentSummaryKey({
      bvid: context.bvid,
      cid: context.cid,
      subtitleId: context.selectedSubtitleId,
      subtitleUrl: context.selectedSubtitleUrl,
      lang: context.subtitleLang,
      segmentIndex: 2
    });
    expect(await mod.loadSegmentSummary(legacySummaryKey)).toBe("统一键位小结");
  });
});

describe("容错：读写失败不抛异常", () => {
  it("load 读失败返回 null", async () => {
    storage.local.get.mockRejectedValueOnce(new Error("read boom"));
    await expect(mod.loadSegmentSummary("biliscript_lvs_summary_x")).resolves.toBeNull();
  });

  it("save 写失败先淘汰重试：重试成功返回 { ok:true } 且不抛", async () => {
    storage.local.set.mockRejectedValueOnce(new Error("write boom"));
    await expect(mod.saveSegmentSummary("biliscript_lvs_summary_x", "小结")).resolves.toMatchObject({ ok: true });
  });

  it("save 持续失败返回 { ok:false, error } 且不抛异常", async () => {
    const { setSubtitleCacheWriteInterceptorForTests } = await import("../../extension/subtitle/store-client.js");
    setSubtitleCacheWriteInterceptorForTests(() => {
      throw new Error("quota");
    });
    try {
      const summaryResult = await mod.saveSegmentSummary("biliscript_lvs_summary_x", "小结");
      expect(summaryResult).toMatchObject({ ok: false, error: expect.any(Error) });
    } finally {
      setSubtitleCacheWriteInterceptorForTests(null);
    }
  });
});

describe("预算代隔离：budgetScale≠1 时 key 带代后缀（防段边界漂移命中错位小结）", () => {
  const context = {
    bvid: "BV1scale",
    cid: "5",
    selectedSubtitleId: "sub-1",
    selectedSubtitleUrl: "",
    subtitleLang: "zh-CN"
  };

  it("budgetScale=1 / 缺省 → key 不带后缀，与历史键逐字节一致（零迁移）", () => {
    const byDefault = mod.buildSegmentSummaryCacheKey(context, 3);
    const scaleOne = mod.buildSegmentSummaryCacheKey(context, 3, 1);
    const explicit = mod.buildSegmentSummaryCacheKey(context, 3, undefined);
    expect(byDefault).toBe(scaleOne);
    expect(byDefault).toBe(explicit);
    expect(byDefault).toBe("biliscript_lvs_summary_BV1scale_5_id_sub-1_3");
  });

  it("budgetScale=0.5 → 追加 _b50 后缀；scale=2 → _b200", () => {
    expect(mod.buildSegmentSummaryCacheKey(context, 3, 0.5)).toBe("biliscript_lvs_summary_BV1scale_5_id_sub-1_3_b50");
    expect(mod.buildSegmentSummaryCacheKey(context, 3, 2)).toBe("biliscript_lvs_summary_BV1scale_5_id_sub-1_3_b200");
  });

  it("同段序号不同预算档 → key 不同（0.5 档绝不命中 1 档已落盘小结）", async () => {
    await mod.saveSegmentSummary(mod.buildSegmentSummaryCacheKey(context, 1), "常态档小结");
    expect(await mod.loadSegmentSummary(mod.buildSegmentSummaryCacheKey(context, 1))).toBe("常态档小结");
    expect(await mod.loadSegmentSummary(mod.buildSegmentSummaryCacheKey(context, 1, 0.5))).toBeNull();
  });

  it("非法 budgetScale（非数）按缺省档处理（无后缀）", () => {
    expect(mod.buildSegmentSummaryCacheKey(context, 3, "x")).toBe("biliscript_lvs_summary_BV1scale_5_id_sub-1_3");
  });
});
