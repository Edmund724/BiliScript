import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../../extension/chat/protocol.js";
import type { AiContext } from "../../extension/ai/types.js";
import type { ClipState } from "../../extension/core/state.js";

const { gatewayMock } = vi.hoisted(() => ({
  gatewayMock: {
    fetchHotCommentsWithLedger: vi.fn()
  }
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  fetchHotCommentsWithLedger: gatewayMock.fetchHotCommentsWithLedger
}));

let createInProcessContextFetch: typeof import("../../extension/core/context-assembly.js").createInProcessContextFetch;
let createInProcessPinnedContextResolver: typeof import("../../extension/core/context-assembly.js").createInProcessPinnedContextResolver;
let createContextLoad: typeof import("../../extension/chat/context-load.js").createContextLoad;
let createConversationStore: typeof import("../../extension/chat/conversation-store.js").createConversationStore;
let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let createSubtitleWaiter: typeof import("../../extension/chat/subtitle-wait.js").createSubtitleWaiter;
let subtitleReadiness: typeof import("../../extension/chat/subtitle-readiness.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

const VIDEO_URL = "https://www.bilibili.com/video/BV1test000000/";
const CONTEXT_KEY = "video:BV1test000000|101";
const HOT_COMMENTS = [{ uname: "热评君", message: "前方高能" }];

type ClipRef = { current: Partial<ClipState> };

async function importModules() {
  const contextLoadModule = await import("../../extension/chat/context-load.js");
  createContextLoad = contextLoadModule.createContextLoad;
  const assemblyModule = await import("../../extension/core/context-assembly.js");
  createInProcessContextFetch = assemblyModule.createInProcessContextFetch;
  createInProcessPinnedContextResolver = assemblyModule.createInProcessPinnedContextResolver;
  const storeModule = await import("../../extension/chat/conversation-store.js");
  createConversationStore = storeModule.createConversationStore;
  const runtimeModule = await import("../../extension/chat/chat-runtime.js");
  createChatRuntime = runtimeModule.createChatRuntime;
  const waitModule = await import("../../extension/chat/subtitle-wait.js");
  createSubtitleWaiter = waitModule.createSubtitleWaiter;
  subtitleReadiness = await import("../../extension/chat/subtitle-readiness.js");
  const stateModule = await import("../../extension/chat/chat-state.js");
  chatSessionState = stateModule.chatSessionState;
  chatSessionStateForTests = stateModule.chatSessionStateForTests;
  applyConversationIdentity = stateModule.applyConversationIdentity;
  resetChatSessionStateForTests = stateModule.resetChatSessionStateForTests;
}

function makeClip(overrides: Partial<ClipState> = {}): Partial<ClipState> {
  return {
    currentUrl: VIDEO_URL,
    bvid: "BV1test000000",
    cid: "101",
    aid: "100",
    title: "测试视频",
    author: "UP 主",
    uploadDate: "2026-01-01",
    pageIndex: 1,
    pageCount: 1,
    pageTitle: "",
    videoDuration: 60,
    description: "",
    subtitles: [{ id: "s1", subtitleUrl: "https://example.com/s1", lan: "zh-CN" }],
    selectedSubtitleId: "s1",
    selectedSubtitleUrl: "https://example.com/s1",
    selectedSubtitleLang: "zh-CN",
    subtitleBody: [{ from: 0, to: 5, content: "第一句" }],
    subtitleFetchState: "ready",
    noSubtitleReason: null,
    chapters: [],
    hotComments: [],
    ...overrides
  };
}

function makeContextHarness(clipRef: ClipRef, { hotComments = HOT_COMMENTS }: { hotComments?: unknown[] } = {}) {
  const fetchHotComments = vi.fn(async () => hotComments);
  const fetchContext = createInProcessContextFetch({
    clip: () => clipRef.current,
    settings: () => ({ includeTimestampInBody: true }),
    url: () => VIDEO_URL,
    fetchHotComments
  });
  const deps = {
    fetchContext,
    renderHistoryList: vi.fn(),
    renderInitialState: vi.fn(),
    renderSuggestions: vi.fn(),
    requestViewReset: vi.fn(),
    restartChat: vi.fn(),
    restoreLatest: vi.fn(async () => true),
    isStreaming: vi.fn(() => false),
    hasPendingUserPrompt: vi.fn(() => false)
  };
  const contextLoad = createContextLoad(deps);
  return { fetchHotComments, contextLoad, deps };
}

interface ChatSendMessage {
  action: string;
  contextKey?: string;
  prompt?: string;
  context: { subtitleBody?: unknown; subtitleFetchState?: unknown };
}

function makePort() {
  const listeners: {
    message: Array<(message: unknown) => void>;
    disconnect: Array<() => void>;
  } = { message: [], disconnect: [] };
  return {
    port: {
      name: OFFSCREEN_CHAT_PORT_NAME,
      onMessage: { addListener: (fn: (message: unknown) => void) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => listeners.disconnect.push(fn) },
      postMessage: vi.fn<(message: ChatSendMessage) => void>(),
      disconnect: vi.fn()
    },
    listeners
  };
}

type ChatRuntimeDeps = CreateChatRuntimeDeps & {
  ports: Array<ReturnType<typeof makePort>>;
};

function makeChatDeps(overrides: Partial<ChatRuntimeDeps> = {}) {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports: ChatRuntimeDeps["ports"] = [];
  const deps: ChatRuntimeDeps = {
    messages,
    input,
    ports,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: (id: string) => id === chatSessionState.currentConversationId
    },
    ui: {
      setStreamingUiState: vi.fn(),
      showConversationContextNotice: vi.fn(),
      removeConversationContextNotice: vi.fn(),
      hideHistoryPopover: vi.fn(),
      removeCenteredState: vi.fn(),
      removeSuggestions: vi.fn(),
      requestViewReset: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => ({ pass: true }) as const),
    getProviderId: () => "test-provider",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port;
    }),
    ...overrides
  };
  return { deps };
}

