// tests/chat/chat-continue-generation.test.ts
// Ticket 04: 原地无缝“继续生成”流式编排测试

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

    // 发起第一轮
    await runtime.sendTurn(deps.input.value);
    expect(deps.ports).toHaveLength(1);

    // 仅输出思考文本后被用户中断
    feed(runtime, { type: "reasoning", data: "正在思考一个关于程序员的笑话..." });
    feed(runtime, { type: "stopped", reason: "用户停止" });

    // 校验中断态：正文为空，思考保留，卡片呈现停止徽标与重试/继续生成按钮
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

    // 点击“继续生成”
    continueBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));

    // 验证 UI 清理停止徽标与操作栏，卡片恢复流式接收态
    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-actions")).toBeNull();
    expect(assistantEl.classList.contains("chat-msg-streaming")).toBe(true);

    // 验证发给模型的请求协议：原问题重跑，上下文为该用户问题之前的历史（空）
    const secondReq = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(secondReq.prompt).toBe("讲个笑话");
    expect(secondReq.history).toEqual([]);

    // 验证没有多加一条 user 消息
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);

    // 模型流式吐出正文
    feed(runtime, { type: "token", data: "为什么程序员总分不清万圣节和圣诞节？" });
    feed(runtime, { type: "token", data: "因为 Oct 31 == Dec 25。" });
    feed(runtime, { type: "done" });

    // 验证完成态：更新为一条完整助手回答并落盘，stopped 标记清除
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

    // 验证 DOM：终态渲染，恢复4个正常操作按钮，停止徽标与继续按钮消失
    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-continue-btn")).toBeNull();
    const actionBtns = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect(actionBtns).toHaveLength(4);
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.textContent).toContain("为什么程序员总分不清万圣节和圣诞节？因为 Oct 31 == Dec 25。");
    // 思考过程已折叠保留
    expect(assistantEl.querySelector(".chat-thinking")?.classList.contains("chat-thinking-collapsed")).toBe(true);
  });

  it("Branch B: 有部分正文时点击“继续生成”，向模型发送“继续”，原地追加增量并合并落盘", async () => {
    const deps = makeDeps();
    deps.input.value = "列出三个常用排序算法";
    const runtime = createChatRuntime(deps);

    // 发起第一轮
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

    // 点击“继续生成”
    continueBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));

    // 验证 UI 清理与流式接收态
    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-actions")).toBeNull();
    expect(assistantEl.classList.contains("chat-msg-streaming")).toBe(true);

    // 验证请求协议：prompt 为 "继续"，history 包含当前用户问题及已有未完成回答
    const continueReq = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(continueReq.prompt).toBe("继续");
    expect(continueReq.history).toEqual([
      { role: "user", content: "列出三个常用排序算法" },
      { role: "assistant", content: "1. 冒泡排序\n2. 插入排序" }
    ]);

    // 模型继续吐出剩余内容
    feed(runtime, { type: "token", data: "\n3. 快速排序" });
    feed(runtime, { type: "done" });

    // 验证合并落盘：chatHistory 依然只有 2 条消息（不产生额外的“继续”轮次），正文合并为完整回答
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

    // 验证 DOM：终态渲染完整合并内容
    expect(assistantEl.querySelector(".chat-msg-stopped")).toBeNull();
    expect(assistantEl.querySelector(".chat-msg-continue-btn")).toBeNull();
    expect(assistantEl.querySelectorAll(".chat-msg-action-btn")).toHaveLength(4);
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.innerHTML).toContain("快速排序");
  });

  it("多轮历史下的 Branch B 继续生成：发送正确的完整前置上下文", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    // 第一轮正常完成
    await runtime.sendTurn("你好");
    feed(runtime, { type: "token", data: "你好！很高兴为你服务。" });
    feed(runtime, { type: "done" });

    // 第二轮中断
    await runtime.sendTurn("介绍一下 Python");
    feed(runtime, { type: "token", data: "Python 是一种简洁的" });
    feed(runtime, { type: "stopped", reason: "用户停止" });

    const assistants = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant");
    expect(assistants).toHaveLength(2);

    const continueBtn = assistants[1].querySelector<HTMLButtonElement>(".chat-msg-continue-btn");
    expect(continueBtn).toBeTruthy();

    continueBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    // 验证发送的 history 包含第1轮一问一答 + 第2轮问 + 第2轮已有的 partial 回答
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

    // 续写流吐出一部分 token
    feed(runtime, { type: "token", data: " -> 第二步" });

    // 用户再次手动停止
    runtime.stopActiveStream();
    feed(runtime, { type: "stopped", reason: "再次中断" });

    // 验证历史中保存了合并后的文本且保持 stopped: true
    expect(chatSessionState.chatHistory).toHaveLength(2);
    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "第一步 -> 第二步",
      stopped: true
    });

    // 验证 DOM 维持中断态并保留合并正文
    expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("再次中断");
    const actions = assistantEl.querySelectorAll<HTMLButtonElement>(".chat-msg-action-btn");
    expect(actions).toHaveLength(2);
    expect(actions[0].getAttribute("aria-label")).toBe("重新生成");
    expect(actions[1].getAttribute("aria-label")).toBe("继续生成");
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.textContent).toContain("第一步 -> 第二步");
  });

  it("继续生成运行期间联动禁用操作按钮，防止重复点击并发重入", async () => {
    const deps = makeDeps();
    const runtime = createChatRuntime(deps);

    // 第一轮正常完成，卡片上有“重新生成”按钮
    await runtime.sendTurn("第一问");
    feed(runtime, { type: "token", data: "第一答" });
    feed(runtime, { type: "done" });

    // 第二轮中断
    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答部分内容" });
    feed(runtime, { type: "stopped", reason: "用户停止" });

    const assistants = deps.messages.querySelectorAll<HTMLDivElement>(".chat-msg-assistant");
    expect(assistants).toHaveLength(2);

    const firstRegenBtn = assistants[0].querySelector<HTMLButtonElement>(".chat-msg-regenerate-btn")!;
    const secondContinueBtn = assistants[1].querySelector<HTMLButtonElement>(".chat-msg-continue-btn")!;

    expect(firstRegenBtn.disabled).toBe(false);
    expect(secondContinueBtn.disabled).toBe(false);

    // 触发继续生成
    secondContinueBtn.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));

    // 运行期间：当前在途流式中，其他卡片的重试/继续按钮全部禁用
    expect(runtime.isTurnActive()).toBe(true);
    expect(firstRegenBtn.disabled).toBe(true);

    // 尝试重入点击被忽略（端口数不会增长）
    firstRegenBtn.click();
    secondContinueBtn.click();
    expect(deps.ports).toHaveLength(3);

    // 结束流
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

    // 模拟下次建连失败
    deps.connectPort.mockRejectedValueOnce(new Error("offscreen 端口建立失败"));

    continueBtn.click();

    await vi.waitFor(() => {
      expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("继续生成失败：offscreen 端口建立失败", 4000);
    });

    // 历史保持原状
    expect(chatSessionState.chatHistory[1]).toEqual({
      role: "assistant",
      content: "原部分正文",
      stopped: true
    });

    // DOM 恢复中断态
    expect(assistantEl.querySelector(".chat-msg-stopped")?.textContent).toBe("初始停止");
    expect(assistantEl.querySelector(".chat-msg-assistant-body")?.textContent).toContain("原部分正文");
    expect(assistantEl.querySelectorAll(".chat-msg-action-btn")).toHaveLength(2);
  });
});
