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
// - 外点关闭单委托：popovers 的 handleDocumentClick 经 chat-tab-bridge 并入
//   ui-renderer 的单一文档级委托（点外关闭、点内不关），不双监听；
// - player-ai 快捷动作 seam（PR4b 概览笔记按钮同款）：runQuickActionPrompt =
//   定位对话 tab + startNewConversation + 填提示词 + 自动发送；不消费待解释
//   意图（互不踩踏）。
//
// 模块纪元注意：chatSessionState 与组合根闭包都是模块级单例，beforeEach
// resetModules 后同纪元导入；chrome.storage / runtime 消息按 type 路由 stub。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
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

let state: TestState;
let ids: typeof import("../../extension/reader/state.js").ids;
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");
let lazyChat: typeof import("../../extension/reader/lazy-chat-tab.js");
let explainIntent: typeof import("../../extension/reader/explain-intent.js");
let chatSessionState: typeof import("../../extension/chat/chat-state.js").chatSessionState;
// 写纪律：身份三件套只经 chat-state 的意图级原语写（与被测模块同纪元）
let chatState: typeof import("../../extension/chat/chat-state.js");
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
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
      local: { get: Sendstub; set: Sendstub };
      sync: { set: Sendstub };
      onChanged: { addListener: Sendstub; removeListener: Sendstub };
    };
  };
  chromeStub.runtime.sendMessage = vi.fn((message: { type?: string }, callback?: (resp: unknown) => void) => {
    const type = String(message?.type || "");
    if (type === "ai-providers-list") {
      callback?.({ ok: true, providers: providerList });
    } else if (type === "get-settings") {
      callback?.({ ok: true, settings: {} });
    } else {
      callback?.({ ok: true });
    }
    return undefined;
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
  chromeStub.storage.local.get = vi.fn(async () => ({}));
  chromeStub.storage.local.set = vi.fn(async () => {});
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
    // - 上下文装载（进程内直读 state.clip）→ 主上下文落到视频标题（标题不再上屏：
    //   头部标题 chip 已删，2026-10 用户决议）
    expect(chatSessionState.contextData?.title).toContain("测试视频");
    const header = document.querySelector(`#${ids.readingChatRoot} > .chat-header`);
    expect(Array.from(header!.children).map((node) => (node as HTMLElement).id)).toEqual([
      ids.readingChatHistoryBtn,
      ids.readingChatNewBtn
    ]);
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
    await waitFor(() =>
      Boolean((document.getElementById(ids.readingChatMessages) as HTMLElement).querySelector(".chat-context-notice"))
    );
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

  it("抓取等待中转入转写相位：消息区抓取通知立即清理，不闪两条同屏提示", async () => {
    // 抓取中（loading + 空字幕体）等待闸落一条「正在抓取字幕…」消息区通知；
    // 随后无字幕出口进入转写相位——若不清掉那条抓取通知，它会与转写状态行
    // 同屏显示（用户报障：一闪两条重复且不正确的提示），直到下一轮 4s 轮询。
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
    await waitFor(() => Boolean(messages.querySelector(".chat-context-notice")));
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("正在抓取字幕");
    expect(asrNotice.hidden).toBe(true);

    // 转写相位广播（同步分发）：抓取通知立即消失，只留转写状态行
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

  it("有字幕视频抓取中等待：消息区显示抓取文案，不误报音频转写", async () => {
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

    // 等待提示走消息区抓取文案；转写状态行不亮（无字幕/转写只属转写场景）
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(messages.querySelector(".chat-context-notice")));
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("正在抓取字幕");
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
    // 抓取挂起期间提示词不发：未开 port，等待提示走消息区抓取文案
    const messages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    await waitFor(() => Boolean(messages.querySelector(".chat-context-notice")));
    expect(messages.querySelector(".chat-context-notice")?.textContent).toContain("正在抓取字幕");
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

describe("外点关闭单委托（chat-tab-bridge 并入 ui-renderer 文档级委托）", () => {
  it("点外关闭 popover、点内不关；重复激活不双挂监听", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    await chat.ensureChatTabActivated(); // 重复激活不重复注册（注册槽覆盖语义）

    // 文档级 click 委托已由 ensureUiReady 首建时绑定（含对话 tab 外点转发）

    const historyBtn = document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement;
    const historyPopover = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    // dispatchEvent 恰好一次（setup 的 click 补丁会双触发，toggle 会开又关）
    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPopover.hidden).toBe(false);

    // 点击 popover 内部（冒泡到 document）：不关闭
    const historyList = document.getElementById(ids.readingChatHistoryList) as HTMLElement;
    historyList.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPopover.hidden).toBe(false);

    // 点击外部（冒泡到 document 的单一委托）：关闭
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPopover.hidden).toBe(true);
  });
});

describe("历史对话整页（返回键关闭）", () => {
  it("点返回键收起整页：hidden 回到 true，对话内容随之恢复显示", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();

    const historyBtn = document.getElementById(ids.readingChatHistoryBtn) as HTMLButtonElement;
    const historyPage = document.getElementById(ids.readingChatHistoryPopover) as HTMLElement;
    const backBtn = document.getElementById(ids.readingChatHistoryBackBtn) as HTMLButtonElement;

    historyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(false);

    backBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(historyPage.hidden).toBe(true);
  });
});

