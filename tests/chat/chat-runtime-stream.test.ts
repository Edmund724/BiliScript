import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock, MockInstance } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import { renderMarkdown } from "../../extension/ui/markdown.js";
import type { ChatPortMessage, CreateChatRuntimeDeps } from "../../extension/chat/chat-runtime.js";
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
    requestViewReset: MockFn;
    autosizeInput: MockFn;
  };
  ensureCurrentContextForSend: MockFn;
  connectPort: MockFn;
}

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: ChatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

const SLOW_NOTICE_TEXT = "模型响应较慢，可能正在思考，请稍候…";

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

function feed(runtime: ChatRuntime, msg: ChatPortMessage) {
  runtime.handleChatPortMessage(msg);
}

function holdRaf(): RafSpy {
  return vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1) as unknown as RafSpy;
}

function runRafFrames(raf: RafSpy) {
  raf.mock.calls.splice(0).forEach((call) => call[0]());
}

function assistantNode(deps: TestDeps): HTMLElement {
  return deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  ({ chatSessionState, chatSessionStateForTests, resetChatSessionStateForTests } = await import("../../extension/chat/chat-state.js"));
  resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("sendMessage 建流与协议入口", () => {
  it("发送后：chat 消息发起，助手占位（含光标）先于首个 token 建立，进入流式 UI", async () => {
    const { deps, runtime, session } = await makeRuntime("总结一下这个视频");

    expect(session.port.postMessage).toHaveBeenCalledTimes(1);
    const chatMsg = session.port.postMessage.mock.calls[0][0];
    expect(chatMsg.action).toBe("chat");
    expect(chatMsg.prompt).toBe("总结一下这个视频");

    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");

    const node = assistantNode(deps);
    expect(node).toBeTruthy();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();

    expect(runtime.isStreaming()).toBe(true);
    expect(deps.ui.setStreamingUiState).toHaveBeenCalledWith(true, expect.anything());
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("支持图片时下发截帧工具开关，video-frame-request 回传真实图片与播放时间", async () => {
    const deps = makeDeps();
    deps.canUseVideoFrameTool = vi.fn(async () => true);
    deps.captureCurrentVideoFrame = vi.fn(async () => ({
      image: { mime: "image/jpeg", data: "/9j/" },
      currentTime: 151
    }));
    deps.input.value = "看看当前画面";
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn(deps.input.value);
    const session = deps.ports[0];

    expect(session.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      action: "chat",
      videoFrameToolEnabled: true
    }));

    session.listeners.message[0]({ type: "video-frame-request", requestId: "frame-1" });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith({
      action: "video-frame-result",
      requestId: "frame-1",
      image: { mime: "image/jpeg", data: "/9j/" },
      currentTime: 151
    }));
    expect(deps.captureCurrentVideoFrame).toHaveBeenCalledTimes(1);
    expect(deps.captureCurrentVideoFrame).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
  });

  it("video-frame-request 携带目标时间时按该时间取帧并回传有序三帧", async () => {
    const deps = makeDeps();
    deps.canUseVideoFrameTool = vi.fn(async () => true);
    deps.captureCurrentVideoFrame = vi.fn(async () => [88, 90, 92].map((currentTime, index) => ({
      image: { mime: "image/jpeg", data: ["Rk9S", "Q0VO", "QUZU"][index] },
      currentTime
    })));
    deps.input.value = "看看 1:30 的画面";
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn(deps.input.value);
    const session = deps.ports[0];

    session.listeners.message[0]({ type: "video-frame-request", requestId: "history-1", targetTime: 90 });

    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledWith({
      action: "video-frame-result",
      requestId: "history-1",
      frames: [88, 90, 92].map((currentTime, index) => ({
        image: { mime: "image/jpeg", data: ["Rk9S", "Q0VO", "QUZU"][index] },
        currentTime
      }))
    }));
    expect(deps.captureCurrentVideoFrame).toHaveBeenCalledWith(90, expect.any(AbortSignal));
    expect(deps.messages.querySelectorAll(".chat-msg-user img")).toHaveLength(0);
    session.listeners.message[0]({ type: "done" });
    expect(chatSessionState.chatHistory).toEqual([
      expect.objectContaining({ role: "user", content: "看看 1:30 的画面" }),
      expect.objectContaining({ role: "assistant" })
    ]);
    expect(chatSessionState.chatHistory.every((message) => !message.images?.length)).toBe(true);
  });

  it("video-frame-cancel 中止在飞取帧并丢弃迟到结果", async () => {
    const deps = makeDeps();
    let captureSignal: AbortSignal | undefined;
    let resolveCapture!: (frames: Array<{ image: { mime: string; data: string }; currentTime: number }>) => void;
    deps.captureCurrentVideoFrame = vi.fn((_targetTime?: number, signal?: AbortSignal) => {
      captureSignal = signal;
      return new Promise<Array<{ image: { mime: string; data: string }; currentTime: number }>>((resolve) => { resolveCapture = resolve; });
    });
    deps.input.value = "看看 1:30 的画面";
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn(deps.input.value);
    const session = deps.ports[0];
    session.listeners.message[0]({ type: "video-frame-request", requestId: "history-1", targetTime: 90 });
    await vi.waitFor(() => expect(deps.captureCurrentVideoFrame).toHaveBeenCalledWith(90, expect.any(AbortSignal)));

    session.listeners.message[0]({ type: "video-frame-cancel", requestId: "history-1" });
    expect(captureSignal?.aborted).toBe(true);
    resolveCapture([{ image: { mime: "image/jpeg", data: "/9j/" }, currentTime: 90 }]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(session.port.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      action: "video-frame-result",
      requestId: "history-1"
    }));
  });

  it.each(["reset", "disconnect"] as const)("会话生命周期终止（%s）会中止在飞取帧", async (termination) => {
    const deps = makeDeps();
    let captureSignal: AbortSignal | undefined;
    deps.captureCurrentVideoFrame = vi.fn((_targetTime?: number, signal?: AbortSignal) => {
      captureSignal = signal;
      return new Promise<never>(() => {});
    });
    deps.input.value = "看看 1:30 的画面";
    const runtime = createChatRuntime(deps);
    await runtime.sendTurn(deps.input.value);
    const session = deps.ports[0];
    session.listeners.message[0]({ type: "video-frame-request", requestId: "history-1", targetTime: 90 });
    await vi.waitFor(() => expect(deps.captureCurrentVideoFrame).toHaveBeenCalled());

    if (termination === "reset") {
      runtime.resetStreamState();
    } else {
      session.listeners.disconnect[0]();
    }

    expect(captureSignal?.aborted).toBe(true);
  });

  it("能力查询失败或缺省时不下发截帧工具开关", async () => {
    const disabledDeps = makeDeps();
    disabledDeps.canUseVideoFrameTool = vi.fn(async () => false);
    disabledDeps.input.value = "纯文本问答";
    const disabledRuntime = createChatRuntime(disabledDeps);
    await disabledRuntime.sendTurn(disabledDeps.input.value);
    expect(disabledDeps.ports[0].port.postMessage.mock.calls[0][0].videoFrameToolEnabled).toBeUndefined();

    const { session } = await makeRuntime();
    expect(session.port.postMessage.mock.calls[0][0].videoFrameToolEnabled).toBeUndefined();
  });

  it("假 port 的 onMessage 监听器与 handleChatPortMessage 走同一协议分派（wiring）", async () => {
    const { deps, runtime, session } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    session.listeners.message[0]({ type: "token", data: "**第一帧**" });
    raf.mock.calls[0][0]();
    expect(deps.messages.querySelector("strong")?.textContent).toBe("第一帧");

    feed(runtime, { type: "token", data: " 与第二帧" });
    raf.mock.calls[1][0]();
    const tail = node.querySelector<HTMLElement>(".chat-stream-tail")!;
    expect(tail.textContent).toContain("第一帧");
    expect(tail.textContent).toContain("第二帧");
  });

  it("流式中重复 sendMessage 被拒（activePort 占用）：verdict=ignored、不发起第二条 port、不清输入", async () => {
    const { deps, runtime } = await makeRuntime("第一条");

    deps.input.value = "第二条";
    const verdict = await runtime.sendTurn(deps.input.value);

    expect(verdict).toBe("ignored");
    expect(deps.ports).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.input.value).toBe("第二条");
  });

  it("发送中（ensure 窗口内）重复 sendMessage 被拒：verdict=ignored、不发起第二条 port、不开第二条流", async () => {
    const deps = makeDeps();
    deps.input.value = "第一条";
    let releaseEnsure!: (value: unknown) => void;
    deps.ensureCurrentContextForSend = vi.fn(() => new Promise((resolve) => { releaseEnsure = resolve; }));

    const runtime = createChatRuntime(deps);
    const send1 = runtime.sendTurn(deps.input.value);
    expect(runtime.isStreaming()).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBeNull();

    deps.input.value = "第二条";
    const secondVerdict = await runtime.sendTurn(deps.input.value);
    expect(secondVerdict).toBe("ignored");
    expect(deps.ports).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(0);
    expect(deps.input.value).toBe("第二条");
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());

    releaseEnsure({ pass: true });
    await expect(send1).resolves.toBe("accepted");
    expect(deps.ports).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.input.value).toBe("第二条");
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("已发送原文，保留了后来修改的草稿与图片", 4000);
  });

  it("空文本 sendMessage：verdict=ignored，输入框保持空、无 port", async () => {
    const deps = makeDeps();
    deps.input.value = "   ";
    const runtime = createChatRuntime(deps);

    await expect(runtime.sendTurn(deps.input.value)).resolves.toBe("ignored");

    expect(deps.ensureCurrentContextForSend).not.toHaveBeenCalled();
    expect(deps.ports).toHaveLength(0);
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
  });
});

