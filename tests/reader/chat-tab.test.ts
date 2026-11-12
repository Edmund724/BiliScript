// tests/reader/chat-tab.test.ts
// PR5 AI 对话 tab 组合根（reader/chat-tab.ts）回归测试：真实模板（ensureUiReady）
// + 二级惰性装载（reader/lazy-chat-tab）。
//
// 覆盖（验收清单）：
// - 组合根装配：懒加载边界（开壳不装载，首切对话 tab 才装载）、init 一次性
//   （重复激活幂等）、上下文装载 / 模型选择器 / 消息区初始态；
// - explain 意图消费：激活时 peek → 渲染引用卡（时间戳 pill）→ 自动发送解释
//   提示词 → 发送成功即 consume（一次意图只发一次）；取消按钮清意图；
// - subtitle-wait kick 总线接线：转写中发送被挂起（意图/输入保持 pending），
//   进程内相位 asr-done（subtitle-status-bus）驱动 kick 补轮放行，发出的是转写
//   完成后的完整字幕；asr 提示行随相位显隐；
// - 断流收口（工单 08）：closeChatSession 断 port + 退出流式 UI 态；关闭后发送
//   不再放行（不做后台续跑）；重开从会话历史恢复（恢复路径重渲 + 触发源重挂）；
// - 外点关闭单委托：popovers 的 handleDocumentClick 经 reader-bus 转发槽并入
//   ui-renderer 的单一文档级委托（点外关闭、点内不关），不双监听；
// - player-ai 快捷动作无损续问：空闲空会话/已有会话直接发送，忙碌或已有输入时
//   仅定位；连点单飞，关闭/换片使旧意图失效；不消费待解释意图。
// - 滚底按钮（DeepSeek Harness 同款）：显隐跟随机动（同一近底判据）、点一下
//   回底、回底动画途中的跟随闸与用户干预放闸、清场放闸。
//
// 模块纪元注意：chatSessionState 与组合根闭包都是模块级单例，beforeEach
// resetModules 后同纪元导入；chrome.storage / runtime 消息按 type 路由 stub。

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

// 热评编排已收口为 gateway.fetchHotCommentsWithLedger（arch-review-2026-09/07），
// context-assembly 静态 import——mock 保持确定性：接缝替身经 gatewayMock 的
// getCurrentAid/fetchHotComments 重演单源形状（落账不在本文件断言面），
// fetchHotComments 调用计数语义不变。
// gateway 拆叶（arch-slim-2/04）：bgFetchJson 已迁 gateway-core（经
// ai/context-resolver 被对话链消费）。
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
// 写纪律：身份三件套只经 chat-state 的意图级原语写（与被测模块同纪元）
let chatState: typeof import("../../extension/chat/chat-state.js");
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let statusBus: typeof import("../../extension/shared/subtitle-status-bus.js");

// 假 offscreen 端口（chat-runtime 经 chrome.runtime.connect 取用）
interface FakePort {
  name: string;
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (fn: (msg: unknown) => void) => void };
  onDisconnect: { addListener: (fn: () => void) => void };
}
const ports: FakePort[] = [];

// 平台列表（ai-providers-list 的响应源，用例内可变）与 storage.onChanged 监听
// 收集：模拟「设置抽屉新增平台 → SW 写 storage.sync.aiProviders → 存储事件派发
// 到 content」。beforeEach 复位。
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
  // storage.local = 共享内存面单源（写后可读回，三方法都是 vi.fn，调用记录照旧可断言）；
  // sync 面只记调用、不写盘——这些用例只断言 sync 写实参。
  chromeStub.storage.local = createMemoryStorageArea();
  chromeStub.storage.sync.set = vi.fn(async () => {});
  chromeStub.storage.onChanged.addListener = vi.fn((listener: StorageListener) => {
    storageListeners.add(listener);
  });
  chromeStub.storage.onChanged.removeListener = vi.fn((listener: StorageListener) => {
    storageListeners.delete(listener);
  });
}

