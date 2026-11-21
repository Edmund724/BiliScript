import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../../extension/chat/protocol.js";
import { TURN_SETTLE_FALLBACK_MS } from "../../extension/chat/turn-lifecycle.js";

type MockFn = Mock<(...args: any[]) => any>;
type RafSpy = MockInstance<(callback: () => void) => number>;
type TestPort = ReturnType<typeof makePort>;
type ChatRuntime = ReturnType<typeof createChatRuntime>;

interface TestDeps extends CreateChatRuntimeDeps {
  ports: TestPort[];
  store: { persistCurrent: MockFn; isCurrent: MockFn };
  ui: {
    setStreamingUiState: MockFn;
    showConversationContextNotice: MockFn;
    removeConversationContextNotice: MockFn;
    hideHistoryPopover: MockFn;
    removeCenteredState: MockFn;
    removeSuggestions: MockFn;
    requestViewReset: MockFn;
    autosizeInput: MockFn;
  };
  ensureCurrentContextForSend: MockFn;
  connectPort: MockFn;
}

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: ChatSessionState;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

function makePort() {
  const listeners: { message: ((msg: unknown) => void)[]; disconnect: (() => void)[] } = {
    message: [],
    disconnect: []
  };
  return {
    port: {
      name: OFFSCREEN_CHAT_PORT_NAME,
      onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

function makeDeps(): TestDeps {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports: TestPort[] = [];
  return {
    messages,
    input,
    ports,
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
      requestViewReset: vi.fn(),
      autosizeInput: vi.fn()
    },
    ensureCurrentContextForSend: vi.fn(async () => ({ pass: true })),
    getProviderId: () => "test-provider",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port;
    })
  };
}

async function makeRuntime(text = "帮我写个标题") {
  const deps = makeDeps();
  deps.input.value = text;
  const runtime = createChatRuntime(deps);
  await runtime.sendTurn(deps.input.value);
  return { deps, runtime, session: deps.ports[0] };
}

function assistantNode(deps: TestDeps): HTMLElement {
  return deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
}

function holdRaf(): RafSpy {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1) as unknown as RafSpy;
}

function trackSettle(promise: Promise<void>): { readonly settled: boolean } {
  const state = { settled: false };
  void promise.then(() => {
    state.settled = true;
  });
  return state;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const postedActions = (session: TestPort): unknown[] =>
  session.port.postMessage.mock.calls.map((call) => (call[0] as { action?: unknown })?.action);

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState, applyConversationIdentity, chatSessionStateForTests, resetChatSessionStateForTests } =
    await import("../../extension/chat/chat-state.js"));
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isTurnActive（在途回合判据）", () => {
  it("空闲 false；发送闸窗口（受理窗口）与流式中 true；终态后回到 false", async () => {
    const deps = makeDeps();
    deps.input.value = "问题";
    let releaseEnsure!: (value: unknown) => void;
    deps.ensureCurrentContextForSend = vi.fn(
      () => new Promise((resolve) => { releaseEnsure = resolve; })
    );
    const runtime = createChatRuntime(deps);

    expect(runtime.isTurnActive()).toBe(false);
    expect(runtime.isStreaming()).toBe(false);

    const sending = runtime.sendTurn("问题");
    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.isTurnActive()).toBe(true);

    releaseEnsure({ pass: true });
    await sending;
    expect(runtime.isStreaming()).toBe(true);
    expect(runtime.isTurnActive()).toBe(true);

    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.isTurnActive()).toBe(false);
  });
});

describe("stopActiveStream 停止中状态", () => {
  it("点击停止立即进入停止中，stopped 终态后退出流式", async () => {
    const { deps, runtime, session } = await makeRuntime("问题");
    deps.ui.setStreamingUiState.mockClear();

    runtime.stopActiveStream();

    expect(deps.ui.setStreamingUiState).toHaveBeenCalledWith(true, { stopping: true });
    expect(postedActions(session)).toEqual(["chat", "stop"]);
    expect(runtime.isTurnActive()).toBe(true);

    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, { stopping: false });
    expect(runtime.isTurnActive()).toBe(false);
  });
});

