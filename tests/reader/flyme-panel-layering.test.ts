// tests/reader/flyme-panel-layering.test.ts
// Flyme 浅色面板分层契约（2026-12 用户决议，截图两轮 + 预览页确认）：
// 「字幕/概览那一行往下一块灰」「打开历史对话多一圈灰框」的修复定稿——
// 面板只剩两层：surface 页面灰（外壳底色，header 与 tab 区直接落在其上）
// + card 白卡（tab 内容区、历史条目）。本文件锁四点：
//
// 1. tab 内容区（.biliscript-reading-tab-body）是 card 白卡：background 走
//    --biliscript-reader-card，圆角 12px（与 tab 槽同档的嵌套半径），四周
//    margin 环透出面板页面灰——白卡于是读作「浮在灰页底上」而非「灰海里又一块灰」。
// 2. header 不再自带底色与毛玻璃：原 header-bg 是 surface 加 alpha 的 rgba，
//    叠在不透明的 surface 面板壳上数学上恒等于 surface（纯冗余），而它近白的
//    观感在 flyme 浅色下与 tab 区的灰形成断层（用户报「很割裂」）。token
//    --biliscript-reader-header-bg 随唯一消费方一并清除。
// 3. flyme 浅色 tab 槽 pill-bg 由 #f0f1f3 加深到 #e9ebef（surface-3 同值）：
//    原值与面板灰 #f2f3f5 仅差 2 阶，槽形不可见、选中态蓝胶囊像浮在灰上。
//    flyme 深色 pill-bg #222327 与 surface-3 本就同值，不动。
// 4. 历史条目（.chat-history-item）白卡无描边：background 由 surface（与面板
//    同灰，读作一排灰盒子）换成 card；描边退为 transparent（保留 1px 几何，
//    is-live-match 换 accent 边时布局不跳）。
//
// 局限同 chat-history-page.test.ts：jsdom 无布局，本文件只锁 CSS 源文本，
// 真实观感回归由人工/预览页（.scratch/previews/flyme-panel-color-fix.html）兜。
// 防倒退：tab 内容区回到透明/灰底、header 复活独立底色、flyme 浅色槽色退回
// 2 阶差、历史条目回到灰底灰边，本文件红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const READER_CSS = "extension/entry/styles/reader.css";
const GATE_CSS = "extension/entry/styles/reader-gate.css";
const CHAT_CSS = "extension/entry/styles/reader-chat.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

// 取「选择器恰好等于 selector」的那条规则块（与 chat-history-page 同口径：
// 剥注释后按 {…} 切）。
function ruleBody(css: string, selector: string): string {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const bodies = rules
    .map((rule) => {
      const [head, body] = rule.split("{");
      return { head: head.trim(), body };
    })
    .filter((rule) => rule.head.split(",").map((part) => part.trim()).includes(selector))
    .map((rule) => rule.body);
  expect(bodies.length, `应存在 ${selector} 规则`).toBeGreaterThan(0);
  return bodies.join("\n");
}

// 主题块定位：gate 段每个色板块的最后一个选择器是 #biliscript-reading-view 形态，
// 按结尾特征区分 flyme 浅色块与 flyme 深色块。
function themeBlock(tailSelector: string): string {
  const text = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((rule) => rule.split("{")[0].trimEnd().endsWith(tailSelector));
  expect(hit, `应存在以 ${tailSelector} 结尾的主题块`).not.toBe(undefined);
  return hit!.split("{")[1];
}

describe("Flyme 浅色面板分层（灰页底 + 白卡）", () => {
  it("tab 内容区是 card 白卡：card 底 + 12px 圆角 + margin 环透出页面灰", () => {
    const body = ruleBody(readCss(READER_CSS), ".biliscript-reading-tab-body");

    expect(body).toContain("background: var(--biliscript-reader-card)");
    expect(body).toContain("border-radius: 12px");
    expect(body).toMatch(/(?:^|;)\s*margin:\s*\d+px\s+\d+px\s+\d+px\s*;/);
  });

  it("header 不再自带底色与毛玻璃（与 tab 区同落面板页面灰，不再断层）", () => {
    const body = ruleBody(
      readCss(READER_CSS),
      ".biliscript-reading-script-panel .biliscript-reading-header"
    );

    expect(body).not.toMatch(/background\s*:/);
    expect(body).not.toContain("backdrop-filter");
  });

  it("header-bg token 随唯一消费方清除：两份样式表都不再有它的定义与引用", () => {
    expect(readCss(READER_CSS)).not.toContain("--biliscript-reader-header-bg");
    expect(readCss(GATE_CSS)).not.toContain("--biliscript-reader-header-bg");
  });

  it("flyme 浅色 tab 槽加深到 surface-3 同值 #e9ebef（2 阶差不可见 → 可辨）", () => {
    const flymeLight = themeBlock('#biliscript-reading-view[data-family="flyme"]');

    expect(flymeLight).toContain("--biliscript-reader-pill-bg: #e9ebef");
  });

  it("flyme 深色 tab 槽不动（#222327，深色分层用户确认协调）", () => {
    const flymeDark = themeBlock('#biliscript-reading-view[data-family="flyme"][data-theme="dark"]');

    expect(flymeDark).toContain("--biliscript-reader-pill-bg: #222327");
  });

  it("历史条目白卡无描边：card 底 + transparent 边（不再是与面板同灰的灰盒子）", () => {
    const body = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-history-item");

    expect(body).toContain("background: var(--biliscript-reader-card)");
    expect(body).toMatch(/border:\s*1px solid transparent\s*;/);
  });
});
