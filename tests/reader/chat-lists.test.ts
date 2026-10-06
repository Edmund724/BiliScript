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
let state: typeof import("../../extension/core/state.js").state;
let chatSessionState: ChatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let resetQuickPromptCacheForTests: typeof import("../../extension/chat/quick-prompt-cache.js").resetQuickPromptCacheForTests;
// 写纪律：身份三件套 / 存档列表只经 chat-state 的意图级原语写（与被测模块同纪元）
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let setSavedConversations: typeof import("../../extension/chat/chat-state.js").setSavedConversations;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

async function importModule() {
  const module = await import("../../extension/reader/chat-lists.js");
  const chatState = await import("../../extension/chat/chat-state.js");
  const cache = await import("../../extension/chat/quick-prompt-cache.js");
  createReaderChatLists = module.createReaderChatLists;
  state = (await import("../../extension/core/state.js")).state;
  chatSessionState = chatState.chatSessionState;
  chatSessionStateForTests = chatState.chatSessionStateForTests;
  applyConversationIdentity = chatState.applyConversationIdentity;
  setSavedConversations = chatState.setSavedConversations;
  resetChatSessionStateForTests = chatState.resetChatSessionStateForTests;
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
// 当前页（jsdom 地址由 setup 的 resetModuleState 固定为 BV1test000000）的视频身份与
// 已就绪字幕：建议区的缓存键读进程内 clip（与写方 reader/quick-prompts 同源）。
const PAGE_BVID = "BV1test000000";
const PAGE_CID = "1";
const PAGE_CACHE_KEY = `video:${PAGE_BVID}|${PAGE_CID}`;

beforeEach(async () => {
  resetModuleState();
  await importModule();
  resetChatSessionStateForTests();
  resetQuickPromptCacheForTests();
  chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", enabled: true }];
  chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT };
  chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["总结视频", "整理笔记"];
  state.clip.setBvid(PAGE_BVID);
  state.clip.setCid(PAGE_CID);
  state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一句" }]);
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

  it("有建议时先渲染一行提示（图标 + 文案），chips 紧随其后", () => {
    const { lists, container } = makeDeps();
    lists.renderSuggestions();

    const hint = container.querySelector(".chat-suggestions-hint");
    expect(hint).not.toBe(null);
    expect(hint!.textContent).toBe("这段视频你可能想问");
    expect(hint!.querySelector(".chat-suggestions-hint-icon svg")).not.toBe(null);

    // 顺序即契约：提示行是建议区的第一个节点，chips 依次跟在后面。
    const children = [...container.querySelectorAll(".chat-suggestions-hint, .chat-chip")];
    expect(children[0]).toBe(hint);
    expect(children.slice(1).map((el) => el.textContent)).toEqual(["总结视频", "整理笔记"]);
  });

  it("无上下文：清空建议区", () => {
    chatSessionStateForTests.contextData = null;
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("非视频上下文（isVideoContext === false）：清空建议区", () => {
    chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT, isVideoContext: false };
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
    chatSessionStateForTests.providers = [];
    const { lists, setSuggestionsNode } = makeDeps();
    const node = document.createElement("div");
    setSuggestionsNode(node);
    lists.renderSuggestions();
    expect(node.innerHTML).toBe("");
  });

  it("自定义留空（留空即自动生成）：渲染该视频的生成结果", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    writeCachedQuickPrompts(PAGE_CACHE_KEY, ["生成一", "生成二", "生成三"]);
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(["生成一", "生成二", "生成三"]);
  });

  it("自定义留空且该视频还没有生成结果：回落固定三条兜底", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  // 用户报障（音频转写中显示上一个视频的三个问题）：缓存里有生成结果 ≠ 该在当前页
  // 显示。取用要同时满足「身份是当前页视频」与「字幕已就绪」，两条不满足都回落
  // 固定三条默认问题。
  it("字幕未就绪（转写中，字幕体为空）：回落固定三条默认问题，不用该视频已有的生成结果", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    writeCachedQuickPrompts(PAGE_CACHE_KEY, ["上一轮一", "上一轮二", "上一轮三"]);
    // 对照：旧口径（读对话上下文的 currentContextKey）在这里会命中缓存、
    // 把生成结果显示到没字幕的视频上。
    chatSessionStateForTests.currentContextKey = PAGE_CACHE_KEY;
    state.clip.setSubtitleBody([]);
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("clip 还停在上一个视频（转写中换片竞态）：回落固定三条，不遗留上个视频的生成结果", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    const prevKey = "video:BV1prev00000|9";
    writeCachedQuickPrompts(prevKey, ["Karpathy四层输出阶梯是什么？", "第三层网页为何更适合读长文？", "如何用一次性软件降低大脑带宽？"]);
    // 真实形态：对话上下文也还停在上一个视频（URL 变化同步早于 clip 重置，
    // 且此后不再对账）——建议区不读它，读进程内 clip 的当前页身份。
    chatSessionStateForTests.currentContextKey = prevKey;
    state.clip.setBvid("BV1prev00000");
    state.clip.setCid("9");
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "上个视频的第一句" }]);
    const { lists, container } = makeDeps();
    lists.renderSuggestions();
    expect([...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent))
      .toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("自定义超过三条：只渲染前三条", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["一", "二", "三", "四"];
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
