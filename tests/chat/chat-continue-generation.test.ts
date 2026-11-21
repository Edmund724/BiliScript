import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { ChatPortMessage, CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";
import { OFFSCREEN_CHAT_PORT_NAME } from "../../extension/chat/protocol.js";

type MockFn = Mock<(...args: any[]) => any>;
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

function feed(runtime: ChatRuntime, msg: ChatPortMessage) {
  runtime.handleChatPortMessage(msg);
}

beforeEach(async () => {
  resetModuleState();
  const stateMod = await import("../../extension/chat/chat-state.js");
  chatSessionState = stateMod.chatSessionState;
  resetChatSessionStateForTests = stateMod.resetChatSessionStateForTests;
  resetChatSessionStateForTests();
  const runtimeMod = await import("../../extension/chat/chat-runtime.js");
  createChatRuntime = runtimeMod.createChatRuntime;
});

describe("Ticket 04: 原地无缝“继续生成”流式编排", () => {
  it("Branch A: 正文为空时（思考阶段中断）点击“继续生成”，原地重新发起原问题，流式写入并合并落盘", async () => {
    const deps = makeDeps();
    deps.input.value = "讲个笑话";
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn(deps.input.value);
    expect(deps.ports).toHaveLength(1);

    feed(runtime, { type: "reasoning", data: "正在思考一个关于程序员的笑话..." });
    feed(runtime, { type: "stopped", reason: "用户停止" });

    const assistantEl = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    expect(assistantEl).toBeTruthy();
    const stoppedBadge = assistantEl.querySelector(".chat-msg-stopped");
    expect(stoppedBadge?.textContent).toBe("用户停止");
    const continueBtn = assistantEl.querySelector<HTMLButtonElement>(".chat-msg-continue-btn");
    expect(continueBtn).toBeTruthy();

    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "",
      thinking: "正在思考一个关于程序员的笑话...",
      stopped: true
    });

    deps.store.persistCurrent.mockClear();

    continueBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));

    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-actions")).toBeNull();
    expect(assistantEl.classList.contains("chat-msg-streaming")).toBe(true);

    const secondReq = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(secondReq.prompt).toBe("讲个笑话");
    expect(secondReq.history).toEqual([]);

    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);

    feed(runtime, { type: "token", data: "为什么程序员总分不清万圣节和圣诞节？" });
    feed(runtime, { type: "token", data: "因为 Oct 31 == Dec 25。" });
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(chatSessionState.chatHistory[0]).toEqual({
      role: "user",
      content: "讲个笑话"
    });
    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "为什么程序员总分不清万圣节和圣诞节？因为 Oct 31 == Dec 25。",
      thinking: "正在思考一个关于程序员的笑话..."
    });
    expect(deps.store.persistCurrent).toHaveBeenCalled();

    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-continue-btn")).toBeNull();
    const actionBtns = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect(actionBtns).toHaveLength(4);
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.textContent).toContain("为什么程序员总分不清万圣节和圣诞节？因为 Oct 31 == Dec 25。");
    expect(assistantEl.querySelector(".chat-thinking")?.classList.contains("chat-thinking-collapsed")).toBe(true);
  });

  it("Branch B: 有部分正文时点击“继续生成”，向模型发送“继续”，原地追加增量并合并落盘", async () => {
    const deps = makeDeps();
    deps.input.value = "列出三个常用排序算法";
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn(deps.input.value);
    feed(runtime, { type: "token", data: "1. 冒泡排序\n2. 插入排序" });
    feed(runtime, { type: "stopped", reason: "网络中断" });

    const assistantEl = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("网络中断");
    const continueBtn = assistantEl.querySelector<HTMLButtonElement>(".chat-msg-continue-btn");
    expect(continueBtn).toBeTruthy();

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "列出三个常用排序算法" },
      { role: "assistant", content: "1. 冒泡排序\n2. 插入排序", stopped: true }
    ]);

    deps.store.persistCurrent.mockClear();

    continueBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));

    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-actions")).toBeNull();
    expect(assistantEl.classList.contains("chat-msg-streaming")).toBe(true);

    const continueReq = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(continueReq.prompt).toBe("继续");
    expect(continueReq.history).toEqual([
      { role: "user", content: "列出三个常用排序算法" },
      { role: "assistant", content: "1. 冒泡排序\n2. 插入排序" }
    ]);

    feed(runtime, { type: "token", data: "\n3. 快速排序" });
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(chatSessionState.chatHistory[0]).toEqual({
      role: "user",
      content: "列出三个常用排序算法"
    });
    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "1. 冒泡排序\n2. 插入排序\n3. 快速排序"
    });
    expect(chatSessionState.chatHistory[1].stopped).toBeUndefined();
    expect(deps.store.persistCurrent).toHaveBeenCalled();

    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-continue-btn")).toBeNull();
    expect(assistantEl.querySelectorAll(".chat-msg-action-btn")).toHaveLength(4);
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.innerHTML).toContain("快速排序");
  });

  it("多轮历史下的 Branch B 继续生成：发送正确的完整前置上下文", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("你好");
    feed(runtime, { type: "token", data: "你好！很高兴为你服务。" });
    feed(runtime, { type: "done" });

    await runtime.sendTurn("介绍一下 Python");
    feed(runtime, { type: "token", data: "Python 是一种简洁的" });
    feed(runtime, { type: "stopped", reason: "用户停止" });

    const assistants = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant");
    expect(assistants).toHaveLength(2);

    const continueBtn = assistants[1].querySelector<HTMLButtonElement>(".chat-msg-continue-btn");
    expect(continueBtn).toBeTruthy();

    continueBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    const req = deps.ports[2].port.postMessage.mock.calls[0][0];
    expect(req.prompt).toBe("继续");
    expect(req.history).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！很高兴为你服务。" },
      { role: "user", content: "介绍一下 Python" },
      { role: "assistant", content: "Python 是一种简洁的" }
    ]);

    feed(runtime, { type: "token", data: "高级编程语言。" });
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！很高兴为你服务。" },
      { role: "user", content: "介绍一下 Python" },
      { role: "assistant", content: "Python 是一种简洁的高级编程语言。" }
    ]);
  });

  it("继续生成过程中再次被中断：保留已合并的全部正文，标记已停止，显示重试与继续按钮", async () => {
    const deps = makeDeps();
    deps.input.value = "步骤说明";
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn(deps.input.value);
    feed(runtime, { type: "token", data: "第一步" });
    feed(runtime, { type: "stopped", reason: "停止1" });

    const assistantEl = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    assistantEl.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));

    feed(runtime, { type: "token", data: " -> 第二步" });

    runtime.stopActiveStream();
    feed(runtime, { type: "stopped", reason: "再次中断" });

    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "第一步 -> 第二步",
      stopped: true
    });

    expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("再次中断");
    const actions = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect([...actions].map((button) => button.getAttribute("aria-label"))).toEqual([
      "复制回复", "朗读回答", "重新生成", "继续生成", "导出 Markdown"
    ]);
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.textContent).toContain("第一步 -> 第二步");
  });

  it("继续生成运行期间联动禁用操作按钮，防止重复点击并发重入", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "第一答" });
    feed(runtime, { type: "done" });

    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答部分内容" });
    feed(runtime, { type: "stopped", reason: "用户停止" });

    const assistants = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant");
    expect(assistants).toHaveLength(2);

    const firstRegenBtn = assistants[0].querySelector<HTMLButtonElement>(".chat-msg-regenerate-btn")!;
    const secondContinueBtn = assistants[1].querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!;

    expect(firstRegenBtn.disabled).toBe(false);
    expect(secondContinueBtn.disabled).toBe(false);

    secondContinueBtn.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    expect(runtime.isTurnActive()).toBe(true);
    expect(firstRegenBtn.disabled).toBe(true);

    firstRegenBtn.click();
    secondContinueBtn.click();
    expect(deps.ports).toHaveLength(3);

    feed(runtime, { type: "done" });
    expect(runtime.isTurnActive()).toBe(false);
    expect(firstRegenBtn.disabled).toBe(false);
  });

  it("继续生成建连失败或异常中断：恢复原卡片内容与状态，弹出提示，不破坏原历史", async () => {
    const deps = makeDeps();
    deps.input.value = "原问题";
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn(deps.input.value);
    feed(runtime, { type: "token", data: "原部分正文" });
    feed(runtime, { type: "stopped", reason: "初始停止" });

    const assistantEl = deps.messages.querySelector(".chat-msg-assistant") as HTMLDivElement;
    const continueBtn = assistantEl.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!;

    deps.connectPort.mockRejectedValueOnce(new Error("offscreen 端口建立失败"));

    continueBtn.click();

    await vi.waitFor(() => {
      expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("继续生成失败：offscreen 端口建立失败", 4000);
    });

    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "原部分正文",
      stopped: true
    });

    expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("初始停止");
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.textContent).toContain("原部分正文");
    expect(assistantEl.querySelectorAll(".chat-msg-action-btn")).toHaveLength(5);
  });

  it("继续生成较早的已停止回答（Branch B）：生成中隐藏后续消息，完成后合并落盘并永久删去后续", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "第一答前半" });
    feed(runtime, { type: "stopped", reason: "初停" });

    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答" });
    feed(runtime, { type: "done" });

    const firstAssistant = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant")[0];
    firstAssistant.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(2);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-user")[1].hidden).toBe(true);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1].hidden).toBe(true);

    feed(runtime, { type: "token", data: "，第一答后半" });
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答前半，第一答后半" }
    ]);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
    expect(firstAssistant.querySelector(".chat-msg-assistant-body")?.textContent).toContain("第一答前半，第一答后半");
  });

  it("继续生成较早的仅思考已停止回答（Branch A）：完成后删去后续消息与历史", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "reasoning", data: "先想一下" });
    feed(runtime, { type: "stopped", reason: "思考中断" });

    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答" });
    feed(runtime, { type: "done" });

    const firstAssistant = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant")[0];
    firstAssistant.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-user")[1].hidden).toBe(true);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1].hidden).toBe(true);

    feed(runtime, { type: "token", data: "第一答正文" });
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答正文", thinking: "先想一下" }
    ]);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
  });

  it("继续生成较早回答失败：恢复原卡片与后续消息，历史不变", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "第一答前半" });
    feed(runtime, { type: "stopped", reason: "初停" });

    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答" });
    feed(runtime, { type: "done" });

    const firstAssistant = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant")[0];
    firstAssistant.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    feed(runtime, { type: "token", data: "半截新内容" });
    feed(runtime, { type: "error", error: "网络断开" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答前半", stopped: true },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答" }
    ]);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(2);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-user")[1].hidden).toBe(false);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1].hidden).toBe(false);
    expect(firstAssistant.querySelector(".chat-msg-stopped")?.textContent).toBe("初停");
    expect(firstAssistant.querySelector(".chat-msg-assistant-body")?.textContent).not.toContain("半截新内容");
  });

  it("继续生成较早回答在零新增输出时被停止：恢复原卡片与后续消息", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "第一答前半" });
    feed(runtime, { type: "stopped", reason: "初停" });

    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答" });
    feed(runtime, { type: "done" });

    const firstAssistant = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant")[0];
    firstAssistant.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    feed(runtime, { type: "stopped", reason: "立即停止" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答前半", stopped: true },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答" }
    ]);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(2);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-user")[1].hidden).toBe(false);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1].hidden).toBe(false);
    expect(firstAssistant.querySelector(".chat-msg-stopped")?.textContent).toBe("初停");
    expect(firstAssistant.querySelector(".chat-msg-continue-btn")).toBeTruthy();
  });

  it("继续生成较早回答收到新增输出后被停止：保留合并内容并永久删去后续消息", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "第一答前半" });
    feed(runtime, { type: "stopped", reason: "初停" });

    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答" });
    feed(runtime, { type: "done" });

    const firstAssistant = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant")[0];
    firstAssistant.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    feed(runtime, { type: "token", data: "，新追加" });
    feed(runtime, { type: "stopped", reason: "再次停止" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答前半，新追加", stopped: true }
    ]);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
    expect(firstAssistant.querySelector(".chat-msg-stopped")?.textContent).toBe("再次停止");
  });

  it("跨视频继续生成弹出上下文确认并沿用原上下文（不带截帧工具），取消时恢复 DOM 与 scrollTop", async () => {
    const stateMod = await import("../../extension/chat/chat-state.js");
    stateMod.chatSessionStateForTests.currentContextKey = "video:BV1old|1";
    stateMod.chatSessionStateForTests.liveContextKey = "video:BV1old|1";
    stateMod.chatSessionStateForTests.contextData = {
      title: "旧视频",
      bvid: "BV1old",
      cid: "1",
      url: "https://www.bilibili.com/video/BV1old",
      isVideoContext: true,
      subtitleBody: [{ from: 0, to: 5, content: "旧字幕" }]
    };
    const deps = makeDeps();
    (deps as CreateChatRuntimeDeps).canUseVideoFrameTool = vi.fn(async () => true);
    const confirmFn = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    (deps as CreateChatRuntimeDeps).confirmRegenerationContext = confirmFn;
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "半句" });
    feed(runtime, { type: "stopped", reason: "已停止" });

    stateMod.chatSessionStateForTests.liveContextKey = "video:BV1new|1";
    deps.messages.scrollTop = 180;
    const assistantEl = deps.messages.querySelector<HTMLDivElement>(".chat-msg-assistant")!;

    assistantEl.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("已停止"));
    expect(deps.messages.scrollTop).toBe(180);
    expect(deps.ports).toHaveLength(1);

    assistantEl.querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!.click();
    await vi.waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));
    const posted = deps.ports[1].port.postMessage.mock.calls[0][0] as {
      contextKey?: string;
      context?: { bvid?: string };
      videoFrameToolEnabled?: boolean;
    };
    expect(posted.contextKey).toBe("video:BV1old|1");
    expect(posted.context?.bvid).toBe("BV1old");
    expect(posted).not.toHaveProperty("videoFrameToolEnabled");
  });
});
