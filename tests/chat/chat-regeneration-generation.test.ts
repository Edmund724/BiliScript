import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeMarkdownForSectionPaste } from "../../extension/notes/paste.js";
import type { AiContext, ImagePart } from "../../extension/ai/types.js";
import type { ChatPortMessage } from "../../extension/chat/protocol.js";

let createChatRuntime: typeof import("../../extension/chat/chat-runtime.js").createChatRuntime;
let state: typeof import("../../extension/chat/chat-state.js");

type ChatRuntime = ReturnType<typeof createChatRuntime>;
type TestDeps = ReturnType<typeof makeDeps>;

const IMAGE: ImagePart = { mime: "image/webp", data: "b3JpZ2luYWwtaW1hZ2U" };
const VIDEO_A: AiContext = {
  title: "视频 A",
  bvid: "BV1A",
  cid: "101",
  pageIndex: 2,
  pageTitle: "原分P",
  url: "https://www.bilibili.com/video/BV1A/?p=2",
  subtitleBody: [{ from: 0, to: 1, content: "原视频字幕" }]
};
const VIDEO_B: AiContext = {
  title: "视频 B",
  bvid: "BV1B",
  cid: "202",
  pageIndex: 1,
  pageTitle: "当前视频",
  url: "https://www.bilibili.com/video/BV1B/",
  subtitleBody: [{ from: 0, to: 1, content: "当前视频字幕" }]
};

function makePort() {
  const listeners: { message: Array<(msg: unknown) => void>; disconnect: Array<() => void> } = {
    message: [],
    disconnect: []
  };
  return {
    port: {
      name: "offscreen-chat",
      onMessage: { addListener: (fn: (msg: unknown) => void) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn: () => void) => listeners.disconnect.push(fn) },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    emit(message: ChatPortMessage) {
      listeners.message.forEach((listener) => listener(message));
    },
    emitDisconnect() {
      listeners.disconnect.forEach((listener) => listener());
    }
  };
}

function makeDeps() {
  const messages = document.createElement("div");
  const input = document.createElement("textarea");
  const ports: Array<ReturnType<typeof makePort>> = [];
  let inputImages: ImagePart[] = [];
  return {
    messages,
    input,
    ports,
    store: {
      persistCurrent: vi.fn(async () => {}),
      isCurrent: vi.fn((id: string) => id === state.chatSessionState.currentConversationId)
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
    getInputImages: () => [...inputImages],
    takeInputImages: (snapshot?: ImagePart[]) => {
      const taken = snapshot ?? inputImages;
      inputImages = [];
      return taken;
    },
    setInputImages(images: ImagePart[]) {
      inputImages = [...images];
    },
    confirmRegenerationContext: undefined as ((message: string) => boolean | Promise<boolean>) | undefined,
    canUseVideoFrameTool: undefined as (() => Promise<boolean>) | undefined,
    connectPort: vi.fn(async () => {
      const session = makePort();
      ports.push(session);
      return session.port;
    })
  };
}

async function makeRuntime(text = "问题") {
  const deps = makeDeps();
  deps.input.value = text;
  const runtime = createChatRuntime(deps);
  await runtime.sendTurn(text);
  return { deps, runtime, session: deps.ports[0] };
}

function feed(runtime: ChatRuntime, message: ChatPortMessage) {
  runtime.handleChatPortMessage(message);
}

function toolTurn(callId: string, query: string): Extract<ChatPortMessage, { type: "tool-turn" }> {
  return {
    type: "tool-turn",
    generation: 1,
    messages: [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: callId, type: "function", function: { name: "web_search", arguments: JSON.stringify({ query }) } }]
      },
      { role: "tool", tool_call_id: callId, content: query }
    ]
  };
}

function source(title: string, url: string) {
  return { title, url, snippet: `${title}摘要` };
}

function frame(data: string, currentTime: number) {
  return { image: { mime: "image/webp", data }, currentTime };
}

