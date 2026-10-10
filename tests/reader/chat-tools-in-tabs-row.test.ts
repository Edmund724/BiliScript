// tests/reader/chat-tools-in-tabs-row.test.ts
// 对话工具键并入壳标签行（方案对比 .scratch/chat-top-layout 选定「头部归并」）：
// 「历史对话 / 新会话」两键从对话 tab 内的工具条整行搬到壳（ui-renderer）的
// 标签行右侧（.biliscript-reading-tabs-tools），与分段控件同一行。
//
// 形状同其它 CSS/模板契约测试：直接断言文本与 DOM 结构，防「改一半」——
//   1. 模板搬了键、reader-chat.css 留着 .chat-header 死规则：旧形态回流；
//   2. 只搬键、忘了「仅对话 tab 激活可见」的 :has 规则：字幕/概览 tab 上露出
//      两个对话语义的键；
//   3. 两键不用 .biliscript-reading-icon-btn：对话样式按需装载，壳上的键在样式
//      未挂载时会裸奔（且与 header 三键不同形）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const READER_CSS = "extension/entry/styles/reader.css";
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const CHAT_TEMPLATE = "extension/reader/chat-template.ts";
const UI_RENDERER = "extension/ui/ui-renderer.ts";

function readSrc(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

describe("对话工具键并入壳标签行", () => {
  it("壳模板：标签行 = 分段控件 + 工具组（历史对话、新会话，顺序即契约）", () => {
    const tpl = readSrc(UI_RENDERER);

    const row = tpl.match(/<div class="biliscript-reading-tabs-row">([\s\S]*?)<\/div>\s*<\/div>/);
    expect(row, "壳模板应有 .biliscript-reading-tabs-row").not.toBe(null);
    expect(row![1]).toMatch(/class="biliscript-reading-tabs"/);

    const tools = row![1].match(/<div class="biliscript-reading-tabs-tools">([\s\S]*)/);
    expect(tools, "标签行内应有 .biliscript-reading-tabs-tools").not.toBe(null);
    const btnIds = [...tools![1].matchAll(/id="\$\{ids\.(readingChat\w+Btn)\}"/g)].map((m) => m[1]);
    expect(btnIds).toEqual(["readingChatHistoryBtn", "readingChatNewBtn"]);

    // 外观复用面板 header 三键的无框幽灵键（壳常驻样式，不依赖按需装载的对话分区表）
    const buttons = [...tools![1].matchAll(/<button[^>]*>/g)].map((m) => m[0]);
    for (const btn of buttons) {
      expect(btn).toMatch(/class="biliscript-reading-icon-btn"/);
    }
    expect(tools![1]).toMatch(/aria-label="历史对话"/);
    expect(tools![1]).toMatch(/aria-label="开启新会话"/);
  });

  it("对话模板：工具条整行退役，chat-template 不再有 chat-header 与这两枚按钮", () => {
    const tpl = readSrc(CHAT_TEMPLATE);

    expect(tpl).not.toMatch(/chat-header/);
    expect(tpl).not.toMatch(/ids\.readingChatHistoryBtn/);
    expect(tpl).not.toMatch(/ids\.readingChatNewBtn/);
  });

  it("reader-chat.css 不再有 .chat-header 规则（唯一消费方已退役）", () => {
    expect(readSrc(CHAT_CSS)).not.toMatch(/\.chat-header/);
  });

  it("reader.css：标签行壳占网格第 3 行，分段控件在行内吃满剩余宽度", () => {
    const css = readSrc(READER_CSS);

    expect(ruleBody(css, "\\.biliscript-reading-tabs-row")).toMatch(/grid-row:\s*3;/);
    expect(ruleBody(css, "\\.biliscript-reading-tabs")).toMatch(/flex:\s*1;/);
    expect(ruleBody(css, "\\.biliscript-reading-tabs-tools")).toMatch(/flex:\s*0 0 auto;/);
  });

  it("工具键仅在 AI 对话 tab 激活时可见（:has 纯 CSS 反应，不引 JS 状态）", () => {
    const css = readSrc(READER_CSS);

    expect(css).toMatch(
      /\.biliscript-reading-script-panel:not\(:has\(#biliscript-reading-tab-chat\.is-active\)\) \.biliscript-reading-tabs-tools\s*\{[^}]*display:\s*none;/
    );
  });

  it("配色只走 token：标签行相关规则不写死色值", () => {
    const css = readSrc(READER_CSS);

    expect(ruleBody(css, "\\.biliscript-reading-tabs-row")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(ruleBody(css, "\\.biliscript-reading-tabs-tools")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
