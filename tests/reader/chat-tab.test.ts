import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "../helpers/memory-storage-area.js";
import { SELECTED_PROVIDER_KEY } from "../../extension/shared/selected-provider.js";
import type { TestState } from "./reader-test-env.js";

const { gatewayMock, gatewayCoreMock } = vi.hoisted(() => ({
  gatewayMock: {
    getCurrentAid: vi.fn(() => 0),
    fetchHotComments: vi.fn(async (_count?: number) => [])
  },
  gatewayCoreMock: {
    bgFetchJson: vi.fn(),
    isBiliUrl: vi.fn(() => true)
  }
}));

vi.mock("../../extension/bilibili/gateway.js", () => ({
  getCurrentAid: gatewayMock.getCurrentAid,
  fetchHotComments: gatewayMock.fetchHotComments,
  fetchHotCommentsWithLedger: async () => {
    if (!gatewayMock.getCurrentAid()) {
      return { comments: [], note: "无法获取视频 aid" };
    }
    try {
      return { comments: await gatewayMock.fetchHotComments(20) };
    } catch (error) {
      return { comments: [], note: String((error as Error)?.message || error) };
    }
  }
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));
vi.mock("../../extension/chat/image-compress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../extension/chat/image-compress.js")>();
  return {
    ...actual,
    createImageCompressor: () => ({
      compress: async () => ({ part: { mime: "image/webp", data: "aA==" }, bytes: 1 })
    })
  };
});

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let chatState: typeof import("../../extension/chat/chat-state.js");
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");

interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}
const ports: FakePort[] = [];

type StorageListener = (changes: Record<string, unknown>, areaName: string) => void;
let providerList: Array<Record<string, unknown>> = [];
const storageListeners = new Set<StorageListener>();
function fireStorageChange(changes: Record<string, unknown>, areaName: string): void {
  [...storageListeners].forEach((listener) => listener(changes, areaName));
}

type Sendstub = ReturnType<typeof vi.fn>;
function stubChromeByType(): void {
  const chromeStub = window.chrome as unknown as {
    runtime: { sendMessage: Sendstub; connect: Sendstub };
    storage: {
      local: ChromeHostStorageArea;
      sync: { set: Sendstub };
      onChanged: { addListener: Sendstub; removeListener: Sendstub };
    };
  };
  chromeStub.runtime.sendMessage = callbackStyleSendMessage({
    "ai-providers-list": () => ({ ok: true, providers: providerList }),
    "get-settings": () => ({ ok: true, settings: {} })
  });
  chromeStub.runtime.connect = vi.fn(() => {
    const messageListeners: Array<(msg: unknown) => void> = [];
    const port: FakePort = {
      name: "offscreen-chat",
      postMessage: vi.fn(),
      disconnect: vi.fn(),
      onMessage: { addListener: (fn: (msg: unknown) => void) => messageListeners.push(fn) },
      onDisconnect: { addListener: (_fn: () => void) => {} }
    };
    (port as FakePort & { __fire?: (msg: unknown) => void }).__fire = (msg: unknown) =>
      messageListeners.forEach((fn) => fn(msg));
    ports.push(port);
    return port;
  });
  chromeStub.storage.local = createMemoryStorageArea();
  chromeStub.storage.sync.set = vi.fn(async () => {});
  chromeStub.storage.onChanged.addListener = vi.fn((listener: StorageListener) => {
    storageListeners.add(listener);
  });
  chromeStub.storage.onChanged.removeListener = vi.fn((listener: StorageListener) => {
    storageListeners.delete(listener);
  });
}