// 等待异步链落定（轮询直到 predicate 成立或超时）——发送流程跨多层 await，
// 固定 sleep 对时序敏感，统一用条件轮询。
async function waitFor(predicate: () => boolean, { timeoutMs = 1000 } = {}): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor: condition not met within timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
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
    // reader 域 + 壳已就绪，对话 tab 未触达：二级惰性未装载
    expect(lazyChat.isReaderChatTabLoaded()).toBe(false);
    seedReadyContext();

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    expect(lazyChat.isReaderChatTabLoaded()).toBe(true);
    // init 时序落定后的装配断言：
    // - 平台列表加载（stub 提供一个启用平台）→ 模型选择器可用且选中
    const modelSelect = document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
    expect(modelSelect.disabled).toBe(false);
    // multi-model-catalog：选项值为「平台 id\u0001模型 id」复合值（选中回落首平台首模型）
    expect(modelSelect.value).toBe("p1\u0001模型一");
    // - 上下文装载（进程内直读 state.clip）→ 主上下文落到视频标题（标题不再上屏）
    expect(chatSessionState.contextData?.title).toContain("测试视频");
    const tools = document.querySelector(".biliscript-reading-tabs-tools")!;
    expect(Array.from(tools.children).map((node) => (node as HTMLElement).id)).toEqual([
      ids.readingChatNewBtn,
      ids.readingChatHistoryBtn,
      ids.readingChatMoreBtn,
      ids.readingChatMoreMenu
    ]);
    expect(document.querySelectorAll(".biliscript-reading-tab")).toHaveLength(3);
    expect(document.getElementById(ids.readingChatNewBtn)?.getAttribute("aria-label")).toBe("新建会话");
    expect(document.getElementById(ids.readingChatHistoryBtn)?.getAttribute("aria-label")).toBe("历史记录");
    expect(document.getElementById(ids.readingChatMoreBtn)?.getAttribute("aria-label")).toBe("显示设置");
    expect(document.getElementById(ids.readingChatMoreMenu)?.querySelector(`#${ids.readingChatNewBtn}`)).toBeNull();
    expect(document.getElementById(ids.readingChatMoreMenu)?.querySelector(`#${ids.readingChatHistoryBtn}`)).toBeNull();
    expect(document.getElementById(ids.readingChatDisplaySettingsBtn)?.textContent).toBe("更多显示设置");
    expect(document.getElementById(ids.readingChatLineHeight)).not.toBe(null);
    expect(document.getElementById(ids.readingChatParagraphSpacing)).not.toBe(null);
    expect(document.getElementById(ids.readingChatSpeechVolumeInput)).not.toBe(null);
    expect(document.getElementById(ids.readingChatSpeechVolumeResetBtn)).not.toBe(null);
    const volumeLabel = document.querySelector(`label[for="${ids.readingChatSpeechVolumeInput}"]`);
    expect(volumeLabel?.textContent).toBe("朗读音量");
    // - 初始态：无会话历史 → 空消息区 + 建议区（无居中错误）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(messages.querySelectorAll(".chat-center-error")).toHaveLength(0);
    expect(messages.querySelector(".chat-suggestions")).not.toBe(null);
  });

  it("首开初始化四路并行：平台列表被卡住时会话存档与 offscreen 确保已发起（opt-backlog-2026-09/05）", async () => {
    seedReadyContext();
    const chromeStub = window.chrome as unknown as { runtime: { sendMessage: Sendstub } };
    // 把平台列表响应关在 gate 后：并行实现下其余三路不等待它；串行实现下
    // 会话存档（storage.local.get）要等 providers 落定才会发起，本断言即失败。
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

    // 平台列表仍在 gate 后：offscreen 确保与会话存档必须已经发起。
    await waitFor(() =>
      chromeStub.runtime.sendMessage.mock.calls.some((call) => (call[0] as { type?: string })?.type === "ensure-offscreen-chat")
    );
    const storageGet = (window.chrome as unknown as { storage: { local: { get: Sendstub } } }).storage.local.get;
    await waitFor(() => storageGet.mock.calls.length > 0);

    releaseProviders(null);
    await activation;
    expect(lazyChat.isReaderChatTabLoaded()).toBe(true);
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

// C5「defaultModel 直写收编」：模型选择变化的持久化原先在 change 监听里直写
// chrome.storage.sync（绕过 save-settings 的归一化与白名单、也不触发 SW 设置快照
// 失效），现改走既有 save-settings 通道（同 aiThinkingLevel / webSearchEnabled）。
// 断言面：出站消息 = save-settings{defaultModel}，且 sync 直写不再收到 defaultModel 键。
describe("模型选择变化的 defaultModel 落盘（C5 直写收编）", () => {
  async function activateWithModelSelect() {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const chromeStub = window.chrome as unknown as {
      runtime: { sendMessage: Sendstub };
      storage: { sync: { set: Sendstub } };
    };
    chromeStub.runtime.sendMessage.mockClear();
    chromeStub.storage.sync.set.mockClear();
    const modelSelect = document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
    return { chromeStub, modelSelect };
  }

  function directDefaultModelWrites(syncSet: Sendstub): unknown[][] {
    return syncSet.mock.calls.filter(([payload]) =>
      Object.prototype.hasOwnProperty.call((payload as Record<string, unknown>) ?? {}, "defaultModel")
    );
  }

  it("选中平台模型：发 save-settings{defaultModel: 裸平台 id}，sync 直写不再出现 defaultModel", async () => {
    const { chromeStub, modelSelect } = await activateWithModelSelect();

    modelSelect.value = "p1\u0001模型一";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));

    // 直写断言放前：旧实现下这里立刻红，红证据直接给出被直写的载荷
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(directDefaultModelWrites(chromeStub.storage.sync.set)).toEqual([]);
    await waitFor(() =>
      chromeStub.runtime.sendMessage.mock.calls.some(
        ([message]) =>
          (message as { type?: string })?.type === "save-settings" &&
          (message as { settings?: { defaultModel?: unknown } })?.settings?.defaultModel === "p1"
      )
    );
    // 进程内镜像同趟更新（noteDefaultModelChoice 语义不变）
    expect(chatSessionState.aiPrefs.defaultModel).toBe("p1");
  });

  it("清空选择：同路写回空串，sync 直写不再出现 defaultModel", async () => {
    const { chromeStub, modelSelect } = await activateWithModelSelect();

    modelSelect.value = "";
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(directDefaultModelWrites(chromeStub.storage.sync.set)).toEqual([]);
    await waitFor(() =>
      chromeStub.runtime.sendMessage.mock.calls.some(
        ([message]) =>
          (message as { type?: string })?.type === "save-settings" &&
          (message as { settings?: { defaultModel?: unknown } })?.settings?.defaultModel === ""
      )
    );
    expect(chatSessionState.aiPrefs.defaultModel).toBe("");
  });
});

describe("explain 意图消费（自动发送 + consume 一次）", () => {
  it("激活时渲染引用卡并自动发送解释提示词，发送成功即 consume", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({ from: 10, content: "第二句话待解释", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    // 自动发送：解释提示词发出（offscreen 端口一条 chat 消息），提示词自带
    // 引用句与时间戳 pill 文案
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { action?: string; prompt?: string };
    expect(posted.action).toBe("chat");
    expect(posted.prompt).toContain("第二句话待解释");
    expect(posted.prompt).toContain("0:10"); // arch-slim-2/08 拍板 Q1：不补零
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    // 受理的副作用（不是受理判据）：受理结论来自 sendMessage 的 SendVerdict，
    // 下方 consumePendingExplainIntent 断言才是受理信号。
    expect(input.value).toBe("");

    // 发送成功即消费：一次意图只发一次，引用卡随之隐藏
    expect(explainIntent.consumePendingExplainIntent()).toBe(null);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);

    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(1); // 无新意图：不再发送
  });

  it("引用卡取消按钮：清意图 + 隐卡（不自动发送）", async () => {
    // 无字幕收尾（empty 且字幕体为空）：发送被 no-subtitle 闸拦下，意图保持
    // pending、引用卡可见——取消按钮在此状态清意图。
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "empty";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 5, content: "待取消句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await waitFor(() => Boolean(document.querySelector(".chat-input-card .chat-context-notice")));
    expect(ports).toHaveLength(0); // 发送被拦截
    const intentCard = document.getElementById(ids.readingChatIntent) as HTMLElement;
    expect(intentCard.hidden).toBe(false);

    // 容器层委托：对话 tab 根节点上的 [data-chat-intent-action] 点击
    const cancelBtn = intentCard.querySelector("[data-chat-intent-action='cancel']") as HTMLButtonElement;
    cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
    expect(intentCard.hidden).toBe(true);
    expect(ports).toHaveLength(0); // 取消不触发发送
  });

  // 实证 bug（受理窗口漏判 + ignored 被折算成受理）：发送流程停在发送闸的 await
  // 窗口（端口未建、用户消息尚未上屏）时再激活对话 tab，旧判据
  // isStreaming() || hasPendingUserPrompt() 判「空闲」→ autoSendPrompt 走
  // sendViaInputBox → sendTurn 返回 ignored 却被 `verdict !== "blocked"` 折算成
  // 受理成功 → 解释意图被消费、消息从未发出（引用卡消失、时间轴上什么都没有）。
  // 修法两条同时生效：在途判据收成含受理窗口的一条 + 只有 accepted 才算受理。
  // 修后行为：窗口内不消费（意图留 pending、引用卡保留），回合落定后激活补发。
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

    // 用户先按回车：受理停在 subtitle-wait（受理窗口内，端口未建、未上屏）
    input.value = "闸中问题";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(ports).toHaveLength(0);

    // 窗口内再激活（走意图消费路径）：不消费意图、不误报受理
    explainIntent.setPendingExplainIntent({ from: 10, content: "待解释句", createdAt: Date.now() });
    await chat.ensureChatTabActivated();
    expect(ports).toHaveLength(0);
    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(false);

    // 闸放行：先发出的是闸里那条，不是解释提示词
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");
    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    expect((ports[0].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toBe("闸中问题");

    // 第一回合终态落定后再次激活：pending 意图这次真正发出并消费（该发出就发出）
    (ports[0] as FakePort & { __fire: (msg: unknown) => void }).__fire({ type: "done" });
    await chat.ensureChatTabActivated();
    await waitFor(() => ports.length === 2 && ports[1].postMessage.mock.calls.length === 1);
    expect((ports[1].postMessage.mock.calls[0][0] as { prompt?: string }).prompt).toContain("待解释句");
    expect(explainIntent.peekPendingExplainIntent()).toBe(null);
  });
});

