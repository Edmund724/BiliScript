// tests/reader/chat-lists.test.ts
// createReaderChatLists（对话 tab 两列表渲染：建议/历史）行为契约。
// PR5 自 tests/sidepanel/sidepanel-lists.test.ts 随重建迁移（tests/sidepanel/
// 对应文件已迁走）：逻辑断言保真，DOM 壳换新——元素为 reader 的 readingChat*
// 节点，class 名沿用 .chat-*（样式段在 styles/reader-chat.css，按需装载）。
//
// 覆盖：
// - renderSuggestions：有平台/无历史/视频上下文时渲染建议 chip，点击填入输入框
//   并触发发送回调；无上下文 / 非视频页 / 流式中（有 chatHistory）/ 无平台时清空；
// - renderHistoryList：空列表占位 + 清空按钮隐藏；active / live-match 高亮；
//   open 点击 → applyById + 关历史 popover；remove 点击 → deleteById。
//
// 模块纪元注意：chatSessionState 是模块级单例，beforeEach resetModules 后与被测
// 模块同纪元导入，并经 resetChatSessionStateForTests 重置字段。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";
import type { CreateReaderChatListsDeps } from "../../extension/reader/chat-lists.js";

let createReaderChatLists: typeof import("../../extension/reader/chat-lists.js").createReaderChatLists;
let chatSessionState: ChatSessionState;
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let resetQuickPromptCacheForTests: typeof import("../../extension/chat/quick-prompt-cache.js").resetQuickPromptCacheForTests;
// 写纪律：身份三件套 / 存档列表只经 chat-state 的意图级原语写（与被测模块同纪元）
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

async function importModule() {
  const module = await import("../../extension/reader/chat-lists.js");
  const state = await import("../../extension/chat/chat-state.js");
  const cache = await import("../../extension/chat/quick-prompt-cache.js");
  createReaderChatLists = module.createReaderChatLists;
  chatSessionState = state.chatSessionState;
  applyConversationIdentity = state.applyConversationIdentity;
  setSavedConversations = state.setSavedConversations;
  resetChatSessionStateForTests = state.resetChatSessionStateForTests;
  writeCachedQuickPrompts = cache.writeCachedQuickPrompts;
  resetQuickPromptCacheForTests = cache.resetQuickPromptCacheForTests;
}

function makeDeps(overrides: Partial<CreateReaderChatListsDeps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const historyList = document.createElement("div");
  const historyClearBtn = document.createElement("button");
  const input = document.createElement("textarea");
  container.append(historyList, historyClearBtn, input);

  let suggestionsNode: HTMLElement = document.createElement("div");
  container.appendChild(suggestionsNode);
  const deps: CreateReaderChatListsDeps = {
    historyList,
    historyClearBtn,
    input,
    applyById: vi.fn(),
    deleteById: vi.fn(async () => {}),
    autosizeInput: vi.fn(),
    onSuggestionClick: vi.fn(),
    getSuggestionsNode: () => suggestionsNode,
    hideHistoryPopover: vi.fn(),
    ...overrides
  };
  const lists = createReaderChatLists(deps);
  return { deps, lists, input, historyList, historyClearBtn, container, setSuggestionsNode: (node: HTMLElement) => {
    suggestionsNode.remove();
    suggestionsNode = node;
    container.appendChild(node);
  } };
}

