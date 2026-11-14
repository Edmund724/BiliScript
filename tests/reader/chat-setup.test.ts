// 票 provider-onboarding-consistency/03 的 AI 对话首配与草稿恢复测试：
// 无平台空态、发送前无平台、已选平台缺 Key 三条入口都能直达正确的平台编辑记录；
// 保存成功后回到 AI 对话、聚焦输入区并提示「平台已就绪、请确认发送」——是否发送
// 始终由用户再点一次；受理前拦截的草稿与图片附件原位保留；已受理错误回合（用户
// 气泡 / 部分回复）不自动重发、不新建会话、不清输入、不拆历史；取消 / 换视频 /
// 关抽屉 / 关会话后不残留返回行为。
//
// 手法（对齐 tests/reader/explain-setup-resume.test.ts 与 tests/reader/chat-tab.test.ts）：
//   - 真实阅读壳 + 真实对话组合根（ui-renderer + lazy-chat-tab），chrome 消息按 type 路由；
//   - ui/settings-panel 整个 mock 掉，捕获 openReaderAiSetup(errorClass, session, target)，
//     用捕获的 session 回调模拟「保存成功 / 取消编辑」两个装配方出口；
//   - 意图叶直接 import 断言快照字段与单槽语义。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import { callbackStyleSendMessage } from "../helpers/chrome-runtime-host.js";
import { createMemoryStorageArea, type ChromeHostStorageArea } from "../helpers/memory-storage-area.js";
import { MISSING_PROVIDER_KEY_MESSAGE } from "../../extension/core/overview-setup-error.js";
import { BILISCRIPT_URL_CHANGE_EVENT } from "../../extension/core/url-watcher.js";
import type { TestState } from "./reader-test-env.js";

const setupMock = vi.hoisted(() => ({
  openReaderAiSetup: vi.fn(async () => {}),
  openReaderTranscribeSettings: vi.fn(),
  renderReaderSettingsPanel: vi.fn()
}));
vi.mock("../../extension/ui/settings-panel.js", () => setupMock);

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
  fetchHotCommentsWithLedger: async () => ({ comments: [], note: "无法获取视频 aid" })
}));
vi.mock("../../extension/bilibili/gateway-core.js", () => ({
  bgFetchJson: gatewayCoreMock.bgFetchJson,
  isBiliUrl: gatewayCoreMock.isBiliUrl
}));

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
let resumeLeaf: typeof import("../../extension/reader/chat-setup-resume.js");

const ports: FakePort[] = [];
interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
  __fire?: (msg: unknown) => void;
}

let providersPayload: Array<Record<string, unknown>> = [];
let settingsPayload: Record<string, unknown> = {};

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
    "ai-providers-list": () => ({ ok: true, providers: providersPayload }),
    "get-settings": () => ({ ok: true, settings: settingsPayload })
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
    port.__fire = (msg: unknown) => messageListeners.forEach((fn) => fn(msg));
    ports.push(port);
    return port;
  });
  chromeStub.storage.local = createMemoryStorageArea();
  chromeStub.storage.sync.set = vi.fn(async () => {});
  chromeStub.storage.onChanged.addListener = vi.fn();
  chromeStub.storage.onChanged.removeListener = vi.fn();
}

