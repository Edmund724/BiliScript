import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";
import type { ChatSessionState } from "../../extension/chat/chat-state.js";
import type { CreateReaderChatListsDeps } from "../../extension/reader/chat-lists.js";
import type { ChatSuggestionsSlot } from "../../extension/reader/chat-suggestions-slot.js";

let createReaderChatLists: typeof import("../../extension/reader/chat-lists.js").createReaderChatLists;
let state: typeof import("../../extension/core/state.js").state;
let chatSessionState: ChatSessionState;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let resetQuickPromptCacheForTests: typeof import("../../extension/chat/quick-prompt-cache.js").resetQuickPromptCacheForTests;
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

function makeSuggestionsSlot(overrides: Partial<ChatSuggestionsSlot> = {}): ChatSuggestionsSlot {
  return {
    render: vi.fn(),
    clear: vi.fn(),
    isPresent: vi.fn(() => true),
    ...overrides
  } as ChatSuggestionsSlot;
}

function makeDeps(overrides: Partial<CreateReaderChatListsDeps> = {}) {
  const historyList = document.createElement("div");
  const historyClearBtn = document.createElement("button");
  document.body.append(historyList, historyClearBtn);

  const deps: CreateReaderChatListsDeps = {
    historyList,
    historyClearBtn,
    applyById: vi.fn(),
    deleteById: vi.fn(async () => null),
    isTurnActive: vi.fn(() => false),
    confirmDeleteCurrent: vi.fn(async () => true),
    startNewConversation: vi.fn(async () => true),
    suggestions: makeSuggestionsSlot(),
    hideHistoryPopover: vi.fn(),
    ...overrides
  };
  const lists = createReaderChatLists(deps);
  return { deps, lists, historyList, historyClearBtn, suggestions: deps.suggestions };
}

