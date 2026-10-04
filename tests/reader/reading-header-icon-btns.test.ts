// tests/reader/reading-header-icon-btns.test.ts
// 2026-XX 用户决议（截图，面板右上角）：面板 header 的主题/设置/退出三键
// （.biliscript-reading-icon-btn）摘掉 1px 边框——键与面板同底色，框线是唯一
// 多余的一圈线；三键改为无框「幽灵键」，悬停底是唯一的存在感来源。
// 同一张截图里三键离面板右上角偏远 → .biliscript-reading-actions 取负 margin
// 往右上收（负 margin 而非改 header 内边距：内边距是三键与左侧文案/下方
// 标签槽共用的，收它会把整行一起挪走）。
// 形状同 chat-header-toolbox：直接断言 CSS 文本，防「改一半」——
//   1. 只改基础段 .biliscript-reading-icon-btn：`.biliscript-reading-actions button`
//      是 (0,1,1)，压过基础段的 (0,1,0)，边框照样回来（本文件断言高特异性覆写块
//      也写 border: 0）；
//   2. 边框摘了但 hover/is-active 里的 border-color 留着：成无边框的孤儿声明；
//   3. 边框摘了顺手把 hover 底色也摘：三键彻底不可见；
//   4. 只写 border-color 不写 border：改一半，边框纹丝不动；
//   5. 位置没跟着收：只摘框不动位（负 margin 缺失）。
// 作用域提示：本文件只管面板 header 三键；对话工具条两键（chat-header-toolbox.test.ts）
// 仍是 1px 框，那是另一处控件，本次不联动。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const READER_CSS = "extension/entry/styles/reader.css";

function readCss(): string {
  return readFileSync(join(ROOT, READER_CSS), "utf8");
}

function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function declaration(block: string, prop: string): string | undefined {
  return block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`))?.[1].trim();
}

// 三键的框形由这条高特异性覆写块最终定型（基础段见上）。
function iconBtnOverrideBlock(): string {
  return ruleBody(
    readCss(),
    "#biliscript-reading-view \\.biliscript-reading-actions button\\.biliscript-reading-icon-btn"
  );
}

describe("面板 header 三键的边框与位置", () => {
  it("基础段与高特异性覆写块都声明无边框（只改一处边框会从另一处漏回来）", () => {
    const base = ruleBody(readCss(), "\\.biliscript-reading-icon-btn");

    expect(declaration(base, "border")).toBe("0");
    expect(declaration(iconBtnOverrideBlock(), "border")).toBe("0");
    expect(`${base}${iconBtnOverrideBlock()}`).not.toMatch(/border:\s*1px/);
  });

  it("摘框后不留孤儿 border-color（无边框时改 border-color 无任何效果）", () => {
    const css = readCss();

    expect(ruleBody(css, "\\.biliscript-reading-icon-btn:hover")).not.toMatch(/border-color:/);
    expect(ruleBody(css, "\\.biliscript-reading-icon-btn\\.is-active")).not.toMatch(/border-color:/);
  });

  it("悬停底仍在：框是唯一被摘的存在感来源，底色不能再跟着摘", () => {
    const hover = ruleBody(readCss(), "\\.biliscript-reading-icon-btn:hover");

    expect(declaration(hover, "background")).toBeTruthy();
  });

  it("三键往面板右上角收：动作行取负 margin（不碰共用的 header 内边距）", () => {
    const margin = declaration(ruleBody(readCss(), "\\.biliscript-reading-actions"), "margin");

    expect(margin, "动作行应带 margin 简写").toBeTruthy();
    const [top, right] = margin!.split(/\s+/);
    expect(Number.parseFloat(top)).toBeLessThan(0);
    expect(Number.parseFloat(right)).toBeLessThan(0);
  });
});