describe("settleTurn（在途回合结算）", () => {
  it("不在途：立即兑现、不发 stop、不碰 port", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(deps.ports).toHaveLength(0);
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalled();
  });

  it("流式中：发 stop；stopped 终态落定后才兑现（partial 写回 + 退出流式）", async () => {
    const raf = holdRaf();
    const { deps, runtime, session } = await makeRuntime("原会话的问题");

    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();

    expect(postedActions(session)).toEqual(["chat", "stop"]);
    expect(settled.settled).toBe(false);

    runtime.handleChatPortMessage({ type: "token", data: "部分正文" });
    raf.mock.calls[0][0]();
    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(chatSessionState.chatHistory.map((m) => [m.role, m.content])).toEqual([
      ["user", "原会话的问题"],
      ["assistant", "部分正文"]
    ]);
    expect(deps.store.persistCurrent).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.isTurnActive()).toBe(false);
  });

  it("done 与 stop 竞态：done 先到也结算（终态出口共用一个落定点）", async () => {
    const { runtime, session } = await makeRuntime("问题");
    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();
    expect(postedActions(session)).toEqual(["chat", "stop"]);

    runtime.handleChatPortMessage({ type: "token", data: "整段回答" });
    runtime.handleChatPortMessage({ type: "done" });
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(chatSessionState.chatHistory[1]).toMatchObject({ role: "assistant", content: "整段回答" });
  });

  it("发送闸窗口（端口未建）：先登记，端口建立后 chat 之后立刻补发 stop", async () => {
    const deps = makeDeps();
    deps.input.value = "闸中问题";
    let releaseEnsure!: (value: unknown) => void;
    deps.ensureCurrentContextForSend = vi.fn(
      () => new Promise((resolve) => { releaseEnsure = resolve; })
    );
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn("闸中问题");
    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);
    expect(deps.ports).toHaveLength(0);

    releaseEnsure({ pass: true });
    await sending;
    await flushMicrotasks();

    const session = deps.ports[0];
    expect(postedActions(session)).toEqual(["chat", "stop"]);
    expect(settled.settled).toBe(false);

    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    await flushMicrotasks();
    expect(settled.settled).toBe(true);
  });

  it("闸未放行（blocked，未起流）：settle 兑现，不悬挂", async () => {
    const deps = makeDeps();
    deps.input.value = "被拦下的问题";
    let releaseEnsure!: (value: unknown) => void;
    deps.ensureCurrentContextForSend = vi.fn(
      () => new Promise((resolve) => { releaseEnsure = resolve; })
    );
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn("被拦下的问题");
    const settled = trackSettle(runtime.settleTurn());

    releaseEnsure({ pass: false, kind: "read-failed" });
    await expect(sending).resolves.toBe("blocked");
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(deps.ports).toHaveLength(0);
    expect(runtime.isTurnActive()).toBe(false);
  });

  it("blocked（闸未放行 / 无平台）后复位双发闸：下一次发送不再被判 ignored", async () => {
    const blockedDeps = makeDeps();
    blockedDeps.input.value = "被拦下的问题";
    blockedDeps.ensureCurrentContextForSend = vi.fn(async () => ({ pass: false, kind: "no-subtitle" }));
    const blockedRuntime = createChatRuntime(blockedDeps);
    await expect(blockedRuntime.sendTurn("被拦下的问题")).resolves.toBe("blocked");
    expect(blockedRuntime.isTurnActive()).toBe(false);

    blockedDeps.ensureCurrentContextForSend = vi.fn(async () => ({ pass: true }));
    blockedDeps.input.value = "字幕就绪后的第二问";
    await expect(blockedRuntime.sendTurn("字幕就绪后的第二问")).resolves.toBe("accepted");
    expect(blockedDeps.ports).toHaveLength(1);

    const noProviderDeps = makeDeps();
    noProviderDeps.input.value = "无平台时的发送";
    noProviderDeps.getProviderId = () => "";
    const noProviderRuntime = createChatRuntime(noProviderDeps);
    await expect(noProviderRuntime.sendTurn("无平台时的发送")).resolves.toBe("blocked");
    expect(noProviderRuntime.isTurnActive()).toBe(false);

    noProviderDeps.getProviderId = () => "test-provider";
    noProviderDeps.input.value = "配置平台后的发送";
    await expect(noProviderRuntime.sendTurn("配置平台后的发送")).resolves.toBe("accepted");
    expect(noProviderDeps.ports).toHaveLength(1);
  });

  it("端口断连（offscreen 不回终态）：settle 由断连兜底兑现", async () => {
    const { deps, runtime, session } = await makeRuntime("问题");
    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);

    session.listeners.disconnect.forEach((fn) => fn());
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(runtime.isTurnActive()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, expect.anything());
  });

  it("看门狗：既不回终态也不断连时，兜底窗口后兑现并断开端口（settle 绝不悬挂）", async () => {
    vi.useFakeTimers();
    const { deps, runtime, session } = await makeRuntime("问题");
    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);

    vi.advanceTimersByTime(TURN_SETTLE_FALLBACK_MS);
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isTurnActive()).toBe(false);
  });

  it("重入（同一次在途回合两次 settleTurn）：两个请求一起兑现", async () => {
    const { runtime } = await makeRuntime("问题");
    const first = trackSettle(runtime.settleTurn());
    const second = trackSettle(runtime.settleTurn());
    await flushMicrotasks();
    expect(first.settled).toBe(false);
    expect(second.settled).toBe(false);

    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    await flushMicrotasks();
    expect(first.settled).toBe(true);
    expect(second.settled).toBe(true);
  });

  it("拆除类入口（resetStreamState）清场时：已武装的 settle 一并兑现（不留悬挂）", async () => {
    const { runtime } = await makeRuntime("问题");
    const settled = trackSettle(runtime.settleTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);

    runtime.resetStreamState();
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(runtime.isTurnActive()).toBe(false);
  });
});

