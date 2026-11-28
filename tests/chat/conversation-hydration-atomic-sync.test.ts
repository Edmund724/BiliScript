// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createFakeIdbEnvironment } from "../helpers/fake-idb.js";
import {
  CONVERSATIONS_V1_MIGRATED_META_KEY,
  createSubtitleIdbStore,
  type SubtitleIdbStore
} from "../../extension/subtitle/idb-store.js";
import { configureSubtitleCacheStoreForTests } from "../../extension/subtitle/store-client.js";
import { createSubtitleCacheHandler } from "../../extension/subtitle/subtitle-cache-handler.js";
import {
  CONVERSATIONS_SYNC_SIGNAL_KEY,
  HISTORY_STORAGE_KEY,
  listConversationSummaries,
  patchConversationSummaryAnchorEntry,
  readConversationById,
  saveConversationEntry,
  saveLiveTextToolRecordEntry,
  type ConversationSyncSignal,
  type StoredConversation
} from "../../extension/chat/conversation-storage.js";
import {
  applyConversationSyncSignal,
  createConversationStore,
  type CreateConversationStoreDeps,
  type StorageArea
} from "../../extension/chat/conversation-store.js";
import {
  applyConversationIdentity,
  chatSessionState,
  chatSessionStateForTests,
  detachConversationIdentity,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import { createChatRuntime } from "../../extension/chat/chat-runtime.js";
import { OFFSCREEN_CHAT_PORT_NAME, type ChatPortMessage } from "../../extension/chat/protocol.js";
import { createReaderChatLists } from "../../extension/reader/chat-lists.js";
import { persistLiveTextToolRecord, type LiveTextToolRecord } from "../../extension/live/live-text-tool-records.js";
import { MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO, isLiveTextToolHistoryEntry } from "../../extension/live/live-text-tool-history.js";
import { YOUTUBE_UNIT_CID } from "../../extension/shared/site.js";
import type { SubtitleCacheMessage, SubtitleCacheResponse } from "../../extension/shared/messaging-protocol.js";

const IMG_A = { mime: "image/webp", data: "QUJDREVGR0hJSktMTU5PUA==" };
const IMG_B = { mime: "image/png", data: "WFl6MDEyMzQ1Njc4OUFCQ0Q=" };

function makeMemoryStorage(initial: Record<string, unknown> = {}): StorageArea & {
  data: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, structuredClone(data.get(k))]))
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        data.set(k, structuredClone(v));
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const k of list) data.delete(k);
    })
  };
}

function makeChatConv(
  id: string,
  options: {
    site?: "bilibili" | "youtube";
    bvid?: string;
    cid?: string;
    updatedAt?: number;
    transcriptMode?: "full" | "hybrid";
    withImage?: boolean;
    messages?: Array<{ id?: string; role: "user" | "assistant"; content: string; images?: Array<{ mime: string; data: string }> }>;
  } = {}
): StoredConversation {
  const site = options.site ?? "bilibili";
  const bvid = options.bvid ?? (site === "youtube" ? `ytVid_${id}` : `BV1${id.replace(/[^a-zA-Z0-9]/g, "")}`);
  const cid = options.cid ?? (site === "youtube" ? YOUTUBE_UNIT_CID : "101");
  const url =
    site === "youtube"
      ? `https://www.youtube.com/watch?v=${bvid}`
      : `https://www.bilibili.com/video/${bvid}/`;
  const updatedAt = options.updatedAt ?? 10_000;
  return {
    id,
    title: `视频 ${id}`,
    contextKey: site === "youtube" ? `video:youtube:${bvid}` : `video:${bvid}|${cid}`,
    contextTitle: `视频 ${id}`,
    contextUrl: url,
    isVideoContext: true,
    createdAt: updatedAt - 100,
    updatedAt,
    contextRef: {
      site,
      title: `视频 ${id}`,
      url,
      author: "",
      uploadDate: "",
      bvid,
      cid,
      aid: "",
      pageIndex: 1,
      pageCount: 1,
      pageTitle: "",
      subtitleLang: "",
      selectedSubtitleId: "",
      selectedSubtitleUrl: "",
      isVideoContext: true
    },
    ...(options.transcriptMode ? { transcriptMode: options.transcriptMode } : {}),
    messages: (options.messages ?? [
      { id: `${id}-m0`, role: "user", content: `长问题 ${id} ${"x".repeat(200)}`, ...(options.withImage ? { images: [IMG_A] } : {}) },
      { id: `${id}-m1`, role: "assistant", content: `长回答 ${id} ${"y".repeat(400)}` }
    ]) as StoredConversation["messages"]
  } as StoredConversation;
}

