// tests/reader/reading-item-active.test.ts
// 2026-10-06 用户决议（字幕 tab 活动行截图）：活动行只留 accent-soft 底色——
//   1. 2px 绿下划线整条删除——它与活动行底色同读 sync 的同一个 is-active，是同一
//      状态的两套颜色语言；且 text-decoration 按行盒铺开，2–3 行的字幕长句实际
//      会变成每行一条绿线，而底色始终是一整块；
//   2. 活动行内的时间戳 pill 底清零——pill 底与行底同是 accent-soft，叠上去二次
//      加深；bilibili 浅色档的 accent-soft 是四档里唯一的不透明值，那里 pill 与
//      行底同色、形状直接消失。
// 2026-10-17 03 号票（字幕时间戳减噪）：pill 清底从「仅活动行」推广到「字幕列表
//   全部静止行」——清底 + padding 归零 + 次级 muted 字 + tabular-nums；活动行与
//   悬停行回主色强调。作用域收在 .biliscript-reading-item 内，章节/金句/AI 引用的
//   pill 母题保持 accent-soft 底 + accent 字；浅色档强调字走 gate 的
//   time-color token（flyme 柔和中蓝 #2e6fc2；accent 亮蓝 #008cff 在 accent-soft
//   浅底上对比不足）。
// 形状同 reading-header-icon-btns.test.ts：直接断言 CSS 文本，防「改一半」——
//   1. 下划线从别处漏回来（活动行文本再加 text-decoration，或线色又取 success 绿）；
//   2. 删线顺手把线挪到基础段：非活动行的正文跟着带线；
//   3. 减噪规则漏出字幕列表：基础段 pill 母题（章节/金句/AI 引用同款）掉底/变色；
//   4. 减噪/强调规则不带 #id 前缀：压不过 gate 浅色档的全 pill 规则等于浅色档没减噪；
//   5. 死声明回归：字幕列表只存在于 #biliscript-reading-view 里，裸类名
//      .biliscript-reading-item.is-active 的 background 恒被 #id 规则全量覆盖；
//   6. 强调档漏态：is-active 与 :hover 必须同规则同待遇，只高亮其一即回归噪音。
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

describe("字幕活动行：底色留、下划线删、时间戳减噪", () => {
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

  it("活动/悬停行时间戳回主色强调：is-active 与 :hover 同规则同待遇", () => {
    const css = readCss();
    // 合并规则块以 :hover 选择器行收尾，ruleBody 从行首匹配命中该块。
    const block = ruleBody(
      css,
      "#biliscript-reading-view \\.biliscript-reading-item:hover \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe("var(--biliscript-reader-accent)");
    expect(css).toContain("#biliscript-reading-view .biliscript-reading-item.is-active .biliscript-reading-time,");
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

  it("浅色档强调字沿用柔和中蓝 token：accent 亮蓝在 accent-soft 浅底上对比不足", () => {
    const gate = readGate();
    const block = ruleBody(
      gate,
      "#biliscript-reading-view:not\\(\\[data-theme=\"dark\"\\]\\) \\.biliscript-reading-item:hover \\.biliscript-reading-time"
    );

    // 浅色档强调字走 time-color token（01 号票起按色板覆写：flyme 柔和中蓝、
    // editorial 深赤陶文字档），token 定义留在 gate 主题块里。
    expect(declaration(block, "color")).toBe("var(--biliscript-reader-time-color)");
    expect(gate).toContain("--biliscript-reader-time-color: #2e6fc2;");
    expect(gate).toContain("--biliscript-reader-time-color: #9c4527;");
    expect(gate).toContain(
      "#biliscript-reading-view:not([data-theme=\"dark\"]) .biliscript-reading-item.is-active .biliscript-reading-time,"
    );
  });

  it("裸类名活动行规则不回来：面板内它恒被 #id 规则覆盖，是死声明", () => {
    const bare = readCss().match(/(?:^|\n)[ \t]*\.biliscript-reading-item\.is-active\s*\{([^}]*)\}/);

    expect(bare, "不应存在 .biliscript-reading-item.is-active 裸类名规则").toBe(null);
  });
});
