// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import {
  AI_ARTIFACTS_IDB_STORE,
  AI_ARTIFACTS_INDEX_BVID,
  AI_ARTIFACTS_INDEX_FAMILY_BVID,
  AI_ARTIFACTS_INDEX_FAMILY_LAST_USED,
  AI_ARTIFACTS_INDEX_LAST_USED,
  AI_ARTIFACT_FAMILY_KEEP_VIDEOS,
  CHAT_IMAGES_IDB_STORE,
  CHAT_IMAGES_INDEX_BVID,
  CHAT_IMAGES_INDEX_CONVERSATION_ID,
  CHAT_IMAGES_INDEX_LAST_USED,
  SUBTITLE_IDB_BVID_INDEX,
  SUBTITLE_IDB_LAST_USED_INDEX,
  SUBTITLE_IDB_STORE,
  SUBTITLE_IDB_VERSION,
  buildSubtitlePageId,
  createSubtitleIdbStore
} from "../../extension/subtitle/idb-store.js";
import {
  clearVideoCache,
  configureSubtitleCacheStoreForTests,
  getSubtitleCacheKey,
  loadRawSubtitleTrack,
  saveRawSubtitleTrack,
  scheduleTranslatedTrackWrite,
  setSubtitleCacheWriteInterceptorForTests
} from "../../extension/subtitle/cache.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import {
  STORAGE_TO_IDB_MIGRATION_DONE_KEY,
  migrateLegacyLocalStorageToIdb
} from "../../extension/subtitle/storage-migration.js";
import {
  ANALYSIS_FINAL_PREFIX,
  L1_INDEX_CACHE_PREFIX,
  buildAnalysisFinalCacheKey,
  buildL1IndexCacheKey,
  buildL1VideoIndex,
  clearL1IndexMemoryCache,
  loadAnalysisFinal,
  loadL1Index,
  readCachedClipOverviewArtifacts,
  saveAnalysisFinal,
  saveL1Index
} from "../../extension/ai/l1-chapter-index.js";
import {
  getSegmentSummaryKey,
  loadSegmentSummary,
  loadStoredSegmentSummaries
} from "../../extension/ai/segment-cache.js";
import { buildLruIndexEntryKey, LRU_MANIFEST_STORAGE_KEY } from "../../extension/core/cache-lru.js";
import { trackIdentity } from "../../extension/subtitle/source-key.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../../extension/shared/messaging-protocol.js";

interface FakeStoreState {
  keyPath: string;
  records: Map<string, Record<string, unknown>>;
  indexes: Map<string, string | string[]>;
}

interface FakeDbState {
  version: number;
  stores: Map<string, FakeStoreState>;
}

function extractKeyPathValue(record: Record<string, unknown>, keyPath: string | string[]): unknown {
  if (Array.isArray(keyPath)) {
    return keyPath.map((k) => record[k]);
  }
  return record[keyPath];
}

function matchesIdbQuery(value: unknown, query: unknown): boolean {
  if (query === undefined || query === null) {
    return true;
  }
  if (typeof query === "object" && query !== null && "lower" in query && "upper" in query) {
    const range = query as { lower: unknown; upper: unknown };
    if (Array.isArray(value) && Array.isArray(range.lower) && Array.isArray(range.upper)) {
      if (value[0] !== range.lower[0] || value[0] !== range.upper[0]) {
        return false;
      }
      const num = Number(value[1]);
      return num >= Number(range.lower[1]) && num <= Number(range.upper[1]);
    }
    return true;
  }
  if (Array.isArray(query)) {
    return Array.isArray(value) && query.length === value.length && query.every((q, i) => value[i] === q);
  }
  return value === query;
}

