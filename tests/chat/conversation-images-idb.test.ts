// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeConversations } from "../../extension/ai/conversation.js";
import {
  CHAT_IMAGES_IDB_STORE,
  CHAT_IMAGES_INDEX_CONVERSATION_ID,
  SUBTITLE_IDB_VERSION,
  createSubtitleIdbStore,
  type SubtitleIdbStore
} from "../../extension/subtitle/idb-store.js";
import { configureSubtitleCacheStoreForTests } from "../../extension/subtitle/store-client.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import {
  HISTORY_STORAGE_KEY,
  computeChatImageId,
  pruneOrphanChatImages,
  readConversationHistory,
  updateConversationHistory,
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

interface FakeStoreState {
  keyPath: string;
  records: Map<string, Record<string, unknown>>;
  indexes: Map<string, string | string[]>;
}

function createFakeIdbWithIndexSpy() {
  const stores = new Map<string, FakeStoreState>();
  const indexGetAllCalls: Array<{ storeName: string; indexName: string; query: unknown }> = [];

  function makeDomStringList(names: Iterable<string>): DOMStringList {
    const arr = Array.from(names);
    return Object.assign(arr, {
      contains: (name: string) => arr.includes(name),
      item: (index: number) => arr[index] ?? null
    }) as unknown as DOMStringList;
  }

  function makeReq<T>(
    executor: () => T,
    enqueueOp?: (runner: () => void) => void
  ): IDBRequest<T> {
    const req: Record<string, unknown> = {
      result: undefined,
      error: null,
      onsuccess: null,
      onerror: null
    };
    const runner = () => {
      try {
        req.result = executor();
        (req.onsuccess as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
      } catch (err) {
        req.error = err;
        (req.onerror as ((ev: Event) => void) | null)?.({ target: req } as unknown as Event);
      }
    };
    if (enqueueOp) {
      enqueueOp(runner);
    } else {
      queueMicrotask(runner);
    }
    return req as unknown as IDBRequest<T>;
  }

  function createStoreApi(
    storeName: string,
    state: FakeStoreState,
    enqueueOp?: (runner: () => void) => void
  ): IDBObjectStore {
    return {
      name: storeName,
      keyPath: state.keyPath,
      get indexNames() {
        return makeDomStringList(state.indexes.keys());
      },
      createIndex(name: string, keyPath: string | string[]) {
        state.indexes.set(name, keyPath);
        return {} as IDBIndex;
      },
      get(key: IDBValidKey) {
        return makeReq(() => {
          const hit = state.records.get(String(key));
          return hit ? structuredClone(hit) : undefined;
        }, enqueueOp);
      },
      getAll() {
        return makeReq(
          () => Array.from(state.records.values()).map((r) => structuredClone(r)),
          enqueueOp
        );
      },
      put(value: Record<string, unknown>) {
        return makeReq(() => {
          const key = String(value[state.keyPath]);
          state.records.set(key, structuredClone(value));
          return key;
        }, enqueueOp);
      },
      delete(key: IDBValidKey) {
        return makeReq(() => {
          state.records.delete(String(key));
          return undefined;
        }, enqueueOp);
      },
      clear() {
        return makeReq(() => {
          state.records.clear();
          return undefined;
        }, enqueueOp);
      },
      index(indexName: string) {
        const keyPath = state.indexes.get(indexName);
        if (!keyPath) {
          throw new Error(`Missing index ${indexName}`);
        }
        return {
          getAll(query?: unknown) {
            indexGetAllCalls.push({ storeName, indexName, query });
            return makeReq(() => {
              const out: Record<string, unknown>[] = [];
              for (const rec of state.records.values()) {
                const val = Array.isArray(keyPath)
                  ? keyPath.map((k) => rec[k])
                  : rec[keyPath];
                if (query === undefined || JSON.stringify(val) === JSON.stringify(query)) {
                  out.push(structuredClone(rec));
                }
              }
              return out;
            }, enqueueOp);
          }
        } as unknown as IDBIndex;
      }
    } as unknown as IDBObjectStore;
  }

  let version = 0;

  const factory = {
    open(_name: string, requestedVersion?: number) {
      const req: Record<string, unknown> = {
        result: null,
        error: null,
        transaction: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null
      };
      const db = {
        get version() {
          return version;
        },
        get objectStoreNames() {
          return makeDomStringList(stores.keys());
        },
        createObjectStore(storeName: string, opts?: { keyPath?: string }) {
          const st: FakeStoreState = {
            keyPath: opts?.keyPath || "id",
            records: new Map(),
            indexes: new Map()
          };
          stores.set(storeName, st);
          return createStoreApi(storeName, st);
        },
        transaction(storeNames: string | string[]) {
          const names = Array.isArray(storeNames) ? storeNames : [storeNames];
          let pending = 0;
          let finished = false;
          let oncompleteCb: ((ev: Event) => void) | null = null;
          const scheduleComplete = () => {
            queueMicrotask(() => {
              queueMicrotask(() => {
                if (pending === 0 && !finished) {
                  finished = true;
                  oncompleteCb?.({} as Event);
                }
              });
            });
          };
          const tx: Record<string, unknown> = {
            error: null,
            get oncomplete() {
              return oncompleteCb;
            },
            set oncomplete(fn: ((ev: Event) => void) | null) {
              oncompleteCb = fn;
              if (finished && fn) {
                queueMicrotask(() => fn({} as Event));
              }
            },
            onerror: null,
            onabort: null,
            objectStore(name: string) {
              const st = stores.get(name);
              if (!st || !names.includes(name)) {
                throw new Error(`ObjectStore ${name} not in transaction`);
              }
              return createStoreApi(name, st, (runner) => {
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
        },
        close() {}
      } as unknown as IDBDatabase;

      queueMicrotask(() => {
        req.result = db;
        const nextVer = requestedVersion ?? (version || 1);
        if (nextVer > version) {
          version = nextVer;
          req.transaction = {
            objectStore(name: string) {
              const st = stores.get(name)!;
              return createStoreApi(name, st);
            }
          };
          (req.onupgradeneeded as ((ev: Event) => void) | null)?.({} as Event);
        }
        (req.onsuccess as ((ev: Event) => void) | null)?.({} as Event);
      });

      return req as unknown as IDBOpenDBRequest;
    }
  } as unknown as IDBFactory;

  return { factory, stores, indexGetAllCalls };
}

function wireSubtitleCacheSwRpc(remoteStore: SubtitleIdbStore) {
  const handler = createSubtitleCacheHandler(remoteStore);
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

describe("阶段 2B：对话图片外置与水合", () => {
  it("升级 SUBTITLE_IDB_VERSION 至 v3 且保留 ai/conversation.ts 同步数据结构契约", () => {
    expect(SUBTITLE_IDB_VERSION).toBe(3);
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

  it("a) 正常写盘外置为 { mime, idbRef } 并经 SW subtitle-cache RPC 落盘与读盘水合还原", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy();
    const remoteStore = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-chat-rpc" });
    const { rpcCalls } = wireSubtitleCacheSwRpc(remoteStore);
    const storage = makeMemoryStorage();

    const conv = makeConversation("conv-1", {
      bvid: "BV1rpc001",
      updatedAt: 20_000,
      messages: [
        { role: "user", content: "请分析这两张图", images: [IMG_A, IMG_B] },
        { role: "assistant", content: "这是分析结果" }
      ]
    });

    const saved = await updateConversationHistory(storage, () => [conv]);
    expect((saved[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A, IMG_B]);

    const rawPersisted = (await remoteStore.listConversations()) as unknown as Array<{
      id: string;
      messages: Array<{ images?: Array<Record<string, unknown>> }>;
    }>;
    const persistedImages = rawPersisted[0].messages[0].images!;
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
    expect(rpcCalls.some((m) => m.op === "put-chat-image")).toBe(true);

    const hydrated = await readConversationHistory(storage);
    expect(rpcCalls.some((m) => m.op === "get-chat-images")).toBe(true);
    expect((hydrated[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A, IMG_B]);
    expect((chatSessionState.savedConversations[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([
      IMG_A,
      IMG_B
    ]);
  });

  it("b) 单张 idbRef 缺失或记录损坏时仅降级受影响单图，整条对话文本与其他正常图片完整加载", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy();
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

    await storage.set({
      [HISTORY_STORAGE_KEY]: [
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
        })
      ]
    });

    const loaded = await readConversationHistory(storage);
    expect(loaded).toHaveLength(1);
    const msgs = (loaded[0] as { messages: Array<{ content: string; images?: unknown }> }).messages;
    expect(msgs).toHaveLength(3);
    expect(msgs[0].content).toBe("第一轮带好图与坏图");
    expect(msgs[0].images).toEqual([IMG_A]);
    expect(msgs[1].content).toBe("正常回答文本");
    expect(msgs[2].content).toBe("第二轮仅带缺失图");
    expect(msgs[2].images).toBeUndefined();
  });

  it("b2) 读盘 SW RPC 抛异常时整条对话文本仍可加载，且并发保存新会话不误擦原会话 idbRef", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy();
    const remoteStore = createSubtitleIdbStore({ indexedDB: fakeIdb.factory, dbName: "test-rpc-err" });
    const handler = createSubtitleCacheHandler(remoteStore);
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
    const conv1 = makeConversation("conv-1", {
      updatedAt: 10_000,
      messages: [
        { role: "user", content: "带图旧对话", images: [IMG_A] },
        { role: "assistant", content: "旧回复" }
      ]
    });
    await updateConversationHistory(storage, () => [conv1]);

    failGetChatImages = true;
    const degraded = await readConversationHistory(storage);
    expect(degraded).toHaveLength(1);
    expect((degraded[0] as { messages: Array<{ content: string; images?: unknown }> }).messages[0]).toEqual({
      role: "user",
      content: "带图旧对话"
    });

    const conv2 = makeConversation("conv-2", { updatedAt: 20_000 });
    await updateConversationHistory(storage, (current) => [conv2, ...current]);

    failGetChatImages = false;
    const recovered = await readConversationHistory(storage);
    const recoveredConv1 = recovered.find((c) => c.id === "conv-1") as {
      messages: Array<{ images?: unknown }>;
    };
    expect(recoveredConv1.messages[0].images).toEqual([IMG_A]);
  });

  it("c) IDB 图片写入失败时安全回退为原内联 base64，绝不写入悬空 idbRef；写盘先写图片再写会话", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const idA = computeChatImageId("conv-fallback", IMG_A.mime, IMG_A.data);
    const idB = computeChatImageId("conv-fallback", IMG_B.mime, IMG_B.data);
    const order: string[] = [];

    store.setWriteInterceptorForTests((ctx) => {
      if (ctx.op === "put-chat-image") {
        order.push(`idb:${ctx.key}`);
        if (ctx.key === idB) {
          throw new Error("QuotaExceededError");
        }
      }
    });
    const origPutMany = store.putConversationsMany.bind(store);
    store.putConversationsMany = vi.fn(async (records) => {
      order.push("idb:putConversationsMany");
      return origPutMany(records);
    });

    const conv = makeConversation("conv-fallback", {
      messages: [
        { role: "user", content: "两张图", images: [IMG_A, IMG_B] },
        { role: "assistant", content: "收到" }
      ]
    });

    await updateConversationHistory(storage, () => [conv]);

    expect(order).toEqual([`idb:${idA}`, `idb:${idB}`, "idb:putConversationsMany"]);

    const persisted = (await store.listConversations()) as unknown as Array<{
      messages: Array<{ images?: Array<Record<string, unknown>> }>;
    }>;
    expect(persisted[0].messages[0].images).toEqual([
      { mime: IMG_A.mime, idbRef: idA },
      { mime: IMG_B.mime, data: IMG_B.data }
    ]);
    expect(await store.getChatImage(idA)).not.toBeNull();
    expect(await store.getChatImage(idB)).toBeNull();

    store.setWriteInterceptorForTests(null);
    const reloaded = await readConversationHistory(storage);
    expect((reloaded[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A, IMG_B]);
    expect(await store.getChatImage(idB)).not.toBeNull();
  });

  it("c2) 会话写盘失败时回滚本次新写入的 IDB 图片，不留无主孤儿", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();
    store.putConversationsMany = vi.fn(async () => {
      throw new Error("conversations idb write failed");
    });

    const conv = makeConversation("conv-set-fail", {
      messages: [{ role: "user", content: "失败回滚", images: [IMG_A] }]
    });

    await expect(updateConversationHistory(storage, () => [conv])).rejects.toThrow("conversations idb write failed");
    expect(await store.listAllChatImages()).toEqual([]);
  });

  it("d) 旧版内联 base64 读路径自动迁移进 IDB 并懒外置回填 chat_images（幂等）", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const legacyConv = makeConversation("conv-legacy", {
      bvid: "BV1leg01",
      updatedAt: 5000,
      messages: [
        { role: "user", content: "历史旧图", images: [IMG_A] },
        { role: "assistant", content: "历史旧回复" }
      ]
    });
    await storage.set({ [HISTORY_STORAGE_KEY]: [legacyConv] });

    store.setWriteInterceptorForTests(() => {
      throw new Error("temporary idb write error");
    });
    const firstRead = await readConversationHistory(storage);
    expect((firstRead[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
    expect(
      ((await store.listConversations()) as unknown as Array<{ messages: Array<{ images?: unknown }> }>)[0]
        .messages[0].images
    ).toEqual([IMG_A]);

    store.setWriteInterceptorForTests(null);
    const secondRead = await readConversationHistory(storage);
    expect((secondRead[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);

    const expectedRef = computeChatImageId("conv-legacy", IMG_A.mime, IMG_A.data);
    expect(
      ((await store.listConversations()) as unknown as Array<{ messages: Array<{ images?: unknown }> }>)[0]
        .messages[0].images
    ).toEqual([{ mime: IMG_A.mime, idbRef: expectedRef }]);
    expect(await store.getChatImage(expectedRef)).toMatchObject({
      id: expectedRef,
      conversationId: "conv-legacy",
      bvid: "BV1leg01",
      mime: IMG_A.mime,
      data: IMG_A.data
    });

    const putSpy = vi.spyOn(store, "putConversationsMany");
    const thirdRead = await readConversationHistory(storage);
    expect((thirdRead[0] as { messages: Array<{ images?: unknown }> }).messages[0].images).toEqual([IMG_A]);
    expect(putSpy).not.toHaveBeenCalled();
  });

  it("e) 删除单条会话（含 undo）、覆盖移除图片、清空全部与超上限裁剪后 chat_images 零孤儿残留", async () => {
    const fakeIdb = createFakeIdbWithIndexSpy();
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
    await updateConversationHistory(storage, () => [conv2, conv1]);
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
    await updateConversationHistory(storage, (curr) => [
      conv2Updated,
      ...curr.filter((c) => c.id !== "conv-2")
    ]);
    const conv2Images = await store.listChatImagesByConversationId("conv-2");
    expect(conv2Images).toHaveLength(1);
    expect(conv2Images[0].data).toBe(IMG_C.data);
    expect(await store.getChatImage(computeChatImageId("conv-2", IMG_B.mime, IMG_B.data))).toBeNull();

    const conv2TextOnly = makeConversation("conv-2", {
      updatedAt: 4000,
      messages: [{ role: "user", content: "只留文字" }]
    });
    await updateConversationHistory(storage, (curr) => [
      conv2TextOnly,
      ...curr.filter((c) => c.id !== "conv-2")
    ]);
    expect(await store.listChatImagesByConversationId("conv-2")).toEqual([]);

    await updateConversationHistory(storage, () => []);
    expect(await store.listAllChatImages()).toEqual([]);

    const oldestConv = makeConversation("conv-oldest", {
      updatedAt: 1000,
      messages: [{ role: "user", content: "最旧带图会话", images: [IMG_A] }]
    });
    const maxTestLimit = 5;
    const fillerConvs = Array.from({ length: maxTestLimit - 1 }, (_, idx) =>
      makeConversation(`conv-fill-${idx}`, { updatedAt: 2000 + idx })
    );
    await updateConversationHistory(storage, () => [...fillerConvs, oldestConv]);
    expect(await store.listChatImagesByConversationId("conv-oldest")).toHaveLength(1);

    fakeIdb.indexGetAllCalls.length = 0;
    const newestConv = makeConversation("conv-newest", {
      updatedAt: 99_999,
      messages: [{ role: "user", content: "最新带图会话", images: [IMG_B] }]
    });
    const afterEvict = await updateConversationHistory(
      storage,
      (curr) => [newestConv, ...curr],
      { maxCount: maxTestLimit }
    );
    expect(afterEvict).toHaveLength(maxTestLimit);
    expect(afterEvict.some((c) => c.id === "conv-oldest")).toBe(false);
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

    await updateConversationHistory(storage, () => []);
    expect(await store.listAllChatImages()).toEqual([]);
  });

  it("e2) 兜底孤儿清理（pruneOrphanChatImages）与总字节上限 LRU 淘汰保护", async () => {
    let clock = 1000;
    const store = createSubtitleIdbStore({
      indexedDB: null,
      maxChatImageBytes: 900,
      now: () => {
        clock += 100;
        return clock;
      }
    });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const alive = makeConversation("conv-alive", {
      updatedAt: 5000,
      messages: [{ role: "user", content: "存活图", images: [{ mime: "image/webp", data: "A".repeat(120) }] }]
    });
    await updateConversationHistory(storage, () => [alive]);

    await store.putChatImage({
      id: "img_ghost_conv",
      conversationId: "conv-ghost",
      mime: "image/webp",
      data: "B".repeat(100)
    });
    await store.putChatImage({
      id: "img_unreferenced_in_alive",
      conversationId: "conv-alive",
      mime: "image/webp",
      data: "C".repeat(100)
    });
    expect(await store.listAllChatImages()).toHaveLength(3);

    const pruned = await pruneOrphanChatImages(storage);
    expect(pruned.sort()).toEqual(["img_ghost_conv", "img_unreferenced_in_alive"].sort());
    expect(await store.listAllChatImages()).toHaveLength(1);

    await store.clearAllChatImages();
    const res1 = await store.putChatImage({
      id: "lru-1",
      conversationId: "c1",
      mime: "image/webp",
      data: "1".repeat(260)
    });
    expect(res1.ok).toBe(true);

    const res2 = await store.putChatImage({
      id: "lru-2",
      conversationId: "c2",
      mime: "image/webp",
      data: "2".repeat(260)
    });
    expect(res2.ok).toBe(true);

    expect(await store.getChatImage("lru-1")).not.toBeNull();

    const res3 = await store.putChatImage({
      id: "lru-3",
      conversationId: "c3",
      mime: "image/webp",
      data: "3".repeat(260)
    });
    expect(res3.ok).toBe(true);
    expect(res3.evictedIds).toEqual(["lru-2"]);
    expect(await store.getChatImage("lru-2")).toBeNull();
    expect(await store.getChatImage("lru-1")).not.toBeNull();
    expect(await store.getChatImage("lru-3")).not.toBeNull();
  });
});
