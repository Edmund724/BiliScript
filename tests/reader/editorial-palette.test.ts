// tests/reader/editorial-palette.test.ts
// editorial 数字刊物色板的 CSS 契约（01 号票）：色板是与明暗正交的第二根轴，
// gate 表在 flyme 两档之后按属性选择器分层覆写。本文件锁四点：
//
// 1. 浅色块（[data-palette="editorial"]）：暖纸底 #faf7f2 三层纸面 + 赤陶
//    accent #b85435 + 暖边框，表面/卡片/文字/强调/边框令牌齐全（正文对比
//    经 luminance 手算：text 三层 ≥11.8、muted 最洼层 4.57，均过 4.5 线）。
// 2. 深色块（[data-theme="dark"][data-palette="editorial"]）：暖炭黑 #171513
//    三层 + 暖赤陶 accent #e07a5f，令牌同样齐全。
// 3. 纸感：两块的 mist-blobs 均为 none、mist-filter 均为 none（移除蓝雾
//    径向光斑），壳直落纸面渐变。
// 4. 字体：editorial 衬线只覆盖概览组标题；章节使用中字重无衬线栈，
//    金句使用本地 Noto Serif，色板切换不改变阅读字形；
//    时间戳浅色文字档 time-color 在 flyme 柔和中蓝 / editorial 深赤陶两档
//    各有一份定义（消费规则只引用 token，字面色不进 reader.css）。
//
// 局限同 flyme-panel-layering.test.ts：jsdom 无布局，本文件只锁 CSS 源文本，
// 真实观感回归由人工/真机预览兜。
// 防倒退：editorial 块漏令牌（回落 flyme 蓝）、光斑复辟、衬线规则丢消费方、
// 时间戳字面色回流 hard-code，本文件红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const READER_CSS = "extension/entry/styles/reader.css";
const GATE_CSS = "extension/entry/styles/reader-gate.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// 主题块定位：gate 段每个色板块的最后一个选择器是 #biliscript-reading-view 形态，
// 按结尾特征区分块（与 flyme-panel-layering.test.ts 同口径）。
function themeBlock(tailSelector: string): string {
  const text = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((rule) => rule.split("{")[0].trimEnd().endsWith(tailSelector));
  expect(hit, `应存在以 ${tailSelector} 结尾的主题块`).not.toBe(undefined);
  return hit!.split("{")[1];
}

const EDITORIAL_LIGHT = themeBlock("#biliscript-reading-view[data-palette=\"editorial\"]");
const EDITORIAL_DARK = themeBlock("#biliscript-reading-view[data-theme=\"dark\"][data-palette=\"editorial\"]");

// 表面/卡片/文字/强调/边框令牌齐全性的最小清单（其余组件级 token 不在此锁）。
const REQUIRED_TOKENS = [
  "--biliscript-reader-surface:",
  "--biliscript-reader-surface-2:",
  "--biliscript-reader-surface-3:",
  "--biliscript-reader-card:",
  "--biliscript-reader-border:",
  "--biliscript-reader-text:",
  "--biliscript-reader-muted:",
  "--biliscript-reader-faint:",
  "--biliscript-reader-accent:",
  "--biliscript-reader-accent-soft:",
  "--biliscript-reader-accent-ink:"
];

