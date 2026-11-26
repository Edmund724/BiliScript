import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm } from "../helpers/detached-realm.js";
import { DEFAULT_INITIAL_QUICK_PROMPTS } from "../../extension/core/default-prompts.js";

let createChatSuggestionsSlot: typeof import("../../extension/reader/chat-suggestions-slot.js").createChatSuggestionsSlot;
let state: typeof import("../../extension/core/state.js").state;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;
let writeCachedQuickPrompts: typeof import("../../extension/chat/quick-prompt-cache.js").writeCachedQuickPrompts;
let resetQuickPromptCacheForTests: typeof import("../../extension/chat/quick-prompt-cache.js").resetQuickPromptCacheForTests;

const SLOT_ID = "test-reading-chat-suggestions";
const VIDEO_CONTEXT = { isVideoContext: true, title: "测试视频", url: "https://www.bilibili.com/video/BV1" };
const PAGE_BVID = "BV1test000000";
const PAGE_CID = "1";
const PAGE_CACHE_KEY = `video:${PAGE_BVID}|${PAGE_CID}`;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const onPick = vi.fn();
  const slot = createChatSuggestionsSlot({ messages: container, id: SLOT_ID, onPick });
  const node = () => container.querySelector<HTMLElement>(".chat-suggestions");
  const chipTexts = () => [...container.querySelectorAll(".chat-chip")].map((btn) => btn.textContent || "");
  return { container, slot, onPick, node, chipTexts };
}

function clickOnce(el: Element): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  createChatSuggestionsSlot = (await import("../../extension/reader/chat-suggestions-slot.js")).createChatSuggestionsSlot;
  state = (await import("../../extension/core/state.js")).state;
  const chatState = await import("../../extension/chat/chat-state.js");
  chatSessionStateForTests = chatState.chatSessionStateForTests;
  applyConversationIdentity = chatState.applyConversationIdentity;
  resetChatSessionStateForTests = chatState.resetChatSessionStateForTests;
  const cache = await import("../../extension/chat/quick-prompt-cache.js");
  writeCachedQuickPrompts = cache.writeCachedQuickPrompts;
  resetQuickPromptCacheForTests = cache.resetQuickPromptCacheForTests;
  resetChatSessionStateForTests();
  resetQuickPromptCacheForTests();
  chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", enabled: true }];
  chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT };
  chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["问题一", "问题二"];
  state.clip.setBvid(PAGE_BVID);
  state.clip.setCid(PAGE_CID);
  state.clip.setSubtitleBody([{ from: 0, to: 5, content: "第一句" }]);
});

