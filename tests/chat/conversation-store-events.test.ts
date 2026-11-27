// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import type { CreateConversationStoreDeps } from "../../extension/chat/conversation-store.js";

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
  pageIndex?: number;
}

function makeConversation(id: string, { contextKey = "", url = URL_A, pageIndex }: ConversationOverrides = {}) {
  return {
    id,
    title: `对话${id}`,
    contextKey,
    contextTitle: "视频A",
    contextUrl: url,
    isVideoContext: true,
    createdAt: 1000,
    updatedAt: 1000,
    contextRef: { bvid: "BV1abc", cid: pageIndex ? String(pageIndex) : "1", url, pageIndex },
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

function makeOrderLog(deps: StoreDeps) {
  const log: unknown[][] = [];
  deps.onConversationChanged.mockImplementation((change) => log.push(["change", change]));
  deps.onStreamInterrupted.mockImplementation(() => log.push(["interrupt"]));
  deps.onContextNotice.mockImplementation((notice) => log.push(["notice", notice]));
  return log;
}

interface PinnedMetaOverrides {
  contextRef?: Record<string, unknown> | null;
  resolvedContext?: Record<string, unknown> | null;
}

function makePinnedMeta(overrides: PinnedMetaOverrides = {}) {
  return {
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
    resolvedContext: null,
    ...overrides
  };
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

describe("loadAll / 命中项补水 / persistCurrent 的 change 时序", () => {
  it("loadAll:change 恰一次且 detail 为空(无上下文写入)", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    setSavedConversations([makeConversation("c1")]);

    await store.loadAll();

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(log).toEqual([["change", {}]]);
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
  });

  it("restoreLatest 命中项分页补水:仅命中项一条请求(purpose=page),change 序列 = [{}, {}]", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn<CreateConversationStoreDeps["resolveAiConversationRef"]>(async (ref, purpose) => {
        expect(purpose).toBe("page");
        return { pageIndex: 2, url: `${URL_A}?p=2`, cid: "2", pageTitle: "第二P" };
      })
    });
    const log = makeOrderLog(deps);
    setSavedConversations([
      makeConversation("c1"),
      makeConversation("c2", { url: "https://www.bilibili.com/video/BVother" })
    ]);
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-1";

    const result = await store.restoreLatest();

    expect(result).toBe(true);
    expect(deps.resolveAiConversationRef).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(1, {});
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(2, {});
    expect(log.map(([kind]) => kind)).toEqual(["change", "change"]);
  });

  it("persistCurrent:change 恰一次且 detail 为空(元信息重写不改上下文绑定呈现)", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionStateForTests.currentContextKey = "k-1";
    applyConversationIdentity({ history: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a" }
    ] });

    await store.persistCurrent();

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });

  it("persistCurrent:消息的 images 字段随文本一起落盘（image-input 路线 B 的白名单透传）", async () => {
    const { store } = makeHarness();
    const images = [{ mime: "image/webp", data: "QUJD" }];
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionStateForTests.currentContextKey = "k-1";
    applyConversationIdentity({ history: [
      { role: "user", content: "这张图里是什么", images },
      { role: "assistant", content: "是截图" }
    ] });

    await store.persistCurrent();

    expect(chatSessionState.savedConversations[0].messages).toEqual([
      { role: "user", content: "这张图里是什么", images },
      { role: "assistant", content: "是截图" }
    ]);
  });

  it("落盘只留最近一张图；重开（loadAll + restoreLatest）后追问仍带得回那张图", async () => {
    const { store, storage } = makeHarness();
    const earlier = { mime: "image/webp", data: "QUJD" };
    const latest = { mime: "image/webp", data: "WFla" };
    chatSessionStateForTests.contextData = { bvid: "BV1abc", cid: "1", url: URL_A, title: "视频A", isVideoContext: true };
    chatSessionStateForTests.currentContextKey = "k-1";
    applyConversationIdentity({ history: [
      { role: "user", content: "第一张图", images: [earlier] },
      { role: "assistant", content: "是截图" },
      { role: "user", content: "这张呢", images: [latest] },
      { role: "assistant", content: "也是截图" }
    ] });

    await store.persistCurrent();

    const persisted = [
      { role: "user", content: "第一张图" },
      { role: "assistant", content: "是截图" },
      { role: "user", content: "这张呢", images: [latest] },
      { role: "assistant", content: "也是截图" }
    ];
    expect(chatSessionState.savedConversations[0].messages).toEqual(persisted);

    const { store: reopened } = makeHarness({ storage });
    chatSessionStateForTests.currentContextKey = "";
    chatSessionStateForTests.contextData = null;
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", cid: "1", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "video:BV1abc|1";

    await reopened.loadAll();
    const restored = await reopened.restoreLatest();

    expect(restored).toBe(true);
    expect(chatSessionState.chatHistory).toEqual(persisted);
  });
});