describe("editorial 数字刊物色板", () => {
  it("浅色块：暖纸底 + 暖米书摘卡 + 赤陶点缀，五族令牌齐全", () => {
    expect(EDITORIAL_LIGHT).toContain("--biliscript-reader-surface: var(--biliscript-primitive-color-paper-50)");
    expect(EDITORIAL_LIGHT).toContain("--biliscript-reader-card: var(--biliscript-primitive-color-paper-100)");
    expect(EDITORIAL_LIGHT).toContain("--biliscript-reader-border: var(--biliscript-primitive-color-paper-300)");
    expect(EDITORIAL_LIGHT).toContain("--biliscript-reader-mist-line: var(--biliscript-primitive-color-paper-250)");
    expect(EDITORIAL_LIGHT).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-terracotta-500)");
    for (const token of REQUIRED_TOKENS) {
      expect(EDITORIAL_LIGHT, `浅色块缺 ${token}`).toContain(token);
    }
  });

  it("深色块：暖炭黑 + 深暖褐卡 + 暖赤陶，五族令牌齐全", () => {
    expect(EDITORIAL_DARK).toContain("--biliscript-reader-surface: var(--biliscript-primitive-color-charcoal-950)");
    expect(EDITORIAL_DARK).toContain("--biliscript-reader-card: var(--biliscript-primitive-color-charcoal-900)");
    expect(EDITORIAL_DARK).toContain("--biliscript-reader-border: var(--biliscript-primitive-color-charcoal-700)");
    expect(EDITORIAL_DARK).toContain("--biliscript-reader-mist-line: var(--biliscript-primitive-color-charcoal-750)");
    expect(EDITORIAL_DARK).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-terracotta-400)");
    for (const token of REQUIRED_TOKENS) {
      expect(EDITORIAL_DARK, `深色块缺 ${token}`).toContain(token);
    }
  });

  it("两档都关蓝雾径向光斑与背景模糊（温润纸感直落纸面）", () => {
    for (const [label, block] of [["浅色", EDITORIAL_LIGHT], ["深色", EDITORIAL_DARK]] as const) {
      expect(block, `${label}块 mist-blobs 应为 none`).toContain("--biliscript-reader-mist-blobs: none");
      expect(block, `${label}块 mist-filter 应为 none`).toContain("--biliscript-reader-mist-filter: none");
    }
  });

  it("卡片回归羊皮纸书摘质感：1px 暖沙细描边 + 去掉玻璃内高光与悬浮投影", () => {
    const gate = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(gate).toContain("#biliscript-reading-view[data-palette=\"editorial\"] .biliscript-reading-ov-chapter");
    expect(gate).toContain("#biliscript-reading-view[data-palette=\"editorial\"] .biliscript-reading-ov-quote");
    expect(gate).toContain(".biliscript-reading-search");
    for (const popover of [
      ".chat-model-panel",
      ".chat-search-preview",
      ".custom-select-dropdown",
      ".provider-editor-host .ai-provider-model-dropdown",
      ".provider-editor-fetch-dialog"
    ]) {
      expect(gate).toContain(popover);
    }
    expect(gate).toContain("border: 1px solid var(--biliscript-reader-border);");
  });

  it("editorial 衬线只命中概览组标题，章节与金句保留各自字型栈", () => {
    const css = readCss(READER_CSS).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\r\n/g, "\n");
    const serifRule = css.match(
      /#biliscript-reading-view\[data-palette="editorial"\][^{]*\{[^}]*font-family:\s*var\(--biliscript-reader-font-serif\)[^}]*\}/
    );
    expect(serifRule, "应存在 editorial 衬线规则").not.toBe(null);
    expect(serifRule![0]).toContain(".biliscript-reading-ov-h");
    expect(serifRule![0]).not.toContain(".biliscript-reading-ov-chapter-title");
    expect(serifRule![0]).not.toContain(".biliscript-reading-ov-quote-text");
    expect(serifRule![0]).not.toContain("data-theme");
    expect(css).toContain(".biliscript-reading-ov-chapter-title {\n  font-family: var(--biliscript-reader-font-sans-medium)");
    expect(css).toContain(".biliscript-reading-ov-chapter-desc {\n  font-family: var(--biliscript-reader-font-sans)");
    expect(css).toContain('.biliscript-reading-ov-quote-text {\n  position: relative;\n  z-index: 1;\n  display: block;\n  font-family: Georgia, "Times New Roman", "BiliScript Noto Serif SC"');
  });

  it("时间戳浅色文字档：flyme 柔和中蓝 / editorial 深赤陶两档各一份，消费侧只引用 token", () => {
    const gate = readCss(GATE_CSS);
    expect(gate).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-blue-600);");
    expect(gate).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-terracotta-600);");
    // editorial 两块的 time token 定义齐全（深色档不定义——深色消费 accent 母题）
    expect(EDITORIAL_LIGHT).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-terracotta-600);");
  });
});

