// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { installChromeHost, type ChromeHost } from "../helpers/chrome-host.js";
import { createFakeIdbEnvironment } from "../helpers/fake-idb.js";
import {
  AI_ARTIFACTS_IDB_STORE,
  AI_ARTIFACTS_INDEX_BVID,
  AI_ARTIFACTS_INDEX_FAMILY_BVID,
  AI_ARTIFACTS_INDEX_LAST_USED,
  CHAT_IMAGES_IDB_STORE,
  CHAT_IMAGES_INDEX_BVID,
  CHAT_IMAGES_INDEX_CONVERSATION_ID,
  CONVERSATION_MESSAGES_IDB_STORE,
  CONVERSATION_META_IDB_STORE,
  CONVERSATION_META_INDEX_CONTEXT_KEY,
  CONVERSATION_META_INDEX_UPDATED_AT,
  NOTE_HIGHLIGHTS_IDB_STORE,
  NOTE_HIGHLIGHTS_INDEX_UPDATED_AT,
  STORE_META_IDB_STORE,
  SUBTITLE_IDB_BVID_INDEX,
  SUBTITLE_IDB_LAST_USED_INDEX,
  SUBTITLE_IDB_STORE,
  SUBTITLE_IDB_VERSION,
  SUBTITLE_TRACKS_IDB_STORE,
  SUBTITLE_TRACKS_INDEX_PAGE_ID,
  VIDEO_CACHE_LEDGER_META_KEY,
  buildSubtitlePageId,
  buildSubtitleTrackId,
  buildTranslatedTrackMapKey,
  createSubtitleIdbStore,
  readAiArtifactInBackground,
  type VideoCacheLedgerRecord
} from "../../extension/subtitle/idb-store.js";
import {
  clearStaleAsrSubtitleCache,
  clearTranslatedSubtitleCache,
  clearVideoCache,
  configureSubtitleCacheStoreForTests
} from "../../extension/subtitle/cache.js";
import {
  STORAGE_TO_IDB_MIGRATION_DONE_KEY,
  migrateLegacyLocalStorageToIdb
} from "../../extension/subtitle/storage-migration.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import { resolveActiveSubtitleStore } from "../../extension/subtitle/store-client.js";
import { createSegmentCacheHandler } from "../../extension/ai/segment-cache-handler.js";
import { videoCacheMaxMbToBytes } from "../../extension/core/validators.js";
import {
  isLiveTextToolHistoryEntry,
  normalizeLiveTextToolHistoryEntry
} from "../../extension/live/live-text-tool-history.js";
import {
  NOTE_HIGHLIGHTS_MIGRATED_META_KEY,
  NOTE_HIGHLIGHTS_STORAGE_KEY,
  addVideoHighlight,
  loadVideoHighlights,
  resetHighlightMemoryStoreForTests
} from "../../extension/notes/highlights-store.js";
import { encodeVideoStorageBvid } from "../../extension/shared/site.js";
import type {
  SegmentCacheMessage,
  SegmentCacheResponse,
  SubtitleCacheMessage,
  SubtitleCacheResponse
} from "../../extension/shared/messaging-protocol.js";

const IMG_BASE64 = "QUJDREVGR0hJSktMTU5PUA==";

let chromeHost: ChromeHost;

