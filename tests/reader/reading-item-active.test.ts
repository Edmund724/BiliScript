// tests/reader/reading-item-active.test.ts
// 2026-10-06 用户决议（字幕 tab 活动行截图）：活动行只留 accent-soft 底色——
//   1. 2px 绿下划线整条删除——它与活动行底色同读 sync 的同一个 is-active，是同一
//      状态的两套颜色语言；且 text-decoration 按行盒铺开，2–3 行的字幕长句实际
//      会变成每行一条绿线，而底色始终是一整块；
//   2. 活动行内的时间戳 pill 底清零——pill 底与行底同是 accent-soft，叠上去二次
//      加深；bilibili 浅色档的 accent-soft 是四档里唯一的不透明值，那里 pill 与
//      行底同色、形状直接消失。
// 形状同 reading-header-icon-btns.test.ts：直接断言 CSS 文本，防「改一半」——
//   1. 下划线从别处漏回来（活动行文本再加 text-decoration，或线色又取 success 绿）；
//   2. 删线顺手把线挪到基础段：非活动行的正文跟着带线；
//   3. pill 清底只写在基础段：非活动行的 pill 母题（章节/金句/AI 引用同款）掉底；
//   4. pill 清底不带 #id 前缀：基础段 .biliscript-reading-time 是 (0,1,0)，压不过
//      它就是没生效；
//   5. 死声明回归：字幕列表只存在于 #biliscript-reading-view 里，裸类名
//      .biliscript-reading-item.is-active 的 background 恒被 #id 规则全量覆盖。
// 作用域提示：本文件只管字幕活动行；对话区 .chat-timestamp-link 与解释浮层不联动。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const READER_CSS = "extension/entry/styles/reader.css";

function readCss(): string {
  return readFileSync(join(process.cwd(), READER_CSS), "utf8");
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

describe("字幕活动行：底色留、下划线删、pill 清底", () => {
  it("活动行不再有下划线：任何活动行规则块都不带 text-decoration", () => {
    expect(readCss()).not.toMatch(/\.biliscript-reading-item\.is-active[^{]*\{[^}]*text-decoration/);
  });

  it("本表不再把 success 绿当线色", () => {
    expect(readCss()).not.toMatch(/text-decoration-color:\s*var\(--biliscript-reader-success\)/);
  });

  it("删的是活动行那条线：正文基础段不带 text-decoration", () => {
    expect(ruleBody(readCss(), "\\.biliscript-reading-text")).not.toMatch(/text-decoration/);
  });

  it("活动行底色仍是 accent-soft（删线不动底色）", () => {
    const block = ruleBody(readCss(), "#biliscript-reading-view \\.biliscript-reading-item\\.is-active");

    expect(declaration(block, "background")).toBe("var(--biliscript-reader-accent-soft)");
  });

  it("活动行内 pill 清底，且带 #id 前缀（否则 (0,1,0) 的基础段照样盖回来）", () => {
    const selector =
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-time";

    expect(declaration(ruleBody(readCss(), selector), "background")).toBe("transparent");
  });

  it("基础 pill 底仍在：清底只作用于活动行，母题不被全局摘掉", () => {
    expect(declaration(ruleBody(readCss(), "\\.biliscript-reading-time"), "background")).toBe(
      "var(--biliscript-reader-accent-soft)"
    );
  });

  it("裸类名活动行规则不回来：面板内它恒被 #id 规则覆盖，是死声明", () => {
    const bare = readCss().match(/(?:^|\n)[ \t]*\.biliscript-reading-item\.is-active\s*\{([^}]*)\}/);

    expect(bare, "不应存在 .biliscript-reading-item.is-active 裸类名规则").toBe(null);
  });
});
