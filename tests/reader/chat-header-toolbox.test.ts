// tests/reader/chat-header-toolbox.test.ts
// 头部工具条的按钮形态契约：
//   2026-10 第三～五轮：删视频标题 chip 后工具条只剩「历史对话」（文字键）+
//  「新会话」（图标键），先加框、再每键各一个框、再统一成 8px 方框。
//   2026-12 用户决议（本文件当前口径）：「历史对话」由文字键改为时针回溯图标键
//  （方案对比 .scratch/history-icon-compare 选定方案 1），两键与面板 header 三键
//  （主题/设置/退出，.biliscript-reading-icon-btn，reader.css 的「无框幽灵键」明文
//  决议）完全同构——34×34、8px 圆角、无边框无底（悬停才出 surface-2）、图标
//  18px / stroke 1.8、组距同 header 三键（10px）。文字键形态（.chat-toolbar-btn）
//  随之整族退役。早先的边框决议被本轮取代：五键一致性的最新裁决是无框幽灵。
// 故本文件的核心断言不是字面值，而是**跨文件同值**：聊天工具条两键的尺寸/圆角/
// 组距必须等于 reader.css 里 header 三键的同项——任一侧改了值，一致性就断了，
// 测试报红。
// 形状同 chat-header-compact-spacing：直接断言 CSS/模板文本，防「改一半」——
//   1. 模板改了、CSS 留着 .chat-toolbar-btn 死规则：文字键形态回流；
//   2. 只改历史键、漏了组距/描边：五键不成一致；
//   3. 圆角/键高各写各的字面值：必须与 header 三键同源同值；
//   4. 写死色值：暗色主题破相（token 在 reader-gate.css 两主题定义）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const READER_CSS = "extension/entry/styles/reader.css";
const CHAT_TEMPLATE = "extension/reader/chat-template.ts";
const HEADER_ICONS = "extension/ui/reading-header-icons.ts";

function readSrc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// 取「选择器 + 声明块」里的声明块；selector 传正则片段（已转义的类名）。
function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function declaration(block: string, prop: string): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `声明块里应有 ${prop} 声明：${block.trim()}`).not.toBe(null);
  return match![1].trim();
}

function chatHeaderBlock(): string {
  return ruleBody(readSrc(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-header");
}

// 对话头部图标键的覆写规则（尺寸/内边距/颜色）。
function headerIconBtnBlock(): string {
  return ruleBody(readSrc(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-header \\.chat-icon-btn");
}

// 面板 header 三键的基准（reader.css 基础段）。
function panelHeaderKeyBlock(): string {
  return ruleBody(readSrc(READER_CSS), "\\.biliscript-reading-icon-btn");
}

describe("对话头部工具条与面板 header 三键同构（无框幽灵图标键）", () => {
  it("容器退回纯布局行，不再自带框（否则又成了「一个槽装两键」）", () => {
    const block = chatHeaderBlock();

    expect(block).not.toMatch(/border:\s*1px/);
    expect(block).not.toMatch(/border-radius:/);
    expect(block).not.toMatch(/background:/);
  });

  it("模板：「历史对话」是图标键（chat-icon-btn + svg），不再是文字键", () => {
    const tpl = readSrc(CHAT_TEMPLATE);

    expect(tpl).not.toMatch(/chat-toolbar-btn/);
    const historyBtn = tpl.match(/id="\$\{ids\.readingChatHistoryBtn\}"[^>]*>([\s\S]*?)<\/button>/);
    expect(historyBtn, "模板里应有历史对话按钮").not.toBe(null);
    expect(historyBtn![0]).toMatch(/class="chat-icon-btn"/);
    expect(historyBtn![1]).toMatch(/<svg/);
    // 图标键没有可见文字，可访问名必须由 aria-label 承担
    expect(historyBtn![0]).toMatch(/aria-label="历史对话"/);
  });

  it("文字键形态整族退役：reader-chat.css 不再有任何 .chat-toolbar-btn 规则", () => {
    expect(readSrc(CHAT_CSS)).not.toMatch(/\.chat-toolbar-btn/);
  });

  it("键尺寸同面板 header 三键（34 × 34）", () => {
    const panelKey = panelHeaderKeyBlock();
    const box = headerIconBtnBlock();

    expect(declaration(panelKey, "width")).toBe("34px");
    expect(declaration(panelKey, "height")).toBe("34px");
    expect(declaration(box, "width")).toBe(declaration(panelKey, "width"));
    expect(declaration(box, "height")).toBe(declaration(panelKey, "height"));
  });

  it("圆角同面板 header 三键（8px，继承自基础段 .chat-icon-btn）", () => {
    const panelKey = panelHeaderKeyBlock();
    const base = ruleBody(readSrc(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-icon-btn");

    expect(declaration(panelKey, "border-radius")).toBe("8px");
    expect(declaration(base, "border-radius")).toBe(declaration(panelKey, "border-radius"));
  });

  it("无框幽灵：头部图标键规则块不声明边框与底色（悬停底由 .chat-icon-btn:hover 承担）", () => {
    const box = headerIconBtnBlock();

    expect(box).not.toMatch(/border:/);
    expect(box).not.toMatch(/background:/);
    expect(declaration(panelHeaderKeyBlock(), "border")).toBe("0");
  });

  it("图标规格同 header 三键：18px + stroke 1.8（READING_HEADER_ICONS 同源）", () => {
    const chatSvg = ruleBody(
      readSrc(CHAT_CSS),
      "\\.biliscript-reading-chat \\.chat-header \\.chat-icon-btn svg"
    );
    const panelSvg = ruleBody(readSrc(READER_CSS), "\\.biliscript-reading-icon-btn svg");

    expect(declaration(chatSvg, "width")).toBe(declaration(panelSvg, "width"));
    expect(declaration(chatSvg, "stroke-width")).toBe("1.8");
    // header 三键图标字面量同步用 1.8，防两侧各写各的
    expect(readSrc(HEADER_ICONS)).toMatch(/stroke-width="1\.8"/);
  });

  it("组距同 header 三键（面板内 .biliscript-reading-actions 的有效 gap），且无负 margin 收紧规则", () => {
    // 生效值在面板作用域覆写段（基础段 8px 被 #biliscript-reading-view 覆写为 10px）
    const actionsBlock = ruleBody(readSrc(READER_CSS), "#biliscript-reading-view \\.biliscript-reading-actions");

    expect(declaration(chatHeaderBlock(), "gap")).toBe(declaration(actionsBlock, "gap"));
    expect(readSrc(CHAT_CSS)).not.toMatch(/\.chat-icon-btn\s*\+\s*\.chat-icon-btn/);
  });

  it("行仍贴内容宽右对齐（flex 列里 align-self 默认 stretch）", () => {
    const block = chatHeaderBlock();

    expect(block).toMatch(/align-self:\s*flex-end;/);
    expect(block).toMatch(/justify-content:\s*flex-end;/);
  });

  it("配色只走 token，不写死色值（暗色主题自动跟随）", () => {
    expect(chatHeaderBlock()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(headerIconBtnBlock()).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
