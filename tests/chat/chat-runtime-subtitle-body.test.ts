// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { ChatPort } from "../../extension/chat/chat-runtime.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

interface PortSession {
  port: FakePort;
  listeners: {
    message: Array<(message: unknown) => void>;
    disconnect: Array<() => void>;
  };
}

type ChatRuntime = ReturnType<typeof import("../../extension/chat/chat-runtime.js").createChatRuntime>;

const CONTEXT_KEY = "video:BV1body|101";
const SUBTITLE_BODY = [{ from: 0, to: 5, content: "x".repeat(1000) }];

function makePort(): PortSession {
  const listeners: PortSession["listeners"] = { message: [], disconnect: [] };
  return {
    port: {
      name: "offscreen-chat",
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

function makeRuntime() {
  const ports: PortSession[] = [];
  const deps = {
    messages: document.createElement("div"),
    input: document.createElement("textarea"),
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
    getSelectedModel: () => "test-model",
    getTimestampNavDeps: () => ({}),
    normalizeMarkdownForSectionPaste,
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port as unknown as ChatPort;
    })
  };
  return { runtime: createChatRuntime(deps), deps, ports };
}

function seedVideoContext() {
  chatSessionStateForTests.contextData = {
    bvid: "BV1body",
    cid: "101",
    title: "长视频",
    url: "https://www.bilibili.com/video/BV1body/",
    subtitleBody: SUBTITLE_BODY
  };
  chatSessionStateForTests.currentContextKey = CONTEXT_KEY;
}

async function send(runtime: ChatRuntime, deps: ReturnType<typeof makeRuntime>["deps"], text: string) {
  deps.input.value = text;
  await runtime.sendTurn(deps.input.value);
}

function getChatMessage(session: PortSession) {
  expect(session.port.postMessage).toHaveBeenCalledTimes(1);
  const msg = session.port.postMessage.mock.calls[0][0];
  expect(msg.action).toBe("chat");
  return msg;
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
});

describe("追问消息的字幕体省略传输", () => {
  it("首条消息：lastAcked 为空 → context 携带全量 subtitleBody 与 contextKey", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");

    const msg = getChatMessage(ports[0]);
    expect(msg.contextKey).toBe(CONTEXT_KEY);
    expect(msg.context.subtitleBody).toBe(SUBTITLE_BODY);
    expect(msg.context.aiSystemPrompt).toBe("");
  });

  it("收到 cachedContextKey 回执后：追问 context 省略 subtitleBody，元数据/history 照常全量", async () => {
    seedVideoContext();
    chatSessionStateForTests.aiPrefs.aiSystemPrompt = "你是助手";
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");
    const first = getChatMessage(ports[0]);
    expect(first.context.subtitleBody).toBe(SUBTITLE_BODY);
    ports[0].listeners.message[0]({ type: "token", data: "你好", cachedContextKey: CONTEXT_KEY });
    ports[0].listeners.message[0]({ type: "done", cachedContextKey: CONTEXT_KEY });
    expect(ports[0].port.disconnect).toHaveBeenCalled();

    await send(runtime, deps, "第二章讲了什么？");
    const second = getChatMessage(ports[1]);
    expect(second.contextKey).toBe(CONTEXT_KEY);
    expect("subtitleBody" in second.context).toBe(false);
    expect(second.context.title).toBe("长视频");
    expect(second.context.bvid).toBe("BV1body");
    expect(second.context.aiSystemPrompt).toBe("你是助手");
    expect(second.history).toEqual(chatSessionState.chatHistory);
    expect(second.prompt).toBe("第二章讲了什么？");
  });

  it("字幕体缺失错误（code subtitle-body-missing）→ lastAcked 重置，下一条重新携带全文", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");
    ports[0].listeners.message[0]({ type: "done", cachedContextKey: CONTEXT_KEY });

    await send(runtime, deps, "第二章讲了什么？");
    expect("subtitleBody" in getChatMessage(ports[1]).context).toBe(false);
    ports[1].listeners.message[0]({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
    expect(ports[1].port.disconnect).toHaveBeenCalled();

    await send(runtime, deps, "再试一次");
    const third = getChatMessage(ports[2]);
    expect(third.context.subtitleBody).toBe(SUBTITLE_BODY);
  });

  it("port 断连（offscreen 文档被回收）→ lastAcked 重置，下一条重新携带全文", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");
    ports[0].listeners.message[0]({ type: "token", data: "部分输出", cachedContextKey: CONTEXT_KEY });

    ports[0].listeners.disconnect[0]();

    await send(runtime, deps, "继续");
    const second = getChatMessage(ports[1]);
    expect(second.contextKey).toBe(CONTEXT_KEY);
    expect(second.context.subtitleBody).toBe(SUBTITLE_BODY);
  });

  it("普通错误（非字幕体缺失）不重置 lastAcked：确认过缓存仍可省略", async () => {
    seedVideoContext();
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "总结一下这个视频");
    ports[0].listeners.message[0]({ type: "error", error: "网络错误", cachedContextKey: CONTEXT_KEY });

    await send(runtime, deps, "继续");
    expect("subtitleBody" in getChatMessage(ports[1]).context).toBe(false);
  });
});

describe("无字幕体上下文的兜底行为", () => {
  it("contextData 无 subtitleBody 字段时照常发送（省略条件不满足）", async () => {
    chatSessionStateForTests.contextData = { title: "无字幕页面", isVideoContext: false };
    chatSessionStateForTests.currentContextKey = "url:https://www.bilibili.com/";
    const { runtime, deps, ports } = makeRuntime();

    await send(runtime, deps, "随便聊聊");

    const msg = getChatMessage(ports[0]);
    expect(msg.contextKey).toBe("url:https://www.bilibili.com/");
    expect(msg.context.subtitleBody).toBeUndefined();
  });
});
