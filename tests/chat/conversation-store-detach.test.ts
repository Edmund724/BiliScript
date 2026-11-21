import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import type {
  ConversationStore,
  CreateConversationStoreDeps
} from "../../extension/chat/conversation-store.js";

let createConversationStore: typeof import("../../extension/chat/conversation-store.js").createConversationStore;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

const URL_A = "https://www.bilibili.com/video/BV1abc";

interface ConversationOverrides {
  contextKey?: string;
  url?: string;
}

function makeConversation(id: string, { contextKey = "", url = URL_A }: ConversationOverrides = {}) {
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
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  };
}

function makeStorage() {
  const data = new Map<string, unknown>();
  return {
    data,
    get: vi.fn<(keys: string[]) => Promise<Record<string, unknown>>>(async (keys) =>
      Object.fromEntries(keys.filter((k) => data.has(k)).map((k) => [k, data.get(k)]))
    ),
    set: vi.fn<(items: Record<string, unknown>) => Promise<void>>(async (obj) => {
      for (const [k, v] of Object.entries(obj)) {
        data.set(k, v);
      }
    })
  };
}

interface StoreDeps {
  loadContextState: Mock<CreateConversationStoreDeps["loadContextState"]>;
  resolveAiConversationRef: Mock<CreateConversationStoreDeps["resolveAiConversationRef"]>;
  onConversationChanged: Mock<CreateConversationStoreDeps["onConversationChanged"]>;
  onStreamInterrupted: Mock<CreateConversationStoreDeps["onStreamInterrupted"]>;
  onContextNotice: Mock<CreateConversationStoreDeps["onContextNotice"]>;
  storage: ReturnType<typeof makeStorage>;
  confirmClearAll?: (message: string) => boolean | Promise<boolean>;
}

function makeHarness(storeDepsOverrides: Partial<StoreDeps> = {}) {
  const storage = makeStorage();
  const deps: StoreDeps = {
    loadContextState: vi.fn<CreateConversationStoreDeps["loadContextState"]>(async () => true),
    resolveAiConversationRef: vi.fn<CreateConversationStoreDeps["resolveAiConversationRef"]>(async () => ({})),
    onConversationChanged: vi.fn<CreateConversationStoreDeps["onConversationChanged"]>(),
    onStreamInterrupted: vi.fn<CreateConversationStoreDeps["onStreamInterrupted"]>(),
    onContextNotice: vi.fn<CreateConversationStoreDeps["onContextNotice"]>(),
    storage,
    ...storeDepsOverrides
  };
  const store = createConversationStore(deps);
  return { store, deps, storage };
}

interface InterruptedSnapshot {
  id: string;
  meta: unknown;
  history: unknown[];
  savedCount: number;
}

function makeOrderLog(deps: StoreDeps, storage: ReturnType<typeof makeStorage>) {
  const log: unknown[][] = [];
  const interruptedWith: InterruptedSnapshot[] = [];
  deps.onConversationChanged.mockImplementation((change) => log.push(["change", change]));
  deps.onStreamInterrupted.mockImplementation(() => {
    interruptedWith.push({
      id: chatSessionState.currentConversationId,
      meta: chatSessionState.currentConversationMeta,
      history: chatSessionState.chatHistory,
      savedCount: chatSessionState.savedConversations.length
    });
    log.push(["interrupt"]);
  });
  deps.onContextNotice.mockImplementation((notice) => log.push(["notice", notice]));
  storage.set.mockImplementation(async (obj) => {
    log.push(["persist", Object.keys(obj)]);
    for (const [k, v] of Object.entries(obj)) {
      storage.data.set(k, v);
    }
  });
  return { log, interruptedWith };
}

function seedCurrentConversation(id = "c1", overrides: ConversationOverrides = {}) {
  setSavedConversations([makeConversation(id, overrides)]);
  applyConversationIdentity({
    id,
    meta: {
      id,
      title: `对话${id}`,
      pinnedContext: true,
      contextKey: overrides.contextKey || "",
      contextRef: null,
      resolvedContext: null
    },
    history: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" }
    ]
  });
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createConversationStore } = await import("../../extension/chat/conversation-store.js"));
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