function createVersionedFakeIdbFactory() {
  const databases = new Map<string, FakeDbState>();

  function cloneVal<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  function makeStoreApi(
    storeState: FakeStoreState,
    trackOp?: (fn: () => void) => void
  ): IDBObjectStore {
    const runAsync = <T>(exec: () => T) => {
      const r = {
        result: undefined as unknown as T,
        error: null,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null
      };
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
        contains: (name: string) => storeState.indexes.has(name)
      },
      createIndex(name: string, keyPath: string | string[]) {
        storeState.indexes.set(name, keyPath);
        return {} as IDBIndex;
      },
      index(name: string) {
        const keyPath = storeState.indexes.get(name);
        if (!keyPath) {
          throw new Error(`Missing index ${name}`);
        }
        return {
          getAll(query?: unknown) {
            return runAsync(() =>
              Array.from(storeState.records.values())
                .filter((rec) => matchesIdbQuery(extractKeyPathValue(rec, keyPath), query))
                .map((rec) => cloneVal(rec))
            );
          }
        } as unknown as IDBIndex;
      },
      get(key: IDBValidKey) {
        return runAsync(() => {
          const hit = storeState.records.get(String(key));
          return hit === undefined ? undefined : cloneVal(hit);
        });
      },
      getAll() {
        return runAsync(() => Array.from(storeState.records.values()).map((rec) => cloneVal(rec)));
      },
      put(val: Record<string, unknown>) {
        return runAsync(() => {
          const pk = String(val[storeState.keyPath]);
          storeState.records.set(pk, cloneVal(val));
          return pk;
        });
      },
      delete(key: IDBValidKey) {
        return runAsync(() => {
          storeState.records.delete(String(key));
          return undefined;
        });
      },
      clear() {
        return runAsync(() => {
          storeState.records.clear();
          return undefined;
        });
      }
    } as unknown as IDBObjectStore;
  }

  const factory: IDBFactory = {
    open(name: string, requestedVersion = 1) {
      let dbState = databases.get(name);
      const oldVersion = dbState?.version ?? 0;
      if (!dbState) {
        dbState = { version: 0, stores: new Map() };
        databases.set(name, dbState);
      }

      const req = {
        result: null as unknown as IDBDatabase,
        transaction: null as unknown as IDBTransaction | null,
        error: null,
        onupgradeneeded: null as ((ev: IDBVersionChangeEvent) => void) | null,
        onsuccess: null as ((ev: Event) => void) | null,
        onerror: null as ((ev: Event) => void) | null
      };

      const dbApi = {
        objectStoreNames: {
          contains: (storeName: string) => dbState!.stores.has(storeName)
        },
        createObjectStore(storeName: string, opts?: { keyPath?: string }) {
          const storeState: FakeStoreState = {
            keyPath: opts?.keyPath || "id",
            records: new Map(),
            indexes: new Map()
          };
          dbState!.stores.set(storeName, storeState);
          return makeStoreApi(storeState);
        },
        deleteObjectStore(storeName: string) {
          dbState!.stores.delete(storeName);
        },
        close() {},
        onversionchange: null as ((ev: IDBVersionChangeEvent) => void) | null,
        onclose: null as ((ev: Event) => void) | null,
        transaction(storeNames: string | string[]) {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
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
            objectStore(storeName: string) {
              const storeState = dbState!.stores.get(storeName || names[0]);
              if (!storeState) {
                throw new Error(`Missing object store ${storeName}`);
              }
              return makeStoreApi(storeState, (runner) => {
                pending += 1;
                queueMicrotask(() => {
                  runner();
                  pending -= 1;
                  scheduleComplete();
                });
              });
            }
          };
          return tx as unknown as IDBTransaction;
        }
      } as unknown as IDBDatabase;

      req.result = dbApi;
      queueMicrotask(() => {
        if (requestedVersion > oldVersion) {
          dbState!.version = requestedVersion;
          req.transaction = {
            objectStore(storeName: string) {
              const storeState = dbState!.stores.get(storeName);
              if (!storeState) {
                throw new Error(`Missing object store ${storeName}`);
              }
              return makeStoreApi(storeState);
            }
          } as unknown as IDBTransaction;
          req.onupgradeneeded?.({ oldVersion, newVersion: requestedVersion } as IDBVersionChangeEvent);
          req.transaction = null;
        }
        req.onsuccess?.(new Event("success"));
      });
      return req as unknown as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;

  return { factory, databases };
}

let chromeHost: ChromeHost;

beforeEach(() => {
  vi.useRealTimers();
  resetModuleState();
  configureSubtitleCacheStoreForTests(null);
  clearL1IndexMemoryCache();
  chromeHost = installChromeHost();
});