async function send(runtime: ReturnType<typeof createChatRuntime>, deps: ChatRuntimeDeps, text: string) {
  deps.input.value = text;
  await runtime.sendTurn(deps.input.value);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  gatewayMock.fetchHotCommentsWithLedger.mockReset();
  await importModules();
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("工单 08 短路三事（进程内直读路径）", () => {
  it("① 字幕签名未变 → 不重发字幕体到 offscreen：unchanged 短路 + lastAcked 省传接力", async () => {
    const clipRef = { current: makeClip() };
    const { fetchHotComments, contextLoad } = makeContextHarness(clipRef);

    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(chatSessionState.contextData!.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    const signature = chatSessionState.liveContextData!.signature;
    expect(signature).not.toBe("");
    expect(chatSessionState.currentContextKey).toBe(CONTEXT_KEY);

    const { deps } = makeChatDeps();
    const runtime = createChatRuntime(deps);
    await send(runtime, deps, "总结一下这个视频");
    expect(deps.ports).toHaveLength(1);
    const firstMsg = deps.ports[0].port.postMessage.mock.calls[0][0];
    expect(firstMsg.action).toBe("chat");
    expect(firstMsg.contextKey).toBe(CONTEXT_KEY);
    expect(firstMsg.context.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    deps.ports[0].listeners.message[0]({ type: "done", cachedContextKey: CONTEXT_KEY });
    expect(deps.ports[0].port.disconnect).toHaveBeenCalled();

    const contextDataBefore = chatSessionState.contextData;
    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(chatSessionState.contextData).toBe(contextDataBefore);
    expect(chatSessionState.currentContextKey).toBe(CONTEXT_KEY);

    await send(runtime, deps, "第二章讲了什么？");
    expect(deps.ports).toHaveLength(2);
    const secondMsg = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(secondMsg.contextKey).toBe(CONTEXT_KEY);
    expect("subtitleBody" in secondMsg.context).toBe(false);
    expect(secondMsg.prompt).toBe("第二章讲了什么？");
  });

  it("② 首次上下文组装时拉热评：仅全量路径拉取并合并进快照（时机与消息链现状一致）", async () => {
    const clipRef = { current: makeClip() };
    const { fetchHotComments, contextLoad } = makeContextHarness(clipRef, {
      hotComments: HOT_COMMENTS
    });

    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
    expect(chatSessionState.contextData!.hotComments).toEqual(HOT_COMMENTS);
    expect(chatSessionState.contextData!.isVideoContext).toBe(true);
    expect(chatSessionState.contextData!.signature).not.toBe("");

    await contextLoad.loadContextState({ silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(1);

    await contextLoad.loadContextState({ forceRefresh: true, silent: true });
    expect(fetchHotComments).toHaveBeenCalledTimes(2);
    expect(chatSessionState.contextData!.hotComments).toEqual(HOT_COMMENTS);
  });

  it("③ ASR 转写中发送 → subtitle-wait 等待而非发空上下文；转写完成后放行完整字幕", async () => {
    const clipRef = {
      current: makeClip({ subtitleBody: [], subtitleFetchState: "loading" })
    };
    const { fetchHotComments, contextLoad } = makeContextHarness(clipRef);
    await contextLoad.loadContextState({ silent: true });
    chatSessionStateForTests.asrTranscribingActive = true;

    const waitingNotice = vi.fn();
    const removeNotice = vi.fn();
    const timers: Array<{ fn: () => void; ms: number; id?: number }> = [];
    let timerSeq = 0;
    const subtitleWaiter = createSubtitleWaiter({
      pollIntervalMs: 4000,
      pollContext: async () => {
        const ok = await contextLoad.loadContextState({ forceRefresh: false, silent: true }).catch(() => false);
        const snapshot = ok ? (chatSessionState.liveContextData || chatSessionState.contextData) : null;
        return {
          ok: Boolean(snapshot),
          pending: subtitleReadiness.isPending(
            subtitleReadiness.readinessFromSnapshot(snapshot, {
              asrTranscribingActive: chatSessionState.asrTranscribingActive
            })
          )
        };
      },
      showWaitingNotice: waitingNotice,
      removeNotice,
      setTimer: (fn: () => void, ms: number) => {
        timers.push({ fn, ms });
        return ++timerSeq;
      },
      clearTimer: (handle: number) => {
        const index = timers.findIndex((t) => t.id === handle || timers.indexOf(t) === handle - 1);
        if (index >= 0) {
          timers.splice(index, 1);
        }
      }
    });

    const { deps } = makeChatDeps();
    deps.ensureCurrentContextForSend = vi.fn(async () => {
      const ok = await contextLoad.loadContextState({ forceRefresh: false, silent: true });
      if (!ok || !chatSessionState.contextData) {
        return { pass: false, kind: "read-failed" } as const;
      }
      const ready = await subtitleWaiter.wait();
      if (!ready) {
        return { pass: false, kind: "read-failed" } as const;
      }
      await contextLoad.loadContextState({ forceRefresh: false, silent: true });
      if (!chatSessionState.contextData) {
        return { pass: false, kind: "read-failed" } as const;
      }
      if (subtitleReadiness.isNoSubtitleEmpty(subtitleReadiness.readinessFromSnapshot(chatSessionState.contextData))) {
        return { pass: false, kind: "no-subtitle" } as const;
      }
      return { pass: true } as const;
    });
    const runtime = createChatRuntime(deps);

    const sendPromise = send(runtime, deps, "总结一下这个视频");
    await flush();
    await flush();

    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(1);
    expect(waitingNotice).toHaveBeenCalled();
    expect(deps.ports).toHaveLength(0);
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());
    expect(timers).toHaveLength(1);

    clipRef.current = makeClip();
    chatSessionStateForTests.asrTranscribingActive = false;
    subtitleWaiter.kick();
    await sendPromise;

    expect(deps.ports).toHaveLength(1);
    const chatMsg = deps.ports[0].port.postMessage.mock.calls[0][0];
    expect(chatMsg.action).toBe("chat");
    expect(chatMsg.prompt).toBe("总结一下这个视频");
    expect(Array.isArray(chatMsg.context.subtitleBody)).toBe(true);
    expect((chatMsg.context.subtitleBody as unknown[]).length).toBeGreaterThan(0);
    expect(chatMsg.context.subtitleFetchState).toBe("ready");
    expect(removeNotice).toHaveBeenCalled();
    expect(fetchHotComments.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("视频身份校验（clip 与当前页地址不符）", () => {
  it("clip 还停在上一个视频：按未就绪装配空快照，不带上个视频的身份与字幕", async () => {
    const clipRef = {
      current: makeClip({ bvid: "BV1prev00000", cid: "999", title: "上一个视频" })
    };
    const { contextLoad } = makeContextHarness(clipRef);

    await contextLoad.loadContextState({ silent: true });

    expect(chatSessionState.contextData!.bvid).toBe("");
    expect(chatSessionState.contextData!.title).toBe("");
    expect(chatSessionState.contextData!.subtitleBody).toEqual([]);
    expect(chatSessionState.currentContextKey).toBe(`url:${VIDEO_URL}`);
  });

  it("clip 与地址同视频（对照组）：照常装配真快照", async () => {
    const clipRef = { current: makeClip() };
    const { contextLoad } = makeContextHarness(clipRef);

    await contextLoad.loadContextState({ silent: true });

    expect(chatSessionState.contextData!.bvid).toBe("BV1test000000");
    expect(chatSessionState.contextData!.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    expect(chatSessionState.currentContextKey).toBe(CONTEXT_KEY);
  });
});

describe("缺省热评实现（gateway 单源接缝）", () => {
  function makeBareFetch(clipRef: ClipRef) {
    return createInProcessContextFetch({
      clip: () => clipRef.current,
      settings: () => ({ includeTimestampInBody: true }),
      url: () => VIDEO_URL
    });
  }

  it("成功：fetchHotCommentsWithLedger 的 comments 合并进快照", async () => {
    const comments = [{ uname: "u", message: "m" }];
    gatewayMock.fetchHotCommentsWithLedger.mockResolvedValue({ comments });
    const clipRef = { current: makeClip() };
    const fetchContext = makeBareFetch(clipRef);

    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });

    expect(gatewayMock.fetchHotCommentsWithLedger).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe("payload");
    expect((outcome as { payload: AiContext }).payload.hotComments).toEqual(comments);
  });

  it("降级（{comments:[], note}）：快照热评空数组、不阻断全量路径（note 不进快照）", async () => {
    gatewayMock.fetchHotCommentsWithLedger.mockResolvedValue({ comments: [], note: "无法获取视频 aid" });
    const clipRef = { current: makeClip() };
    const fetchContext = makeBareFetch(clipRef);

    const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });

    expect(outcome.kind).toBe("payload");
    expect((outcome as { payload: AiContext }).payload.hotComments).toEqual([]);
  });
});

describe("pinned 补水身份短路（工单 04）", () => {
  interface PinnedRefOverrides {
    bvid?: string;
    cid?: string;
    subtitleLang?: string;
    selectedSubtitleId?: string;
    selectedSubtitleUrl?: string;
  }

  function makePinnedRef(overrides: PinnedRefOverrides = {}) {
    return {
      bvid: "BV1test000000",
      cid: "101",
      aid: "100",
      url: VIDEO_URL,
      title: "测试视频",
      pageIndex: 1,
      subtitleLang: "zh-CN",
      selectedSubtitleId: "s1",
      selectedSubtitleUrl: "https://example.com/s1",
      isVideoContext: true,
      ...overrides
    };
  }

  function makeResolver(
    clipRef: ClipRef,
    {
      resolveNetwork,
      url = VIDEO_URL
    }: {
      resolveNetwork?: (contextRef: unknown) => Promise<Record<string, unknown>>;
      url?: string;
    } = {}
  ) {
    const fetchHotComments = vi.fn(async () => HOT_COMMENTS);
    const network = resolveNetwork
      || vi.fn(async () => ({
        title: "网络装配",
        subtitleBody: [{ from: 9, to: 12, content: "网络字幕" }],
        isVideoContext: true
      }));
    const resolve = createInProcessPinnedContextResolver({
      clip: () => clipRef.current,
      settings: () => ({ includeTimestampInBody: true }),
      url: () => url,
      fetchHotComments,
      resolveNetwork: network
    });
    return { resolve, network, fetchHotComments };
  }

  it("pinned contextRef 与当前 clip 身份一致 → 零网络往返，从同进程快照装配", async () => {
    const clipRef = { current: makeClip() };
    const { resolve, network, fetchHotComments } = makeResolver(clipRef);

    const payload = await resolve(makePinnedRef());

    expect(network).not.toHaveBeenCalled();
    expect(payload.bvid).toBe("BV1test000000");
    expect(payload.cid).toBe("101");
    expect(payload.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    expect(payload.hotComments).toEqual(HOT_COMMENTS);
    expect(payload.isVideoContext).toBe(true);
    expect(payload.signature).not.toBe("");
    expect(fetchHotComments).toHaveBeenCalledTimes(1);
  });

  it("当前页是别的视频（浏览中补水置顶对话）：仍从 clip 装配会话视频的上下文", async () => {
    const clipRef = { current: makeClip() };
    const { resolve, network } = makeResolver(clipRef, {
      url: "https://www.bilibili.com/video/BV1otherpage/"
    });

    const payload = await resolve(makePinnedRef());

    expect(network).not.toHaveBeenCalled();
    expect(payload.bvid).toBe("BV1test000000");
    expect(payload.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
  });

  it("装配结果与 createInProcessContextFetch 的 live 全量快照同 shape 同签名", async () => {
    const clipRef = { current: makeClip() };
    const { resolve } = makeResolver(clipRef);
    const pinnedPayload = await resolve(makePinnedRef());

    const liveFetch = createInProcessContextFetch({
      clip: () => clipRef.current,
      settings: () => ({ includeTimestampInBody: true }),
      url: () => VIDEO_URL,
      fetchHotComments: async () => HOT_COMMENTS
    });
    const live = await liveFetch({ forceRefresh: true, ifSignature: "" });

    expect(live.kind).toBe("payload");
    expect(pinnedPayload).toEqual((live as { payload: AiContext }).payload);
  });

  it.each([
    ["bvid 不同（别的视频）", { bvid: "BV1other00000" }],
    ["cid 不同（换分P）", { cid: "999" }],
    ["字幕轨 id 不同（换轨）", { selectedSubtitleId: "s2" }],
    ["字幕 lang 不同", { subtitleLang: "en-US" }],
    ["字幕轨 URL 缺失（老数据）", { selectedSubtitleUrl: "" }],
    ["cid 缺失（aid 键老会话）", { cid: "" }]
  ])("不匹配（%s）→ 原样落回网络路径", async (_name, overrides) => {
    const clipRef = { current: makeClip() };
    const { resolve, network } = makeResolver(clipRef);
    const ref = makePinnedRef(overrides);

    const payload = await resolve(ref);

    expect(network).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledWith(ref);
    expect(payload.title).toBe("网络装配");
  });

  it("无页面（clip 为空）→ 落回网络路径", async () => {
    const clipRef = { current: {} };
    const { resolve, network } = makeResolver(clipRef);

    await resolve(makePinnedRef());

    expect(network).toHaveBeenCalledTimes(1);
  });

  it("转写中（字幕体为空）→ 落回网络路径，不装配空字幕上下文", async () => {
    const clipRef = { current: makeClip({ subtitleBody: [], subtitleFetchState: "loading" }) };
    const { resolve, network } = makeResolver(clipRef);

    await resolve(makePinnedRef());

    expect(network).toHaveBeenCalledTimes(1);
  });

  it("hydratePinned 经身份短路补水当前视频的置顶对话（dep 接线对账）", async () => {
    const clipRef = { current: makeClip() };
    const { resolve, network } = makeResolver(clipRef);
    const store = createConversationStore({
      loadContextState: vi.fn(async () => true),
      resolveAiConversationRef: vi.fn((ref: AiContext, purpose: "context" | "page") =>
        purpose === "context" ? resolve(ref) : Promise.resolve({})
      ),
      onConversationChanged: vi.fn(),
      onStreamInterrupted: vi.fn(),
      onContextNotice: vi.fn(),
      storage: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) }
    });
    applyConversationIdentity({
      meta: {
        id: "conv-1",
        title: "测试视频",
        createdAt: 1,
        updatedAt: 1,
        contextKey: CONTEXT_KEY,
        contextTitle: "测试视频",
        contextUrl: VIDEO_URL,
        isVideoContext: true,
        pinnedContext: true,
        contextRef: makePinnedRef(),
        resolvedContext: null
      }
    });
    chatSessionStateForTests.liveContextKey = "";

    const ok = await store.hydratePinned({ silent: true });

    expect(ok).toBe(true);
    expect(network).not.toHaveBeenCalled();
    expect(chatSessionState.contextData!.subtitleBody).toEqual([{ from: 0, to: 5, content: "第一句" }]);
    expect(chatSessionState.contextData!.signature).not.toBe("");
    expect(chatSessionState.currentContextKey).toBe(CONTEXT_KEY);
    expect(chatSessionState.currentConversationMeta!.resolvedContext).not.toBeNull();
  });
});