const DETACH_EXITS = [
  {
    label: "restoreLatest 无匹配",
    setup() {
      seedCurrentConversation("c1", { url: "https://www.bilibili.com/video/BVother" });
    },
    run(store: ConversationStore) {
      return store.restoreLatest();
    },
    persisted: false
  },
  {
    label: "deleteById 当前会话",
    setup() {
      seedCurrentConversation("c1");
    },
    run(store: ConversationStore) {
      return store.deleteById("c1");
    },
    persisted: true
  },
  {
    label: "clearAll",
    storeDeps: { confirmClearAll: () => true },
    setup() {
      seedCurrentConversation("c1");
    },
    run(store: ConversationStore) {
      return store.clearAll();
    },
    persisted: true
  },
  {
    label: "detachForRestart(新会话重启)",
    setup() {
      seedCurrentConversation("c1");
    },
    run(store: ConversationStore) {
      return store.detachForRestart();
    },
    persisted: false
  }
];

describe("拆除会话四出口的承重不变式", () => {
  it.each(DETACH_EXITS)("$label:断流恰一次且先于身份清空(发起瞬间 id 仍在);收尾 id/meta/历史清空", async ({ setup, run, storeDeps }) => {
    const { store, deps, storage } = makeHarness(storeDeps);
    const { interruptedWith } = makeOrderLog(deps, storage);
    setup();

    await run(store);

    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    expect(interruptedWith[0].id).toBe("c1");
    expect(interruptedWith[0].meta).not.toBeNull();
    expect(interruptedWith[0].history.length).toBe(2);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it.each(DETACH_EXITS)("$label:断流先于落盘(落盘出口)或不落盘(无落盘出口)", async ({ setup, run, persisted, storeDeps }) => {
    const { store, deps, storage } = makeHarness(storeDeps);
    const { log } = makeOrderLog(deps, storage);
    setup();

    await run(store);

    if (persisted) {
      const interruptIndex = log.findIndex(([kind]) => kind === "interrupt");
      const persistIndex = log.findIndex(([kind]) => kind === "persist");
      expect(persistIndex).toBeGreaterThan(-1);
      expect(interruptIndex).toBeLessThan(persistIndex);
    } else {
      expect(log.some(([kind]) => kind === "persist")).toBe(false);
    }
  });
});

describe("出口一 restoreLatest 无匹配", () => {
  it("断流+清身份后返回 false;live 快照不回填,change/notice/persist 零次", async () => {
    const { store, deps, storage } = makeHarness();
    const { log } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1", { url: "https://www.bilibili.com/video/BVother" });
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-live";

    const result = await store.restoreLatest();

    expect(result).toBe(false);
    expect(chatSessionState.contextData).toBeNull();
    expect(chatSessionState.currentContextKey).toBe("");
    expect(log).toEqual([["interrupt"]]);
  });
});

describe("出口二 deleteById 当前会话", () => {
  it("事件次序 = [interrupt, persist, change {}, change {resetView}];live 回填发生", async () => {
    const { store, deps, storage } = makeHarness();
    const { log } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");
    const liveData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionStateForTests.liveContextData = liveData;
    chatSessionStateForTests.liveContextKey = "k-live";

    await store.deleteById("c1");

    expect(log).toEqual([
      ["interrupt"],
      ["persist", ["biliscript_ai_conversations_v1"]],
      ["change", {}],
      ["change", { resetView: true }]
    ]);
    expect(chatSessionState.contextData).toEqual(liveData);
    expect(chatSessionState.contextData).not.toBe(liveData);
    expect(chatSessionState.currentContextKey).toBe("k-live");
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("组合次序:detach(断流+清键)先于 commitSaved+save(detach 瞬间存档尚未重写)", async () => {
    const { store, deps, storage } = makeHarness();
    const { interruptedWith } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");

    await store.deleteById("c1");

    expect(interruptedWith[0].savedCount).toBe(1);
    expect(chatSessionState.savedConversations).toEqual([]);
  });
});

describe("出口三 clearAll", () => {
  it("事件次序 = [interrupt, persist, change {}, change {historyCleared, resetView}];detach 瞬间存档已清(commitSaved([]) 在 detach 前)", async () => {
    const { store, deps, storage } = makeHarness({ confirmClearAll: () => true });
    const { log, interruptedWith } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");
    const liveData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionStateForTests.liveContextData = liveData;
    chatSessionStateForTests.liveContextKey = "k-live";

    await store.clearAll();

    expect(log).toEqual([
      ["interrupt"],
      ["persist", ["biliscript_ai_conversations_v1"]],
      ["change", {}],
      ["change", { historyCleared: true, resetView: true }]
    ]);
    expect(interruptedWith[0].savedCount).toBe(0);
    expect(chatSessionState.contextData).toEqual(liveData);
    expect(chatSessionState.currentContextKey).toBe("k-live");
  });
});

describe("出口四 detachForRestart(新会话重启)", () => {
  it("断流一次+身份清空;live 不回填;零 change/notice/persist(视图重建由 restartChat 自排)", () => {
    const { store, deps, storage } = makeHarness();
    const { log } = makeOrderLog(deps, storage);
    seedCurrentConversation("c1");
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-live";

    store.detachForRestart();

    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(chatSessionState.contextData).toBeNull();
    expect(log).toEqual([["interrupt"]]);
  });
});

describe("公开接口面", () => {
  it("返回面 = 收窄 8 键 + detachForRestart;apply/resolveContext/hydratePages 三键不再外露", () => {
    const { store } = makeHarness();

    expect(Object.keys(store).sort()).toEqual([
      "applyById",
      "clearAll",
      "deleteById",
      "detachForRestart",
      "hydratePinned",
      "isCurrent",
      "loadAll",
      "persistCurrent",
      "restoreLatest"
    ]);
    const exposed = store as unknown as Record<string, unknown>;
    expect(exposed.apply).toBeUndefined();
    expect(exposed.resolveContext).toBeUndefined();
    expect(exposed.hydratePages).toBeUndefined();
  });

  it("内部 apply 经 applyById 存活:身份/历史/事件面照常", () => {
    const { store, deps } = makeHarness();
    setSavedConversations([makeConversation("c1")]);

    store.applyById("c1");

    expect(chatSessionState.currentConversationId).toBe("c1");
    expect(chatSessionState.currentConversationMeta!.pinnedContext).toBe(true);
    expect(chatSessionState.chatHistory.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ resetView: true });
  });

  it("内部 resolveContext 经 hydratePinned 网络路径存活:purpose=context 解析成功落回", async () => {
    const { store } = makeHarness({
      resolveAiConversationRef: vi.fn(async (_ref, purpose) => {
        expect(purpose).toBe("context");
        return { bvid: "BV1abc", cid: "1", url: URL_A, title: "视频A", isVideoContext: true };
      })
    });
    applyConversationIdentity({
      meta: {
        id: "conv-1",
        title: "视频A",
        createdAt: 1,
        updatedAt: 1,
        contextKey: "k-1",
        contextTitle: "视频A",
        contextUrl: URL_A,
        isVideoContext: true,
        pinnedContext: true,
        contextRef: { bvid: "BV1abc", cid: "1", url: URL_A },
        resolvedContext: null
      }
    });

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(chatSessionState.currentContextKey).toBe("k-1");
  });

  it("分页补水收敛到 restoreLatest 命中项:loadAll 零请求,命中项一条(purpose=page),变更追加 save 的 {} 与 apply 的 {}", async () => {
    const { store, deps, storage } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => ({ pageIndex: 2, url: `${URL_A}?p=2`, cid: "2", pageTitle: "第二P" }))
    });
    await storage.set({ biliscript_ai_conversations_v1: [makeConversation("c1")] });
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-1";

    await store.loadAll();
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    await store.restoreLatest();

    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(2, {});
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(3, {});
    expect(deps.resolveAiConversationRef).toHaveBeenCalledTimes(1);
  });
});