describe("restoreLatest / applyById 的 change 时序", () => {
  it("restoreLatest 有匹配:change 恰一次 {},无断流(命中项无需分页补水时)", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);
    const conversation = makeConversation("c1");
    conversation.title = "视频A-P1";
    setSavedConversations([conversation]);
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-1";

    const result = await store.restoreLatest();

    expect(result).toBe(true);
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });

  it("restoreLatest 无匹配:恰一次断流,change/notice 零次(原编排不重渲任何面)", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    setSavedConversations([makeConversation("c1", { url: "https://www.bilibili.com/video/BVother" })]);
    applyConversationIdentity({ id: "c1" });

    const result = await store.restoreLatest();

    expect(result).toBe(false);
    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(deps.onContextNotice).not.toHaveBeenCalled();
    expect(log).toEqual([["interrupt"]]);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("applyById(上下文键与 live 不一致):change = {resetView} → notice pending,补水解析走 purpose=context", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn<CreateConversationStoreDeps["resolveAiConversationRef"]>(async (ref, purpose) => {
        expect(purpose).toBe("context");
        return { bvid: "BV1abc", cid: "1", url: URL_A, title: "视频A", isVideoContext: true };
      })
    });
    const log = makeOrderLog(deps);
    setSavedConversations([makeConversation("c1", { contextKey: "k-other" })]);

    store.applyById("c1");

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ resetView: true });
    expect(deps.onContextNotice).toHaveBeenCalledWith({ kind: "pending", message: "正在加载原视频上下文..." });
    expect(log.map(([kind]) => kind)).toEqual(["change", "notice"]);
    await vi.waitFor(() => expect(deps.onContextNotice.mock.calls.length).toBe(2));
    expect(deps.onConversationChanged).toHaveBeenNthCalledWith(2, {});
    expect(deps.onContextNotice).toHaveBeenLastCalledWith({ kind: "clear" });
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });

  it("applyById(键与 live 一致):change = {resetView},不发 pending 也不补水", () => {
    const { store, deps } = makeHarness();
    setSavedConversations([makeConversation("c1", { contextKey: "k-1" })]);
    chatSessionStateForTests.liveContextKey = "k-1";

    store.applyById("c1");

    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({ resetView: true });
    expect(deps.onContextNotice).not.toHaveBeenCalled();
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
  });
});