async function waitFor(predicate: () => boolean, { timeoutMs = 1000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loadShell() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  explainIntent = await import("../../extension/reader/explain-intent.js");
  chatState = await import("../../extension/chat/chat-state.js");
  chatSessionState = chatState.chatSessionState;
  applyConversationIdentity = chatState.applyConversationIdentity;
  setSavedConversations = chatState.setSavedConversations;
  statusBus = await import("../../extension/shared/subtitle-status-bus.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  ports.length = 0;
  storageListeners.clear();
  providerList = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
  await loadShell();
  stubChromeByType();
  statusBus.publishSubtitleStatusPhase("idle");
});

describe("组合根装配与懒加载边界", () => {
  it("开壳不装载对话组合根；首切对话 tab 才装载并完成 init", async () => {
    expect(lazyChat.isReaderChatTabLoaded()).toBe(false);
    seedReadyContext();

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    expect(lazyChat.isReaderChatTabLoaded()).toBe(true);
    expect(document.getElementById("biliscript-reading-chat-model-select")).toBe(null);
    expect(chatSessionState.selectedModelValue).toBe("p1\u0001模型一");
    expect(
      document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-model`)?.textContent
    ).toBe("平台一·模型一");
    expect(chatSessionState.contextData?.title).toContain("测试视频");
    const tools = document.querySelector(".biliscript-reading-tabs-tools")!;
    expect(Array.from(tools.children).map((node) => (node as HTMLElement).id)).toEqual([
      ids.readingOverviewExportBtn,
      ids.readingChatMoreBtn,
      ids.readingChatMoreMenu
    ]);
    expect(document.querySelectorAll(".biliscript-reading-tab")).toHaveLength(3);
    expect(document.getElementById(ids.readingChatMoreBtn)?.getAttribute("aria-label")).toBe("更多操作");
    const moreMenu = document.getElementById(ids.readingChatMoreMenu)!;
    expect(moreMenu.querySelector(`#${ids.readingChatNewBtn}`)?.textContent).toContain("开启新会话");
    expect(moreMenu.querySelector(`#${ids.readingChatHistoryBtn}`)?.textContent).toContain("历史对话");
    expect(moreMenu.querySelector(".biliscript-reading-chat-more-actions")).not.toBeNull();
    expect(document.getElementById(ids.readingChatDisplaySettingsBtn)?.textContent).toBe("更多显示设置");
    expect(document.getElementById(ids.readingChatLineHeight)).not.toBe(null);
    expect(document.getElementById(ids.readingChatParagraphSpacing)).not.toBe(null);
    expect(document.getElementById(ids.readingChatSpeechVolumeInput)).not.toBe(null);
    expect(document.getElementById(ids.readingChatSpeechVolumeResetBtn)).not.toBe(null);
    const volumeLabel = document.querySelector(`label[for="${ids.readingChatSpeechVolumeInput}"]`);
    expect(volumeLabel?.textContent).toBe("对话朗读音量");
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(messages.querySelectorAll(".chat-center-error")).toHaveLength(0);
    expect(messages.querySelector(".chat-suggestions")).not.toBe(null);
  });

  it("首开初始化四路并行：平台列表被卡住时会话存档与 offscreen 确保已发起（opt-backlog-2026-09/05）", async () => {
    seedReadyContext();
    const chromeStub = window.chrome as unknown as { runtime: { sendMessage: Sendstub } };
    let releaseProviders: (value: unknown) => void = () => {};
    const providersGate = new Promise((resolve) => {
      releaseProviders = resolve;
    });
    chromeStub.runtime.sendMessage.mockImplementation((message: { type?: string }, callback?: (resp: unknown) => void) => {
      const type = String(message?.type || "");
      if (type === "ai-providers-list") {
        void providersGate.then(() =>
          callback?.({ ok: true, providers: [{ id: "p1", name: "平台一", model: "模型一", enabled: true }] })
        );
      } else if (type === "get-settings") {
        callback?.({ ok: true, settings: {} });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    });

    const chat = await lazyChat.ensureReaderChatTab();
    const activation = chat.ensureChatTabActivated();

    await waitFor(() =>
      chromeStub.runtime.sendMessage.mock.calls.some((call) => (call[0] as { type?: string })?.type === "ensure-offscreen-chat")
    );
    const storageGet = (window.chrome as unknown as { storage: { local: { get: Sendstub } } }).storage.local.get;
    await waitFor(() => storageGet.mock.calls.length > 0);

    releaseProviders(null);
    await activation;
    expect(lazyChat.isReaderChatTabLoaded()).toBe(true);
  });

  it("首开异步等待平台列表途中关闭会话：迟到响应不污染已关闭面板，重开仍可干净初始化", async () => {
    seedReadyContext();
    const chromeStub = window.chrome as unknown as { runtime: { sendMessage: Sendstub } };
    let releaseProviders: (value: unknown) => void = () => {};
    const providersGate = new Promise((resolve) => {
      releaseProviders = resolve;
    });
    chromeStub.runtime.sendMessage.mockImplementation((message: { type?: string }, callback?: (resp: unknown) => void) => {
      const type = String(message?.type || "");
      if (type === "ai-providers-list") {
        void providersGate.then(() =>
          callback?.({ ok: true, providers: [{ id: "p1", name: "平台一", model: "模型一", enabled: true }] })
        );
      } else if (type === "get-settings") {
        callback?.({ ok: true, settings: {} });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    });

    const chat = await lazyChat.ensureReaderChatTab();
    const activation = chat.ensureChatTabActivated();
    await waitFor(() =>
      chromeStub.runtime.sendMessage.mock.calls.some((call) => (call[0] as { type?: string })?.type === "ai-providers-list")
    );

    const outside = document.createElement("button");
    document.body.appendChild(outside);
    outside.focus();

    chat.closeChatSession();
    releaseProviders(null);
    await activation;

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(messages.querySelector(".chat-hero")).toBeNull();
    expect(messages.querySelectorAll(".chat-chip")).toHaveLength(0);
    expect(document.activeElement).not.toBe(input);
    expect(document.activeElement).toBe(outside);

    await chat.ensureChatTabActivated();
    expect(messages.querySelector(".chat-hero")).not.toBeNull();
  });

  it("重复激活幂等：不重跑 init（storage 读取次数不变）", async () => {
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const chromeStub = window.chrome as unknown as { storage: { local: { get: Sendstub } } };
    const getCalls = chromeStub.storage.local.get.mock.calls.length;

    await chat.ensureChatTabActivated();

    expect(chromeStub.storage.local.get.mock.calls.length).toBe(getCalls);
  });

  it("closeReadingView 在对话 tab 未装载时不触发懒加载（清理 no-op）", async () => {
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    const reader = await import("../../extension/reader/index.js");
    reader.closeReadingView();
    expect(lazyChat.isReaderChatTabLoaded()).toBe(false);
  });
});

describe("模型选择变化只落本地对话键，不覆写 defaultModel", () => {
  async function activateWithModelPanel() {
    providerList = [{ id: "p1", name: "平台一", models: ["模型一", "模型二"], enabled: true }];
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const chromeStub = window.chrome as unknown as {
      runtime: { sendMessage: Sendstub };
      storage: {
        sync: { set: Sendstub };
        local: { set: Sendstub };
      };
    };
    chromeStub.runtime.sendMessage.mockClear();
    chromeStub.storage.sync.set.mockClear();
    chromeStub.storage.local.set.mockClear();
    return { chromeStub };
  }

  function directDefaultModelWrites(syncSet: Sendstub): unknown[][] {
    return syncSet.mock.calls.filter(([payload]) =>
      Object.prototype.hasOwnProperty.call((payload as Record<string, unknown>) ?? {}, "defaultModel")
    );
  }

  it("选中平台模型：仅写 local[SELECTED_PROVIDER_KEY]，不发 save-settings{defaultModel} 也不写 sync", async () => {
    const { chromeStub } = await activateWithModelPanel();

    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const option = document.querySelector<HTMLButtonElement>(
      `#${ids.readingChatModelList} .chat-model-option[data-value="p1\u0001模型二"]`
    )!;
    expect(option).not.toBe(null);
    option.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chromeStub.storage.local.set).toHaveBeenCalledWith({ [SELECTED_PROVIDER_KEY]: "p1\u0001模型二" });
    expect(directDefaultModelWrites(chromeStub.storage.sync.set)).toEqual([]);
    expect(
      chromeStub.runtime.sendMessage.mock.calls.some(
        ([message]) => (message as { type?: string })?.type === "save-settings"
      )
    ).toBe(false);
  });
});

describe("explain 意图消费（自动发送 + consume 一次）", () => {
  it("激活时渲染引用卡并自动发送解释提示词，发送成功即 consume", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({ from: 10, content: "第二句话待解释", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { action?: string; prompt?: string };
    expect(posted.action).toBe("chat");
    expect(posted.prompt).toContain("第二句话待解释");
    expect(posted.prompt).toContain("0:10");
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(input.value).toBe("");

    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);

    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(1);
  });

  it("引用卡取消按钮：清意图 + 隐卡（不自动发送）", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "empty";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 5, content: "待取消句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => Boolean(document.querySelector(".chat-input-card .chat-context-notice")));
    expect(ports).toHaveLength(0);
    const intentCard = document.getElementById(ids.readingChatIntent) as HTMLElement;
    expect(intentCard.hidden).toBe(false);

    const cancelBtn = intentCard.querySelector("[data-chat-intent-action='cancel']") as HTMLButtonElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(intentCard.hidden).toBe(true);
    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(0);
  });

  it("受理窗口内激活：意图不被消费，回合落定后激活才真正发出", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;

    input.value = "闸中问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(ports).toHaveLength(0);

    explainIntent.setPendingExplainIntent({ from: 10, content: "待解释句", createdAt: Date.now() });
    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(0);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(false);

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("闸中问题");

    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    await chat.ensureChatTabActivated();
    await waitFor(() => ports.length === 2 && ports[1].postMessage.mock.calls.length === 1);
    expect((ports[1].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toContain("待解释句");
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(2);
  });
});

describe("subtitle-wait kick 总线接线", () => {
  it("转写中发送被挂起；asr-done 相位驱动 kick 放行并发完整字幕", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 30, content: "转写中句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    const activation = chat.ensureChatTabActivated();

    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    const asrNotice = document.getElementById(ids.readingChatAsrNotice) as HTMLElement;
    expect(asrNotice.hidden).toBe(false);
    expect(chatSessionState.asrTranscribingActive).toBe(true);

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(asrNotice.textContent?.includes("完成后自动开始总结")));
    expect(ports).toHaveLength(0);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(false);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; context?: { subtitleBody?: unknown[] } };
    expect(posted.prompt).toContain("转写中句");
    expect(posted.context?.subtitleBody).toHaveLength(1);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(asrNotice.hidden).toBe(true);
    await activation;
    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(1);
  });

  it("抓取等待中转入转写相位：等待卡保留并显示转写状态行", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 10, content: "抓取中转写句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    const activation = chat.ensureChatTabActivated();

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const asrNotice = document.getElementById(ids.readingChatAsrNotice) as HTMLElement;
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(document.querySelector(".chat-subtitle-wait")?.textContent).toContain("正在等待字幕");
    expect(asrNotice.hidden).toBe(true);

    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(asrNotice.hidden).toBe(false);

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await waitFor(() => ports.length === 1);
    await activation;
  });

  it("抓取等待期间：等待卡、重复发送反馈与新草稿保留；放行后发送状态成对复位", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const sendBtn = document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement;
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const waitCard = document.querySelector<HTMLElement>(".chat-subtitle-wait")!;
    const defaultPlaceholder = input.placeholder;

    input.value = "闸中问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await waitFor(() => waitCard.hidden === false);
    expect(sendBtn.disabled).toBe(true);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);
    expect(input.disabled).toBe(false);
    expect(input.placeholder).toBe(defaultPlaceholder);

    input.value = "等待中补的内容";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn.disabled).toBe(true);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => Boolean(messages.textContent?.includes("正在等待字幕，完成后自动发送")));
    expect(ports).toHaveLength(0);
    expect(waitCard.hidden).toBe(false);

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("闸中问题");
    await waitFor(() => waitCard.hidden === true);
    expect(input.value).toBe("等待中补的内容");
    expect(messages.textContent).toContain("已发送原文，保留了后来修改的草稿与图片");

    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    await waitFor(() => !sendBtn.classList.contains("is-stop"));
    input.value = "下一问";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(sendBtn.disabled).toBe(false);
    expect(input.placeholder).toBe(defaultPlaceholder);
  });

  it("等待卡可取消：原回合不发送且保留草稿，字幕就绪后可重新发送", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const waitCard = document.querySelector<HTMLElement>(".chat-subtitle-wait")!;
    const cancel = waitCard.querySelector<HTMLButtonElement>(".chat-subtitle-wait-cancel")!;

    input.value = "取消前的问题";
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => waitCard.hidden === false);

    cancel.click();
    await waitFor(() => waitCard.hidden === true);
    expect(ports).toHaveLength(0);
    expect(input.value).toBe("取消前的问题");
    expect(messages.textContent).toContain("已取消等待，草稿与图片已保留");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(input.value.length);
    expect(input.selectionEnd).toBe(input.value.length);
    await new Promise((resolve) => setTimeout(resolve, 0));

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("取消前的问题");
    expect(input.value).toBe("");
  });

  it("有字幕视频抓取中等待：输入区显示等待卡，不误报音频转写", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 20, content: "抓取中句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    vi.useFakeTimers();
    try {
      const activation = chat.ensureChatTabActivated();

      const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
      await vi.advanceTimersByTimeAsync(50);
      expect(document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden).toBe(false);
      expect(document.querySelector(".chat-subtitle-wait")?.textContent).toContain("正在等待字幕");
      expect((document.getElementById(ids.readingChatAsrNotice) as HTMLElement).hidden).toBe(true);

      state.clip.subtitleFetchState = "ready";
      state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
      await vi.advanceTimersByTimeAsync(4000);
      expect(ports).toHaveLength(1);
      expect(messages.querySelector(".chat-context-notice")).toBeNull();
      await activation;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("发送前主动起跑字幕抓取（抓取未起跑的 idle 窗口不再发空上下文）", () => {
  it("字幕体为空且抓取尚未起跑：主动触发一轮抓取，抓取落定前不发提示词", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    let resolveFetch: () => void = () => {};
    const refreshSpy = vi.fn(() => {
      state.clip.subtitleFetchState = "loading";
      return new Promise<void>((resolve) => {
        resolveFetch = resolve;
      });
    });
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "idle";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    const sent = chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    await waitFor(() => refreshSpy.mock.calls.length === 1);
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(document.querySelector(".chat-subtitle-wait")?.textContent).toContain("正在等待字幕");
    expect(ports).toHaveLength(0);

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    resolveFetch();
    statusBus.publishSubtitleStatusPhase("asr-done");

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as {
      prompt?: string;
      context?: { subtitleBody?: unknown[] };
    };
    expect(posted.prompt).toContain("整理这期视频");
    expect(posted.context?.subtitleBody).toHaveLength(1);
    expect(await sent).toBe(true);
  });

  it("非视频页：不起跑抓取（对话仍可用，不落一条抓取失败状态行）", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    setLocationUrl("https://www.bilibili.com/");
    state.clip.title = "";
    state.clip.bvid = "";
    state.clip.cid = "";
    state.clip.subtitleFetchState = "idle";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(ports).toHaveLength(1);
  });

  it("快照落后于 state（另一轮抓取刚落账）：不重复起跑抓取，按最新 state 发送", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(() => Promise.resolve());
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "idle";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    if (chatSessionState.liveContextData) {
      chatState.chatSessionStateForTests.liveContextData!.signature = "stale-signature";
    }
    gatewayMock.getCurrentAid.mockReturnValueOnce(7100);
    gatewayMock.fetchHotComments.mockImplementationOnce(async () => {
      state.clip.subtitleFetchState = "ready";
      state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
      return [];
    });

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "总结一下";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { context?: { subtitleBody?: unknown[] } };
    expect(refreshSpy).not.toHaveBeenCalled();
    expect(posted.context?.subtitleBody).toHaveLength(1);
  });

  it("字幕刷新异步失败时保持 awaitRefresh: false 非阻塞语义，并通过 logWarn 输出失败详情", async () => {
    const { registerDebugGate } = await import("../../extension/shared/logging.js");
    registerDebugGate(() => true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshError = new Error("subtitle refresh failed boom");
    const refreshSpy = vi.fn(async () => {
      throw refreshError;
    });
    readerBus.subscribeSubtitleRefresh(refreshSpy);

    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "idle";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    const sent = chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    await waitFor(() => warnSpy.mock.calls.some((call) => call[0] === "[BILISCRIPT] subtitle refresh failed"));
    expect(warnSpy).toHaveBeenCalledWith("[BILISCRIPT] subtitle refresh failed", { error: refreshError });

    statusBus.publishSubtitleStatusPhase("error");
    await expect(sent).resolves.toBe(true);
  });
});

