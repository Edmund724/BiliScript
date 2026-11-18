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

async function seedThreeOldIdbEntries() {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1old_1_id_x", BODY);
  vi.setSystemTime(2000);
  await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1m_1_id_x", BODY);
  vi.setSystemTime(3000);
  await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1w_1_id_x", BODY);
  vi.setSystemTime(4000);
}

describe("saveSubtitleToCache 与 IndexedDB LRU 的接线", () => {
  it("写入超出 maxEntries=3 时自动按 lastUsed 淘汰最旧分 P，保留新条目", async () => {
    cache.configureSubtitleCacheStoreForTests(cache.createSubtitleIdbStore({ maxEntries: 3 }));
    try {
      await seedThreeOldIdbEntries();

      const result = await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1n_1_id_y", BODY);

      expect(result).toMatchObject({ ok: true });
      await expect(cache.loadSubtitleFromCache("biliscript_subtitle_cache_BV1old_1_id_x")).resolves.toBeNull();
      await expect(cache.loadSubtitleFromCache("biliscript_subtitle_cache_BV1n_1_id_y")).resolves.toEqual(BODY);
    } finally {
      cache.configureSubtitleCacheStoreForTests(null);
      vi.useRealTimers();
    }
  });

  it("IndexedDB 写入失败 → 返回 { ok:false, error } 不抛异常（logError 由调用方上浮）", async () => {
    cache.setSubtitleCacheWriteInterceptorForTests(() => {
      throw new Error("quota");
    });
    const result = await cache.saveSubtitleToCache("biliscript_subtitle_cache_BV1a_1_id_x", BODY);
    cache.setSubtitleCacheWriteInterceptorForTests(null);
    expect(result).toMatchObject({ ok: false, error: expect.any(Error) });
  });
});

// 译文副轨失效：译文键不含原文身份（`id_translate-<lang>` 是已落盘缓存的兼容面），
// 新一版转写落盘后同一目标语言会命中旧原文的译文——必须整体作废。
describe("clearTranslatedSubtitleCache：新转写落盘后旧译文整体作废", () => {
  it("删除同视频的 translate-* 键，保留平台轨 / ASR 变体 / 其它视频", async () => {
    const translatedEn = cacheKey("BV1t", "3", { kind: "track", trackId: "translate-en" });
    const translatedJa = cacheKey("BV1t", "3", { kind: "track", trackId: "translate-ja" });
    const asrKey = cacheKey("BV1t", "3", asrIdentity("provider", "model", "auto"));
    const platformTrack = cacheKey("BV1t", "3", { kind: "track", trackId: "88" });
    const otherVideo = cacheKey("BV1u", "4", { kind: "track", trackId: "translate-en" });

    for (const key of [translatedEn, translatedJa, asrKey, platformTrack, otherVideo]) {
      storage.seedCacheEntry(key, BODY, 1);
    }

    const removed = await cache.clearTranslatedSubtitleCache({ bvid: "BV1t", cid: "3" });

    expect(removed.sort()).toEqual([translatedEn, translatedJa].sort());
    expect(storage.map.has(asrKey)).toBe(true);
    expect(storage.map.has(platformTrack)).toBe(true);
    expect(storage.map.has(otherVideo)).toBe(true);
  });
});

describe("persistAsrSubtitleToCache：落盘主轨后同步清旧 ASR 变体与旧译文副轨", () => {
  it("写入成功：保留新 ASR 键与平台轨，删除同视频旧 ASR 变体与全部 translate-* 译文键", async () => {
    const identity = asrIdentity("new-p", "new-m", "zh");
    const keepKey = cacheKey("BV1p", "5", identity);
    const staleAsr = cacheKey("BV1p", "5", asrIdentity("old-p", "old-m", "auto"));
    const translatedEn = cacheKey("BV1p", "5", { kind: "translated", targetLang: "en" });
    const translatedJa = cacheKey("BV1p", "5", { kind: "translated", targetLang: "ja" });
    const platformTrack = cacheKey("BV1p", "5", { kind: "track", trackId: "88" });
    const otherVideoTranslated = cacheKey("BV1q", "5", { kind: "translated", targetLang: "en" });

    await cache.saveSubtitleToCache(staleAsr, BODY);
    await cache.saveSubtitleToCache(translatedEn, BODY);
    await cache.saveSubtitleToCache(translatedJa, BODY);
    await cache.saveSubtitleToCache(platformTrack, BODY);
    await cache.saveSubtitleToCache(otherVideoTranslated, BODY);

    const result = await cache.persistAsrSubtitleToCache({ bvid: "BV1p", cid: "5", identity, body: BODY });

    expect(result).toMatchObject({ ok: true });
    await expect(cache.loadSubtitleFromCache(keepKey)).resolves.toEqual(BODY);
    await expect(cache.loadSubtitleFromCache(staleAsr)).resolves.toBeNull();
    await expect(cache.loadSubtitleFromCache(translatedEn)).resolves.toBeNull();
    await expect(cache.loadSubtitleFromCache(translatedJa)).resolves.toBeNull();
    await expect(cache.loadSubtitleFromCache(platformTrack)).resolves.toEqual(BODY);
    await expect(cache.loadSubtitleFromCache(otherVideoTranslated)).resolves.toEqual(BODY);
  });

  it("写入失败：不清理旧 ASR 变体与译文缓存，返回 { ok: false }", async () => {
    const identity = asrIdentity("new-p", "new-m", "zh");
    const staleAsr = cacheKey("BV1p", "5", asrIdentity("old-p", "old-m", "auto"));
    const translatedEn = cacheKey("BV1p", "5", { kind: "translated", targetLang: "en" });
    await cache.saveSubtitleToCache(staleAsr, BODY);
    await cache.saveSubtitleToCache(translatedEn, BODY);
    cache.setSubtitleCacheWriteInterceptorForTests(() => {
      throw new Error("quota");
    });

    const result = await cache.persistAsrSubtitleToCache({ bvid: "BV1p", cid: "5", identity, body: BODY });
    cache.setSubtitleCacheWriteInterceptorForTests(null);

    expect(result.ok).toBe(false);
    await expect(cache.loadSubtitleFromCache(staleAsr)).resolves.toEqual(BODY);
    await expect(cache.loadSubtitleFromCache(translatedEn)).resolves.toEqual(BODY);
  });
});
