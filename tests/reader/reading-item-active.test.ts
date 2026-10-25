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
//   3. 活动行 = 整颗白卡：行容器切 inline-grid、宽度随内容自适应包裹
//     （max-width 100% 兜底折行）、圆角 12px（与分段控件槽/项、tab 内容卡、
//      章节/金句卡同一半径语言；多行内容卡不能用 999px 胶囊——折行后半径
//      钳到半高，首尾行左缘文字会被裁进弧线里），白卡同时包住时间戳与文字；底色消费
//      --biliscript-reader-card 白卡令牌（色板/深色档自动跟随），软投影与
//      tab.is-active 同款（深色档投影换黑）。左侧时刻文本列锁定网格槽位
//     （继承基础网格 var(--biliscript-reader-time-col)，窄档 64px 同样对齐），
//      卡内时间戳保持浅底小胶囊（time-bg + time-color，深色档回退 accent-soft/accent 母题），
//      padding 1px 7px 随内容收紧、圆角 999px 全胶囊形、列内左对齐；正文深色加粗 600，
//      确保正文起始 X 坐标与未激活行垂直对齐。is-active 规则书写在 :hover 之后。
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

describe("字幕活动行：整颗白卡、时间戳减噪", () => {
  it("活动行不再有下划线：任何活动行规则块都不带 text-decoration", () => {
    expect(readCss()).not.toMatch(/\.biliscript-reading-item\.is-active[^{]*\{[^}]*text-decoration/);
  });

  it("本表不再把 success 绿当线色", () => {
    expect(readCss()).not.toMatch(/text-decoration-color:\s*var\(--biliscript-reader-success\)/);
  });

  it("删的是活动行那条线：正文基础段不带 text-decoration", () => {
    expect(ruleBody(readCss(), "\\.biliscript-reading-text")).not.toMatch(/text-decoration/);
  });

  it("活动行白卡在行容器：inline-grid 内容宽 + 28px 圆角 + card 白卡底 + tab 同款凸起投影", () => {
    const css = readCss();
    const block = ruleBody(css, "#biliscript-reading-view \\.biliscript-reading-item\\.is-active");

    expect(declaration(block, "display")).toBe("inline-grid");
    expect(declaration(block, "width")).toBe("auto");
    expect(declaration(block, "max-width")).toBe("100%");
    expect(["28px", "var(--biliscript-radius-panel)"]).toContain(declaration(block, "border-radius"));
    expect(declaration(block, "background")).toBe("var(--biliscript-reader-card)");
    expect(declaration(block, "box-shadow")).toMatch(
      /^0 1px 4px rgba\((23, 24, 26|var\(--biliscript-primitive-color-gray-950-rgb\)), 0\.12\), inset 0 1px 0 rgba\((255, 255, 255|var\(--biliscript-primitive-color-white-rgb\)), 0\.9\)$/
    );

    // 深色档投影换黑（与 tab.is-active 同款处理）。
    const darkBlock = ruleBody(
      css,
      "#biliscript-reading-view\\[data-theme=\"dark\"\\] \\.biliscript-reading-item\\.is-active"
    );
    expect(declaration(darkBlock, "box-shadow")).toMatch(
      /^0 1px 4px rgba\((0, 0, 0|var\(--biliscript-primitive-color-black-rgb\)), 0\.35\)$/
    );
  });

  it("时刻文本列锁定网格槽位：继承 --biliscript-reader-time-col，胶囊徽标在列内左对齐", () => {
    const css = readCss();
    const baseBlock = ruleBody(css, "\\.biliscript-reading-item");
    const activeBlock = ruleBody(css, "#biliscript-reading-view \\.biliscript-reading-item\\.is-active");
    const timeBlock = ruleBody(css, "\\.biliscript-reading-time");

    // 基础条目声明固定时间戳列变量与网格列规
    expect(declaration(baseBlock, "grid-template-columns")).toBe(
      "var(--biliscript-reader-time-col) minmax(0, 1fr)"
    );
    // 活动行不覆写列规或间距，确保时刻列槽位宽度与未激活行严格锁死一致
    expect(declaration(activeBlock, "grid-template-columns")).toBeUndefined();
    expect(declaration(activeBlock, "gap")).toBeUndefined();

    // 时间戳徽标在列内左对齐包裹自身宽度
    expect(declaration(timeBlock, "justify-self")).toBe("start");

    // 窄面板容器查询档位同样下发 64px time-col 覆写
    const containerBlock = ruleBody(
      css,
      "#biliscript-reading-view \\.biliscript-reading-item"
    );
    expect(declaration(containerBlock, "--biliscript-reader-time-col")).toBe("64px");
  });

  it("活动行文字在白卡内：深色加粗、可收进 max-width 折行，不自带底色", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-text"
    );

    expect(declaration(block, "color")).toBe("var(--biliscript-reader-text)");
    expect(declaration(block, "font-weight")).toBe("600");
    expect(declaration(block, "min-width")).toBe("0");
    expect(declaration(block, "background")).toBeUndefined();
  });

  it("活动行时间戳保持浅底小胶囊：time 令牌底/字（深色回退母题），随内容收紧、999px 胶囊圆角、列内左对齐", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe(
      "var(--biliscript-reader-time-color, var(--biliscript-reader-accent))"
    );
    expect(declaration(block, "background")).toBe(
      "var(--biliscript-reader-time-bg, var(--biliscript-reader-accent-soft))"
    );
    expect(declaration(block, "padding")).toBe("1px 7px");
    expect(["999px", "var(--biliscript-radius-pill)"]).toContain(declaration(block, "border-radius"));
    // 不留定宽列：min-width/居中都已摘除，pill 左右不空。
    expect(declaration(block, "min-width")).toBeUndefined();
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
    expect(gate).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-blue-600);");
    expect(gate).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-terracotta-600);");
    // 活动行时间戳的底/字由 reader.css 的 is-active 规则直接消费 time 令牌，
    // gate 再挂 is-active 即双头维护。
    expect(gate).not.toContain(".biliscript-reading-item.is-active .biliscript-reading-time");
  });

  it("裸类名活动行规则不回来：面板内它恒被 #id 规则覆盖，是死声明", () => {
    const bare = readCss().match(/(?:^|\n)[ \t]*\.biliscript-reading-item\.is-active\s*\{([^}]*)\}/);

    expect(bare, "不应存在 .biliscript-reading-item.is-active 裸类名规则").toBe(null);
  });
});
