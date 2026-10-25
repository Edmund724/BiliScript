// tests/reader/flyme-panel-layering.test.ts
// Flyme 浅色面板分层契约（2026-12 用户决议，截图两轮 + 预览页确认）：
// 面板只剩一层料：surface 页面灰 / 雾底（外壳底色，header、tab 区、tab
// 内容区与盖住它的历史对话整页全部直露其上），白玻璃凸起卡（选中 pill、
// 章节/金句、输入卡、用户气泡）靠灰差浮出。本文件锁四点：
//
// 1. tab 内容区（.biliscript-reading-tab-body）底色走 --biliscript-reader-card，
//    圆角 12px（与 tab 槽同档的嵌套半径），四周 margin 环透出面板页面灰
//    （reader-gate.css 的蓝雾壳段覆写为透明：内容区直露雾底，全场一层料，
//    凸起白卡靠灰差浮出），本测试只锁 base 规则。
// 2. header 不再自带底色与毛玻璃：原 header-bg 是 surface 加 alpha 的 rgba，
//    叠在不透明的 surface 面板壳上数学上恒等于 surface（纯冗余），而它近白的
//    观感在浅色下与 tab 区的灰形成断层（用户报「很割裂」）。token
//    --biliscript-reader-header-bg 随唯一消费方一并清除。
// 3. 分段控件槽体透明、与雾底融为一体：无槽底、无内阴影，只有选中项浮起
//    白玻璃卡 + accent 字（reader-gate.css 的蓝雾壳段覆写），圆角沿用基表
//    槽/项同档 12px（与 tab 内容卡、字幕活动卡、章节/金句卡同语言）；
//    pill-bg token 留在色板里服务解释卡关闭键 hover 等消费方，值不变。
// 4. 历史对话条目（.chat-history-item）无界平列表：无底、无边、无圆角，
//    行间无间隙（2026-12 用户裁定，参考常见历史会话界面）；状态用整行
//    wash 表达——hover 取 fill-hover、当前会话取 surface-2、同视频取
//    accent-soft。列表滚动条细淡并贴面板右缘（整页横向缩进挪到头部与
//    条目内容）。
//
// 局限同 chat-history-page.test.ts：jsdom 无布局，本文件只锁 CSS 源文本，
// 真实观感回归由人工/真机预览兜。
// 防倒退：tab 内容区回到透明/灰底、header 复活独立底色、flyme 槽色退回不透明
// 灰、历史页底色退回实底或历史条目回到卡片化（底/边/圆角），本文件红。

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
// 按结尾特征区分浅色基础块与深色块。
function themeBlock(tailSelector: string): string {
  const text = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((rule) => rule.split("{")[0].trimEnd().endsWith(tailSelector));
  expect(hit, `应存在以 ${tailSelector} 结尾的主题块`).not.toBe(undefined);
  return hit!.split("{")[1];
}

describe("Flyme 浅色面板分层（灰页底 + 白卡）", () => {
  it("tab 内容区是 card 白卡：card 底 + 28px 圆角 + margin 环透出页面灰", () => {
    const body = ruleBody(readCss(READER_CSS), ".biliscript-reading-tab-body");

    expect(body).toContain("background: var(--biliscript-reader-card)");
    expect(body).toContain("border-radius: 28px");
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

  it("分段控件槽体透明：无槽底无内阴影，只有选中项浮白玻璃 pill", () => {
    const trough = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view .biliscript-reading-tabs"
    );
    const active = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view .biliscript-reading-tab.is-active"
    );

    expect(trough).toContain("background: transparent");
    expect(trough).toContain("box-shadow: none");
    expect(active).toContain("background: var(--biliscript-reader-card)");
    expect(active).toContain("color: var(--biliscript-reader-accent)");
  });

  it("深色 tab 槽留存（#26282d，深色分层与 surface-3 对齐）", () => {
    const dark = themeBlock("#biliscript-reading-view[data-theme=\"dark\"]");

    expect(dark).toContain("--biliscript-reader-pill-bg: var(--biliscript-primitive-color-dark-gray-800)");
  });

  it("历史条目无界平列表：无底无边，状态走整行圆角 wash", () => {
    const css = readCss(CHAT_CSS);
    const item = ruleBody(css, ".biliscript-reading-chat .chat-history-item");

    expect(item).not.toMatch(/border\s*:/);
    expect(item).toContain("border-radius: 8px");
    expect(item).not.toContain("background");
    expect(ruleBody(css, ".biliscript-reading-chat .chat-history-item:hover")).toContain(
      "background: var(--biliscript-reader-fill-hover)"
    );
    expect(ruleBody(css, ".biliscript-reading-chat .chat-history-item.is-active")).toContain(
      "background: var(--biliscript-reader-surface-2)"
    );
    expect(ruleBody(css, ".biliscript-reading-chat .chat-history-item.is-live-match")).toContain(
      "background: var(--biliscript-reader-accent-soft)"
    );
  });

  it("历史列表无行间间隙、滚动条贴右缘（细淡一档）", () => {
    const list = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-history-list");

    expect(list).not.toContain("gap");
    // 细淡一档由 ::-webkit-scrollbar 定制承担（不设标准 scrollbar-color/width，
    // Chrome 121+ 会跳过 webkit 定制回退原生粗灰条）
    expect(readCss(CHAT_CSS)).toContain(".chat-history-list::-webkit-scrollbar");
    // 整页横向缩进挪到头部/条目内容（padding 左右为 0），滚动条才贴得上右缘；
    // inset 右侧多吞 tab-body 外边距 14（-28 = padding 14 + margin 14），贴的是面板壳
    const page = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-history-popover");
    expect(page).toMatch(/padding:\s*4px 0 12px\s*;/);
    expect(page).toContain("inset: -10px -28px -14px -14px");
  });

  it("字幕工具条搜索框：盒高 32px 对齐选轨下拉，无描边白玻璃凸起 + 24px 无框幽灵跳转键", () => {
    const readerCss = readCss(READER_CSS);
    const searchBody = ruleBody(readerCss, ".biliscript-reading-search");
    expect(searchBody).toContain("height: 32px");
    expect(searchBody).toContain("box-sizing: border-box");
    expect(searchBody).toContain("border-radius: 28px");

    const navBody = ruleBody(readerCss, ".biliscript-reading-search-nav");
    expect(navBody).toContain("width: 24px");
    expect(navBody).toContain("height: 24px");
    expect(navBody).toContain("background: transparent");
    expect(navBody).toContain("border: none");
    expect(readerCss).toContain("background: var(--biliscript-reader-fill-hover)");

    const gate = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(gate).toContain(".biliscript-reading-search");
    expect(gate).toContain("border: none");
    expect(gate).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.7)");
  });

  it("浮层与弹层：无边框半透明白玻璃卡 + 顶缘内高光 + 24px 毛玻璃模糊与滚动/透明度降级", () => {
    const gate = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const sel of [
      ".chat-model-panel",
      ".chat-search-preview",
      ".custom-select-dropdown",
      ".provider-editor-host .ai-provider-model-dropdown",
      ".provider-editor-fetch-dialog"
    ]) {
      expect(gate, `gate 表应包含 ${sel}`).toContain(sel);
    }
    expect(gate).toContain("-webkit-backdrop-filter: blur(24px) saturate(180%)");
    expect(gate).toContain("backdrop-filter: blur(24px) saturate(180%)");
    expect(gate).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.7)");
    expect(gate).toContain("inset 0 1px 0 rgba(255, 255, 255, 0.07)");
  });
});