describe("断流收口（工单 08：关闭即断流，重开从会话历史恢复）", () => {
  it("流式中关闭：断 port + 退出流式 UI 态；关闭后发送不再放行", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "总结一下";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);

    const sendBtn = document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement;
    expect(sendBtn.classList.contains("is-stop")).toBe(true);
    expect(input.disabled).toBe(false);

    chat.closeChatSession();

    expect(ports[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);

    input.value = "关闭后再发";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(ports).toHaveLength(1);
  });

  it("发送闸等待时关闭并重开：迟到就绪不得复活旧快捷意图", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.aid = "7100";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const sending = chat.runQuickActionPrompt("等待字幕时发送");
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);

    chat.closeChatSession();
    await chat.ensureChatTabActivated();
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "迟到的字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await expect(sending).resolves.toBe(false);
    expect(ports).toHaveLength(0);
  });

  it.each([
    {
      label: "换视频",
      url: "https://www.bilibili.com/video/BV1next000000/",
      bvid: "BV1next000000",
      cid: "201"
    },
    {
      label: "换分P",
      url: "https://www.bilibili.com/video/BV1test000000/?p=2",
      bvid: "BV1test000000",
      cid: "102"
    }
  ])("$label 使在飞等待的旧快捷意图失效", async ({ url, bvid, cid }) => {
    state.clip.title = "旧视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.aid = "7100";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const sending = chat.runQuickActionPrompt("只在旧视频等待时发送");
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);

    state.clip.bvid = bvid;
    state.clip.cid = cid;
    state.clip.title = "新内容";
    const { contentEventBus } = await import("../../extension/shared/content-event-bus.js");
    setLocationUrl(url);
    contentEventBus.emit("host:url-change", { url });
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "新内容字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await expect(sending).resolves.toBe(false);
    expect(ports).toHaveLength(0);
    chat.closeChatSession();
  });

  it("重开（重新激活）：从会话历史恢复视图并重挂触发源", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    chat.closeChatSession();

    await chat.ensureChatTabActivated();

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(messages.querySelector(".chat-center-error")).toBeNull();
    expect(messages.querySelector(".chat-suggestions")).not.toBe(null);
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect((document.getElementById(ids.readingChatAsrNotice) as HTMLElement).hidden).toBe(false);
    statusBus.publishSubtitleStatusPhase("idle");
  });

  it("关闭期间新增平台：重开激活刷新平台列表（模型选择器纳入新平台）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    expect(chatSessionState.selectedModelValue).toBe("p1\u0001模型一");

    chat.closeChatSession();

    const next = [
      { id: "p1", name: "平台一", model: "模型一", enabled: true },
      { id: "p2", name: "平台二", models: ["模型二"], enabled: true }
    ];
    providerList = next;
    fireStorageChange({ aiProviders: { newValue: next, oldValue: [next[0]] } }, "sync");

    await chat.ensureChatTabActivated();

    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const optionValues = Array.from(
      document.querySelectorAll<HTMLButtonElement>(`#${ids.readingChatModelList} .chat-model-option`)
    ).map((option) => option.getAttribute("data-value"));
    expect(optionValues).toContain("p2\u0001模型二");
  });

  it("关闭前有置顶会话、关闭后切换视频再重开：未命中历史会话时同步新视频字幕", async () => {
    state.clip.title = "视频A";
    state.clip.bvid = "BV1videoA0001";
    state.clip.cid = "101";
    state.clip.aid = "7100";
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "视频A字幕" }];
    setLocationUrl("https://www.bilibili.com/video/BV1videoA0001/?biliscript_reader=1");

    const chat = await lazyChat.ensureReaderChatTab();
    await expect(chat.runQuickActionPrompt("总结视频A")).resolves.toBe(true);
    await waitFor(() => ports.length === 1);
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "token", data: "视频A回复" });
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    await waitFor(() => chatSessionState.currentConversationMeta?.pinnedContext === true);

    chat.closeChatSession();

    state.clip.title = "视频B";
    state.clip.bvid = "BV1videoB0002";
    state.clip.cid = "202";
    state.clip.aid = "7200";
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "视频B新字幕" }];
    setLocationUrl("https://www.bilibili.com/list/watchlater?oid=222&bvid=BV1videoB0002");

    await expect(chat.runQuickActionPrompt("总结视频B")).resolves.toBe(true);
    await waitFor(() => ports.length === 2 && ports[1].postMessage.mock.calls.length === 1);
    const posted = ports[1].postMessage.mock.calls[0][0] as {
      context?: { bvid?: string; title?: string; subtitleBody?: Array<{ content?: string }> };
    };
    expect(posted.context?.bvid).toBe("BV1videoB0002");
    expect(posted.context?.title).toBe("视频B");
    expect(posted.context?.subtitleBody?.map((item) => item.content)).toEqual(["视频B新字幕"]);
  });

  it("联网偏好外部变更（拒绝授权后关闭）→ 对话开关与内存态同步", async () => {
    seedReadyContext();
    const chromeStub = window.chrome as unknown as { runtime: { sendMessage: Sendstub } };
    let webSearchEnabled = true;
    chromeStub.runtime.sendMessage.mockImplementation(
      (message: { type?: string }, callback?: (resp: unknown) => void) => {
        const type = String(message?.type || "");
        if (type === "ai-providers-list") {
          callback?.({ ok: true, providers: providerList });
        } else if (type === "get-settings") {
          callback?.({ ok: true, settings: { webSearchEnabled } });
        } else {
          callback?.({ ok: true });
        }
        return undefined;
      }
    );

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const pill = document.getElementById(ids.readingChatWebSearchPill) as HTMLElement;
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    expect(chatSessionState.webSearchEnabled).toBe(true);

    webSearchEnabled = false;
    fireStorageChange({ webSearchEnabled: { newValue: false, oldValue: true } }, "sync");

    await waitFor(() => pill.getAttribute("aria-pressed") === "false");
    expect(chatSessionState.webSearchEnabled).toBe(false);
  });
});

describe("联网搜索回放重建（spec §4：tool 消息 → 时间线卡 + 内联引用）", () => {
  it("tool 轮消息渲染成时间线卡与 [n] 引用，JSON 不落正文", async () => {
    seedReadyContext();
    const chromeStub = window.chrome as unknown as {
      storage: { local: ChromeHostStorageArea };
    };
    await chromeStub.storage.local.set({
      biliscript_ai_conversations_v1: [
        {
          id: "conv-web-search-replay",
          title: "测试视频",
          contextKey: "video:BV1test000000|101",
          contextTitle: "测试视频",
          contextUrl: "https://www.bilibili.com/video/BV1test000000/",
          isVideoContext: true,
          createdAt: 1000,
          updatedAt: 2000,
          contextRef: {
            bvid: "BV1test000000",
            cid: "101",
            url: "https://www.bilibili.com/video/BV1test000000/"
          },
          messages: [
            { role: "user", content: "视频里提到的 MoE 后来有什么进展？" },
            {
              role: "assistant",
              content: "",
              tool_calls: [{ id: "c1", function: { name: "web_search", arguments: '{"query":"MoE 新进展"}' } }]
            },
            {
              role: "tool",
              tool_call_id: "c1",
              content: JSON.stringify([{ title: "来源A", url: "https://a.example.com/x", snippet: "摘录A" }])
            },
            { role: "assistant", content: "回答见 [1]。" }
          ]
        }
      ]
    });
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(messages.querySelector(".chat-thought-chain")));
    const card = messages.querySelector(".chat-thought-chain") as HTMLElement;
    expect((card.querySelector(".chat-thought-step-detail") as HTMLElement).textContent).toBe("MoE 新进展");
    expect((card.querySelector(".chat-thought-step-meta") as HTMLElement).textContent).toBe("1 条");
    expect(card.querySelectorAll(".chat-search-source-row")).toHaveLength(1);
    expect(card.classList.contains("chat-thought-chain-collapsed")).toBe(true);
    expect(card.querySelector(".chat-thought-chain-head")!.getAttribute("aria-expanded")).toBe("false");
    expect((card.querySelector(".chat-thought-chain-summary") as HTMLElement).textContent).toBe("联网检索 1 条");
    (card.querySelector(".chat-thought-chain-head") as HTMLElement).click();
    expect(card.classList.contains("chat-thought-chain-collapsed")).toBe(false);
    expect(messages.textContent).not.toContain('{"title"');
    expect(messages.querySelectorAll("sup.chat-cite")).toHaveLength(1);
  });
});