describe("token 流式渲染（协议驱动）", () => {
  it("流式期间按帧渲染 markdown 结构并保留光标（stable/tail 双容器）", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "# 标题\n- 第一项\n" });
    expect(raf).toHaveBeenCalledTimes(1);
    raf.mock.calls[0][0]();
    expect(node.querySelector("h2")).toBeTruthy();
    expect(node.querySelector("li")).toBeTruthy();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();

    feed(runtime, { type: "token", data: "- 第二项\n```js\nconst a = 1;\n```\n" });
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("pre code")).toBeTruthy();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();

    feed(runtime, { type: "token", data: "结尾段落\n" });
    raf.mock.calls[2][0]();
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("p")).toBeTruthy();

    const tailEl = node.querySelector<HTMLElement>(".chat-stream-tail")!;
    expect(tailEl.lastElementChild!.className).toBe("chat-msg-cursor");
    expect(tailEl.lastElementChild!.querySelectorAll("i")).toHaveLength(3);
  });

  it("稳定前缀 + 末块增量渲染：stable 只在增长时增量提交并保持节点身份，done 后与全量渲染一致", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "第一段\n\n第二段开头" });
    raf.mock.calls[0][0]();
    const stableEl = node.querySelector<HTMLElement>(".chat-stream-stable")!;
    const tailEl = node.querySelector<HTMLElement>(".chat-stream-tail")!;
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段"));
    expect(tailEl.querySelector("p")!.textContent).toBe("第二段开头");
    expect(tailEl.lastElementChild!.className).toBe("chat-msg-cursor");

    const p1 = stableEl.firstElementChild!;

    feed(runtime, { type: "token", data: "，仍在增长" });
    raf.mock.calls[1][0]();
    expect(stableEl.firstElementChild).toBe(p1);
    expect(stableEl.children).toHaveLength(1);
    expect(tailEl.querySelector("p")!.textContent).toBe("第二段开头，仍在增长");
    expect(tailEl.lastElementChild!.className).toBe("chat-msg-cursor");

    feed(runtime, { type: "token", data: "\n\n第三段" });
    raf.mock.calls[2][0]();
    expect(stableEl.firstElementChild).toBe(p1);
    expect(stableEl.innerHTML).toBe(renderMarkdown("第一段\n\n第二段开头，仍在增长"));
    expect(tailEl.querySelector("p")!.textContent).toBe("第三段");

    const fullText = "第一段\n\n第二段开头，仍在增长\n\n第三段";
    feed(runtime, { type: "done" });
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();
    expect(node.querySelector<HTMLElement>(".chat-msg-assistant-body")!.innerHTML).toBe(renderMarkdown(fullText));
  });

  it("done 收尾：未 flush 的 pending 一并入全量文本；写回并持久化；断开 port 退出流式 UI", async () => {
    const { deps, runtime, session } = await makeRuntime("帮我写个标题");
    const node = assistantNode(deps);
    const focusSpy = vi.spyOn(deps.input, "focus");
    const raf = holdRaf();

    const tokens = ["# 标题\n\n", "第一段**加粗**", "\n\n- 项目一\n", "- 项目二\n", "结尾文本"];
    const fullText = tokens.join("");

    feed(runtime, { type: "token", data: tokens[0] });
    feed(runtime, { type: "token", data: tokens[1] });
    raf.mock.calls[0][0]();
    expect(node.querySelector("h2")).toBeTruthy();

    feed(runtime, { type: "token", data: tokens[2] });
    raf.mock.calls[1][0]();
    expect(node.querySelectorAll("li")).toHaveLength(1);

    feed(runtime, { type: "token", data: tokens[3] });
    feed(runtime, { type: "token", data: tokens[4] });
    expect(node.querySelectorAll("li")).toHaveLength(1);

    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory[0]).toEqual({ role: "user", content: "帮我写个标题" });
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: fullText });
    expect(node.querySelector<HTMLElement>(".chat-msg-assistant-body")!.innerHTML).toBe(renderMarkdown(fullText));

    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, expect.anything());
    expect(focusSpy).toHaveBeenCalled();
  });
});

describe("reasoning / thinking 展示", () => {
  it("reasoning 创建思维链思考步骤（深度思考中…）并流式累加；首个 token 渲染时折叠为单行摘要", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "先想" });
    const thinking = node.querySelector<HTMLElement>(".chat-thinking")!;
    expect(thinking).toBeTruthy();
    expect(thinking.querySelector(".chat-thinking-label")?.textContent).toBe("深度思考中…");
    runRafFrames(raf);
    expect(thinking.querySelector(".chat-thinking-text")?.textContent).toBe("先想");

    feed(runtime, { type: "reasoning", data: "再想" });
    runRafFrames(raf);
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("先想再想");

    feed(runtime, { type: "token", data: "正文" });
    runRafFrames(raf);
    const folded = node.querySelector<HTMLElement>(".chat-thinking")!;
    expect(folded).toBeTruthy();
    expect(folded.classList.contains("chat-thinking-collapsible")).toBe(true);
    expect(folded.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(folded.querySelector(".chat-thinking-label")?.textContent).toMatch(/^已思考 \d+\.\ds$/);
    expect(folded.querySelector(".chat-thinking-duration-num")?.textContent).toMatch(/^\d+\.\d$/);
    expect(folded.querySelector(".chat-thinking-text")?.textContent).toBe("先想再想");
    expect(node.textContent).toContain("正文");
  });

  it("流式期间默认展开且随时可手动折叠；正文首帧后自动折叠为单行摘要并支持展开回看", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "想了很多" });
    const thinking = node.querySelector<HTMLElement>(".chat-thinking")!;
    const thinkingBtn = thinking.querySelector<HTMLButtonElement>(".chat-thinking-label")!;
    expect(thinkingBtn.disabled).toBe(false);
    expect(thinkingBtn.getAttribute("aria-expanded")).toBe("true");
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(false);
    thinkingBtn.click();
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(thinkingBtn.getAttribute("aria-expanded")).toBe("false");
    thinkingBtn.click();
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(false);
    expect(thinkingBtn.textContent).toBe("深度思考中…");

    feed(runtime, { type: "token", data: "正文" });
    runRafFrames(raf);
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(thinkingBtn.disabled).toBe(false);
    expect(thinkingBtn.getAttribute("aria-expanded")).toBe("false");
    thinkingBtn.click();
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(false);
    expect(thinkingBtn.getAttribute("aria-expanded")).toBe("true");
    expect(thinking.querySelector(".chat-thinking-text")?.textContent).toBe("想了很多");
    thinking.querySelector<HTMLElement>(".chat-thinking-text")!.click();
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(false);
    thinkingBtn.click();
    expect(thinking.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(thinkingBtn.getAttribute("aria-expanded")).toBe("false");

    feed(runtime, { type: "done" });
    const kept = node.querySelector(".chat-thinking");
    expect(kept?.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(kept?.querySelector(".chat-thinking-text")?.textContent).toBe("想了很多");
  });

  it("思考时长与数字锁契约：流式结束折叠时渲染 0.1s 精度秒数且包含 tabular-nums 数字节点", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    const nowSpy = vi.spyOn(Date, "now");
    try {
      nowSpy.mockReturnValue(1_000_000);
      feed(runtime, { type: "reasoning", data: "深入思考中" });

      nowSpy.mockReturnValue(1_003_200);
      feed(runtime, { type: "token", data: "结论" });
      runRafFrames(raf);

      const folded = node.querySelector<HTMLElement>(".chat-thinking")!;
      expect(folded.querySelector(".chat-thinking-label")?.textContent).toBe("已思考 3.2s");
      const numEl = folded.querySelector<HTMLElement>(".chat-thinking-duration-num")!;
      expect(numEl).toBeTruthy();
      expect(numEl.textContent).toBe("3.2");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("reasoning 超 4000 字符不截断：全量显示；跨消息不串内容", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const node1 = assistantNode(deps);
    const raf = holdRaf();

    const chunks = [
      "a".repeat(1500),
      "b".repeat(2499),
      "c",
      "d",
      "e".repeat(2500)
    ];
    let total = "";
    for (const chunk of chunks) {
      feed(runtime, { type: "reasoning", data: chunk });
      total += chunk;
      runRafFrames(raf);
      expect(node1.querySelector(".chat-thinking-text")?.textContent).toBe(total);
    }

    feed(runtime, { type: "token", data: "第一条回答" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });
    expect(node1.querySelector(".chat-thinking-text")?.textContent).toBe(total);

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二条思考" });
    runRafFrames(raf);
    expect(node2.querySelector(".chat-thinking-text")?.textContent).toBe("第二条思考");
  });

  it("跨消息 reasoning 收尾事件：在新回合的 assistant 节点上新建思考节点，不串进旧节点", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一轮思考" });
    feed(runtime, { type: "token", data: "第一轮正文" });
    runRafFrames(raf);
    feed(runtime, { type: "reasoning", data: "" });
    feed(runtime, { type: "done" });
    const node1 = deps.messages.querySelectorAll(".chat-msg-assistant")[0];
    const node1Chain = node1.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(node1Chain).toBeTruthy();
    expect(node1Chain.classList.contains("chat-thinking-collapsed")).toBe(true);
    expect(node1Chain.querySelectorAll(".chat-thought-step[data-step-kind='thinking']")).toHaveLength(2);
    expect(node1Chain.querySelector(".chat-thinking-label")?.textContent).toMatch(/^已思考 \d+\.\ds$/);
    expect(node1Chain.querySelector(".chat-thinking-duration-num")?.textContent).toMatch(/^\d+\.\d$/);

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "" });
    runRafFrames(raf);
    const node2Thinking = node2.querySelector<HTMLElement>(".chat-thinking")!;
    expect(node2Thinking).toBeTruthy();
    expect(node2Thinking.querySelector(".chat-thinking-text")?.textContent).toBe("");
    expect(node1.querySelectorAll(".chat-thought-chain")).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-thought-chain")).toHaveLength(2);

    feed(runtime, { type: "reasoning", data: "第二轮思考" });
    runRafFrames(raf);
    expect(node2.querySelector(".chat-thinking-text")?.textContent).toBe("第二轮思考");
  });

  it("跨消息思考重建：首帧 flush 前的 reasoning 在新回合新建节点（不依赖 thinkingNode 残留）", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一轮思考" });
    feed(runtime, { type: "token", data: "第一轮正文" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二轮思考" });
    runRafFrames(raf);
    expect(node2.querySelector(".chat-thinking-text")?.textContent).toBe("第二轮思考");
  });
});