describe("deleteById / clearAll 的断流与 change 时序", () => {
  it("deleteById 当前会话:onStreamInterrupted 同步先于一切 change;尾次 change = {resetView}", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    setSavedConversations([makeConversation("c1")]);
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-1";
    store.applyById("c1");
    deps.onConversationChanged.mockClear();
    log.length = 0;

    await store.deleteById("c1");

    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    expect(log[0]).toEqual(["interrupt"]);
    expect(log[log.length - 1]).toEqual(["change", { resetView: true }]);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.currentConversationMeta).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("deleteById 非当前会话:无断流,change = {}(仅存档列表面)", async () => {
    const { store, deps } = makeHarness();
    makeOrderLog(deps);
    setSavedConversations([makeConversation("c1"), makeConversation("c2")]);
    applyConversationIdentity({ id: "c1" });

    await store.deleteById("c2");

    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
    expect(deps.onConversationChanged).toHaveBeenCalledTimes(1);
    expect(deps.onConversationChanged).toHaveBeenCalledWith({});
    expect(chatSessionState.currentConversationId).toBe("c1");
  });

  it("clearAll:onStreamInterrupted 在先,尾次 change = {historyCleared, resetView}", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    document.body.innerHTML = '<div id="biliscript-reading-view"></div>';
    setSavedConversations([makeConversation("c1")]);
    chatSessionStateForTests.liveContextData = { bvid: "BV1abc", url: URL_A, isVideoContext: true };
    chatSessionStateForTests.liveContextKey = "k-1";
    store.applyById("c1");
    deps.onConversationChanged.mockClear();
    log.length = 0;

    const pending = store.clearAll();
    const confirmBtn = document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    expect(confirmBtn, "清空确认弹层应已打开").not.toBeNull();
    expect(confirmBtn.textContent).toBe("清空");
    confirmBtn.click();
    await pending;

    expect(deps.onStreamInterrupted).toHaveBeenCalledTimes(1);
    expect(log[0]).toEqual(["interrupt"]);
    expect(log[log.length - 1]).toEqual([
      "change",
      { historyCleared: true, resetView: true }
    ]);
    expect(chatSessionState.savedConversations).toEqual([]);
  });

  it("clearAll 空档早退 / confirm 取消:零事件", async () => {
    const { store, deps } = makeHarness({ confirmClearAll: () => false });
    makeOrderLog(deps);

    await store.clearAll();

    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();

    setSavedConversations([makeConversation("c1")]);
    await store.clearAll();

    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(deps.onStreamInterrupted).not.toHaveBeenCalled();
  });
});

describe("hydratePinned 的 change / notice 时序", () => {
  it("resolvedContext 缓存命中:change = {} → notice clear,不走解析", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    applyConversationIdentity({ meta: makePinnedMeta({
      resolvedContext: { bvid: "BV1abc", url: URL_A, title: "视频A" }
    }) });

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(deps.loadContextState).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["change", {}],
      ["notice", { kind: "clear" }]
    ]);
  });

  it("contextKey 与 live 键一致(分支 2):先经 loadContextState 静默刷新 live,再 change {} → notice clear", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    applyConversationIdentity({ meta: makePinnedMeta() });
    chatSessionStateForTests.liveContextKey = "k-1";
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(deps.loadContextState).toHaveBeenCalledWith({ forceRefresh: false, silent: true, preserveInput: false });
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["change", {}],
      ["notice", { kind: "clear" }]
    ]);
  });

  it("hydratePinned({preserveInput:true}):分支 2 的 loadContextState 原样透传(发送闸调用链)", async () => {
    const { store, deps } = makeHarness();
    applyConversationIdentity({ meta: makePinnedMeta() });
    chatSessionStateForTests.liveContextKey = "k-1";
    chatSessionStateForTests.contextData = { bvid: "BV1abc", url: URL_A, title: "视频A" };

    const ok = await store.hydratePinned({ preserveInput: true });

    expect(ok).toBe(true);
    expect(deps.loadContextState).toHaveBeenCalledWith({ forceRefresh: false, silent: true, preserveInput: true });
  });

  it("网络补水成功:change = {} → notice clear(次序与反转前「先发 change 再撤提示」一致)", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => ({ bvid: "BV1abc", url: URL_A, title: "视频A" }))
    });
    const log = makeOrderLog(deps);
    applyConversationIdentity({ meta: makePinnedMeta() });

    const ok = await store.hydratePinned();

    expect(ok).toBe(true);
    expect(deps.resolveAiConversationRef).toHaveBeenCalledTimes(1);
    expect(log).toEqual([
      ["change", {}],
      ["notice", { kind: "clear" }]
    ]);
  });

  it("网络补水失败:notice clear → notice error(非 silent);不触 change", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => {
        throw new Error("网络挂了");
      })
    });
    const log = makeOrderLog(deps);
    applyConversationIdentity({ meta: makePinnedMeta() });

    const ok = await store.hydratePinned();

    expect(ok).toBe(false);
    expect(deps.onConversationChanged).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["notice", { kind: "clear" }],
      ["notice", { kind: "error", message: "历史视频上下文获取失败：网络挂了" }]
    ]);
  });

  it("补水失败(silent):仅撤提示,不展示 error", async () => {
    const { store, deps } = makeHarness({
      resolveAiConversationRef: vi.fn(async () => {
        throw new Error("网络挂了");
      })
    });
    makeOrderLog(deps);
    applyConversationIdentity({ meta: makePinnedMeta() });

    const ok = await store.hydratePinned({ silent: true });

    expect(ok).toBe(false);
    expect(deps.onContextNotice).toHaveBeenCalledTimes(1);
    expect(deps.onContextNotice).toHaveBeenCalledWith({ kind: "clear" });
  });

  it("缺少 contextRef:notice clear → notice error(非 silent),不走解析", async () => {
    const { store, deps } = makeHarness();
    const log = makeOrderLog(deps);
    applyConversationIdentity({ meta: makePinnedMeta({ contextRef: null }) });

    const ok = await store.hydratePinned();

    expect(ok).toBe(false);
    expect(deps.resolveAiConversationRef).not.toHaveBeenCalled();
    expect(log).toEqual([
      ["notice", { kind: "clear" }],
      ["notice", { kind: "error", message: "历史对话缺少原视频信息，无法继续。" }]
    ]);
  });
});