describe("外点关闭单委托（reader-bus 转发槽并入 ui-renderer 文档级委托）", () => {
  it("点外关闭、点内不关；退出后焦点回 ⋮ 触发键，重复激活不双挂监听", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await chat.ensureChatTabActivated();

    const historyBtn = document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement;
    const historyPopover = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPopover.hidden).toBe(false);

    const historyList = document.getElementById(ids.readingChatHistoryList) as HTMLElement;
    historyList.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPopover.hidden).toBe(false);

    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPopover.hidden).toBe(true);
    expect(document.activeElement).toBe(document.getElementById(ids.readingChatMoreBtn));
  });
});

describe("历史内容模式", () => {
  it("打开聚焦返回键；返回与 Esc 都恢复 hidden 并聚焦 ⋮ 触发键", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const historyBtn = document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement;
    const historyPage = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    const backBtn = document.getElementById(ids.readingChatHistoryBackBtn) as HTMLButtonElement;
    const moreBtn = document.getElementById(ids.readingChatMoreBtn) as HTMLButtonElement;

    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(false);
    expect(historyBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(backBtn);

    backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(true);
    expect(document.activeElement).toBe(moreBtn);

    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(true);
    expect(historyBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(moreBtn);
  });

  it("设置深链先退出历史，再发既有 open-settings/appearance 壳命令", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const historyPage = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    const commands: Array<{ name: string; payload: unknown; historyHidden: boolean }> = [];
    readerBus.subscribeUiCommand((name, payload) => {
      commands.push({ name, payload, historyHidden: historyPage.hidden === true });
    });

    document.getElementById(ids.readingChatHistoryBtn)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document.getElementById(ids.readingChatDisplaySettingsBtn)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(historyPage.hidden).toBe(true);
    expect((document.getElementById(ids.readingChatMoreMenu) as HTMLElement).hidden).toBe(true);
    expect(commands).toEqual([{ name: "open-settings", payload: { target: "appearance" }, historyHidden: true }]);
  });

  it("外部偏好变更即时同步 Aa 三项滑块并预览对话排版", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    fireStorageChange({
      chatLineHeight: { oldValue: 160, newValue: 185 },
      chatParagraphSpacing: { oldValue: 12, newValue: 18 },
      speechVoiceVolume: { oldValue: 100, newValue: 45 }
    }, "sync");

    expect(document.getElementById(ids.readingChatLineHeight)).toHaveProperty("value", "185");
    expect(document.getElementById(ids.readingChatParagraphSpacing)).toHaveProperty("value", "18");
    expect(document.getElementById(ids.readingChatSpeechVolumeInput)).toHaveProperty("value", "45");
    expect(state.settings).toMatchObject({
      chatLineHeight: 185,
      chatParagraphSpacing: 18,
      speechVoiceVolume: 45
    });
    const view = document.getElementById("biliscript-reading-view")!;
    expect(view.style.getPropertyValue("--biliscript-chat-line-height")).toBe("1.85");
    expect(view.style.getPropertyValue("--biliscript-chat-paragraph-spacing")).toBe("18px");
  });
});

describe("新建会话风险确认", () => {
  function clickOnce(element: Element): void {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function pasteImage(input: HTMLTextAreaElement): void {
    const file = new File(["image"], "draft.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] }
    });
    input.dispatchEvent(event);
  }

  async function activateEmptyChat() {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    return chat;
  }

  it("草稿与图片合并为一次确认；取消零副作用，确认后才清理", async () => {
    await activateEmptyChat();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const imageStrip = document.getElementById(ids.readingChatImageStrip) as HTMLElement;
    const newBtn = document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement;
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    input.value = "不能丢失的草稿";
    pasteImage(input);
    await waitFor(() => imageStrip.querySelectorAll(".chat-image-item").length === 1);
    applyConversationIdentity({ id: "conv-keep" });
    const messagesBefore = messages.innerHTML;
    const sendMessage = (window.chrome as unknown as { runtime: { sendMessage: Sendstub } }).runtime.sendMessage;
    const messageCallsBefore = sendMessage.mock.calls.length;

    clickOnce(newBtn);

    expect(document.querySelectorAll(".confirm-dialog-host")).toHaveLength(1);
    const message = document.querySelector(".confirm-dialog-message")!.textContent!;
    expect(message).toContain("清空未发送的草稿");
    expect(message).toContain("移除 1 张已添加的图片");
    expect(message).not.toContain("中断正在生成");
    clickOnce(document.querySelector(".confirm-dialog-cancel")!);
    await waitFor(() => document.querySelector(".confirm-dialog-host") === null);
    expect(input.value).toBe("不能丢失的草稿");
    expect(imageStrip.querySelectorAll(".chat-image-item")).toHaveLength(1);
    expect(messages.innerHTML).toBe(messagesBefore);
    expect(chatSessionState.currentConversationId).toBe("conv-keep");
    expect(sendMessage.mock.calls.length).toBe(messageCallsBefore);

    clickOnce(newBtn);
    clickOnce(document.querySelector(".confirm-dialog-confirm")!);
    await waitFor(() => input.value === "" && imageStrip.hidden === true);
    expect(chatSessionState.currentConversationId).toBe("");
    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
  });

  it("在途回合确认如实说明中断；Esc 取消不断流、不改草稿或会话", async () => {
    await activateEmptyChat();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "正在发送的问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);
    const conversationId = chatSessionState.currentConversationId;
    input.value = "流式期间的新草稿";

    clickOnce(document.getElementById(ids.readingChatNewBtn)!);

    const message = document.querySelector(".confirm-dialog-message")!.textContent!;
    expect(message).toContain("中断正在生成的回复");
    expect(message).toContain("清空未发送的草稿");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector(".confirm-dialog-host") === null);
    expect(ports[0].disconnect).not.toHaveBeenCalled();
    expect(input.value).toBe("流式期间的新草稿");
    expect(chatSessionState.currentConversationId).toBe(conversationId);

    clickOnce(document.getElementById(ids.readingChatNewBtn)!);
    clickOnce(document.querySelector(".confirm-dialog-confirm")!);
    await waitFor(() => ports[0].disconnect.mock.calls.length === 1);
    expect(input.value).toBe("");
    expect(chatSessionState.currentConversationId).toBe("");
  });

  it("无草稿、图片或在途回合时不弹确认，直接新建", async () => {
    await activateEmptyChat();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const marker = document.createElement("div");
    marker.className = "chat-msg";
    messages.appendChild(marker);

    clickOnce(document.getElementById(ids.readingChatNewBtn)!);

    expect(document.querySelector(".confirm-dialog-host")).toBeNull();
    await waitFor(() => !marker.isConnected);
  });
});

