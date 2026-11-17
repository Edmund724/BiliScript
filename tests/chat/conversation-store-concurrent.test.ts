// tests/chat/conversation-store-concurrent.test.ts
// 跨标签页并发会话持久化与外部同步回归测试：
// 1. 标签页 A 内存存档滞后时，persistCurrent() 增量合入最新存储快照，不抹除标签页 B 先写入的新会话；
// 2. 分页补水（restoreLatest → saveHydratedConversation）同样保留期间其他标签页写入的新会话；
// 3. syncSavedConversationsFromStorage 仅在外部快照真正变化时更新内存并返回 true，等价快照幂等返回 false；
// 4. 目标存储为真实 chrome.storage.local 且环境具备 navigator.locks 时，经同源 Web Lock 串行化。

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
    isCleanEnabled: () => false,
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

    // 模拟标签页 B 在独立页内完成一次对话并率先落盘 conv-b
    const convB = makeStoredConversation("conv-b", "BVB", "202", 2000);
    await updateConversationHistory(storage, (current) => [convB, ...current]);

    // 标签页 A 内存中仍只有 [conv-0]（尚未感知 conv-b），此时完成总结并 persistCurrent
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

    const storedIds = (storage.data.get(CONVERSATIONS_STORAGE_KEY) as Array<{ id: string }>).map((c) => c.id);
    expect(storedIds).toEqual(["conv-a", "conv-b", "conv-0"]);
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

    // 外部标签页在 restoreLatest 之前写入 conv-b
    const convB = makeStoredConversation("conv-b", "BVB", "202", 2000);
    await updateConversationHistory(storage, (current) => [convB, ...current]);
    // 还原标签页 A 的陈旧内存视图（模拟 A 尚未收到外部事件时就执行了 restoreLatest）
    chatSessionStateForTests.savedConversations = [convA as any];
    chatSessionStateForTests.liveContextData = { bvid: "BVA", cid: "101", url: "https://www.bilibili.com/video/BVA/", isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "video:BVA|101";

    await expect(storeA.restoreLatest()).resolves.toBe(true);

    const stored = storage.data.get(CONVERSATIONS_STORAGE_KEY) as Array<{ id: string; title: string }>;
    expect(stored.map((c) => c.id)).toEqual(["conv-b", "conv-a"]);
    expect(stored.find((c) => c.id === "conv-a")?.title).toContain("-P2");
  });

  it("syncSavedConversationsFromStorage 对新外部快照返回 true 并更新内存，等价快照幂等返回 false", () => {
    const conv0 = makeStoredConversation("conv-0", "BV0", "1", 1000);
    const convB = makeStoredConversation("conv-b", "BVB", "202", 2000);

    expect(syncSavedConversationsFromStorage([conv0])).toBe(true);
    expect(chatSessionState.savedConversations.map((c) => c.id)).toEqual(["conv-0"]);

    // 等价快照（本页自写回声场景）：返回 false
    expect(syncSavedConversationsFromStorage([conv0])).toBe(false);

    // 外部写入新增 convB：返回 true 且内存同步更新
    expect(syncSavedConversationsFromStorage([convB, conv0])).toBe(true);
    expect(chatSessionState.savedConversations.map((c) => c.id)).toEqual(["conv-b", "conv-0"]);
  });

  it("目标为真实 chrome.storage.local 且具备 navigator.locks 时经同源 Web Lock 串行化", async () => {
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

    expect(requestLock).toHaveBeenCalledTimes(1);
    expect(requestLock).toHaveBeenCalledWith(CONVERSATIONS_STORAGE_KEY, expect.any(Function));
    expect((storage.data.get(CONVERSATIONS_STORAGE_KEY) as Array<{ id: string }>).map((c) => c.id)).toEqual(["conv-lock"]);
  });
});
