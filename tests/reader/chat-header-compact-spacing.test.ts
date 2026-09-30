// tests/reader/chat-header-compact-spacing.test.ts
// 2026-10 用户决议（截图，两轮）：头部只剩两个 32px 高的操作键，而头部盒仍是
// min-height 42px + padding 6px/8px——「历史对话」上下各空出一截。第一轮把头部盒
// 收为控件等高（32px）+ 上下留白 2px/4px，但上方仍空：上面的空档除头部自身 2px 外
// 还有 .biliscript-reading-tab-body 给三个 tab 共用的 14px 板面顶距。第二轮在
// reader-chat.css 里按对话面板（:has(> .biliscript-reading-chat)）把它单独收到 4px
// ——对话面板首行是工具条而非正文，不需要正文级的板面留白；字幕/概览两 tab 的
// 14px 不动（规则在 reader.css 域）。
// 形状同 chat-header-context-chip-removed：直接断言 CSS 文本，防「改一半」
//（只改 min-height 忘 padding、或只改头部忘上方板面顶距）。
// 2026-10 第三轮（工具条加框）与第四轮（改分成两个槽，见 chat-header-toolbox.test.ts）：
// 头部盒的 0/4 左右内边距与 2/4 上下留白先后被槽/双槽的边框取代——纵向总高仍是
// 38px（旧 2 + 32 + 4，今 2 + 34 + 2，两键各 34px = 32 + 上下 1px 边框），本条断言的
// 「无额外纵高」意图不变，故这里断行内对称留白 2px 0。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";

function readChatCss(): string {
  return readFileSync(join(ROOT, CHAT_CSS), "utf8");
}

function chatHeaderBlock(): string {
  const match = readChatCss().match(/\.biliscript-reading-chat \.chat-header \{([^}]*)\}/);
  expect(match, "reader-chat.css 中应存在 .chat-header 规则块").not.toBe(null);
  return match![1];
}

describe("对话头部工具条紧凑化", () => {
  it("头部盒与最高控件（32px 操作键）等高，不再有 42px 的额外高度", () => {
    expect(chatHeaderBlock()).toMatch(/min-height:\s*32px;/);
  });

  it("行内留白对称 2px 0：加两键各 1px 边框后总高仍是 38px，无额外纵高", () => {
    expect(chatHeaderBlock()).toMatch(/padding:\s*2px 0;/);
  });

  it("对话面板的板面顶距单独收到 4px（首行是工具条，不留正文级 14px）", () => {
    const match = readChatCss().match(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\) \{([^}]*)\}/s);

    expect(match, "reader-chat.css 中应有对话面板的板面内边距覆写规则").not.toBe(null);
    expect(match![1]).toMatch(/padding-top:\s*4px;/);
  });
});