describe("player-ai 快捷动作 seam（无损续问）", () => {
  it("首开空会话直接发送；覆盖激活与受理的连点只发一次", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();

    const first = chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");
    const repeated = chat.runQuickActionPrompt("连点不应重复发送");

    await expect(first).resolves.toBe(true);
    await expect(repeated).resolves.toBe(false);
    const tabBodyChat = document.getElementById(ids.readingTabBodyChat) as HTMLElement;
    expect(tabBodyChat.classList.contains("is-active")).toBe(true);
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(input.value).toBe("");
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toBe("整理这期视频的内容，输出结构化总结。");
  });

  it("当前视频已有空闲对话：保留会话与上下文，新问答原位追加", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.runQuickActionPrompt("第一问");
    const conversationId = chatSessionState.currentConversationId;
    const contextKey = chatSessionState.currentContextKey;
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });

    await chat.runQuickActionPrompt("第二问");

    expect(chatSessionState.currentConversationId).toBe(conversationId);
    expect(chatSessionState.currentContextKey).toBe(contextKey);
    expect(ports).toHaveLength(2);
    expect((ports[1].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("第二问");
    (ports[1] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    expect(chatSessionState.chatHistory.filter((message) => message.role === "user").map((message) => message.content)).toEqual([
      "第一问",
      "第二问"
    ]);
  });

  it("设置中唤起且有草稿：退出设置并直接发送快捷提示词，原有文字草稿保留在输入框", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "尚未发送的草稿";
    const settingsMode = await import("../../extension/reader/settings-mode.js");
    settingsMode.openReaderSettingsMode();

    const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(accepted).toBe(true);
    expect(input.value).toBe("尚未发送的草稿");
    expect(state.reader.readingSettingsExpanded).toBe(false);
    expect((document.getElementById(ids.readingTabBodyChat) as HTMLElement).classList.contains("is-active")).toBe(true);
    expect(ports).toHaveLength(1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("整理这期视频的内容，输出结构化总结。");
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    expect(input.value).toBe("尚未发送的草稿");
  });

  it("已有图片草稿：直接发送纯文本快捷提示词，草稿图片不附带也不丢失", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const file = new File(["image"], "draft.png", { type: "image/png" });
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }] }
    });
    input.dispatchEvent(event);
    const imageStrip = document.getElementById(ids.readingChatImageStrip) as HTMLElement;
    await waitFor(() => imageStrip.querySelectorAll(".chat-image-item").length === 1);

    const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(accepted).toBe(true);
    expect(imageStrip.querySelectorAll(".chat-image-item")).toHaveLength(1);
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; images?: unknown[] };
    expect(posted.prompt).toBe("整理这期视频的内容，输出结构化总结。");
    expect(posted.images).toBeUndefined();
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    expect(imageStrip.querySelectorAll(".chat-image-item")).toHaveLength(1);
  });

  it("流式生成中：只定位并提示稍后再试，不停止或并发发送", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.runQuickActionPrompt("正在生成的第一问");

    const accepted = await chat.runQuickActionPrompt("不得并发发送");

    expect(accepted).toBe(false);
    expect(ports).toHaveLength(1);
    expect(ports[0].disconnect).not.toHaveBeenCalled();
    expect(document.getElementById(ids.readingChatMessages)?.textContent).toContain("请稍后再试");
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
  });

  it("已有回合等待发送闸：不覆盖输入、不排队，就绪后仍只发原回合", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "用户已发送的问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);

    const accepted = await chat.runQuickActionPrompt("不得自动排队");

    expect(accepted).toBe(false);
    expect(input.value).toBe("用户已发送的问题");
    expect(ports).toHaveLength(0);
    expect(document.getElementById(ids.readingChatMessages)?.textContent).toContain("请稍后再试");
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("用户已发送的问题");
  });

  it("快捷发送自身等待闸时连点：单飞保护贯穿受理，全程只发首个提示词", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    const chat = await lazyChat.ensureReaderChatTab();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;

    const first = chat.runQuickActionPrompt("只发送这个提示词");
    const repeated = chat.runQuickActionPrompt("连点提示词");
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(ports).toHaveLength(0);

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await expect(first).resolves.toBe(true);
    await expect(repeated).resolves.toBe(false);
    expect(ports).toHaveLength(1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("只发送这个提示词");
  });

  it("runQuickActionPrompt 被无字幕闸拦下：返回 false、无 port、不把总结提示词留进输入框", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "empty";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(accepted).toBe(false);
    expect(ports).toHaveLength(0);
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(input.value).toBe("");
  });

  it("一键总结被 YouTube 无字幕拦下后，点重新抓取成功即移除旧提示并自动发出总结提示词", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    let fetchAttempt = 0;
    const refreshSpy = vi.fn(async (options?: { forceRefresh?: boolean }) => {
      fetchAttempt += 1;
      if (options?.forceRefresh) {
        state.clip.subtitleFetchState = "ready";
        state.clip.noSubtitleReason = null;
        state.clip.subtitleBody = [{ from: 0, to: 10, content: "开启原生 CC 后抓到的字幕" }];
        statusBus.publishSubtitleStatusPhase("subtitle-ready");
      }
    });
    const unsubscribeRefresh = readerBus.subscribeSubtitleRefresh(refreshSpy);
    try {
      state.clip.title = "YT 访谈视频";
      state.clip.bvid = "BV1test000000";
      state.clip.cid = "101";
      state.clip.subtitleFetchState = "empty";
      state.clip.noSubtitleReason = "youtube-captions-unavailable";
      state.clip.subtitleBody = [];

      const chat = await lazyChat.ensureReaderChatTab();
      const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

      expect(accepted).toBe(false);
      expect(ports).toHaveLength(0);
      const inputCard = document.querySelector<HTMLElement>(".chat-input-card")!;
      const retryLink = inputCard.querySelector<HTMLAnchorElement>(".chat-context-notice a");
      expect(retryLink?.textContent).toBe("重新抓取");

      retryLink!.click();

      await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
      expect(refreshSpy).toHaveBeenCalledWith({ forceRefresh: true });
      expect(fetchAttempt).toBeGreaterThanOrEqual(2);
      expect(inputCard.querySelector(".chat-context-notice")).toBeNull();
      const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
      expect(posted.prompt).toBe("整理这期视频的内容，输出结构化总结。");
      const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
      expect(input.value).toBe("");
    } finally {
      unsubscribeRefresh();
    }
  });

  it("手动发送被无字幕拦下后点重新抓取：成功后移除重新抓取按钮并展示成功反馈，不自动发送草稿", async () => {
    const readerBus = await import("../../extension/reader/reader-bus.js");
    const refreshSpy = vi.fn(async (options?: { forceRefresh?: boolean }) => {
      if (options?.forceRefresh) {
        state.clip.subtitleFetchState = "ready";
        state.clip.noSubtitleReason = null;
        state.clip.subtitleBody = [{ from: 0, to: 10, content: "开启原生 CC 后抓到的字幕" }];
        statusBus.publishSubtitleStatusPhase("subtitle-ready");
      }
    });
    const unsubscribeRefresh = readerBus.subscribeSubtitleRefresh(refreshSpy);
    try {
      state.clip.title = "YT 访谈视频";
      state.clip.bvid = "BV1test000000";
      state.clip.cid = "101";
      state.clip.subtitleFetchState = "empty";
      state.clip.noSubtitleReason = "youtube-captions-unavailable";
      state.clip.subtitleBody = [];

      const chat = await lazyChat.ensureReaderChatTab();
      await chat.ensureChatTabActivated();
      const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
      const sendBtn = document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement;
      input.value = "手动草稿问题";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      sendBtn.click();

      const inputCard = document.querySelector<HTMLElement>(".chat-input-card")!;
      await waitFor(() => inputCard.querySelector(".chat-context-notice a")?.textContent === "重新抓取");
      expect(ports).toHaveLength(0);

      inputCard.querySelector<HTMLAnchorElement>(".chat-context-notice a")!.click();

      await waitFor(() =>
        Boolean(inputCard.querySelector(".chat-context-notice.is-success")?.textContent?.includes("已获取字幕"))
      );
      expect(inputCard.querySelector(".chat-context-notice a")).toBeNull();
      expect(ports).toHaveLength(0);
      expect(input.value).toBe("手动草稿问题");
    } finally {
      unsubscribeRefresh();
    }
  });

  it("字幕等待期间取消快捷发送后不残留提示词，转写完成后再次触发可正常发送", async () => {
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];

    const chat = await lazyChat.ensureReaderChatTab();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const waitCard = document.querySelector<HTMLElement>(".chat-subtitle-wait")!;
    const cancel = waitCard.querySelector<HTMLButtonElement>(".chat-subtitle-wait-cancel")!;

    const first = chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");
    await waitFor(() => waitCard.hidden === false);
    cancel.click();
    await expect(first).resolves.toBe(false);
    expect(input.value).toBe("");
    expect(ports).toHaveLength(0);

    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "字幕" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await expect(chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。")).resolves.toBe(true);
    expect(ports).toHaveLength(1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("整理这期视频的内容，输出结构化总结。");
  });

  it("快捷动作不消费待解释意图（与解释自动发送互不踩踏）", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({ from: 3, content: "挂起句", createdAt: Date.now() });
    const chat = await lazyChat.ensureReaderChatTab();

    await chat.runQuickActionPrompt("总结提示词");

    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toBe("总结提示词");

    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    await chat.ensureChatTabActivated();
    await waitFor(() => ports.length === 2);
    expect((ports[1].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toContain("挂起句");
  });

  it("带 explanation 的追问意图：保留上下文并聚焦输入框，追问发送时拼入已有解释并消费", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({
      from: 10,
      content: "原字幕句",
      selection: "选区词",
      explanation: "已有释义正文",
      createdAt: 1000
    });
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    expect(ports).toHaveLength(0);
    const intentCard = document.getElementById(ids.readingChatIntent) as HTMLElement;
    expect(intentCard.hidden).toBe(false);
    expect(intentCard.querySelector(".biliscript-reading-chat-intent-title")?.textContent).toBe("基于当前解释继续追问");
    expect(intentCard.querySelector<HTMLButtonElement>('[data-chat-intent-action="send"]')?.hidden).toBe(true);

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);

    input.value = "请再举个例子";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toContain("已有释义正文");
    expect(posted.prompt).toContain("追问：请再举个例子");
    expect(intentCard.hidden).toBe(true);

    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    input.value = "普通追问";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 2);
    expect((ports[1].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("普通追问");
  });

  it("无 explanation 且流式生成中：提示稍后可发送，流结束后点引用卡发送可发出并消费", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.runQuickActionPrompt("首问");
    expect(ports).toHaveLength(1);

    explainIntent.setPendingExplainIntent({ from: 20, content: "忙时字幕句", createdAt: 2000 });
    await chat.ensureChatTabActivated();

    expect(ports).toHaveLength(1);
    expect(document.getElementById(ids.readingChatMessages)?.textContent).toContain("当前对话正在生成，待本轮结束后可继续追问或发送。");
    const sendAction = document.querySelector<HTMLButtonElement>(
      `#${ids.readingChatIntent} [data-chat-intent-action="send"]`
    ) as HTMLButtonElement;
    expect(sendAction.hidden).toBe(false);

    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    sendAction.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 2);
    expect((ports[1].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toContain("忙时字幕句");
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(2);
  });
});

