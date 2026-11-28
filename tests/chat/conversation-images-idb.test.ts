// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createFakeIdbEnvironment } from "../helpers/fake-idb.js";
import { normalizeConversations } from "../../extension/ai/conversation.js";
import {
  CHAT_IMAGES_IDB_STORE,
  CHAT_IMAGES_INDEX_CONVERSATION_ID,
  SUBTITLE_IDB_VERSION,
  createSubtitleIdbStore,
  type PersistedConversationRecord,
  type SubtitleIdbStore
} from "../../extension/subtitle/idb-store.js";
import { configureSubtitleCacheStoreForTests } from "../../extension/subtitle/store-client.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import {
  HISTORY_STORAGE_KEY,
  clearConversationHistory,
  computeChatImageId,
  listConversationSummaries,
  readConversationById,
  saveConversationEntry,
  type StoredConversation
} from "../../extension/chat/conversation-storage.js";
import {
  createConversationStore,
  type CreateConversationStoreDeps,
  type StorageArea
} from "../../extension/chat/conversation-store.js";
import {
  chatSessionState,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../../extension/shared/messaging-protocol.js";

const IMG_A = { mime: "image/webp", data: "QUJDREVGR0hJSktMTU5PUA==" };
const IMG_B = { mime: "image/png", data: "WFl6MDEyMzQ1Njc4OUFCQ0Q=" };
const IMG_C = { mime: "image/jpeg", data: "LzlqLzRBQVNTS1pKcmdBQkFRQUFBQUFCQUFE" };

function makeMemoryStorage(): StorageArea & {
  data: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, structuredClone(v));
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) {
        data.delete(k);
      }
    })
  };
}

function makeConversation(
  id: string,
  options: {
    bvid?: string;
    updatedAt?: number;
    messages?: Array<{ role: "user" | "assistant"; content: string; images?: Array<Record<string, unknown>> }>;
  } = {}
): StoredConversation {
  const bvid = options.bvid ?? "BV1chatimg01";
  const updatedAt = options.updatedAt ?? 10_000;
  const url = `https://www.bilibili.com/video/${bvid}/`;
  return {
    id,
    title: `视频 ${id}`,
    contextKey: `video:${bvid}|101`,
    contextTitle: `视频 ${id}`,
    contextUrl: url,
    isVideoContext: true,
    createdAt: updatedAt - 100,
    updatedAt,
    contextRef: {
      title: `视频 ${id}`,
      url,
      author: "",
      uploadDate: "",
      bvid,
      cid: "101",
      aid: "",
      pageIndex: 1,
      pageCount: 0,
      pageTitle: "",
      subtitleLang: "",
      selectedSubtitleId: "",
      selectedSubtitleUrl: "",
      isVideoContext: true
    },
    messages: (options.messages ?? [
      { role: "user", content: `问题 ${id}` },
      { role: "assistant", content: `回答 ${id}` }
    ]) as StoredConversation["messages"]
  } as StoredConversation;
}

function createFakeIdbWithIndexSpy(dbName: string) {
  const { factory, databases, spies } = createFakeIdbEnvironment();
  return {
    factory,
    get stores() {
      return databases.get(dbName)!.stores;
    },
    get indexGetAllCalls() {
      return spies.indexCursorCalls;
    }
  };
}

