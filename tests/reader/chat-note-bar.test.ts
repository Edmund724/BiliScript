import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm } from "../helpers/detached-realm.js";

let createChatNoteBar: typeof import("../../extension/reader/chat-note-bar.js").createChatNoteBar;
let state: typeof import("../../extension/core/state.js").state;
let chatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").chatSessionStateForTests;
let applyConversationIdentity: typeof import("../../extension/chat/chat-state.js").applyConversationIdentity;
let resetChatSessionStateForTests: typeof import("../../extension/chat/chat-state.js").resetChatSessionStateForTests;

const VIDEO_CONTEXT = { isVideoContext: true, title: "测试视频", url: "https://www.bilibili.com/video/BV1" };

function clickOnce(el: Element, detail = 1): void {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  createChatNoteBar = (await import("../../extension/reader/chat-note-bar.js")).createChatNoteBar;
  state = (await import("../../extension/core/state.js")).state;
  const chatState = await import("../../extension/chat/chat-state.js");
  chatSessionStateForTests = chatState.chatSessionStateForTests;
  applyConversationIdentity = chatState.applyConversationIdentity;
  resetChatSessionStateForTests = chatState.resetChatSessionStateForTests;
  resetChatSessionStateForTests();
  chatSessionStateForTests.providers = [{ id: "p1", name: "平台一", enabled: true }];
  chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT };
});

describe("输入框上方视频笔记条：常驻显隐、预设切换、键盘导航与跨文档兼容", () => {
  it("视频页且存在可选模型时在空态与有历史对话时均保持显示；非视频页或无可用模型时隐藏", () => {
    const host = document.createElement("div");
    host.id = "test-chat-note-bar";
    host.hidden = true;
    document.body.appendChild(host);
    let selectable = true;
    const onPickVideoNote = vi.fn();
    const bar = createChatNoteBar({
      host,
      hasSelectableModels: () => selectable,
      onPickVideoNote
    });

    bar.refresh();
    expect(host.hidden).toBe(false);
    const mainBtn = host.querySelector<HTMLButtonElement>(".chat-note-pill-main")!;
    expect(mainBtn.textContent).toBe("生成视频笔记 · 通用结构化");

    applyConversationIdentity({ history: [{ role: "user", content: "hi" }] });
    bar.refresh();
    expect(host.hidden).toBe(false);

    clickOnce(mainBtn);
    expect(onPickVideoNote).toHaveBeenCalledTimes(1);

    selectable = false;
    bar.refresh();
    expect(host.hidden).toBe(true);

    selectable = true;
    chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT, isVideoContext: false };
    bar.refresh();
    expect(host.hidden).toBe(true);

    chatSessionStateForTests.contextData = null;
    bar.refresh();
    expect(host.hidden).toBe(true);

    chatSessionStateForTests.contextData = { ...VIDEO_CONTEXT };
    chatSessionStateForTests.providers = [];
    bar.refresh();
    expect(host.hidden).toBe(true);
  });

  it("预设菜单支持切换持久化、外部点击、方向键/Home/End、Tab 与 Escape 关闭", () => {
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

    const host = document.createElement("div");
    host.id = "test-chat-note-bar";
    host.hidden = true;
    const outside = document.createElement("button");
    document.body.append(host, outside);
    const onPresetChange = vi.fn();
    const onOpenMenu = vi.fn();
    const bar = createChatNoteBar({
      host,
      hasSelectableModels: () => true,
      onPickVideoNote: vi.fn(),
      onPresetChange,
      onOpenMenu
    });

    bar.refresh();

    const toggle = host.querySelector<HTMLButtonElement>(".chat-note-pill-toggle")!;
    const menu = host.querySelector<HTMLElement>(".chat-note-preset-menu")!;
    const mainBtn = host.querySelector<HTMLButtonElement>(".chat-note-pill-main")!;
    const items = [...menu.querySelectorAll<HTMLButtonElement>(".chat-note-preset-item")];
    expect(menu.hidden).toBe(true);
    expect(toggle.getAttribute("aria-controls")).toBe(menu.id);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    clickOnce(toggle);
    expect(menu.hidden).toBe(false);
    expect(onOpenMenu).toHaveBeenCalledTimes(1);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).not.toBe(items[0]);

    const tutorialItem = menu.querySelector<HTMLButtonElement>("[data-note-preset='tutorial']")!;
    clickOnce(tutorialItem);
    expect(menu.hidden).toBe(true);
    expect(mainBtn.textContent).toBe("生成视频笔记 · 教程实操");
    expect(tutorialItem.getAttribute("aria-checked")).toBe("true");
    expect(state.settings.notePromptPreset).toBe("tutorial");
    expect(onPresetChange).toHaveBeenCalledWith("tutorial");
    expect(sentMessages).toContainEqual({
      type: "save-settings",
      settings: { notePromptPreset: "tutorial" }
    });

    toggle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(false);
    expect(document.activeElement).toBe(items[0]);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[items.length - 1]);

    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(items[0]);

    bar.handleEscapeKey(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
    expect(menu.hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);

    clickOnce(toggle);
    expect(menu.hidden).toBe(false);
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    expect(menu.hidden).toBe(true);

    clickOnce(toggle);
    expect(menu.hidden).toBe(false);
    clickOnce(outside);
    expect(menu.hidden).toBe(true);

    vi.unstubAllGlobals();
  });

  it("独立窗口跨文档 Realm 下可正常挂载、展开菜单、切换预设并响应外部点击关闭", () => {
    const realm = createDetachedRealm();
    try {
      const host = realm.doc.createElement("div");
      host.id = "detached-chat-note-bar";
      host.hidden = true;
      const outside = realm.doc.createElement("div");
      realm.doc.body.append(host, outside);
      const onPickVideoNote = vi.fn();
      const bar = createChatNoteBar({
        host,
        hasSelectableModels: () => true,
        onPickVideoNote
      });

      bar.refresh();

      const pill = host.querySelector<HTMLElement>(".chat-note-split-pill")!;
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
