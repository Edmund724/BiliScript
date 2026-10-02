// tests/chat/chat-runtime-turn-settle.test.ts
// 在途回合结算（C′：流式中点历史项 = 先体面停流落盘、再切换）的 chat-runtime
// 侧契约：isTurnActive / settleActiveTurn 两键的语义，以及「settle 绝不悬挂」
// 的四条落定出口——stopped/done 终态、端口断连、闸拦下未起流、看门狗兜底。
// 另含 blocked 提前返回的双发闸复位（「静默发不出去」第二条根因，也是新判据
// isTurnActive 正确性的前提）与一条 characterization：钉住 W3 现状的内部事实
//（身份守卫在 id 已换时拦下写回、token 继续写脱离 DOM 的旧节点），它是
//「必须先结算再切换」的动机证据。
//
// 注意：chat-runtime 直接读写 chatSessionState。测试在 beforeEach 里
// resetModules 后把两个模块放进同一模块纪元导入（跨纪元会拿到两个不同的 state
// 单例），并在每个用例前重置会用到的字段。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../../extension/chat/protocol.js";

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
    resetConversationView: MockFn;
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

// 看门狗兜底窗口（chat-runtime 的 TURN_SETTLE_FALLBACK_MS；同款硬编码先例见
// chat-runtime-stream.test.ts 的 15000 慢响应计时器）。
const TURN_SETTLE_FALLBACK_MS = 4000;

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
      resetConversationView: vi.fn(),
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
  await runtime.sendMessage();
  return { deps, runtime, session: deps.ports[0] };
}

function assistantNode(deps: TestDeps): HTMLElement {
  return deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
}

// rAF 拦截：注册回调但不自动执行（token 渲染帧由用例手动驱动）
function holdRaf(): RafSpy {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1) as unknown as RafSpy;
}

// 记录 settle 是否已兑现（promise 本身 await 会挂住用例——超时兜底由断言给出）
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
  it("空闲 false；发送闸窗口（sendInFlight）与流式中 true；终态后回到 false", async () => {
    const deps = makeDeps();
    deps.input.value = "问题";
    let releaseEnsure!: (value: unknown) => void;
    deps.ensureCurrentContextForSend = vi.fn(
      () => new Promise((resolve) => { releaseEnsure = resolve; })
    );
    const runtime = createChatRuntime(deps);

    expect(runtime.isTurnActive()).toBe(false);
    expect(runtime.isStreaming()).toBe(false);

    const sending = runtime.sendMessage();
    // 闸窗口：端口未建、isStreaming() 仍 false，但发送流程已在进行
    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.isTurnActive()).toBe(true);

    releaseEnsure({ pass: true });
    await sending;
    // 流式中：activePort 已置位
    expect(runtime.isStreaming()).toBe(true);
    expect(runtime.isTurnActive()).toBe(true);

    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.isTurnActive()).toBe(false);
  });
});