describe("subtitle-wait kick 总线接线", () => {
  it("转写中发送被挂起；asr-done 相位驱动 kick 放行并发完整字幕", async () => {
    // 转写中：subtitleFetchState loading + 字幕体为空
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 30, content: "转写中句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    // 模块求值即启动 init（bootstrap）；显式激活共享同一次 init promise
    const activation = chat.ensureChatTabActivated();

    // 转写相位（进程内总线；content script 收不到自己的广播）→ 提示行显示
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    const asrNotice = document.getElementById(ids.readingChatAsrNotice) as HTMLElement;
    expect(asrNotice.hidden).toBe(false);
    expect(chatSessionState.asrTranscribingActive).toBe(true);

    // 发送被 subtitle-wait 挂起：未发起 port，意图保持 pending；
    // 等待提示并入转写状态行（合成一句，消息区不再另起 .chat-context-notice）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(asrNotice.textContent?.includes("完成后自动开始总结")));
    expect(ports).toHaveLength(0);
    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
    expect(messages.querySelector(".chat-context-notice")).toBeNull();

    // 转写完成（字幕落账 + 相位 asr-done）→ kick 补轮放行
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    statusBus.publishSubtitleStatusPhase("asr-done");

    await waitFor(() => ports.length === 1 && ports[0].postMessage.mock.calls.length === 1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; context?: { subtitleBody?: unknown[] } };
    expect(posted.prompt).toContain("转写中句");
    expect(posted.context?.subtitleBody).toHaveLength(1); // 转写完成后的完整字幕
    expect(explainIntent.consumePendingExplainIntent()).toBe(null);
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
    // 等待提示清理 + asr 提示行收起
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(asrNotice.hidden).toBe(true);
    await activation;
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

    // 转写相位广播（同步分发）：等待卡继续显示，状态行转入转写文案
    statusBus.publishSubtitleStatusPhase("asr-transcribing");
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    expect(asrNotice.hidden).toBe(false);

    // 收尾：转写完成 → kick 补轮放行
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
    // 抓取中：subtitleFetchState loading + 字幕体为空，相位 idle（非转写）
    state.clip.title = "测试视频";
    state.clip.bvid = "BV1test000000";
    state.clip.cid = "101";
    state.clip.subtitleFetchState = "loading";
    state.clip.subtitleBody = [];
    explainIntent.setPendingExplainIntent({ from: 20, content: "抓取中句", createdAt: Date.now() });

    const chat = await lazyChat.ensureReaderChatTab();
    // 不 await 激活：发送卡在等待中，activate 到放行才落定（同上例时序）
    const activation = chat.ensureChatTabActivated();

    // 输入区显示等待卡；转写状态行不亮（无字幕/转写只属转写场景）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(document.querySelector(".chat-subtitle-wait")?.textContent).toContain("正在等待字幕");
    expect((document.getElementById(ids.readingChatAsrNotice) as HTMLElement).hidden).toBe(true);

    // 抓取完成 → 轮询放行（无相位广播可 kick，等一轮 4s 轮询），通知清理
    state.clip.subtitleFetchState = "ready";
    state.clip.subtitleBody = [{ from: 0, to: 10, content: "大家好" }];
    await waitFor(() => ports.length === 1, { timeoutMs: 6000 });
    expect(messages.querySelector(".chat-context-notice")).toBeNull();
    await activation;
  });
});