function wireSubtitleCacheSwRpc(
  remoteStore: SubtitleIdbStore,
  options: { resolveChatHistoryMaxCount?: () => Promise<number> } = {}
) {
  const handler = createSubtitleCacheHandler(remoteStore, options);
  const rpcCalls: SubtitleCacheMessage[] = [];
  const sendMessage = vi.fn(
    (message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
      const msg = message as SubtitleCacheMessage;
      if (msg?.type === "subtitle-cache") {
        rpcCalls.push(msg);
        handler(msg, {}, (response) => {
          callback?.(response);
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );
  (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
  return { sendMessage, rpcCalls };
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  configureSubtitleCacheStoreForTests(null);
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  vi.restoreAllMocks();
});

describe("对话图片外置、单会话懒迁移与原子回收", () => {
  it("使用 SUBTITLE_IDB_VERSION v4 且保留 ai/conversation.ts 同步数据结构契约", () => {
    expect(SUBTITLE_IDB_VERSION).toBe(4);
    const conv = makeConversation("conv-sync", {
      messages: [
        { role: "user", content: "看图", images: [IMG_A] },
        { role: "assistant", content: "好的" }
      ]
    });
    const normalized = normalizeConversations([conv]);
    expect(normalized).toHaveLength(1);
    expect((normalized[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
  });

  it("正常写盘外置为 { mime, idbRef } 并经 SW 原子 RPC 落盘与单会话读盘水合还原", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy("test-chat-rpc");
    const remoteStore = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-chat-rpc" });
    const { rpcCalls } = wireSubtitleCacheSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => 0 });
    const storage = makeMemoryStorage();

    const conv = makeConversation("conv-1", {
      bvid: "BV1rpc001",
      updatedAt: 20_000,
      messages: [
        { role: "user", content: "请分析这两张图", images: [IMG_A, IMG_B] },
        { role: "assistant", content: "这是分析结果" }
      ]
    });

    const saved = await saveConversationEntry(conv, { storage });
    expect((saved.conversation as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A, IMG_B]);

    const rawPersisted = (await remoteStore.getConversation("conv-1")) as unknown as {
      id: string;
      messages: Array<{ images?: Array<Record<string, unknown>> }>;
    };
    const persistedImages = rawPersisted.messages[0].images!;
    expect(persistedImages).toHaveLength(2);
    expect(persistedImages[0]).toEqual({
      mime: IMG_A.mime,
      idbRef: computeChatImageId("conv-1", IMG_A.mime, IMG_A.data)
    });
    expect("data" in persistedImages[0]).toBe(false);
    expect(persistedImages[1]).toEqual({
      mime: IMG_B.mime,
      idbRef: computeChatImageId("conv-1", IMG_B.mime, IMG_B.data)
    });
    expect("data" in persistedImages[1]).toBe(false);

    const storedImages = await remoteStore.listAllChatImages();
    expect(storedImages).toHaveLength(2);
    expect(storedImages.map((r) => r.conversationId)).toEqual(["conv-1", "conv-1"]);
    expect(storedImages.every((r) => r.bvid === "BV1rpc001")).toBe(true);
    expect(rpcCalls.some((m) => m.op === "upsert-conversation-atomic")).toBe(true);

    const hydrated = await readConversationById("conv-1", storage);
    expect(rpcCalls.some((m) => m.op === "get-chat-images")).toBe(true);
    expect((hydrated as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A, IMG_B]);

    const summaries = await listConversationSummaries(storage);
    expect(summaries[0]).toMatchObject({
      id: "conv-1",
      kind: "chat",
      messageCount: 2,
      hasImages: true
    });
    expect("messages" in chatSessionState.savedConversations[0]).toBe(false);
  });

  it("单张 idbRef 缺失或记录损坏时仅降级受影响单图，整条对话文本与其他正常图片完整加载", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy("test-degrade");
    const store = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-degrade" });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const refOk = computeChatImageId("conv-degrade", IMG_A.mime, IMG_A.data);
    const refMissing = "img_conv-degrade_missing_ref";
    const refCorrupted = "img_conv-degrade_corrupted_ref";

    await store.putChatImage({
      id: refOk,
      conversationId: "conv-degrade",
      bvid: "BV1deg01",
      mime: IMG_A.mime,
      data: IMG_A.data
    });
    fakeIdb.stores.get(CHAT_IMAGES_IDB_STORE)!.records.set(refCorrupted, {
      id: refCorrupted,
      conversationId: "conv-degrade",
      bvid: "BV1deg01",
      mime: "image/png",
      data: "",
      estimatedBytes: 10,
      createdAt: 1000,
      updatedAt: 1000,
      lastUsedAt: 1000
    });

    await store.putConversation(
      makeConversation("conv-degrade", {
        messages: [
          {
            role: "user",
            content: "第一轮带好图与坏图",
            images: [
              { mime: IMG_A.mime, idbRef: refOk },
              { mime: "image/png", idbRef: refMissing },
              { mime: "image/png", idbRef: refCorrupted }
            ]
          },
          { role: "assistant", content: "正常回答文本" },
          {
            role: "user",
            content: "第二轮仅带缺失图",
            images: [{ mime: "image/jpeg", idbRef: refMissing }]
          }
        ]
      }) as unknown as PersistedConversationRecord
    );

    const loaded = await readConversationById("conv-degrade", storage);
    expect(loaded).not.toBeNull();
    const msgs = (loaded as { messages: Array<{ content: string; images?: unknown }> }).messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe("第一轮带好图与坏图");
    expect(msgs[0].images).toEqual([IMG_A]);
    expect(msgs[1].content).toBe("正常回答文本");
    expect(msgs[2].content).toBe("第二轮仅带缺失图");
    expect(msgs[2].images).toBeUndefined();
  });

  it("读盘 SW RPC 抛异常时整条对话文本仍可加载，跳过懒迁移且并发保存新会话不误擦原会话 idbRef", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy("test-rpc-err");
    const remoteStore = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-rpc-err" });
    const handler = createSubtitleCacheHandler(remoteStore, { resolveChatHistoryMaxCount: async () => 0 });
    let failGetChatImages = false;

    const sendMessage = vi.fn(
      (message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
        const msg = message as SubtitleCacheMessage;
        if (msg?.type === "subtitle-cache") {
          if (failGetChatImages && msg.op === "get-chat-images") {
            callback?.({ ok: false, handled: true, error: "simulated SW disconnect" });
            return undefined;
          }
          handler(msg, {}, (resp) => callback?.(resp));
          return undefined;
        }
        callback?.({ ok: true });
        return undefined;
      }
    );
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    const storage = makeMemoryStorage();
    const refA = computeChatImageId("conv-1", IMG_A.mime, IMG_A.data);
    await remoteStore.putChatImage({
      id: refA,
      conversationId: "conv-1",
      bvid: "BV1chatimg01",
      mime: IMG_A.mime,
      data: IMG_A.data
    });
    await remoteStore.putConversation(
      makeConversation("conv-1", {
        updatedAt: 10_000,
        messages: [
          { role: "user", content: "带外置与内联混合图", images: [{ mime: IMG_A.mime, idbRef: refA }, IMG_B] },
          { role: "assistant", content: "旧回复" }
        ]
      }) as unknown as PersistedConversationRecord
    );

    failGetChatImages = true;
    const degraded = await readConversationById("conv-1", storage);
    expect(degraded).not.toBeNull();
    expect((degraded as { messages: Array<{ content: string; images?: unknown }> }).messages[0]).toEqual({
      role: "user",
      content: "带外置与内联混合图",
      images: [IMG_B]
    });

    const conv2 = makeConversation("conv-2", { updatedAt: 20_000 });
    await saveConversationEntry(conv2, { storage });

    failGetChatImages = false;
    const recovered = await readConversationById("conv-1", storage);
    expect((recovered as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A, IMG_B]);
    expect(await remoteStore.getChatImage(refA)).not.toBeNull();
    expect(await remoteStore.getChatImage(computeChatImageId("conv-1", IMG_B.mime, IMG_B.data))).not.toBeNull();
  });

  it("原子写入失败时整体中止，不写入悬空 idbRef 也不残留无主 chat_images", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();
    const idB = computeChatImageId("conv-atomic-fail", IMG_B.mime, IMG_B.data);

    store.setWriteInterceptorForTests((ctx) => {
      if (ctx.op === "put-chat-image" && ctx.key === idB) {
        throw new Error("QuotaExceededError");
      }
    });

    const conv = makeConversation("conv-atomic-fail", {
      messages: [
        { role: "user", content: "两张图", images: [IMG_A, IMG_B] },
        { role: "assistant", content: "收到" }
      ]
    });

    await expect(saveConversationEntry(conv, { storage })).rejects.toThrow("QuotaExceededError");
    expect(await store.getConversation("conv-atomic-fail")).toBeNull();
    expect(await store.listAllChatImages()).toEqual([]);
  });

  it("IDB 内联 base64 读路径经原子 RPC 懒外置回填 chat_images（幂等且 maxCount=0 绝不裁剪其他会话）", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy("test-lazy-migrate");
    const remoteStore = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-lazy-migrate" });
    const { rpcCalls } = wireSubtitleCacheSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => 1 });
    const storage = makeMemoryStorage();

    await remoteStore.putConversation(
      makeConversation("conv-other", {
        bvid: "BV1oth01",
        updatedAt: 1000
      }) as unknown as PersistedConversationRecord
    );
    await remoteStore.putConversation(
      makeConversation("conv-legacy", {
        bvid: "BV1leg01",
        updatedAt: 5000,
        messages: [
          { role: "user", content: "历史旧图", images: [IMG_A] },
          { role: "assistant", content: "历史旧回复" }
        ]
      }) as unknown as PersistedConversationRecord
    );

    remoteStore.setWriteInterceptorForTests(() => {
      throw new Error("temporary idb write error");
    });
    const firstRead = await readConversationById("conv-legacy", storage);
    expect((firstRead as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
    expect(
      ((await remoteStore.getConversation("conv-legacy")) as unknown as { messages: Array<{ images?: unknown }> })
        .messages[0].images
    ).toEqual([IMG_A]);

    remoteStore.setWriteInterceptorForTests(null);
    rpcCalls.length = 0;
    const secondRead = await readConversationById("conv-legacy", storage);
    expect((secondRead as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);

    const atomicCalls = rpcCalls.filter((m) => m.op === "upsert-conversation-atomic");
    expect(atomicCalls).toHaveLength(1);
    expect(atomicCalls[0].maxCount).toBe(0);

    const expectedRef = computeChatImageId("conv-legacy", IMG_A.mime, IMG_A.data);
    expect(
      ((await remoteStore.getConversation("conv-legacy")) as unknown as { messages: Array<{ images?: unknown }> })
        .messages[0].images
    ).toEqual([{ mime: IMG_A.mime, idbRef: expectedRef }]);
    expect(await remoteStore.getChatImage(expectedRef)).toMatchObject({
      id: expectedRef,
      conversationId: "conv-legacy",
      bvid: "BV1leg01",
      mime: IMG_A.mime,
      data: IMG_A.data
    });
    expect(await remoteStore.getConversation("conv-other")).not.toBeNull();

    const upsertSpy = vi.spyOn(remoteStore, "upsertConversationAtomic");
    const thirdRead = await readConversationById("conv-legacy", storage);
    expect((thirdRead as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("旧版 storage.local 迁移遵循写后删幂等：IDB 写入失败时保留旧键，恢复后一次性迁移并清理", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const legacyConv = makeConversation("conv-local-legacy", {
      bvid: "BV1loc01",
      updatedAt: 5000,
      messages: [
        { role: "user", content: "本地旧图", images: [IMG_A] },
        { role: "assistant", content: "本地旧回复" }
      ]
    });
    await storage.set({ [HISTORY_STORAGE_KEY]: [legacyConv] });

    const origMigrate = store.migrateLegacyConversationsAtomic.bind(store);
    vi.spyOn(store, "migrateLegacyConversationsAtomic")
      .mockRejectedValueOnce(new Error("temporary migration failure"))
      .mockImplementation(origMigrate);

    await expect(readConversationById("conv-local-legacy", storage)).rejects.toThrow("temporary migration failure");
    expect(storage.data.has(HISTORY_STORAGE_KEY)).toBe(true);

    const migrated = await readConversationById("conv-local-legacy", storage);
    expect((migrated as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
    expect(storage.data.has(HISTORY_STORAGE_KEY)).toBe(false);
    expect(await store.getChatImage(computeChatImageId("conv-local-legacy", IMG_A.mime, IMG_A.data))).not.toBeNull();
  });

  it("删除单条会话（含 undo）、覆盖移除图片、清空全部与超上限裁剪后 chat_images 零孤儿残留", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy("test-orphan-reclaim");
    const store = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-orphan-reclaim" });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const conv1 = makeConversation("conv-1", {
      updatedAt: 1000,
      messages: [{ role: "user", content: "图1", images: [IMG_A] }]
    });
    const conv2 = makeConversation("conv-2", {
      updatedAt: 2000,
      messages: [{ role: "user", content: "图2", images: [IMG_B] }]
    });
    await saveConversationEntry(conv1, { storage, maxCount: 0 });
    await saveConversationEntry(conv2, { storage, maxCount: 0 });
    expect(await store.listAllChatImages()).toHaveLength(2);

    const deps: CreateConversationStoreDeps = {
      loadContextState: vi.fn(async () => true),
      resolveAiConversationRef: vi.fn(async () => ({})),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage,
      getMaxCount: () => 0
    };
    const convStore = createConversationStore(deps);
    await convStore.loadAll();

    fakeIdb.indexGetAllCalls.length = 0;
    const deletion = await convStore.deleteById("conv-1");
    expect(deletion).not.toBeNull();
    expect(
      fakeIdb.indexGetAllCalls.some(
        (call) =>
          call.storeName === CHAT_IMAGES_IDB_STORE &&
          call.indexName === CHAT_IMAGES_INDEX_CONVERSATION_ID &&
          call.query === "conv-1"
      )
    ).toBe(true);
    expect(await store.listChatImagesByConversationId("conv-1")).toEqual([]);
    expect(await store.listChatImagesByConversationId("conv-2")).toHaveLength(1);

    await deletion!.undo();
    expect(await store.listChatImagesByConversationId("conv-1")).toHaveLength(1);

    const conv2Updated = makeConversation("conv-2", {
      updatedAt: 3000,
      messages: [{ role: "user", content: "换成图3", images: [IMG_C] }]
    });
    await saveConversationEntry(conv2Updated, { storage, maxCount: 0 });
    const conv2Images = await store.listChatImagesByConversationId("conv-2");
    expect(conv2Images).toHaveLength(1);
    expect(conv2Images[0].data).toBe(IMG_C.data);
    expect(await store.getChatImage(computeChatImageId("conv-2", IMG_B.mime, IMG_B.data))).toBeNull();

    const conv2TextOnly = makeConversation("conv-2", {
      updatedAt: 4000,
      messages: [{ role: "user", content: "只留文字" }]
    });
    await saveConversationEntry(conv2TextOnly, { storage, maxCount: 0 });
    expect(await store.listChatImagesByConversationId("conv-2")).toEqual([]);

    await clearConversationHistory({ storage });
    expect(await store.listAllChatImages()).toEqual([]);

    const oldestConv = makeConversation("conv-oldest", {
      updatedAt: 1000,
      messages: [{ role: "user", content: "最旧带图会话", images: [IMG_A] }]
    });
    const maxTestLimit = 5;
    await saveConversationEntry(oldestConv, { storage, maxCount: 0 });
    await Promise.all(
      Array.from({ length: maxTestLimit - 1 }, (_, idx) =>
        saveConversationEntry(makeConversation(`conv-fill-${idx}`, { updatedAt: 2000 + idx }), {
          storage,
          maxCount: 0
        })
      )
    );
    expect(await store.listChatImagesByConversationId("conv-oldest")).toHaveLength(1);

    fakeIdb.indexGetAllCalls.length = 0;
    const newestConv = makeConversation("conv-newest", {
      updatedAt: 99_999,
      messages: [{ role: "user", content: "最新带图会话", images: [IMG_B] }]
    });
    const evictResult = await saveConversationEntry(newestConv, { storage, maxCount: maxTestLimit });
    expect(evictResult.prunedIds).toEqual(["conv-oldest"]);
    const remainingSummaries = await listConversationSummaries(storage);
    expect(remainingSummaries).toHaveLength(maxTestLimit);
    expect(remainingSummaries.some((c) => c.id === "conv-oldest")).toBe(false);
    expect(
      fakeIdb.indexGetAllCalls.some(
        (call) =>
          call.storeName === CHAT_IMAGES_IDB_STORE &&
          call.indexName === CHAT_IMAGES_INDEX_CONVERSATION_ID &&
          call.query === "conv-oldest"
      )
    ).toBe(true);
    expect(await store.listChatImagesByConversationId("conv-oldest")).toEqual([]);
    const remainingAll = await store.listAllChatImages();
    expect(remainingAll).toHaveLength(1);
    expect(remainingAll[0].conversationId).toBe("conv-newest");

    await clearConversationHistory({ storage });
    expect(await store.listAllChatImages()).toEqual([]);
  });

  it("chat_images 废除独立图片字节 LRU 淘汰，多会话附图持久保留不静默丢失", async () => {
    let clock = 1000;
    const store = createSubtitleIdbStore({
      indexedDB: null,
      now: () => {
        clock += 100;
        return clock;
      }
    });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    await saveConversationEntry(
      makeConversation("c1", { updatedAt: 1000, messages: [{ role: "user", content: "图A", images: [IMG_A] }] }),
      { storage, maxCount: 0 }
    );
    await saveConversationEntry(
      makeConversation("c2", { updatedAt: 2000, messages: [{ role: "user", content: "图B", images: [IMG_B] }] }),
      { storage, maxCount: 0 }
    );
    await saveConversationEntry(
      makeConversation("c3", { updatedAt: 3000, messages: [{ role: "user", content: "图C", images: [IMG_C] }] }),
      { storage, maxCount: 0 }
    );

    expect(await store.listAllChatImages()).toHaveLength(3);
    expect((await readConversationById("c1", storage) as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
    expect((await readConversationById("c2", storage) as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_B]);
    expect((await readConversationById("c3", storage) as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_C]);
  });
});