beforeEach(() => {
  vi.useRealTimers();
  resetModuleState();
  resetHighlightMemoryStoreForTests();
  configureSubtitleCacheStoreForTests(null);
  chromeHost = installChromeHost();
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  resetHighlightMemoryStoreForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("IndexedDB v3 -> v4 全域原子升级与数据无损迁移", () => {
  it("无损拆写 chat 与 live-text-tool 会话、拆出 subtitle_tracks、Base64 附图转原生 Blob 并精确初始化 ledger", async () => {
    expect(SUBTITLE_IDB_VERSION).toBe(4);
    const { factory, databases } = createFakeIdbEnvironment();
    const dbName = "biliscript-v3-to-v4-test";

    const v3Page = {
      id: "BV1upg001:101",
      bvid: "BV1upg001",
      cid: "101",
      rawTracks: {
        id_en: {
          trackKey: "id_en",
          lang: "en-US",
          kind: "manual-cc",
          items: [{ from: 0, to: 3, content: "Hello upgrade" }],
          updatedAt: 1000
        }
      },
      segmentedTracks: {
        "id_en:seg1": {
          key: "id_en:seg1",
          trackKey: "id_en",
          segmentationSig: "seg1",
          items: [{ from: 0, to: 3, content: "Hello upgrade." }],
          updatedAt: 1100
        }
      },
      translatedTracks: {
        "id_en->zh-CN:tr1": {
          key: "id_en->zh-CN:tr1",
          sourceTrackKey: "id_en",
          targetLang: "zh-CN",
          translationSig: "tr1",
          mode: "cc-json",
          items: [{ from: 0, to: 3, content: "你好升级" }],
          updatedAt: 1200
        }
      },
      estimatedBytes: 512,
      createdAt: 1000,
      updatedAt: 1200,
      lastUsed: 1200
    };

    const v3Artifact = {
      key: "biliscript_lvs_summary_BV1upg001_101_id_en_0",
      family: "biliscript_lvs_summary_",
      bvid: "BV1upg001",
      cid: "101",
      payload: "存量 AI 分段小结",
      estimatedBytes: 320,
      createdAt: 1300,
      updatedAt: 1300,
      lastUsedAt: 1300
    };

    const v3ChatConv = {
      id: "conv_chat_1",
      title: "普通对话",
      contextKey: "video:BV1upg001|101",
      contextTitle: "升级测试视频",
      contextUrl: "https://www.bilibili.com/video/BV1upg001/",
      isVideoContext: true,
      createdAt: 2000,
      updatedAt: 2500,
      transcriptMode: "full",
      summaryAnchor: { summaryText: "前情摘要", upToIndex: 2 },
      contextRef: { bvid: "BV1upg001", cid: "101", title: "升级测试视频", url: "https://www.bilibili.com/video/BV1upg001/" },
      messages: [
        { role: "user", content: "看这张图", images: [{ mime: "image/png", idbRef: "img_1" }] },
        {
          role: "assistant",
          content: "分析完成",
          tool_calls: [{ id: "tc_1", type: "function", function: { name: "search_subtitle", arguments: "{}" } }],
          thinkingBlocks: [{ type: "thinking", thinking: "深度推理", signature: "sig_abc" }],
          thoughtSignature: "gem_sig_123"
        }
      ]
    };

    const v3LiveConv = {
      id: "live:BV1upg001:101",
      kind: "live-text-tool",
      title: "伴看记录",
      contextKey: "video:BV1upg001|101",
      contextTitle: "升级测试视频",
      contextUrl: "https://www.bilibili.com/video/BV1upg001/",
      isVideoContext: true,
      createdAt: 3000,
      updatedAt: 3500,
      contextRef: {
        bvid: "BV1upg001",
        cid: "101",
        pageIndex: 1,
        title: "升级测试视频",
        url: "https://www.bilibili.com/video/BV1upg001/"
      },
      messages: [],
      records: [
        {
          callId: "call_live_1",
          source: "gemini",
          status: "completed",
          objective: "总结这一段",
          summary: "要点概括",
          markdown: "## 要点\n- 内容 A",
          startedAt: 3000,
          endedAt: 3500,
          durationMs: 500
        }
      ]
    };

    const v3ChatImage = {
      id: "img_1",
      conversationId: "conv_chat_1",
      bvid: "BV1upg001",
      mime: "image/png",
      data: IMG_BASE64,
      estimatedBytes: 128,
      createdAt: 2000,
      updatedAt: 2000,
      lastUsedAt: 2000
    };

    databases.set(dbName, {
      version: 3,
      stores: new Map([
        [
          SUBTITLE_IDB_STORE,
          {
            keyPath: "id",
            indexes: new Map([
              [SUBTITLE_IDB_LAST_USED_INDEX, "lastUsed"],
              [SUBTITLE_IDB_BVID_INDEX, "bvid"]
            ]),
            records: new Map([[v3Page.id, v3Page]])
          }
        ],
        [
          AI_ARTIFACTS_IDB_STORE,
          {
            keyPath: "key",
            indexes: new Map<string, string | string[]>([
              [AI_ARTIFACTS_INDEX_FAMILY_BVID, ["family", "bvid"]],
              ["by_family_lastUsedAt", ["family", "lastUsedAt"]],
              [AI_ARTIFACTS_INDEX_BVID, "bvid"],
              [AI_ARTIFACTS_INDEX_LAST_USED, "lastUsedAt"]
            ]),
            records: new Map([[v3Artifact.key, v3Artifact]])
          }
        ],
        [
          CHAT_IMAGES_IDB_STORE,
          {
            keyPath: "id",
            indexes: new Map([
              [CHAT_IMAGES_INDEX_CONVERSATION_ID, "conversationId"],
              [CHAT_IMAGES_INDEX_BVID, "bvid"],
              ["by_lastUsedAt", "lastUsedAt"]
            ]),
            records: new Map([[v3ChatImage.id, v3ChatImage]])
          }
        ],
        [
          "conversations",
          {
            keyPath: "id",
            indexes: new Map([["by_updatedAt", "updatedAt"]]),
            records: new Map<string, Record<string, unknown>>([
              [v3ChatConv.id, v3ChatConv],
              [v3LiveConv.id, v3LiveConv]
            ])
          }
        ]
      ])
    });

    const store = createSubtitleIdbStore({ indexedDB: factory, dbName });
    const usage = await store.getVideoCacheUsage();
    const dbState = databases.get(dbName)!;

    expect(dbState.version).toBe(4);
    expect(dbState.stores.has("conversations")).toBe(false);
    expect(dbState.stores.has(CONVERSATION_META_IDB_STORE)).toBe(true);
    expect(dbState.stores.has(CONVERSATION_MESSAGES_IDB_STORE)).toBe(true);
    expect(dbState.stores.has(SUBTITLE_TRACKS_IDB_STORE)).toBe(true);
    expect(dbState.stores.has(NOTE_HIGHLIGHTS_IDB_STORE)).toBe(true);
    expect(dbState.stores.has(STORE_META_IDB_STORE)).toBe(true);

    const aiStore = dbState.stores.get(AI_ARTIFACTS_IDB_STORE)!;
    expect(aiStore.indexes.has("by_family_lastUsedAt")).toBe(false);
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_FAMILY_BVID)).toEqual(["family", "bvid"]);
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_BVID)).toBe("bvid");
    expect(aiStore.indexes.get(AI_ARTIFACTS_INDEX_LAST_USED)).toBe("lastUsedAt");

    const convMetaStore = dbState.stores.get(CONVERSATION_META_IDB_STORE)!;
    expect(convMetaStore.indexes.get(CONVERSATION_META_INDEX_UPDATED_AT)).toBe("updatedAt");
    expect(convMetaStore.indexes.get(CONVERSATION_META_INDEX_CONTEXT_KEY)).toBe("contextKey");

    const hlStore = dbState.stores.get(NOTE_HIGHLIGHTS_IDB_STORE)!;
    expect(hlStore.keyPath).toBe("videoKey");
    expect(hlStore.indexes.get(NOTE_HIGHLIGHTS_INDEX_UPDATED_AT)).toBe("updatedAt");

    const chatMeta = convMetaStore.records.get("conv_chat_1")!;
    expect(chatMeta).toMatchObject({
      id: "conv_chat_1",
      kind: "chat",
      transcriptMode: "full",
      messageCount: 2,
      recordCount: 0,
      hasImages: true
    });
    expect("messages" in chatMeta).toBe(false);

    const liveMeta = convMetaStore.records.get("live:BV1upg001:101")!;
    expect(liveMeta).toMatchObject({
      id: "live:BV1upg001:101",
      kind: "live-text-tool",
      messageCount: 0,
      recordCount: 1,
      hasImages: false
    });
    expect("records" in liveMeta).toBe(false);

    const restoredChat = await store.getConversation("conv_chat_1");
    expect(restoredChat).toMatchObject({
      id: "conv_chat_1",
      transcriptMode: "full",
      summaryAnchor: { summaryText: "前情摘要", upToIndex: 2 }
    });
    const restoredMsgs = restoredChat?.messages as Array<Record<string, unknown>>;
    expect(restoredMsgs[1].tool_calls).toEqual(v3ChatConv.messages[1].tool_calls);
    expect(restoredMsgs[1].thinkingBlocks).toEqual(v3ChatConv.messages[1].thinkingBlocks);
    expect(restoredMsgs[1].thoughtSignature).toBe("gem_sig_123");

    const restoredLive = await store.getConversation("live:BV1upg001:101");
    expect(isLiveTextToolHistoryEntry(restoredLive)).toBe(true);
    const normalizedLive = normalizeLiveTextToolHistoryEntry(restoredLive);
    expect(normalizedLive?.records).toHaveLength(1);
    expect(normalizedLive?.records[0].callId).toBe("call_live_1");

    const rawPageHeader = dbState.stores.get(SUBTITLE_IDB_STORE)!.records.get(v3Page.id)!;
    expect("rawTracks" in rawPageHeader).toBe(false);
    expect("segmentedTracks" in rawPageHeader).toBe(false);
    expect("translatedTracks" in rawPageHeader).toBe(false);
    const trackStore = dbState.stores.get(SUBTITLE_TRACKS_IDB_STORE)!;
    expect(trackStore.indexes.get(SUBTITLE_TRACKS_INDEX_PAGE_ID)).toBe("pageId");
    expect(trackStore.records.size).toBe(3);

    const assembledPage = await store.getPageRecord("BV1upg001", "101");
    expect(assembledPage?.rawTracks["id_en"]?.items).toEqual(v3Page.rawTracks.id_en.items);
    expect(assembledPage?.segmentedTracks["id_en:seg1"]?.items).toEqual(v3Page.segmentedTracks["id_en:seg1"].items);
    expect(assembledPage?.translatedTracks["id_en->zh-CN:tr1"]?.items).toEqual(
      v3Page.translatedTracks["id_en->zh-CN:tr1"].items
    );

    const imgStore = dbState.stores.get(CHAT_IMAGES_IDB_STORE)!;
    expect(imgStore.indexes.has("by_lastUsedAt")).toBe(false);
    const migratedImg = imgStore.records.get("img_1")!;
    expect(migratedImg.blob instanceof Blob).toBe(true);
    expect(migratedImg.byteLength).toBe(16);
    expect("data" in migratedImg).toBe(false);
    const loadedImg = await store.getChatImage("img_1");
    expect(loadedImg?.data).toBe(IMG_BASE64);
    expect(loadedImg?.blob instanceof Blob).toBe(true);

    const ledger = dbState.stores.get(STORE_META_IDB_STORE)!.records.get(
      VIDEO_CACHE_LEDGER_META_KEY
    ) as unknown as VideoCacheLedgerRecord;
    expect(ledger.subtitleBytes).toBe(Number(rawPageHeader.estimatedBytes));
    expect(ledger.artifactBytes).toBe(v3Artifact.estimatedBytes);
    expect(ledger.totalBytes).toBe(ledger.subtitleBytes + ledger.artifactBytes);
    expect(ledger.pageCount).toBe(1);
    expect(ledger.artifactCount).toBe(1);
    expect(usage.totalBytes).toBe(ledger.totalBytes);
  });
});