describe("发送前主动起跑字幕抓取（抓取未起跑的 idle 窗口不再发空上下文）", () => {
  it("字幕体为空且抓取尚未起跑：主动触发一轮抓取，抓取落定前不发提示词", async () => {
    // 用户报障形态：有字幕的视频点 AI 键，面板打开后的后台抓取还在等播放器
    // 元数据（subtitleFetchState 仍是 idle、字幕体为空），等待闸判「非 pending」
    // 直接放行 → 空字幕上下文发给模型，只能得到凭标题编造「无公开字幕」的总结。
    const readerBus = await import("../../extension/reader/reader-bus.js");
    let resolveFetch: () => void = () => {};
    const refreshSpy = vi.fn(() => {
      // refreshClip 的同步前缀：起跑即写 loading（首个 await 之前）
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

    // 发送路径主动起跑（本套件里 spy 是 reader-bus 的首个 handler）
    await waitFor(() => refreshSpy.mock.calls.length === 1);
    // 抓取挂起期间提示词不发：未开 port，输入区显示等待卡
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => document.querySelector<HTMLElement>(".chat-subtitle-wait")?.hidden === false);
    expect(document.querySelector(".chat-subtitle-wait")?.textContent).toContain("正在等待字幕");
    expect(ports).toHaveLength(0);

    // 抓取落定 → kick 补轮放行（不必真等一轮 4s 轮询）
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
    expect(posted.context?.subtitleBody).toHaveLength(1); // 发出的是抓取后的完整字幕
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
    expect(ports).toHaveLength(1); // 非视频页对话照常发出
  });

  it("快照落后于 state（另一轮抓取刚落账）：不重复起跑抓取，按最新 state 发送", async () => {
    // 上下文载荷在拉热评之前组装（core/context-assembly），热评那次网络往返期间
    // 落账的字幕不在快照里。若按快照判定就会多起一轮抓取——那一轮把刚落账的
    // 抓取顶成 STALE_RUN，它的终态文案（状态行「抓取完成…」）随之丢失，状态行
    // 停在「正在获取可用字幕...」而字幕列表其实已经填好（用户报障的形态）。
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

    // 让本轮全量装配读到「无字幕体 + idle」：签名对不上 → 走全量；载荷组装在
    // 热评往返之前，字幕在这段往返里落账（另一轮抓取刚完成）。
    if (chatSessionState.liveContextData) {
      // 快照嵌套字段在公开只读面内（ADR-0005），测试布置前置状态走测试把手。
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
    expect(refreshSpy).not.toHaveBeenCalled(); // 不重复起跑（旧判定在这里会起第二轮）
    expect(posted.context?.subtitleBody).toHaveLength(1); // 发的是已落账的字幕
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

    // 流式中：发送键切换为停止键形态（is-stop）；输入框不禁用（等待期间可继续打字）
    const sendBtn = document.getElementById(ids.readingChatSendBtn) as HTMLButtonElement;
    expect(sendBtn.classList.contains("is-stop")).toBe(true);
    expect(input.disabled).toBe(false);

    chat.closeChatSession();

    expect(ports[0].disconnect).toHaveBeenCalledTimes(1);
    expect(sendBtn.classList.contains("is-stop")).toBe(false);

    // 关闭后发送不再放行（不做后台续跑）：subtitle-wait 轮询闸住，无新 port
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
    setLocationUrl(url);
    window.dispatchEvent(new Event("biliscript:urlchange"));
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

    // 恢复路径重渲消息区（关闭后残留的失败/半截节点清场）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(messages.querySelector(".chat-center-error")).toBeNull();
    expect(messages.querySelector(".chat-suggestions")).not.toBe(null);
    // 触发源重挂：相位总线又能驱动 asr 提示行（转写中判定要求字幕体为空，
    // 临时切 loading 空体模拟转写窗口）
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
    const modelSelect = document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
    expect(modelSelect.value).toBe("p1\u0001模型一");

    chat.closeChatSession();

    // 关闭期间（设置抽屉在会话关闭态下新增平台）：存储事件已无订阅者，
    // 恢复路径必须自己重取平台列表。
    const next = [
      { id: "p1", name: "平台一", model: "模型一", enabled: true },
      { id: "p2", name: "平台二", models: ["模型二"], enabled: true }
    ];
    providerList = next;
    fireStorageChange({ aiProviders: { newValue: next, oldValue: [next[0]] } }, "sync");

    await chat.ensureChatTabActivated();

    expect(Array.from(modelSelect.options).map((option) => option.value)).toContain("p2\u0001模型二");
  });

  // 联网搜索授权被拒后闸侧关闭偏好（票 11）：既有对话开关与内存态经同一条
  // 「外部设置变更 → 刷新」路径同步，下一条消息不再重复询问。
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
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    // 激活流程会用会话存档覆盖 chatHistory：先激活载入 providers，再播入
    // 带工具轮的历史并触发回放（renderInitialState → renderConversationMessages）。
    applyConversationIdentity({ history: [
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
    ] });
    (await import("../../extension/reader/chat-tab.js")).renderInitialState();

    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(messages.querySelector(".chat-search-card")));
    const card = messages.querySelector(".chat-search-card") as HTMLElement;
    expect((card.querySelector(".chat-search-step-query") as HTMLElement).textContent).toBe("MoE 新进展");
    expect((card.querySelector(".chat-search-step-note") as HTMLElement).textContent).toBe("1 条");
    expect(card.querySelectorAll(".chat-search-source-row")).toHaveLength(1);
    // 头部 = 最近一条查询词 + 来源条数
    expect((card.querySelector(".chat-search-card-query") as HTMLElement).textContent).toBe("MoE 新进展");
    // 回放卡与 live 卡同构：默认折叠（重建一律回到折叠态，不落盘）
    expect(card.classList.contains("chat-search-card-collapsed")).toBe(true);
    expect(card.querySelector(".chat-search-card-head")!.getAttribute("aria-expanded")).toBe("false");
    expect((card.querySelector(".chat-search-card-status") as HTMLElement).textContent).toBe("1 条来源");
    // 回放卡同样可点击展开
    (card.querySelector(".chat-search-card-head") as HTMLElement).click();
    expect(card.classList.contains("chat-search-card-collapsed")).toBe(false);
    // tool 消息 JSON 不落正文；[n] 重建为内联引用
    expect(messages.textContent).not.toContain('{"title"');
    expect(messages.querySelectorAll("sup.chat-cite")).toHaveLength(1);
  });
});

describe("外点关闭单委托（reader-bus 转发槽并入 ui-renderer 文档级委托）", () => {
  it("点外关闭、点内不关；退出后焦点回历史入口，重复激活不双挂监听", async () => {
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
    expect(document.activeElement).toBe(historyBtn);
  });
});

