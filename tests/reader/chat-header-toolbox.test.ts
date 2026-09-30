// tests/reader/chat-header-toolbox.test.ts
// 头部工具条的「槽」契约，两轮用户决议：
//   第三轮（2026-10）：删掉视频标题 chip 后，工具条只剩「历史对话」+「新会话」两个
//   裸控件，和下方消息正文糊成一片（用户报「应该有个框」）→ 一个槽包住两键。
//   第四轮（2026-10，本文件当前口径）：用户否掉「一个槽装两键」，改为分成两个槽
//   ——每键各一个描边胶囊、彼此独立（用户报「分成两个槽，不要在一个槽里」）。
//   于是容器 .chat-header 退回纯布局行（无边框/底色/圆角），框落在两个按钮上；
//   母题仍是既有语言：1px 边框 + surface 底 + 全圆角胶囊（下方 .chat-input-card
//   的 border + surface，圆角取按钮自身原有的 999px）。
// 形状同 chat-header-compact-spacing：直接断言 CSS 文本，防「改一半」——
//   1. 容器仍留着框：又变回「一个槽装两键」，本决议被推翻；
//   2. 只给文字键加框、漏了 + ：两个槽不成对；
//   3. 漏 align-self：flex 列里默认 stretch，整行被撑满（框虽在按钮上，右对齐仍在，
//      但行盒横贯整行会与上方分段控件打架）；
//   4. 写死色值：暗色主题破相（token 在 reader-gate.css 两主题定义）；
//   5. 纵向总高被改：两键各 34px（32 + 上下 1px 边框），加行内 2px 上下留白 = 38px
//      ——与加槽前的 2 + 32 + 4 逐像素一致（chat-header-compact-spacing 的
//      「消空档」决议仍然成立：原留白位换成描边）。
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

// 双槽规则是「文字键 + 图标键」共用的一条选择器组，取整条规则（选择器组 + 声明块）。
function headerSlotRule(): string {
  const match = readChatCss().match(
    /\.biliscript-reading-chat \.chat-header \.chat-toolbar-btn,\s*\.biliscript-reading-chat \.chat-header \.chat-icon-btn \{([^}]*)\}/
  );
  expect(match, "reader-chat.css 中应有头部两键共用的槽规则").not.toBe(null);
  return match![0];
}

describe("对话头部工具条的两个槽", () => {
  it("容器退回纯布局行，不再自带框（否则又成了「一个槽装两键」）", () => {
    const block = chatHeaderBlock();

    expect(block).not.toMatch(/border:\s*1px/);
    expect(block).not.toMatch(/border-radius:/);
    expect(block).not.toMatch(/background:/);
  });

  it("两键各一个描边胶囊：1px 边框 + surface 底 + 全圆角，选择器组同时命中两键", () => {
    const rule = headerSlotRule();

    expect(rule).toMatch(/\.chat-header \.chat-toolbar-btn/);
    expect(rule).toMatch(/\.chat-header \.chat-icon-btn/);
    expect(rule).toMatch(/border:\s*1px solid var\(--biliscript-reader-border\);/);
    expect(rule).toMatch(/border-radius:\s*999px;/);
    expect(rule).toMatch(/background:\s*var\(--biliscript-reader-surface\);/);
  });

  it("行仍贴内容宽右对齐，两槽之间留 gap（flex 列里 align-self 默认 stretch）", () => {
    const block = chatHeaderBlock();

    expect(block).toMatch(/align-self:\s*flex-end;/);
    expect(block).toMatch(/justify-content:\s*flex-end;/);
    expect(block).toMatch(/gap:\s*5px;/);
  });

  it("纵向总高与加槽前一致：行内对称留白 2px + 两键 34px（32 + 1px 边框两侧）", () => {
    const block = chatHeaderBlock();

    expect(block).toMatch(/min-height:\s*32px;/);
    expect(block).toMatch(/padding:\s*2px 0;/);
  });

  it("配色只走 token，不写死色值（暗色主题自动跟随）", () => {
    expect(chatHeaderBlock()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(headerSlotRule()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
