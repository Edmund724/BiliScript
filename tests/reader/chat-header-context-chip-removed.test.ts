// tests/reader/chat-header-context-chip-removed.test.ts
// AI 对话 tab 不显示视频标题——承载标题的 chip
//（.chat-context-chip / readingChatContextChip）整体删除。
//
// 四半守卫（防「半删」留孤儿，形状同 chat-header-refresh-removed）：
// - 模板（chat-template）：标题 chip 不再渲染（「历史对话 / 新会话」两键已并入
//   壳标签行，结构契约见 chat-tools-in-tabs-row.test.ts）；
// - id 契约表（shared/dom-ids）：readingChatContextChip 不再暴露；
// - 接线（reader/chat-tab + chat/context-load）：不再 getElementById 该节点、不再把
//   chip 注入上下文编排壳——删模板却留着 getElementById + addEventListener 会在激活
//   时抛 TypeError（真实壳激活回归由 tests/reader/chat-tab.test.ts 兜底）；
// - CSS（reader-chat.css）：.chat-context-chip 规则连同 hover/active/mismatch/disabled
//   变体一并移除（唯一消费方已不存在）。
// 不在删除范围：loadContextState 的上下文装载与 forceRefresh 强刷链（「+」新会话键
// 共用），故本文件不对它设断言。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const CHAT_TAB = "extension/reader/chat-tab.ts";
const CONTEXT_LOAD = "extension/chat/context-load.ts";
const CHIP_ID = "biliscript-reading-chat-context-chip";

let ids: typeof import("../../extension/reader/state.js").ids;
let buildChatTabBodyHtml: typeof import("../../extension/reader/chat-template.js").buildChatTabBodyHtml;

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  ids = (await import("../../extension/reader/state.js")).ids;
  buildChatTabBodyHtml = (await import("../../extension/reader/chat-template.js")).buildChatTabBodyHtml;
  document.body.innerHTML = buildChatTabBodyHtml();
});

describe("对话头部标题 chip 删除（模板）", () => {
  it("标题 chip 不再渲染", () => {
    expect(document.getElementById(CHIP_ID)).toBe(null);
    expect(document.querySelector(".chat-context-chip")).toBe(null);
  });
});

describe("对话头部标题 chip 删除（id 契约）", () => {
  it("ids 表不再暴露 readingChatContextChip", () => {
    expect(Object.keys(ids)).not.toContain("readingChatContextChip");
  });
});

describe("对话头部标题 chip 删除（接线）", () => {
  it("组合根与上下文编排壳都不再引用 chip", () => {
    expect(readFileSync(join(ROOT, CHAT_TAB), "utf8")).not.toContain("readingChatContextChip");
    expect(readFileSync(join(ROOT, CONTEXT_LOAD), "utf8")).not.toContain("contextChip");
  });
});

describe("对话头部标题 chip 删除（样式）", () => {
  it("chip 全套规则移除", () => {
    const css = readFileSync(join(ROOT, CHAT_CSS), "utf8");

    expect(css).not.toContain("chat-context-chip");
  });
});