describe("历史内容模式", () => {
  it("打开聚焦返回键；返回与 Esc 都恢复 hidden 并聚焦历史入口", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const historyBtn = document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement;
    const historyPage = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    const backBtn = document.getElementById(ids.readingChatHistoryBackBtn) as HTMLButtonElement;

    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(false);
    expect(historyBtn.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(backBtn);

    backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(true);
    expect(document.activeElement).toBe(historyBtn);

    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(true);
    expect(historyBtn.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(historyBtn);
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

  it("设置中唤起且有草稿：退出设置并定位，草稿原样保留且不发送", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    input.value = "尚未发送的草稿";
    const settingsMode = await import("../../extension/reader/settings-mode.js");
    settingsMode.openReaderSettingsMode();

    const accepted = await chat.runQuickActionPrompt("不得覆盖草稿");

    expect(accepted).toBe(false);
    expect(input.value).toBe("尚未发送的草稿");
    expect(state.reader.readingSettingsExpanded).toBe(false);
    expect((document.getElementById(ids.readingTabBodyChat) as HTMLElement).classList.contains("is-active")).toBe(true);
    expect(ports).toHaveLength(0);
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

  it("runQuickActionPrompt 被无字幕闸拦下：返回 false、无 port、输入框保留（受理结论来自返回值）", async () => {
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
    expect(input.value).toBe("整理这期视频的内容，输出结构化总结。");
  });

  it("快捷动作不消费待解释意图（与解释自动发送互不踩踏）", async () => {
    seedReadyContext();
    explainIntent.setPendingExplainIntent({ from: 3, content: "挂起句", createdAt: Date.now() });
    const chat = await lazyChat.ensureReaderChatTab();

    await chat.runQuickActionPrompt("总结提示词");

    expect(explainIntent.peekPendingExplainIntent()).not.toBe(null);
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toBe("总结提示词");
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

  // 每条消息后都越过 50ms 预算：让出路径（jsdom 无 scheduler → setTimeout 0
  // 兜底）逐条走一遍，把「一次同步 append」与「分片 append」的差异放大到可观测。
  function forceYieldEveryMessage(): void {
    let clock = 0;
    nowSpy = vi.spyOn(performance, "now").mockImplementation(() => {
      clock += 60;
      return clock;
    });
  }

  // 存档一条匹配当前上下文的会话（bvid/cid 与 seedReadyContext 一致），
  // init 的 restoreLatest 命中后走历史回放路径。
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
    // 记录 scrollTop 写入次数：分片期间不应滚动，末尾统一收尾恰一次。
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

    // 分片证据：激活返回时回放尚未跑完（旧同步实现此处已全部上屏）。
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
    // 全部上屏后才滚底（且恰一次）：末条 append 与收尾滚动之间还有一次让出，
    // 故按 scrollWrites 计数等收尾落定，而不是按消息条数。
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

    // 回放尚未完成（首片之后即让出）就回车发送
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
    // 新用户消息在回放内容之后，助手占位紧随其后
    expect(texts[REPLAY_MESSAGES.length]).toBe("回放中的新问题");
    expect(texts[REPLAY_MESSAGES.length + 1]).toBe("");
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string; history?: unknown[] };
    expect(posted.prompt).toBe("回放中的新问题");
  });
});

// ===========================================================================
// 在途回合点历史项（C′：先体面停流落盘、再切换）
// ---------------------------------------------------------------------------
// 缺陷（W3）：流式中点历史项 → applyById 直接切走视图（回放清场）→ 在途流继续
// 写脱离 DOM 的旧节点，终态又因 store 身份守卫（isCurrent）被丢弃 → 一问一答
// 双双消失、此后发送还被双发闸判 ignored（静默窗口）。修法：历史项点击路径在
// store.applyById 之前先 await runtime.settleActiveTurn()——先停流并让 stopped
// 终态把在途一问一答写回**原**会话，落定后才切换。拆除类入口（删除/清空/
// 新对话/关闭）不走本接缝，维持有意拆除语义。
// ===========================================================================
describe("在途回合点历史项（C′：先体面停流落盘、再切换）", () => {
  // 同一视频下的两条会话（contextKey 与 seedReadyContext 的 bvid/cid 一致）：
  // restoreLatest 命中第一条 A → 激活后当前会话 = A；B 供历史项点击切换。
  // 两条同 contextKey 是真实形态（同一视频多个会话），也让 apply(B) 走 live
  // 命中分支、不触发 pinned 补水网络路径。
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

    clickHistoryOpen(historyList, "conv-b");
    await waitFor(() => stopRequests(ports[0]).length === 1);
    // 停流尚未落定：不切换（仍在 A，A 的流式内容还在屏上）
    expect(chatSessionState.currentConversationId).toBe("conv-a");
    expect(messages.textContent).toContain("原会话的新问题");

    // stopped 终态：endStream 六步 + commitAssistantTurn 在身份未换前写回 A
    firePort(ports[0], { type: "stopped", reason: "已停止生成" });
    await waitFor(() => chatSessionState.currentConversationId === "conv-b");

    // 原会话一问一答（含 partial 正文）写回存档
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
    // 且已落盘（persistCurrent → saveConversations 的 storage 写）
    const chromeStub = window.chrome as unknown as {
      storage: { local: { set: ReturnType<typeof vi.fn> } };
    };
    const writes = chromeStub.storage.local.set.mock.calls
      .map((call) => (call[0] as Record<string, unknown>).biliscript_ai_conversations_v1)
      .filter(Boolean) as Array<Array<{ id: string; messages: Array<{ content: string }> }>>;
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[writes.length - 1].find((item) => item.id === "conv-a")!.messages.map((m) => m.content))
      .toContain("部分正文");

    // 切换后回放的是目标会话 B
    await waitFor(() => messages.textContent!.includes("B 的历史答案"));
    expect(messages.textContent).not.toContain("部分正文");
    expect(messages.textContent).not.toContain("原会话的新问题");
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

    // 无在途回合：settle 立即兑现，applyById 不留一拍（与旧实现逐点一致）
    expect(chatSessionState.currentConversationId).toBe("conv-b");
    expect(ports).toHaveLength(0);
    expect(document.activeElement).toBe(document.getElementById(ids.readingChatInput));
  });

  it("拆除类入口（流式中删除当前会话）：走既有断连路径、不发 stop（不触发 settle）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const { messages, input, historyList } = els();

    // 第一条：跑完一轮把会话落进存档（当前会话才有历史项与删除键）
    input.value = "第一问";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 1);
    firePort(ports[0], { type: "token", data: "第一答" });
    firePort(ports[0], { type: "done" });
    await waitFor(() => chatSessionState.savedConversations.length === 1);
    const currentId = chatSessionState.currentConversationId;

    // 第二条：流式中删除当前会话——拆除事务有意断流，不经 settle 接缝
    input.value = "第二问";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await waitFor(() => ports.length === 2);

    const removeBtn = historyList.querySelector(`.chat-history-remove[data-id="${currentId}"]`);
    expect(removeBtn).not.toBe(null);
    removeBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => chatSessionState.currentConversationId === "");

    // 无 stop 请求（settle 未被触发）；断流走 resetStreamState 的 disconnect
    expect(stopRequests(ports[1])).toHaveLength(0);
    expect(ports[1].disconnect).toHaveBeenCalledTimes(1);
    // 视图按拆除语义重建（在途用户消息被清掉）
    expect(messages.querySelector(".chat-msg-user")).toBe(null);
  });
});