describe("建议区深模块：生命周期、渲染与交互", () => {
  it("未建立时不在场；reset 建壳并渲染欢迎区与 chips，重复 reset 只留最新清单", () => {
    const { container, slot, node, chipTexts } = mount();

    expect(slot.isPresent()).toBe(false);
    expect(node()).toBe(null);

    slot.reset();

    expect(slot.isPresent()).toBe(true);
    expect(node()).not.toBe(null);
    expect(node()!.id).toBe(SLOT_ID);
    expect(node()!.parentElement).toBe(container);
    expect(container.querySelector(".chat-hero")).not.toBe(null);
    expect(container.querySelector(".chat-hero-icon svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector(".chat-hero-title")?.textContent).toBe("围绕这期视频，问点什么");
    expect(chipTexts()).toEqual(["问题一", "问题二"]);

    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["新问题"];
    slot.reset();

    expect(chipTexts()).toEqual(["新问题"]);
    expect(container.querySelectorAll(".chat-suggestions")).toHaveLength(1);
  });

  it("chip 点击：把该 chip 的文案交回 onPick；HTML 走 escapeHtml 不解析且点击交回原文", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["<b>整段</b>问什么", "问题二"];
    const { container, slot, onPick } = mount();
    slot.reset();

    const chips = container.querySelectorAll<HTMLElement>(".chat-chip");
    expect(chips[0].textContent).toBe("<b>整段</b>问什么");
    expect(chips[0].querySelector("b")).toBe(null);

    clickOnce(chips[0]);
    clickOnce(chips[1]);
    expect(onPick).toHaveBeenNthCalledWith(1, "<b>整段</b>问什么");
    expect(onPick).toHaveBeenNthCalledWith(2, "问题二");
  });

  it("不可用态（无上下文 / 非视频 / 有历史 / 无平台）：reset 保留空壳不落欢迎区", () => {
    const scenarios = [
      () => { chatSessionStateForTests.contextData = null; },
      () => { chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT, isVideoContext: false }; },
      () => { applyConversationIdentity({ history: [{ role: "user", content: "hi" }] }); },
      () => { chatSessionStateForTests.providers = []; }
    ];

    for (const setup of scenarios) {
      resetChatSessionStateForTests();
      chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", enabled: true }];
      chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT };
      chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["问题一"];
      setup();
      const { container, slot, node } = mount();

      slot.reset();

      expect(slot.isPresent()).toBe(true);
      expect(node()!.innerHTML).toBe("");
      expect(container.querySelector(".chat-hero")).toBe(null);
    }
  });

  it("refresh 仅在场时重渲；clear 或容器清空后 refresh 不复活，reset 可重建新节点", () => {
    const { container, slot, node, chipTexts } = mount();

    slot.refresh();
    expect(slot.isPresent()).toBe(false);

    slot.reset();
    expect(chipTexts()).toEqual(["问题一", "问题二"]);

    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["更新后"];
    slot.refresh();
    expect(chipTexts()).toEqual(["更新后"]);

    slot.clear();
    expect(slot.isPresent()).toBe(false);
    expect(node()).toBe(null);

    slot.refresh();
    expect(slot.isPresent()).toBe(false);

    slot.reset();
    const before = node();
    container.innerHTML = "";
    expect(slot.isPresent()).toBe(false);
    slot.refresh();
    expect(slot.isPresent()).toBe(false);

    slot.reset();
    const after = node();
    expect(after).not.toBe(null);
    expect(after).not.toBe(before);
    expect(after!.parentElement).toBe(container);
  });
});

describe("建议区提示词解析（自定义 / 预热缓存 / 固定兜底 / 换片门控）", () => {
  it("自定义超过三条只保留前三条；自定义留空时优先取当前视频预热结果，否则取固定三条兜底", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = ["一", "二", "三", "四"];
    const { slot, chipTexts } = mount();
    slot.reset();
    expect(chipTexts()).toEqual(["一", "二", "三"]);

    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    slot.refresh();
    expect(chipTexts()).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);

    writeCachedQuickPrompts(PAGE_CACHE_KEY, ["生成一", "生成二", "生成三"]);
    slot.refresh();
    expect(chipTexts()).toEqual(["生成一", "生成二", "生成三"]);
  });

  it("字幕未就绪或 clip 仍停留在上个视频时，不复用旧视频预热结果，回落固定三条", () => {
    chatSessionStateForTests.aiPrefs.aiInitialQuickPrompts = [];
    writeCachedQuickPrompts(PAGE_CACHE_KEY, ["上一轮一", "上一轮二", "上一轮三"]);
    chatSessionStateForTests.currentContextKey = PAGE_CACHE_KEY;
    state.clip.setSubtitleBody([]);
    const { slot, chipTexts } = mount();
    slot.reset();
    expect(chipTexts()).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);

    const prevKey = "video:BV1prev00000|9";
    writeCachedQuickPrompts(prevKey, ["旧视频一", "旧视频二", "旧视频三"]);
    chatSessionStateForTests.currentContextKey = prevKey;
    state.clip.setBvid("BV1prev00000");
    state.clip.setCid("9");
    state.clip.setSubtitleBody([{ from: 0, to: 5, content: "上个视频的第一句" }]);
    slot.refresh();
    expect(chipTexts()).toEqual(DEFAULT_INITIAL_QUICK_PROMPTS);
  });
});