describe("删除撤销的存储、顺序与当前身份（工单 05）", () => {
  it("非当前会话撤销：存储与原顺序恢复，当前身份不变，撤销仅生效一次", async () => {
    const { store, storage } = makeHarness();
    const conversations = [makeConversation("c1"), makeConversation("c2"), makeConversation("c3")];
    setSavedConversations(conversations);
    applyConversationIdentity({ id: "c1" });
    await storage.set({ biliscript_ai_conversations_v1: conversations });
    storage.set.mockClear();

    const { resolveActiveSubtitleStore } = await import("../../extension/subtitle/store-client.js");
    const deletion = await store.deleteById("c2");
    expect(chatSessionState.savedConversations.map((item) => item.id)).toEqual(["c1", "c3"]);
    expect((await resolveActiveSubtitleStore().listConversations()).map((item) => item.id)).toEqual(["c1", "c3"]);

    await deletion!.undo();
    expect(chatSessionState.savedConversations.map((item) => item.id)).toEqual(["c1", "c2", "c3"]);
    expect((await resolveActiveSubtitleStore().listConversations()).map((item) => item.id)).toEqual(["c1", "c2", "c3"]);
    expect(chatSessionState.currentConversationId).toBe("c1");
    const writesAfterUndo = storage.set.mock.calls.length;
    await deletion!.undo();
    expect(storage.set.mock.calls.length).toBe(writesAfterUndo);
  });

  it("当前会话撤销：存储、顺序、当前身份与消息历史一并恢复", async () => {
    const { resolveActiveSubtitleStore } = await import("../../extension/subtitle/store-client.js");
    const { store, storage } = makeHarness();
    const conversations = [makeConversation("c1"), makeConversation("c2")];
    setSavedConversations(conversations);
    await storage.set({ biliscript_ai_conversations_v1: conversations });
    store.applyById("c1");

    const deletion = await store.deleteById("c1");
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.chatHistory).toEqual([]);

    await deletion!.undo();
    expect(chatSessionState.currentConversationId).toBe("c1");
    expect(chatSessionState.chatHistory.map((message) => message.content)).toEqual(["hi", "hello"]);
    expect(chatSessionState.savedConversations.map((item) => item.id)).toEqual(["c1", "c2"]);
    expect((await resolveActiveSubtitleStore().listConversations()).map((item) => item.id)).toEqual(["c1", "c2"]);
  });
});