// ===========================================================================
// 外部设置变更（refreshProviders）与在途回合
// ---------------------------------------------------------------------------
// 守卫从 isStreaming() 换成 isTurnActive()（含「已受理、端口未建」的在途窗口），
// 且历史列表刷新提到守卫之前——在途只推迟视图重建，不动历史列表。
// ===========================================================================
describe("外部设置变更与在途回合（refreshProviders 守卫）", () => {
  // 把 ensure-offscreen-chat 关在 gate 后：发送流程停在 connectPort 之前——
  // hasPendingUserPrompt 已置位、isStreaming() 仍为假（在途未流式窗口）。
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
    expect(ports).toHaveLength(0); // 未起流：停在 connectPort 之前

    seedSavedConversationForList("conv-x", "设置变更后可见");
    expect(historyList.textContent).not.toContain("设置变更后可见");
    const innerBefore = messages.innerHTML;

    fireStorageChange({ aiProviders: { newValue: [], oldValue: [] } }, "sync");
    await waitFor(() => historyList.textContent!.includes("设置变更后可见"));

    // 在途：视图不重建（消息区原样），历史列表已照刷
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
    await waitFor(() => ports.length === 1); // 已起流

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

    // 宽度写在模型 chip 上（隐藏 select 只是值源）：清空后触发 resize 合帧重算
    const chip = document.getElementById(ids.readingChatModelChip) as HTMLElement;
    chip.style.width = "";

    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));

    // 合帧：帧回调执行前不写宽度（旧同步实现此处已是 92px）。
    expect(chip.style.width).toBe("");

    await waitFor(() => chip.style.width !== "");
    // jsdom canvas 降级 8px/字符：模型名「平台一·模型一」7 字符 + 档位 Default 7 字符
    // → 56 + 56 + 44 = 156，与直接调用 updateModelSelectWidth 同结果
    // （出厂默认 = `default`（不干预），chip 写 Default；2026-10-05 用户裁定前写的是 Off 3 字符）。
    // tests/ui/model-select-width.test.ts 另锁「一帧至多一帧」的合帧计数与 [92, 420] 区间。
    expect(chip.style.width).toBe("156px");
  });
});

describe("无平台空态「前往设置」（arch-slim-2/06 死绑定回归 + 票 03 直达）", () => {
  it("后建链接经 #readingChatRoot 容器委托直达新增 AI 平台编辑器", async () => {
    // 无平台：ai-providers-list 返回空列表 → renderInitialState 走「还没有配置
    // AI 平台」分支，「前往设置」链接由 resetConversationView 用 innerHTML 后建。
    // 历史缺陷：ui-renderer 曾在壳构建时 getElementById 直绑——绑定时点早于
    // 元素诞生，监听器永远挂不上，无平台空态点「前往设置」无任何效果。
    // 票 03：点击不再只开设置抽屉，而是直达新增 AI 平台编辑器（首配「保存并继续」）。
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

    // 无平台空态已渲染：链接存在（后建于消息区），设置抽屉此前关闭
    const link = document.getElementById(ids.readingChatOpenSettings) as HTMLAnchorElement | null;
    expect(link).not.toBe(null);
    const settingsPanel = document.getElementById(ids.readingSettingsPanel) as HTMLElement;
    expect(settingsPanel.hidden).toBe(true);
    expect(state.reader.readingSettingsExpanded).toBe(false);

    // 容器委托命中（冒泡到 #readingChatRoot）：展开设置并直达新增平台编辑器
    // （编辑器 chunk 动态装载，全量套件并发下放宽等待上限）。
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitFor(() => document.querySelector(".provider-editor-dialog") !== null, { timeoutMs: 5000 });
    expect(state.reader.readingSettingsExpanded).toBe(true);
    expect(
      document.querySelector(".provider-editor-dialog .provider-editor-title")?.textContent
    ).toBe("添加AI 平台");
    // 收尾：关编辑器（首配会话回调由本文件不关心的装配方持有）
    const { closeProviderEditor } = await import("../../extension/ui/provider-editor.js");
    closeProviderEditor(true);
  });
});

