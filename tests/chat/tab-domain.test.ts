// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import {
  NON_VIDEO_CONTEXT_MESSAGE,
  chatSessionState,
  createChatTabDomain,
  type CreateChatTabDomainDeps
} from "../../extension/chat/tab-domain.js";
import {
  applyConversationIdentity,
  chatSessionStateForTests,
  resetChatSessionStateForTests,
  type ChatSessionContextSnapshot
} from "../../extension/chat/chat-state.js";
import type { ContextFetchOutcome } from "../../extension/core/context-assembly.js";
import type { ChatPort } from "../../extension/chat/chat-runtime.js";

function makeSnapshot(overrides: Partial<ChatSessionContextSnapshot> = {}): ChatSessionContextSnapshot {
  return {
    site: "bilibili",
    bvid: "BV1alpha00001",
    cid: "101",
    title: "视频甲",
    url: "https://www.bilibili.com/video/BV1alpha00001/",
    isVideoContext: true,
    signature: "sig-alpha",
    subtitleFetchState: "ready",
    subtitleBody: [{ from: 5, to: 12, content: "核心字幕句" }],
    ...overrides
  };
}

function makePort() {
  const messageListeners: Array<(msg: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: ChatPort = {
    name: "offscreen-chat",
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) }
  };
  return { port, messageListeners, disconnectListeners };
}

function makeMemoryStorage() {
  const store = new Map<string, unknown>();
  return {
    store,
    get: vi.fn(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)]))
    ),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) {
        store.set(k, structuredClone(v));
      }
    })
  };
}

interface HarnessOptions {
  fetchOutcome?: () => ContextFetchOutcome;
  hasSelectableModels?: () => boolean;
  providerId?: () => string;
  selectedModel?: () => string;
  inputImageCount?: () => number;
  confirmResult?: boolean;
  isSessionClosed?: () => boolean;
  syncDebounceMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  document.body.append(messages, input);

  const storage = makeMemoryStorage();
  const ports: Array<ReturnType<typeof makePort>> = [];
  const fetchContext = vi.fn(async (): Promise<ContextFetchOutcome> => {
    if (options.fetchOutcome) {
      return options.fetchOutcome();
    }
    const snapshot = makeSnapshot();
    return { kind: "payload", tabUrl: snapshot.url || "", payload: snapshot };
  });
  const ui = {
    setStreamingUiState: vi.fn(),
    showConversationContextNotice: vi.fn(),
    removeConversationContextNotice: vi.fn(),
    hideHistoryPopover: vi.fn(),
    removeCenteredState: vi.fn(),
    removeSuggestions: vi.fn(),
    autosizeInput: vi.fn()
  };
  const view = {
    hasSelectableModels: vi.fn(options.hasSelectableModels ?? (() => true)),
    getSetupStateHtml: vi.fn(() => '还没有配置 AI 平台，<a href="#" id="setup-link">前往设置</a>'),
    focusSetupAction: vi.fn(),
    getInputImageCount: vi.fn(options.inputImageCount ?? (() => 0)),
    clearInputImages: vi.fn(),
    suggestions: {
      refresh: vi.fn(),
      clear: vi.fn(),
      reset: vi.fn()
    },
    resetScrollFollow: vi.fn(),
    prepareForNewConversation: vi.fn(),
    seekReadingTarget: vi.fn((seconds: number) => seconds),
    confirmDialog: vi.fn(async () => options.confirmResult ?? true)
  };
  const onConversationChanged = vi.fn();
  const onContextNotice = vi.fn();
  const renderHistoryList = vi.fn();
  const onWaitingChange = vi.fn();
  const removeInputContextNotice = vi.fn();

  const deps: CreateChatTabDomainDeps = {
    messages,
    input,
    ui,
    view,
    onConversationChanged,
    onContextNotice,
    renderHistoryList,
    storage,
    clip: () => ({}),
    settings: () => ({}),
    fetchContext,
    isSessionClosed: options.isSessionClosed ?? (() => false),
    isReaderTranscribing: () => false,
    asrNotice: null,
    pageBvid: () => "BV1alpha00001",
    startSubtitleFetch: vi.fn(async () => true),
    subscribeStatusPhase: () => () => {},
    onWaitingChange,
    removeInputContextNotice,
    getProviderId: options.providerId ?? (() => "p1"),
    getSelectedModel: options.selectedModel ?? (() => "m1"),
    connectPort: vi.fn(async () => {
      const created = makePort();
      ports.push(created);
      return created.port;
    }),
    syncDebounceMs: options.syncDebounceMs ?? 120
  };