describe("增量字节账本、单轨写入、零 getAll() 与游标归并淘汰", () => {
  it("putPage / upsertTranslatedTrack / putAiArtifact / 游标 LRU 淘汰全程零 getAll()、单轨更新不读兄弟轨、淘汰后无孤儿轨", async () => {
    let clock = 1000;
    const { factory, databases, spies } = createFakeIdbEnvironment();
    const dbName = "biliscript-zero-getall";
    const store = createSubtitleIdbStore({
      indexedDB: factory,
      dbName,
      maxBytes: 10 * 1024 * 1024,
      now: () => (clock += 100)
    });

    await store.putRawTrack({
      bvid: "BV1perf",
      cid: "1",
      trackKey: "id_en",
      lang: "en-US",
      items: [{ from: 0, to: 5, content: "English line 1" }]
    });
    await store.putRawTrack({
      bvid: "BV1perf",
      cid: "1",
      trackKey: "id_ja",
      lang: "ja-JP",
      items: [{ from: 0, to: 5, content: "日本語の字幕" }]
    });

    spies.reset();
    const pageId = buildSubtitlePageId("BV1perf", "1");
    const trMapKey = buildTranslatedTrackMapKey("id_en", "zh-CN", "sig_stream");
    const expectedTrackId = buildSubtitleTrackId(pageId, "translated", trMapKey);

    await store.upsertTranslatedTrack({
      bvid: "BV1perf",
      cid: "1",
      sourceTrackKey: "id_en",
      targetLang: "zh-CN",
      translationSig: "sig_stream",
      items: [{ from: 0, to: 5, content: "流式译文 1" }]
    });
    await store.upsertTranslatedTrack({
      bvid: "BV1perf",
      cid: "1",
      sourceTrackKey: "id_en",
      targetLang: "zh-CN",
      translationSig: "sig_stream",
      items: [{ from: 5, to: 10, content: "流式译文 2" }]
    });

    expect(spies.getAllCalls).toEqual([]);
    const trackReads = spies.getCalls.filter((c) => c.storeName === SUBTITLE_TRACKS_IDB_STORE);
    expect(trackReads.length).toBeGreaterThan(0);
    expect(trackReads.every((c) => c.key === expectedTrackId)).toBe(true);
    expect(
      spies.indexCursorCalls.filter((c) => c.storeName === SUBTITLE_TRACKS_IDB_STORE)
    ).toEqual([]);

    const bigText = "X".repeat(3000);
    await store.putRawTrack({
      bvid: "BV1evictA",
      cid: "1",
      trackKey: "id_a",
      items: [{ from: 0, to: 5, content: bigText }]
    });
    await store.putAiArtifact({
      key: "biliscript_lvs_summary_BV1evictB_1_id_b_0",
      payload: "Y".repeat(3000)
    });
    const beforeLimit = await store.getVideoCacheUsage();

    const targetLimit = Math.floor(beforeLimit.totalBytes * 0.65);
    const narrowed = await store.setVideoCacheMaxBytes(targetLimit);

    expect(spies.getAllCalls).toEqual([]);
    expect(narrowed.usage.totalBytes).toBeLessThanOrEqual(Math.floor(targetLimit * 0.9));
    expect(narrowed.evictedPageIds.length + narrowed.evictedArtifactKeys.length).toBeGreaterThan(0);

    const dbState = databases.get(dbName)!;
    const remainingPageIds = new Set(dbState.stores.get(SUBTITLE_IDB_STORE)!.records.keys());
    for (const row of dbState.stores.get(SUBTITLE_TRACKS_IDB_STORE)!.records.values()) {
      expect(remainingPageIds.has(String(row.pageId))).toBe(true);
    }
  });
});

