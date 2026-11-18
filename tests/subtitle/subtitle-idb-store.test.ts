// IndexedDB 分层字幕仓库（biliscript-subtitle-store）单元测试：
// 1) 验证同一 ${bvid}:${cid} 下：
//    - 纯中文 ai-zh 仅本地断句（不开启外译）落 rawTracks + segmentedTracks，绝不创建空译文记录；
//    - 原生 en-US + zh-CN 双人工 CC 轨共存于 rawTracks；
//    - 基于 en-US 生成 AI 中文精翻仅写 translatedTracks（1500ms 防抖合入、pagehide/visibilitychange 立即 flush），各层互不污染；
//    - 验证真实 IDBFactory 事务后端与旧版 chrome.storage.local 遗留键平滑迁移；
// 2) 验证非内容网络/调度参数变更不影响 segmentationSig / translationSig，
//    以及分 P 条目数（默认 100）与累计估算体积（默认 150 MB）双阈值 LRU 淘汰顺序与命中刷新 lastUsed。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { state, clipState } from "../../extension/core/state.js";
import { acceptSubtitle, configureCommitUi } from "../../extension/subtitle/commit.js";
import {
  DEFAULT_SUBTITLE_CACHE_MAX_BYTES,
  DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES,
  SUBTITLE_IDB_STORE,
  buildSegmentationSignature,
  buildSegmentedTrackMapKey,
  buildSubtitlePageId,
  buildTranslatedTrackMapKey,
  buildTranslationSignature,
  configureSubtitleCacheStoreForTests,
  createSubtitleIdbStore,
  flushSubtitleCache,
  getSubtitleCacheKey,
  getSubtitlePageCacheRecord,
  loadRawSubtitleTrack,
  loadSegmentedSubtitleTrack,
  loadSubtitleFromCache,
  loadTranslatedSubtitleTrack,
  saveRawSubtitleTrack,
  saveTranslatedSubtitleTrack,
  scheduleTranslatedTrackWrite
} from "../../extension/subtitle/cache.js";
import { subtitleSourceKey, trackIdentity } from "../../extension/subtitle/source-key.js";

const BVID = "BV1idb000001";
const CID = "88001";

const AI_ZH_RAW = [
  { from: 0, to: 1.5, content: "大家好" },
  { from: 1.6, to: 3.2, content: "欢迎来到本期课程" },
  { from: 3.3, to: 5.0, content: "今天讲分层缓存" }
];

const EN_US_RAW = [
  { from: 0, to: 2.5, content: "Welcome to the lecture on subtitle caching." },
  { from: 2.6, to: 5.2, content: "Each layer stays isolated cleanly." }
];

const ZH_CN_RAW = [
  { from: 0, to: 2.5, content: "欢迎收看字幕缓存专题讲座。" },
  { from: 2.6, to: 5.2, content: "每一层都保持干净隔离。" }
];