describe("终态分派：stopped / error", () => {
  it("stopped 有正文：渲染正文 + 停止徽标 + 写回持久化 + 断开 port", async () => {
    const { deps, runtime, session } = await makeRuntime("总结一下");
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "部分回答" });
    raf.mock.calls[0][0]();
    feed(runtime, { type: "stopped", reason: "用户手动停止" });

    expect(node.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("部分回答"));
    expect(node.querySelector(".chat-msg-stopped")?.textContent).toBe("用户手动停止");
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "总结一下" },
      { role: "assistant", content: "部分回答", stopped: true }
    ]);
    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
  });

  it("stopped 无正文：放停止徽标，写回持久化", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);

    feed(runtime, { type: "stopped", reason: "" });

    expect(node.querySelector(".chat-msg-stopped")?.textContent).toBe("已停止生成");
    expect(node.querySelector(".chat-msg-assistant-body")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "帮我写个标题" },
      { role: "assistant", content: "", stopped: true }
    ]);
    expect(deps.store.persistCurrent).toHaveBeenCalledTimes(1);
    expect(runtime.isStreaming()).toBe(false);
  });

  it("error：错误占位（错误：xxx），半截正文不写回；断开 port 退出流式 UI", async () => {
    const { deps, runtime, session } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "半截输出" });
    raf.mock.calls[0][0]();
    feed(runtime, { type: "error", error: "网络错误" });

    expect(node.querySelector(".chat-msg-error")?.textContent).toBe("错误：网络错误");
    expect(node.querySelector(".chat-msg-assistant-body")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
    expect(deps.store.persistCurrent).not.toHaveBeenCalled();
    expect(session.port.disconnect).toHaveBeenCalled();
    expect(runtime.isStreaming()).toBe(false);
  });

  it("error 空 error 字段：默认文案「错误：未知错误」", async () => {
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "error", error: "" });

    expect(assistantNode(deps).querySelector(".chat-msg-error")?.textContent).toBe("错误：未知错误");
  });
});

describe("notice 与 cost-guard 分派（流中非终态）", () => {
  it("notice：转发上下文 notice 门面（data, 4000），流不终止", async () => {
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "notice", data: "上下文提示" });

    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("上下文提示", 4000);
    expect(runtime.isStreaming()).toBe(true);
  });

  it("notice code=truncated：不走通知条，done 收尾在正文后挂常驻截断徽标", async () => {
    const { deps, runtime } = await makeRuntime("总结一下");
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "半句" });
    runRafFrames(raf);
    feed(runtime, { type: "notice", data: "回答被截断（达到模型输出上限）", code: "truncated" });
    feed(runtime, { type: "done" });

    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalled();
    expect(node.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("半句"));
    expect(node.querySelector(".chat-msg-truncated")?.textContent).toBe("回答被截断（达到模型输出上限）");
    expect(node.querySelector(".chat-msg-continue-btn")).not.toBeNull();
    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "总结一下" },
      { role: "assistant", content: "半句" }
    ]);
  });

  it("截断标记不串代际：下一条消息正常收尾不带徽标", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "第一轮" });
    runRafFrames(raf);
    feed(runtime, { type: "notice", data: "回答被截断（达到模型输出上限）", code: "truncated" });
    feed(runtime, { type: "done" });
    expect(deps.messages.querySelector(".chat-msg-truncated")).not.toBeNull();

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    const nodes = deps.messages.querySelectorAll(".chat-msg-assistant");
    const node2 = nodes[nodes.length - 1] as HTMLElement;
    feed(runtime, { type: "token", data: "第二轮" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });

    expect(node2.querySelector(".chat-msg-truncated")).toBeNull();
    expect(node2.querySelector(".chat-msg-continue-btn")).toBeNull();
  });

  it("cost-guard：面板内确认弹层确认 → 回执 ok:true；取消/缺省文案 → ok:false，流不终止", async () => {
    const { runtime, session } = await makeRuntime();
    document.body.innerHTML = '<div id="biliscript-reading-view"></div>';

    feed(runtime, { type: "cost-guard", data: { message: "预计 3 次调用" } });
    let confirmBtn = document.querySelector<HTMLButtonElement>(".confirm-dialog-confirm")!;
    expect(confirmBtn, "成本护栏确认弹层应已打开").not.toBeNull();
    expect(confirmBtn.textContent).toBe("继续");
    expect(document.querySelector<HTMLElement>(".confirm-dialog-message")!.textContent).toBe("预计 3 次调用");
    confirmBtn.click();
    await vi.waitFor(() => {
      expect(session.port.postMessage).toHaveBeenCalledWith({ action: "cost-guard-confirm", ok: true });
    });

    feed(runtime, { type: "cost-guard" });
    expect(document.querySelector<HTMLElement>(".confirm-dialog-message")!.textContent).toBe("预计会有多次调用，是否继续？");
    document.querySelector<HTMLButtonElement>(".confirm-dialog-cancel")!.click();
    await vi.waitFor(() => {
      expect(session.port.postMessage).toHaveBeenLastCalledWith({ action: "cost-guard-confirm", ok: false });
    });

    expect(runtime.isStreaming()).toBe(true);
  });
});

describe("stream-reset 代际重放（读流中断重试：整体重放）", () => {
  it("收到 stream-reset → 清空已渲染内容与累加器；第二代流从头渲染，finalize 不含第一代残留", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "# 第一代开头\n\n第一代正文" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-stream-stable")).toBeTruthy();
    expect(node.querySelector("h2")?.textContent).toContain("第一代");

    feed(runtime, { type: "stream-reset" });

    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();

    feed(runtime, { type: "token", data: "## 第二代重写\n\n全新的正文" });
    raf.mock.calls[1][0]();
    expect(node.textContent).toContain("第二代重写");

    feed(runtime, { type: "done" });

    const expected = "## 第二代重写\n\n全新的正文";
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: expected });
    expect(node.querySelector<HTMLElement>(".chat-msg-assistant-body")!.innerHTML).toBe(renderMarkdown(expected));
    expect(node.textContent).not.toContain("第一代");
  });

  it("stream-reset 时已渲染的思考节点一并清掉，后续 reasoning 事件重建", async () => {
    const { deps, runtime } = await makeRuntime("问题");
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一代思考" });
    runRafFrames(raf);
    expect(node.querySelector(".chat-thinking")?.textContent).toContain("第一代思考");

    feed(runtime, { type: "stream-reset" });
    expect(node.querySelector(".chat-thinking")).toBeNull();

    feed(runtime, { type: "reasoning", data: "第二代思考" });
    runRafFrames(raf);
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("第二代思考");
  });
});

describe("慢响应提示计时器（fake timers）", () => {
  it("发送后 15s 仍无首 token → 显示慢响应 notice；首个 token 到达后移除且不再重弹", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime();

    vi.advanceTimersByTime(15000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);

    feed(runtime, { type: "token", data: "第一帧" });
    expect(deps.ui.removeConversationContextNotice).toHaveBeenCalled();

    vi.advanceTimersByTime(60000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledTimes(1);
  });

  it("15s 内收到首 token → 计时器被清，此后再久也不弹慢响应 notice", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime();

    feed(runtime, { type: "token", data: "很快就来了" });
    vi.advanceTimersByTime(60000);

    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalled();
  });

  it("done 收尾清计时器：收尾后不再弹慢响应 notice", async () => {
    vi.useFakeTimers();
    const { deps, runtime, session } = await makeRuntime();

    feed(runtime, { type: "done" });
    vi.advanceTimersByTime(30000);

    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalled();
    expect(session.port.disconnect).toHaveBeenCalled();
  });

  it("终态收尾不重置首 token 标志：收尾后迟到的 reasoning 不再触发清理、下一条消息慢响应提示照常", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime("问题一");
    const removeSpy = deps.ui.removeConversationContextNotice;

    feed(runtime, { type: "reasoning", data: "思考" });
    feed(runtime, { type: "done" });
    expect(removeSpy).toHaveBeenCalledTimes(3);

    feed(runtime, { type: "reasoning", data: "" });
    expect(removeSpy).toHaveBeenCalledTimes(3);

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    vi.advanceTimersByTime(15000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);

    feed(runtime, { type: "token", data: "回答" });
    expect(removeSpy.mock.calls.length).toBeGreaterThan(3);
    vi.advanceTimersByTime(60000);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledTimes(1);
  });
});

describe("自动滚动开关对渲染的影响", () => {
  it("setAutoScroll(false) 后 token flush 不滚动；恢复 true 后恢复滚动", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    runtime.setAutoScroll(false);
    deps.messages.scrollTop = 42;
    feed(runtime, { type: "token", data: "第一帧" });
    raf.mock.calls[0][0]();
    expect(deps.messages.scrollTop).toBe(42);

    runtime.setAutoScroll(true);
    feed(runtime, { type: "token", data: "第二帧" });
    raf.mock.calls[1][0]();
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
  });

  it("消息区句柄的来源语义：replay 追加不滚动不重置标志；live 追加强制滚动并重置标志", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    runtime.setAutoScroll(false);
    deps.messages.scrollTop = 42;

    runtime.messageArea.appendUserMessage("回放消息", { source: "replay" });
    expect(deps.messages.scrollTop).toBe(42);
    feed(runtime, { type: "token", data: "一帧" });
    raf.mock.calls[0][0]();
    expect(deps.messages.scrollTop).toBe(42);

    runtime.messageArea.appendUserMessage("新消息", { source: "live" });
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
    deps.messages.scrollTop = 9;
    feed(runtime, { type: "token", data: "又一帧" });
    raf.mock.calls[1][0]();
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
  });
});