describe("player-ai 快捷动作 seam（PR4b 概览笔记按钮同款）", () => {
  it("runQuickActionPrompt：定位对话 tab + 自动发送快捷提示词", async () => {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();

    const accepted = await chat.runQuickActionPrompt("整理这期视频的内容，输出结构化总结。");

    expect(accepted).toBe(true);
    const tabBodyChat = document.getElementById(ids.readingTabBodyChat) as HTMLElement;
    expect(tabBodyChat.classList.contains("is-active")).toBe(true);
    const input = document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
    // 受理判据是上面的返回值 accepted；输入框清空只是受理副作用。
    expect(input.value).toBe("");
    expect(ports).toHaveLength(1);
    const posted = ports[0].postMessage.mock.calls[0][0] as { prompt?: string };
    expect(posted.prompt).toBe("整理这期视频的内容，输出结构化总结。");
  });

  it("runQuickActionPrompt 被无字幕闸拦下：返回 false、无 port、输入框保留（受理结论来自返回值）", async () => {
    // 无字幕收尾（empty 且字幕体为空）：发送闸 G6 拦截，sendMessage 返回 blocked
    // → sendViaInputBox 折算 false。旧实现靠「输入框是否被清空」推断，本用例把
    // 判据钉在返回值上：即使输入框残留，结论也只由 SendVerdict 决定。
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
    // jsdom canvas 降级 8px/字符：模型名「平台一·模型一」7 字符 + 档位 Off 3 字符
    // → 56 + 24 + 44 = 124，与直接调用 updateModelSelectWidth 同结果
    // （tests/ui/model-select-width.test.ts 另锁「一帧至多一帧」的合帧计数与
    // [92, 420] 区间）。
    expect(chip.style.width).toBe("124px");
  });
});

describe("无平台空态「前往设置」（arch-slim-2/06 死绑定回归）", () => {
  it("后建链接经 #readingChatRoot 容器委托打开设置抽屉", async () => {
    // 无平台：ai-providers-list 返回空列表 → renderInitialState 走「还没有配置
    // AI 平台」分支，「前往设置」链接由 resetConversationView 用 innerHTML 后建。
    // 历史缺陷：ui-renderer 曾在壳构建时 getElementById 直绑——绑定时点早于
    // 元素诞生，监听器永远挂不上，无平台空态点「前往设置」无任何效果。
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

    // 容器委托命中（冒泡到 #readingChatRoot）：展开设置并渲染面板
    link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(state.reader.readingSettingsExpanded).toBe(true);
    // renderReaderPanels 经 ui/reader-gate 异步装载 reader 域后写 hidden
    await waitFor(() => !settingsPanel.hidden);
  });
});

// 输入框高度两态（省空间改造）：未聚焦恒一行（模板 rows=1、无行内 min-height），
// 聚焦（有光标）才展开——下限两行、之上随内容长高、上限 320。杠杆是 min-height
// 而非 height：主轴上 flex 项的 flex-basis:0% 让 height 失效（headless Chromium
// 实测行内 height 写了高度不变）。
describe("输入框高度两态：未聚焦一行、聚焦才展开", () => {
  async function mountChat(): Promise<HTMLTextAreaElement> {
    seedReadyContext();
    const chat = await lazyChat.ensureReaderChatTab();
    await chat.ensureChatTabActivated();
    return document.getElementById(ids.readingChatInput) as HTMLTextAreaElement;
  }

  it("未聚焦不写行内 min-height（高度交回模板单行）；聚焦展开到两行下限；失焦收回", async () => {
    const input = await mountChat();

    // 初始未聚焦：没有任何行内高度——单行高度由模板 rows=1 定
    expect(input.style.minHeight).toBe("");

    // jsdom 无布局：scrollHeight 恒 0 → 落到聚焦下限（屏上两行 = 56，
    // border-box 后不再额外叠加 4px 内边距）
    input.focus();
    expect(input.style.minHeight).toBe("56px");

    input.blur();
    expect(input.style.minHeight).toBe("");
  });

  it("内容长高、封顶 320", async () => {
    const input = await mountChat();
    input.focus();

    Object.defineProperty(input, "scrollHeight", { value: 140, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("140px");

    Object.defineProperty(input, "scrollHeight", { value: 500, configurable: true });
    input.dispatchEvent(new Event("input"));
    expect(input.style.minHeight).toBe("320px");
  });

  it("非视频上下文：聚焦下限更小（屏上 48）", async () => {
    const input = await mountChat();
    (document.getElementById(ids.readingChatRoot) as HTMLElement).classList.add("chat-non-video-context");

    input.focus();
    expect(input.style.minHeight).toBe("48px");
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

  it("短输入逐字敲：盒高稳在聚焦下限，不逐键 +4px", async () => {
    const input = await mountAutosizingInput();

    for (let i = 0; i < 5; i += 1) {
      typeChar(input, "d");
    }

    // 五行文字仍在单行内：高度必须稳在聚焦下限（border-box 后 52 + 4 = 56）
    expect(input.style.minHeight).toBe("56px");
  });

  it("删除逐字退格：长内容删除后高度跟着缩回，不朝反向继续长", async () => {
    const input = await mountAutosizingInput();

    // 先敲够三行（30 字），让内容自然高越过聚焦下限
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

    // 剩 5 字 → 回到单行：高度必须缩回聚焦下限，而不是比 grown 更高
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