afterEach(() => {
  setSubtitleCacheWriteInterceptorForTests(null);
  configureSubtitleCacheStoreForTests(null);
  clearL1IndexMemoryCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("IndexedDB v1 → v3 零损升级与新仓库结构", () => {
  it("从 v1 升级到 v3：保留历史 subtitle_pages 与 by_lastUsed，增量补 by_bvid 并建好 ai_artifacts、chat_images 与 conversations", async () => {
    expect(SUBTITLE_IDB_VERSION).toBe(3);
    const { factory, databases } = createVersionedFakeIdbFactory();
    const dbName = "biliscript-upgrade-test";

    databases.set(dbName, {
      version: 1,
      stores: new Map([
        [
          SUBTITLE_IDB_STORE,
          {
            keyPath: "id",
            indexes: new Map([[SUBTITLE_IDB_LAST_USED_INDEX, "lastUsed"]]),
            records: new Map([
              [
                "BV1hist:100",
                {
                  id: "BV1hist:100",
                  bvid: "BV1hist",
                  cid: "100",
                  rawTracks: {
                    "id_cc1": {
                      trackKey: "id_cc1",
                      items: [{ from: 0, to: 2, content: "历史字幕保留验证" }],
                      updatedAt: 1000
                    }
                  },
                  segmentedTracks: {},
                  translatedTracks: {},
                  estimatedBytes: 256,
                  createdAt: 1000,
                  updatedAt: 1000,
                  lastUsed: 1000
                }
              ]
            ])
          }
        ]
      ])
    });

    const store = createSubtitleIdbStore({ indexedDB: factory, dbName });

    const legacyTrack = await store.getRawTrack("BV1hist", "100", "id_cc1");
    expect(legacyTrack).toEqual([{ from: 0, to: 2, content: "历史字幕保留验证" }]);

    const dbState = databases.get(dbName)!;
    expect(dbState.version).toBe(3);

    const subStore = dbState.stores.get(SUBTITLE_IDB_STORE)!;
    expect(subStore.indexes.get(SUBTITLE_IDB_LAST_USED_INDEX)).toBe("lastUsed");
    expect(subStore.indexes.get(SUBTITLE_IDB_BVID_INDEX)).toBe("bvid");

    const aiStore = dbState.stores.get(AI_ARTIFACTS_IDB_STORE)!;
    expect(aiStore.keyPath).toBe("key");
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_FAMILY_BVID)).toEqual(["family", "bvid"]);
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_FAMILY_LAST_USED)).toEqual(["family", "lastUsedAt"]);
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_BVID)).toBe("bvid");
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_LAST_USED)).toBe("lastUsedAt");

    const chatImgStore = dbState.stores.get(CHAT_IMAGES_IDB_STORE)!;
    expect(chatImgStore.keyPath).toBe("id");
    expect(chatImgStore.records.size).toBe(0);
    expect(chatImgStore.indexes.get(CHAT_IMAGES_INDEX_CONVERSATION_ID)).toBe("conversationId");
    expect(chatImgStore.indexes.get(CHAT_IMAGES_INDEX_BVID)).toBe("bvid");
    expect(chatImgStore.indexes.get(CHAT_IMAGES_INDEX_LAST_USED)).toBe("lastUsedAt");

    const convStore = dbState.stores.get("conversations")!;
    expect(convStore.keyPath).toBe("id");
    expect(convStore.records.size).toBe(0);
    expect(convStore.indexes.get("by_updatedAt")).toBe("updatedAt");
  });

  it("ai_artifacts 按族视频数上限（默认 100 / 100 / 20 / 20）执行 LRU 淘汰且读命中刷新 lastUsedAt", async () => {
    expect(AI_ARTIFACT_FAMILY_KEEP_VIDEOS).toEqual({
      biliscript_lvs_l1_index_: 100,
      biliscript_lvs_analysis_final_: 100,
      biliscript_lvs_analysis_: 20,
      biliscript_lvs_summary_: 20
    });

    let clock = 1000;
    const { factory } = createVersionedFakeIdbFactory();
    const store = createSubtitleIdbStore({
      indexedDB: factory,
      dbName: "biliscript-ai-lru-test",
      aiArtifactKeepVideos: {
        biliscript_lvs_summary_: 2,
        biliscript_lvs_l1_index_: 3
      },
      now: () => {
        clock += 100;
        return clock;
      }
    });

    await store.putAiArtifact({ key: "biliscript_lvs_summary_BV1a_1_id_s_1", payload: "a1" });
    await store.putAiArtifact({ key: "biliscript_lvs_summary_BV1a_1_id_s_2", payload: "a2" });
    await store.putAiArtifact({ key: "biliscript_lvs_summary_BV1b_1_id_s_1", payload: "b1" });
    await store.putAiArtifact({ key: "biliscript_lvs_l1_index_BV1b_1_id_s_sig", payload: { ok: true } });

    await store.getAiArtifact("biliscript_lvs_summary_BV1a_1_id_s_1");

    const writeC = await store.putAiArtifact({ key: "biliscript_lvs_summary_BV1c_1_id_s_1", payload: "c1" });
    expect(writeC.ok).toBe(true);
    expect(writeC.evictedKeys).toEqual(["biliscript_lvs_summary_BV1b_1_id_s_1"]);

    await expect(store.getAiArtifact("biliscript_lvs_summary_BV1a_1_id_s_1")).resolves.not.toBeNull();
    await expect(store.getAiArtifact("biliscript_lvs_summary_BV1a_1_id_s_2")).resolves.not.toBeNull();
    await expect(store.getAiArtifact("biliscript_lvs_summary_BV1b_1_id_s_1")).resolves.toBeNull();
    await expect(store.getAiArtifact("biliscript_lvs_l1_index_BV1b_1_id_s_sig")).resolves.not.toBeNull();
  });
});