// setup.ts 给 HTMLElement.prototype.click 打了「补派发一次 MouseEvent」的补丁，
// 直接 .click() 会双触发；测试里统一用 dispatchEvent 保证恰好一次。
function clickOnce(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

const VIDEO_CONTEXT = { isVideoContext: true, title: "测试视频", url: "https://www.bilibili.com/video/BV1" };

beforeEach(async () => {
  resetModuleState();
  await importModule();
  resetChatSessionStateForTests();
  resetQuickPromptCacheForTests();
  chatSessionState.providers = [{ id: "p1", name: "平台一", enabled: true }];
  chatSessionState.contextData = { ...VIDEO_CONTEXT };
  chatSessionState.aiPrefs.aiInitialQuickPrompts = ["总结视频", "整理笔记"];
});

describe("renderSuggestions（建议提示词）", () => {
  it("有上下文 + 有平台 + 无历史：渲染建议 chip，点击填入输入框并发送", async () => {
    const { lists, deps, input } = makeDeps();
    lists.renderSuggestions();

    const chips = [...document.querySelectorAll(".chat-chip")];
    expect(chips.map((btn) => btn.textContent)).toEqual(["总结视频", "整理笔记"]);

    clickOnce(chips[1]);
    expect(input.value).toBe("整理笔记");
    expect(deps.autosizeInput).toHaveBeenCalled();
    expect(deps.onSuggestionClick).toHaveBeenCalledWith("整理笔记");
  });

  it("无上下文：清空建议区", () => {
    chatSessionState.contextData = null;
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("非视频上下文（isVideoContext === false）：清空建议区", () => {
    chatSessionState.contextData = { ...VIDEO_CONTEXT, isVideoContext: false };
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("有会话历史（流式中）：清空建议区", () => {
    applyConversationIdentity({ history: [{ role: "user", content: "hi" }] });
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("无可用平台：清空建议区", () => {
    chatSessionState.providers = [];
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("自定义留空（留空即自动生成）：渲染该视频的生成结果", () => {
    chatSessionState.aiPrefs.aiInitialQuickPrompts = [];
    chatSessionState.currentContextKey = "video:BV1|1";
    writeCachedQuickPrompts("video:BV1|1", ["生成一", "生成二", "生成三"]);
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(["生成一", "生成二", "生成三"]);
  });

  it("自定义留空且该视频还没有生成结果：回落固定三条兜底", () => {
    chatSessionState.aiPrefs.aiInitialQuickPrompts = [];
    chatSessionState.currentContextKey = "video:BV1|1";
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("自定义超过三条：只渲染前三条", () => {
    chatSessionState.aiPrefs.aiInitialQuickPrompts = ["一", "二", "三", "四"];
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(["一", "二", "三"]);
  });
});

describe("renderHistoryList（历史会话）", () => {
  it("空列表：占位文案 + 清空按钮隐藏", () => {
    const { lists, historyList, historyClearBtn } = makeDeps();
    lists.renderHistoryList();
    expect(historyList.innerHTML).toContain("chat-history-empty");
    expect(historyClearBtn.hidden).toBe(true);
  });

  it("有会话：清空按钮显示，渲染条目，open 点击触发 applyById + 关历史 popover", () => {
    setSavedConversations([
      { id: "c1", title: "会话一", contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] },
      { id: "c2", title: "会话二", contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] }
    ]);
    applyConversationIdentity({ id: "c2" });
    const { lists, deps, historyList, historyClearBtn } = makeDeps();
    lists.renderHistoryList();

    expect(historyClearBtn.hidden).toBe(false);
    const items = [...historyList.querySelectorAll(".chat-history-item")];
    expect(items).toHaveLength(2);
    expect(items[0].classList.contains("is-active")).toBe(false);
    expect(items[1].classList.contains("is-active")).toBe(true);

    clickOnce(items[0].querySelector(".chat-history-open")!);
    expect(deps.applyById).toHaveBeenCalledWith("c1");
    expect(deps.hideHistoryPopover).toHaveBeenCalledTimes(1);
  });

  it("remove 点击：调用 deleteById 回调", async () => {
    setSavedConversations([
      { id: "c1", title: "会话一", contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] }
    ]);
    const { lists, deps, historyList } = makeDeps();
    lists.renderHistoryList();

    clickOnce(historyList.querySelector(".chat-history-remove")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.deleteById).toHaveBeenCalledWith("c1");
  });
});
