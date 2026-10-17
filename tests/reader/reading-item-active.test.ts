// tests/reader/reading-item-active.test.ts
// 字幕列表行样式的当前契约（reader.css + reader-gate.css 源文本锁）：
//   1. 静止非活动行时间戳减噪：清底 + padding 归零 + 次级 muted 字 + tabular-nums
//      等宽数字，不做任何胶囊。选择器显式 :not(.is-active)——gate 浅色档全 pill
//      规则 (1,2,0) 与本表同源序打平即输（gate 在 reader.css 之后装载），减噪须
//      以 (1,3,0) 明压；章节/金句/AI 引用的 pill 母题不受影响。
//   2. 悬停行：仅时间戳回主色强调（浅色档由 gate time-color token 按色板定稿：
//      flyme 柔和中蓝 #2e6fc2、editorial 深赤陶 #9C4527——accent 亮蓝 #008cff
//      在浅色底上 3.4:1 不达 4.5 门），不做整行高亮；hover 选择器同样带
//      :not(.is-active)，(1,4,0) 压减噪 (1,3,0)。
//   3. 活动行 = 整颗白卡实心胶囊：行容器切 inline-flex、宽度收为内容宽
//     （max-width 100% 兜底折行）、圆角 999px 全胶囊形，胶囊同时包住时间戳与
//      文字；底色消费 --biliscript-reader-card 白卡令牌（色板/深色档自动跟随），
//      软投影与 tab.is-active 同款（深色档投影换黑）。胶囊内时间戳保持 pill
//      形态（time-bg + time-color，深色档回退 accent-soft/accent 母题），
//      min-width 与网格列宽同源（--biliscript-reader-time-col）+ box-sizing 收编
//      padding，时间数字在 pill 内居中（左对齐会让 pill 右侧空出一截）；正文
//      深色加粗 600。is-active 规则书写在 :hover 之后。
//   4. 活动行不带 text-decoration 下划线，本表不把 success 绿当线色。
//   5. 死声明防回归：字幕列表只存在于 #biliscript-reading-view 里，裸类名
//      .biliscript-reading-item.is-active 的 background 恒被 #id 规则全量覆盖。
// 作用域提示：本文件只管字幕列表行；对话区 .chat-timestamp-link 与解释浮层不联动。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const READER_CSS = "extension/entry/styles/reader.css";
const GATE_CSS = "extension/entry/styles/reader-gate.css";

function readCss(): string {
  return readFileSync(join(process.cwd(), READER_CSS), "utf8");
}

function readGate(): string {
  return readFileSync(join(process.cwd(), GATE_CSS), "utf8");
}

// 从行首起匹配：避免命中「… .biliscript-reading-time」这类带前缀的同名选择器。
function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`(?:^|\\n)[ \\t]*${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function declaration(block: string, prop: string): string | undefined {
  return block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`))?.[1].trim();
}

