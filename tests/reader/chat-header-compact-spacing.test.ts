// tests/reader/chat-header-compact-spacing.test.ts
// 2026-10 用户决议（截图）：头部只剩两个 32px 高的操作键，而头部盒仍是
// min-height 42px + padding 6px/8px——「历史对话」上下各空出一截。头部盒收为
// 控件等高（32px），上下留白收到 2px / 4px（上方 = 2 + 面板 tab-body 的 14px，
// 下方 = 4 + 消息区的 12px，两侧视觉几乎对称）。
// 不在收紧范围：.biliscript-reading-tab-body 的 14px 顶部内边距是三个 tab
//（字幕/概览/对话）共用的板面留白，属 reader.css 域。
// 形状同 chat-header-context-chip-removed：直接断言 CSS 文本，防「改一半」
//（只改 min-height 忘 padding，或反过来）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";

function chatHeaderBlock(): string {
  const css = readFileSync(join(ROOT, CHAT_CSS), "utf8");
  const match = css.match(/\.biliscript-reading-chat \.chat-header \{([^}]*)\}/);
  expect(match, "reader-chat.css 中应存在 .chat-header 规则块").not.toBe(null);
  return match![1];
}

describe("对话头部工具条紧凑化", () => {
  it("头部盒与最高控件（32px 操作键）等高，不再有 42px 的额外高度", () => {
    expect(chatHeaderBlock()).toMatch(/min-height:\s*32px;/);
  });

  it("上下留白收到 2px / 4px", () => {
    expect(chatHeaderBlock()).toMatch(/padding:\s*2px 0 4px;/);
  });
});
