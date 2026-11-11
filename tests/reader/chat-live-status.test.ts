import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
import type { TestState } from "./reader-test-env.js";
import { createLiveTextToolRecordStore } from "../../extension/live/live-text-tool-records.js";

const liveHarness = vi.hoisted(() => ({
  deps: null as any,
  controller: null as any,
  records: null as any,
  state: "idle",
  reconnecting: false,
  emit: (_state: string, _error?: string, _failureKind?: string, _reconnecting?: boolean) => {}
}));

const shellHarness = vi.hoisted(() => ({
  ensure: vi.fn(),
  enter: vi.fn(async () => {})
}));

vi.mock("../../extension/live/live-chat-controller.js", () => ({
  createLiveChatController: (deps: any) => {
    liveHarness.deps = deps;
    liveHarness.state = "idle";
    liveHarness.reconnecting = false;
    const records = createLiveTextToolRecordStore();
    liveHarness.records = records;
    liveHarness.emit = (state, error, failureKind, reconnecting = false) => {
      liveHarness.state = state;
      liveHarness.reconnecting = reconnecting;
      deps.onStateChange?.(state, error, failureKind);
      if (reconnecting) {
        deps.onReconnecting?.({ attempt: 1, maxAttempts: 5, notice: "正在重连" });
      }
    };
    liveHarness.controller = {
      getState: () => liveHarness.state,
      isReconnecting: () => liveHarness.reconnecting,
      getTextToolRecords: records.getSnapshot,
      subscribeTextToolRecords: records.subscribe,
      retryTextToolRecord: vi.fn((callId: string) => {
        const record = records.getSnapshot().find((item) => item.callId === callId);
        if (record?.status !== "failed") return false;
        records.apply({
          type: "started",
          callId,
          source: record.source,
          objective: record.objective,
          startedAt: Date.now(),
          retry: true
        });
        return true;
      }),
      dismissTextToolRecord: vi.fn((callId: string) => records.apply({ type: "dismissed", callId })),
      isMuted: () => false,
      isSpeaking: () => false,
      isMicVadActive: () => false,
      isVoiceRecentlyActive: () => true,
      isSharingVideoAudio: () => false,
      isVoicePriority: () => true,
      isDucked: () => false,
      getSpeed: () => 1,
      getVolume: () => 1,
      start: vi.fn(async () => {
        liveHarness.emit("connecting");
        return true;
      }),
      stop: vi.fn(async () => {
        liveHarness.emit("idle");
      }),
      refreshTarget: vi.fn(async () => {}),
      dispose: vi.fn()
    };
    return liveHarness.controller;
  }
}));

vi.mock("../../extension/reader/lazy-shell.js", () => ({
  ensureReaderShell: shellHarness.ensure
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: vi.fn(() => 7100),
  fetchHotComments: vi.fn(async () => []),
  fetchHotCommentsWithLedger: vi.fn(async () => ({ comments: [] }))
}));

vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: vi.fn(),
  isBiliUrl: vi.fn(() => true)
}));

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
const ports: FakePort[] = [];

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
  state.clip.subtitles = [{ lan: "zh", subtitleUrl: "https://example.com/subtitle.json" }];
}

function statusElement(): HTMLElement {
  return document.getElementById(ids.readingChatLiveStatus) as HTMLElement;
}

function actionButton(action: string): HTMLButtonElement {
  return statusElement().querySelector<HTMLButtonElement>(`[data-live-status-action="${action}"]`) as HTMLButtonElement;
}

function visibleActions(): string[] {
  return [...statusElement().querySelectorAll<HTMLButtonElement>("[data-live-status-action]")]
    .filter((button) => !button.hidden)
    .map((button) => button.dataset.liveStatusAction || "");
}

async function activateChat() {
  const chat = await import("../../extension/reader/chat-tab.js");
  await chat.ensureChatTabActivated();
  return chat;
}

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  document.body.innerHTML = "";
  ports.length = 0;
  liveHarness.deps = null;
  liveHarness.controller = null;
  liveHarness.records = null;
  liveHarness.state = "idle";
  liveHarness.reconnecting = false;
  shellHarness.enter.mockClear();
  shellHarness.ensure = vi.fn(async () => ({
    enterReaderShell: shellHarness.enter,
    enterReaderShellOnUrlNavigation: vi.fn(async () => {}),
    exitReaderShell: vi.fn(async () => {})
  }));

  const chromeStub = window.chrome as unknown as {
    runtime: {
      sendMessage: ReturnType<typeof vi.fn>;
      connect: ReturnType<typeof vi.fn>;
    };
  };
  chromeStub.runtime.sendMessage = callbackStyleSendMessage({
    "ai-providers-list": () => ({
      ok: true,
      providers: [{ id: "p1", name: "平台一", model: "模型一", enabled: true }]
    }),
    "get-settings": () => ({ ok: true, settings: {} })
  }, { fallback: { ok: true } });
  chromeStub.runtime.connect = vi.fn(() => {
    const messageListeners: Array<(msg: unknown) => void> = [];
    const port: FakePort = {
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn) => messageListeners.push(fn) },
      onDisconnect: { addListener: () => {} }
    };
    ports.push(port);
    return port;
  });

  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  const uiRenderer = await import("../../extension/ui/ui-renderer.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
  seedReadyContext();
});