describe("历史回放分片让出（P2-1：50ms 预算 + scheduler.yield/setTimeout 兜底）", () => {
  const REPLAY_MESSAGES = [
    { role: "user", content: "第一问" },
    { role: "assistant", content: "第一答" },
    { role: "user", content: "第二问" },
    { role: "assistant", content: "第二答" },
    { role: "user", content: "第三问" },
    { role: "assistant", content: "第三答" }
  ];

  let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

  afterEach(() => {
    nowSpy?.mockRestore();
    nowSpy = null;
  });

  function forceYieldEveryMessage(): void {
    let clock = 0;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      clock += 60;
      return clock;
    });
  }

  function seedSavedConversation(messages = REPLAY_MESSAGES): void {
    const chromeStub = window.chrome as unknown as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    chromeStub.storage.local.get = vi.fn(async () => ({
      biliscript_ai_conversations_v1: [
        {
          id: "conv-replay",
          title: "测试视频",
          contextKey: "video:BV1test000000|101",
          contextTitle: "测试视频",
          contextUrl: "https://www.bilibili.com/video/BV1test000000/",
          isVideoContext: true,
          createdAt: 1000,
          updatedAt: 2000,
          contextRef: {
            bvid: "BV1test000000",
            cid: "101",
            url: "https://www.bilibili.com/video/BV1test000000/"
          },
          messages
        }
      ]
    }));
  }

  it("按序分片渲染、内容不变，滚底只在全部上屏后发生一次", async () => {
    seedReadyContext();
    seedSavedConversation();
    forceYieldEveryMessage();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const scrollWrites: number[] = [];
    let scrollTopValue = 0;
    Object.defineProperty(messages, "scrollTop", {
      configurable: true,
      get: () => scrollTopValue,
      set: (value: number) => {
        scrollWrites.push(value);
        scrollTopValue = value;
      }
    });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const earlyCount = messages.querySelectorAll(".chat-msg").length;
    expect(earlyCount).toBeGreaterThan(0);
    expect(earlyCount).toBeLessThan(REPLAY_MESSAGES.length);

    await waitFor(() => messages.querySelectorAll(".chat-msg").length === REPLAY_MESSAGES.length);
    const rendered = [...messages.querySelectorAll(".chat-msg")];
    expect(rendered.map((node) => node.className)).toEqual([
      "chat-msg chat-msg-user",
      "chat-msg chat-msg-assistant",
      "chat-msg chat-msg-user",
      "chat-msg chat-msg-assistant",
      "chat-msg chat-msg-user",
      "chat-msg chat-msg-assistant"
    ]);
    expect(rendered.map((node) => node.textContent?.trim())).toEqual([
      "第一问",
      "第一答",
      "第二问",
      "第二答",
      "第三问",
      "第三答"
    ]);
    await waitFor(() => scrollWrites.length > 0);
    expect(scrollWrites).toHaveLength(1);
  });

  it("回放让出期间发送：新消息等回放落定后追加在末尾（不插进中间）", async () => {
    seedReadyContext();
    seedSavedConversation();
    forceYieldEveryMessage();

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;

    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "回放中的新问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    await waitFor(() => messages.querySelectorAll(".chat-msg").length === REPLAY_MESSAGES.length + 2);
    const texts = [...messages.querySelectorAll(".chat-msg")].map((node) => node.textContent?.trim());
    expect(texts.slice(0, REPLAY_MESSAGES.length)).toEqual([
      "第一问",
      "第一答",
      "第二问",
      "第二答",
      "第三问",
      "第三答"
    ]);
    expect(texts[REPLAY_MESSAGES.length]).toBe("回放中的新问题");
    expect(texts[REPLAY_MESSAGES.length + 1]).toBe("");
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; history?: unknown[] };
    expect(posted.prompt).toBe("回放中的新问题");
  });
});

describe("在途回合点历史项（C′：先体面停流落盘、再切换）", () => {
  function seedTwoConversations(): void {
    const chromeStub = window.chrome as unknown as {
      storage: { local: { get: ReturnType<typeof vi.fn> } };
    };
    const conversation = (id: string, label: string) => ({
      id,
      title: `会话 ${label}`,
      contextKey: "video:BV1test000000|101",
      contextTitle: "测试视频",
      contextUrl: "https://www.bilibili.com/video/BV1test000000/",
      isVideoContext: true,
      createdAt: 1000,
      updatedAt: 2000,
      contextRef: {
        bvid: "BV1test000000",
        cid: "101",
        url: "https://www.bilibili.com/video/BV1test000000/"
      },
      messages: [
        { role: "user", content: `${label} 的历史问题` },
        { role: "assistant", content: `${label} 的历史答案` }
      ]
    });
    chromeStub.storage.local.get = vi.fn(async () => ({
      biliscript_ai_conversations_v1: [conversation("conv-a", "A"), conversation("conv-b", "B")]
    }));
  }

  function firePort(port: FakePort, msg: unknown): void {
    (port as FakePort & { __fire: (message: unknown) => void }).__fire(msg);
  }

  function els() {
    return {
      messages: document.getElementById(ids.readingChatMessages) as HTMLElement,
      input: document.getElementById(ids.readingChatInput) as HTMLTextAreaElement,
      historyList: document.getElementById(ids.readingChatHistoryList) as HTMLElement
    };
  }

  function clickHistoryOpen(historyList: HTMLElement, id: string): void {
    const btn = historyList.querySelector(`.chat-history-open[data-id="${id}"]`);
    expect(btn).not.toBe(null);
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function stopRequests(port: FakePort): unknown[][] {
    return port.postMessage.mock.calls.filter((call) => (call[0] as { action?: unknown })?.action === "stop");
  }

  it("流式中点历史项：先停流、stopped 落定把 partial 写回原会话并落盘，然后才切换回放", async () => {
    seedReadyContext();
    seedTwoConversations();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    expect(chatSessionState.currentConversationId).toBe("conv-a");

    const { messages, input, historyList } = els();
    input.value = "原会话的新问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);
    firePort(ports[0], { type: "token", data: "部分正文" });
    await waitFor(() => messages.textContent!.includes("部分正文"));

    const historyPage = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    document.getElementById(ids.readingChatMoreBtn)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    document.getElementById(ids.readingChatHistoryBtn)!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(false);
    const scrollTo = vi.fn((options: ScrollToOptions) => {
      messages.scrollTop = Number(options.top || 0);
    });
    Object.defineProperty(messages, "scrollHeight", { configurable: true, get: () => 640 });
    Object.defineProperty(messages, "scrollTo", { configurable: true, value: scrollTo });

    clickHistoryOpen(historyList, "conv-b");
    await waitFor(() => stopRequests(ports[0]).length === 1);
    expect(chatSessionState.currentConversationId).toBe("conv-a");
    expect(messages.textContent).toContain("原会话的新问题");
    expect(historyPage.hidden).toBe(false);
    expect(historyList.querySelector(".chat-history-item[data-id=conv-b]")?.textContent).toContain("正在保存当前回答…");
    clickHistoryOpen(historyList, "conv-b");
    expect(stopRequests(ports[0])).toHaveLength(1);

    firePort(ports[0], { type: "stopped", reason: "已停止生成" });
    await waitFor(() => chatSessionState.currentConversationId === "conv-b");

    const saved = chatSessionState.savedConversations as unknown as Array<{
      id: string;
      messages: Array<{ content: string }>;
    }>;
    expect(saved.find((item) => item.id === "conv-a")!.messages.map((m) => m.content)).toEqual([
      "A 的历史问题",
      "A 的历史答案",
      "原会话的新问题",
      "部分正文"
    ]);
    const chromeStub = window.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    const writes = chromeStub.storage.local.set.mock.calls
      .map((call) => (call[0] as Record<string, unknown>).biliscript_ai_conversations_v1)
      .filter(Boolean) as Array<Array<{ id: string; messages: Array<{ content: string }> }>>;
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1].find((item) => item.id === "conv-a")!.messages.map((m) => m.content))
      .toContain("部分正文");

    await waitFor(() => messages.textContent!.includes("B 的历史答案") && scrollTo.mock.calls.length > 0);
    expect(messages.textContent).not.toContain("部分正文");
    expect(messages.textContent).not.toContain("原会话的新问题");
    expect(historyPage.hidden).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 640, behavior: "instant" });
    expect(messages.scrollTop).toBe(640);
    expect(document.activeElement).toBe(input);
  });

  it("[characterization] 不在途点历史项：同一 tick 内切换、不发 stop（零延迟零行为差）", async () => {
    seedReadyContext();
    seedTwoConversations();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    expect(chatSessionState.currentConversationId).toBe("conv-a");

    const { historyList } = els();
    document.getElementById(ids.readingChatHistoryBtn)!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    clickHistoryOpen(historyList, "conv-b");

    expect(chatSessionState.currentConversationId).toBe("conv-b");
    expect(ports).toHaveLength(0);
    expect(document.activeElement).toBe(document.getElementById(ids.readingChatInput));
  });

  it("拆除类入口（流式中删除当前会话）：走既有断连路径、不发 stop（不触发 settle）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const { messages, input, historyList } = els();

    input.value = "第一问";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);
    firePort(ports[0], { type: "token", data: "第一答" });
    firePort(ports[0], { type: "done" });
    await waitFor(() => chatSessionState.savedConversations.length === 1);
    const currentId = chatSessionState.currentConversationId;

    input.value = "第二问";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 2);

    const removeBtn = historyList.querySelector(`.chat-history-remove[data-id="${currentId}"]`);
    expect(removeBtn).not.toBe(null);
    removeBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => Boolean(document.querySelector(".confirm-dialog-confirm")));
    expect(document.querySelector(".confirm-dialog-message")?.textContent).toContain("正在生成的回答将被丢弃");
    (document.querySelector(".confirm-dialog-confirm") as HTMLButtonElement).click();
    await waitFor(() => chatSessionState.currentConversationId === "");

    expect(stopRequests(ports[1])).toHaveLength(0);
    expect(ports[1].disconnect).toHaveBeenCalledTimes(1);
    expect(messages.querySelector(".chat-msg-user")).toBe(null);
  });
});

