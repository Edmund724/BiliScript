// 统一 文摘面板三标签（PR2）回归测试：真实模板（ensureUiReady/buildUiHtml）
// + 真实事件绑定（bindUiEvents）。
//
// 覆盖：
//   A. 壳结构契约：面板壳/三 tab 按钮/三 tab body 存在，字幕列表挂在字幕
//      tab body 内（分批渲染的目标容器随搬家保持可用）；
//   B. 概览 tab（PR4 状态机宿主）初始为「未生成」诚实态；AI 对话 tab（PR5）
//      为静默真壳（消息区/输入框等节点齐备，未激活前空态无假数据）；
//   C. tab 切换：点击 tab 按钮（壳上报意图 → 属主写状态位后再投影）→
//      is-active/aria-selected/hidden 三通道一致，字幕 tab 与概览/AI 对话互斥
//      显示；
//   D. 进入阅读模式恢复上次所在标签（2026-10 用户决议：刷新不跳回字幕 tab；
//      当前标签落 chrome.storage.local）；无值/脏值回落「字幕」；
//   E. 视图开着期间 renderReadingView（切轨重渲）不重置 tab——不打断用户
//      所在标签。
//
// 标签激活属主收口后：状态位的直接读口（getReaderActiveScriptTab）已随「写手
// 唯一」收口删除，状态侧断言一律走可见性谓词（isReadingSubtitleBodyVisible 读
// 唯一状态位），投影侧断言走 DOM 三通道。

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
    // ignore
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
    // 模板初值：字幕 tab 默认激活（与 ui-renderer 模板一致）
    expectTabActive("Subtitle", true);
    expectTabActive("Overview", false);
    expectTabActive("Chat", false);
  });

  it("B. 概览 tab（PR4 状态机宿主）保持诚实空态；AI 对话 tab（PR5）为静默真壳", () => {
    // 概览（PR4 落地）：初始为「未生成」诚实态，无假数据；渲染宿主节点存在。
    const overviewBody = document.getElementById(ids.readingOverviewBody) as HTMLElement;
    expect(overviewBody).not.toBe(null);
    const overviewCopy = tabBody("Overview").textContent || "";
    expect(overviewCopy).toContain("概览还未生成");
    expect(overviewBody.querySelector(".biliscript-reading-ov-chapter, .biliscript-reading-ov-quote")).toBe(null);
    expect(tabBody("Overview").querySelector("input, textarea, button, select")).toBe(null);

    // AI 对话（PR5 落地）：真对话 UI 壳（消息区/输入框/模型与思考档/历史），
    // 未激活前保持静默空态——空消息区、无假消息节点、无占位文案。
    const chatRoot = document.getElementById(ids.readingChatRoot) as HTMLElement;
    expect(chatRoot).not.toBe(null);
    expect(document.getElementById(ids.readingChatMessages)).not.toBe(null);
    expect(document.getElementById(ids.readingChatInput)).not.toBe(null);
    expect(document.getElementById(ids.readingChatModelSelect)).not.toBe(null);
    expect(document.getElementById(ids.readingChatHistoryBtn)).not.toBe(null);
    expect(document.getElementById(ids.readingChatSendBtn)).not.toBe(null);
    // 预设提示词入口（输入框左下角「+」）已删除：壳内不再有该触发键与弹层
    expect(document.getElementById("biliscript-reading-chat-preset-btn")).toBe(null);
    expect(document.getElementById("biliscript-reading-chat-preset-popover")).toBe(null);
    // 联网搜索 pill 只留文字：左侧地球图标已去掉，输入行的横向空间让给模型名。
    const searchPill = document.getElementById(ids.readingChatWebSearchPill) as HTMLButtonElement;
    expect(searchPill.querySelector("svg")).toBe(null);
    expect(searchPill.textContent?.trim()).toBe("联网搜索");
    const chatMessages = document.getElementById(ids.readingChatMessages) as HTMLElement;
    expect(chatMessages.querySelectorAll(".chat-msg, .chat-center-error").length).toBe(0);
    expect((chatMessages.querySelector(".chat-suggestions") as HTMLElement).innerHTML).toBe("");
    expect(((document.getElementById(ids.readingChatInput) as HTMLTextAreaElement).value) || "").toBe("");
    // 输入框单行起步（省空间）：未聚焦高度由模板 rows=1 定，聚焦展开见
    // chat-tab.ts 的 autosizeInput（行内 min-height）。
    expect((document.getElementById(ids.readingChatInput) as HTMLTextAreaElement).getAttribute("rows")).toBe("1");
    // 待解释意图引用卡默认隐藏
    expect((document.getElementById(ids.readingChatIntent) as HTMLElement).hidden).toBe(true);
  });

  it("C. 点击 tab 按钮：三通道（is-active/aria-selected/hidden）一致切换，并写穿持久化", async () => {
    // bindUiEvents 由 ensureUiReady 首建时绑定；forceRecreate 后需重绑
    uiRenderer.bindUiEvents();
    vi.mocked(chrome.storage.local.set).mockClear();

    // 点击只上报意图（reader-bus 反向槽），属主写状态位/持久化后才发投影命令
    // 回来——投影是异步落地的，断言前等它落定。
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
    await vi.waitFor(() => expectTabActive("Subtitle", true));
    expectTabActive("Chat", false);
    // 切回字幕同样落盘：否则刷新后会被上一次的非字幕值恢复
    expect(vi.mocked(chrome.storage.local.set)).toHaveBeenLastCalledWith({
      readerActiveScriptTab: "subtitle"
    });
  });

  it("D1. 进入阅读模式：恢复上次所在标签（概览）——刷新不跳回字幕", async () => {
    seedSubtitleBody();
    document.documentElement.setAttribute("data-biliscript-reader-mode", "1");
    document.body.setAttribute("data-biliscript-reader-mode", "1");
    // 唯一输入是持久值：DOM 与状态位由进入链按它重建
    vi.mocked(chrome.storage.local.get).mockResolvedValue({ readerActiveScriptTab: "overview" });

    await reader.enterReaderMode();

    expect(state.reader.readingViewOpen).toBe(true);
    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    expectTabActive("Chat", false);
    // 状态位与 DOM 三通道同源：谓词（唯一状态位）不再判定字幕可见
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

    // 字幕列表在打开后正常渲染进字幕 tab
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
    // 用户切到概览 tab（真实点击路径：壳上报意图 → 属主写状态位 + 投影）
    (tabButton("Overview") as HTMLButtonElement).click();
    await vi.waitFor(() => expectTabActive("Overview", true));

    reader.renderReadingView();

    expectTabActive("Overview", true);
    expectTabActive("Subtitle", false);
    // 重渲不重置：状态位同样保持用户所在标签（谓词读唯一状态位）
    expect(readerState.isReadingSubtitleBodyVisible()).toBe(false);
  });
});