describe("Origin 隔离与内容脚本 SW RPC（禁止网页源直连 indexedDB）", () => {
  it("内容脚本在 https://www.bilibili.com 下经 subtitle-cache SW RPC 读写 AI 产物与清视频，绝不调用网页源 indexedDB", async () => {
    const pageIndexedDbOpen = vi.fn(() => {
      throw new Error("forbidden: content script must not call page-origin indexedDB");
    });
    vi.stubGlobal("indexedDB", { open: pageIndexedDbOpen });

    const remoteStore = createSubtitleIdbStore({ indexedDB: null });
    const handler = createSubtitleCacheHandler(remoteStore);
    const rpcOps: string[] = [];
    const sendMessage = vi.fn((message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
      const msg = message as SubtitleCacheMessage;
      if (msg?.type === "subtitle-cache") {
        rpcOps.push(msg.op);
        handler(msg, {}, (response) => callback?.(response));
        return;
      }
      callback?.({ ok: false });
    });
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    const clip = {
      bvid: "BV1rpc001",
      cid: "42",
      selectedSubtitleId: "sub-1",
      selectedSubtitleLang: "zh-CN",
      subtitleBody: [{ from: 0, to: 10, content: "RPC 隔离测试" }]
    };
    const finalKey = buildAnalysisFinalCacheKey(clip, "sig_rpc");
    const l1Key = buildL1IndexCacheKey({
      bvid: "BV1rpc001",
      cid: "42",
      subtitleId: "sub-1",
      subtitleLang: "zh-CN",
      subtitleSignature: "sig_rpc"
    });
    const analysis = { summary: "RPC 摘要", chapters: [], quotes: [] };
    const l1 = buildL1VideoIndex({
      bvid: "BV1rpc001",
      cid: "42",
      subtitleId: "sub-1",
      subtitleLang: "zh-CN",
      subtitleSignature: "sig_rpc",
      globalSummary: "RPC L1 摘要"
    });

    expect((await saveAnalysisFinal(finalKey, analysis)).ok).toBe(true);
    expect((await saveL1Index(l1Key, l1)).ok).toBe(true);
    clearL1IndexMemoryCache();

    expect(await loadAnalysisFinal(finalKey)).toEqual(analysis);
    expect(await loadL1Index(l1Key)).toEqual(l1);
    expect(await remoteStore.getAiArtifact(finalKey)).toMatchObject({ payload: analysis });
    expect(await remoteStore.getAiArtifact(l1Key)).toMatchObject({ payload: l1 });

    const cleared = await clearVideoCache("BV1rpc001");
    expect(cleared.removedArtifactKeys.sort()).toEqual([finalKey, l1Key].sort());
    expect(await remoteStore.listAiArtifactsByBvid("BV1rpc001")).toEqual([]);

    expect(rpcOps).toContain("put-ai-artifact");
    expect(rpcOps).toContain("get-ai-artifact");
    expect(rpcOps).toContain("clear-video");
    expect(pageIndexedDbOpen).not.toHaveBeenCalled();
  });
});

