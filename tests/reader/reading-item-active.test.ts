// tests/reader/reading-item-active.test.ts
// 字幕列表行样式的当前契约（reader.css + reader-gate.css 源文本锁）：
//   1. 静止非活动行时间戳减噪：清底 + padding 归零 + 次级 muted 字 + tabular-nums
//      等宽数字；作用域收在 .biliscript-reading-item 内，章节/金句/AI 引用的
//      pill 母题（accent-soft 底 + accent 字）不受影响。
//   2. 悬停行：仅时间戳回主色强调（浅色档由 gate time-color token 按色板定稿：
//      flyme 柔和中蓝 #2e6fc2、editorial 深赤陶 #9C4527——accent 亮蓝 #008cff
//      在浅色透明底上 3.4:1 不达 4.5 门），不做整行高亮；:hover 与 is-active
//      不得合并同规则（待遇不同，合并即互相污染）。
//   3. 活动行 = 整颗实心主色胶囊：行容器切 inline-flex、宽度收为内容宽
//     （max-width 100% 兜底折行），胶囊同时包住时间戳与文字；时间戳与正文恒白、
//      正文加粗 600；时间戳 min-width 与网格列宽同源（--biliscript-reader-time-col），
//      活动行文字左缘与静止行对齐。行底色 accent 压深 25%（color-mix）——原生
//      accent 实底白字只有 2.9–3.4:1，压深后四档 4.8–7.4:1；色板换 accent token
//      自动跟随（editorial → 深一档赤陶）。is-active 规则书写在 :hover 之后，
//      同特异性下悬停活动行时恒白不被 hover 主色盖掉；gate 浅色档强调档用
//      :not(.is-active) 排除活动行（防把白字盖回 time-color 文字档色）。
//   4. 双语副行在胶囊内随正文反白（muted 灰 / accent 字在实色底上对比不足）。
//   5. 活动行不带 text-decoration 下划线，本表不把 success 绿当线色。
//   6. 死声明防回归：字幕列表只存在于 #biliscript-reading-view 里，裸类名
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

describe("字幕活动行：整颗实心主色胶囊、时间戳减噪", () => {
  it("活动行不再有下划线：任何活动行规则块都不带 text-decoration", () => {
    expect(readCss()).not.toMatch(/\.biliscript-reading-item\.is-active[^{]*\{[^}]*text-decoration/);
  });

  it("本表不再把 success 绿当线色", () => {
    expect(readCss()).not.toMatch(/text-decoration-color:\s*var\(--biliscript-reader-success\)/);
  });

  it("删的是活动行那条线：正文基础段不带 text-decoration", () => {
    expect(ruleBody(readCss(), "\\.biliscript-reading-text")).not.toMatch(/text-decoration/);
  });

  it("活动行胶囊在行容器：inline-flex 内容宽 + accent 压深 25% 实底", () => {
    const block = ruleBody(readCss(), "#biliscript-reading-view \\.biliscript-reading-item\\.is-active");

    expect(declaration(block, "display")).toBe("inline-flex");
    expect(declaration(block, "width")).toBe("auto");
    expect(declaration(block, "max-width")).toBe("100%");
    expect(declaration(block, "background")).toBe(
      "color-mix(in srgb, var(--biliscript-reader-accent), #000000 25%)"
    );
  });

  it("活动行文字在胶囊内：恒白加粗、可收进 max-width 折行，不再自带胶囊底", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-text"
    );

    expect(declaration(block, "color")).toBe("#ffffff");
    expect(declaration(block, "font-weight")).toBe("600");
    expect(declaration(block, "min-width")).toBe("0");
    expect(declaration(block, "background")).toBeUndefined();
  });

  it("活动行时间戳在胶囊内：恒白，min-width 与网格列宽同源对齐文字左缘", () => {
    const css = readCss();
    const block = ruleBody(
      css,
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe("#ffffff");
    expect(declaration(block, "min-width")).toBe("var(--biliscript-reader-time-col)");
    expect(declaration(ruleBody(css, "\\.biliscript-reading-item"), "grid-template-columns")).toBe(
      "var(--biliscript-reader-time-col) minmax(0, 1fr)"
    );
  });

  it("双语副行在胶囊内随正文反白", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-text \\.biliscript-reading-subtext"
    );

    expect(declaration(block, "color")).toBe("rgba(255, 255, 255, 0.78)");
  });

  it("字幕列表静止态减噪：清底 + padding 归零 + 次级色 + 等宽数字，带 #id 前缀", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item \\.biliscript-reading-time"
    );

    expect(declaration(block, "background")).toBe("transparent");
    expect(declaration(block, "padding")).toBe("0");
    expect(declaration(block, "color")).toBe("var(--biliscript-reader-muted)");
    expect(declaration(block, "font-variant-numeric")).toBe("tabular-nums");
  });

  it("悬停行时间戳回主色强调，且不与活动行合并同规则", () => {
    const css = readCss();
    const block = ruleBody(
      css,
      "#biliscript-reading-view \\.biliscript-reading-item:hover \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe("var(--biliscript-reader-accent)");
    expect(css).not.toContain(
      "#biliscript-reading-view .biliscript-reading-item.is-active .biliscript-reading-time,"
    );
  });

  it("is-active 规则书写在 :hover 之后：悬停活动行时恒白不被 hover 主色盖掉", () => {
    const css = readCss();
    const hoverAt = css.indexOf(
      "#biliscript-reading-view .biliscript-reading-item:hover .biliscript-reading-time"
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

  it("浅色档悬停强调走 time-color token，并用 :not(.is-active) 排除胶囊内活动行", () => {
    const gate = readGate();
    const block = ruleBody(
      gate,
      "#biliscript-reading-view:not\\(\\[data-theme=\"dark\"\\]\\) \\.biliscript-reading-item:hover:not\\(\\.is-active\\) \\.biliscript-reading-time"
    );

    // time-color token 按色板覆写（flyme 柔和中蓝 / editorial 深赤陶文字档），
    // token 定义留在 gate 主题块里；accent 亮蓝在浅色底上 3.4:1 不达 4.5 门。
    expect(declaration(block, "color")).toBe("var(--biliscript-reader-time-color)");
    expect(gate).toContain("--biliscript-reader-time-color: #2e6fc2;");
    expect(gate).toContain("--biliscript-reader-time-color: #9c4527;");
    // 活动行时间戳在胶囊内恒白——浅色档不得再有任何 is-active 时间戳规则把
    // 白字盖回 time-color / accent。
    expect(gate).not.toContain(".biliscript-reading-item.is-active .biliscript-reading-time");
  });

  it("裸类名活动行规则不回来：面板内它恒被 #id 规则覆盖，是死声明", () => {
    const bare = readCss().match(/(?:^|\n)[ \t]*\.biliscript-reading-item\.is-active\s*\{([^}]*)\}/);

    expect(bare, "不应存在 .biliscript-reading-item.is-active 裸类名规则").toBe(null);
  });
});