describe("联网搜索授权与视图销毁", () => {
  function stubSearchSettings() {
    const sent: Array<Record<string, unknown>> = [];
    const settings = { webSearchEnabled: true, searchOptInNoticeAcknowledged: false };
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: (msg: Record<string, unknown>, cb?: (response: unknown) => void) => {
          sent.push(msg);
          if (msg.type === "get-settings") {
            cb?.({ ok: true, settings: { ...settings } });
          } else if (msg.type === "resolve-search-provider") {
            cb?.({ ok: true });
          } else if (msg.type === "save-settings") {
            Object.assign(settings, msg.settings);
            cb?.({ ok: true });
          } else {
            cb?.({ ok: true });
          }
        }
      }
    });
    chatSessionStateForTests.webSearchEnabled = true;
    return { sent, settings };
  }

  function mountChatView(deps: TestDeps): void {
    const view = document.createElement("div");
    view.id = "biliscript-reading-view";
    view.appendChild(deps.messages);
    document.body.appendChild(view);
  }

  it("授权只在字幕闸通过后发生，且同意前不上屏、不建端口", async () => {
    const deps = makeDeps();
    mountChatView(deps);
    const { sent } = stubSearchSettings();
    let releaseGate!: (value: { pass: true }) => void;
    deps.ensureCurrentContextForSend = vi.fn(() => new Promise((resolve) => { releaseGate = resolve; }));
    deps.input.value = "问题";
    const runtime = createChatRuntime(deps);

    const sending = runtime.sendTurn("问题");
    await flushMicrotasks();
    expect(document.querySelector(".confirm-dialog")).toBeNull();
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);

    releaseGate({ pass: true });
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(deps.ports).toHaveLength(0);

    document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!.click();
    await expect(sending).resolves.toBe("accepted");
    expect(deps.messages.querySelector(".chat-msg-user")).not.toBeNull();
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ webSearchEnabled: true }));
    expect(sent).toContainEqual({ type: "save-settings", settings: { searchOptInNoticeAcknowledged: true } });
    expect(sent.some((m) => m.type === "save-settings" && "webSearchEnabled" in (m.settings as object))).toBe(false);
  });

  it("拒绝后本轮无搜索继续，并在输入区提示如何重新开启", async () => {
    const deps = makeDeps();
    mountChatView(deps);
    const { sent } = stubSearchSettings();
    deps.input.value = "问题";
    const runtime = createChatRuntime(deps);

    const sending = runtime.sendTurn("问题");
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel")!.click();

    await expect(sending).resolves.toBe("accepted");
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ webSearchEnabled: false }));
    expect(sent).toContainEqual({ type: "save-settings", settings: { webSearchEnabled: false } });
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(
      "已关闭联网搜索，可在输入区重新开启",
      4000,
      { placement: "input" }
    );
  });

  it("授权中销毁：取消回合、不写视图或偏好，重开后发送不被 ignored", async () => {
    const deps = makeDeps();
    mountChatView(deps);
    const { sent } = stubSearchSettings();
    deps.input.value = "问题";
    const runtime = createChatRuntime(deps);
    const { dismissConfirmDialog } = await import("../../extension/ui/confirm-dialog.js");

    const sending = runtime.sendTurn("问题");
    await vi.waitFor(() => expect(document.querySelector(".confirm-dialog")).not.toBeNull());
    dismissConfirmDialog();
    runtime.resetStreamState();

    await expect(sending).resolves.toBe("blocked");
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(deps.ports).toHaveLength(0);
    expect(runtime.isTurnActive()).toBe(false);
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);

    chatSessionStateForTests.webSearchEnabled = false;
    deps.input.value = "重开后的问题";
    await expect(runtime.sendTurn("重开后的问题")).resolves.toBe("accepted");
    expect(deps.ports).toHaveLength(1);
  });
});

describe("W3 现状 characterization（动机证据，非新行为）", () => {
  it("身份已换 + 消息区已重建：token 写脱离节点、done 不写回 chatHistory", async () => {
    const raf = holdRaf();
    const { deps, runtime } = await makeRuntime("原会话的问题");
    const node = assistantNode(deps);

    applyConversationIdentity({ id: "other-conversation", history: [] });
    deps.messages.innerHTML = "";

    runtime.handleChatPortMessage({ type: "token", data: "脱离后的正文" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("脱离后的正文");
    expect(deps.messages.querySelector(".chat-stream-tail")).toBeNull();

    runtime.handleChatPortMessage({ type: "done" });
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
  });
});