describe("先写后删懒迁移与启动/更新分批幂等迁移", () => {
  it("读路径懒迁移：IDB 写失败时保留旧键及分键 LRU 索引并优雅返回旧数据；写成功后才删旧键", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    const clipInput = {
      bvid: "BV1lazy01",
      cid: "7",
      selectedSubtitleId: "sub-1",
      selectedSubtitleLang: "zh-CN",
      subtitleBody: [{ from: 0, to: 10, content: "懒迁移内容" }]
    };
    const finalKey = buildAnalysisFinalCacheKey(clipInput, "sig_lazy");
    const finalIdxKey = buildLruIndexEntryKey(ANALYSIS_FINAL_PREFIX, "BV1lazy01", finalKey);
    const analysis = { summary: "旧存储概览", chapters: [], quotes: [] };

    const summaryKey = getSegmentSummaryKey({ bvid: "BV1lazy01", cid: "7", subtitleId: "sub-1", segmentIndex: 1 });
    const summaryIdxKey = buildLruIndexEntryKey("biliscript_lvs_summary_", "BV1lazy01", summaryKey);

    await chromeHost.local.set({
      [finalKey]: { analysis, timestamp: 12345 },
      [finalIdxKey]: { ts: 12345 },
      [summaryKey]: { summary: "旧分段小结", timestamp: 12345 },
      [summaryIdxKey]: { ts: 12345 }
    });

    store.setWriteInterceptorForTests(() => {
      throw new Error("IDB quota failure");
    });
    expect(await loadAnalysisFinal(finalKey)).toEqual(analysis);
    expect(await loadSegmentSummary(summaryKey)).toBe("旧分段小结");
    expect(await loadStoredSegmentSummaries({ bvid: "BV1lazy01", cid: "7", subtitleId: "sub-1" })).toEqual(["旧分段小结"]);
    expect(chromeHost.hasEntry(finalKey)).toBe(true);
    expect(chromeHost.hasEntry(finalIdxKey)).toBe(true);
    expect(chromeHost.hasEntry(summaryKey)).toBe(true);
    expect(chromeHost.hasEntry(summaryIdxKey)).toBe(true);

    store.setWriteInterceptorForTests(null);
    expect(await loadAnalysisFinal(finalKey)).toEqual(analysis);
    expect(await loadSegmentSummary(summaryKey)).toBe("旧分段小结");

    expect(chromeHost.hasEntry(finalKey)).toBe(false);
    expect(chromeHost.hasEntry(finalIdxKey)).toBe(false);
    expect(chromeHost.hasEntry(summaryKey)).toBe(false);
    expect(chromeHost.hasEntry(summaryIdxKey)).toBe(false);
    expect(await store.getAiArtifact(finalKey)).toMatchObject({ payload: analysis });
    expect(await store.getAiArtifact(summaryKey)).toMatchObject({ payload: "旧分段小结" });

    chromeHost.local.get.mockClear();
    expect(await loadAnalysisFinal(finalKey)).toEqual(analysis);
    expect(await readCachedClipOverviewArtifacts(clipInput)).toBeDefined();
    expect(chromeHost.local.get).not.toHaveBeenCalledWith(finalKey);
  });

  it("启动/更新分批迁移：中途失败不落完成标记且保留失败旧键，下次安全续跑并幂等跳过", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });

    const l1Record = buildL1VideoIndex({
      bvid: "BV1mig1",
      cid: "11",
      subtitleId: "s1",
      subtitleSignature: "sig1",
      globalSummary: "迁移 L1"
    });
    const l1Key = buildL1IndexCacheKey({
      bvid: "BV1mig1",
      cid: "11",
      subtitleId: "s1",
      subtitleSignature: "sig1"
    });
    const finalKey = buildAnalysisFinalCacheKey(
      { bvid: "BV1mig1", cid: "11", selectedSubtitleId: "s1" },
      "sig1"
    );
    const summaryKey = getSegmentSummaryKey({ bvid: "BV1mig1", cid: "11", subtitleId: "s1", segmentIndex: 1 });
    const subKey = getSubtitleCacheKey({
      bvid: "BV1mig1",
      cid: "11",
      identity: trackIdentity("s1", "https://sub.test/s1.json", "zh-CN")
    });
    const rawObsoleteKey = "biliscript_lvs_raw_BV1mig1_11_id_s1_1";

    await chromeHost.local.set({
      [l1Key]: { index: l1Record, timestamp: 1000 },
      [buildLruIndexEntryKey(L1_INDEX_CACHE_PREFIX, "BV1mig1", l1Key)]: { ts: 1000 },
      [finalKey]: { analysis: { summary: "整份迁移", chapters: [], quotes: [] }, timestamp: 2000 },
      [buildLruIndexEntryKey(ANALYSIS_FINAL_PREFIX, "BV1mig1", finalKey)]: { ts: 2000 },
      [summaryKey]: { summary: "小结迁移", timestamp: 3000 },
      [buildLruIndexEntryKey("biliscript_lvs_summary_", "BV1mig1", summaryKey)]: { ts: 3000 },
      [subKey]: { body: [{ from: 0, to: 3, content: "遗留字幕迁移" }], timestamp: 4000 },
      [buildLruIndexEntryKey("biliscript_subtitle_cache_", "BV1mig1", subKey)]: { ts: 4000 },
      [rawObsoleteKey]: { segments: [], timestamp: 5000 },
      [buildLruIndexEntryKey("biliscript_lvs_raw_", "BV1mig1", rawObsoleteKey)]: { ts: 5000 },
      [LRU_MANIFEST_STORAGE_KEY]: {
        biliscript_lvs_l1_index_: { BV1mig1: 1000 },
        biliscript_lvs_summary_: { BV1mig1: 3000 }
      },
      savedConversations: [{ id: "conv-keep" }]
    });

    store.setWriteInterceptorForTests((ctx) => {
      if (ctx.key === summaryKey) {
        throw new Error("simulated crash on summaryKey");
      }
    });

    const first = await migrateLegacyLocalStorageToIdb({ store, batchSize: 2, now: () => 9999 });
    expect(first.skipped).toBe(false);
    expect(first.completed).toBe(false);
    expect(first.failedKeys).toEqual([summaryKey]);
    expect(chromeHost.hasEntry(summaryKey)).toBe(true);
    expect(chromeHost.hasEntry(STORAGE_TO_IDB_MIGRATION_DONE_KEY)).toBe(false);
    expect(chromeHost.hasEntry(l1Key)).toBe(false);
    expect(await store.getAiArtifact(l1Key)).toMatchObject({ payload: l1Record });

    store.setWriteInterceptorForTests(null);
    const second = await migrateLegacyLocalStorageToIdb({ store, batchSize: 2, now: () => 10000 });
    expect(second.skipped).toBe(false);
    expect(second.completed).toBe(true);
    expect(second.failedKeys).toEqual([]);

    expect(await store.getAiArtifact(l1Key)).toMatchObject({ payload: l1Record });
    expect(await store.getAiArtifact(finalKey)).toMatchObject({ payload: { summary: "整份迁移", chapters: [], quotes: [] } });
    expect(await store.getAiArtifact(summaryKey)).toMatchObject({ payload: "小结迁移" });
    expect(await store.getRawTrack("BV1mig1", "11", "id_s1")).toEqual([{ from: 0, to: 3, content: "遗留字幕迁移" }]);

    expect(chromeHost.hasEntry(summaryKey)).toBe(false);
    expect(chromeHost.hasEntry(subKey)).toBe(false);
    expect(chromeHost.hasEntry(rawObsoleteKey)).toBe(false);
    expect(chromeHost.hasEntry(LRU_MANIFEST_STORAGE_KEY)).toBe(false);
    expect(chromeHost.map.get("savedConversations")).toEqual([{ id: "conv-keep" }]);
    expect(chromeHost.map.get(STORAGE_TO_IDB_MIGRATION_DONE_KEY)).toEqual({ version: 2, completedAt: 10000 });

    chromeHost.local.getKeys.mockClear();
    const third = await migrateLegacyLocalStorageToIdb({ store, batchSize: 2 });
    expect(third.skipped).toBe(true);
    expect(third.completed).toBe(true);
    expect(chromeHost.local.getKeys).not.toHaveBeenCalled();
  });
});

