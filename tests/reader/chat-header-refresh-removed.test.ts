// tests/reader/chat-header-refresh-removed.test.ts
// 2026-09 用户决议：对话头部的刷新键（↻，biliscript-reading-chat-refresh-btn）连同
// 只服务它的后端（点击绑定 → refreshContextManually → 刷新键 loading 态）一并删除。
//
// 三半守卫（防「半删」留孤儿）：
// - 模板（chat-template）：头部工具条只剩上下文 chip / 历史对话 / 新会话，刷新键
//   不再渲染；
// - id 契约表（shared/dom-ids）：readingChatRefreshBtn 不再暴露；
// - CSS（reader-chat.css）：该键专用的 .is-loading 转圈规则与其 @keyframes 一并
//   移除——唯一消费方已不存在。
// 删模板却留着 chat-tab 的 getElementById + addEventListener 会在激活时抛
// TypeError：该回归由 tests/reader/chat-tab.test.ts 的真实壳激活用例兜底，本文件
// 不重复挂载壳。
// 不在删除范围：loadContextState 的 forceRefresh 强刷链（「+」新会话键与上下文
// chip 点击共用），故本文件不对它设断言。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const REFRESH_BTN_ID = "biliscript-reading-chat-refresh-btn";

let ids: typeof import("../../extension/reader/state.js").ids;
let buildChatTabBodyHtml: typeof import("../../extension/reader/chat-template.js").buildChatTabBodyHtml;

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  ids = (await import("../../extension/reader/state.js")).ids;
  buildChatTabBodyHtml = (await import("../../extension/reader/chat-template.js")).buildChatTabBodyHtml;
  document.body.innerHTML = buildChatTabBodyHtml();
});

describe("对话头部刷新键删除（模板）", () => {
  it("头部工具条只剩上下文 chip / 历史对话 / 新会话，刷新键不再渲染", () => {
    const header = document.querySelector(`#${ids.readingChatRoot} > .chat-header`);

    expect(header).not.toBe(null);
    expect(Array.from(header!.children).map((node) => (node as HTMLElement).id)).toEqual([
      ids.readingChatContextChip,
      ids.readingChatHistoryBtn,
      ids.readingChatNewBtn
    ]);
    expect(document.getElementById(REFRESH_BTN_ID)).toBe(null);
  });
});

describe("对话头部刷新键删除（id 契约）", () => {
  it("ids 表不再暴露 readingChatRefreshBtn", () => {
    expect(Object.keys(ids)).not.toContain("readingChatRefreshBtn");
  });
});

describe("对话头部刷新键删除（样式）", () => {
  it("该键专用的 loading 转圈规则与 @keyframes 一并移除（不留孤儿动画）", () => {
    const css = readFileSync(join(ROOT, CHAT_CSS), "utf8");

    expect(css).not.toContain("is-loading");
    expect(css).not.toContain("biliscript-chat-icon-rotate");
  });
});