async function waitFor(predicate: () => boolean, { timeoutMs = 1000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function seedReadyContext(): void {
  state.clip.title = "测试视频";
  state.clip.bvid = "BV1test000000";
  state.clip.cid = "101";
  state.clip.aid = "7100";
  state.clip.subtitleFetchState = "ready";
  state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
}

async function loadShell(): Promise<void> {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  ids = (await import("../../extension/reader/state.js")).ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
  lazyChat = await import("../../extension/reader/lazy-chat-tab.js");
  chatSessionState = (await import("../../extension/chat/chat-state.js")).chatSessionState;
  resumeLeaf = await import("../../extension/reader/chat-setup-resume.js");
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
}

async function activateChat(): Promise<void> {
  seedReadyContext();
  const chat = await lazyChat.ensureReaderChatTab();
  await chat.ensureChatTabActivated();
}

function inputEl(): HTMLTextAreaElement {
  return document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
}

function messagesEl(): HTMLElement {
  return document.getElementById(ids.readingChatMessages) as HTMLElement;
}

function imageStrip(): HTMLElement {
  return document.getElementById(ids.readingChatImageStrip) as HTMLElement;
}

function setupLink(): HTMLAnchorElement | null {
  return document.getElementById(ids.readingChatOpenSettings) as HTMLAnchorElement | null;
}

function clickElement(element: Element | null): void {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function sendEnter(): void {
  inputEl().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
}

function noticeText(): string {
  return messagesEl().querySelector(".chat-context-notice")?.textContent || "";
}

function capturedSetupSession() {
  const call = setupMock.openReaderAiSetup.mock.calls.at(-1);
  expect(call, "openReaderAiSetup 应已被调用").toBeTruthy();
  return call as unknown as [
    string,
    { onAfterSave(): void; onSessionEnd(): void },
    { providerId?: string } | undefined
  ];
}

// ===== 图片附件（真实压缩管线，jsdom 缺的三个 DOM 原语按既有 canvas 先例补齐）=====

const WEBP_BYTES = [0x89, 0x50, 0x4e, 0x47];

function stubCanvasPrimitives(): void {
  vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 2400, height: 1200 })));
  vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    drawImage: vi.fn(),
    measureText: vi.fn(() => ({ width: 0 }))
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(window.HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback: BlobCallback) => {
    callback(new Blob([new Uint8Array(WEBP_BYTES)], { type: "image/webp" }));
  });
}

interface FakeClipboardItem {
  kind: string;
  type: string;
  getAsFile: () => File | null;
}

function imageItem(type = "image/png"): FakeClipboardItem {
  return { kind: "file", type, getAsFile: () => new File([new Uint8Array([1, 2, 3])], "shot.png", { type }) };
}

function dispatchPaste(target: HTMLElement, items: FakeClipboardItem[]): Event {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items }, configurable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  ports.length = 0;
  providersPayload = [];
  settingsPayload = {};
  setupMock.openReaderAiSetup.mockReset();
  setupMock.openReaderAiSetup.mockResolvedValue(undefined);
  setupMock.openReaderTranscribeSettings.mockReset();
  stubCanvasPrimitives();
  await loadShell();
  stubChromeByType();
});

