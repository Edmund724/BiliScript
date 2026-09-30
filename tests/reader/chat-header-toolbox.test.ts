// tests/reader/chat-header-toolbox.test.ts
// 头部工具条的按钮框契约，三轮用户决议：
//   第三轮（2026-10）：删视频标题 chip 后工具条只剩「历史对话」+「新会话」两个裸控件，
//   与下方消息正文糊成一片（用户报「应该有个框」）→ 给工具条加框。
//   第四轮：用户否掉「一个槽装两键」→ 每键各一个框，容器 .chat-header 退回纯布局行
//  （无边框/底色/圆角）。
//   第五轮（本文件当前口径）：用户贴真机截图指出两键（999px 胶囊/圆形）与面板 header
//   的主题/设置/退出三键（.biliscript-reading-icon-btn）不成一致，指定按 flyme-design
//   统一 → 两键改用面板既有的「8px = 一切框」形态（reader.css 明文决议：34px 键高、
//   1px 边框 + surface 底、8px 圆角）。故本文件的核心断言不是字面值，而是**跨文件
//   同值**：聊天工具条两键的圆角/键高必须等于 reader.css 里 header 三键的圆角/键高，
//   文字键横向内边距必须等于 reader.css 里文字动作按钮的内边距——任一侧改了值，
//   一致性就断了，测试报红。
// 形状同 chat-header-compact-spacing：直接断言 CSS 文本，防「改一半」——
//   1. 容器仍留着框：又变回「一个槽装两键」；
//   2. 只给文字键加框、漏了 + ：两键不成对；
//   3. 圆角/键高各写各的字面值：正是用户报的「不一致」，必须与 header 三键同源同值；
//   4. 写死色值：暗色主题破相（token 在 reader-gate.css 两主题定义）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const READER_CSS = "extension/entry/styles/reader.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// 取「选择器 + 声明块」里的声明块；selector 传正则片段（已转义的类名）。
function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function bodyOfRule(rule: string): string {
  const match = rule.match(/\{([^}]*)\}/);
  expect(match, `规则应有声明块：${rule}`).not.toBe(null);
  return match![1];
}

function declaration(block: string, prop: string): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `声明块里应有 ${prop} 声明：${block.trim()}`).not.toBe(null);
  return match![1].trim();
}

// 同一条选择器可能命中多条规则（两键共用的选择器组 + 各自的独立规则），
// 取第一条声明了该属性的——「组规则在前、个别规则在后」是本文件的书写顺序。
function declarationFromRules(css: string, selector: string, prop: string): string {
  const bodies = [...css.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
  for (const body of bodies) {
    const match = body.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
    if (match) {
      return match[1].trim();
    }
  }
  expect.fail(`命中 ${selector} 的规则里应有 ${prop} 声明`);
}

function chatHeaderBlock(): string {
  return ruleBody(readCss(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-header");
}

// 两键共用的框规则（选择器组 + 声明块）。
function headerBoxRule(): string {
  const match = readCss(CHAT_CSS).match(
    /\.biliscript-reading-chat \.chat-header \.chat-toolbar-btn,\s*\.biliscript-reading-chat \.chat-header \.chat-icon-btn \{[^}]*\}/
  );
  expect(match, "reader-chat.css 中应有头部两键共用的框规则").not.toBe(null);
  return match![0];
}

// 面板 header 三键的框基准（reader.css 基础段）。
function panelHeaderKeyBlock(): string {
  return ruleBody(readCss(READER_CSS), "\\.biliscript-reading-icon-btn");
}

// 面板文字动作按钮的框基准（reader.css 基础段：1px 边框 + surface 底 + 15px 字）。
function panelActionButtonBlock(): string {
  return ruleBody(readCss(READER_CSS), "\\.biliscript-reading-actions button");
}

describe("对话头部工具条的按钮框", () => {
  it("容器退回纯布局行，不再自带框（否则又成了「一个槽装两键」）", () => {
    const block = chatHeaderBlock();

    expect(block).not.toMatch(/border:\s*1px/);
    expect(block).not.toMatch(/border-radius:/);
    expect(block).not.toMatch(/background:/);
  });

  it("两键各一个框，选择器组同时命中文字键与图标键", () => {
    const rule = headerBoxRule();

    expect(rule).toMatch(/\.chat-header \.chat-toolbar-btn/);
    expect(rule).toMatch(/\.chat-header \.chat-icon-btn/);
    expect(rule).toMatch(/border:\s*1px solid var\(--biliscript-reader-border\);/);
    expect(rule).toMatch(/background:\s*var\(--biliscript-reader-surface\);/);
  });

  it("圆角与键高同面板 header 三键（reader.css 的「8px = 一切框」/ 34px）", () => {
    const panelKey = panelHeaderKeyBlock();
    const box = bodyOfRule(headerBoxRule());

    expect(declaration(panelKey, "border-radius")).toBe("8px");
    expect(declaration(panelKey, "height")).toBe("34px");
    expect(declaration(box, "border-radius")).toBe(declaration(panelKey, "border-radius"));
    expect(declaration(box, "height")).toBe(declaration(panelKey, "height"));
  });

  it("图标键是方键：宽高同面板 header 三键（34 × 34）", () => {
    const panelKey = panelHeaderKeyBlock();
    const iconWidth = declarationFromRules(
      readCss(CHAT_CSS),
      "\\.biliscript-reading-chat \\.chat-header \\.chat-icon-btn",
      "width"
    );

    expect(declaration(panelKey, "width")).toBe("34px");
    expect(iconWidth).toBe(declaration(panelKey, "width"));
  });

  it("文字键横向内边距同面板文字动作按钮（不另起一套字面值）", () => {
    const panelActionPadding = declaration(panelActionButtonBlock(), "padding").split(/\s+/);
    const toolbarPadding = declaration(
      ruleBody(readCss(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-header \\.chat-toolbar-btn"),
      "padding"
    ).split(/\s+/);

    expect(panelActionPadding[1]).toBe("14px");
    expect(toolbarPadding[toolbarPadding.length - 1]).toBe(panelActionPadding[1]);
  });

  it("行仍贴内容宽右对齐（flex 列里 align-self 默认 stretch）", () => {
    const block = chatHeaderBlock();

    expect(block).toMatch(/align-self:\s*flex-end;/);
    expect(block).toMatch(/justify-content:\s*flex-end;/);
  });

  it("配色只走 token，不写死色值（暗色主题自动跟随）", () => {
    expect(chatHeaderBlock()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(headerBoxRule()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