describe("外部设置变更与在途回合（refreshProviders 守卫）", () => {
  function holdOffscreenEnsure(): () => void {
    const chromeStub = window.chrome as unknown as {
      runtime: { sendMessage: (message: { type?: string }, callback?: (resp: unknown) => void) => unknown };
    };
    const original = chromeStub.runtime.sendMessage;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
      if (String(message?.type || "") === "ensure-offscreen-chat") {
        void gate.then(() => callback?.({ ok: true }));
        return undefined;
      }
      return original(message, callback);
    });
    return () => release();
  }

  function seedSavedConversationForList(id: string, title: string): void {
    setSavedConversations([
      {
        id,
        title,
        contextKey: "",
        contextTitle: "",
        contextUrl: "",
        isVideoContext: true,
        createdAt: 0,
        updatedAt: 0,
        contextRef: null,
        messages: []
      }
    ]);
  }

  it("在途未流式（待发 prompt 窗口）：不重建视图，历史列表照刷", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const releaseOffscreen = holdOffscreenEnsure();

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const historyList = document.getElementById(ids.readingChatHistoryList) as HTMLElement;
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "在途问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => Boolean(messages.querySelector(".chat-msg-user")));
    expect(ports).toHaveLength(0);

    seedSavedConversationForList("conv-x", "设置变更后可见");
    expect(historyList.textContent).not.toContain("设置变更后可见");
    const innerBefore = messages.innerHTML;

    fireStorageChange({ aiProviders: { newValue: [], oldValue: [] } }, "sync");
    await waitFor(() => historyList.textContent!.includes("设置变更后可见"));

    expect(messages.innerHTML).toBe(innerBefore);
    releaseOffscreen();
  });

  it("流式窗口：历史列表照刷（顺序在视图重建之前），视图不重建", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    const historyList = document.getElementById(ids.readingChatHistoryList) as HTMLElement;
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "流式问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);

    seedSavedConversationForList("conv-y", "流式期可见");
    const innerBefore = messages.innerHTML;

    fireStorageChange({ aiProviders: { newValue: [], oldValue: [] } }, "sync");
    await waitFor(() => historyList.textContent!.includes("流式期可见"));

    expect(messages.innerHTML).toBe(innerBefore);
  });
});

describe("resize 合帧（P2-3：model-select 宽度重算走 rAF 而非同步）", () => {
  it("resize 不同步写宽度，帧落定后按计算结果写入", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const chip = document.getElementById(ids.readingChatModelChip) as HTMLElement;
    chip.style.width = "";

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    expect(chip.style.width).toBe("");

    await waitFor(() => chip.style.width !== "");
    expect(chip.style.width).toBe("156px");
  });
});

describe("无平台空态「前往设置」（arch-slim-2/06 死绑定回归 + 票 03 直达）", () => {
  it("后建链接经 #readingChatRoot 容器委托直达新增 AI 平台编辑器", async () => {
    const chromeStub = window.chrome as unknown as { runtime: { sendMessage: Sendstub } };
    chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
      if (String(message?.type || "") === "ai-providers-list") {
        callback?.({ ok: true, providers: [] });
      } else {
        callback?.({ ok: true });
      }
      return undefined;
    });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const link = document.getElementById(ids.readingChatOpenSettings) as HTMLAnchorElement | null;
    expect(link).not.toBe(null);
    const settingsPanel = document.getElementById(ids.readingSettingsPanel) as HTMLElement;
    expect(settingsPanel.hidden).toBe(true);
    expect(state.reader.readingSettingsExpanded).toBe(false);

    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector(".provider-editor-dialog") !== null, { timeoutMs: 5000 });
    expect(state.reader.readingSettingsExpanded).toBe(true);
    expect(
      document.querySelector(".provider-editor-dialog .provider-editor-title")?.textContent
    ).toBe("添加AI 平台");
    const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
    closeProviderEditor(true);
  });
});