afterEach(async () => {
  window.dispatchEvent(new Event("resize"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("意图叶子（reader/chat-setup-resume）：单槽语义", () => {
  it("set → peek 副本 → consume 取走清空 → clear 作废", () => {
    const intent = {
      errorClass: "no-provider" as const,
      providerId: "",
      mode: "blocked" as const,
      contextKey: "BV1|1",
      conversationId: "conv-1",
      createdAt: 1
    };
    resumeLeaf.setChatSetupResumeIntent(intent);
    const peeked = resumeLeaf.peekChatSetupResumeIntent();
    expect(peeked).toEqual(intent);
    expect(peeked).not.toBe(intent);
    // 副本不反写内部状态
    peeked!.contextKey = "changed";
    expect(resumeLeaf.peekChatSetupResumeIntent()?.contextKey).toBe("BV1|1");
    // 一次性消费
    expect(resumeLeaf.consumeChatSetupResumeIntent()).toEqual(intent);
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();
    expect(resumeLeaf.consumeChatSetupResumeIntent()).toBeNull();
    // clear 作废未消费意图
    resumeLeaf.setChatSetupResumeIntent(intent);
    resumeLeaf.clearChatSetupResumeIntent();
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();
  });
});

describe("无平台空态：直达新增平台编辑器，保存后回对话聚焦输入区", () => {
  it("空态「前往设置」直达新增编辑器；保存成功退出设置、聚焦输入区、提示确认发送、不发送", async () => {
    await activateChat();
    const input = inputEl();
    const link = setupLink();
    expect(link, "无平台空态应渲染「前往设置」").not.toBeNull();

    clickElement(link);
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session, target] = capturedSetupSession();
    expect(errorClass).toBe("no-provider");
    expect(target).toBeUndefined();
    const intent = resumeLeaf.peekChatSetupResumeIntent();
    expect(intent).toMatchObject({ errorClass: "no-provider", providerId: "", mode: "blocked" });
    expect(intent?.contextKey).toBe(String(chatSessionState.currentContextKey || ""));
    expect(intent?.conversationId).toBe(String(chatSessionState.currentConversationId || ""));

    // 保存成功：平台已落盘 → 返回对话
    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
    const { openReaderSettingsMode } = await import("../../extension/reader/settings-mode.js");
    openReaderSettingsMode();
    expect(state.reader.readingSettingsExpanded).toBe(true);
    session.onAfterSave();

    await vi.waitFor(() => expect(noticeText()).toContain("平台已就绪，请确认发送"));
    expect(state.reader.readingSettingsExpanded, "保存成功后应退出设置抽屉").toBe(false);
    expect(document.activeElement, "应聚焦对话输入区").toBe(input);
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();
    // 不误自动发送：没有端口、没有用户气泡
    expect(ports).toHaveLength(0);
    expect(messagesEl().querySelector(".chat-msg-user")).toBeNull();
    // 配置后空态消失（初始态重渲）
    expect(setupLink()).toBeNull();
  });

  it("重复保存回调：返回事务只生效一次（不重复提示、不发送）", async () => {
    await activateChat();
    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
    session.onAfterSave();
    await vi.waitFor(() => expect(noticeText()).toContain("平台已就绪"));

    session.onAfterSave();
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(messagesEl().querySelectorAll(".chat-context-notice")).toHaveLength(1);
    expect(noticeText()).toContain("平台已就绪");
    expect(ports).toHaveLength(0);
  });
});

describe("发送前无平台：草稿与图片附件原位保留", () => {
  it("被拦截的草稿与图片附件留在原位；配置保存后提示确认发送，由用户再点一次才发出", async () => {
    await activateChat();
    const input = inputEl();
    const strip = imageStrip();

    // 先备好草稿与一张图片附件
    dispatchPaste(input, [imageItem()]);
    await waitFor(() => strip.querySelectorAll(".chat-image-item").length === 1);
    input.value = "请总结这个视频";

    sendEnter();
    // 配置类拦截屏（与空态同源）：出现「前往设置」动作，未发起端口
    await waitFor(() => setupLink() !== null);
    expect(ports).toHaveLength(0);
    expect(input.value, "被拦截的草稿应留在输入框").toBe("请总结这个视频");
    expect(strip.querySelectorAll(".chat-image-item"), "图片附件应留在附件区").toHaveLength(1);

    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session] = capturedSetupSession();
    expect(errorClass).toBe("no-provider");
    expect(resumeLeaf.peekChatSetupResumeIntent()?.mode).toBe("blocked");

    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
    session.onAfterSave();
    await vi.waitFor(() => expect(noticeText()).toContain("平台已就绪，请确认发送"));

    // 原位：草稿、附件、焦点都在对话里；仍未发送
    expect(input.value).toBe("请总结这个视频");
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(1);
    expect(document.activeElement).toBe(input);
    expect(ports).toHaveLength(0);

    // 用户再点一次发送：草稿与图片一起发出（不被返回事务代发）
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as {
      prompt?: string;
      images?: Array<{ mime: string }>;
    };
    expect(posted.prompt).toBe("请总结这个视频");
    expect(posted.images).toHaveLength(1);
    expect(strip.querySelectorAll(".chat-image-item")).toHaveLength(0);
  });
});

describe("已选平台缺 Key：错误回合直达该记录，不自动重发", () => {
  it("部分回复后的缺 Key 错误给直达动作；保存后保留错误回合与历史身份、不重发", async () => {
    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
    settingsPayload = { defaultModel: "p1" };
    await activateChat();
    const input = inputEl();
    const messages = messagesEl();

    input.value = "问一句";
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const conversationIdBefore = chatSessionState.currentConversationId;
    const turnPrompt = (ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt;
    expect(turnPrompt).toBe("问一句");

    // 部分回复后配置类错误：用户气泡已在屏上，回合未被受理进 history
    ports[0].__fire!({ type: "token", data: "半截回答" });
    ports[0].__fire!({ type: "error", error: MISSING_PROVIDER_KEY_MESSAGE });
    await waitFor(() => Boolean(messages.querySelector(".chat-msg-error")));
    expect(messages.querySelector(".chat-msg-error")?.textContent).toContain("该平台 API Key 未配置");
    expect(messages.querySelector(".chat-msg-user")?.textContent).toBe("问一句");

    // 错误回合给直达对应平台记录的动作
    const action = messages.querySelector<HTMLAnchorElement>(".chat-context-notice a");
    expect(action, "缺 Key 错误应给「前往设置」动作").not.toBeNull();
    expect(action?.textContent).toBe("前往设置");
    clickElement(action);
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session, target] = capturedSetupSession();
    expect(errorClass).toBe("missing-key");
    expect(target).toEqual({ providerId: "p1" });
    expect(resumeLeaf.peekChatSetupResumeIntent()).toMatchObject({
      errorClass: "missing-key",
      providerId: "p1",
      mode: "error"
    });

    // 保存成功：只回对话提示，不重发、不新建会话、不清历史身份
    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true, hasSavedKey: true }];
    session.onAfterSave();
    await vi.waitFor(() => expect(noticeText()).toContain("平台已就绪，请确认发送"));

    expect(ports, "不得自动重发：不新建端口").toHaveLength(1);
    expect(ports[0].postMessage, "不得自动重发：端口只发过原来那一条").toHaveBeenCalledTimes(1);
    expect(messages.querySelector(".chat-msg-user")?.textContent, "用户气泡应保留").toBe("问一句");
    expect(messages.querySelector(".chat-msg-error")?.textContent, "错误占位应保留").toContain(
      "该平台 API Key 未配置"
    );
    expect(chatSessionState.currentConversationId).toBe(conversationIdBefore);
    expect(document.activeElement).toBe(input);
  });

  it("非配置类回合错误：保持原错误语义，不给配置动作", async () => {
    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
    await activateChat();
    const input = inputEl();
    const messages = messagesEl();

    input.value = "问一句";
    sendEnter();
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);

    ports[0].__fire!({ type: "error", error: "网络连接失败" });
    await waitFor(() => Boolean(messages.querySelector(".chat-msg-error")));
    expect(messages.querySelector(".chat-msg-error")?.textContent).toContain("网络连接失败");
    // 网络错误不伪装成配置问题：没有「前往设置」动作、不记录返回意图
    expect(messages.querySelector(".chat-context-notice a")).toBeNull();
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();
    expect(setupMock.openReaderAiSetup).not.toHaveBeenCalled();
  });
});