describe("视频级联动清理（多 P 防误删与 clearVideoCache 全清）", () => {
  it("多 P 视频仅淘汰其中 1P 时不误删该 bvid 的 ai_artifacts；最后一个分 P 淘汰时联动删除", async () => {
    let clock = 1000;
    const { factory } = createVersionedFakeIdbFactory();
    const store = createSubtitleIdbStore({
      indexedDB: factory,
      dbName: "biliscript-cascade-test",
      maxEntries: 3,
      now: () => {
        clock += 100;
        return clock;
      }
    });

    await store.putRawTrack({ bvid: "BV1multi", cid: "p1", trackKey: "id_1", items: [{ from: 0, to: 1, content: "m1" }] });
    await store.putRawTrack({ bvid: "BV1solo", cid: "s1", trackKey: "id_1", items: [{ from: 0, to: 1, content: "s1" }] });
    await store.putRawTrack({ bvid: "BV1multi", cid: "p2", trackKey: "id_1", items: [{ from: 0, to: 1, content: "m2" }] });

    await store.putAiArtifact({ key: "biliscript_lvs_l1_index_BV1multi_p1_id_1_sig", payload: { ok: 1 } });
    await store.putAiArtifact({ key: "biliscript_lvs_l1_index_BV1multi_p2_id_1_sig", payload: { ok: 2 } });
    await store.putAiArtifact({ key: "biliscript_lvs_analysis_final_BV1solo_s1_id_1_sig", payload: { ok: 3 } });

    const evict1 = await store.putRawTrack({
      bvid: "BV1newA",
      cid: "a1",
      trackKey: "id_1",
      items: [{ from: 0, to: 1, content: "a1" }]
    });
    expect(evict1.evictedIds).toEqual([buildSubtitlePageId("BV1multi", "p1")]);
    expect(evict1.evictedArtifactKeys).toBeUndefined();
    expect(await store.listAiArtifactsByBvid("BV1multi")).toHaveLength(2);

    const evict2 = await store.putRawTrack({
      bvid: "BV1newB",
      cid: "b1",
      trackKey: "id_1",
      items: [{ from: 0, to: 1, content: "b1" }]
    });
    expect(evict2.evictedIds).toEqual([buildSubtitlePageId("BV1solo", "s1")]);
    expect(evict2.evictedArtifactKeys).toEqual(["biliscript_lvs_analysis_final_BV1solo_s1_id_1_sig"]);
    expect(await store.listAiArtifactsByBvid("BV1solo")).toEqual([]);

    const evict3 = await store.putRawTrack({
      bvid: "BV1newC",
      cid: "c1",
      trackKey: "id_1",
      items: [{ from: 0, to: 1, content: "c1" }]
    });
    expect(evict3.evictedIds).toEqual([buildSubtitlePageId("BV1multi", "p2")]);
    expect(evict3.evictedArtifactKeys?.sort()).toEqual([
      "biliscript_lvs_l1_index_BV1multi_p1_id_1_sig",
      "biliscript_lvs_l1_index_BV1multi_p2_id_1_sig"
    ]);
    expect(await store.listAiArtifactsByBvid("BV1multi")).toEqual([]);
  });

  it("clearVideoCache(bvid, cid?) 统一清理防抖缓冲、L1 内存 LRU、IDB 条目及遗留 storage.local 键", async () => {
    vi.useFakeTimers();
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    await saveRawSubtitleTrack({ bvid: "BV1clr", cid: "p1", trackKey: "id_1", items: [{ from: 0, to: 2, content: "p1" }] });
    await saveRawSubtitleTrack({ bvid: "BV1clr", cid: "p2", trackKey: "id_1", items: [{ from: 0, to: 2, content: "p2" }] });
    await saveRawSubtitleTrack({ bvid: "BV1other", cid: "o1", trackKey: "id_1", items: [{ from: 0, to: 2, content: "o1" }] });

    scheduleTranslatedTrackWrite({
      bvid: "BV1clr",
      cid: "p1",
      sourceTrackKey: "id_1",
      targetLang: "zh-CN",
      translationSig: "sig1",
      items: [{ from: 0, to: 2, content: "待落盘译文 p1" }]
    });

    const l1P1 = buildL1VideoIndex({ bvid: "BV1clr", cid: "p1", subtitleId: "1", subtitleSignature: "sig1", globalSummary: "p1" });
    const l1P2 = buildL1VideoIndex({ bvid: "BV1clr", cid: "p2", subtitleId: "1", subtitleSignature: "sig2", globalSummary: "p2" });
    const l1Other = buildL1VideoIndex({ bvid: "BV1other", cid: "o1", subtitleId: "1", subtitleSignature: "sig3", globalSummary: "other" });
    const l1KeyP1 = buildL1IndexCacheKey({ bvid: "BV1clr", cid: "p1", subtitleId: "1", subtitleSignature: "sig1" });
    const l1KeyP2 = buildL1IndexCacheKey({ bvid: "BV1clr", cid: "p2", subtitleId: "1", subtitleSignature: "sig2" });
    const l1KeyOther = buildL1IndexCacheKey({ bvid: "BV1other", cid: "o1", subtitleId: "1", subtitleSignature: "sig3" });

    await saveL1Index(l1KeyP1, l1P1);
    await saveL1Index(l1KeyP2, l1P2);
    await saveL1Index(l1KeyOther, l1Other);

    const legacyP1 = "biliscript_lvs_summary_BV1clr_p1_id_1_1";
    const legacyP1Idx = buildLruIndexEntryKey("biliscript_lvs_summary_", "BV1clr", legacyP1);
    const legacyP2 = "biliscript_lvs_summary_BV1clr_p2_id_1_1";
    const legacyOther = "biliscript_lvs_summary_BV1other_o1_id_1_1";
    await chromeHost.local.set({
      [legacyP1]: { summary: "old p1", timestamp: 1 },
      [legacyP1Idx]: { ts: 1 },
      [legacyP2]: { summary: "old p2", timestamp: 1 },
      [legacyOther]: { summary: "old other", timestamp: 1 }
    });

    const resP1 = await clearVideoCache("BV1clr", "p1");
    expect(resP1.removedPageIds).toEqual(["BV1clr:p1"]);
    expect(resP1.removedArtifactKeys).toEqual([l1KeyP1]);
    expect(resP1.removedLegacyKeys.sort()).toEqual([legacyP1Idx, legacyP1].sort());

    await vi.advanceTimersByTimeAsync(2000);
    expect(await store.getPageRecord("BV1clr", "p1")).toBeNull();
    expect(await loadL1Index(l1KeyP1)).toBeNull();
    expect(await loadRawSubtitleTrack({ bvid: "BV1clr", cid: "p2", trackKey: "id_1" })).not.toBeNull();
    expect(await loadL1Index(l1KeyP2)).toEqual(l1P2);
    expect(chromeHost.hasEntry(legacyP2)).toBe(true);

    const resAll = await clearVideoCache("BV1clr");
    expect(resAll.removedPageIds).toEqual(["BV1clr:p2"]);
    expect(resAll.removedArtifactKeys).toEqual([l1KeyP2]);
    expect(resAll.removedLegacyKeys).toEqual([legacyP2]);

    expect(await store.getPageRecord("BV1clr", "p2")).toBeNull();
    expect(await loadL1Index(l1KeyP2)).toBeNull();
    expect(await loadRawSubtitleTrack({ bvid: "BV1other", cid: "o1", trackKey: "id_1" })).not.toBeNull();
    expect(await loadL1Index(l1KeyOther)).toEqual(l1Other);
    expect(chromeHost.hasEntry(legacyOther)).toBe(true);
  });
});