describe("输入框高度：聚焦不撑高、只随内容走", () => {
  beforeEach(() => {
    vi.spyOn(CSS, "supports").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountChat(): Promise<HTMLTextAreaElement> {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    return document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
  }

  it("聚焦/失焦都不写行内 height（空输入恒一行，高度落回 CSS 自然高）", async () => {
    const input = await mountChat();

    expect(input.style.height).toBe("");

    input.focus();
    expect(input.style.height).toBe("");

    input.blur();
    expect(input.style.height).toBe("");
  });

  it("内容长高、封顶 320", async () => {
    const input = await mountChat();
    input.value = "x";

    Object.defineProperty(input, "scrollHeight", { value: 140, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("140px");

    Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("320px");
  });

  it("删回单行：行内高跟着缩回自然高，不残留上次撑起的高", async () => {
    const input = await mountChat();
    input.value = "xxxxxxxx";

    Object.defineProperty(input, "scrollHeight", { value: 200, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("200px");

    Object.defineProperty(input, "scrollHeight", { value: 56, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("56px");
  });

  it("未封顶 overflow-y hidden（两行边界不闪滚动条）；封顶 320 才放行 auto", async () => {
    const input = await mountChat();
    input.value = "x";

    Object.defineProperty(input, "scrollHeight", { value: 48, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("48px");
    expect(input.style.overflowY).toBe("hidden");

    Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("320px");
    expect(input.style.overflowY).toBe("auto");
  });

  it("空输入不写行内高：入场瞬时布局把 scrollHeight 读多大都不粘成巨盒", async () => {
    const input = await mountChat();

    Object.defineProperty(input, "scrollHeight", { value: 260, configurable: true });
    input.focus();
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("");
    expect(input.style.overflowY).toBe("hidden");

    input.value = "很长的一段文字";
    Object.defineProperty(input, "scrollHeight", { value: 120, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("120px");

    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(input.style.height).toBe("");
  });
});

describe("输入框自适应高度：逐键回写不得被自己放大", () => {
  const PADDING = 4;

  beforeEach(() => {
    vi.spyOn(CSS, "supports").mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function mountAutosizingInput(): Promise<HTMLTextAreaElement> {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const naturalContentHeight = () => 52 + Math.floor(input.value.length / 10) * 21.75;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => {
        const inline = Number.parseFloat(input.style.height || "0");
        return Math.max(naturalContentHeight(), inline) + PADDING;
      }
    });
    input.focus();
    return input;
  }

  function typeChar(input: HTMLTextAreaElement, ch: string): void {
    input.value += ch;
    input.dispatchEvent(new Event("input"));
  }

  it("短输入逐字敲：盒高稳在单行自然高，不逐键 +4px", async () => {
    const input = await mountAutosizingInput();

    for (let i = 0; i < 5; i += 1) {
      typeChar(input, "d");
    }

    expect(input.style.height).toBe("56px");
  });

  it("删除逐字退格：长内容删除后高度跟着缩回，不朝反向继续长", async () => {
    const input = await mountAutosizingInput();

    for (let i = 0; i < 30; i += 1) {
      typeChar(input, "d");
    }
    const grown = Number.parseFloat(input.style.height);
    expect(grown).toBeGreaterThan(56);

    for (let i = 0; i < 25; i += 1) {
      input.value = input.value.slice(0, -1);
      input.dispatchEvent(new Event("input"));
    }

    expect(input.style.height).toBe("56px");
  });

  it("内容真的变长时仍然长高并封顶 320（屏上盒高，不再多出内边距）", async () => {
    const input = await mountAutosizingInput();

    for (let i = 0; i < 200; i += 1) {
      typeChar(input, "d");
    }

    expect(input.style.height).toBe("320px");
  });
});

describe("消息区滚底按钮：显隐跟随机动、点一下回底", () => {
  const SCROLL_HEIGHT = 1000;
  const CLIENT_HEIGHT = 300;
  const FOLLOW_THRESHOLD_PX = 40;
  const BUTTON_THRESHOLD_PX = 120;

  function captureRaf(): { flush: () => void; restore: () => void } {
    const queue: FrameRequestCallback[] = [];
    const spy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return queue.length;
    });
    return {
      flush: () => {
        for (let guard = 0; queue.length > 0 && guard < 50; guard += 1) {
          queue.splice(0, queue.length).forEach((cb) => cb(0));
        }
      },
      restore: () => spy.mockRestore()
    };
  }

  async function mountScrolledChat(): Promise<{ messages: HTMLElement; btn: HTMLButtonElement }> {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    Object.defineProperty(messages, "scrollHeight", { get: () => SCROLL_HEIGHT, configurable: true });
    Object.defineProperty(messages, "clientHeight", { get: () => CLIENT_HEIGHT, configurable: true });
    Object.defineProperty(messages, "scrollTo", {
      configurable: true,
      value: (options?: ScrollToOptions | number) => {
        if (options && typeof options === "object") {
          messages.scrollTop = Number(options.top ?? 0);
        }
      }
    });
    return { messages, btn: document.getElementById(ids.readingChatScrollBottomBtn) as HTMLButtonElement };
  }

  function userScrollTo(messages: HTMLElement, top: number): void {
    messages.scrollTop = top;
    messages.dispatchEvent(new Event("scroll"));
  }

  it("模板挂位与初态：挂在 footer 内、默认 hidden（底部时没有入口）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const btn = document.getElementById(ids.readingChatScrollBottomBtn) as HTMLButtonElement;
    const footer = btn.parentElement as HTMLElement;
    expect(footer.classList.contains("chat-footer")).toBe(true);
    expect(Array.from(footer.children).indexOf(btn)).toBe(0);
    expect(btn.hidden).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("回到底部");
    expect(btn.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(btn.querySelector("svg path")?.getAttribute("d")).toBe("m6 9 6 6 6-6");
  });

  it("双阈值迟滞：40px 内跟随且不显按钮，40px~120px 间不显按钮，>120px 按钮亮起，回底退场", async () => {
    const { messages, btn } = await mountScrolledChat();
    const raf = captureRaf();
    try {
      userScrollTo(messages, SCROLL_HEIGHT - CLIENT_HEIGHT - FOLLOW_THRESHOLD_PX);
      raf.flush();
      expect(btn.hidden).toBe(true);

      userScrollTo(messages, SCROLL_HEIGHT - CLIENT_HEIGHT - 80);
      raf.flush();
      expect(btn.hidden).toBe(true);

      userScrollTo(messages, SCROLL_HEIGHT - CLIENT_HEIGHT - BUTTON_THRESHOLD_PX - 1);
      raf.flush();
      expect(btn.hidden).toBe(false);

      userScrollTo(messages, SCROLL_HEIGHT);
      raf.flush();
      expect(btn.hidden).toBe(true);
    } finally {
      raf.restore();
    }
  });

  it("点击：滚到底部、按钮退场", async () => {
    const { messages, btn } = await mountScrolledChat();
    const raf = captureRaf();
    try {
      userScrollTo(messages, 100);
      raf.flush();
      expect(btn.hidden).toBe(false);

      btn.click();

      expect(messages.scrollTop).toBe(SCROLL_HEIGHT);
      expect(btn.hidden).toBe(true);
    } finally {
      raf.restore();
    }
  });

  it("回底动画途中：按钮不重新亮起、流式跟随不被中途判死", async () => {
    const { messages, btn } = await mountScrolledChat();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const raf = captureRaf();
    try {
      input.value = "滚动测试";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await waitFor(() => ports.length === 1);
      userScrollTo(messages, 100);
      raf.flush();
      expect(btn.hidden).toBe(false);

      btn.click();
      expect(btn.hidden).toBe(true);

      userScrollTo(messages, 600);
      raf.flush();
      expect(btn.hidden).toBe(true);

      (ports[0] as FakePort & { __fire: (message: unknown) => void }).__fire({ type: "token", data: "正文一帧" });
      raf.flush();
      expect(messages.scrollTop).toBe(SCROLL_HEIGHT);

      userScrollTo(messages, SCROLL_HEIGHT);
      raf.flush();
      userScrollTo(messages, 200);
      raf.flush();
      expect(btn.hidden).toBe(false);
    } finally {
      raf.restore();
    }
  });

  it("回底途中用户自己滚了：立即放闸，按钮重新亮起", async () => {
    const { messages, btn } = await mountScrolledChat();
    const raf = captureRaf();
    try {
      userScrollTo(messages, 100);
      raf.flush();
      btn.click();

      messages.dispatchEvent(new Event("wheel"));
      userScrollTo(messages, 300);
      raf.flush();
      expect(btn.hidden).toBe(false);
    } finally {
      raf.restore();
    }
  });

  it("清场（新会话）：按钮退场且放闸——此后的上翻还能再点亮", async () => {
    const { messages, btn } = await mountScrolledChat();
    const raf = captureRaf();
    try {
      userScrollTo(messages, 100);
      raf.flush();
      btn.click();
      userScrollTo(messages, 600);
      raf.flush();
      expect(btn.hidden).toBe(true);

      (document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement).click();
      const marker = document.createElement("div");
      marker.className = "chat-msg";
      messages.appendChild(marker);
      await waitFor(() => !messages.contains(marker));
      raf.flush();
      expect(btn.hidden).toBe(true);

      userScrollTo(messages, 100);
      raf.flush();
      expect(btn.hidden).toBe(false);
    } finally {
      raf.restore();
    }
  });
});

describe("模型名显示：集合站的 org 前缀只从显示层剥掉", () => {
  const SEP = String.fromCharCode(1);
  const PREFIXED = "deepseek-ai/DeepSeek-V4.1-Flash";

  function shown(value: string): string {
    return value.split(SEP).join("<SEP>");
  }

  function optionTexts(panelList: HTMLElement): string[] {
    return [...panelList.querySelectorAll<HTMLElement>(".chat-model-option-name")].map(
      (node) => node.textContent || ""
    );
  }

  function optionValues(panelList: HTMLElement): string[] {
    return [...panelList.querySelectorAll<HTMLElement>(".chat-model-option")].map(
      (node) => node.getAttribute("data-value") || ""
    );
  }

  function clickModelOption(panelList: HTMLElement, value: string): void {
    const target = panelList.querySelector<HTMLButtonElement>(
      `.chat-model-option[data-value="${value}"]`
    ) as HTMLButtonElement;
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  it("chip 与弹层条目剥前缀，复合值与落盘选中值保持完整", async () => {
    providerList = [
      { id: "modelscope", name: "ModelScope", models: [PREFIXED, "Qwen/Qwen3-32B", "glm-4.6"], enabled: true }
    ];
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    const chipModel = chip.querySelector(".chat-model-chip-model") as HTMLElement;
    const panelList = document.getElementById(ids.readingChatModelList) as HTMLElement;
    const steps: string[] = [];

    expect(chipModel.textContent).toBe("ModelScope·DeepSeek-V4.1-Flash");
    expect(chatSessionState.selectedModelValue).toBe(`modelscope${SEP}${PREFIXED}`);
    expect(chip.dataset.selectedValue).toBe(`modelscope${SEP}${PREFIXED}`);
    steps.push(
      `1 激活（首项 = ${PREFIXED}） | chip=${chipModel.textContent} | 值源=${shown(chatSessionState.selectedModelValue)}`
    );

    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    const names = optionTexts(panelList);
    const values = optionValues(panelList);
    expect(names).toEqual(["DeepSeek-V4.1-Flash", "Qwen3-32B", "glm-4.6"]);
    expect(values).toEqual([
      `modelscope${SEP}${PREFIXED}`,
      `modelscope${SEP}Qwen/Qwen3-32B`,
      `modelscope${SEP}glm-4.6`
    ]);
    steps.push(`2 开面板 | 条目=[${names.join(", ")}] | data-value=[${values.map(shown).join(", ")}]`);

    clickModelOption(panelList, `modelscope${SEP}Qwen/Qwen3-32B`);
    const setMock = (window.chrome as unknown as { storage: { local: { set: ReturnType<typeof vi.fn> } } })
      .storage.local.set;
    expect(chatSessionState.selectedModelValue).toBe(`modelscope${SEP}Qwen/Qwen3-32B`);
    expect(chip.dataset.selectedValue).toBe(`modelscope${SEP}Qwen/Qwen3-32B`);
    expect(chipModel.textContent).toBe("ModelScope·Qwen3-32B");
    expect(setMock).toHaveBeenCalledWith({ [SELECTED_PROVIDER_KEY]: `modelscope${SEP}Qwen/Qwen3-32B` });
    steps.push(
      `3 点 Qwen/Qwen3-32B（带前缀） | chip=${chipModel.textContent} | 值源=${shown(chatSessionState.selectedModelValue)} | 落盘=${shown(
        `modelscope${SEP}Qwen/Qwen3-32B`
      )}`
    );

    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    clickModelOption(panelList, `modelscope${SEP}glm-4.6`);
    expect(chatSessionState.selectedModelValue).toBe(`modelscope${SEP}glm-4.6`);
    expect(chip.dataset.selectedValue).toBe(`modelscope${SEP}glm-4.6`);
    expect(chipModel.textContent).toBe("ModelScope·glm-4.6");
    steps.push(
      `4 点 glm-4.6（无斜杠裸名） | chip=${chipModel.textContent} | 值源=${shown(chatSessionState.selectedModelValue)}`
    );

    expect(steps).toHaveLength(4);
    const artifactDir = join(process.cwd(), ".scratch", "tickets", "chat-model-name-display", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "01-e2e-walkthrough.txt"),
      [
        "# 集合站模型名显示走查工件（由 tests/reader/chat-tab.test.ts 生成）",
        "# 用例：ModelScope 平台（模型 id 带 org 命名空间前缀）激活对话 tab → 看 chip → 开面板看条目名与 data-value → 点选换模型",
        "# 判据：chip 与弹层条目只显示裸名（剥最后一段斜杠之前的前缀）；复合值（data-value / chatSessionState.selectedModelValue）、",
        "#       落盘选中值仍是完整 id；无斜杠裸名不受影响。复合值里的 \\u0001 分隔符在工件里写作 <SEP>",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });

  it("拖拽图片入 .chat-input-card 添加附件、非图片给出提示；开启新会话聚焦输入区；切走或关会话清浮层不抢焦点", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    const inputCard = input.closest<HTMLElement>(".chat-input-card")!;

    const txtDrop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(txtDrop, "dataTransfer", {
      value: { types: ["Files"], files: [new File(["hello"], "note.txt", { type: "text/plain" })] }
    });
    inputCard.dispatchEvent(txtDrop);
    expect(document.querySelector(".chat-context-notice")?.textContent).toContain("仅支持拖入图片文件");

    const outsideBtn = document.createElement("button");
    document.body.appendChild(outsideBtn);
    outsideBtn.focus();
    const newChatBtn = document.getElementById(ids.readingChatNewBtn) as HTMLButtonElement;
    newChatBtn.click();
    await waitFor(() => document.activeElement === input);

    const moreBtn = document.getElementById(ids.readingChatMoreBtn) as HTMLButtonElement;
    moreBtn.click();
    expect(document.getElementById(ids.readingChatMoreMenu)?.hidden).toBe(false);
    outsideBtn.focus();
    chat.deactivateChatTabOverlays();
    expect(document.getElementById(ids.readingChatMoreMenu)?.hidden).toBe(true);
    expect(document.activeElement).toBe(outsideBtn);
    chat.closeChatSession();
  });
});