function makeLiveRecord(overrides: Partial<LiveTextToolRecord> = {}): LiveTextToolRecord {
  return {
    callId: "live-call-1",
    source: "gemini",
    status: "completed",
    objective: "分析关键论点",
    summary: "核心摘要",
    markdown: "# 伴看分析\n\n详细正文",
    startedAt: 1000,
    endedAt: 2000,
    video: {
      bvid: "BV1live0001",
      cid: "1001",
      pageIndex: 1,
      title: "伴看测试视频",
      url: "https://www.bilibili.com/video/BV1live0001/"
    },
    ...overrides
  };
}

function wireSwRpc(
  remoteStore: SubtitleIdbStore,
  options: { resolveChatHistoryMaxCount?: () => Promise<number> } = {}
) {
  const handler = createSubtitleCacheHandler(remoteStore, options);
  const rpcCalls: SubtitleCacheMessage[] = [];
  const rpcResponses: Array<{ op: SubtitleCacheMessage["op"]; response: SubtitleCacheResponse }> = [];
  const sendMessage = vi.fn(
    (message: unknown, callback?: (response: SubtitleCacheResponse) => void) => {
      const msg = JSON.parse(JSON.stringify(message)) as SubtitleCacheMessage;
      if (msg?.type === "subtitle-cache") {
        rpcCalls.push(msg);
        handler(msg, {}, (response) => {
          const cloned = JSON.parse(JSON.stringify(response)) as SubtitleCacheResponse;
          rpcResponses.push({ op: msg.op, response: cloned });
          callback?.(cloned);
        });
        return undefined;
      }
      callback?.({ ok: true });
      return undefined;
    }
  );
  (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;
  return { sendMessage, rpcCalls, rpcResponses };
}

function makeStoreDeps(storage: StorageArea, overrides: Partial<CreateConversationStoreDeps> = {}): CreateConversationStoreDeps {
  return {
    loadContextState: vi.fn(async () => true),
    resolveAiConversationRef: vi.fn(async () => ({})),
    onConversationChanged: vi.fn(),
    onStreamInterrupted: vi.fn(),
    onContextNotice: vi.fn(),
    storage,
    ...overrides
  };
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  configureSubtitleCacheStoreForTests(null);
  document.body.innerHTML = "";
});

afterEach(() => {
  configureSubtitleCacheStoreForTests(null);
  vi.restoreAllMocks();
});

