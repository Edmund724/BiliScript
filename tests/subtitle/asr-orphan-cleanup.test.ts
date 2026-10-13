// subtitle/cache.js ASR 孤儿清理测试：
// (d) clearStaleAsrSubtitleCache 只删除同 (bvid, cid) 的过期 ASR 变体键
//     （不同 provider/model/language），平台字幕轨（track / url / lang 三态身份）
//     与其它视频一律不动；keepKey（本轮刚写入的变体）保留。
// 期望键由字幕轨身份构造（subtitle/source-key 的编码单点），不再手抄 "asr:..." 字面量。
// 同时覆盖 subtitle/cache.js 与统一 LRU 的接线：写失败先淘汰重试、最终失败返回 { ok:false }。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import type { TrackIdentity } from "../../extension/subtitle/source-key.js";

let cache: typeof import("../../extension/subtitle/cache.js");
let storage: ChromeHost;

const BODY = [{ from: 0, to: 5, content: "字幕" }];

// 期望键的驱动口：身份（而非三个散字段）进缓存键入口。
function cacheKey(bvid: string, cid: string, identity: TrackIdentity) {
  return cache.getSubtitleCacheKey({ bvid, cid, identity });
}

function asrIdentity(providerId: string, model: string, lang: string): TrackIdentity {
  return { kind: "asr", providerId, model, lang };
}

async function importModules() {
  vi.resetModules();
  resetModuleState();
  storage = installChromeHost();
  cache = await import("../../extension/subtitle/cache.js");
}

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clearStaleAsrSubtitleCache：只清同视频的过期 ASR 变体", () => {
  it("删除同 bvid+cid 的其它 ASR 变体键，保留 keepKey / 平台轨 / 其它视频", async () => {
    const keepKey = cacheKey("BV1o", "7", asrIdentity("new-provider", "gpt", "auto"));
    const staleAsr1 = cacheKey("BV1o", "7", asrIdentity("old-provider", "gpt", "auto"));
    const staleAsr2 = cacheKey("BV1o", "7", asrIdentity("new-provider", "gpt", "zh"));
    const platformId = cacheKey("BV1o", "7", { kind: "track", trackId: "88" });
    const platformUrl = cacheKey("BV1o", "7", { kind: "url", url: "https://a.b/c.json" });
    const platformLang = cacheKey("BV1o", "7", { kind: "lang", lang: "zh-CN" });
    const otherVideoAsr = cacheKey("BV1p", "9", asrIdentity("old-provider", "gpt", "auto"));

    for (const key of [keepKey, staleAsr1, staleAsr2, platformId, platformUrl, platformLang, otherVideoAsr]) {
      storage.seedCacheEntry(key, BODY, 1);
    }

    const removed = await cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey });

    expect(removed.sort()).toEqual([staleAsr1, staleAsr2].sort());
    expect(storage.map.has(keepKey)).toBe(true);
    expect(storage.map.has(staleAsr1)).toBe(false);
    expect(storage.map.has(staleAsr2)).toBe(false);
    // 平台字幕轨不是孤儿：id / url / lang 三种 source key 全保留
    expect(storage.map.has(platformId)).toBe(true);
    expect(storage.map.has(platformUrl)).toBe(true);
    expect(storage.map.has(platformLang)).toBe(true);
    // 其它视频的 ASR 变体不动
    expect(storage.map.has(otherVideoAsr)).toBe(true);
  });

  it("无过期变体 / 缺 bvid+cid / 枚举失败 → 不删任何键并返回 []", async () => {
    const keepKey = cacheKey("BV1o", "7", asrIdentity("a", "m", "auto"));
    storage.seedCacheEntry(keepKey, BODY, 1);

    expect(await cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey })).toEqual([]);
    expect(await cache.clearStaleAsrSubtitleCache({ bvid: "", cid: "", keepKey })).toEqual([]);

    storage.local.get.mockRejectedValue(new Error("boom"));
    await expect(cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey })).resolves.toEqual([]);
    expect(storage.map.has(keepKey)).toBe(true);
  });

  it("索引含该 bvid 条目 → 定点批量枚举出过期变体（11 票分键布局：索引枚举走全量快照）", async () => {
    const keepKey = cacheKey("BV1o", "7", asrIdentity("new", "gpt", "auto"));
    const staleAsr = cacheKey("BV1o", "7", asrIdentity("old", "gpt", "auto"));
    storage.seedCacheEntry(keepKey, BODY, 2);
    storage.seedCacheEntry(staleAsr, BODY, 1);
    // 预置分键索引记录两键（键经生产装配点，宿主 seedIndexEntry）
    for (const key of [keepKey, staleAsr]) {
      storage.seedIndexEntry("biliscript_subtitle_cache_", "BV1o", key, 10);
    }

    const removed = await cache.clearStaleAsrSubtitleCache({ bvid: "BV1o", cid: "7", keepKey });

    expect(removed).toEqual([staleAsr]);
    expect(storage.map.has(staleAsr)).toBe(false);
    expect(storage.map.has(keepKey)).toBe(true);
    // 索引枚举本身是一次 get(null) 快照过滤（11 票分键布局），其后数据读取为定点批量 get
    expect(storage.local.get.mock.calls.filter(([keys]) => keys === null)).toHaveLength(1);
  });
});

describe("saveSubtitleToCache 与统一 LRU 的接线", () => {
  it("写入失败先淘汰重试：重试成功返回 { ok:true } 且旧视频被淘汰", async () => {
    // 预置旧格式汇总清单（数值 ts）造出已满 3 个的族 + 最旧 BV1old
    // （写入目标 BV1n 由 save 内部记录）
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1old", 1);
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1m", 2);
    storage.seedLegacyManifest("biliscript_subtitle_cache_", "BV1w", 3);
    storage.seedCacheEntry("biliscript_subtitle_cache_BV1old_1_id_x", BODY, 1);
    storage.seedCacheEntry("biliscript_subtitle_cache_BV1m_1_id_x", BODY, 2);
    storage.seedCacheEntry("biliscript_subtitle_cache_BV1w_1_id_x", BODY, 3);
    let dataWriteAttempts = 0;
    storage.local.set.mockImplementation(async (items) => {
      // 仅数据键首次写入失败（模拟容量不足），索引记录正常
      if ("biliscript_subtitle_cache_BV1n_1_id_y" in items) {
        dataWriteAttempts += 1;
        if (dataWriteAttempts === 1) {
          throw new Error("quota");
        }
      }
      for (const [key, value] of Object.entries(items)) {
        storage.map.set(key, value);
      }
    });

    const result = await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1n_1_id_y", BODY);

    expect(result).toMatchObject({ ok: true });
    expect(dataWriteAttempts).toBe(2);
    expect(storage.map.has("biliscript_subtitle_cache_BV1old_1_id_x")).toBe(false);
    expect(storage.map.get("biliscript_subtitle_cache_BV1n_1_id_y")).toMatchObject({ body: BODY });
  });

  it("淘汰后重试仍失败 → 返回 { ok:false, error } 不抛异常（logError 由调用方上浮）", async () => {
    storage.local.set.mockRejectedValue(new Error("quota"));
    const result = await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1a_1_id_x", BODY);
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.error).toBeInstanceOf(Error);
    }
  });
});
