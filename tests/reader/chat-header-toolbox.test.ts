// tests/reader/chat-header-toolbox.test.ts
// 2026-10 用户决议（截图，第三轮）：删掉视频标题 chip 后，工具条只剩「历史对话」+
// 「新会话」两个裸控件，和下方消息正文糊成一片（用户报「应该有个框什么的，确保设计的
// 一致性」）。据此把工具条收进一个「槽」：1px 边框 + surface 底 + 全圆角胶囊，只包住
// 两键；母题同上方 .biliscript-reading-tabs 分段控件（凹槽 + 槽内控件）与下方
// .chat-input-card（border + surface 卡片），不引入新的视觉语言。
// 形状同 chat-header-compact-spacing：直接断言 CSS 文本，防「改一半」——
//   1. 只给按钮各加框：两个控件各一个框，控件组仍不成组；
//   2. 加了框但没 align-self：flex 列里默认 stretch，槽横贯整行，与上方分段控件打架；
//   3. 只收窄不给底/边框：框看不见，问题原样；
//   4. 写死色值：暗色主题破相（token 在 reader-gate.css 两主题定义）；
//   5. 纵向总高被改：旧 2 + 32 + 4 = 38px，新 1 + 2 + 32 + 2 + 1 = 38px，消息区高度
//      必须不变（chat-header-compact-spacing 的「消空档」决议仍然成立——原位换成框）；
//   6. 槽内图标键不跟随胶囊圆角：8px 方角贴在 999px 槽端会露角。
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

describe("对话头部工具条的槽容器", () => {
  it("槽有可见的框：1px 边框 + surface 底 + 胶囊圆角", () => {
    const block = chatHeaderBlock();

    expect(block).toMatch(/border:\s*1px solid var\(--biliscript-reader-border\);/);
    expect(block).toMatch(/background:\s*var\(--biliscript-reader-surface\);/);
    expect(block).toMatch(/border-radius:\s*999px;/);
  });

  it("槽只包住两键，不横贯整行（flex 列里 align-self 默认 stretch）", () => {
    expect(chatHeaderBlock()).toMatch(/align-self:\s*flex-end;/);
  });

  it("纵向总高与改前一致：min-height 32px + 对称内边距 2px/4px（旧 2+32+4）", () => {
    const block = chatHeaderBlock();

    expect(block).toMatch(/min-height:\s*32px;/);
    expect(block).toMatch(/padding:\s*2px 4px;/);
  });

  it("槽内图标键跟随胶囊圆角（8px 方角贴在 999px 槽端会露角）", () => {
    const match = readChatCss().match(/\.biliscript-reading-chat \.chat-header \.chat-icon-btn \{([^}]*)\}/);

    expect(match, "reader-chat.css 中应有槽内图标键的圆角覆写规则").not.toBe(null);
    expect(match![1]).toMatch(/border-radius:\s*999px;/);
  });

  it("配色只走 token，不写死色值（暗色主题自动跟随）", () => {
    expect(chatHeaderBlock()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