describe("分割视频笔记胶囊：点击生成、预设切换持久化与独立窗口兼容", () => {
  it("首位渲染分割笔记胶囊而不污染 .chat-chip，点击主按钮触发 onPickVideoNote", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const onPick = vi.fn();
    const onPickVideoNote = vi.fn();
    const slot = createChatSuggestionsSlot({
      messages: container,
      id: SLOT_ID,
      onPick,
      onPickVideoNote
    });

    slot.reset();

    const sugs = container.querySelector(".chat-hero-sugs")!;
    const firstChild = sugs.firstElementChild as HTMLElement;
    expect(firstChild.classList.contains("chat-note-split-pill")).toBe(true);
    expect([...container.querySelectorAll(".chat-chip")].map((el) => el.textContent)).toEqual(["问题一", "问题二"]);

    const mainBtn = firstChild.querySelector<HTMLButtonElement>(".chat-note-pill-main")!;
    expect(mainBtn.textContent).toBe("生成视频笔记 · 通用结构化");

    clickOnce(mainBtn);
    expect(onPickVideoNote).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("下拉切换预设立即更新文案与 state 并持久化 save-settings，支持外部点击与 Escape 关闭", async () => {
    const sentMessages: unknown[] = [];
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: null,
        sendMessage: vi.fn((msg: unknown, cb?: (res: unknown) => void) => {
          sentMessages.push(msg);
          cb?.({ ok: true });
        })
      }
    });

    const container = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(container, outside);
    const onPresetChange = vi.fn();
    const slot = createChatSuggestionsSlot({
      messages: container,
      id: SLOT_ID,
      onPick: vi.fn(),
      onPresetChange
    });

    slot.reset();

    const toggle = container.querySelector<HTMLButtonElement>(".chat-note-pill-toggle")!;
    const menu = container.querySelector<HTMLElement>(".chat-note-preset-menu")!;
    const mainBtn = container.querySelector<HTMLButtonElement>(".chat-note-pill-main")!;
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    clickOnce(toggle);
    expect(menu.hidden).toBe(false);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");

    const tutorialItem = menu.querySelector<HTMLButtonElement>("[data-note-preset='tutorial']")!;
    clickOnce(tutorialItem);
    expect(menu.hidden).toBe(true);
    expect(mainBtn.textContent).toBe("生成视频笔记 · 教程实操");
    expect(state.settings.notePromptPreset).toBe("tutorial");
    expect(onPresetChange).toHaveBeenCalledWith("tutorial");
    expect(sentMessages).toContainEqual({
      type: "save-settings",
      settings: { notePromptPreset: "tutorial" }
    });

    clickOnce(toggle);
    expect(menu.hidden).toBe(false);
    clickOnce(outside);
    expect(menu.hidden).toBe(true);

    clickOnce(toggle);
    expect(menu.hidden).toBe(false);
    slot.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(menu.hidden).toBe(true);

    clickOnce(toggle);
    const customItem = menu.querySelector<HTMLButtonElement>("[data-note-preset='custom']")!;
    clickOnce(customItem);
    expect(mainBtn.textContent).toBe("生成视频笔记 · 自定义");
    expect(state.settings.notePromptPreset).toBe("custom");

    vi.unstubAllGlobals();
  });

  it("独立窗口跨文档 Realm 下可正常挂载、展开菜单、切换预设并响应外部点击关闭", () => {
    const realm = createDetachedRealm();
    try {
      const container = realm.doc.createElement("div");
      const outside = realm.doc.createElement("div");
      realm.doc.body.append(container, outside);
      const onPickVideoNote = vi.fn();
      const slot = createChatSuggestionsSlot({
        messages: container,
        id: SLOT_ID,
        onPick: vi.fn(),
        onPickVideoNote
      });

      slot.reset();

      const pill = container.querySelector<HTMLElement>(".chat-note-split-pill")!;
      expect(pill.ownerDocument).toBe(realm.doc);
      expect(pill instanceof window.HTMLElement).toBe(false);

      const realmWin = realm.win as unknown as typeof window;
      const toggle = pill.querySelector<HTMLButtonElement>(".chat-note-pill-toggle")!;
      const menu = pill.querySelector<HTMLElement>(".chat-note-preset-menu")!;
      toggle.dispatchEvent(new realmWin.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(menu.hidden).toBe(false);

      outside.dispatchEvent(new realmWin.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(menu.hidden).toBe(true);

      toggle.dispatchEvent(new realmWin.MouseEvent("click", { bubbles: true, cancelable: true }));
      const courseItem = menu.querySelector<HTMLButtonElement>("[data-note-preset='course']")!;
      courseItem.dispatchEvent(new realmWin.MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(pill.querySelector(".chat-note-pill-main")?.textContent).toBe("生成视频笔记 · 课程学习");
      expect(menu.hidden).toBe(true);

      pill.querySelector<HTMLButtonElement>(".chat-note-pill-main")!.dispatchEvent(
        new realmWin.MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(onPickVideoNote).toHaveBeenCalledTimes(1);
    } finally {
      realm.close();
    }
  });
});