describe("取消 / 换视频 / 关会话：返回意图作废", () => {
  it("取消编辑（onSessionEnd）：意图清空，迟到的保存回调不再有返回效果", async () => {
    await activateChat();
    const input = inputEl();
    input.value = "草稿仍在";
    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    session.onSessionEnd();
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();

    // 迟到回调（同一 session 被误触发）：无提示、无发送、草稿不动
    input.value = "草稿仍在";
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(noticeText()).toBe("");
    expect(ports).toHaveLength(0);
    expect(input.value).toBe("草稿仍在");
  });

  it("换视频：URL 变化即作废意图，保存回调不再提示", async () => {
    await activateChat();
    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();
    expect(resumeLeaf.peekChatSetupResumeIntent()).not.toBeNull();

    setLocationUrl("https://www.bilibili.com/video/BV1other0000/?biliscript_reader=1");
    window.dispatchEvent(new Event(BILISCRIPT_URL_CHANGE_EVENT));
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();

    providersPayload = [{ id: "p1", name: "平台一", model: "模型一", enabled: true }];
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(noticeText()).toBe("");
    expect(ports).toHaveLength(0);
  });

  it("关闭设置抽屉：意图随抽屉关闭作废", async () => {
    await activateChat();
    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();
    const { openReaderSettingsMode, closeReaderSettingsMode } = await import(
      "../../extension/reader/settings-mode.js"
    );
    openReaderSettingsMode();
    expect(resumeLeaf.peekChatSetupResumeIntent()).not.toBeNull();

    closeReaderSettingsMode({ restoreFocus: false });
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();

    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(noticeText()).toBe("");
    expect(ports).toHaveLength(0);
  });

  it("原意图变化（会话身份已换）：保存回调按快照校验作废，不在新会话上提示", async () => {
    await activateChat();
    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();
    const intent = resumeLeaf.peekChatSetupResumeIntent();
    expect(intent?.conversationId).toBeDefined();

    // 会话身份变化（历史项切换 / 新会话）：返回意图快照失配，保存回调静默作废
    const { applyConversationIdentity } = await import("../../extension/chat/chat-state.js");
    applyConversationIdentity({ id: "conv-other" });
    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(noticeText()).toBe("");
    expect(ports).toHaveLength(0);
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();
  });

  it("关闭对话会话：意图作废，重开后不自作主张提示或发送", async () => {
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session] = capturedSetupSession();

    chat.closeChatSession();
    expect(resumeLeaf.peekChatSetupResumeIntent()).toBeNull();

    session.onAfterSave();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(noticeText()).toBe("");
    expect(ports).toHaveLength(0);
  });
});