describe("sendMessage 受理结论与闸拦截的提前返回", () => {
  function makeSendDeps(outcome: { pass: true } | { pass: false; kind: string }) {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    deps.connectPort = vi.fn(async () => {
      throw new Error("不应发起 port");
    });
    deps.ensureCurrentContextForSend = vi.fn(async () => outcome);
    return { deps };
  }

  it("gate no-subtitle：verdict=blocked，不追加消息、不清输入、不发起 port", async () => {
    const { deps } = makeSendDeps({ pass: false, kind: "no-subtitle" });
    const runtime = createChatRuntime(deps);

    await expect(runtime.sendTurn(deps.input.value)).resolves.toBe("blocked");

    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(1);
    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBeNull();
    expect(deps.input.value).toBe("总结一下这个视频");
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalledWith(true, expect.anything());
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("gate read-failed（上下文读取失败）：同样 verdict=blocked，行为与拦截一致", async () => {
    const { deps } = makeSendDeps({ pass: false, kind: "read-failed" });
    const runtime = createChatRuntime(deps);

    await expect(runtime.sendTurn(deps.input.value)).resolves.toBe("blocked");

    expect(deps.connectPort).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(chatSessionState.chatHistory).toEqual([]);
  });

  it("无可用平台：verdict=blocked（不发起 port、不清输入）", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    deps.getProviderId = () => "";
    const runtime = createChatRuntime(deps);

    await expect(runtime.sendTurn(deps.input.value)).resolves.toBe("blocked");

    expect(deps.ensureCurrentContextForSend).not.toHaveBeenCalled();
    expect(deps.ports).toHaveLength(0);
    expect(deps.input.value).toBe("总结一下这个视频");
  });

  it("gate pass：verdict=accepted，照常追加用户消息并发起 port（非 empty 不受影响）", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    const runtime = createChatRuntime(deps);

    await expect(runtime.sendTurn(deps.input.value)).resolves.toBe("accepted");

    expect(deps.connectPort).toHaveBeenCalledTimes(1);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledTimes(1);
  });

  it("connectPort 失败：verdict=accepted，退出流式 UI、assistant 占位变错误占位、port 未建", async () => {
    const deps = makeDeps();
    deps.input.value = "总结一下这个视频";
    deps.connectPort = vi.fn(async () => {
      throw new Error("offscreen 文档创建失败");
    });
    const runtime = createChatRuntime(deps);

    await expect(runtime.sendTurn(deps.input.value)).resolves.toBe("accepted");

    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("总结一下这个视频");
    expect(deps.input.value).toBe("");
    const node = assistantNode(deps);
    expect(node.querySelector(".chat-msg-error")?.textContent).toBe("错误：offscreen 文档创建失败");

    expect(runtime.isStreaming()).toBe(false);
    expect(runtime.hasPendingUserPrompt()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, expect.anything());
    expect(deps.ui.removeConversationContextNotice).toHaveBeenCalled();

    expect(deps.ports).toHaveLength(0);
    expect(deps.connectPort).toHaveBeenCalledTimes(1);

    deps.connectPort.mockImplementation(async () => {
      const session = makePort();
      deps.ports.push(session);
      return session.port;
    });
    deps.input.value = "重试发送";
    await runtime.sendTurn(deps.input.value);
    expect(deps.connectPort).toHaveBeenCalledTimes(2);
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("重试发送");
  });
});

describe("流式 flush 长任务分片（帧预算耗尽让出主线程）", () => {
  function holdClockOverBudget() {
    let t = 0;
    return vi.spyOn(performance, "now").mockImplementation(() => (t += 100));
  }

  type WritableSchedulerWindow = { scheduler?: { yield: () => Promise<void> } };

  function gateScheduler() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    const schedulerStub = { yield: vi.fn(() => promise) };
    (window as unknown as WritableSchedulerWindow).scheduler = schedulerStub;
    return {
      yieldSpy: schedulerStub.yield,
      release: () => release()
    };
  }

  afterEach(() => {
    delete (window as unknown as WritableSchedulerWindow).scheduler;
  });

  it("帧预算耗尽：优先 scheduler.yield 让出主线程，让出后完成渲染并保留光标", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const gate = gateScheduler();
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "第一段\n\n第二段" });
    raf.mock.calls[0][0]();

    expect(gate.yieldSpy).toHaveBeenCalledTimes(1);
    expect(node.querySelector(".chat-stream-stable")?.innerHTML).toBe("");
    expect(node.querySelector(".chat-stream-tail")?.innerHTML).toBe("");

    gate.release();
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第二段");
    });
    expect(gate.yieldSpy).toHaveBeenCalledTimes(2);
    expect(node.querySelector(".chat-stream-stable")?.innerHTML).toBe(renderMarkdown("第一段"));
    const tailEl = node.querySelector<HTMLElement>(".chat-stream-tail")!;
    expect(tailEl.lastElementChild!.className).toBe("chat-msg-cursor");

    feed(runtime, { type: "done" });
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: "第一段\n\n第二段" });
  });

  it("scheduler.yield 不存在（Safari 等旧浏览器）：setTimeout(0) 兜底让出，渲染仍完成", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    expect(window.scheduler).toBeUndefined();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "正文内容" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-stream-tail")?.innerHTML).toBe("");

    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("正文内容");
    });
    expect(setTimeoutSpy.mock.calls.some(([, delay]) => delay === 0)).toBe(true);
    expect(node.querySelector(".chat-msg-cursor")).toBeTruthy();
  });

  it("让出期间流收口（done）：恢复后旧帧作废，不向终态 DOM 回写流式容器", async () => {
    const { deps, runtime, session } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const gate = gateScheduler();
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "半截回答" });
    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-stream-tail")?.innerHTML).toBe("");

    feed(runtime, { type: "done" });
    expect(node.querySelector(".chat-msg-assistant-body")?.innerHTML).toBe(renderMarkdown("半截回答"));
    expect(session.port.disconnect).toHaveBeenCalled();

    gate.release();
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    expect(node.querySelector(".chat-stream-stable")).toBeNull();
    expect(node.querySelector(".chat-stream-tail")).toBeNull();
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: "半截回答" });
  });

  it("让出窗口内新 token 到达：旧帧作废、新帧渲染合并内容（pending 不丢）", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const gate = gateScheduler();
    holdClockOverBudget();

    feed(runtime, { type: "token", data: "第一帧" });
    raf.mock.calls[0][0]();
    feed(runtime, { type: "token", data: "第二帧" });
    raf.mock.calls[1][0]();

    gate.release();
    await vi.waitFor(() => {
      expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第二帧");
    });
    expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("第一帧");

    feed(runtime, { type: "done" });
    expect(chatSessionState.chatHistory[1]).toEqual({ role: "assistant", content: "第一帧第二帧" });
  });
});