describe("settleActiveTurn（在途回合结算）", () => {
  it("不在途：立即兑现、不发 stop、不碰 port", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(deps.ports).toHaveLength(0);
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalled();
  });

  it("流式中：发 stop；stopped 终态落定后才兑现（partial 写回 + 退出流式）", async () => {
    const raf = holdRaf();
    const { deps, runtime, session } = await makeRuntime("原会话的问题");

    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();

    // stop 已发出，但回合未落定：settle 不兑现
    expect(postedActions(session)).toEqual(["chat", "stop"]);
    expect(settled.settled).toBe(false);

    runtime.handleChatPortMessage({ type: "token", data: "部分正文" });
    raf.mock.calls[0][0]();
    runtime.handleChatPortMessage({ type: "stopped", reason: "已停止生成" });
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    // 落定点在终态收口之内：partial 正文与用户问题都已写回当前会话
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
    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();
    expect(postedActions(session)).toEqual(["chat", "stop"]);

    runtime.handleChatPortMessage({ type: "token", data: "整段回答" });
    runtime.handleChatPortMessage({ type: "done" });
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(chatSessionState.chatHistory[1]).toMatchObject({ role: "assistant", content: "整段回答" });
  });

  it("发送闸窗口（端口未建）：先武装，端口建立后 chat 之后立刻补发 stop", async () => {
    const deps = makeDeps();
    deps.input.value = "闸中问题";
    let releaseEnsure!: (value: unknown) => void;
    deps.ensureCurrentContextForSend = vi.fn(
      () => new Promise((resolve) => { releaseEnsure = resolve; })
    );
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendMessage();
    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);
    expect(deps.ports).toHaveLength(0);

    releaseEnsure({ pass: true });
    await sending;
    await flushMicrotasks();

    // 端口未建时无处发 stop：端口就绪后补发，且必然在 chat 之后
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
    const sending = runtime.sendMessage();
    const settled = trackSettle(runtime.settleActiveTurn());

    releaseEnsure({ pass: false, kind: "read-failed" });
    await expect(sending).resolves.toBe("blocked");
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(deps.ports).toHaveLength(0);
    expect(runtime.isTurnActive()).toBe(false);
  });

  // 「静默发不出去」的第二条根因（与本轮 W3 同型，且是新判据 isTurnActive 的
  // 前提）：blocked 的两条提前返回历史上直接 return，没有任何出口复位 sendInFlight
  // → 此后每次发送都被入口双发闸判 "ignored"，用户输入端毫无反馈。
  it("blocked（闸未放行 / 无平台）后复位双发闸：下一次发送不再被判 ignored", async () => {
    const blockedDeps = makeDeps();
    blockedDeps.input.value = "被拦下的问题";
    blockedDeps.ensureCurrentContextForSend = vi.fn(async () => ({ pass: false, kind: "no-subtitle" }));
    const blockedRuntime = createChatRuntime(blockedDeps);
    await expect(blockedRuntime.sendMessage()).resolves.toBe("blocked");
    expect(blockedRuntime.isTurnActive()).toBe(false);

    blockedDeps.ensureCurrentContextForSend = vi.fn(async () => ({ pass: true }));
    blockedDeps.input.value = "字幕就绪后的第二问";
    await expect(blockedRuntime.sendMessage()).resolves.toBe("accepted");
    expect(blockedDeps.ports).toHaveLength(1);

    const noProviderDeps = makeDeps();
    noProviderDeps.input.value = "无平台时的发送";
    noProviderDeps.getProviderId = () => "";
    const noProviderRuntime = createChatRuntime(noProviderDeps);
    await expect(noProviderRuntime.sendMessage()).resolves.toBe("blocked");
    expect(noProviderRuntime.isTurnActive()).toBe(false);

    noProviderDeps.getProviderId = () => "test-provider";
    noProviderDeps.input.value = "配置平台后的发送";
    await expect(noProviderRuntime.sendMessage()).resolves.toBe("accepted");
    expect(noProviderDeps.ports).toHaveLength(1);
  });

  it("端口断连（offscreen 不回终态）：settle 由断连兜底兑现", async () => {
    const { deps, runtime, session } = await makeRuntime("问题");
    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);

    // offscreen 文档被回收：不回 stopped，直接断连
    session.listeners.disconnect.forEach((fn) => fn());
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(runtime.isTurnActive()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, expect.anything());
  });

  it("看门狗：既不回终态也不断连时，兜底窗口后兑现并断开端口（settle 绝不悬挂）", async () => {
    vi.useFakeTimers();
    const { deps, runtime, session } = await makeRuntime("问题");
    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);

    vi.advanceTimersByTime(TURN_SETTLE_FALLBACK_MS);
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isTurnActive()).toBe(false);
  });

  it("重入（同一次在途回合两次 settle）：两个请求一起兑现", async () => {
    const { runtime } = await makeRuntime("问题");
    const first = trackSettle(runtime.settleActiveTurn());
    const second = trackSettle(runtime.settleActiveTurn());
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
    const settled = trackSettle(runtime.settleActiveTurn());
    await flushMicrotasks();
    expect(settled.settled).toBe(false);

    runtime.resetStreamState();
    await flushMicrotasks();

    expect(settled.settled).toBe(true);
    expect(runtime.isTurnActive()).toBe(false);
  });
});

describe("W3 现状 characterization（动机证据，非新行为）", () => {
  // 钉住现状的内部事实：会话身份已被 applyById 换掉后，在途流继续把 token 写进
  // 脱离 DOM 的旧节点，终态写回又被 store 身份守卫拦下——一次历史点击 =
  // 答案静默丢弃。C′ 因此必须把切换挡在「回合落定」之后，而不是去改这条守卫。
  it("身份已换 + 消息区已重建：token 写脱离节点、done 不写回 chatHistory", async () => {
    const raf = holdRaf();
    const { deps, runtime } = await makeRuntime("原会话的问题");
    const node = assistantNode(deps);

    // 模拟 applyById 的两半：身份换到另一会话 + 回放清场重建消息区
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