function clickOnce(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

const VIDEO_CONTEXT = { isVideoContext: true, title: "测试视频", url: "https://www.bilibili.com/video/BV1" };
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

describe("renderSuggestions（提交给建议区属主的清单）", () => {
  it("有上下文 + 有平台 + 无历史：提交自定义的三条问题", () => {
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();

    expect(suggestions.isPresent).toHaveBeenCalled();
    expect(suggestions.render).toHaveBeenCalledWith(["总结视频", "整理笔记"]);
  });

  it("无上下文：提交空表（属主保留空壳）", () => {
    chatSessionStateForTests.contextData = null;
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith([]);
  });

  it("非视频上下文（isVideoContext === false）：提交空表", () => {
    chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT, isVideoContext: false };
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith([]);
  });

  it("有会话历史（流式中）：提交空表", () => {
    applyConversationIdentity({ history: [{ role: "user", content: "hi" }] });
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith([]);
  });

  it("无可用平台：提交空表", () => {
    chatSessionStateForTests.providers = [];
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith([]);
  });

  it("建议区不在场（发送受理撤除 / 回放清场）：不对账重渲", () => {
    const { lists, suggestions } = makeDeps({ suggestions: makeSuggestionsSlot({ isPresent: vi.fn(() => false) }) });
    lists.renderSuggestions();
    expect(suggestions.render).not.toHaveBeenCalled();
  });

  it("自定义留空（留空即自动生成）：提交该视频的生成结果", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    writeCachedQuickPrompts(PAGE_CACHE_KEY, ["生成一", "生成二", "生成三"]);
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith(["生成一", "生成二", "生成三"]);
  });

  it("自定义留空且该视频还没有生成结果：提交固定三条兜底", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("字幕未就绪（转写中，字幕体为空）：回落固定三条默认问题，不用该视频已有的生成结果", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    writeCachedQuickPrompts(PAGE_CACHE_KEY, ["上一轮一", "上一轮二", "上一轮三"]);
    chatSessionStateForTests.currentContextKey = PAGE_CACHE_KEY;
    state.clip.setSubtitleBody([]);
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("clip 还停在上一个视频（转写中换片竞态）：回落固定三条，不遗留上个视频的生成结果", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    const prevKey = "video:BV1prev00000|9";
    writeCachedQuickPrompts(prevKey, ["Karpathy四层输出阶梯是什么？", "第三层网页为何更适合读长文？", "如何用一次性软件降低大脑带宽？"]);
    chatSessionStateForTests.currentContextKey = prevKey;
    state.clip.setBvid("BV1prev00000");
    state.clip.setCid("9");
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "上个视频的第一句" }]);
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith(DEFAULT_INITIAL_QUICK_PROMPTS);
  });

  it("自定义超过三条：只提交前三条", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["一", "二", "三", "四"];
    const { lists, suggestions } = makeDeps();
    lists.renderSuggestions();
    expect(suggestions.render).toHaveBeenCalledWith(["一", "二", "三"]);
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

  it("伴看记录展示类别与数量，打开只读详情不恢复对话或提供伴看动作", async () => {
    applyConversationIdentity({ id: "ordinary", history: [{ role: "user", content: "普通问题" }] });
    setSavedConversations([
      {
        id: "live:BV1test000000:1",
        kind: "live-text-tool",
        title: "伴看视频",
        contextKey: "video:BV1test000000|1",
        contextTitle: "伴看视频",
        contextUrl: "https://www.bilibili.com/video/BV1test000000",
        isVideoContext: true,
        createdAt: 100,
        updatedAt: 200,
        contextRef: { bvid: "BV1test000000", cid: "1" },
        messages: [],
        records: [
          {
            callId: "completed",
            source: "gemini",
            status: "completed",
            objective: "梳理论点",
            summary: "完成摘要",
            markdown: "# 完整结果\n\n**正文**",
            startedAt: 100,
            endedAt: 200,
            durationMs: 100
          },
          {
            callId: "failed",
            source: "moss",
            status: "failed",
            objective: "总结全片",
            summary: "失败前摘要",
            markdown: "失败前全文",
            error: "模型限流",
            startedAt: 50,
            endedAt: 80,
            durationMs: 30
          }
        ]
      }
    ]);
    const { lists, deps, historyList } = makeDeps();
    lists.renderHistoryList();

    expect(historyList.textContent).toContain("伴看记录");
    expect(historyList.textContent).toContain("伴看视频");
    expect(historyList.textContent).toContain("2 条记录");
    historyList.scrollTop = 120;
    clickOnce(historyList.querySelector(".chat-history-open")!);

    expect(historyList.scrollTop).toBe(0);
    expect(deps.applyById).not.toHaveBeenCalled();
    expect(deps.hideHistoryPopover).not.toHaveBeenCalled();
    expect(chatSessionState.currentConversationId).toBe("ordinary");
    expect(chatSessionState.chatHistory).toEqual([{ role: "user", content: "普通问题" }]);
    expect(historyList.textContent).toContain("梳理论点");
    expect(historyList.textContent).toContain("完成摘要");
    expect(historyList.textContent).toContain("模型限流");
    expect(historyList.textContent).toContain("失败前摘要");
    expect(historyList.querySelector(".chat-live-tool-record-markdown")?.textContent).toContain("完整结果");
    expect(historyList.querySelectorAll("details[data-record-details]")).toHaveLength(2);
    expect(historyList.querySelector("[data-live-record-action]")).toBeNull();

    historyList.scrollTop = 40;
    clickOnce(historyList.querySelector(".chat-live-history-back")!);
    expect(historyList.querySelector(".chat-live-history-detail")).toBeNull();
    expect(historyList.scrollTop).toBe(120);
    clickOnce(historyList.querySelector(".chat-history-remove")!);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.deleteById).toHaveBeenCalledWith("live:BV1test000000:1");
  });
});