describe("M14 增量：流式滚动瞬时化 / 思考文本滚动合帧 / flush 异常收口", () => {
  it("流式 flush 滚动瞬时化：scrollTo({behavior:'instant'}) 覆盖 CSS smooth；自动滚动关闭时不触发", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const scrollToSpy = vi.fn();
    deps.messages.scrollTo = scrollToSpy;

    feed(runtime, { type: "token", data: "第一帧" });
    raf.mock.calls[0][0]();
    expect(scrollToSpy).toHaveBeenCalledWith({ top: expect.any(Number), behavior: "instant" });

    runtime.setAutoScroll(false);
    scrollToSpy.mockClear();
    feed(runtime, { type: "token", data: "第二帧" });
    raf.mock.calls[1][0]();
    expect(scrollToSpy).not.toHaveBeenCalled();
  });

  it("发送路径滚动瞬时化：消息区句柄 appendUserMessage(source=live) 走 instant scrollTo，endStream 收尾保留直写", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();
    const scrollToSpy = vi.fn();
    deps.messages.scrollTo = scrollToSpy;

    deps.messages.scrollTop = 0;
    runtime.messageArea.appendUserMessage("新消息", { source: "live" });
    expect(scrollToSpy).toHaveBeenCalledWith({ top: deps.messages.scrollHeight, behavior: "instant" });

    feed(runtime, { type: "token", data: "正文" });
    raf.mock.calls[0][0]();
    expect(scrollToSpy).toHaveBeenCalledTimes(2);
    feed(runtime, { type: "done" });
    expect(scrollToSpy).toHaveBeenCalledTimes(2);
    expect(deps.messages.scrollTop).toBe(deps.messages.scrollHeight);
  });

  it("思考文本按帧写入与滚动合批：reasoning 累加文本按帧统一写入 DOM（写入在布局读取前），同帧多条增量只写一次", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一段" });
    const textNode = node.querySelector<HTMLElement>(".chat-thinking-text")!;
    expect(textNode?.textContent).toBe("");

    const getScrollHeight = vi.fn(() => 1234);
    Object.defineProperty(textNode, "scrollHeight", { get: getScrollHeight, configurable: true });
    feed(runtime, { type: "reasoning", data: "第二段" });
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("");
    expect(getScrollHeight).not.toHaveBeenCalled();

    raf.mock.calls[0][0]();
    expect(textNode.textContent).toBe("第一段第二段");
    expect(textNode.scrollTop).toBe(1234);
    expect(getScrollHeight).toHaveBeenCalledTimes(1);
  });
  it("08 思考流按帧写入：同帧多次 reasoning 累加只在帧回调中统一写入 DOM，且写入先于布局读取", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "chunk1" });
    const textNode = node.querySelector<HTMLElement>(".chat-thinking-text")!;
    expect(textNode).toBeTruthy();
    expect(textNode.textContent).toBe("");

    let textAtLayoutRead = "";
    const getScrollHeight = vi.fn(() => {
      textAtLayoutRead = textNode.textContent;
      return 888;
    });
    Object.defineProperty(textNode, "scrollHeight", { get: getScrollHeight, configurable: true });

    feed(runtime, { type: "reasoning", data: "chunk2" });
    feed(runtime, { type: "reasoning", data: "chunk3" });
    expect(textNode.textContent).toBe("");
    expect(getScrollHeight).not.toHaveBeenCalled();

    raf.mock.calls[0][0]();
    expect(textAtLayoutRead).toBe("chunk1chunk2chunk3");
    expect(textNode.textContent).toBe("chunk1chunk2chunk3");
    expect(textNode.scrollTop).toBe(888);
    expect(getScrollHeight).toHaveBeenCalledTimes(1);
  });

  it("08 终态前最后一帧同步冲刷：未跑 rAF 时，done/stop/fail/首token折叠同步冲刷待写文本不丢最后一段", async () => {
    const { deps: deps1, runtime: rt1 } = await makeRuntime("问题1");
    const node1 = assistantNode(deps1);
    const raf1 = holdRaf();
    feed(rt1, { type: "reasoning", data: "思考未上屏" });
    const textNode1 = node1.querySelector<HTMLElement>(".chat-thinking-text")!;
    expect(textNode1.textContent).toBe("");
    feed(rt1, { type: "token", data: "正文开始" });
    runRafFrames(raf1);
    expect(textNode1.textContent).toBe("思考未上屏");

    const { deps: deps2, runtime: rt2 } = await makeRuntime("问题2");
    const node2 = assistantNode(deps2);
    holdRaf();
    feed(rt2, { type: "reasoning", data: "终态前最后一段" });
    const textNode2 = node2.querySelector<HTMLElement>(".chat-thinking-text")!;
    expect(textNode2.textContent).toBe("");
    feed(rt2, { type: "done" });
    expect(textNode2.textContent).toBe("终态前最后一段");

    const { deps: deps3, runtime: rt3 } = await makeRuntime("问题3");
    const node3 = assistantNode(deps3);
    holdRaf();
    feed(rt3, { type: "reasoning", data: "停止前一段" });
    const textNode3 = node3.querySelector<HTMLElement>(".chat-thinking-text")!;
    expect(textNode3.textContent).toBe("");
    feed(rt3, { type: "stopped", reason: "用户停止" });
    expect(textNode3.textContent).toBe("停止前一段");
  });

  it("08 正文后收尾 reasoning：在同一思维链内追加第二思考步骤，文本按帧写入并在 done 时折叠冲刷", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "前置思考" });
    feed(runtime, { type: "token", data: "正文" });
    runRafFrames(raf);

    feed(runtime, { type: "reasoning", data: "收尾思考" });
    const chain = node.querySelector<HTMLElement>(".chat-thought-chain")!;
    const thinkingSteps = chain.querySelectorAll<HTMLElement>(".chat-thought-step[data-step-kind='thinking']");
    expect(thinkingSteps).toHaveLength(2);
    const textNode2 = thinkingSteps[1].querySelector<HTMLElement>(".chat-thinking-text")!;
    expect(textNode2.textContent).toBe("");

    feed(runtime, { type: "done" });
    expect(textNode2.textContent).toBe("收尾思考");
    expect(chain.classList.contains("chat-thinking-collapsed")).toBe(true);
  });

  it("08 重置：reasoning 帧挂起时收到 stream-reset，挂起帧不作用于已清理节点，下一代全新接收", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一代思考" });
    expect(node.querySelector(".chat-thinking")).toBeTruthy();
    expect(raf.mock.calls).toHaveLength(1);

    feed(runtime, { type: "stream-reset" });
    expect(node.querySelector(".chat-thinking")).toBeNull();

    raf.mock.calls[0][0]();
    expect(node.querySelector(".chat-thinking")).toBeNull();

    feed(runtime, { type: "reasoning", data: "第二代思考" });
    runRafFrames(raf);
    expect(node.querySelector(".chat-thinking-text")?.textContent).toBe("第二代思考");
  });

  it("08 正文 flush 期间直接复用热节点引用，不调用 querySelector 扫描光标和思考节点", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "思考" });
    feed(runtime, { type: "token", data: "正文1" });

    const querySelectorSpy = vi.spyOn(node, "querySelector");
    const querySelectorAllSpy = vi.spyOn(node, "querySelectorAll");

    runRafFrames(raf);

    const scannedSelectors = [
      ...querySelectorSpy.mock.calls.map((c) => c[0]),
      ...querySelectorAllSpy.mock.calls.map((c) => c[0])
    ];
    expect(scannedSelectors).not.toContain(".chat-msg-cursor");
    expect(scannedSelectors).not.toContain(".chat-thinking:not(.chat-thinking-collapsible)");

    querySelectorSpy.mockClear();
    querySelectorAllSpy.mockClear();
    feed(runtime, { type: "token", data: "正文2" });
    runRafFrames(raf);

    const scannedSelectors2 = [
      ...querySelectorSpy.mock.calls.map((c) => c[0]),
      ...querySelectorAllSpy.mock.calls.map((c) => c[0])
    ];
    expect(scannedSelectors2).not.toContain(".chat-msg-cursor");
    expect(scannedSelectors2).not.toContain(".chat-thinking:not(.chat-thinking-collapsible)");
  });

  it("跨消息思考滚动：旧消息滚动帧挂起期间，新消息思考节点独立调度互不影响", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一轮思考" });
    feed(runtime, { type: "token", data: "第一轮正文" });
    raf.mock.calls[1][0]();
    feed(runtime, { type: "done" });
    expect(raf.mock.calls).toHaveLength(2);

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    feed(runtime, { type: "reasoning", data: "第二轮思考" });
    expect(raf.mock.calls).toHaveLength(3);

    const textNode2 = node2.querySelector<HTMLElement>(".chat-thinking-text")!;
    const getScrollHeight2 = vi.fn(() => 4321);
    Object.defineProperty(textNode2, "scrollHeight", { get: getScrollHeight2, configurable: true });
    raf.mock.calls[2][0]();
    expect(textNode2.scrollTop).toBe(4321);

    getScrollHeight2.mockClear();
    raf.mock.calls[0][0]();
    expect(getScrollHeight2).not.toHaveBeenCalled();
  });

  it("思考盒钉底契约：用户上翻即停跟随（绝不拉回），回到底部附近恢复", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一段" });
    const textNode = node.querySelector<HTMLElement>(".chat-thinking-text")!;
    Object.defineProperty(textNode, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(textNode, "clientHeight", { get: () => 200, configurable: true });

    raf.mock.calls[0][0]();
    expect(textNode.scrollTop).toBe(1000);

    textNode.scrollTop = 100;
    textNode.dispatchEvent(new Event("scroll"));
    feed(runtime, { type: "reasoning", data: "第二段" });
    raf.mock.calls[1][0]();
    expect(textNode.scrollTop).toBe(100);

    textNode.scrollTop = 985;
    textNode.dispatchEvent(new Event("scroll"));
    feed(runtime, { type: "reasoning", data: "第三段" });
    raf.mock.calls[2][0]();
    expect(textNode.scrollTop).toBe(1000);
  });

  it("钉底误判回归：写入落底后、事件派发前的内容增长不视为用户上翻", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();

    feed(runtime, { type: "reasoning", data: "第一段" });
    const textNode = node.querySelector<HTMLElement>(".chat-thinking-text")!;
    Object.defineProperty(textNode, "scrollHeight", { get: () => 1000, configurable: true });
    Object.defineProperty(textNode, "clientHeight", { get: () => 200, configurable: true });
    raf.mock.calls[0][0]();
    expect(textNode.scrollTop).toBe(1000);

    Object.defineProperty(textNode, "scrollHeight", { get: () => 1300, configurable: true });
    textNode.dispatchEvent(new Event("scroll"));
    feed(runtime, { type: "reasoning", data: "第二段" });
    raf.mock.calls[1][0]();
    expect(textNode.scrollTop).toBe(1300);

    textNode.scrollTop = 500;
    textNode.dispatchEvent(new Event("scroll"));
    feed(runtime, { type: "reasoning", data: "第三段" });
    raf.mock.calls[2][0]();
    expect(textNode.scrollTop).toBe(500);
  });

  it("流式消息带 chat-msg-streaming 类（豁免 content-visibility），下一次发送上屏时摘除上一条", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const node1 = assistantNode(deps);
    const raf = holdRaf();

    expect(node1.classList.contains("chat-msg-streaming")).toBe(true);
    feed(runtime, { type: "token", data: "第一条正文" });
    runRafFrames(raf);
    expect(node1.classList.contains("chat-msg-streaming")).toBe(true);
    feed(runtime, { type: "done" });
    expect(node1.classList.contains("chat-msg-streaming")).toBe(true);

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    const node2 = deps.messages.querySelectorAll(".chat-msg-assistant")[1];
    expect(node1.classList.contains("chat-msg-streaming")).toBe(false);
    expect(node2.classList.contains("chat-msg-streaming")).toBe(true);
  });

  it("flush 同步段抛错：catch 收口记 console.error，不产生 unhandled rejection", async () => {
    const { deps, runtime } = await makeRuntime();
    const node = assistantNode(deps);
    const raf = holdRaf();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    Object.defineProperty(deps.messages, "scrollTop", {
      get: () => 0,
      set: () => {
        throw new Error("scroll boom");
      },
      configurable: true
    });

    feed(runtime, { type: "token", data: "正文" });
    raf.mock.calls[0][0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(errorSpy).toHaveBeenCalledWith("[chat-runtime] 流式渲染 flush 失败：", expect.any(Error));
    expect(node.querySelector(".chat-stream-tail")?.textContent).toContain("正文");
  });
});