function createFakeIdbFactory(): IDBFactory {
  const databases = new Map<string, Map<string, Map<string, unknown>>>();

  function cloneVal<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  return {
    open(name: string) {
      let dbStores = databases.get(name);
      const isUpgrade = !dbStores;
      if (!dbStores) {
        dbStores = new Map();
        databases.set(name, dbStores);
      }
      const req = {
        result: null as unknown as IDBDatabase,
        transaction: null as unknown as IDBTransaction | null,
        error: null,
        onupgradeneeded: null as ((ev: IDBVersionChangeEvent) => void) | null,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null
      };

      const makeObjectStoreApi = (storeMap: Map<string, unknown>, trackOp?: (fn: () => void) => void) => {
        const indexSet = new Set<string>();
        const makeReq = <T>() => ({
          result: undefined as unknown as T,
          error: null,
          onsuccess: null as ((ev: Event) => void) | null,
          onerror: null as ((ev: Event) => void) | null
        });
        const runAsync = <T>(exec: () => T) => {
          const r = makeReq<T>();
          const runner = () => {
            r.result = exec();
            r.onsuccess?.(new Event("success"));
          };
          if (trackOp) {
            trackOp(runner);
          } else {
            queueMicrotask(runner);
          }
          return r as unknown as IDBRequest<T>;
        };
        return {
          indexNames: {
            contains: (idxName: string) => indexSet.has(idxName)
          },
          createIndex(idxName: string) {
            indexSet.add(idxName);
            return {} as IDBIndex;
          },
          get(key: IDBValidKey) {
            return runAsync(() => {
              const found = storeMap.get(String(key));
              return found === undefined ? undefined : cloneVal(found);
            });
          },
          getAll() {
            return runAsync(() => Array.from(storeMap.values()).map((v) => cloneVal(v)));
          },
          put(val: { id: string }) {
            return runAsync(() => {
              storeMap.set(String(val.id), cloneVal(val));
              return String(val.id);
            });
          },
          delete(key: IDBValidKey) {
            return runAsync(() => {
              storeMap.delete(String(key));
              return undefined;
            });
          },
          clear() {
            return runAsync(() => {
              storeMap.clear();
              return undefined;
            });
          }
        };
      };

      const dbApi = {
        objectStoreNames: {
          contains: (storeName: string) => dbStores!.has(storeName)
        },
        createObjectStore(storeName: string) {
          const storeMap = new Map<string, unknown>();
          dbStores!.set(storeName, storeMap);
          return makeObjectStoreApi(storeMap) as unknown as IDBObjectStore;
        },
        close() {},
        onversionchange: null as ((ev: IDBVersionChangeEvent) => void) | null,
        onclose: null as ((ev: Event) => void) | null,
        transaction(storeNames: string | string[]) {
          const targetName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
          let pending = 0;
          let finished = false;
          const scheduleComplete = () => {
            queueMicrotask(() => {
              queueMicrotask(() => {
                if (pending === 0 && !finished) {
                  finished = true;
                  tx.oncomplete?.(new Event("complete"));
                }
              });
            });
          };
          const tx = {
            error: null,
            oncomplete: null as ((ev: Event) => void) | null,
            onerror: null as ((ev: Event) => void) | null,
            onabort: null as ((ev: Event) => void) | null,
            objectStore(name: string) {
              const storeMap = dbStores!.get(name || targetName);
              if (!storeMap) {
                throw new Error(`Missing object store ${name}`);
              }
              return makeObjectStoreApi(storeMap, (runner) => {
                pending += 1;
                queueMicrotask(() => {
                  runner();
                  pending -= 1;
                  scheduleComplete();
                });
              }) as unknown as IDBObjectStore;
            }
          };
          return tx as unknown as IDBTransaction;
        }
      } as unknown as IDBDatabase;

      req.result = dbApi;
      queueMicrotask(() => {
        if (isUpgrade) {
          req.transaction = dbApi.transaction(SUBTITLE_IDB_STORE);
          req.onupgradeneeded?.({} as IDBVersionChangeEvent);
          req.transaction = null;
        }
        req.onsuccess?.(new Event("success"));
      });
      return req as unknown as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;
}

function seedMultiLangTracksOnClip(): void {
  clipState.setBvid(BVID);
  clipState.setCid(CID);
  clipState.setSubtitles([
    { id: "track-ai-zh", lan: "ai-zh", lanDoc: "中文（自动生成）", subtitleUrl: "https://sub.test/ai-zh.json" },
    { id: "track-en-us", lan: "en-US", lanDoc: "英语（美国）", subtitleUrl: "https://sub.test/en-us.json" },
    { id: "track-zh-cn", lan: "zh-CN", lanDoc: "中文（中国）", subtitleUrl: "https://sub.test/zh-cn.json" }
  ]);
}

function makeLargeBody(marker: string, lineCount = 40, padLength = 350): Array<{ from: number; to: number; content: string }> {
  const pad = marker.repeat(Math.ceil(padLength / marker.length)).slice(0, padLength);
  const items: Array<{ from: number; to: number; content: string }> = [];
  for (let i = 0; i < lineCount; i += 1) {
    items.push({ from: i * 2, to: i * 2 + 1.5, content: `${marker}-${i}-${pad}` });
  }
  return items;
}

let chromeHost: ChromeHost;

beforeEach(() => {
  vi.useRealTimers();
  resetModuleState();
  configureSubtitleCacheStoreForTests(null);
  chromeHost = installChromeHost();
  configureCommitUi({ setStatus: vi.fn() });
  state.setSettings({
    ...state.settings,
    subtitleSegmentationStrategy: "auto",
    subtitleTranslateModel: "Index-Translate-35B-A3B",
    subtitleTranslateGlossary: "Cache=缓存\nIndexedDB=本地库\nUnusedTerm=未使用术语"
  });
  seedMultiLangTracksOnClip();
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  vi.useRealTimers();
});

describe("分层 IndexedDB 字幕仓库（三层共存与边界隔离）", () => {
  it("同分 P 共存三类轨道：纯中文 ai-zh 仅写 raw + segmented（不建空译文），与 en-US/zh-CN 原生双轨及 AI 精翻互不污染", async () => {
    vi.useFakeTimers();

    const aiTrackKey = subtitleSourceKey(trackIdentity("track-ai-zh", "https://sub.test/ai-zh.json", "ai-zh"));
    const enTrackKey = subtitleSourceKey(trackIdentity("track-en-us", "https://sub.test/en-us.json", "en-US"));
    const zhTrackKey = subtitleSourceKey(trackIdentity("track-zh-cn", "https://sub.test/zh-cn.json", "zh-CN"));

    await saveRawSubtitleTrack({
      bvid: BVID,
      cid: CID,
      trackKey: aiTrackKey,
      lang: "ai-zh",
      kind: "bili-ai",
      items: AI_ZH_RAW
    });
    const acceptedSegmented = await acceptSubtitle({
      body: AI_ZH_RAW,
      selectedSubtitleId: "track-ai-zh",
      selectedSubtitleUrl: "https://sub.test/ai-zh.json",
      selectedSubtitleLang: "ai-zh",
      skipHotComments: true
    });

    const segSig = buildSegmentationSignature({ strategy: "auto", lang: "ai-zh" });
    const pageAfterAiSeg = await getSubtitlePageCacheRecord(BVID, CID);

    expect(pageAfterAiSeg?.id).toBe(buildSubtitlePageId(BVID, CID));
    expect(pageAfterAiSeg?.rawTracks[aiTrackKey]?.items).toEqual(AI_ZH_RAW);
    expect(pageAfterAiSeg?.segmentedTracks[buildSegmentedTrackMapKey(aiTrackKey, segSig)]?.items).toEqual(
      acceptedSegmented
    );
    expect(pageAfterAiSeg?.translatedTracks).toEqual({});

    await saveRawSubtitleTrack({
      bvid: BVID,
      cid: CID,
      trackKey: enTrackKey,
      lang: "en-US",
      kind: "manual-cc",
      items: EN_US_RAW
    });
    await saveRawSubtitleTrack({
      bvid: BVID,
      cid: CID,
      trackKey: zhTrackKey,
      lang: "zh-CN",
      kind: "manual-cc",
      items: ZH_CN_RAW
    });

    const translationSig = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      glossary: "Cache=缓存\nUnusedTerm=未使用"
    });
    scheduleTranslatedTrackWrite({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enTrackKey,
      targetLang: "zh-CN",
      translationSig,
      mode: "cc-json",
      items: [{ from: 0, to: 2.5, content: "   " }]
    });
    await vi.advanceTimersByTimeAsync(1600);
    const pageAfterBlankWrite = await getSubtitlePageCacheRecord(BVID, CID);
    expect(pageAfterBlankWrite?.translatedTracks).toEqual({});

    scheduleTranslatedTrackWrite({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enTrackKey,
      targetLang: "zh-CN",
      translationSig,
      mode: "cc-json",
      items: [{ from: 0, to: 2.5, content: "欢迎来到字幕缓存讲座。" }]
    });
    await vi.advanceTimersByTimeAsync(1000);
    scheduleTranslatedTrackWrite({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enTrackKey,
      targetLang: "zh-CN",
      translationSig,
      mode: "cc-json",
      items: [{ from: 2.6, to: 5.2, content: "各层数据严格隔离。" }]
    });
    await vi.advanceTimersByTimeAsync(1600);

    const finalPage = await getSubtitlePageCacheRecord(BVID, CID);
    const trMapKey = buildTranslatedTrackMapKey(enTrackKey, "zh-CN", translationSig);

    expect(Object.keys(finalPage?.rawTracks ?? {}).sort()).toEqual(
      [aiTrackKey, enTrackKey, zhTrackKey].sort()
    );
    expect(finalPage?.rawTracks[enTrackKey]?.items).toEqual(EN_US_RAW);
    expect(finalPage?.rawTracks[zhTrackKey]?.items).toEqual(ZH_CN_RAW);
    expect(finalPage?.segmentedTracks[buildSegmentedTrackMapKey(aiTrackKey, segSig)]?.items).toEqual(
      acceptedSegmented
    );
    expect(finalPage?.translatedTracks[trMapKey]?.items).toEqual([
      { from: 0, to: 2.5, content: "欢迎来到字幕缓存讲座。" },
      { from: 2.6, to: 5.2, content: "各层数据严格隔离。" }
    ]);
    await expect(
      loadSegmentedSubtitleTrack({ bvid: BVID, cid: CID, trackKey: aiTrackKey, segmentationSig: segSig })
    ).resolves.toEqual(acceptedSegmented);
    await expect(
      loadTranslatedSubtitleTrack({
        bvid: BVID,
        cid: CID,
        sourceTrackKey: enTrackKey,
        targetLang: "zh-CN",
        translationSig
      })
    ).resolves.toEqual([
      { from: 0, to: 2.5, content: "欢迎来到字幕缓存讲座。" },
      { from: 2.6, to: 5.2, content: "各层数据严格隔离。" }
    ]);
  });

  it("流式防抖缓冲在 1500ms 前不写盘；pagehide 与 visibilitychange=hidden 立即 flush 落盘", async () => {
    vi.useFakeTimers();
    const enKey = subtitleSourceKey(trackIdentity("track-en-us", "https://sub.test/en-us.json", "en-US"));
    const sig = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN"
    });
    const fakeIdbStore = createSubtitleIdbStore({ indexedDB: createFakeIdbFactory() });
    configureSubtitleCacheStoreForTests(fakeIdbStore);

    scheduleTranslatedTrackWrite({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enKey,
      targetLang: "zh-CN",
      translationSig: sig,
      items: [{ from: 0, to: 2, content: "第一句防抖" }]
    });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(fakeIdbStore.getPageRecord(BVID, CID)).resolves.toBeNull();

    window.dispatchEvent(new Event("pagehide"));
    await flushSubtitleCache();
    await expect(
      fakeIdbStore.getTranslatedTrack(BVID, CID, enKey, "zh-CN", sig)
    ).resolves.toEqual([{ from: 0, to: 2, content: "第一句防抖" }]);

    scheduleTranslatedTrackWrite({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enKey,
      targetLang: "zh-CN",
      translationSig: sig,
      items: [{ from: 2, to: 4, content: "第二句切后台" }]
    });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flushSubtitleCache();

    await expect(
      fakeIdbStore.getTranslatedTrack(BVID, CID, enKey, "zh-CN", sig)
    ).resolves.toEqual([
      { from: 0, to: 2, content: "第一句防抖" },
      { from: 2, to: 4, content: "第二句切后台" }
    ]);
  });

  it("兼容旧版 chrome.storage.local 遗留字幕键：命中后迁移至 IndexedDB 并清理旧键", async () => {
    const legacyKey = getSubtitleCacheKey({
      bvid: BVID,
      cid: CID,
      identity: trackIdentity("track-en-us", "https://sub.test/en-us.json", "en-US")
    });
    chromeHost.seedCacheEntry(legacyKey, EN_US_RAW, 100);

    const loaded = await loadSubtitleFromCache(legacyKey);
    expect(loaded).toEqual(EN_US_RAW);
    expect(chromeHost.hasEntry(legacyKey)).toBe(false);
    await expect(
      loadRawSubtitleTrack({
        bvid: BVID,
        cid: CID,
        trackKey: subtitleSourceKey(trackIdentity("track-en-us", "https://sub.test/en-us.json", "en-US"))
      })
    ).resolves.toEqual(EN_US_RAW);
  });
});

