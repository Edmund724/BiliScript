import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import type { ChatSessionContextSnapshot } from "../../extension/chat/chat-state.js";
import type { ContextFetchOutcome } from "../../extension/core/context-assembly.js";

let createContextLoad: typeof import("../../extension/chat/context-load.js").createContextLoad;
let isPinnedContextStrict: typeof import("../../extension/chat/context-load.js").isPinnedContextStrict;
let CONTEXT_READ_FAILED_MESSAGE: string;
let NO_TAB_MESSAGE: string;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

async function importModule() {
  const module = await import("../../extension/chat/context-load.js");
  const state = await import("../../extension/chat/chat-state.js");
  createContextLoad = module.createContextLoad;
  isPinnedContextStrict = module.isPinnedContextStrict;
  CONTEXT_READ_FAILED_MESSAGE = module.CONTEXT_READ_FAILED_MESSAGE;
  NO_TAB_MESSAGE = module.NO_TAB_MESSAGE;
  chatSessionState = state.chatSessionState;
  chatSessionStateForTests = state.chatSessionStateForTests;
  applyConversationIdentity = state.applyConversationIdentity;
  resetChatSessionStateForTests = state.resetChatSessionStateForTests;
}

const ACTIVE_TAB = { url: "https://www.bilibili.com/video/BV1" };

function makePayload(overrides: Partial<ChatSessionContextSnapshot> = {}) {
  return { signature: "sig-1", title: "测试视频", url: "https://www.bilibili.com/video/BV1", isVideoContext: true, ...overrides };
}

function makeHarness({
  fetchOutcome
}: {
  fetchOutcome?: () => ContextFetchOutcome;
} = {}) {
  const deps = {
    fetchContext: vi.fn(async (): Promise<ContextFetchOutcome> => {
      if (fetchOutcome) {
        return fetchOutcome();
      }
      return { kind: "payload", tabUrl: ACTIVE_TAB.url, payload: makePayload() };
    }),
    renderHistoryList: vi.fn(),
    renderInitialState: vi.fn(),
    renderSuggestions: vi.fn(),
    requestViewReset: vi.fn(),
    restoreLatest: vi.fn(async () => true),
    isStreaming: vi.fn(() => false),
    hasPendingUserPrompt: vi.fn(() => false),
    isLiveActive: vi.fn(() => false)
  };
  const contextLoad = createContextLoad({
    fetchContext: deps.fetchContext,
    renderHistoryList: deps.renderHistoryList,
    renderInitialState: deps.renderInitialState,
    renderSuggestions: deps.renderSuggestions,
    requestViewReset: deps.requestViewReset,
    restoreLatest: deps.restoreLatest,
    isStreaming: deps.isStreaming,
    hasPendingUserPrompt: deps.hasPendingUserPrompt,
    isLiveActive: deps.isLiveActive
  });
  return { deps, contextLoad };
}

beforeEach(async () => {
  resetModuleState();
  await importModule();
  resetChatSessionStateForTests();
});