describe("resetStreamState 对挂起流式渲染帧的清理", () => {
  it("resetStreamState 取消挂起帧后：新消息的 token 重新调度 flush（旧帧 id 不再占位）", async () => {
    const { deps, runtime } = await makeRuntime("问题一");
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "旧流内容" });
    expect(raf).toHaveBeenCalledTimes(1);

    runtime.resetStreamState();
    expect(runtime.isStreaming()).toBe(false);
    deps.messages.innerHTML = "";

    deps.input.value = "问题二";
    await runtime.sendTurn(deps.input.value);
    feed(runtime, { type: "token", data: "新流正文" });
    expect(raf).toHaveBeenCalledTimes(2);

    raf.mock.calls[1][0]();
    const node2 = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    expect(node2.querySelector(".chat-stream-tail")!.textContent).toContain("新流正文");

    raf.mock.calls[0][0]();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
    expect(node2.querySelector(".chat-stream-tail")!.textContent).toContain("新流正文");
  });

  it("resetStreamState 后执行旧帧：消息区不被旧流残留渲染污染", async () => {
    const { deps, runtime } = await makeRuntime();
    const raf = holdRaf();

    feed(runtime, { type: "token", data: "旧流内容" });
    expect(raf).toHaveBeenCalledTimes(1);

    runtime.resetStreamState();
    deps.messages.innerHTML = "";

    raf.mock.calls[0][0]();
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-stream-stable")).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-stream-tail")).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-msg-cursor")).toHaveLength(0);
  });
});

describe("tool-turn 持久化与 tool-status 最小消费", () => {
  it("tool-turn → done：chatHistory 按 user → tool 消息 → assistant 顺序写回", async () => {
    const raf = holdRaf();
    const { deps, runtime } = await makeRuntime("问");
    feed(runtime, {
      type: "tool-turn",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"x"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "[]" }
      ]
    });
    feed(runtime, { type: "token", data: "回答" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(chatSessionState.chatHistory[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(chatSessionState.chatHistory[2]).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "[]" });
    expect(chatSessionState.chatHistory[3]).toMatchObject({ role: "assistant", content: "回答" });
    expect(deps.store.persistCurrent).toHaveBeenCalled();
  });

  it("多轮 tool-turn → done：全部轮的 [assistant(tool_calls), tool] 都落进 chatHistory", async () => {
    const raf = holdRaf();
    const { deps, runtime } = await makeRuntime("问");
    feed(runtime, {
      type: "tool-turn",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"第一轮"}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "[]" }
      ]
    });
    feed(runtime, {
      type: "tool-turn",
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "call_2", type: "function", function: { name: "web_search", arguments: '{"query":"第二轮"}' } }] },
        { role: "tool", tool_call_id: "call_2", content: "[]" }
      ]
    });
    feed(runtime, { type: "token", data: "回答" });
    runRafFrames(raf);
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory.map((m) => m.role)).toEqual([
      "user", "assistant", "tool", "assistant", "tool", "assistant"
    ]);
    expect(chatSessionState.chatHistory[1]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(chatSessionState.chatHistory[2]).toMatchObject({ role: "tool", tool_call_id: "call_1" });
    expect(chatSessionState.chatHistory[3]).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_2" }] });
    expect(chatSessionState.chatHistory[4]).toMatchObject({ role: "tool", tool_call_id: "call_2" });
    expect(chatSessionState.chatHistory[5]).toMatchObject({ role: "assistant", content: "回答" });
    expect(deps.store.persistCurrent).toHaveBeenCalled();
  });

  it("error 终态：累积中的 pendingToolMessages 清空，不串入下一条消息", async () => {
    const { runtime } = await makeRuntime("问");
    feed(runtime, {
      type: "tool-turn",
      messages: [{ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_search", arguments: '{"query":"第一轮"}' } }] }, { role: "tool", tool_call_id: "call_1", content: "[]" }]
    });
    feed(runtime, {
      type: "tool-turn",
      messages: [{ role: "tool", tool_call_id: "call_2", content: "[]" }]
    });
    feed(runtime, { type: "error", error: "boom" });

    expect(chatSessionState.chatHistory.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(chatSessionState.chatHistory).toHaveLength(0);

    const { runtime: runtime2 } = await makeRuntime("再问");
    feed(runtime2, { type: "token", data: "答" });
    feed(runtime2, { type: "done" });
    expect(chatSessionState.chatHistory.filter((m) => m.role === "tool")).toHaveLength(0);
  });

  it("tool-status：驱动统一思维链状态条（notice 行消费已由思维链取代）", async () => {
    const raf = holdRaf();
    const { deps, runtime } = await makeRuntime("问");
    feed(runtime, { type: "tool-status", status: "searching", query: "x", platform: "Tavily" });
    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalledWith(expect.stringContaining("Tavily · 搜索中"), 4000);
    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;
    expect(chain).toBeTruthy();
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("联网检索 · x…");
    feed(runtime, { type: "tool-status", status: "done", query: "x", resultCount: 3, platform: "Tavily" });
    expect(chain.querySelector(".chat-thought-chain-summary")!.textContent).toBe("联网检索 0 条");
    expect(chain.querySelector(".chat-thought-step-meta")!.textContent).toBe("3 条 · Tavily");
    runRafFrames(raf);
  });
});

describe("opt-in 一次性说明闸（§6.7 / 票 11）", () => {
  interface StubOptions {
    acknowledged?: boolean;
    saveFails?: boolean;
    chain?: Array<{ provider: Record<string, unknown>; apiKey: string }>;
  }

  function stubSettingsChrome(options: StubOptions = {}): Array<Record<string, unknown>> {
    const sent: Array<Record<string, unknown>> = [];
    const settings = {
      webSearchEnabled: true,
      searchOptInNoticeAcknowledged: options.acknowledged === true
    };
    const chromeStub = {
      runtime: {
        lastError: null as { message?: string } | null,
        getURL: (path: string) => `chrome-extension://test/${path}`,
        sendMessage: (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
          sent.push(msg);
          if (msg?.type === "get-settings") {
            cb?.({ ok: true, settings: { ...settings } });
            return undefined;
          }
          if (msg?.type === "resolve-search-provider") {
            cb?.(options.chain ? { ok: true, chain: options.chain, maxToolCalls: 3 } : { ok: true });
            return undefined;
          }
          if (msg?.type === "save-settings") {
            if (options.saveFails) {
              chromeStub.runtime.lastError = { message: "storage write failed" };
              cb?.(undefined);
              chromeStub.runtime.lastError = null;
              return undefined;
            }
            Object.assign(settings, (msg.settings || {}) as Record<string, unknown>);
            cb?.({ ok: true });
            return undefined;
          }
          cb?.({ ok: true });
          return undefined;
        }
      }
    };
    vi.stubGlobal("chrome", chromeStub);
    return sent;
  }

  function mountReadingView(): void {
    document.body.innerHTML = '<div id="biliscript-reading-view"></div>';
  }

  function dialog(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".confirm-dialog");
  }

  function clickAction(action: "confirm" | "cancel"): void {
    dialog()!.querySelector<HTMLButtonElement>(`[data-confirm-dialog-action="${action}"]`)!.click();
  }

  function chatMessageOf(deps: TestDeps, index = 0): { action: string; webSearchEnabled: boolean; prompt: string } {
    return deps.ports[index].port.postMessage.mock.calls[0][0] as {
      action: string;
      webSearchEnabled: boolean;
      prompt: string;
    };
  }

  it("存量开关开 + 位未置位 → 发送前弹授权；允许并继续 → 写位且该条 webSearchEnabled 仍为 true", async () => {
    const sent = stubSettingsChrome();
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const deps = makeDeps();
    deps.input.value = "开搜的问题";
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn(deps.input.value);

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(deps.ports).toHaveLength(0);
    const box = dialog()!;
    expect(box.querySelector(".confirm-dialog-title")!.textContent).toBe("允许联网搜索？");
    expect(box.querySelector(".confirm-dialog-message")!.textContent).toContain(
      "联网搜索会把查询词发往内置的免 Key 服务（Tavily / Firecrawl / AnySearch / Parallel）"
    );
    expect(box.querySelector(".confirm-dialog-cancel")!.textContent).toBe("关闭联网搜索");
    expect(box.querySelector(".confirm-dialog-confirm")!.textContent).toBe("允许并继续");

    clickAction("confirm");
    await sending;

    expect(sent).toContainEqual({ type: "save-settings", settings: { searchOptInNoticeAcknowledged: true } });
    const chatMsg = chatMessageOf(deps);
    expect(chatMsg.action).toBe("chat");
    expect(chatMsg.webSearchEnabled).toBe(true);
  });

  it("拒绝：该条 webSearchEnabled=false、关闭联网偏好、消息照常发出；下一条消息不再弹层", async () => {
    const sent = stubSettingsChrome();
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const deps = makeDeps();
    deps.input.value = "只问不搜";
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn(deps.input.value);

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");
    await sending;

    expect(chatMessageOf(deps).webSearchEnabled).toBe(false);
    expect(sent).toContainEqual({ type: "save-settings", settings: { webSearchEnabled: false } });
    expect(
      sent.some((m) => m.type === "save-settings" && (m.settings as Record<string, unknown>)?.searchOptInNoticeAcknowledged)
    ).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("只问不搜");
    expect(dialog()).toBeNull();

    feed(runtime, { type: "done" });
    await runtime.sendTurn("下一句");
    expect(dialog()).toBeNull();
    expect(chatMessageOf(deps, 1).webSearchEnabled).toBe(false);
  });

  it("位已置位 → 不弹层且该条 webSearchEnabled 为 true", async () => {
    const sent = stubSettingsChrome({ acknowledged: true });
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const { deps } = await makeRuntime("已同意过");

    expect(dialog()).toBeNull();
    expect(chatMessageOf(deps).webSearchEnabled).toBe(true);
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
  });

  it("付费链：授权文案提示会产生费用（不写成价格承诺）", async () => {
    stubSettingsChrome({
      chain: [
        {
          provider: {
            id: "search_deepseek",
            presetId: "deepseek",
            name: "DeepSeek Search",
            type: "deepseek",
            baseUrl: "https://api.deepseek.com",
            access: "paid"
          },
          apiKey: "sk-deepseek"
        }
      ]
    });
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const deps = makeDeps();
    deps.input.value = "会花钱吗";
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn(deps.input.value);

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    const message = dialog()!.querySelector(".confirm-dialog-message")!.textContent!;
    expect(message).toContain("使用付费平台会产生费用");
    expect(message).toContain("具体计费方式以该平台为准");
    expect(message).not.toMatch(/¥|\$\d|\d+\s*元|免费额度/);

    clickAction("confirm");
    await sending;
    expect(chatMessageOf(deps).webSearchEnabled).toBe(true);
  });

  it("授权写失败：本轮照常带搜索继续，不伪造授权位；下一条消息仍会询问", async () => {
    stubSettingsChrome({ saveFails: true });
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const deps = makeDeps();
    deps.input.value = "写失败也要继续";
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn(deps.input.value);

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("confirm");
    await sending;
    expect(chatMessageOf(deps).webSearchEnabled).toBe(true);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("写失败也要继续");

    feed(runtime, { type: "done" });
    const second = runtime.sendTurn("再问一句");
    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");
    await second;
  });

  it("弹窗挂起时用户消息不上屏、输入保留；授权后才进入受理下游", async () => {
    stubSettingsChrome();
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const deps = makeDeps();
    deps.input.value = "等待授权的问题";
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn(deps.input.value);

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    expect(deps.messages.querySelector(".chat-msg-user")).toBeNull();
    expect(deps.input.value).toBe("等待授权的问题");
    expect(deps.ui.autosizeInput).not.toHaveBeenCalled();
    expect(deps.ports).toHaveLength(0);
    expect(deps.ui.setStreamingUiState).not.toHaveBeenCalled();
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBeNull();

    clickAction("confirm");
    await sending;
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("等待授权的问题");
    expect(deps.input.value).toBe("");
    expect(chatMessageOf(deps).webSearchEnabled).toBe(true);
  });

  it("对话草稿恢复后的发送：拒绝授权后消息照常发出、草稿清空、主任务继续", async () => {
    stubSettingsChrome();
    chatSessionStateForTests.webSearchEnabled = true;
    mountReadingView();

    const deps = makeDeps();
    deps.input.value = "恢复的草稿";
    const runtime = createChatRuntime(deps);
    const sending = runtime.sendTurn(deps.input.value);

    await vi.waitFor(() => expect(dialog()).not.toBeNull());
    clickAction("cancel");
    await sending;

    expect(chatMessageOf(deps).prompt).toBe("恢复的草稿");
    expect(chatMessageOf(deps).webSearchEnabled).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("恢复的草稿");
    expect(deps.input.value).toBe("");
    expect(deps.messages.querySelector(".chat-msg-assistant")).not.toBeNull();
  });

  it("阅读视图未挂载 → 本轮不搜索（fail-closed），且不关闭联网偏好", async () => {
    const sent = stubSettingsChrome();
    chatSessionStateForTests.webSearchEnabled = true;
    const { deps } = await makeRuntime("未挂载");

    expect(dialog()).toBeNull();
    expect(chatMessageOf(deps).webSearchEnabled).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-user")?.textContent).toBe("未挂载");
    expect(sent.some((m) => m.type === "save-settings")).toBe(false);
  });
});