describe("字幕活动行：整颗白卡实心胶囊、时间戳减噪", () => {
  it("活动行不再有下划线：任何活动行规则块都不带 text-decoration", () => {
    expect(readCss()).not.toMatch(/\.biliscript-reading-item\.is-active[^{]*\{[^}]*text-decoration/);
  });

  it("本表不再把 success 绿当线色", () => {
    expect(readCss()).not.toMatch(/text-decoration-color:\s*var\(--biliscript-reader-success\)/);
  });

  it("删的是活动行那条线：正文基础段不带 text-decoration", () => {
    expect(ruleBody(readCss(), "\\.biliscript-reading-text")).not.toMatch(/text-decoration/);
  });

  it("活动行胶囊在行容器：inline-flex 内容宽 + 999px 全胶囊圆角 + card 白卡底 + tab 同款凸起投影", () => {
    const css = readCss();
    const block = ruleBody(css, "#biliscript-reading-view \\.biliscript-reading-item\\.is-active");

    expect(declaration(block, "display")).toBe("inline-flex");
    expect(declaration(block, "width")).toBe("auto");
    expect(declaration(block, "max-width")).toBe("100%");
    expect(declaration(block, "border-radius")).toBe("999px");
    expect(declaration(block, "background")).toBe("var(--biliscript-reader-card)");
    expect(declaration(block, "box-shadow")).toBe(
      "0 1px 4px rgba(23, 24, 26, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.9)"
    );

    // 深色档投影换黑（与 tab.is-active 同款处理）。
    const darkBlock = ruleBody(
      css,
      "#biliscript-reading-view\\[data-theme=\"dark\"\\] \\.biliscript-reading-item\\.is-active"
    );
    expect(declaration(darkBlock, "box-shadow")).toBe("0 1px 4px rgba(0, 0, 0, 0.35)");
  });

  it("活动行文字在胶囊内：深色加粗、可收进 max-width 折行，不自带底色", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-text"
    );

    expect(declaration(block, "color")).toBe("var(--biliscript-reader-text)");
    expect(declaration(block, "font-weight")).toBe("600");
    expect(declaration(block, "min-width")).toBe("0");
    expect(declaration(block, "background")).toBeUndefined();
  });

  it("活动行时间戳保持 pill：time 令牌底/字（深色回退母题），列宽同源、数字居中", () => {
    const css = readCss();
    const block = ruleBody(
      css,
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe(
      "var(--biliscript-reader-time-color, var(--biliscript-reader-accent))"
    );
    expect(declaration(block, "background")).toBe(
      "var(--biliscript-reader-time-bg, var(--biliscript-reader-accent-soft))"
    );
    expect(declaration(block, "min-width")).toBe("var(--biliscript-reader-time-col)");
    expect(declaration(block, "box-sizing")).toBe("border-box");
    expect(declaration(block, "text-align")).toBe("center");
    expect(declaration(block, "border-radius")).toBe("999px");
    expect(declaration(ruleBody(css, "\\.biliscript-reading-item"), "grid-template-columns")).toBe(
      "var(--biliscript-reader-time-col) minmax(0, 1fr)"
    );
  });

  it("静止态减噪显式 :not(.is-active)：清底 + padding 归零 + 次级色 + 等宽数字，明压 gate 全 pill 规则", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item:not\\(\\.is-active\\) \\.biliscript-reading-time"
    );

    expect(declaration(block, "background")).toBe("transparent");
    expect(declaration(block, "padding")).toBe("0");
    expect(declaration(block, "color")).toBe("var(--biliscript-reader-muted)");
    expect(declaration(block, "font-variant-numeric")).toBe("tabular-nums");
  });

  it("悬停行时间戳回主色强调，选择器带 :not(.is-active) 且 (1,4,0) 压减噪", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item:not\\(\\.is-active\\):hover \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe("var(--biliscript-reader-accent)");
  });

  it("is-active 规则书写在 :hover 之后", () => {
    const css = readCss();
    const hoverAt = css.indexOf(
      "#biliscript-reading-view .biliscript-reading-item:not(.is-active):hover .biliscript-reading-time"
    );
    const activeAt = css.indexOf(
      "#biliscript-reading-view .biliscript-reading-item.is-active .biliscript-reading-time"
    );

    expect(hoverAt).toBeGreaterThan(-1);
    expect(activeAt).toBeGreaterThan(hoverAt);
  });

  it("基础 pill 底仍在：减噪只作用于字幕列表，母题不被全局摘掉", () => {
    expect(declaration(ruleBody(readCss(), "\\.biliscript-reading-time"), "background")).toBe(
      "var(--biliscript-reader-accent-soft)"
    );
  });

  it("基础 pill 字色仍是 accent：减噪的次级色没漏进母题", () => {
    expect(declaration(ruleBody(readCss(), "\\.biliscript-reading-time"), "color")).toBe(
      "var(--biliscript-reader-accent)"
    );
  });

  it("浅色档悬停强调走 time-color token；活动行时间戳由 reader.css 直接消费 token，gate 不再重复挂", () => {
    const gate = readGate();
    const block = ruleBody(
      gate,
      "#biliscript-reading-view:not\\(\\[data-theme=\"dark\"\\]\\) \\.biliscript-reading-item:hover \\.biliscript-reading-time"
    );

    // time-color token 按色板覆写（flyme 柔和中蓝 / editorial 深赤陶文字档），
    // token 定义留在 gate 主题块里；accent 亮蓝在浅色底上 3.4:1 不达 4.5 门。
    expect(declaration(block, "color")).toBe("var(--biliscript-reader-time-color)");
    expect(gate).toContain("--biliscript-reader-time-color: #2e6fc2;");
    expect(gate).toContain("--biliscript-reader-time-color: #9c4527;");
    // 活动行时间戳的底/字由 reader.css 的 is-active 规则直接消费 time 令牌，
    // gate 再挂 is-active 即双头维护。
    expect(gate).not.toContain(".biliscript-reading-item.is-active .biliscript-reading-time");
  });

  it("裸类名活动行规则不回来：面板内它恒被 #id 规则覆盖，是死声明", () => {
    const bare = readCss().match(/(?:^|\n)[ \t]*\.biliscript-reading-item\.is-active\s*\{([^}]*)\}/);

    expect(bare, "不应存在 .biliscript-reading-item.is-active 裸类名规则").toBe(null);
  });
});