describe("loadContextState 动作分支", () => {
  it("skip-unchanged：短路返回 true，不动任何状态不重渲染", async () => {
    chatSessionStateForTests.liveContextData = makePayload();
    const prevContextData = chatSessionState.contextData;
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload: { unchanged: true } })
    });

    const ok = await contextLoad.loadContextState({ forceRefresh: false, silent: true });

    expect(ok).toBe(true);
    expect(deps.fetchContext).toHaveBeenCalledWith({ forceRefresh: false, ifSignature: "sig-1" });
    expect(chatSessionState.contextData).toBe(prevContextData);
    expect(deps.renderHistoryList).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
  });

  it("error：清 live 快照，非静默重置视图并透传错误信息", async () => {
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "error", tabUrl: ACTIVE_TAB.url, error: "内容脚本未响应" })
    });

    const ok = await contextLoad.loadContextState({ silent: false });

    expect(ok).toBe(false);
    expect(chatSessionState.liveContextData).toBeNull();
    expect(chatSessionState.contextData).toBeNull();
    expect(deps.requestViewReset).toHaveBeenCalledWith({ kind: "state", html: "内容脚本未响应" });
  });

  it("error + 静默：不重置视图（返回值仍 false）", async () => {
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "error", tabUrl: ACTIVE_TAB.url, error: "超时" })
    });

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(false);
    expect(deps.requestViewReset).not.toHaveBeenCalled();
  });

  it("no-tab 信封：清 live 快照（进程内策略不产生该分支，信封语义由 policy 锁定）", async () => {
    chatSessionStateForTests.contextData = makePayload();
    chatSessionStateForTests.currentContextKey = "k1";
    chatSessionStateForTests.liveContextData = makePayload();
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "no-tab" })
    });

    const ok = await contextLoad.loadContextState({ silent: false });

    expect(ok).toBe(false);
    expect(chatSessionState.liveContextData).toBeNull();
    expect(chatSessionState.contextData).toBeNull();
    expect(deps.requestViewReset).toHaveBeenCalledTimes(1);
  });

  it("apply-pinned：只落地 live 快照（不进主上下文、不触发对话恢复）", async () => {
    applyConversationIdentity({ meta: { pinnedContext: true } });
    const payload = makePayload({ signature: "sig-2" });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload })
    });

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(chatSessionState.liveContextData).toEqual(payload);
    expect(chatSessionState.liveContextKey).not.toBe("");
    expect(chatSessionState.contextData).toBeNull();
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
    expect(deps.restoreLatest).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();
  });

  it("blocked-streaming：同 pinned 执行体（只落地 live 快照）", async () => {
    const payload = makePayload({ signature: "sig-3" });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload })
    });
    deps.isStreaming.mockReturnValue(true);

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(chatSessionState.liveContextData).toEqual(payload);
    expect(chatSessionState.contextData).toBeNull();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
  });

  it("apply-live：主上下文落地；上下文变化时经 requestViewReset(restart) + restoreLatest + renderInitialState", async () => {
    chatSessionStateForTests.currentContextKey = "old-key";
    chatSessionStateForTests.contextData = makePayload();
    const payload = makePayload({ signature: "sig-4", title: "新视频" });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload })
    });

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(chatSessionState.contextData).toEqual(payload);
    expect(deps.requestViewReset).toHaveBeenCalledWith({
      kind: "restart",
      keepContext: true,
      preserveInput: false
    });
    expect(deps.renderHistoryList).toHaveBeenCalledTimes(1);
    expect(deps.restoreLatest).toHaveBeenCalledTimes(1);
    expect(deps.renderInitialState).toHaveBeenCalledTimes(1);
  });

  it("apply-live：preserveInput 透传到 requestViewReset(restart) 与 restoreLatest(preserveStream)（发送闸调用链不清输入/附件且不拆在途受理）", async () => {
    chatSessionStateForTests.currentContextKey = "old-key";
    chatSessionStateForTests.contextData = makePayload();
    const payload = makePayload({ signature: "sig-4b", title: "换P后的视频" });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload })
    });

    const ok = await contextLoad.loadContextState({ silent: true, preserveInput: true });

    expect(ok).toBe(true);
    expect(deps.requestViewReset).toHaveBeenCalledWith({
      kind: "restart",
      keepContext: true,
      preserveInput: true
    });
    expect(deps.restoreLatest).toHaveBeenCalledWith({ preserveStream: true });
  });

  it("apply-live：上下文未变化（首次落地）不触发对话恢复，走 renderSuggestions", async () => {
    const payload = makePayload();
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload })
    });

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(chatSessionState.contextData).toEqual(payload);
    expect(deps.restoreLatest).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();
    expect(deps.renderSuggestions).toHaveBeenCalledTimes(1);
  });

  it("apply-live-session：实时伴看中同视频同步主上下文但不清场/不恢复，换片/分P时切换到新视频对话历史", async () => {
    chatSessionStateForTests.currentContextKey = "url:https://www.bilibili.com/video/BV1";
    chatSessionStateForTests.contextData = makePayload();
    const sameVideoPayload = makePayload({ signature: "sig-live-same", title: "同视频字幕刷新" });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload: sameVideoPayload })
    });
    deps.isLiveActive.mockReturnValue(true);

    deps.isStreaming.mockReturnValue(true);
    await contextLoad.loadContextState({ silent: true });
    expect(chatSessionState.contextData).toEqual(makePayload());
    expect(deps.requestViewReset).not.toHaveBeenCalled();

    deps.isStreaming.mockReturnValue(false);
    await contextLoad.loadContextState({ silent: true });
    expect(chatSessionState.contextData).toEqual(sameVideoPayload);
    expect(deps.requestViewReset).not.toHaveBeenCalled();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
    expect(deps.renderInitialState).not.toHaveBeenCalled();

    const switchVideoPayload = makePayload({
      signature: "sig-live-new",
      title: "新视频",
      url: "https://www.bilibili.com/video/BV2"
    });
    deps.fetchContext.mockResolvedValueOnce({
      kind: "payload",
      tabUrl: "https://www.bilibili.com/video/BV2",
      payload: switchVideoPayload
    });
    await contextLoad.loadContextState({ silent: true });
    expect(chatSessionState.contextData).toEqual(switchVideoPayload);
    expect(deps.requestViewReset).toHaveBeenCalledWith({
      kind: "restart",
      keepContext: true,
      preserveInput: false
    });
    expect(deps.restoreLatest).toHaveBeenCalledTimes(1);
    expect(deps.renderInitialState).toHaveBeenCalledTimes(1);
  });

  it("apply-live：上下文变化但流式中 → 只落地 live 快照、冻结主上下文", async () => {
    chatSessionStateForTests.currentContextKey = "old-key";
    chatSessionStateForTests.contextData = makePayload();
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload: makePayload({ signature: "sig-5", title: "新视频" }) })
    });
    deps.isStreaming.mockReturnValue(true);

    const ok = await contextLoad.loadContextState({ silent: true });

    expect(ok).toBe(true);
    expect(chatSessionState.liveContextData).not.toBeNull();
    expect(chatSessionState.contextData).toEqual(makePayload());
    expect(deps.requestViewReset).not.toHaveBeenCalled();
    expect(deps.restoreLatest).not.toHaveBeenCalled();
  });

  it("unchanged 严格判定 === true：非 true 真值不短路；true 时优先于 pinned 与流式守卫", async () => {
    const truthyPayload = makePayload({ signature: "sig-truthy", unchanged: 1 } as Partial<ChatSessionContextSnapshot>);
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload: truthyPayload })
    });
    expect(await contextLoad.loadContextState({ silent: true })).toBe(true);
    expect(chatSessionState.contextData).toEqual(truthyPayload);

    applyConversationIdentity({ meta: { pinnedContext: true } });
    deps.isStreaming.mockReturnValue(true);
    deps.renderHistoryList.mockClear();
    deps.fetchContext.mockResolvedValueOnce({
      kind: "payload",
      tabUrl: ACTIVE_TAB.url,
      payload: { unchanged: true }
    });
    expect(await contextLoad.loadContextState({ silent: true })).toBe(true);
    expect(deps.renderHistoryList).not.toHaveBeenCalled();
  });

  it("error 边界：非字符串/缺失错误回落通用文案；pinned 保留主上下文且不重置；伴看中清主上下文但不重置视图", async () => {
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "error", tabUrl: ACTIVE_TAB.url, error: { code: 7 } as unknown as string })
    });
    expect(await contextLoad.loadContextState({ silent: false })).toBe(false);
    expect(deps.requestViewReset).toHaveBeenCalledWith({ kind: "state", html: CONTEXT_READ_FAILED_MESSAGE });

    deps.requestViewReset.mockClear();
    const pinnedContext = makePayload({ signature: "sig-pinned" });
    chatSessionStateForTests.contextData = pinnedContext;
    applyConversationIdentity({ meta: { pinnedContext: true } });
    expect(await contextLoad.loadContextState({ silent: false })).toBe(false);
    expect(chatSessionState.contextData).toEqual(pinnedContext);
    expect(deps.requestViewReset).not.toHaveBeenCalled();

    applyConversationIdentity({ meta: { pinnedContext: false } });
    deps.isLiveActive.mockReturnValue(true);
    expect(await contextLoad.loadContextState({ silent: false })).toBe(false);
    expect(chatSessionState.contextData).toBeNull();
    expect(deps.requestViewReset).not.toHaveBeenCalled();
  });

  it("no-tab 边界：pinned 保留主上下文；silent 或伴看中抑制视图重置", async () => {
    const initial = makePayload({ signature: "sig-keep" });
    chatSessionStateForTests.contextData = initial;
    applyConversationIdentity({ meta: { pinnedContext: true } });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "no-tab" })
    });

    expect(await contextLoad.loadContextState({ silent: false })).toBe(false);
    expect(chatSessionState.contextData).toEqual(initial);
    expect(deps.requestViewReset).not.toHaveBeenCalled();

    applyConversationIdentity({ meta: { pinnedContext: false } });
    deps.isLiveActive.mockReturnValue(true);
    expect(await contextLoad.loadContextState({ silent: false })).toBe(false);
    expect(chatSessionState.contextData).toBeNull();
    expect(deps.requestViewReset).not.toHaveBeenCalled();

    deps.isLiveActive.mockReturnValue(false);
    expect(await contextLoad.loadContextState({ silent: false })).toBe(false);
    expect(deps.requestViewReset).toHaveBeenCalledWith({ kind: "state", html: NO_TAB_MESSAGE });
  });

  it("hasPendingUserPrompt 冻结主上下文；伴看进行中即使 pinned 也优先跟随页面视频", async () => {
    const payload = makePayload({ signature: "sig-pending" });
    const { deps, contextLoad } = makeHarness({
      fetchOutcome: () => ({ kind: "payload", tabUrl: ACTIVE_TAB.url, payload })
    });
    deps.hasPendingUserPrompt.mockReturnValue(true);

    expect(await contextLoad.loadContextState({ silent: true })).toBe(true);
    expect(chatSessionState.liveContextData).toEqual(payload);
    expect(chatSessionState.contextData).toBeNull();

    deps.hasPendingUserPrompt.mockReturnValue(false);
    applyConversationIdentity({ meta: { pinnedContext: true } });
    deps.isLiveActive.mockReturnValue(true);
    expect(await contextLoad.loadContextState({ silent: true })).toBe(true);
    expect(chatSessionState.contextData).toEqual(payload);
  });
});

describe("isPinnedContextStrict 与 ContextLoad 接口面", () => {
  it("isPinnedContextStrict 仅字面量 true 返回 true", () => {
    expect(isPinnedContextStrict({ pinnedContext: true })).toBe(true);
    expect(isPinnedContextStrict({ pinnedContext: 1 })).toBe(false);
    expect(isPinnedContextStrict({ pinnedContext: "true" })).toBe(false);
    expect(isPinnedContextStrict({})).toBe(false);
    expect(isPinnedContextStrict(undefined)).toBe(false);
    expect(isPinnedContextStrict(null)).toBe(false);
  });

  it("只暴露 loadContextState（跳转编排 openCurrentContextUrl 与 getActiveTab 已下线）", () => {
    const { contextLoad } = makeHarness();

    expect(Object.keys(contextLoad).sort()).toEqual(["loadContextState"]);
  });
});