afterEach(async () => {
  const chat = await import("../../extension/reader/chat-tab.js");
  chat.closeChatSession();
  const session = await import("../../extension/live/live-companion-session.js");
  session.disposeLiveCompanionSession();
  await new Promise((resolve) => setTimeout(resolve, 0));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AI 对话实时伴看状态区", () => {
  it("未开启时隐藏，开启后状态有明确文案和动作，普通连接中不使用 assertive，并生成走查工件", async () => {
    expect(statusElement().hidden).toBe(true);
    await activateChat();
    const statusText = statusElement().querySelector<HTMLElement>(".chat-live-status-text") as HTMLElement;
    const steps: string[] = [];
    const record = (name: string) => {
      steps.push(`${name} | ${statusText.textContent} | ${visibleActions().join(",")}`);
    };

    expect(statusElement().hidden).toBe(true);
    expect(statusElement().parentElement).toBe(document.getElementById(ids.readingChatRoot));
    expect(document.getElementById(ids.readingChatMessages)?.contains(statusElement())).toBe(false);
    expect(statusText.getAttribute("role")).toBe("status");
    expect(statusText.getAttribute("aria-live")).not.toBe("assertive");
    expect(liveHarness.controller.start).not.toHaveBeenCalled();
    expect(statusText.textContent).toBe("");
    expect(visibleActions()).toEqual([]);
    record("未开启");

    liveHarness.emit("connecting");
    expect(statusElement().hidden).toBe(false);
    expect(statusText.textContent).toBe("正在连接伴看…");
    expect(visibleActions()).toEqual(["cancel"]);
    expect(statusText.getAttribute("aria-live")).not.toBe("assertive");
    record("连接中");

    liveHarness.emit("connected");
    expect(statusElement().hidden).toBe(false);
    expect(statusText.textContent).toBe("伴看已连接");
    expect(visibleActions()).toEqual(["restore", "stop"]);
    record("已连接");

    liveHarness.emit("connecting", "第 1 次重连", undefined, true);
    expect(statusElement().hidden).toBe(false);
    expect(statusElement().dataset.state).toBe("reconnecting");
    expect(statusText.textContent).toBe("伴看连接中断，正在重连…");
    expect(visibleActions()).toEqual(["cancel", "restore"]);
    record("重连中");

    liveHarness.emit("failure", "网络握手超时", "network");
    expect(statusElement().hidden).toBe(false);
    expect(statusText.textContent).toBe("伴看连接失败：网络握手超时");
    expect(visibleActions()).toEqual(["retry", "settings", "stop"]);
    record("失败");

    liveHarness.emit("idle");
    expect(statusElement().hidden).toBe(true);
    expect(statusText.textContent).toBe("");
    expect(visibleActions()).toEqual([]);
    record("已结束");

    for (const button of statusElement().querySelectorAll("button")) {
      expect(button.tagName).toBe("BUTTON");
      expect(button.type).toBe("button");
      expect((button.textContent || "").trim().length).toBeGreaterThan(0);
    }

    const artifactDir = join(process.cwd(), ".scratch", "tickets", "live-companion-closure", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(join(artifactDir, "04-chat-live-status.txt"), `${steps.join("\n")}\n`);
  });

  it("回放、空态清场和新会话上下文重建都保留同一个状态区节点", async () => {
    const chat = await activateChat();
    const status = statusElement();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const chatState = await import("../../extension/chat/chat-state.js");

    chatState.applyConversationIdentity({
      history: [
        { role: "user", content: "历史问题" },
        { role: "assistant", content: "历史回答" }
      ]
    });
    chat.renderInitialState();
    await vi.waitFor(() => expect(messages.textContent).toContain("历史回答"));
    expect(statusElement()).toBe(status);

    chatState.applyConversationIdentity({ history: [] });
    chat.renderInitialState();
    expect(messages.querySelector(".chat-suggestions")).not.toBeNull();
    expect(statusElement()).toBe(status);

    const marker = document.createElement("div");
    messages.appendChild(marker);
    (document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(messages.contains(marker)).toBe(false));
    expect(statusElement()).toBe(status);
    expect(liveHarness.controller.start).not.toHaveBeenCalled();
  });

  it("只有开启和失败重试进入启动链，取消与重试都先完整停止旧 Live", async () => {
    await activateChat();
    expect(liveHarness.controller.start).not.toHaveBeenCalled();

    actionButton("start").click();
    await vi.waitFor(() => expect(liveHarness.controller.start).toHaveBeenCalledTimes(1));
    expect(statusElement().dataset.state).toBe("connecting");

    actionButton("cancel").click();
    await vi.waitFor(() => expect(liveHarness.controller.stop).toHaveBeenCalledTimes(1));
    expect(statusElement().dataset.state).toBe("idle");

    liveHarness.emit("failure", "网络失败", "network");
    actionButton("retry").click();
    await vi.waitFor(() => expect(liveHarness.controller.start).toHaveBeenCalledTimes(2));
    expect(liveHarness.controller.stop).toHaveBeenCalledTimes(2);
    expect(liveHarness.controller.stop.mock.invocationCallOrder[1]).toBeLessThan(
      liveHarness.controller.start.mock.invocationCallOrder[1]
    );
  });

  it("失败设置直达伴看配置，Gemini 凭据失败直达 Gemini Key", async () => {
    await activateChat();

    liveHarness.emit("failure", "网络失败", "network");
    actionButton("settings").click();
    await vi.waitFor(() => expect(shellHarness.enter).toHaveBeenCalledTimes(1));
    expect(shellHarness.enter).toHaveBeenLastCalledWith({
      readerUrl: "",
      intent: "open",
      settingsTarget: "live"
    });

    liveHarness.emit("failure", "Gemini 凭据无效", "gemini-credential");
    actionButton("settings").click();
    await vi.waitFor(() => expect(shellHarness.enter).toHaveBeenCalledTimes(2));
    expect(shellHarness.enter).toHaveBeenLastCalledWith({
      readerUrl: "",
      intent: "open",
      settingsTarget: "gemini-key"
    });

    liveHarness.emit("failure", "未分类失败");
    actionButton("settings").click();
    await vi.waitFor(() => expect(shellHarness.enter).toHaveBeenCalledTimes(3));
    expect(shellHarness.enter).toHaveBeenLastCalledWith({
      readerUrl: "",
      intent: "open",
      settingsTarget: "live"
    });
    expect(liveHarness.controller.start).not.toHaveBeenCalled();
    expect(liveHarness.controller.stop).not.toHaveBeenCalled();
  });

  it("显示浮窗只 restore，结束只 stop Live；两者都不停止文本流或删除文本会话", async () => {
    const chat = await activateChat();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const chatState = await import("../../extension/chat/chat-state.js");
    input.value = "保留这轮文本对话";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(ports).toHaveLength(1));
    const history = [...chatState.chatSessionState.chatHistory];
    const messageHtml = messages.innerHTML;

    liveHarness.emit("connected");
    const overlay = chat.getFullscreenLiveOverlay();
    expect(overlay?.isVisible()).toBe(true);
    overlay?.hide();
    actionButton("restore").click();

    expect(overlay?.isVisible()).toBe(true);
    expect(overlay?.isMinimized()).toBe(false);
    expect(liveHarness.controller.start).not.toHaveBeenCalled();
    expect(liveHarness.controller.stop).not.toHaveBeenCalled();
    expect(ports[0].disconnect).not.toHaveBeenCalled();
    expect(messages.innerHTML).toBe(messageHtml);

    actionButton("stop").click();
    await vi.waitFor(() => expect(liveHarness.controller.stop).toHaveBeenCalledTimes(1));
    expect(statusElement().dataset.state).toBe("idle");
    expect(ports[0].disconnect).not.toHaveBeenCalled();
    expect(messages.innerHTML).toBe(messageHtml);
    expect(chatState.chatSessionState.chatHistory).toEqual(history);
  });

  it("面板关闭时隐藏状态区且不打开面板；重开只同步现有状态，不启动 Live", async () => {
    const chat = await activateChat();
    expect(shellHarness.ensure).not.toHaveBeenCalled();

    chat.closeChatSession();
    expect(statusElement().hidden).toBe(true);
    liveHarness.emit("connected");
    expect(statusElement().hidden).toBe(true);
    expect(shellHarness.ensure).not.toHaveBeenCalled();
    expect(liveHarness.controller.start).not.toHaveBeenCalled();

    await chat.ensureChatTabActivated();
    expect(statusElement().hidden).toBe(false);
    expect(statusElement().dataset.state).toBe("connected");
    expect(shellHarness.ensure).not.toHaveBeenCalled();
    expect(liveHarness.controller.start).not.toHaveBeenCalled();
  });

  it("两类来源在稳定状态区显示统一记录，完整 Markdown 可展开且不影响普通消息与发送闸", async () => {
    await activateChat();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const chatState = await import("../../extension/chat/chat-state.js");
    input.value = "普通问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(ports).toHaveLength(1));
    const history = [...chatState.chatSessionState.chatHistory];
    const messageHtml = messages.innerHTML;
    const postCount = ports[0].postMessage.mock.calls.length;
    const records = liveHarness.records;

    records.apply({ type: "started", callId: "gemini-1", source: "gemini", objective: "回答跨片段问题", startedAt: Date.now() - 1250 });
    records.apply({ type: "progress", callId: "gemini-1", summary: "生成中的摘要", markdown: "生成中的摘要" });
    records.apply({ type: "started", callId: "moss-1", source: "moss", objective: "生成全片总结", startedAt: Date.now() - 800 });
    records.apply({
      type: "completed",
      callId: "gemini-1",
      summary: "Gemini 结果摘要",
      markdown: "# 完整分析\n\n**关键结论**",
      endedAt: Date.now()
    });
    records.apply({
      type: "completed",
      callId: "moss-1",
      summary: "MOSS 结果摘要",
      markdown: "# 全片概览\n\n完整内容",
      endedAt: Date.now()
    });
    records.apply({
      type: "completed",
      callId: "moss-1",
      summary: "MOSS 结果摘要",
      markdown: "# 全片概览\n\n完整内容",
      endedAt: Date.now()
    });

    const root = statusElement().querySelector<HTMLElement>(".chat-live-tool-records") as HTMLElement;
    const items = root.querySelectorAll<HTMLElement>("[data-live-tool-record]");
    expect(items).toHaveLength(2);
    expect(root.textContent).toContain("Gemini · 视频分析");
    expect(root.textContent).toContain("MOSS · 视频分析");
    expect(root.textContent).toContain("回答跨片段问题");
    expect(root.textContent).toContain("生成全片总结");
    expect(root.textContent).toContain("Gemini 结果摘要");
    expect(root.querySelector(".chat-live-tool-record-duration")?.textContent).toContain("秒");
    expect(messages.contains(root)).toBe(false);
    expect(root.getAttribute("aria-live")).toBeNull();

    const details = items[0].querySelector<HTMLDetailsElement>("details") as HTMLDetailsElement;
    expect(details.firstElementChild?.tagName).toBe("SUMMARY");
    expect(details.querySelector("summary button")).toBeNull();
    details.open = true;
    expect(details.querySelector(".markdown-body strong")?.textContent).toBe("关键结论");
    expect(messages.innerHTML).toBe(messageHtml);
    expect(chatState.chatSessionState.chatHistory).toEqual(history);
    expect(ports).toHaveLength(1);
    expect(ports[0].postMessage.mock.calls).toHaveLength(postCount);
  });

  it("失败记录提供重试和继续伴看，关闭面板不保留记录 DOM 且事件不自动打开", async () => {
    const chat = await activateChat();
    const records = liveHarness.records;
    records.apply({ type: "started", callId: "failed-1", source: "moss", objective: "生成全片总结", startedAt: 10 });
    records.apply({ type: "failed", callId: "failed-1", error: "文本模型限流", endedAt: 20 });
    const root = statusElement().querySelector<HTMLElement>(".chat-live-tool-records") as HTMLElement;
    expect(root.textContent).toContain("文本模型限流");

    root.querySelector<HTMLButtonElement>("[data-live-record-action='retry']")?.click();
    expect(liveHarness.controller.retryTextToolRecord).toHaveBeenCalledWith("failed-1");
    expect(root.querySelectorAll("[data-live-tool-record]")).toHaveLength(1);
    expect(root.textContent).toContain("正在生成");
    records.apply({ type: "failed", callId: "failed-1", error: "再次失败", endedAt: 30 });
    root.querySelector<HTMLButtonElement>("[data-live-record-action='continue']")?.click();
    expect(root.querySelectorAll("[data-live-tool-record]")).toHaveLength(0);
    expect(liveHarness.controller.stop).not.toHaveBeenCalled();

    records.apply({ type: "started", callId: "closed-1", source: "gemini", objective: "保留当前会话记录", startedAt: 40 });
    records.apply({ type: "completed", callId: "closed-1", summary: "完成", markdown: "完整结果", endedAt: 50 });
    expect(root.querySelectorAll("[data-live-tool-record]")).toHaveLength(1);
    chat.closeChatSession();
    expect(statusElement().hidden).toBe(true);
    expect(root.childElementCount).toBe(0);
    records.apply({ type: "progress", callId: "closed-1", summary: "关闭期间更新", markdown: "关闭期间更新" });
    expect(root.childElementCount).toBe(0);
    expect(shellHarness.ensure).not.toHaveBeenCalled();

    await chat.ensureChatTabActivated();
    expect(root.querySelectorAll("[data-live-tool-record]")).toHaveLength(1);
    expect(root.textContent).toContain("完整结果");
    expect(shellHarness.ensure).not.toHaveBeenCalled();
    expect(liveHarness.controller.start).not.toHaveBeenCalled();
  });
});