async function makeOriginalAnswer(options: { images?: ImagePart[]; toolCard?: boolean } = {}) {
  state.applyContextToMain({ ...VIDEO_A });
  state.applyLiveContextSnapshot({ ...VIDEO_A });
  const deps = makeDeps();
  deps.setInputImages(options.images || []);
  deps.input.value = "原问题";
  const runtime = createChatRuntime(deps);
  await runtime.sendTurn("原问题");
  if (options.toolCard) {
    feed(runtime, {
      type: "tool-status",
      status: "searching",
      query: "原搜索",
      callId: "shared-call",
      generation: 0
    });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      query: "原搜索",
      callId: "shared-call",
      generation: 0,
      sources: [source("原来源", "https://old.example.com")]
    });
    feed(runtime, {
      type: "tool-turn",
      generation: 0,
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "shared-call", type: "function", function: { name: "web_search", arguments: '{"query":"原搜索"}' } }]
        },
        { role: "tool", tool_call_id: "shared-call", content: "原工具结果" }
      ]
    });
  }
  feed(runtime, { type: "token", data: "原回答" });
  feed(runtime, { type: "done" });
  return { deps, runtime };
}

function pinOriginalContext() {
  state.chatSessionStateForTests.currentConversationMeta = {
    ...state.chatSessionState.currentConversationMeta,
    contextKey: "video:BV1A|101",
    contextTitle: VIDEO_A.title,
    contextUrl: VIDEO_A.url,
    pinnedContext: true,
    resolvedContext: { ...VIDEO_A }
  };
}

function switchToVideoB() {
  state.applyContextToMain({ ...VIDEO_B });
  state.applyLiveContextSnapshot({ ...VIDEO_B });
}

function clickRegenerate(deps: TestDeps) {
  deps.messages.querySelector<HTMLButtonElement>(".chat-msg-regenerate-btn")!.click();
}

async function waitForPort(deps: TestDeps, count: number) {
  await vi.waitFor(() => expect(deps.ports).toHaveLength(count));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  ({ createChatRuntime } = await import("../../extension/chat/chat-runtime.js"));
  state = await import("../../extension/chat/chat-state.js");
  state.resetChatSessionStateForTests();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("工具循环代际隔离", () => {
  it("stream-reset 清上一代待落库工具消息，迟到 tool-turn 不进入新历史", async () => {
    const { runtime } = await makeRuntime("问题");
    feed(runtime, {
      type: "tool-turn",
      generation: 0,
      messages: [{ role: "tool", tool_call_id: "old", content: "上一代" }]
    });
    feed(runtime, { type: "stream-reset", generation: 1 });
    feed(runtime, toolTurn("new", "新工具结果"));
    feed(runtime, {
      type: "tool-turn",
      generation: 0,
      messages: [{ role: "tool", tool_call_id: "late", content: "迟到旧结果" }]
    });
    feed(runtime, { type: "stream-reset", generation: 1 });
    feed(runtime, { type: "token", data: "回答" });
    feed(runtime, { type: "done" });

    expect(state.chatSessionState.chatHistory).toEqual([
      { role: "user", content: "问题" },
      ...toolTurn("new", "新工具结果").messages,
      { role: "assistant", content: "回答" }
    ]);
  });

  it("搜索与截帧可复用旧 callId，迟到旧事件不能改写新卡片", async () => {
    const { deps, runtime } = await makeRuntime();
    feed(runtime, { type: "tool-status", status: "searching", query: "旧搜索", callId: "search", generation: 0 });
    feed(runtime, {
      type: "tool-status",
      status: "searching",
      tool: "capture_video_frame_at_time",
      query: "0:01",
      targetTime: 1,
      callId: "frame",
      generation: 0
    });
    feed(runtime, { type: "stream-reset", generation: 1 });
    feed(runtime, { type: "tool-status", status: "searching", query: "新搜索", callId: "search", generation: 1 });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      query: "新搜索",
      callId: "search",
      generation: 1,
      resultCount: 1,
      sources: [source("新来源", "https://new.example.com")]
    });
    feed(runtime, {
      type: "tool-status",
      status: "searching",
      tool: "capture_video_frame_at_time",
      query: "0:12",
      targetTime: 12,
      callId: "frame",
      generation: 1
    });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      tool: "capture_video_frame_at_time",
      query: "0:12",
      targetTime: 12,
      callId: "frame",
      generation: 1,
      resultCount: 1,
      expectedCount: 1,
      frames: [frame("bmV3LWZyYW1l", 12)]
    });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      query: "旧搜索",
      callId: "search",
      generation: 0,
      sources: [source("迟到旧来源", "https://late.example.com")]
    });
    feed(runtime, {
      type: "tool-status",
      status: "done",
      tool: "capture_video_frame_at_time",
      query: "0:01",
      targetTime: 1,
      callId: "frame",
      generation: 0,
      frames: [frame("b2xkLWZyYW1l", 1)]
    });

    const cards = deps.messages.querySelectorAll(".chat-search-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].textContent).toContain("新搜索");
    expect(cards[0].textContent).not.toContain("旧搜索");
    expect(cards[0].querySelectorAll(".chat-search-source-row")).toHaveLength(1);
    expect(cards[0].querySelector(".chat-search-source-title")?.textContent).toBe("新来源");
    const thumbnails = cards[0].querySelectorAll<HTMLImageElement>(".chat-video-frame-item img");
    expect(thumbnails).toHaveLength(1);
    expect(thumbnails[0].src).toContain("bmV3LWZyYW1l");
    expect(cards[0].querySelector(".chat-video-frame-time")?.textContent).toBe("00:12");
  });
});

