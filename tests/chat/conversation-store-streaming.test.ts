// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";
import type { Conversation, CreateConversationStoreDeps, StorageArea } from "../../extension/chat/conversation-store.js";
import type { ChatPortMessage, CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../../extension/chat/protocol.js";

type MockFn = Mock<(...args: any[]) => any>;

interface TestRuntimeDeps extends CreateChatRuntimeDeps {
  store: { persistCurrent: MockFn; isCurrent: MockFn };
  ui: {
    setStreamingUiState: MockFn;
    showConversationContextNotice: MockFn;
    removeConversationContextNotice: MockFn;
    hideHistoryPopover: MockFn;
    removeCenteredState: MockFn;
    removeSuggestions: MockFn;
    showSetupBlockedState: MockFn;
    autosizeInput: MockFn;
  };
  ensureCurrentContextForSend: MockFn;
  connectPort: MockFn;
}

let createConversationStore: typeof import("../../extension/chat/conversation-store.js").createConversationStore;
let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: ChatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

const URL_A = "https://www.bilibili.com/video/BV1abc";

type SavedConversation = Conversation & Record<string, unknown>;

function makeConversation(
  id: string,
  {
    contextKey = "",
    url = URL_A,
    messages
  }: { contextKey?: string; url?: string; messages?: Conversation["messages"] } = {}
): SavedConversation {
  return {
    id,
    title: `对话${id}`,
    contextKey,
    contextTitle: "视频A",
    contextUrl: url,
    isVideoContext: true,
    createdAt: 1000,
    updatedAt: 1000,
    contextRef: { bvid: "BV1abc", cid: "1", url },
    messages: messages || [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  };
}

function makeStorage(): StorageArea {
  const data = new Map<string, unknown>();
  return {
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

function makeStoreStubs() {
  return {
    loadContextState: vi.fn(async () => true),
    resolveAiConversationRef: vi.fn(async () => ({})),
    onConversationChanged: vi.fn(),
    onStreamInterrupted: vi.fn(),
    onContextNotice: vi.fn()
  };
}

function makeStreamHarness(storeDepsOverrides: Partial<CreateConversationStoreDeps> = {}) {
  const stream = { active: false, userPrompt: "", raw: "", capturedId: "" };
  const stopCalls: boolean[] = [];
  const persistCalls: boolean[] = [];
  const storage = makeStorage();
  const ui = makeStoreStubs();
  const store = createConversationStore({
    ...ui,
    onStreamInterrupted: vi.fn(() => {
      stopCalls.push(true);
      stream.active = false;
      stream.userPrompt = "";
    }),
    storage,
    ...storeDepsOverrides
  });

  function startStream(userPrompt: string, raw = "回答中") {
    stream.active = true;
    stream.userPrompt = userPrompt;
    stream.raw = raw;
    stream.capturedId = chatSessionState.currentConversationId;
  }

  async function simulateStreamEnd() {
    if (!stream.active || !stream.userPrompt) {
      return;
    }
    if (chatSessionState.currentConversationId === stream.capturedId) {
      chatSessionState.chatHistory.push({ role: "user", content: stream.userPrompt });
      chatSessionState.chatHistory.push({ role: "assistant", content: stream.raw });
      await store.persistCurrent();
      persistCalls.push(true);
    }
  }

  return { store, ui, storage, stream, stopCalls, persistCalls, startStream, simulateStreamEnd };
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createConversationStore } = await import("../../extension/chat/conversation-store.js"));
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({
    chatSessionState,
    chatSessionStateForTests,
    applyConversationIdentity,
    setSavedConversations,
    resetChatSessionStateForTests
  } = await import("../../extension/chat/chat-state.js"));
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("conversation-store reset 路径在流式中的停流", () => {
  it("deleteById 当前会话（流式中）：先同步停流，状态清空，流结束不复活", async () => {
    const h = makeStreamHarness();
    setSavedConversations([makeConversation("c1")]);
    h.store.applyById("c1");
    expect(chatSessionState.currentConversationId).toBe("c1");
    h.startStream("在途问题");

    await h.store.deleteById("c1");

    expect(h.stopCalls.length).toBe(1);
    expect(h.stream.active).toBe(false);
    expect(h.stream.userPrompt).toBe("");
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(chatSessionState.savedConversations).toEqual([]);

    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(0);
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("deleteById 当前会话（非流式中）：回调幂等空操作，状态照常清空", async () => {
    const h = makeStreamHarness();
    setSavedConversations([makeConversation("c1")]);
    h.store.applyById("c1");

    await h.store.deleteById("c1");

    expect(h.stopCalls.length).toBe(1);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("deleteById 非当前会话（流式中）：不停流，原流式行为保留", async () => {
    const h = makeStreamHarness();
    setSavedConversations([makeConversation("c1"), makeConversation("c2")]);
    h.store.applyById("c1");
    h.startStream("在途问题");

    await h.store.deleteById("c2");

    expect(h.stopCalls.length).toBe(0);
    expect(chatSessionState.currentConversationId).toBe("c1");
    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(1);
    expect(chatSessionState.chatHistory.length).toBe(4);
  });

  it("clearAll（流式中）：先同步停流再清空，流结束不复活", async () => {
    const h = makeStreamHarness({ confirmClearAll: () => true });
    setSavedConversations([makeConversation("c1")]);
    h.store.applyById("c1");
    h.startStream("在途问题");

    await h.store.clearAll();

    expect(h.stopCalls.length).toBe(1);
    expect(h.stream.active).toBe(false);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);

    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(0);
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("clearAll（非流式中）：回调幂等空操作，状态照常清空", async () => {
    const h = makeStreamHarness({ confirmClearAll: () => true });
    setSavedConversations([makeConversation("c1")]);
    h.store.applyById("c1");

    await h.store.clearAll();

    expect(h.stopCalls.length).toBe(1);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("clearAll 无会话时早退：不停流（confirm 也不弹）", async () => {
    const confirmClearAll = vi.fn(() => true);
    const h = makeStreamHarness({ confirmClearAll });

    await h.store.clearAll();

    expect(h.stopCalls.length).toBe(0);
    expect(confirmClearAll).not.toHaveBeenCalled();
  });

  it("restoreLatest 无匹配（非流式中）：停流回调幂等，当前会话状态清空", async () => {
    const h = makeStreamHarness();
    setSavedConversations([makeConversation("c1", { url: "https://www.bilibili.com/video/BVother" })]);
    applyConversationIdentity({ id: "c1" });
    applyConversationIdentity({ meta: { id: "c1", pinnedContext: true, contextKey: "" } });
    applyConversationIdentity({ history: makeConversation("c1").messages });

    const result = await h.store.restoreLatest();

    expect(result).toBe(false);
    expect(h.stopCalls.length).toBe(1);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("restoreLatest 无匹配（防御性流式中）：同样先停流，流结束不复活", async () => {
    const h = makeStreamHarness();
    setSavedConversations([makeConversation("c1", { url: "https://www.bilibili.com/video/BVother" })]);
    applyConversationIdentity({ id: "c1" });
    applyConversationIdentity({ meta: { id: "c1", pinnedContext: true, contextKey: "" } });
    applyConversationIdentity({ history: makeConversation("c1").messages });
    h.startStream("在途问题");

    const result = await h.store.restoreLatest();

    expect(result).toBe(false);
    expect(h.stopCalls.length).toBe(1);
    expect(h.stream.active).toBe(false);
    await h.simulateStreamEnd();
    expect(h.persistCalls.length).toBe(0);
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("detachForRestart / restoreLatest 携带 preserveStream 时显式透传给 onStreamInterrupted", async () => {
    const onStreamInterrupted = vi.fn();
    const h = makeStreamHarness({ onStreamInterrupted });

    h.store.detachForRestart({ preserveStream: true });
    expect(onStreamInterrupted).toHaveBeenLastCalledWith({ preserveStream: true });

    await h.store.restoreLatest({ preserveStream: true });
    expect(onStreamInterrupted).toHaveBeenLastCalledWith({ preserveStream: true });

    h.store.detachForRestart();
    expect(onStreamInterrupted).toHaveBeenLastCalledWith(undefined);
  });

  it("restoreLatest 有匹配：照常 apply，不停流", async () => {
    const h = makeStreamHarness();
    setSavedConversations([makeConversation("c1")]);
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };

    const result = await h.store.restoreLatest();

    expect(result).toBe(true);
    expect(h.stopCalls.length).toBe(0);
    expect(chatSessionState.currentConversationId).toBe("c1");
    expect(chatSessionState.chatHistory.length).toBe(2);
  });
});

describe("store.isCurrent 会话身份守卫", () => {
  it("当前会话命中：id 与 currentConversationId 相等 → true", async () => {
    const { store } = makeStreamHarness();
    applyConversationIdentity({ id: "c1" });

    expect(store.isCurrent("c1")).toBe(true);
  });

  it("非当前：id 不等（切换/恢复了另一会话）或当前已删（空串）→ false", async () => {
    const { store } = makeStreamHarness();
    applyConversationIdentity({ id: "c1" });

    expect(store.isCurrent("c2")).toBe(false);

    applyConversationIdentity({ id: "" });
    expect(store.isCurrent("c1")).toBe(false);
  });

  it("空 id：仅当当前 id 同为空串（新会话首发）→ true，否则 false", async () => {
    const { store } = makeStreamHarness();

    applyConversationIdentity({ id: "" });
    expect(store.isCurrent("")).toBe(true);

    applyConversationIdentity({ id: "c1" });
    expect(store.isCurrent("")).toBe(false);
  });
});

describe("chat-runtime 流结束的会话身份校验", () => {
  function makeSendHarness() {
    const messages = document.createElement("div");
    const input = document.createElement("textarea");
    const listeners: ((msg: ChatPortMessage) => void)[] = [];
    const port = {
      name: OFFSCREEN_CHAT_PORT_NAME,
      onMessage: { addListener: (fn: (msg: ChatPortMessage) => void) => listeners.push(fn) },
      onDisconnect: { addListener: () => {} },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    };
    const deps: TestRuntimeDeps = {
      messages,
      input,
      store: {
        persistCurrent: vi.fn(async () => {}),
        isCurrent: vi.fn((id: string) => id === chatSessionState.currentConversationId)
      },
      ui: {
        setStreamingUiState: vi.fn(),
        showConversationContextNotice: vi.fn(),
        removeConversationContextNotice: vi.fn(),
        hideHistoryPopover: vi.fn(),
        removeCenteredState: vi.fn(),
        removeSuggestions: vi.fn(),
        showSetupBlockedState: vi.fn(),
        autosizeInput: vi.fn()
      },
      ensureCurrentContextForSend: vi.fn(async () => ({ pass: true }) as const),
      getProviderId: () => "test-provider",
      getSelectedModel: () => "test-model",
      getTimestampNavDeps: () => ({}),
      connectPort: vi.fn(async () => port)
    };
    input.value = "在途问题";
    const runtime = createChatRuntime(deps);
    return { deps, runtime, emit: (msg: ChatPortMessage) => listeners[0](msg) };
  }

  it("finalize：发送后当前会话已删（id 已变）→ 只渲染 DOM，不 push 不 persist", async () => {
    applyConversationIdentity({ id: "c1" });
    applyConversationIdentity({ meta: { id: "c1", pinnedContext: true, contextKey: "k1" } });
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendTurn(deps.input.value);
    expect(deps.connectPort).toHaveBeenCalledTimes(1);

    applyConversationIdentity({ id: "" });
    applyConversationIdentity({ meta: null });

    emit({ type: "token", data: "回答" });
    emit({ type: "done" });

    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(chatSessionState.chatHistory).toEqual([]);
    const node = deps.messages.querySelector(".chat-msg-assistant");
    expect(node?.querySelector(".chat-msg-assistant-body")).toBeTruthy();
  });

  it("stopped：发送后当前会话已删 → 同样不 push 不 persist", async () => {
    applyConversationIdentity({ id: "c1" });
    applyConversationIdentity({ meta: { id: "c1", pinnedContext: true, contextKey: "k1" } });
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendTurn(deps.input.value);
    applyConversationIdentity({ id: "" });
    applyConversationIdentity({ meta: null });

    emit({ type: "token", data: "半截回答" });
    emit({ type: "stopped", reason: "已停止生成" });

    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("身份未变（新会话发送，id 均为空串）→ 照常写回并 persist（回归保护）", async () => {
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendTurn(deps.input.value);
    emit({ type: "token", data: "回答" });
    emit({ type: "done" });

    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    expect(chatSessionState.chatHistory.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chatSessionState.chatHistory[1].content).toBe("回答");
  });

  it("流式中切换到另一会话（applyById 改 id）→ finalize 不把回答串进新会话", async () => {
    applyConversationIdentity({ id: "c1" });
    applyConversationIdentity({ meta: { id: "c1", pinnedContext: true, contextKey: "k1" } });
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };
    const { deps, runtime, emit } = makeSendHarness();

    await runtime.sendTurn(deps.input.value);

    applyConversationIdentity({ id: "c2" });
    applyConversationIdentity({ history: makeConversation("c2").messages });

    emit({ type: "token", data: "回答" });
    emit({ type: "done" });

    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(chatSessionState.chatHistory).toEqual(makeConversation("c2").messages);
  });
});
