// tests/reader/reading-header-icon-btns.test.ts
// 2026-XX 用户决议（截图，面板右上角）：面板 header 的主题/设置/退出三键
// （.biliscript-reading-icon-btn）摘掉 1px 边框——键静止透明无底色，框线是
// 画面上唯一多余的一圈线；三键改为无框「幽灵键」，悬停底是唯一的存在感来源。
// 同一张截图里三键离面板右上角偏远 → .biliscript-reading-actions 取负 margin
// 往右上收（负 margin 而非改 header 内边距：内边距是三键与左侧文案/下方
// 标签槽共用的，收它会把整行一起挪走）。
// 直接断言 CSS 文本，防「改一半」——
//   1. 文字动作按钮 pill 的选择器退回裸 `.biliscript-reading-actions button`：
//      pill 的 (0,1,1) 压过基础段 .biliscript-reading-icon-btn 的 (0,1,0)，
//      surface 实底 + 1px 边框 + 36px 最小高 + 999px 圆角整组漏到三键上
//      （本文件断言排除选择器在、裸规则不在）；
//   2. 边框摘了但 hover/is-active 里的 border-color 留着：成无边框的孤儿声明；
//   3. 边框摘了顺手把 hover 底色也摘：三键彻底不可见；
//   4. 只写 border-color 不写 border：改一半，边框纹丝不动；
//   5. 位置没跟着收：只摘框不动位（负 margin 缺失）；
//   6. 位置没钉住：header 的对齐是 center（`.biliscript-reading-script-panel
//      .biliscript-reading-header`，reader.css），左侧文案一长高三键就跟着往
//      下飘 → 动作行自取 align-self: flex-start（2026-10-04 用户决议：三键固定
//      在右上角，不随信息行数上下居中）。
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

describe("面板 header 三键的边框与位置", () => {
  it("文字动作按钮 pill 不落在图标键上：排除选择器在、裸规则不在", () => {
    const css = readCss();
    const pill = ruleBody(
      css,
      "\\.biliscript-reading-actions button:not\\(\\.biliscript-reading-icon-btn\\)"
    );

    // pill 本身还在（排除的是图标键，不是整条文字键规则）
    expect(declaration(pill, "background")).toBe("var(--biliscript-reader-surface, #fff)");
    expect(declaration(pill, "border")).toBe("1px solid var(--biliscript-reader-border, #e5e7eb)");
    // 裸规则（起于选择器位置的 `.biliscript-reading-actions button {`）不许回来；
    // 带 #id 作用域的 `#biliscript-reading-view … button`（box-shadow 归零）不在判据内，
    // 它本就该同时命中图标键。
    expect(/(?:^|\n)\s*\.biliscript-reading-actions button\s*\{/.test(css)).toBe(false);
  });

  it("图标键基础段：静止态无底色、无边框", () => {
    const base = ruleBody(readCss(), "\\.biliscript-reading-icon-btn");

    expect(declaration(base, "background")).toBe("transparent");
    expect(declaration(base, "border")).toBe("0");
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

  it("三键钉在 header 右上角：动作行自取 flex-start（左侧文案变高不下移）", () => {
    const alignSelf = declaration(ruleBody(readCss(), "\\.biliscript-reading-actions"), "align-self");

    expect(alignSelf, "动作行应自取 align-self").toBeTruthy();
    const [crossAxis] = alignSelf!.split(/\s+/);
    expect(crossAxis).toBe("flex-start");
  });
});