describe("Issue #34：轻量摘要头、按需水合、后台原子 RPC 与多标签 O(1) 同步", () => {
  it("100 条带长消息附图会话 + 多条伴看记录初始化时零 readConversationById/get-conversation；点开单条精确水合，切换与关闭释放活跃消息与伴看详情", async () => {
    const { factory } = createFakeIdbEnvironment();
    const remoteStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-34-100-init" });
    const { rpcCalls } = wireSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => 0 });
    const storage = makeMemoryStorage();

    for (let i = 1; i <= 100; i += 1) {
      await saveConversationEntry(
        makeChatConv(`c${i}`, {
          updatedAt: 1000 + i,
          withImage: i % 10 === 0,
          transcriptMode: i % 2 === 0 ? "hybrid" : "full"
        }),
        { storage }
      );
    }
    await persistLiveTextToolRecord(
      makeLiveRecord({ callId: "lc-1", endedAt: 5000, video: { bvid: "BV1liveA", cid: "1", pageIndex: 1, title: "伴看A", url: "https://www.bilibili.com/video/BV1liveA/" } }),
      storage
    );
    await persistLiveTextToolRecord(
      makeLiveRecord({ callId: "lc-2", endedAt: 5100, video: { bvid: "BV1liveA", cid: "1", pageIndex: 1, title: "伴看A", url: "https://www.bilibili.com/video/BV1liveA/" } }),
      storage
    );
    await persistLiveTextToolRecord(
      makeLiveRecord({ callId: "lc-3", endedAt: 5200, video: { bvid: "BV1liveB", cid: "2", pageIndex: 1, title: "伴看B", url: "https://www.bilibili.com/video/BV1liveB/" } }),
      storage
    );

    resetChatSessionStateForTests();
    rpcCalls.length = 0;

    const convStore = createConversationStore(makeStoreDeps(storage));
    await convStore.loadAll();

    expect(chatSessionState.savedConversations).toHaveLength(102);
    expect(rpcCalls.filter((c) => c.op === "list-conversation-metas")).toHaveLength(1);
    expect(rpcCalls.filter((c) => c.op === "get-conversation")).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.op === "list-conversations")).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.op === "get-chat-images")).toHaveLength(0);

    for (const item of chatSessionState.savedConversations) {
      expect("messages" in item).toBe(false);
      expect("records" in item).toBe(false);
    }
    const liveA = chatSessionState.savedConversations.find((item) => item.id === "live:BV1liveA:1");
    expect(liveA).toMatchObject({ kind: "live-text-tool", recordCount: 2, messageCount: 0, hasImages: false });
    const chat10 = chatSessionState.savedConversations.find((item) => item.id === "c10");
    expect(chat10).toMatchObject({ kind: "chat", messageCount: 2, hasImages: true, transcriptMode: "hybrid" });

    await convStore.applyById("c10");
    expect(rpcCalls.filter((c) => c.op === "get-conversation")).toHaveLength(1);
    expect(rpcCalls.filter((c) => c.op === "get-chat-images")).toHaveLength(1);
    expect(chatSessionState.currentConversationId).toBe("c10");
    expect(chatSessionState.currentConversationMeta?.transcriptMode).toBe("hybrid");
    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(chatSessionState.chatHistory[0].images).toEqual([IMG_A]);

    await convStore.applyById("c1");
    expect(chatSessionState.currentConversationId).toBe("c1");
    expect(chatSessionState.currentConversationMeta?.transcriptMode).toBe("full");
    expect(chatSessionState.chatHistory[0].images).toBeUndefined();

    const historyList = document.createElement("div");
    const historyClearBtn = document.createElement("button");
    document.body.append(historyList, historyClearBtn);
    const lists = createReaderChatLists({
      historyList,
      historyClearBtn,
      applyById: (id) => convStore.applyById(id),
      deleteById: (id) => convStore.deleteById(id),
      isTurnActive: () => false,
      confirmDeleteCurrent: () => true,
      startNewConversation: () => true,
      hideHistoryPopover: vi.fn()
    });
    lists.renderHistoryList();
    expect(historyList.textContent).toContain("2 条记录");
    const getCallsBeforeLiveOpen = rpcCalls.filter((c) => c.op === "get-conversation").length;

    historyList.querySelector<HTMLElement>('.chat-history-item[data-id="live:BV1liveA:1"]')?.click();
    await vi.waitFor(() => {
      expect(historyList.textContent).toContain("分析关键论点");
    });
    expect(rpcCalls.filter((c) => c.op === "get-conversation")).toHaveLength(getCallsBeforeLiveOpen + 1);
    expect(historyList.querySelectorAll("details[data-record-details]")).toHaveLength(2);

    expect(lists.exitLiveHistoryDetail()).toBe(true);
    expect(historyList.querySelector(".chat-live-history-detail")).toBeNull();

    detachConversationIdentity();
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(chatSessionState.currentConversationId).toBe("");
  });

  it("快速连点切换 applyById 时单调 seq 令牌阻止慢返回的旧会话覆盖目标会话", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    await saveConversationEntry(makeChatConv("slow", { updatedAt: 1000 }), { storage });
    await saveConversationEntry(makeChatConv("fast", { updatedAt: 2000 }), { storage });

    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const origGet = store.getConversation.bind(store);
    vi.spyOn(store, "getConversation").mockImplementation(async (id: string) => {
      if (id === "slow") {
        await slowGate;
      }
      return origGet(id);
    });

    const convStore = createConversationStore(makeStoreDeps(storage));
    await convStore.loadAll();

    const pSlow = convStore.applyById("slow");
    const pFast = convStore.applyById("fast");
    await expect(pFast).resolves.toBe(true);
    expect(chatSessionState.currentConversationId).toBe("fast");

    releaseSlow();
    await expect(pSlow).resolves.toBe(false);
    expect(chatSessionState.currentConversationId).toBe("fast");
  });

  it("deleteById 6 秒撤销窗口无损恢复普通带图会话与伴看记录（含 chat_images Blob 重建）", async () => {
    const { factory } = createFakeIdbEnvironment();
    const remoteStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-34-undo" });
    wireSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => 0 });
    const storage = makeMemoryStorage();

    await saveConversationEntry(
      makeChatConv("c-img", {
        updatedAt: 2000,
        withImage: true,
        transcriptMode: "hybrid"
      }),
      { storage }
    );
    await persistLiveTextToolRecord(makeLiveRecord({ callId: "undo-live-1", endedAt: 3000 }), storage);

    const convStore = createConversationStore(makeStoreDeps(storage));
    await convStore.loadAll();
    await convStore.applyById("c-img");

    const chatDel = await convStore.deleteById("c-img");
    expect(chatDel).not.toBeNull();
    expect(await remoteStore.getConversation("c-img")).toBeNull();
    expect(await remoteStore.listChatImagesByConversationId("c-img")).toEqual([]);

    await chatDel!.undo();
    const restoredChat = await readConversationById("c-img", storage);
    expect(restoredChat && !isLiveTextToolHistoryEntry(restoredChat)).toBe(true);
    if (restoredChat && !isLiveTextToolHistoryEntry(restoredChat)) {
      expect(restoredChat.messages[0].images).toEqual([IMG_A]);
      expect(restoredChat.transcriptMode).toBe("hybrid");
    }
    expect(await remoteStore.listChatImagesByConversationId("c-img")).toHaveLength(1);
    expect(chatSessionState.currentConversationId).toBe("c-img");
    expect(chatSessionState.chatHistory[0].images).toEqual([IMG_A]);

    const liveDel = await convStore.deleteById("live:BV1live0001:1001");
    expect(liveDel).not.toBeNull();
    expect(await remoteStore.getConversation("live:BV1live0001:1001")).toBeNull();

    await liveDel!.undo();
    const restoredLive = await readConversationById("live:BV1live0001:1001", storage);
    expect(isLiveTextToolHistoryEntry(restoredLive)).toBe(true);
    if (isLiveTextToolHistoryEntry(restoredLive)) {
      expect(restoredLive.records).toHaveLength(1);
      expect(restoredLive.records[0].callId).toBe("undo-live-1");
    }
  });

  it("transcriptMode 经 chat-runtime 回执落盘到会话头，重开恢复后自动透传至下一轮请求", async () => {
    const store = createSubtitleIdbStore({ indexedDB: null });
    configureSubtitleCacheStoreForTests(store);
    const storage = makeMemoryStorage();

    const convStore = createConversationStore(makeStoreDeps(storage));
    chatSessionStateForTests.contextData = {
      bvid: "BV1tm0001",
      cid: "101",
      title: "长视频",
      url: "https://www.bilibili.com/video/BV1tm0001/",
      isVideoContext: true
    };
    chatSessionStateForTests.currentContextKey = "video:BV1tm0001|101";

    const posted: Array<Record<string, unknown>> = [];
    let listener: ((msg: ChatPortMessage) => void) | null = null;
    const runtime = createChatRuntime({
      messages: document.createElement("div"),
      input: document.createElement("textarea"),
      store: convStore,
      ui: {
        setStreamingUiState: vi.fn(),
        messagesNotice: { show: vi.fn(), clear: vi.fn() },
        inputNotice: { show: vi.fn(), clear: vi.fn() },
        hideHistoryPopover: vi.fn(),
        removeCenteredState: vi.fn(),
        removeSuggestions: vi.fn(),
        showSetupBlockedState: vi.fn(),
        autosizeInput: vi.fn()
      },
      ensureCurrentContextForSend: vi.fn(async () => ({ pass: true as const })),
      getProviderId: () => "p1",
      getSelectedModel: () => "m1",
      getTimestampNavDeps: () => ({}),
      connectPort: vi.fn(async () => ({
        name: OFFSCREEN_CHAT_PORT_NAME,
        postMessage: (m: unknown) => { posted.push(m as Record<string, unknown>); },
        disconnect: vi.fn(),
        onMessage: { addListener: (fn: (msg: ChatPortMessage) => void) => { listener = fn; } },
        onDisconnect: { addListener: () => {} }
      }))
    });

    await runtime.sendTurn("第一轮长视频提问");
    listener!({ type: "token", data: "回复1", transcriptMode: "hybrid" });
    listener!({ type: "done", transcriptMode: "hybrid" });
    await vi.waitFor(async () => {
      expect(await store.listConversationMetas()).toHaveLength(1);
    });

    const convId = chatSessionState.currentConversationId;
    expect(chatSessionState.savedConversations[0].transcriptMode).toBe("hybrid");

    runtime.resetStreamState();
    resetChatSessionStateForTests();
    await convStore.loadAll();
    expect(chatSessionState.savedConversations[0].transcriptMode).toBe("hybrid");
    await convStore.applyById(convId);
    expect(chatSessionState.currentConversationMeta?.transcriptMode).toBe("hybrid");

    await runtime.sendTurn("重开后追问");
    expect(posted[1].transcriptMode).toBe("hybrid");
  });

  it("跨站点并发写入、伴看合并去重、summaryAnchor 单调无覆盖回写与 Decision 4（0=无限制 / >0 裁剪删图）", async () => {
    const { factory } = createFakeIdbEnvironment();
    const remoteStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-34-concurrent-atomic" });
    let configuredMaxCount = 0;
    wireSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => configuredMaxCount });
    const storage = makeMemoryStorage();

    const baseConv = makeChatConv("shared-conv", {
      site: "bilibili",
      updatedAt: 10_000,
      messages: [
        { id: "m1", role: "user", content: "T1-Q" },
        { id: "m2", role: "assistant", content: "T1-A" },
        { id: "m3", role: "user", content: "T2-Q" },
        { id: "m4", role: "assistant", content: "T2-A" }
      ]
    });
    await saveConversationEntry(baseConv, { storage });

    const withTurn3 = makeChatConv("shared-conv", {
      site: "bilibili",
      updatedAt: 11_000,
      messages: [
        { id: "m1", role: "user", content: "T1-Q" },
        { id: "m2", role: "assistant", content: "T1-A" },
        { id: "m3", role: "user", content: "T2-Q" },
        { id: "m4", role: "assistant", content: "T2-A" },
        { id: "m5", role: "user", content: "T3-Q" },
        { id: "m6", role: "assistant", content: "T3-A" }
      ]
    });
    const ytConv = makeChatConv("yt-conv", { site: "youtube", updatedAt: 12_000, withImage: true });

    const [anchorRes] = await Promise.all([
      patchConversationSummaryAnchorEntry({
        id: "shared-conv",
        summaryAnchor: { coveredMessageCount: 2, summaryText: "前2条摘要", updatedAt: 10_500 },
        expectedCoveredMessageIds: ["m1", "m2"]
      }),
      saveConversationEntry(withTurn3, { storage }),
      saveConversationEntry(ytConv, { storage }),
      ...Array.from({ length: 22 }, (_, i) =>
        saveLiveTextToolRecordEntry(
          makeLiveRecord({
            callId: i === 21 ? "call-5" : `call-${i + 1}`,
            startedAt: 100 + i * 10,
            endedAt: 105 + i * 10,
            summary: `摘要-${i + 1}`
          }),
          { storage }
        )
      )
    ]);

    expect(anchorRes.updated).toBe(true);
    const reloadedShared = await readConversationById("shared-conv", storage);
    expect(reloadedShared && !isLiveTextToolHistoryEntry(reloadedShared)).toBe(true);
    if (reloadedShared && !isLiveTextToolHistoryEntry(reloadedShared)) {
      expect(reloadedShared.messages).toHaveLength(6);
      expect(reloadedShared.messages[5].content).toBe("T3-A");
      expect(reloadedShared.summaryAnchor).toEqual({
        coveredMessageCount: 2,
        summaryText: "前2条摘要",
        updatedAt: 10_500
      });
    }

    const stalePatch = await patchConversationSummaryAnchorEntry({
      id: "shared-conv",
      summaryAnchor: { coveredMessageCount: 2, summaryText: "旧重复", updatedAt: 10_600 }
    });
    expect(stalePatch.updated).toBe(false);

    const mismatchPatch = await patchConversationSummaryAnchorEntry({
      id: "shared-conv",
      summaryAnchor: { coveredMessageCount: 4, summaryText: "回滚失效", updatedAt: 10_700 },
      expectedCoveredMessageIds: ["m1", "m2", "m3", "WRONG"]
    });
    expect(mismatchPatch.updated).toBe(false);

    const overflowPatch = await patchConversationSummaryAnchorEntry({
      id: "shared-conv",
      summaryAnchor: { coveredMessageCount: 99, summaryText: "越界", updatedAt: 10_800 }
    });
    expect(overflowPatch.updated).toBe(false);

    const liveEntry = await readConversationById("live:BV1live0001:1001", storage);
    expect(isLiveTextToolHistoryEntry(liveEntry)).toBe(true);
    if (isLiveTextToolHistoryEntry(liveEntry)) {
      expect(liveEntry.records).toHaveLength(MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO);
      expect(liveEntry.records.find((r) => r.callId === "call-5")?.summary).toBe("摘要-22");
    }

    configuredMaxCount = 0;
    for (let i = 1; i <= 25; i += 1) {
      await saveConversationEntry(
        makeChatConv(`keep-all-${i}`, { updatedAt: 20_000 + i, withImage: true }),
        { storage }
      );
    }
    const metasAtZero = await remoteStore.listConversationMetas();
    expect(metasAtZero.filter((m) => m.kind !== "live-text-tool").length).toBe(27);

    configuredMaxCount = 20;
    const prunedWrite = await saveConversationEntry(
      makeChatConv("trigger-prune", { updatedAt: 99_999, withImage: true }),
      { storage }
    );
    expect(prunedWrite.prunedIds).toHaveLength(8);
    expect(prunedWrite.prunedIds).toContain("shared-conv");
    expect(prunedWrite.prunedIds).toContain("yt-conv");
    expect(await remoteStore.listChatImagesByConversationId("yt-conv")).toEqual([]);
    const metasAfterPrune = await remoteStore.listConversationMetas();
    expect(metasAfterPrune.filter((m) => m.kind !== "live-text-tool")).toHaveLength(20);
    expect(metasAfterPrune.some((m) => m.id === "live:BV1live0001:1001")).toBe(true);
  });

  it("3 个标签页同时冷启动遇到旧 biliscript_ai_conversations_v1 时仅导入一次（store_meta 门控幂等）", async () => {
    const { factory } = createFakeIdbEnvironment();
    const remoteStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-34-migrate-3tabs" });
    const { rpcResponses } = wireSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => 0 });

    const legacyItems = Array.from({ length: 5 }, (_, i) =>
      makeChatConv(`leg-${i + 1}`, { updatedAt: 1000 + i * 100, withImage: i === 0 })
    );
    const sharedStorage = makeMemoryStorage({ [HISTORY_STORAGE_KEY]: legacyItems });

    const [tab1, tab2, tab3] = await Promise.all([
      listConversationSummaries(sharedStorage),
      listConversationSummaries(sharedStorage),
      listConversationSummaries(sharedStorage)
    ]);

    expect(tab1).toHaveLength(5);
    expect(tab2).toHaveLength(5);
    expect(tab3).toHaveLength(5);

    const migrateResults = rpcResponses
      .filter((entry) => entry.op === "migrate-legacy-conversations")
      .map((entry) => entry.response);
    expect(migrateResults.filter((r) => r.migrated === true)).toHaveLength(1);
    expect(migrateResults.find((r) => r.migrated === true)?.importedCount).toBe(5);
    expect(await remoteStore.getStoreMeta(CONVERSATIONS_V1_MIGRATED_META_KEY)).toBeTruthy();
    expect(sharedStorage.data.has(HISTORY_STORAGE_KEY)).toBe(false);
    expect(await remoteStore.listAllChatImages()).toHaveLength(1);
  });

  it("多标签 O(1) 增量同步：originClientId 屏蔽自回声，兄弟标签零 listConversationMetas 重查修补侧栏，命中当前会话时按需点查刷新正文", async () => {
    const { factory } = createFakeIdbEnvironment();
    const remoteStore = createSubtitleIdbStore({ indexedDB: factory, dbName: "test-34-o1-sync" });
    const { rpcCalls } = wireSwRpc(remoteStore, { resolveChatHistoryMaxCount: async () => 0 });
    const storage = makeMemoryStorage();

    await saveConversationEntry(makeChatConv("c1", { updatedAt: 1000 }), { storage, clientId: "tab-a" });
    await saveConversationEntry(makeChatConv("c2", { updatedAt: 2000 }), { storage, clientId: "tab-a" });

    const tabBStore = createConversationStore(makeStoreDeps(storage, { clientId: "tab-b" }));
    await tabBStore.loadAll();
    await tabBStore.applyById("c1");
    expect(chatSessionState.savedConversations.map((s) => s.id)).toEqual(["c2", "c1"]);

    await saveConversationEntry(
      makeChatConv("c3", { updatedAt: 3000, withImage: true }),
      { storage, clientId: "tab-a" }
    );
    const signalUpsertNew = storage.data.get(CONVERSATIONS_SYNC_SIGNAL_KEY) as ConversationSyncSignal;
    expect(signalUpsertNew.op).toBe("upsert");
    expect(signalUpsertNew.originClientId).toBe("tab-a");

    await tabBStore.loadAll();
    const savedBeforeSync = chatSessionState.savedConversations.filter((s) => s.id !== "c3");
    chatSessionStateForTests.savedConversations = savedBeforeSync;
    rpcCalls.length = 0;

    const selfIgnored = await applyConversationSyncSignal(signalUpsertNew, {
      storage,
      clientId: "tab-a"
    });
    expect(selfIgnored).toBe(false);
    expect(rpcCalls).toHaveLength(0);

    const onCurrentUpdated = vi.fn();
    const siblingApplied = await applyConversationSyncSignal(signalUpsertNew, {
      storage,
      clientId: "tab-b",
      onCurrentUpdated
    });
    expect(siblingApplied).toBe(true);
    expect(chatSessionState.savedConversations.map((s) => s.id)).toEqual(["c3", "c2", "c1"]);
    expect(rpcCalls.filter((c) => c.op === "list-conversation-metas")).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.op === "list-conversations")).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.op === "get-conversation")).toHaveLength(0);
    expect(onCurrentUpdated).not.toHaveBeenCalled();

    const updatedC1 = makeChatConv("c1", {
      updatedAt: 4000,
      messages: [
        { role: "user", content: "旧问题" },
        { role: "assistant", content: "旧回答" },
        { role: "user", content: "Tab A 追问" },
        { role: "assistant", content: "Tab A 新回答", images: [IMG_B] }
      ]
    });
    await saveConversationEntry(updatedC1, { storage, clientId: "tab-a" });
    const signalUpsertCurrent = storage.data.get(CONVERSATIONS_SYNC_SIGNAL_KEY) as ConversationSyncSignal;
    rpcCalls.length = 0;

    const currentRefreshed = await applyConversationSyncSignal(signalUpsertCurrent, {
      storage,
      clientId: "tab-b",
      onCurrentUpdated
    });
    expect(currentRefreshed).toBe(true);
    expect(rpcCalls.filter((c) => c.op === "list-conversation-metas")).toHaveLength(0);
    expect(rpcCalls.filter((c) => c.op === "get-conversation")).toHaveLength(1);
    expect(onCurrentUpdated).toHaveBeenCalledTimes(1);
    expect(chatSessionState.chatHistory).toHaveLength(4);
    expect(chatSessionState.chatHistory[3].content).toBe("Tab A 新回答");

    rpcCalls.length = 0;
    const deleteSignal: ConversationSyncSignal = {
      op: "delete",
      originClientId: "tab-a",
      seq: 99,
      deletedIds: ["c1"]
    };
    const deleted = await applyConversationSyncSignal(deleteSignal, {
      storage,
      clientId: "tab-b",
      onCurrentUpdated
    });
    expect(deleted).toBe(true);
    expect(rpcCalls).toHaveLength(0);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(chatSessionState.savedConversations.map((s) => s.id)).toEqual(["c3", "c2"]);
  });
});