describe("附图零静默淘汰（>80 MB Blob）、RPC 桥接与划词高亮 150 视频无损持久化", () => {
  it("写入超 80 MB 多会话原生 Blob 附图零淘汰、读盘零写回、删会话时按 by_conversationId 级联清空", async () => {
    const { factory, databases, spies } = createFakeIdbEnvironment();
    const dbName = "biliscript-blob-images";
    const store = createSubtitleIdbStore({ indexedDB: factory, dbName });

    const blobSize = 30 * 1024 * 1024;
    const makeBigBlob = (byte: number) => {
      const buf = new Uint8Array(blobSize);
      buf[0] = byte;
      return new Blob([buf], { type: "image/png" });
    };

    for (const idx of [1, 2, 3]) {
      await store.putConversation({
        id: `conv_${idx}`,
        updatedAt: idx * 1000,
        messages: [{ role: "user", content: `msg ${idx}` }]
      });
      const res = await store.putChatImage({
        id: `img_${idx}`,
        conversationId: `conv_${idx}`,
        bvid: `BV1img00${idx}`,
        mime: "image/png",
        blob: makeBigBlob(idx)
      });
      expect(res.ok).toBe(true);
      expect(res.evictedIds).toEqual([]);
      expect(res.estimatedBytes).toBe(blobSize);
    }

    const imgRecords = databases.get(dbName)!.stores.get(CHAT_IMAGES_IDB_STORE)!.records;
    expect(imgRecords.size).toBe(3);
    for (const rec of imgRecords.values()) {
      expect(rec.blob instanceof Blob).toBe(true);
      expect(rec.byteLength).toBe(blobSize);
    }

    spies.reset();
    await store.putChatImage({
      id: "img_small",
      conversationId: "conv_1",
      bvid: "BV1img001",
      mime: "image/png",
      data: IMG_BASE64
    });
    spies.reset();
    const loadedSmall = await store.getChatImage("img_small");
    expect(loadedSmall?.data).toBe(IMG_BASE64);
    expect(spies.putCalls.filter((c) => c.storeName === CHAT_IMAGES_IDB_STORE)).toEqual([]);

    await store.deleteConversations(["conv_1"]);
    expect(imgRecords.has("img_1")).toBe(false);
    expect(imgRecords.has("img_small")).toBe(false);
    expect(imgRecords.has("img_2")).toBe(true);
    expect(imgRecords.has("img_3")).toBe(true);

    await store.pruneConversationsToLimit(1);
    expect(imgRecords.has("img_2")).toBe(false);
    expect(imgRecords.has("img_3")).toBe(true);
  });

  it("MV3 JSON IPC 边界完成 Blob <-> DataURL 往返且 IDB 静态落盘保持原生 Blob", async () => {
    const { factory, databases } = createFakeIdbEnvironment();
    const dbName = "biliscript-rpc-blob";
    const remoteStore = createSubtitleIdbStore({ indexedDB: factory, dbName });
    const handler = createSubtitleCacheHandler(remoteStore);

    const sendMessage = vi.fn(
      (message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
        const jsonMsg = JSON.parse(JSON.stringify(message)) as SubtitleCacheMessage;
        if (jsonMsg?.type === "subtitle-cache") {
          handler(jsonMsg, {}, (resp) => {
            callback?.(JSON.parse(JSON.stringify(resp)) as SubtitleCacheResponse);
          });
          return undefined;
        }
        callback?.({ ok: true });
        return undefined;
      }
    );
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    const rpcStore = resolveActiveSubtitleStore();
    const writeRes = await rpcStore.putChatImage({
      id: "rpc_img_1",
      conversationId: "conv_rpc",
      bvid: "BV1rpcImg",
      mime: "image/png",
      blob: new Blob([new Uint8Array([65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80])], {
        type: "image/png"
      })
    });
    expect(writeRes.ok).toBe(true);

    const rawStored = databases.get(dbName)!.stores.get(CHAT_IMAGES_IDB_STORE)!.records.get("rpc_img_1")!;
    expect(rawStored.blob instanceof Blob).toBe(true);

    const loaded = await rpcStore.getChatImage("rpc_img_1");
    expect(loaded?.data).toBe(IMG_BASE64);
    expect(loaded?.blob instanceof Blob).toBe(true);
  });

  it("写入 150 个视频划词高亮及迁移旧 biliscript_note_highlights_v1 100% 保留无截断", async () => {
    const { factory, databases } = createFakeIdbEnvironment();
    const dbName = "biliscript-note-highlights";
    const store = createSubtitleIdbStore({ indexedDB: factory, dbName });
    configureSubtitleCacheStoreForTests(store);

    await chromeHost.local.set({
      [NOTE_HIGHLIGHTS_STORAGE_KEY]: {
        BV1legacy001: {
          updatedAt: 5000,
          items: [{ id: "hl_leg_1", text: "历史划词句", from: 12, source: "subtitle", subtitleIndex: 1, createdAt: 5000 }]
        }
      }
    });

    const migrated = await loadVideoHighlights("BV1legacy001");
    expect(migrated).toHaveLength(1);
    expect(migrated[0].text).toBe("历史划词句");
    expect(chromeHost.hasEntry(NOTE_HIGHLIGHTS_STORAGE_KEY)).toBe(false);
    expect(await store.getStoreMeta(NOTE_HIGHLIGHTS_MIGRATED_META_KEY)).toMatchObject({ done: true });

    for (let i = 0; i < 150; i += 1) {
      const key =
        i % 2 === 0
          ? encodeVideoStorageBvid("youtube", `_${String(i).padStart(9, "0")}A`)
          : `BV1hl${String(i).padStart(7, "0")}`;
      const added = await addVideoHighlight(key, {
        text: `重点句-${i}`,
        from: i,
        source: "subtitle",
        subtitleIndex: 0
      });
      expect(added.added).toBe(true);
    }

    const hlRecords = databases.get(dbName)!.stores.get(NOTE_HIGHLIGHTS_IDB_STORE)!.records;
    expect(hlRecords.size).toBe(151);
    expect(await loadVideoHighlights("BV1legacy001")).toHaveLength(1);
    expect(await loadVideoHighlights(encodeVideoStorageBvid("youtube", "_000000000A"))).toHaveLength(1);
    expect(await loadVideoHighlights("BV1hl0000149")).toHaveLength(1);
  });
});

