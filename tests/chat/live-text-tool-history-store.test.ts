import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyConversationIdentity,
  chatSessionState,
  chatSessionStateForTests,
  resetChatSessionStateForTests
} from "../../extension/chat/chat-state.js";
import {
  createConversationStore,
  type CreateConversationStoreDeps,
  type StorageArea
} from "../../extension/chat/conversation-store.js";
import { isLiveTextToolHistoryEntry } from "../../extension/live/live-text-tool-history.js";
import { persistLiveTextToolRecord } from "../../extension/live/live-text-tool-history-storage.js";
import type { LiveTextToolRecord } from "../../extension/live/live-text-tool-records.js";

const KEY = "biliscript_ai_conversations_v1";
const URL = "https://www.bilibili.com/video/BV1test000000/";
const VIDEO = {
  bvid: "BV1test000000",
  cid: "123",
  pageIndex: 1,
  title: "测试视频",
  url: URL
};

function makeStorage(firstGet?: Promise<void>) {
  const data = new Map<string, unknown>();
  let gets = 0;
  return {
    data,
    get: vi.fn(async (keys: string[]) => {
      gets += 1;
      if (gets === 1 && firstGet) await firstGet;
      return Object.fromEntries(keys.filter((key) => data.has(key)).map((key) => [key, data.get(key)]));
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    })
  };
}

function makeRecord(overrides: Partial<LiveTextToolRecord> = {}): LiveTextToolRecord {
  return {
    callId: "call-1",
    source: "moss",
    status: "completed",
    objective: "总结全片",
    summary: "摘要",
    markdown: "# 全文",
    startedAt: 100,
    endedAt: 200,
    video: { ...VIDEO },
    ...overrides
  };
}

function makeStore(storage: StorageArea) {
  const deps: CreateConversationStoreDeps = {
    loadContextState: vi.fn(async () => true),
    resolveAiConversationRef: vi.fn(async () => ({})),
    onConversationChanged: vi.fn(),
    onStreamInterrupted: vi.fn(),
    onContextNotice: vi.fn(),
    storage,
    isCleanEnabled: () => false,
    confirmClearAll: () => true
  };
  return { store: createConversationStore(deps), deps };
}

function seedCurrentConversation() {
  chatSessionStateForTests.contextData = { ...VIDEO, isVideoContext: true };
  chatSessionStateForTests.currentContextKey = `video:${VIDEO.bvid}|${VIDEO.cid}`;
  applyConversationIdentity({
    history: [
      { role: "user", content: "普通问题" },
      { role: "assistant", content: "普通回答" }
    ]
  });
}

function stored(storage: ReturnType<typeof makeStorage>) {
  return (storage.data.get(KEY) || []) as Array<Record<string, unknown>>;
}

beforeEach(() => {
  resetChatSessionStateForTests();
  document.body.innerHTML = "";
});

describe("伴看记录与普通会话共享历史事务", () => {
  it("无面板时也能落盘，刷新只恢复普通对话，单删与清空均无残留", async () => {
    const storage = makeStorage();
    const { store, deps } = makeStore(storage);
    seedCurrentConversation();
    await store.persistCurrent();
    const currentId = chatSessionState.currentConversationId;
    const currentHistory = chatSessionState.chatHistory;
    vi.mocked(deps.onConversationChanged).mockClear();

    await persistLiveTextToolRecord(makeRecord(), storage);

    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(chatSessionState.currentConversationId).toBe(currentId);
    expect(chatSessionState.chatHistory).toEqual(currentHistory);
    expect(stored(storage)).toHaveLength(2);

    const reopened = makeStore(storage);
    await reopened.store.loadAll();
    expect(chatSessionState.savedConversations).toHaveLength(2);
    chatSessionStateForTests.liveContextData = { ...VIDEO, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = `video:${VIDEO.bvid}|${VIDEO.cid}`;
    await expect(reopened.store.restoreLatest()).resolves.toBe(true);
    expect(chatSessionState.currentConversationId).toBe(currentId);
    expect(chatSessionState.chatHistory).toEqual(currentHistory);

    const liveEntry = chatSessionState.savedConversations.find(isLiveTextToolHistoryEntry);
    expect(liveEntry).toBeDefined();
    reopened.store.applyById(liveEntry!.id);
    expect(chatSessionState.currentConversationId).toBe(currentId);
    expect(chatSessionState.chatHistory).toEqual(currentHistory);

    await reopened.store.deleteById(liveEntry!.id);
    expect(stored(storage)).toHaveLength(1);
    expect(chatSessionState.currentConversationId).toBe(currentId);
    expect(reopened.deps.onStreamInterrupted).not.toHaveBeenCalled();

    await persistLiveTextToolRecord(makeRecord(), storage);
    await reopened.store.loadAll();
    await reopened.store.clearAll();
    expect(stored(storage)).toEqual([]);
    expect(chatSessionState.savedConversations).toEqual([]);
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it.each(["normal-first", "live-first"])("%s：并发写不覆盖另一类别", async (order) => {
    let releaseFirstGet!: () => void;
    const firstGet = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const storage = makeStorage(firstGet);
    const { store } = makeStore(storage);
    seedCurrentConversation();

    const normalWrite = () => store.persistCurrent();
    const liveWrite = () => persistLiveTextToolRecord(makeRecord(), storage);
    const first = order === "normal-first" ? normalWrite() : liveWrite();
    const second = order === "normal-first" ? liveWrite() : normalWrite();
    releaseFirstGet();
    await Promise.all([first, second]);

    const entries = stored(storage);
    expect(entries).toHaveLength(2);
    expect(entries.some((entry) => entry.kind === "live-text-tool")).toBe(true);
    expect(entries.some((entry) => entry.kind !== "live-text-tool")).toBe(true);
    expect(chatSessionState.savedConversations).toHaveLength(2);
  });
});