// 输入框高度只随内容走（2026-11 用户决议：去掉「聚焦即展开两行」的两态设计，
// 点击聚焦不再撑高）：scrollHeight（内容自然高）写回 min-height，上限 320。
// 杠杆是 min-height 而非 height：主轴上 flex 项的 flex-basis:0% 让 height 失效
// （headless Chromium 实测行内 height 写了高度不变）。
describe("输入框高度：聚焦不撑高、只随内容走", () => {
  async function mountChat(): Promise<HTMLTextAreaElement> {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    return document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
  }

  it("聚焦/失焦都不写行内 min-height（空输入恒一行，高度落回 CSS 自然高）", async () => {
    const input = await mountChat();

    // 初始未聚焦：没有任何行内高度——单行高度由模板 rows=1 定
    expect(input.style.minHeight).toBe("");

    // 聚焦不再撑高：行内高依旧为空（空输入不测量，见 autosizeInput 的空值守卫）
    input.focus();
    expect(input.style.minHeight).toBe("");

    input.blur();
    expect(input.style.minHeight).toBe("");
  });

  it("内容长高、封顶 320", async () => {
    const input = await mountChat();
    input.value = "x";

    Object.defineProperty(input, "scrollHeight", { value: 140, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("140px");

    Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("320px");
  });

  it("删回单行：行内高跟着缩回自然高，不残留上次撑起的高", async () => {
    const input = await mountChat();
    input.value = "xxxxxxxx";

    Object.defineProperty(input, "scrollHeight", { value: 200, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("200px");

    // 删到单行：scrollHeight 塌回一行自然高（含 4px 内边距的 border-box 值）
    Object.defineProperty(input, "scrollHeight", { value: 56, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("56px");
  });

  it("未封顶 overflow-y hidden（两行边界不闪滚动条）；封顶 320 才放行 auto", async () => {
    const input = await mountChat();
    input.value = "x";

    // 两行整：内容高 ≈ 盒高，亚像素行高下 Chromium 会判 1px 溢出——必须 hidden
    Object.defineProperty(input, "scrollHeight", { value: 48, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("48px");
    expect(input.style.overflowY).toBe("hidden");

    // 封顶后超长文本必须滚得动
    Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("320px");
    expect(input.style.overflowY).toBe("auto");
  });

  it("空输入不写行内高：入场瞬时布局把 scrollHeight 读多大都不粘成巨盒", async () => {
    const input = await mountChat();

    // 空输入 + 任何 scrollHeight 读数（含瞬时拉伸读到的盒高）→ 行内高必须为空
    Object.defineProperty(input, "scrollHeight", { value: 260, configurable: true });
    input.focus();
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("");
    expect(input.style.overflowY).toBe("hidden");

    // 有内容才长高；再删空马上收回一行（程序化清空同样走 autosizeInput）
    input.value = "很长的一段文字";
    Object.defineProperty(input, "scrollHeight", { value: 120, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("120px");

    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("");
  });
});

// 「每敲一键就长高一行」bug（2026-11 用户报障）的 JS 侧回归。
//
// 真实浏览器的耦合（headless Chromium 实测，.scratch/input-autosize-probe）：
// textarea 是 content-box，`scrollHeight` 含 4px 上下内边距、`min-height` 不含，
// 于是「把 scrollHeight 写回 min-height」每次都被自己放大 4px；下一个 input 事件
// 再把放大后的高读回来 → 逐键 +4px，删除键同样 +4px（用户看到的「增长方向无关」）。
// 修复有两半，本文件锁 JS 那一半：**测量前先清空行内 min-height**，读到的才是内容
// 自然高（CSS 那一半 = border-box 让两个量同坐标系，见
// tests/reader/chat-input-autosize.test.ts）。
// 下方 getter 逐字复刻上述耦合：行内有值时 scrollHeight = 行内值 + 内边距，
// 没有时才是内容自然高——这正是浏览器里那面「把自己读回来」的镜子。
describe("输入框自适应高度：逐键回写不得被自己放大", () => {
  const PADDING = 4;

  async function mountAutosizingInput(): Promise<HTMLTextAreaElement> {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    // 内容自然高：单行 52，每满 10 字换一行 +21.75（约 line-height: 1.45 × 15px）。
    const naturalContentHeight = () => 52 + Math.floor(input.value.length / 10) * 21.75;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => {
        const inline = Number.parseFloat(input.style.minHeight || "0");
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

    // 五个字仍在单行内：高度必须稳在单行自然高（border-box 后 52 + 4 = 56）
    expect(input.style.minHeight).toBe("56px");
  });

  it("删除逐字退格：长内容删除后高度跟着缩回，不朝反向继续长", async () => {
    const input = await mountAutosizingInput();

    // 先敲够三行（30 字），让内容自然高越过单行
    for (let i = 0; i < 30; i += 1) {
      typeChar(input, "d");
    }
    const grown = Number.parseFloat(input.style.minHeight);
    expect(grown).toBeGreaterThan(56);

    // 再删到只剩一行
    for (let i = 0; i < 25; i += 1) {
      input.value = input.value.slice(0, -1);
      input.dispatchEvent(new Event("input"));
    }

    // 剩 5 字 → 回到单行：高度必须缩回单行自然高，而不是比 grown 更高
    expect(input.style.minHeight).toBe("56px");
  });

  it("内容真的变长时仍然长高并封顶 320（屏上盒高，不再多出内边距）", async () => {
    const input = await mountAutosizingInput();

    for (let i = 0; i < 200; i += 1) {
      typeChar(input, "d");
    }

    expect(input.style.minHeight).toBe("320px");
  });
});

// 滚底按钮（DeepSeek Harness 同款）：离开消息区底部即出现，点一下回到底部。
//
// 按钮显隐与自动滚动共用同一条近底判据（chat-notices 的 isMessagesNearBottom），
// 所以这一组断言盯的是「按钮 ↔ 跟随」同一个布尔的两面：上翻时一起关、回底时一起
// 开；阈值也只此一处（不另立数字），否则会出现「按钮亮着但流式还在拽」。
// 回底闸的三条边界各占一例：动画途中不判死跟随、动画途中用户自己滚了就放闸、
// 清场必须放闸（内容短的清场不产生 scroll 事件）。
describe("消息区滚底按钮：显隐跟随机动、点一下回底", () => {
  const SCROLL_HEIGHT = 1000;
  const CLIENT_HEIGHT = 300;
  // 近底跟随阈值 40px，回底浮钮显现阈值 120px（双阈值迟滞）
  const FOLLOW_THRESHOLD_PX = 40;
  const BUTTON_THRESHOLD_PX = 120;

  // 帧合批的手动推进：滚动判定与 token flush 都排 rAF，同帧多条只判定一次，
  // 用例要能逐帧推进才看得到中间态（动画途中）。
  function captureRaf(): { flush: () => void; restore: () => void } {
    const queue: FrameRequestCallback[] = [];
    const spy = vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      queue.push(cb);
      return queue.length;
    });
    return {
      flush: () => {
        // 帧回调可能再排帧（flush → 下一帧），跑到空；上限防意外自排死循环。
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
    // jsdom 无布局：手工造出「能滚」的测量值。scrollTo 补成真实浏览器那样（带行为
    // 地写 scrollTop），否则 instant 滚动分支（typeof scrollTo === "function"）
    // 在 jsdom 里落空，断言的不是同一条代码路径。
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

  // 用户滚动：写位置 + 派发 scroll（jsdom 不自发 scroll 事件）
  function userScrollTo(messages: HTMLElement, top: number): void {
    messages.scrollTop = top;
    messages.dispatchEvent(new Event("scroll"));
  }

  it("模板挂位与初态：挂在 footer 内、默认 hidden（底部时没有入口）", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const btn = document.getElementById(ids.readingChatScrollBottomBtn) as HTMLButtonElement;
    // 挂在 footer（position:relative）而非消息区：消息区是滚动容器，绝对定位的
    // 子节点会随内容滚走。footer 的 flex 布局里它是绝对定位（第一个子节点），
    // 不挤占输入卡的行位。
    const footer = btn.parentElement as HTMLElement;
    expect(footer.classList.contains("chat-footer")).toBe(true);
    expect(Array.from(footer.children).indexOf(btn)).toBe(0);
    expect(btn.hidden).toBe(true);
    expect(btn.getAttribute("aria-label")).toBe("回到底部");
    // chevron-down 图标（装饰，随 svg 的 aria-hidden）
    expect(btn.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(btn.querySelector("svg path")?.getAttribute("d")).toBe("m6 9 6 6 6-6");
  });

  it("双阈值迟滞：40px 内跟随且不显按钮，40px~120px 间不显按钮，>120px 按钮亮起，回底退场", async () => {
    const { messages, btn } = await mountScrolledChat();
    const raf = captureRaf();
    try {
      // 距底 40px（跟随阈值边界）：按钮不亮
      userScrollTo(messages, SCROLL_HEIGHT - CLIENT_HEIGHT - FOLLOW_THRESHOLD_PX);
      raf.flush();
      expect(btn.hidden).toBe(true);

      // 距底 80px（处于 40px~120px 迟滞带）：按钮仍不亮（防止边缘抖动）
      userScrollTo(messages, SCROLL_HEIGHT - CLIENT_HEIGHT - 80);
      raf.flush();
      expect(btn.hidden).toBe(true);

      // 距底 121px（超过 120px 浮钮阈值）：按钮亮起
      userScrollTo(messages, SCROLL_HEIGHT - CLIENT_HEIGHT - BUTTON_THRESHOLD_PX - 1);
      raf.flush();
      expect(btn.hidden).toBe(false);

      // 手动滚回底部：退场（恢复跟随）
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
      // 起一轮真流式：token 帧的滚动是「跟随还在不在」的唯一可观测出口
      input.value = "滚动测试";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await waitFor(() => ports.length === 1);
      userScrollTo(messages, 100);
      raf.flush();
      expect(btn.hidden).toBe(false);

      btn.click();
      expect(btn.hidden).toBe(true);

      // 动画途中：几何仍是「远离底部」
      userScrollTo(messages, 600);
      raf.flush();
      expect(btn.hidden).toBe(true);

      // 途中来一帧 token：跟随必须还在（无闸时这里会是 600）
      (ports[0] as FakePort & { __fire: (message: unknown) => void }).__fire({ type: "token", data: "正文一帧" });
      raf.flush();
      expect(messages.scrollTop).toBe(SCROLL_HEIGHT);

      // 落底：闸释放
      userScrollTo(messages, SCROLL_HEIGHT);
      raf.flush();
      // 释放后用户再上翻，按钮必须还能亮（闸没释放就永远不亮）
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

      // 动画途中用户上手：wheel / touchstart / keydown 任一都算滚动意图
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
      // 新会话是异步编排（取上下文 → 断流 → 清场）：塞一颗哨兵，等它被清掉才算
      // 真的走过 resetConversationView。
      const marker = document.createElement("div");
      marker.className = "chat-msg";
      messages.appendChild(marker);
      await waitFor(() => !messages.contains(marker));
      raf.flush();
      expect(btn.hidden).toBe(true);

      // 清场后上翻：闸已释放，按钮照常亮起
      userScrollTo(messages, 100);
      raf.flush();
      expect(btn.hidden).toBe(false);
    } finally {
      raf.restore();
    }
  });
});

// 集合站模型名显示（2026-10-06 用户报障，票据 chat-model-name-display/01）：ModelScope /
// OpenRouter 这类集合站回的模型 id 带组织命名空间前缀（`deepseek-ai/DeepSeek-V4.1-Flash`），
// 对话输入框里的 chip 与点开后的模型列表只显示裸名。本文件跑全链真实模块（providers 渲染
// select → 组合根装配 chip 与面板 → 点选写值源），末尾写出可复现工件；判据的另一半是
// **值源一个字不改**：option 文本、复合值与落盘选中值仍是完整 id（剥前缀渗到值源 = 换错模型）。
describe("模型名显示：集合站的 org 前缀只从显示层剥掉", () => {
  const SEP = String.fromCharCode(1);
  const PREFIXED = "deepseek-ai/DeepSeek-V4.1-Flash";

  // 工件里要看得见分隔符（\u0001 是不可见控制字符，直接落盘读不出边界）
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

  it("chip 与弹层条目剥前缀，option 文本、复合值与落盘选中值保持完整", async () => {
    providerList = [
      { id: "modelscope", name: "ModelScope", models: [PREFIXED, "Qwen/Qwen3-32B", "glm-4.6"], enabled: true }
    ];
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const select = document.getElementById(ids.readingChatModelSelect) as HTMLSelectElement;
    const chip = document.getElementById(ids.readingChatModelChip) as HTMLButtonElement;
    const chipModel = chip.querySelector(".chat-model-chip-model") as HTMLElement;
    const panelList = document.getElementById(ids.readingChatModelList) as HTMLElement;
    const steps: string[] = [];

    // 值源（providers 渲染的 option 文本）仍是完整 id：剥前缀只发生在展示层
    expect([...select.options].map((option) => option.textContent)).toEqual([PREFIXED, "Qwen/Qwen3-32B", "glm-4.6"]);
    expect(chipModel.textContent).toBe("ModelScope·DeepSeek-V4.1-Flash");
    expect(select.value).toBe(`modelscope${SEP}${PREFIXED}`);
    steps.push(`1 激活（首项 = ${PREFIXED}） | chip=${chipModel.textContent} | 值源=${shown(select.value)}`);

    // 点 chip 开面板：条目名剥前缀，data-value 与值源同口径（完整）
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

    // 点带前缀的第二项：chip 换裸名，选中值（含落盘那一份）仍是完整复合值
    clickModelOption(panelList, `modelscope${SEP}Qwen/Qwen3-32B`);
    const setMock = (window.chrome as unknown as { storage: { local: { set: ReturnType<typeof vi.fn> } } })
      .storage.local.set;
    expect(select.value).toBe(`modelscope${SEP}Qwen/Qwen3-32B`);
    expect(chipModel.textContent).toBe("ModelScope·Qwen3-32B");
    expect(setMock).toHaveBeenCalledWith({ [SELECTED_PROVIDER_KEY]: `modelscope${SEP}Qwen/Qwen3-32B` });
    steps.push(
      `3 点 Qwen/Qwen3-32B（带前缀） | chip=${chipModel.textContent} | 值源=${shown(select.value)} | 落盘=${shown(
        `modelscope${SEP}Qwen/Qwen3-32B`
      )}`
    );

    // 无斜杠裸名不受影响（防误伤）：带前缀的才是命名空间 id
    chip.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    clickModelOption(panelList, `modelscope${SEP}glm-4.6`);
    expect(select.value).toBe(`modelscope${SEP}glm-4.6`);
    expect(chipModel.textContent).toBe("ModelScope·glm-4.6");
    steps.push(`4 点 glm-4.6（无斜杠裸名） | chip=${chipModel.textContent} | 值源=${shown(select.value)}`);

    expect(steps).toHaveLength(4);
    const artifactDir = join(process.cwd(), ".scratch", "tickets", "chat-model-name-display", "artifacts");
    mkdirSync(artifactDir, { recursive: true });
    writeFileSync(
      join(artifactDir, "01-e2e-walkthrough.txt"),
      [
        "# 集合站模型名显示走查工件（由 tests/reader/chat-tab.test.ts 生成）",
        "# 用例：ModelScope 平台（模型 id 带 org 命名空间前缀）激活对话 tab → 看 chip → 开面板看条目名与 data-value → 点选换模型",
        "# 判据：chip 与弹层条目只显示裸名（剥最后一段斜杠之前的前缀）；option 文本、复合值（data-value / select.value）、",
        "#       落盘选中值仍是完整 id；无斜杠裸名不受影响。复合值里的 \\u0001 分隔符在工件里写作 <SEP>",
        "# 每行 = 一步；同命令重跑逐字节一致",
        ...steps,
        ""
      ].join("\n")
    );
  });
});