describe("SW 冷启动配额同步、Background 零拷贝 Float32Array 与 store_meta 迁移门控", () => {
  it("SW 冷启动经 segment-cache-handler 写入时同步 videoCacheMaxMb = 50 配额生效", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    const resolveQuota = vi.fn(async () => videoCacheMaxMbToBytes(50));
    const handler = createSegmentCacheHandler({ store, resolveVideoCacheMaxBytes: resolveQuota });

    const res = await new Promise<SegmentCacheResponse>((resolve) =>
      handler(
        {
          type: "segment-cache",
          op: "save-summary",
          context: { bvid: "BV1cold50", cid: "1", selectedSubtitleId: "s1", selectedSubtitleUrl: "", subtitleLang: "" },
          segmentIndex: 0,
          budgetScale: 1,
          summary: "冷启动配额验证"
        } as SegmentCacheMessage,
        {},
        resolve
      )
    );

    expect(res).toEqual({ ok: true });
    expect(resolveQuota).toHaveBeenCalledTimes(1);
    const usage = await store.getVideoCacheUsage();
    expect(usage.maxBytes).toBe(50 * 1024 * 1024);
  });

  it("readAiArtifactInBackground 原样读回 Float32Array 实例", async () => {
    const { factory } = createFakeIdbEnvironment();
    const store = createSubtitleIdbStore({ indexedDB: factory, dbName: "biliscript-f32" });
    const vec = new Float32Array([0.25, -0.5, 0.75, 1.5]);
    const key = "biliscript_lvs_l1_index_BV1f32_1_id_s1_vec";

    const write = await store.putAiArtifact({ key, payload: vec });
    expect(write.ok).toBe(true);

    const readBack = await readAiArtifactInBackground<Float32Array>(key, store);
    expect(readBack).toBeInstanceOf(Float32Array);
    expect(Array.from(readBack!)).toEqual([0.25, -0.5, 0.75, 1.5]);
  });

  it("旧版 subtitle_cache_* 经 store_meta 标记迁移完成后不再调用 chrome.storage.local.getKeys()", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);

    const migRes = await migrateLegacyLocalStorageToIdb({ store, now: () => 5000 });
    expect(migRes.completed).toBe(true);
    expect(await store.getStoreMeta(STORAGE_TO_IDB_MIGRATION_DONE_KEY)).toEqual({
      version: 2,
      completedAt: 5000
    });

    chromeHost.local.getKeys.mockClear();
    const secondMig = await migrateLegacyLocalStorageToIdb({ store });
    expect(secondMig.skipped).toBe(true);
    await clearStaleAsrSubtitleCache({ bvid: "BV1gate", cid: "1" });
    await clearTranslatedSubtitleCache({ bvid: "BV1gate", cid: "1" });
    await clearVideoCache("BV1gate", "1");
    expect(chromeHost.local.getKeys).not.toHaveBeenCalled();
  });
});
