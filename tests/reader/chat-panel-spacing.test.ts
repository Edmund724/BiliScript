// tests/reader/chat-panel-spacing.test.ts
// 对话面板纵向间距契约（「头部归并」后的几何）：
// 工具键并入壳标签行后，对话面板内不再有工具条行——首行内容（意图卡 / 转写行 /
// 消息区）与上方白卡边的间隔由 tab-body 的板面顶距覆写（10px）单一承担，
// 各块不再自备顶距（防叠成双倍）；消息区顶部渐隐保留（滚动内容淡出而非硬切）。
//
// 局限：jsdom 无布局，本文件只锁 CSS 取值与作用域，真实几何由浏览器实测兜底。
// 防倒退：板面顶距回到无作用域写法（字幕/概览首行被一起下推）、任一块再自备
// 顶距、渐隐被删或写上主题色，本文件红。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const READER_CSS = "extension/entry/styles/reader.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector} \\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

// 对话面板的板面顶距覆写（只命中对话面板，字幕/概览两 tab 不受影响）。
function chatPanelPaddingTop(): string {
  const match = readCss(CHAT_CSS).match(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\) \{([^}]*)\}/s);
  expect(match, "reader-chat.css 中应有对话面板的板面内边距覆写规则").not.toBe(null);
  const paddingTop = match![1].match(/padding-top:\s*([^;]+);/);
  expect(paddingTop, "板面覆写规则里应有 padding-top 声明").not.toBe(null);
  return paddingTop![1].trim();
}

// 某条规则的纵向顶距：简写 `margin` 的首值（缺省即 0），或显式 `margin-top`。
function topGap(block: string): string {
  const shorthand = block.match(/(?:^|;)\s*margin:\s*([^;]+);/);
  if (shorthand) {
    return shorthand[1].trim().split(/\s+/)[0];
  }
  const marginTop = block.match(/(?:^|;)\s*margin-top:\s*([^;]+);/);
  return marginTop ? marginTop[1].trim() : "0px";
}

function px(value: string): number {
  expect(value, `间距应是 px 字面值（0 可省单位）：${value}`).toMatch(/^-?\d+(\.\d+)?(px)?$/);
  return Number.parseFloat(value);
}

// 消息区规则块（渐隐遮罩的唯一落点）。
function chatMessagesBlock(): string {
  return ruleBody(readCss(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-messages");
}

function maskImage(block: string, prop: "mask-image" | "-webkit-mask-image"): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `消息区应有 ${prop} 顶部渐隐声明`).not.toBe(null);
  return match![1].trim();
}

// 渐隐长度：从 transparent 0 淡到 #000 <N>px，返回 N。
function fadeLength(block: string): number {
  const mask = maskImage(block, "mask-image").replace(/\s+/g, " ");
  const match = mask.match(/^linear-gradient\(to bottom, transparent 0(?:px)?, #000 (\d+(?:\.\d+)?)px\)$/);
  expect(match, `渐隐应是 transparent → #000 的纵向渐变（无色值）：${mask}`).not.toBe(null);
  return Number.parseFloat(match![1]);
}

const SAME_DECK_MIN = 8;
const SAME_DECK_MAX = 16;

describe("对话面板纵向间距（头部归并后）", () => {
  it("对话面板板面顶距保持同档留白（首行内容不贴白卡顶边）", () => {
    const paddingTop = px(chatPanelPaddingTop());

    expect(paddingTop).toBeGreaterThanOrEqual(SAME_DECK_MIN);
    expect(paddingTop).toBeLessThanOrEqual(SAME_DECK_MAX);
  });

  it("板面顶距覆写仍只作用域对话面板（字幕/概览两 tab 保持 reader.css 的板面留白）", () => {
    const css = readCss(CHAT_CSS);

    expect(css).toMatch(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\)\s*\{[^}]*padding-top:/s);
    // 无作用域的 `.biliscript-reading-tab-body { … padding-top: … }` 覆写会把
    // 字幕/概览面板的首行正文一起下推，禁止出现。
    expect(css).not.toMatch(/\.biliscript-reading-tab-body\s*(?:,|\{)[^{}]*\{[^}]*\bpadding-top:/s);
  });

  it("意图卡 / 转写行不自备顶距：上方间隔只由板面顶距一处承担，不叠成双倍", () => {
    const intentBlock = ruleBody(readCss(READER_CSS), "\\.biliscript-reading-chat-intent");
    const asrBlock = ruleBody(readCss(CHAT_CSS), "\\.biliscript-reading-chat \\.chat-asr-notice");

    expect(px(topGap(intentBlock))).toBe(0);
    expect(px(topGap(asrBlock))).toBe(0);
  });

  it("消息区顶部有同档长度的渐隐：滚动的硬切变成淡出", () => {
    const length = fadeLength(chatMessagesBlock());

    expect(length).toBeGreaterThanOrEqual(SAME_DECK_MIN);
    expect(length).toBeLessThanOrEqual(SAME_DECK_MAX);
  });

  it("渐隐前缀双写且数值一致（-webkit- 与标准属性同值）", () => {
    const block = chatMessagesBlock();
    const standard = maskImage(block, "mask-image").replace(/\s+/g, " ");
    const prefixed = maskImage(block, "-webkit-mask-image").replace(/\s+/g, " ");

    expect(prefixed).toBe(standard);
  });

  it("渐隐只挂在消息区：对话根不被遮罩", () => {
    const root = ruleBody(readCss(CHAT_CSS), "\\.biliscript-reading-chat");

    expect(root).not.toMatch(/-?webkit-?mask|mask-image/);
  });

  it("渐隐用无色 stop（transparent / #000），不写死主题色 → 暗色不破相", () => {
    const standard = maskImage(chatMessagesBlock(), "mask-image");

    expect(standard).not.toMatch(/var\(/);
    expect(standard).not.toMatch(/rgba?\(/);
    // 只允许 #000（透明 → 黑的无色遮罩）；出现别的色值就是写死了主题色
    expect(standard.replace(/#000\b/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});