describe("重新生成的原上下文与恢复", () => {
  it("保留原问题和图片，失败后恢复原工具卡且后续发送不受阻", async () => {
    const { deps, runtime } = await makeOriginalAnswer({ images: [IMAGE], toolCard: true });
    const originalHistory = [...state.chatSessionState.chatHistory];
    const originalAssistant = deps.messages.querySelector<HTMLElement>(".chat-msg-assistant")!;
    const originalCard = deps.messages.querySelector<HTMLElement>(".chat-search-card")!;

    clickRegenerate(deps);
    await waitForPort(deps, 2);
    const request = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(request.prompt).toBe("原问题");
    expect(request.images).toEqual([IMAGE]);
    expect(request.context.bvid).toBe("BV1A");
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);

    feed(runtime, { type: "tool-status", status: "searching", query: "新搜索", callId: "shared-call", generation: 0 });
    feed(runtime, toolTurn("shared-call", "新工具结果"));
    feed(runtime, { type: "token", data: "半截新回答" });
    feed(runtime, { type: "error", error: "网络中断" });

    expect(state.chatSessionState.chatHistory).toEqual(originalHistory);
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBe(originalAssistant);
    expect(deps.messages.querySelector(".chat-search-card")).toBe(originalCard);
    expect(originalAssistant.textContent).toContain("原回答");
    expect(originalAssistant.textContent).not.toContain("半截新回答");
    expect(originalCard.textContent).toContain("原来源");
    expect(originalCard.textContent).not.toContain("新搜索");

    await expect(runtime.sendTurn("后续问题")).resolves.toBe("accepted");
    feed(runtime, { type: "token", data: "后续回答" });
    feed(runtime, { type: "done" });
    expect(state.chatSessionState.chatHistory.slice(-2)).toEqual([
      { role: "user", content: "后续问题", contextKey: "video:BV1A|101" },
      { role: "assistant", content: "后续回答" }
    ]);
  });

  it("跨视频确认取消时不起流，恢复原回答并允许继续发送", async () => {
    const { deps, runtime } = await makeOriginalAnswer({ toolCard: true });
    pinOriginalContext();
    switchToVideoB();
    const originalHistory = [...state.chatSessionState.chatHistory];
    const originalCard = deps.messages.querySelector(".chat-search-card");
    const confirm = vi.fn(async () => false);
    deps.confirmRegenerationContext = confirm;
    const ensureCalls = deps.ensureCurrentContextForSend.mock.calls.length;

    clickRegenerate(deps);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(runtime.isTurnActive()).toBe(false));

    expect(deps.ports).toHaveLength(1);
    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(ensureCalls);
    expect(state.chatSessionState.chatHistory).toEqual(originalHistory);
    expect(deps.messages.querySelector(".chat-search-card")).toBe(originalCard);
    expect(deps.messages.querySelector(".chat-msg-assistant")?.textContent).toContain("原回答");
    expect(deps.messages.querySelectorAll(".chat-msg-user")).toHaveLength(1);

    await expect(runtime.sendTurn("取消后的新问题")).resolves.toBe("accepted");
    feed(runtime, { type: "done" });
    expect(deps.ports).toHaveLength(2);
  });

  it("跨视频确认后仍请求原分P和字幕，不开放当前页截帧", async () => {
    const { deps, runtime } = await makeOriginalAnswer();
    pinOriginalContext();
    switchToVideoB();
    deps.confirmRegenerationContext = vi.fn(async () => true);
    deps.canUseVideoFrameTool = vi.fn(async () => true);
    const ensureCalls = deps.ensureCurrentContextForSend.mock.calls.length;

    clickRegenerate(deps);
    await waitForPort(deps, 2);

    const request = deps.ports[1].port.postMessage.mock.calls[0][0];
    expect(request.contextKey).toBe("video:BV1A|101");
    expect(request.context).toMatchObject({
      bvid: "BV1A",
      cid: "101",
      pageIndex: 2,
      pageTitle: "原分P",
      subtitleBody: [{ from: 0, to: 1, content: "原视频字幕" }]
    });
    expect(request.context.bvid).not.toBe("BV1B");
    expect(request).not.toHaveProperty("videoFrameToolEnabled");
    expect(deps.canUseVideoFrameTool).not.toHaveBeenCalled();
    expect(deps.ensureCurrentContextForSend).toHaveBeenCalledTimes(ensureCalls);

    feed(runtime, { type: "token", data: "原上下文的新回答" });
    feed(runtime, { type: "done" });
    expect(state.chatSessionState.chatHistory[0].contextKey).toBe("video:BV1A|101");
  });

  it("原上下文不可用时明确提示，不隐藏原回答也不发起请求", async () => {
    const { deps } = await makeOriginalAnswer();
    pinOriginalContext();
    state.chatSessionStateForTests.currentConversationMeta!.resolvedContext = null;
    state.applyContextToMain({ bvid: VIDEO_A.bvid, cid: VIDEO_A.cid, title: VIDEO_A.title });
    state.applyLiveContextSnapshot({ ...VIDEO_B });
    const assistant = deps.messages.querySelector(".chat-msg-assistant");

    clickRegenerate(deps);
    await Promise.resolve();

    expect(deps.ports).toHaveLength(1);
    expect(deps.ui.showConversationContextNotice).toHaveBeenCalledWith("原消息的视频或分P上下文不可用，无法重新生成。", 4000);
    expect(deps.messages.querySelector(".chat-msg-assistant")).toBe(assistant);
    expect(assistant?.textContent).toContain("原回答");
  });

  it("停止请求抛错和端口断连后都复位发送窗口", async () => {
    const { deps, runtime } = await makeOriginalAnswer();
    clickRegenerate(deps);
    await waitForPort(deps, 2);
    deps.ports[1].port.postMessage.mockImplementation(() => {
      throw new Error("端口已关闭");
    });
    runtime.stopActiveStream();
    expect(runtime.isTurnActive()).toBe(false);
    expect(deps.messages.querySelector(".chat-msg-assistant")?.textContent).toContain("原回答");

    await expect(runtime.sendTurn("停止后的新问题")).resolves.toBe("accepted");
    deps.ports[2].emitDisconnect();
    expect(runtime.isTurnActive()).toBe(false);
    expect(deps.ui.setStreamingUiState).toHaveBeenLastCalledWith(false, { stopping: false });

    await expect(runtime.sendTurn("断连后的新问题")).resolves.toBe("accepted");
    feed(runtime, { type: "done" });
    expect(deps.ports).toHaveLength(4);
    expect(deps.ports[0].port.postMessage).toHaveBeenCalledTimes(1);
  });
});
