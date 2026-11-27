import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";
import { mountPlayerChain } from "../helpers/reader-skeleton.js";
import type { TestState } from "./reader-test-env.js";

let state: TestState;
let reader: typeof import("../../extension/reader/index.js");
let ids: typeof import("../../extension/reader/state.js").ids;
let readerState: typeof import("../../extension/reader/state.js");
let uiRenderer: typeof import("../../extension/ui/ui-renderer.js");

async function loadModules() {
  setLocationUrl(READER_MODE_URL);
  state = (await import("../../extension/core/state.js")).state as TestState;
  reader = await import("../../extension/reader/index.js");
  readerState = await import("../../extension/reader/state.js");
  ids = readerState.ids;
  uiRenderer = await import("../../extension/ui/ui-renderer.js");
}

function seedSubtitleBody() {
  state.clip.subtitleBody = [
    { from: 0, to: 10, content: "大家好" },
    { from: 10, to: 30, content: "今天讲测试" }
  ];
}

function tabButton(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTab${name}`]) as HTMLElement;
}

function tabBody(name: "Subtitle" | "Overview" | "Chat") {
  return document.getElementById(ids[`readingTabBody${name}`]) as HTMLElement;
}

function expectTabActive(name: "Subtitle" | "Overview" | "Chat", active: boolean) {
  expect(tabBody(name).classList.contains("is-active"), `${name} body is-active`).toBe(active);
  expect(tabBody(name).hasAttribute("hidden"), `${name} body hidden`).toBe(!active);
  expect(tabButton(name).classList.contains("is-active"), `${name} button is-active`).toBe(active);
  expect(tabButton(name).getAttribute("aria-selected"), `${name} aria-selected`).toBe(
    active ? "true" : "false"
  );
}

beforeEach(async () => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-reader-mode");
  document.body.removeAttribute("data-biliscript-reader-mode");
  await loadModules();
  uiRenderer.ensureUiReady({ forceRecreate: true });
  mountPlayerChain();
});

afterEach(async () => {
  try {
    reader.stopReadingViewSync();
    reader.closeReadingView();
  } catch {
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("统一 文摘面板三标签", () => {
  it("A. 壳结构：三 tab 与 tab body 存在，字幕列表挂在字幕 tab body 内", () => {
    expect(document.getElementById(ids.readingScriptPanel)).not.toBe(null);
    expect(tabButton("Subtitle")).not.toBe(null);
    expect(tabButton("Overview")).not.toBe(null);
    expect(tabButton("Chat")).not.toBe(null);

    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    expect(subtitleList.parentElement).toBe(tabBody("Subtitle").querySelector(".biliscript-reading-main"));
    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);
  });

  it("B. 概览 tab（PR4 状态机宿主）保持诚实空态；AI 对话 tab（PR5）为静默真壳", () => {
    const overviewBody = document.getElementById(ids.readingOverviewBody) as HTMLElement;
    expect(overviewBody).not.toBe(null);
    const overviewCopy = tabBody("Overview").textContent || "";
    expect(overviewCopy).toContain("概览还未生成");
    expect(overviewBody.querySelector(".biliscript-reading-ov-chapter, .biliscript-reading-ov-quote")).toBe(null);
    expect(tabBody("Overview").querySelector("input, textarea, button, select")).toBe(null);

    const chatRoot = document.getElementById(ids.readingChatRoot) as HTMLElement;
    expect(chatRoot).not.toBe(null);
    expect(document.getElementById(ids.readingChatMessages)).not.toBe(null);
    expect(document.getElementById(ids.readingChatInput)).not.toBe(null);
    expect(document.getElementById(ids.readingChatModelChip)).not.toBe(null);
    expect(document.getElementById(ids.readingChatModelPanel)).not.toBe(null);
    expect(document.getElementById("biliscript-reading-chat-model-select")).toBe(null);
    expect(document.getElementById(ids.readingChatHistoryBtn)).not.toBe(null);
    expect(document.getElementById(ids.readingChatSendBtn)).not.toBe(null);
    expect(document.getElementById("biliscript-reading-chat-preset-btn")).toBe(null);
    expect(document.getElementById("biliscript-reading-chat-preset-popover")).toBe(null);
    const toolsBtn = document.getElementById(ids.readingChatToolsBtn) as HTMLButtonElement;
    const toolsMenu = document.getElementById(ids.readingChatToolsMenu) as HTMLElement;
    expect(toolsBtn.querySelector("svg")).not.toBe(null);
    expect(toolsBtn.getAttribute("aria-expanded")).toBe("false");
    expect(toolsMenu.hidden).toBe(true);
    const searchPill = document.getElementById(ids.readingChatWebSearchPill) as HTMLButtonElement;
    expect(toolsMenu.contains(searchPill)).toBe(true);
    expect(searchPill.querySelector("svg")).not.toBe(null);
    expect(searchPill.textContent?.trim()).toBe("联网搜索");
    expect(searchPill.getAttribute("aria-label")).toBe("联网搜索");
    expect([...searchPill.querySelectorAll(".chat-web-search-meridian")].map((p) => p.classList[1])).toEqual([
      "chat-web-search-meridian-a",
      "chat-web-search-meridian-b",
      "chat-web-search-meridian-c",
    ]);
    expect(searchPill.querySelector("svg > circle")?.getAttribute("r")).toBe("10");
    const chatMessages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(chatMessages.querySelectorAll(".chat-msg, .chat-center-error").length).toBe(0);
    expect((chatMessages.querySelector(".chat-suggestions") as HTMLElement).innerHTML).toBe("");
    expect(((document.getElementById(ids.readingChatInput) as HTMLTextAreaElement).value) || "").toBe("");
    expect((document.getElementById(ids.readingChatInput) as HTMLTextAreaElement).getAttribute("rows")).toBe("1");
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
  });

  it("C. 点击 tab 按钮：三通道（is-active/aria-selected/hidden）一致切换，并写穿持久化", async () => {
    uiRenderer.bindUiEvents();
    vi.mocked(chrome.storage.local.set).mockClear();

    (tabButton("Overview") as HTMLButtonElement).click();
    await vi.waitFor(() => expectTabActive("Overview", true));
    expectTabActive("Subtitle", false);
    expectTabActive("Chat", false);
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenCalledWith({
      readerActiveScriptTab: "overview"
    });

    (tabButton("Chat") as HTMLButtonElement).click();
    await vi.waitFor(() => expectTabActive("Chat", true));
    expectTabActive("Overview", false);

    (tabButton("Subtitle") as HTMLButtonElement).click();
    await vi.waitFor(() => expectTabActive("Subtitle", true), { timeout: 5000 });
    expectTabActive("Chat", false);
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      readerActiveScriptTab: "subtitle"
    });
  });

  it("D1. 进入阅读模式：恢复上次所在标签（概览）——刷新不跳回字幕", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ readerActiveScriptTab: "overview" });

    await reader.enterReaderMode();

    expect(state.reader.readingViewOpen).toBe(true);
    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expectTabActive("Chat", false);
    expect(readerState.isReadingSubtitleBodyVisible()).toBe(false);
  });

  it("D2. 进入阅读模式：无持久值回落默认「字幕」tab", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    vi.mocked(chrome.storage.local.get).mockResolvedValue({});

    await reader.enterReaderMode();

    expect(state.reader.readingViewOpen).toBe(true);
    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);
    expect(readerState.isReadingSubtitleBodyVisible()).toBe(true);

    const subtitleList = document.getElementById(ids.readingSubtitleList) as HTMLElement;
    expect(subtitleList.querySelectorAll(".biliscript-reading-item").length).toBe(2);
  });

  it("D3. 进入阅读模式：脏持久值回落「字幕」tab（不把未知值当标签）", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ readerActiveScriptTab: "ghost" });

    await reader.enterReaderMode();

    expectTabActive("Subtitle", true);
    expect(readerState.isReadingSubtitleBodyVisible()).toBe(true);
  });

  it("E. 视图开着期间重渲（切轨/subtitle-ready）不重置所在 tab", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");

    await reader.enterReaderMode();
    (tabButton("Overview") as HTMLButtonElement).click();
    await vi.waitFor(() => expectTabActive("Overview", true));

    reader.renderReadingView();

    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expect(readerState.isReadingSubtitleBodyVisible()).toBe(false);
  });
});