describe("消息操作：重新生成与导出", () => {
  async function makeTwoTurnConversation() {
    const { deps, runtime } = await makeRuntime("第一问");
    feed(runtime, { type: "token", data: "第一答" });
    feed(runtime, { type: "done" });
    await runtime.sendTurn("第二问");
    feed(runtime, { type: "token", data: "第二答" });
    feed(runtime, { type: "done" });
    return { deps, runtime };
  }

  async function regenerateAt(deps: TestDeps, index: number): Promise<void> {
    deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-regenerate-btn")[index].click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));
  }

  it("重新生成较早回答：沿用原问题和之前历史，保留草稿，成功后原位替换并删除后续", async () => {
    const { deps, runtime } = await makeTwoTurnConversation();
    deps.input.value = "尚未发送的草稿";

    await regenerateAt(deps, 0);

    const request = deps.ports[2].port.postMessage.mock.calls[0][0];
    expect(request.prompt).toBe("第一问");
    expect(request.history).toEqual([]);
    expect(deps.input.value).toBe("尚未发送的草稿");
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(2);
    expect(deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant")[1].hidden).toBe(true);
    expect([...deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-regenerate-btn")].every((button) => button.disabled)).toBe(true);

    feed(runtime, { type: "token", data: "新的第一答" });
    feed(runtime, { type: "done" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "新的第一答" }
    ]);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")).toHaveLength(1);
    expect(deps.messages.querySelector(".chat-msg-assistant-body")?.textContent).toBe("新的第一答");
  });

  it("重新生成失败：恢复原回答、后续消息和历史，不保留半截新内容", async () => {
    const { deps, runtime } = await makeTwoTurnConversation();
    await regenerateAt(deps, 0);

    feed(runtime, { type: "tool-status", status: "searching", query: "新搜索" });
    expect(deps.messages.querySelector(".chat-thought-chain")?.getAttribute("data-status")).toBe("searching");
    feed(runtime, { type: "token", data: "失败的新回答" });
    feed(runtime, { type: "error", error: "网络中断" });

    expect(chatSessionState.chatHistory).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "第二问" },
      { role: "assistant", content: "第二答" }
    ]);
    const assistants = deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant");
    expect(assistants[0].textContent).toContain("第一答");
    expect(assistants[0].textContent).not.toContain("失败的新回答");
    expect(assistants[1].textContent).toContain("第二答");
    expect(assistants[1].hidden).toBe(false);
    expect(deps.messages.querySelector(".chat-thought-chain")).toBeNull();
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("重新生成失败：网络中断", 4000);
  });

  it("重新生成后手动停止：已有部分内容则替换旧回答并标记停止", async () => {
    const { deps, runtime } = await makeTwoTurnConversation();
    await regenerateAt(deps, 1);

    expect(deps.ports[2].port.postMessage.mock.calls[0][0].history).toEqual([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" }
    ]);
    feed(runtime, { type: "token", data: "部分新回答" });
    feed(runtime, { type: "stopped", reason: "用户手动停止" });

    expect(chatSessionState.chatHistory[3]).toEqual({ role: "assistant", content: "部分新回答", stopped: true });
    expect(deps.messages.querySelectorAll(".chat-msg-assistant")[1].textContent).toContain("部分新回答");
    expect(deps.messages.querySelector(".chat-msg-stopped")?.textContent).toBe("用户手动停止");
  });

  it("重新生成后手动停止：尚无内容则恢复完整原对话", async () => {
    const { deps, runtime } = await makeTwoTurnConversation();
    await regenerateAt(deps, 0);

    feed(runtime, { type: "stopped", reason: "用户手动停止" });

    expect(chatSessionState.chatHistory).toHaveLength(4);
    const assistants = deps.messages.querySelectorAll<HTMLElement>(".chat-msg-assistant");
    expect(assistants[0].textContent).toContain("第一答");
    expect(assistants[1].textContent).toContain("第二答");
    expect(assistants[1].hidden).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-stopped")).toBeNull();
  });

  it("导出：下载与复制口径一致的 Markdown，文件名包含视频标题和回答序号", async () => {
    const { deps } = await makeTwoTurnConversation();
    chatSessionStateForTests.currentConversationMeta = { contextTitle: "视频: 标题" };
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let exportedBlob: Blob | undefined;
    let clickedAnchor: HTMLAnchorElement | null = null;
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn((blob: Blob) => {
        exportedBlob = blob;
        return "blob:chat-answer";
      })
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchor = this;
    });

    try {
      deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-export-btn")[0].click();

      expect(clickedAnchor!.download).toBe("视频_ 标题-回答-1.md");
      expect(exportedBlob?.type).toBe("text/markdown;charset=utf-8");
      expect(await exportedBlob?.text()).toBe("第一答");

      chatSessionStateForTests.currentConversationMeta = null;
      deps.messages.querySelectorAll<HTMLButtonElement>(".chat-msg-export-btn")[1].click();
      expect(clickedAnchor!.download).toBe("BiliScript-回答-2.md");
      expect(await exportedBlob?.text()).toBe("第二答");
    } finally {
      Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
      Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
    }
  });
});