describe("模型选择器空态 / 已有平台 models: [] / 成功提示与防连点", () => {
  it("模型选择器空态「前往设置」走首配闭环并写入返回意图，保存后显示可关闭成功提示", async () => {
    await activateChat();
    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    clickElement(chip);
    const panelSettingsBtn = document.querySelector<HTMLButtonElement>(".chat-model-empty-settings");
    expect(panelSettingsBtn, "模型面板空态应渲染「前往设置」").not.toBeNull();

    clickElement(panelSettingsBtn);
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, session] = capturedSetupSession();
    expect(errorClass).toBe("no-provider");
    expect(resumeLeaf.peekChatSetupResumeIntent()).toMatchObject({ errorClass: "no-provider", mode: "blocked" });

    providersPayload = [{ id: "p1", name: "平台一", models: ["m1"], enabled: true }];
    session.onAfterSave();
    await vi.waitFor(() => expect(noticeText()).toContain("平台已就绪，请确认发送"));
    const notice = messagesEl().querySelector<HTMLElement>(".chat-context-notice");
    expect(notice?.classList.contains("is-success")).toBe(true);
    const closeBtn = notice?.querySelector<HTMLButtonElement>(".chat-notice-close") ?? null;
    expect(closeBtn).not.toBeNull();
    clickElement(closeBtn);
    expect(messagesEl().querySelector(".chat-context-notice")).toBeNull();
  });

  it("已有启用平台但 models 为空：直接渲染缺模型引导并定位该 providerId 编辑", async () => {
    providersPayload = [{ id: "p-empty", name: "空模型平台", models: [], enabled: true }];
    settingsPayload = { defaultModel: "p-empty" };
    await activateChat();

    expect(
      document.querySelector(`#${ids.readingChatModelChip} .chat-model-chip-model`)?.textContent
    ).toBe("未配置模型");
    expect(messagesEl().textContent).toContain("当前 AI 平台还没有配置可用模型");

    clickElement(setupLink());
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [errorClass, _session, target] = capturedSetupSession();
    expect(errorClass).toBe("missing-key");
    expect(target).toEqual({ providerId: "p-empty" });
    expect(resumeLeaf.peekChatSetupResumeIntent()).toMatchObject({
      errorClass: "no-model",
      providerId: "p-empty",
      mode: "blocked"
    });
  });

  it("快速双击防重入 & 旧会话 onSessionEnd 不清最新意图", async () => {
    await activateChat();
    let resolveFirst!: () => void;
    setupMock.openReaderAiSetup.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const link = setupLink();
    clickElement(link);
    clickElement(link);
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(1));
    const [, session1] = capturedSetupSession();
    resolveFirst();
    await new Promise((resolve) => setTimeout(resolve, 10));

    // 打开第二轮设置会话后，旧会话迟到的 onSessionEnd 不得误清第二轮刚写入的意图
    clickElement(link);
    await vi.waitFor(() => expect(setupMock.openReaderAiSetup).toHaveBeenCalledTimes(2));
    const intent2 = resumeLeaf.peekChatSetupResumeIntent();
    expect(intent2).not.toBeNull();

    session1.onSessionEnd();
    expect(resumeLeaf.peekChatSetupResumeIntent()).toEqual(intent2);
  });
});

