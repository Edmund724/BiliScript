import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { CreateConversationStoreDeps, StorageArea } from "../../extension/chat/conversation-store.js";

let createConversationStore: typeof import("../../extension/chat/conversation-store.js").createConversationStore;
let CONVERSATIONS_STORAGE_KEY: typeof import("../../extension/chat/conversation-store.js").CONVERSATIONS_STORAGE_KEY;
let syncSavedConversationsFromStorage: typeof import("../../extension/chat/conversation-store.js").syncSavedConversationsFromStorage;
let updateConversationHistory: typeof import("../../extension/chat/conversation-storage.js").updateConversationHistory;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let applyContextToMain: typeof import("../../extension/chat/chat-state.js").applyContextToMain;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

function makeSharedStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn(async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) {
        data.set(k, v);
      }
    })
  };
}

function makeStore(
  storage: StorageArea,
  overrides: Partial<CreateConversationStoreDeps> = {}
) {
  const deps: CreateConversationStoreDeps = {
    loadContextState: vi.fn(async () => true),
    resolveAiConversationRef: vi.fn(async () => ({})),
    onConversationChanged: vi.fn(),
    onStreamInterrupted: vi.fn(),
    onContextNotice: vi.fn(),
    storage,
    getMaxCount: () => 0,
    ...overrides
  };
  return { store: createConversationStore(deps), deps };
}

function makeStoredConversation(id: string, bvid: string, cid: string, updatedAt: number) {
  const url = `https://www.bilibili.com/video/${bvid}/`;
  return {
    id,
    title: `视频 ${bvid}`,
    contextKey: `video:${bvid}|${cid}`,
    contextTitle: `视频 ${bvid}`,
    contextUrl: url,
    isVideoContext: true,
    createdAt: updatedAt - 100,
    updatedAt,
    contextRef: { bvid, cid, url, title: `视频 ${bvid}` },
    messages: [
      { role: "user", content: `问 ${id}` },
      { role: "assistant", content: `答 ${id}` }
    ]
  };
}

beforeEach(async () => {
  resetModuleState();
  ({
    createConversationStore,
    CONVERSATIONS_STORAGE_KEY,
    syncSavedConversationsFromStorage
  } = await import("../../extension/chat/conversation-store.js"));
  ({ updateConversationHistory } = await import("../../extension/chat/conversation-storage.js"));
  ({
    chatSessionState,
    chatSessionStateForTests,
    applyConversationIdentity,
    applyContextToMain,
    resetChatSessionStateForTests
  } = await import("../../extension/chat/chat-state.js"));
  resetChatSessionStateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("跨标签页并发会话持久化与外部同步", () => {
  it("标签页 A 内存落后时调用 persistCurrent 不抹除标签页 B 先写入的新会话", async () => {
    const storage = makeSharedStorage();
    const oldConv = makeStoredConversation("conv-0", "BV0", "1", 1000);
    await storage.set({ [CONVERSATIONS_STORAGE_KEY]: [oldConv] });

    const { store: storeA } = makeStore(storage);
    await storeA.loadAll();
    expect(chatSessionState.savedConversations.map((c) => c.id)).toEqual(["conv-0"]);

    const convB = makeStoredConversation("conv-b", "BVB", "202", 2000);
    await updateConversationHistory(storage, (current) => [convB, ...current]);

    resetChatSessionStateForTests();
    chatSessionStateForTests.savedConversations = [oldConv as any];
    applyContextToMain(
      { bvid: "BVA", cid: "101", title: "视频 A", url: "https://www.bilibili.com/video/BVA/", isVideoContext: true },
      "video:BVA|101"
    );
    applyConversationIdentity({
      id: "conv-a",
      meta: {
        id: "conv-a",
        title: "视频 A",
        createdAt: 3000,
        updatedAt: 3000,
        contextKey: "video:BVA|101",
        contextTitle: "视频 A",
        contextUrl: "https://www.bilibili.com/video/BVA/",
        isVideoContext: true,
        pinnedContext: true,
        contextRef: { bvid: "BVA", cid: "101", url: "https://www.bilibili.com/video/BVA/" }
      },
      history: [
        { role: "user", content: "总结A" },
        { role: "assistant", content: "A的总结" }
      ]
    });

    await storeA.persistCurrent();

    const { resolveActiveSubtitleStore } = await import("../../extension/subtitle/store-client.js");
    const storedIds = (await resolveActiveSubtitleStore().listConversations()).map((c) => c.id);
    expect(storedIds).toEqual(["conv-a", "conv-b", "conv-0"]);
    await storeA.loadAll();
    expect(chatSessionState.savedConversations.map((c) => c.id)).toEqual(["conv-a", "conv-b", "conv-0"]);
  });

  it("分页补水落盘只替换目标条目，保留期间其他标签页写入的新会话", async () => {
    const storage = makeSharedStorage();
    const convA = makeStoredConversation("conv-a", "BVA", "101", 1000);
    await storage.set({ [CONVERSATIONS_STORAGE_KEY]: [convA] });

    const { store: storeA } = makeStore(storage, {
      resolveAiConversationRef: vi.fn(async () => ({
        pageIndex: 2,
        url: "https://www.bilibili.com/video/BVA/?p=2",
        cid: "101",
        pageTitle: "第二P"
      }))
    });
    await storeA.loadAll();

    const convB = makeStoredConversation("conv-b", "BVB", "202", 2000);
    await updateConversationHistory(storage, (current) => [convB, ...current]);
    chatSessionStateForTests.savedConversations = [convA as any];
    chatSessionStateForTests.liveContextData = { bvid: "BVA", cid: "101", url: "https://www.bilibili.com/video/BVA/", isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "video:BVA|101";

    await expect(storeA.restoreLatest()).resolves.toBe(true);

    const { resolveActiveSubtitleStore } = await import("../../extension/subtitle/store-client.js");
    const stored = (await resolveActiveSubtitleStore().listConversations()) as unknown as Array<{ id: string; title: string }>;
    expect(stored.map((c) => c.id)).toEqual(["conv-b", "conv-a"]);
    expect(stored.find((c) => c.id === "conv-a")?.title).toContain("-P2");
  });

  it("syncSavedConversationsFromStorage 对新外部快照返回 true 并更新内存，等价快照幂等返回 false", () => {
    const conv0 = makeStoredConversation("conv-0", "BV0", "1", 1000);
    const convB = makeStoredConversation("conv-b", "BVB", "202", 2000);

    expect(syncSavedConversationsFromStorage([conv0])).toBe(true);
    expect(chatSessionState.savedConversations.map((c) => c.id)).toEqual(["conv-0"]);

    expect(syncSavedConversationsFromStorage([conv0])).toBe(false);

    expect(syncSavedConversationsFromStorage([convB, conv0])).toBe(true);
    expect(chatSessionState.savedConversations.map((c) => c.id)).toEqual(["conv-b", "conv-0"]);
  });

  it("已移除网页源 navigator.locks，写入由后台单写者队列串行化且不调用 Web Lock", async () => {
    const storage = makeSharedStorage();
    const requestLock = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal("chrome", {
      storage: { local: storage }
    });
    vi.stubGlobal("navigator", {
      locks: { request: requestLock }
    });

    const conv = makeStoredConversation("conv-lock", "BVL", "1", 1000);
    await updateConversationHistory(storage, () => [conv as any]);

    const { resolveActiveSubtitleStore } = await import("../../extension/subtitle/store-client.js");
    expect(requestLock).not.toHaveBeenCalled();
    expect((await resolveActiveSubtitleStore().listConversations()).map((c) => c.id)).toEqual(["conv-lock"]);
  });
});