describe("历史截帧的回合生命周期与慢响应守卫", () => {
  const searching = {
    type: "tool-status",
    status: "searching",
    tool: "capture_video_frame_at_time",
    query: "0:12",
    callId: "history-1",
    targetTime: 12
  } satisfies ChatPortMessage;

  it.each(["stopped", "disconnect"] as const)("%s 将截帧收口为已取消，迟到状态不更新旧思维链", async (terminal) => {
    const { deps, session } = await makeRuntime();
    session.listeners.message[0](searching);
    const chain = deps.messages.querySelector<HTMLElement>(".chat-thought-chain")!;

    if (terminal === "stopped") {
      session.listeners.message[0]({ type: "stopped", reason: "已停止生成" });
    } else {
      session.listeners.disconnect[0]();
    }
    expect(chain.dataset.status).toBe("cancelled");
    expect(chain.querySelector(".chat-thought-step-meta")!.textContent).toBe("已取消");
    expect(chain.querySelector(".is-running")).toBeNull();
    const settledText = chain.textContent;

    session.listeners.message[0]({
      type: "tool-status",
      status: "done",
      tool: "capture_video_frame_at_time",
      query: "0:12",
      callId: "history-1",
      targetTime: 12,
      resultCount: 1,
      expectedCount: 3,
      frames: [{ image: { mime: "image/jpeg", data: "/9j/" }, currentTime: 12 }]
    });
    expect(chain.textContent).toBe(settledText);
    expect(chain.querySelectorAll(".chat-video-frame-item")).toHaveLength(0);
  });

  it("截帧活动覆盖 15 秒阈值与 45 秒等待时不误报模型响应较慢", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime();
    feed(runtime, searching);

    vi.advanceTimersByTime(45000);
    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);
    expect(deps.messages.querySelector(".chat-thought-step-detail")!.textContent).toBe("00:12 附近");
  });

  it("最后一个工具终态后重新武装慢响应提示，首 token 正常撤下", async () => {
    vi.useFakeTimers();
    const { deps, runtime } = await makeRuntime();
    feed(runtime, searching);
    vi.advanceTimersByTime(45000);
    feed(runtime, {
      type: "tool-status",
      status: "done",
      tool: "capture_video_frame_at_time",
      query: "0:12",
      callId: "history-1",
      targetTime: 12,
      resultCount: 1,
      expectedCount: 3,
      frames: [{ image: { mime: "image/jpeg", data: "/9j/" }, currentTime: 12 }]
    });

    vi.advanceTimersByTime(14999);
    expect(deps.ui.showConversationContextNotice).not.toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);
    vi.advanceTimersByTime(1);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith(SLOW_NOTICE_TEXT, 0);
    feed(runtime, { type: "token", data: "继续回答" });
    expect(deps.ui.removeConversationContextNotice).toHaveBeenCalled();
  });

  it("旧端口在新回合后的迟到消息与断连不影响新回合", async () => {
    const { deps, runtime, session } = await makeRuntime("第一问");
    session.listeners.message[0](searching);
    runtime.resetStreamState();
    deps.input.value = "第二问";
    await runtime.sendTurn(deps.input.value);
    const next = deps.ports[1];
    next.listeners.message[0]({ type: "token", data: "新回答" });

    session.listeners.message[0]({ type: "token", data: "旧回答" });
    session.listeners.disconnect[0]();

    expect(runtime.isStreaming()).toBe(true);
    next.listeners.message[0]({ type: "done" });
    expect(deps.messages.textContent).toContain("新回答");
    expect(deps.messages.textContent).not.toContain("旧回答");
  });

  it("活动端口非预期断开：收口思考/光标/慢提示并报错，支持原位重试、草稿图片还原与配置错误免重试", async () => {
    const { MISSING_PROVIDER_KEY_MESSAGE } = await import("../../extension/core/overview-setup-error.js");
    const restoredDrafts: Array<{ text: string; images: Array<{ mime: string; data: string }>; isSetupError: boolean }> = [];
    const currentImages: Array<{ mime: string; data: string }> = [{ mime: "image/webp", data: "IMG1" }];
    const deps = makeDeps();
    deps.getInputImages = () => [...currentImages];
    deps.takeInputImages = () => currentImages.splice(0, currentImages.length);
    deps.onTurnFailedRestoreDraft = (draft) => {
      restoredDrafts.push(draft);
      if (!deps.input.value.trim()) {
        deps.input.value = draft.text;
      }
      if (currentImages.length === 0 && draft.images.length > 0) {
        currentImages.push(...draft.images);
      }
    };
    const runtime = createChatRuntime(deps);

    deps.input.value = "带图提问";
    await runtime.sendTurn(deps.input.value);
    feed(runtime, { type: "token", data: "半截" });
    deps.ports[0].listeners.disconnect[0]();

    expect(runtime.isStreaming()).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-cursor")).toBeNull();
    expect(deps.messages.querySelector(".chat-msg-error")?.textContent).toBe("错误：对话连接已中断，请重试");
    expect(deps.messages.querySelectorAll('[data-uncommitted-failed-turn="1"]')).toHaveLength(2);
    expect(restoredDrafts[0]).toEqual({
      text: "带图提问",
      images: [{ mime: "image/webp", data: "IMG1" }],
      isSetupError: false
    });
    expect(deps.input.value).toBe("带图提问");

    const retryBtn = deps.messages.querySelector<HTMLButtonElement>(".chat-msg-retry-btn");
    expect(retryBtn).not.toBeNull();
    retryBtn!.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(2));
    expect(deps.input.value).toBe("");
    expect(currentImages).toHaveLength(0);
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);
    expect(deps.messages.querySelectorAll('[data-uncommitted-failed-turn="1"]')).toHaveLength(0);
    expect(deps.ports[1].port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "带图提问", images: [{ mime: "image/webp", data: "IMG1" }] })
    );

    feed(runtime, { type: "error", error: "网络抖动" });
    deps.input.value = "用户新输入草稿";
    const retry2 = deps.messages.querySelector<HTMLButtonElement>(".chat-msg-retry-btn")!;
    retry2.click();
    await vi.waitFor(() => expect(deps.ports).toHaveLength(3));
    expect(deps.input.value).toBe("用户新输入草稿");
    expect(deps.ports[2].port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "带图提问" })
    );
    feed(runtime, { type: "done" });

    deps.input.value = "无 Key 发送";
    await runtime.sendTurn(deps.input.value);
    feed(runtime, { type: "error", error: MISSING_PROVIDER_KEY_MESSAGE });
    expect(deps.messages.querySelector(".chat-msg-retry-btn")).toBeNull();
    expect(restoredDrafts.at(-1)?.isSetupError).toBe(true);
  });

  it("acceptanceEpoch 守卫：在途上下文闸与建连期间被 resetStreamState 作废时不追发请求并断开迟到端口", async () => {
    let releaseContext!: (value: { pass: boolean }) => void;
    const deps = makeDeps();
    deps.ensureCurrentContextForSend = vi.fn(() => new Promise<{ pass: boolean }>((resolve) => {
      releaseContext = resolve;
    }));
    const runtime = createChatRuntime(deps);

    const pendingTurn1 = runtime.sendTurn("闸内重置");
    runtime.resetStreamState();
    releaseContext({ pass: true });
    await expect(pendingTurn1).resolves.toBe("blocked");
    expect(deps.ports).toHaveLength(0);

    let resolvePort!: (p: TestPort["port"]) => void;
    deps.ensureCurrentContextForSend = vi.fn(async () => ({ pass: true }));
    deps.connectPort = vi.fn(() => new Promise<TestPort["port"]>((resolve) => {
      resolvePort = resolve;
    }));
    const pendingTurn2 = runtime.sendTurn("建连内重置");
    await vi.waitFor(() => expect(deps.connectPort).toHaveBeenCalledTimes(1));
    runtime.resetStreamState();
    const lateSession = makePort();
    resolvePort(lateSession.port);
    await expect(pendingTurn2).resolves.toBe("blocked");
    expect(lateSession.port.disconnect).toHaveBeenCalledTimes(1);
    expect(lateSession.port.postMessage).not.toHaveBeenCalled();
  });

  it("思考过程中断 stop() 清理开始时间并启用按钮 aria-expanded=true；跨视频 pinned 会话关闭截帧工具", async () => {
    chatSessionStateForTests.currentContextKey = "video:BV1pinned|1";
    chatSessionStateForTests.liveContextKey = "video:BV1other|1";
    const deps = makeDeps();
    deps.canUseVideoFrameTool = vi.fn(async () => true);
    const runtime = createChatRuntime(deps);

    await runtime.sendTurn("思考断流与跨视频");
    expect(deps.ports[0].port.postMessage.mock.calls[0][0]).not.toHaveProperty("videoFrameToolEnabled");
    feed(runtime, { type: "reasoning", data: "推演中" });
    feed(runtime, { type: "stopped", reason: "已中断" });

    const labelBtn = deps.messages.querySelector<HTMLButtonElement>(".chat-thinking-label")!;
    expect(labelBtn.disabled).toBe(false);
    expect(labelBtn.getAttribute("aria-expanded")).toBe("true");
  });

  it("sendTurn({ preserveInputDraft: true })：不读取也不清空输入框草稿与图片，错误时也不回填进空输入框", async () => {
    const restoredDrafts: Array<{ text: string; images: Array<{ mime: string; data: string }>; isSetupError: boolean }> = [];
    const currentImages: Array<{ mime: string; data: string }> = [{ mime: "image/webp", data: "IMG_DRAFT" }];
    const deps = makeDeps();
    deps.getInputImages = () => [...currentImages];
    deps.takeInputImages = () => currentImages.splice(0, currentImages.length);
    deps.onTurnFailedRestoreDraft = (draft) => {
      restoredDrafts.push(draft);
    };
    const runtime = createChatRuntime(deps);

    deps.input.value = "未发送的文字草稿";
    await expect(runtime.sendTurn("快捷总结", { preserveInputDraft: true })).resolves.toBe("accepted");
    expect(deps.input.value).toBe("未发送的文字草稿");
    expect(currentImages).toEqual([{ mime: "image/webp", data: "IMG_DRAFT" }]);
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "快捷总结" })
    );
    expect((deps.ports[0].port.postMessage.mock.calls[0][0] as { images?: unknown[] }).images).toBeUndefined();
    feed(runtime, { type: "done" });
    expect(deps.input.value).toBe("未发送的文字草稿");
    expect(currentImages).toHaveLength(1);

    deps.input.value = "";
    await expect(runtime.sendTurn("失败的快捷总结", { preserveInputDraft: true })).resolves.toBe("accepted");
    feed(runtime, { type: "error", error: "网络异常" });
    expect(restoredDrafts).toEqual([]);
    expect(deps.input.value).toBe("");
  });
});