  const domain = createChatTabDomain(deps);
  return {
    domain,
    messages,
    input,
    ui,
    view,
    fetchContext,
    storage,
    ports,
    onConversationChanged,
    onContextNotice,
    renderHistoryList,
    onWaitingChange,
    removeInputContextNotice
  };
}

beforeEach(() => {
  resetModuleState();
  resetChatSessionStateForTests();
  document.body.innerHTML = "";
  chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", models: ["m1"], enabled: true }];
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("createChatTabDomain 任务级接口行为", () => {
  it("startNewConversation：重启时视图重置与流式态退出各仅执行一次，并清空草稿与图片", async () => {
    let snapshot = makeSnapshot();
    const h = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: snapshot.url || "", payload: snapshot }),
      inputImageCount: () => 2,
      confirmResult: true
    });

    await h.domain.loadContextState({ silent: true });
    applyConversationIdentity({
      id: "conv-1",
      meta: {
        id: "conv-1",
        title: "视频甲",
        createdAt: 1,
        updatedAt: 1,
        contextKey: "video:BV1alpha00001|101",
        contextTitle: "视频甲",
        contextUrl: snapshot.url || "",
        isVideoContext: true,
        pinnedContext: true
      },
      history: [{ role: "user", content: "旧问题" }]
    });
    h.messages.innerHTML = '<div class="chat-msg">旧消息</div>';
    h.input.value = "未发草稿";
    h.view.suggestions.reset.mockClear();
    h.view.resetScrollFollow.mockClear();
    h.ui.setStreamingUiState.mockClear();
    h.ui.autosizeInput.mockClear();

    const started = await h.domain.startNewConversation();

    expect(started).toBe(true);
    expect(h.view.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "新建会话",
        message: "新建会话会清空未发送的草稿，移除 2 张已添加的图片。"
      })
    );
    expect(h.view.prepareForNewConversation).toHaveBeenCalledTimes(1);
    expect(h.view.clearInputImages).toHaveBeenCalledTimes(1);
    expect(h.input.value).toBe("");
    expect(chatSessionState.currentConversationId).toBe("");
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(h.messages.innerHTML).toBe("");
    expect(h.view.suggestions.reset).toHaveBeenCalledTimes(1);
    expect(h.view.resetScrollFollow).toHaveBeenCalledTimes(1);
    expect(h.ui.setStreamingUiState).toHaveBeenCalledTimes(1);
    expect(h.ui.setStreamingUiState).toHaveBeenCalledWith(false);
    expect(h.ui.autosizeInput).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(h.input);
  });

  it("startNewConversation：取消确认时不动草稿、会话与视图", async () => {
    const h = makeHarness({ confirmResult: false });
    await h.domain.loadContextState({ silent: true });
    h.input.value = "保留草稿";
    h.messages.innerHTML = '<div class="chat-msg">保留消息</div>';
    h.view.suggestions.reset.mockClear();

    const started = await h.domain.startNewConversation();

    expect(started).toBe(false);
    expect(h.input.value).toBe("保留草稿");
    expect(h.messages.innerHTML).toContain("保留消息");
    expect(h.view.prepareForNewConversation).not.toHaveBeenCalled();
    expect(h.view.suggestions.reset).not.toHaveBeenCalled();
  });

  it("上下文切换到新视频：去重后仅执行一次视图重置，并按 preserveInput 控制是否保留草稿与图片", async () => {
    let snapshot = makeSnapshot();
    const h = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: snapshot.url || "", payload: snapshot })
    });
    await h.domain.loadContextState({ silent: true });

    snapshot = makeSnapshot({
      bvid: "BV1beta000002",
      cid: "202",
      title: "视频乙",
      url: "https://www.bilibili.com/video/BV1beta000002/",
      signature: "sig-beta"
    });
    h.input.value = "切视频前草稿";
    h.view.suggestions.reset.mockClear();
    h.view.resetScrollFollow.mockClear();
    h.view.clearInputImages.mockClear();

    await h.domain.loadContextState({ forceRefresh: true, silent: true, preserveInput: true });
    expect(h.input.value).toBe("切视频前草稿");
    expect(h.view.clearInputImages).not.toHaveBeenCalled();
    expect(h.view.suggestions.reset).toHaveBeenCalledTimes(1);
    expect(h.view.resetScrollFollow).toHaveBeenCalledTimes(1);

    snapshot = makeSnapshot({
      bvid: "BV1gamma00003",
      cid: "303",
      title: "视频丙",
      url: "https://www.bilibili.com/video/BV1gamma00003/",
      signature: "sig-gamma"
    });
    h.view.suggestions.reset.mockClear();
    h.view.resetScrollFollow.mockClear();
    await h.domain.loadContextState({ forceRefresh: true, silent: true, preserveInput: false });
    expect(h.input.value).toBe("");
    expect(h.view.clearInputImages).toHaveBeenCalledTimes(1);
    expect(h.view.suggestions.reset).toHaveBeenCalledTimes(1);
    expect(h.view.resetScrollFollow).toHaveBeenCalledTimes(1);
  });

  it("scheduleLiveContextSync：120ms 防抖合并且 closeSession 取消待执行同步", async () => {
    vi.useFakeTimers();
    let closed = false;
    let snapshot = makeSnapshot();
    const h = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: snapshot.url || "", payload: snapshot }),
      isSessionClosed: () => closed,
      syncDebounceMs: 120
    });

    await h.domain.loadContextState({ silent: true });
    h.fetchContext.mockClear();
    h.view.suggestions.reset.mockClear();

    snapshot = makeSnapshot({
      bvid: "BV1beta000002",
      cid: "202",
      title: "视频乙",
      url: "https://www.bilibili.com/video/BV1beta000002/",
      signature: "sig-beta"
    });
    h.domain.scheduleLiveContextSync();
    vi.advanceTimersByTime(60);
    h.domain.scheduleLiveContextSync();
    vi.advanceTimersByTime(60);
    expect(h.fetchContext).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60);
    expect(h.fetchContext).toHaveBeenCalledTimes(1);
    expect(chatSessionState.contextData?.bvid).toBe("BV1beta000002");
    expect(h.view.suggestions.reset).toHaveBeenCalledTimes(1);

    h.fetchContext.mockClear();
    h.domain.scheduleLiveContextSync();
    closed = true;
    h.domain.closeSession({ resetRuntime: true });
    await vi.advanceTimersByTimeAsync(200);
    expect(h.fetchContext).not.toHaveBeenCalled();
  });

  it("renderInitialState 按上下文/模型/非视频页分支渲染居中状态", () => {
    const h = makeHarness({ hasSelectableModels: () => false });

    h.domain.renderInitialState();
    expect(h.messages.querySelector(".chat-center-error")?.textContent).toContain("当前页面不是支持的视频页");

    chatSessionStateForTests.contextData = makeSnapshot();
    h.domain.renderInitialState();
    expect(h.messages.querySelector("#setup-link")?.textContent).toBe("前往设置");

    h.view.hasSelectableModels.mockReturnValue(true);
    chatSessionStateForTests.contextData = makeSnapshot({ isVideoContext: false });
    h.domain.renderInitialState();
    expect(h.messages.querySelector(".chat-center-error")?.innerHTML).toBe(NON_VIDEO_CONTEXT_MESSAGE);
  });

  it("未配置模型时 sendTurn 返回 blocked、渲染引导空态、聚焦设置动作并在输入槽提示", async () => {
    const h = makeHarness({
      providerId: () => "",
      selectedModel: () => ""
    });

    const verdict = await h.domain.sendTurn("总结一下");

    expect(verdict).toBe("blocked");
    expect(h.messages.querySelector("#setup-link")?.textContent).toBe("前往设置");
    expect(h.view.focusSetupAction).toHaveBeenCalledTimes(1);
    expect(h.ui.showConversationContextNotice).toHaveBeenCalledWith(
      "请先配置平台与模型，点击下方「前往设置」",
      4000,
      { placement: "input" }
    );
  });

  it("getTimestampNavDeps 按 liveContextKey 校验上下文有效性并读取字幕预览", async () => {
    const h = makeHarness();
    await h.domain.loadContextState({ silent: true });

    const navDeps = h.domain.getTimestampNavDeps();
    expect(navDeps.contextUrl).toBe("https://www.bilibili.com/video/BV1alpha00001/");
    expect(navDeps.isContextValid?.()).toBe(true);
    expect(navDeps.getSubtitlePreview?.(8)).toEqual({ time: "0:05", text: "核心字幕句" });
    expect(navDeps.seek?.(15)).toBe(15);
    expect(navDeps.tooltipContainer).toBe(h.messages);

    chatSessionStateForTests.liveContextKey = "video:BV1other00009|999";
    expect(navDeps.isContextValid?.()).toBe(false);
  });
});