describe("历史定位、切换与删除撤销（工单 05）", () => {
  function conversation(id: string) {
    return { id, title: `会话 ${id}`, contextKey: "", contextTitle: "", contextUrl: "", isVideoContext: true, createdAt: 0, updatedAt: 0, contextRef: null, messages: [] };
  }

  function seed(ids = ["c1", "c2", "c3"]) {
    setSavedConversations(ids.map(conversation));
  }

  async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it("当前项有文字徽标与 aria-current，打开时以 nearest 定位", () => {
    seed(["c1", "c2"]);
    applyConversationIdentity({ id: "c2" });
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { lists, historyList } = makeDeps();
      lists.renderHistoryList({ revealCurrent: true });

      const active = historyList.querySelector(".chat-history-open[data-id=c2]")!;
      expect(active.getAttribute("aria-current")).toBe("true");
      expect(active.querySelector(".chat-history-current")?.textContent).toBe("当前");
      expect(historyList.querySelector(".chat-history-open[data-id=c1]")?.getAttribute("aria-current")).toBeNull();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      if (originalScrollIntoView) {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("当前身份晚于首次渲染落定：重渲同样以 nearest 跟随", () => {
    seed(["c1", "c2"]);
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = vi.fn();
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      const { lists } = makeDeps();
      lists.renderHistoryList();
      expect(scrollIntoView).not.toHaveBeenCalled();

      applyConversationIdentity({ id: "c2" });
      lists.renderHistoryList();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    } finally {
      if (originalScrollIntoView) {
        HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
      } else {
        Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
      }
    }
  });

  it("整行除删除键外均可打开，删除不会冒泡成切换", () => {
    seed(["c1"]);
    const { lists, deps, historyList } = makeDeps();
    lists.renderHistoryList();

    clickOnce(historyList.querySelector(".chat-history-remove")!);
    expect(deps.applyById).not.toHaveBeenCalled();
    clickOnce(historyList.querySelector(".chat-history-item")!);
    expect(deps.applyById).toHaveBeenCalledWith("c1");
    expect(deps.hideHistoryPopover).toHaveBeenCalledTimes(1);
  });

  it("在途切换保留历史并显示忙碌，重复提交单飞，落定后才退出", async () => {
    seed(["c1", "c2"]);
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { lists, deps, historyList } = makeDeps({ applyById: vi.fn(() => gate) });
    lists.renderHistoryList();
    const row = historyList.querySelector(".chat-history-item[data-id=c1]")!;

    clickOnce(row);
    expect(historyList.textContent).toContain("正在保存当前回答…");
    expect(historyList.querySelector(".chat-history-item[data-id=c1]")?.getAttribute("aria-busy")).toBe("true");
    expect(historyList.getAttribute("aria-busy")).toBe("true");
    const busyButton = historyList.querySelector<HTMLButtonElement>(".chat-history-open[data-id=c1]")!;
    expect(busyButton.getAttribute("aria-disabled")).toBe("true");
    expect(busyButton.disabled).toBe(false);
    expect(document.activeElement).toBe(busyButton);
    expect(deps.hideHistoryPopover).not.toHaveBeenCalled();
    clickOnce(historyList.querySelector(".chat-history-item[data-id=c1]")!);
    expect(deps.applyById).toHaveBeenCalledTimes(1);

    release();
    await flushPromises();
    expect(deps.hideHistoryPopover).toHaveBeenCalledTimes(1);
    expect(historyList.textContent).not.toContain("正在保存当前回答…");
    expect(historyList.getAttribute("aria-busy")).toBeNull();
  });

  it("删除后聚焦下一项；撤销恢复顺序和原条目焦点", async () => {
    vi.useFakeTimers();
    try {
      const original = ["c1", "c2", "c3"].map(conversation);
      seed();
      const undo = vi.fn(async () => setSavedConversations(original));
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      const { lists, historyList } = makeDeps({
        deleteById: vi.fn(async (id) => {
          setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== id));
          return { id, undo };
        })
      });
      lists.renderHistoryList();
      clickOnce(historyList.querySelector(".chat-history-remove[data-id=c2]")!);
      await flushPromises();

      expect(chatSessionState.savedConversations.map((item) => item.id)).toEqual(["c1", "c3"]);
      expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id=c3]"));
      expect(historyList.textContent).toContain("已删除历史记录");
      const undoTimer = setTimeoutSpy.mock.calls.flatMap(([, delay], index) => delay === 6000 ? [setTimeoutSpy.mock.results[index]?.value] : []).at(-1);

      clickOnce(historyList.querySelector(".chat-history-undo-button")!);
      await flushPromises();
      expect(undo).toHaveBeenCalledTimes(1);
      expect(chatSessionState.savedConversations.map((item) => item.id)).toEqual(["c1", "c2", "c3"]);
      expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id=c2]"));
      expect(clearTimeoutSpy.mock.calls.some(([candidate]) => candidate === undoTimer)).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("删除末项聚焦上一项，6 秒后撤销入口消失", async () => {
    vi.useFakeTimers();
    try {
      seed(["c1", "c2"]);
      const { lists, historyList } = makeDeps({
        deleteById: vi.fn(async (id) => {
          setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== id));
          return { id, undo: vi.fn(async () => {}) };
        })
      });
      lists.renderHistoryList();
      clickOnce(historyList.querySelector(".chat-history-remove[data-id=c2]")!);
      await flushPromises();
      expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id=c1]"));

      await vi.advanceTimersByTimeAsync(5999);
      expect(historyList.querySelector(".chat-history-undo-button")).not.toBeNull();
      await vi.advanceTimersByTimeAsync(1);
      expect(historyList.querySelector(".chat-history-undo-button")).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("连续删除只保留最后一次撤销，离开历史结算并清理计时器", async () => {
    vi.useFakeTimers();
    try {
      seed(["c1", "c2"]);
      const undoFirst = vi.fn(async () => {});
      const undoSecond = vi.fn(async () => setSavedConversations([conversation("c2")]));
      const setTimeoutSpy = vi.spyOn(window, "setTimeout");
      const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
      const { lists, historyList } = makeDeps({
        deleteById: vi.fn(async (id) => {
          setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== id));
          return { id, undo: id === "c1" ? undoFirst : undoSecond };
        })
      });
      lists.renderHistoryList();
      clickOnce(historyList.querySelector(".chat-history-remove[data-id=c1]")!);
      await flushPromises();
      const firstTimer = setTimeoutSpy.mock.calls.flatMap(([, delay], index) => delay === 6000 ? [setTimeoutSpy.mock.results[index]?.value] : []).at(-1);
      clickOnce(historyList.querySelector(".chat-history-remove[data-id=c2]")!);
      await flushPromises();
      const secondTimer = setTimeoutSpy.mock.calls.flatMap(([, delay], index) => delay === 6000 ? [setTimeoutSpy.mock.results[index]?.value] : []).at(-1);
      expect(clearTimeoutSpy.mock.calls.some(([candidate]) => candidate === firstTimer)).toBe(true);

      clickOnce(historyList.querySelector(".chat-history-undo-button")!);
      await flushPromises();
      expect(undoFirst).not.toHaveBeenCalled();
      expect(undoSecond).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy.mock.calls.some(([candidate]) => candidate === secondTimer)).toBe(true);

      clickOnce(historyList.querySelector(".chat-history-remove[data-id=c2]")!);
      await flushPromises();
      const thirdTimer = setTimeoutSpy.mock.calls.flatMap(([, delay], index) => delay === 6000 ? [setTimeoutSpy.mock.results[index]?.value] : []).at(-1);
      lists.settlePendingDeletion();
      expect(clearTimeoutSpy.mock.calls.some(([candidate]) => candidate === thirdTimer)).toBe(true);
      expect(historyList.querySelector(".chat-history-undo-button")).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it("当前在途会话删除前确认，取消零副作用", async () => {
    seed(["c1"]);
    applyConversationIdentity({ id: "c1" });
    const confirmDeleteCurrent = vi.fn(async () => false);
    const { lists, deps, historyList } = makeDeps({
      isTurnActive: () => true,
      confirmDeleteCurrent
    });
    lists.renderHistoryList();
    clickOnce(historyList.querySelector(".chat-history-remove")!);
    await flushPromises();
    expect(confirmDeleteCurrent).toHaveBeenCalledWith(expect.stringContaining("正在生成的回答将被丢弃"));
    expect(deps.deleteById).not.toHaveBeenCalled();

    confirmDeleteCurrent.mockResolvedValue(true);
    clickOnce(historyList.querySelector(".chat-history-remove")!);
    await flushPromises();
    expect(deps.deleteById).toHaveBeenCalledWith("c1");
  });

  it("空态提供开始新会话，完成后退出并聚焦输入框", async () => {
    const { lists, deps, historyList } = makeDeps();
    lists.renderHistoryList();
    clickOnce(historyList.querySelector(".chat-history-start-new")!);
    await flushPromises();
    expect(deps.startNewConversation).toHaveBeenCalledTimes(1);
    expect(deps.hideHistoryPopover).toHaveBeenCalledTimes(1);
  });

  it("开始新会话被取消：历史保持，不再触发退出", async () => {
    const { lists, deps, historyList } = makeDeps({ startNewConversation: vi.fn(async () => false) });
    lists.renderHistoryList();
    clickOnce(historyList.querySelector(".chat-history-start-new")!);
    await flushPromises();
    expect(deps.startNewConversation).toHaveBeenCalledTimes(1);
    expect(deps.hideHistoryPopover).not.toHaveBeenCalled();
  });

  it("连续删除乱序落定：先发后至的旧删除不覆盖最新撤销条与焦点", async () => {
    seed(["c1", "c2", "c3"]);
    const pending: Array<() => void> = [];
    const undos = new Map<string, ReturnType<typeof vi.fn>>();
    const deleteById = vi.fn((id: string) => {
      setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== id));
      return new Promise<{ id: string; undo: () => Promise<void> }>((resolve) => {
        pending.push(() => {
          const undo = vi.fn(async () => {});
          undos.set(id, undo);
          resolve({ id, undo });
        });
      });
    });
    const { lists, historyList } = makeDeps({ deleteById });
    lists.renderHistoryList();

    clickOnce(historyList.querySelector(".chat-history-remove[data-id=c2]")!);
    await flushPromises();
    clickOnce(historyList.querySelector(".chat-history-remove[data-id=c3]")!);
    await flushPromises();
    expect(deleteById).toHaveBeenCalledTimes(2);

    pending[1]();
    await flushPromises();
    expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id=c1]"));

    pending[0]();
    await flushPromises();
    expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id=c1]"));
    clickOnce(historyList.querySelector(".chat-history-undo-button")!);
    await flushPromises();
    expect(undos.get("c3")).toHaveBeenCalledTimes(1);
    expect(undos.get("c2")).not.toHaveBeenCalled();
  });

  it("离开历史时在途删除落定：不复活撤销条、不抢焦点", async () => {
    seed(["c1", "c2"]);
    let resolveDeletion: (() => void) | null = null;
    const { lists, historyList } = makeDeps({
      deleteById: vi.fn((id: string) => {
        setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== id));
        return new Promise<{ id: string; undo: () => Promise<void> }>((resolve) => {
          resolveDeletion = () => resolve({ id, undo: vi.fn(async () => {}) });
        });
      })
    });
    lists.renderHistoryList();
    clickOnce(historyList.querySelector(".chat-history-remove[data-id=c1]")!);
    await flushPromises();

    lists.settlePendingDeletion();
    resolveDeletion!();
    await flushPromises();

    expect(historyList.querySelector(".chat-history-undo-button")).toBeNull();
    expect(document.activeElement).not.toBe(historyList.querySelector(".chat-history-open[data-id=c2]"));
  });

  it("伴看详情内保留撤销条；撤销后回到列表并聚焦被恢复项", async () => {
    const live = {
      id: "live:BV1test000000:1",
      kind: "live-text-tool" as const,
      title: "伴看视频",
      contextKey: "video:BV1test000000|1",
      contextTitle: "伴看视频",
      contextUrl: "https://www.bilibili.com/video/BV1test000000",
      isVideoContext: true,
      createdAt: 100,
      updatedAt: 200,
      contextRef: { bvid: "BV1test000000", cid: "1" },
      messages: [],
      records: []
    };
    const original = [conversation("c1"), live];
    seed(["c1"]);
    setSavedConversations(original as never);
    const undo = vi.fn(async () => setSavedConversations(original as never));
    const { lists, historyList } = makeDeps({
      deleteById: vi.fn(async (id) => {
        setSavedConversations(chatSessionState.savedConversations.filter((item) => item.id !== id));
        return { id, undo };
      })
    });
    lists.renderHistoryList();
    clickOnce(historyList.querySelector(".chat-history-remove[data-id=c1]")!);
    await flushPromises();
    expect(historyList.querySelector(".chat-history-undo")).not.toBeNull();

    clickOnce(historyList.querySelector(".chat-history-open[data-id='live:BV1test000000:1']")!);
    expect(historyList.querySelector(".chat-live-history-detail")).not.toBeNull();
    expect(historyList.querySelector(".chat-history-undo-button")).not.toBeNull();

    clickOnce(historyList.querySelector(".chat-history-undo-button")!);
    await flushPromises();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(historyList.querySelector(".chat-live-history-detail")).toBeNull();
    expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id=c1]"));
  });

  it("settleTurn 未落定前调用 cancelPendingSwitch：作废切换且恢复清空按钮可用", async () => {
    seed(["c1", "c2"]);
    let releaseSettle = () => {};
    const settleGate = new Promise<void>((resolve) => { releaseSettle = resolve; });
    const { lists, deps, historyList, historyClearBtn } = makeDeps({
      settleTurn: vi.fn(() => settleGate)
    });
    lists.renderHistoryList();

    clickOnce(historyList.querySelector(".chat-history-item[data-id=c1]")!);
    expect(historyClearBtn.disabled).toBe(true);
    expect(deps.applyById).not.toHaveBeenCalled();

    lists.cancelPendingSwitch();
    expect(historyClearBtn.disabled).toBe(false);
    expect(historyList.getAttribute("aria-busy")).toBeNull();

    releaseSettle();
    await flushPromises();
    expect(deps.applyById).not.toHaveBeenCalled();
    expect(deps.hideHistoryPopover).not.toHaveBeenCalled();
  });

  it("伴看详情隐藏清空全部按钮；exitLiveHistoryDetail 返回列表并归还焦点", () => {
    const live = {
      id: "live:BV1test000000:1",
      kind: "live-text-tool" as const,
      title: "伴看视频",
      contextKey: "video:BV1test000000|1",
      contextTitle: "伴看视频",
      contextUrl: "https://www.bilibili.com/video/BV1test000000",
      isVideoContext: true,
      createdAt: 100,
      updatedAt: 200,
      contextRef: { bvid: "BV1test000000", cid: "1" },
      messages: [],
      records: []
    };
    seed(["c1"]);
    setSavedConversations([conversation("c1"), live] as never);
    const { lists, historyList, historyClearBtn } = makeDeps();
    lists.renderHistoryList();
    expect(historyClearBtn.hidden).toBe(false);

    clickOnce(historyList.querySelector(".chat-history-open[data-id='live:BV1test000000:1']")!);
    expect(historyClearBtn.hidden).toBe(true);

    expect(lists.exitLiveHistoryDetail()).toBe(true);
    expect(lists.exitLiveHistoryDetail()).toBe(false);
    expect(historyClearBtn.hidden).toBe(false);
    expect(document.activeElement).toBe(historyList.querySelector(".chat-history-open[data-id='live:BV1test000000:1']"));
  });
});