describe("抗干扰内容签名与双阈值 LRU 淘汰", () => {
  it("非内容调度参数（超时/并发/重试/密钥/未命中术语）不变动签名；模型/协议/语言/Prompt/命中术语变更即失效", () => {
    const segBase = buildSegmentationSignature({
      strategy: "auto",
      lang: "ai-zh",
      maxCjkChars: 18,
      timeoutMs: 3000,
      concurrency: 2,
      retryDelayMs: 250
    });
    const segScheduleChanged = buildSegmentationSignature({
      strategy: "auto",
      lang: "zh-CN",
      maxCjkChars: 18,
      timeoutMs: 12000,
      concurrency: 6,
      retryDelayMs: 2000
    });
    const segRuleChanged = buildSegmentationSignature({
      strategy: "rule",
      lang: "zh-CN",
      maxCjkChars: 18
    });
    expect(segScheduleChanged).toBe(segBase);
    expect(segRuleChanged).not.toBe(segBase);

    const glossary = "Cache=缓存\nSharding=分片\nQuantum=量子";
    const sourceText = "Subtitle Cache uses chunking.";
    const trBase = buildTranslationSignature({
      model: "index-translate-35b-a3b",
      protocolVersion: "cc-json",
      targetLang: "zh",
      customPrompt: "keep concise",
      glossary,
      sourceText,
      timeoutMs: 5000,
      concurrency: 2,
      retryDelayMs: 300,
      apiKey: "sk-1",
      baseUrl: "https://example.com"
    });
    const trScheduleOnly = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      customPrompt: "keep concise",
      glossary: "Cache=缓存\nSharding=分片\nQuantum=黑洞\nExtraUnused=多余术语",
      sourceText,
      timeoutMs: 60000,
      concurrency: 8,
      retryDelayMs: 5000,
      apiKey: "sk-2",
      baseUrl: "https://mirror.example.com"
    });
    const trMatchedGlossaryChanged = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      customPrompt: "keep concise",
      glossary: "Cache=高速缓存\nSharding=分片",
      sourceText
    });
    const trProtocolChanged = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "boundary-v3",
      targetLang: "zh-CN",
      customPrompt: "keep concise",
      glossary,
      sourceText
    });
    const trModelChanged = buildTranslationSignature({
      model: "Index-Translate-9B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      customPrompt: "keep concise",
      glossary,
      sourceText
    });
    const trPromptChanged = buildTranslationSignature({
      model: "Index-Translate-35B-A3B",
      protocolVersion: "cc-json",
      targetLang: "zh-CN",
      customPrompt: "formal tone",
      glossary,
      sourceText
    });

    expect(trScheduleOnly).toBe(trBase);
    expect(trMatchedGlossaryChanged).not.toBe(trBase);
    expect(trProtocolChanged).not.toBe(trBase);
    expect(trModelChanged).not.toBe(trBase);
    expect(trPromptChanged).not.toBe(trBase);
  });

  it("双阈值默认值（100 条 / 150 MB）且命中刷新 lastUsed，分别按条目数与字节体积精确 LRU 淘汰", async () => {
    expect(DEFAULT_SUBTITLE_CACHE_MAX_ENTRIES).toBe(100);
    expect(DEFAULT_SUBTITLE_CACHE_MAX_BYTES).toBe(150 * 1024 * 1024);

    let clock = 1000;
    const countStore = createSubtitleIdbStore({
      indexedDB: null,
      maxEntries: 3,
      maxBytes: 10 * 1024 * 1024,
      now: () => {
        clock += 100;
        return clock;
      }
    });

    await countStore.putRawTrack({ bvid: BVID, cid: "p1", trackKey: "id:1", items: EN_US_RAW });
    await countStore.putRawTrack({ bvid: BVID, cid: "p2", trackKey: "id:2", items: EN_US_RAW });
    await countStore.putRawTrack({ bvid: BVID, cid: "p3", trackKey: "id:3", items: EN_US_RAW });
    // 命中 p1 刷新其 lastUsed，最旧变为 p2
    await countStore.getRawTrack(BVID, "p1", "id:1");
    const p4Result = await countStore.putRawTrack({ bvid: BVID, cid: "p4", trackKey: "id:4", items: EN_US_RAW });

    expect(p4Result.ok).toBe(true);
    expect(p4Result.evictedIds).toEqual([buildSubtitlePageId(BVID, "p2")]);
    await expect(countStore.getPageRecord(BVID, "p2")).resolves.toBeNull();
    await expect(countStore.getPageRecord(BVID, "p1")).resolves.not.toBeNull();

    const largeA = makeLargeBody("A");
    const largeB = makeLargeBody("B");
    const largeC = makeLargeBody("C");
    const probeStore = createSubtitleIdbStore({ indexedDB: null, maxEntries: 100, maxBytes: 100 * 1024 * 1024 });
    const probeWrite = await probeStore.putRawTrack({ bvid: BVID, cid: "probe", trackKey: "id:probe", items: largeA });
    const singleBytes = probeWrite.estimatedBytes ?? 20_000;

    let byteClock = 5000;
    const byteStore = createSubtitleIdbStore({
      indexedDB: null,
      maxEntries: 100,
      maxBytes: Math.floor(singleBytes * 2.2),
      now: () => {
        byteClock += 100;
        return byteClock;
      }
    });
    await byteStore.putRawTrack({ bvid: BVID, cid: "b1", trackKey: "id:b1", items: largeA });
    await byteStore.putRawTrack({ bvid: BVID, cid: "b2", trackKey: "id:b2", items: largeB });
    await byteStore.getRawTrack(BVID, "b1", "id:b1");
    const byteEvictRes = await byteStore.putRawTrack({ bvid: BVID, cid: "b3", trackKey: "id:b3", items: largeC });

    expect(byteEvictRes.ok).toBe(true);
    expect(byteEvictRes.evictedIds).toEqual([buildSubtitlePageId(BVID, "b2")]);
    await expect(byteStore.getPageRecord(BVID, "b2")).resolves.toBeNull();
    await expect(byteStore.getPageRecord(BVID, "b1")).resolves.not.toBeNull();
    await expect(byteStore.getPageRecord(BVID, "b3")).resolves.not.toBeNull();
  });

  it("saveTranslatedSubtitleTrack 支持增量按时间合并而不覆盖未重叠旧译文", async () => {
    const enKey = subtitleSourceKey(trackIdentity("track-en-us", "https://sub.test/en-us.json", "en-US"));
    const sig = buildTranslationSignature({ model: "Index-Translate-35B-A3B", protocolVersion: "cc-json", targetLang: "zh-CN" });

    await saveTranslatedSubtitleTrack({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enKey,
      targetLang: "zh-CN",
      translationSig: sig,
      items: [{ from: 0, to: 2, content: "首段译文" }]
    });
    await saveTranslatedSubtitleTrack({
      bvid: BVID,
      cid: CID,
      sourceTrackKey: enKey,
      targetLang: "zh-CN",
      translationSig: sig,
      items: [{ from: 60, to: 63, content: "第二片译文" }]
    });

    await expect(
      loadTranslatedSubtitleTrack({ bvid: BVID, cid: CID, sourceTrackKey: enKey, targetLang: "zh-CN", translationSig: sig })
    ).resolves.toEqual([
      { from: 0, to: 2, content: "首段译文" },
      { from: 60, to: 63, content: "第二片译文" }
    ]);
  });
});
