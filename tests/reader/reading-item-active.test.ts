// tests/reader/reading-item-active.test.ts
// 2026-10-06 用户决议（字幕 tab 活动行截图）：活动行只留 accent-soft 底色——
//   1. 2px 绿下划线整条删除——它与活动行底色同读 sync 的同一个 is-active，是同一
//      状态的两套颜色语言；且 text-decoration 按行盒铺开，2–3 行的字幕长句实际
//      会变成每行一条绿线，而底色始终是一整块；
//   2. 活动行内的时间戳 pill 底清零——pill 底与行底同是 accent-soft，叠上去二次
//      加深；bilibili 浅色档的 accent-soft 是四档里唯一的不透明值，那里 pill 与
//      行底同色、形状直接消失。
// 2026-10-17 03 号票（字幕时间戳减噪）：pill 清底从「仅活动行」推广到「字幕列表
//   全部静止行」——清底 + padding 归零 + 次级 muted 字 + tabular-nums；悬停行把
//   时间戳回主色强调。作用域收在 .biliscript-reading-item 内，章节/金句/AI 引用的
//   pill 母题保持 accent-soft 底 + accent 字；浅色档悬停强调字走 gate 的
//   time-color token（flyme 柔和中蓝 #2e6fc2、editorial 深赤陶 #9C4527；accent
//   亮蓝 #008cff 在浅色底上对比不足）。
// 2026-10-17 03 号票返工（目标设计图）：活动行不再是「时间戳回主色」，改整行
//   实心主色胶囊——行底 accent 压深 25%（color-mix）+ 时间戳与正文恒白 +
//   正文加粗；白字在原生 accent 实底上只有 2.9–3.4:1（flyme 两档），压深后四档
//   4.8–7.4:1，色板只换 accent token 即自动跟随（editorial → 深一档赤陶）。
//   悬停维持时间戳主色强调，不做整行高亮；is-active 与 :hover 不得再合并同规则。
// 2026-10-18 03 号票返工二（目标参考图复刻）：胶囊从整行收窄到只包文字列——
//   行底不再染色，胶囊底移到 .biliscript-reading-text（文字列即网格第二列，
//   胶囊左缘 = 文字列左缘，2px/10px 内边距）；时间戳留在胶囊外左侧列，回主色
//   加粗（母题本就 600，不反白），浅色档同悬停一并由 gate time-color token 定稿。
//   白字对比方案不变（accent 压深 25% 的 color-mix 底色）。
// 形状同 reading-header-icon-btns.test.ts：直接断言 CSS 文本，防「改一半」——
//   1. 下划线从别处漏回来（活动行文本再加 text-decoration，或线色又取 success 绿）；
//   2. 删线顺手把线挪到基础段：非活动行的正文跟着带线；
//   3. 减噪规则漏出字幕列表：基础段 pill 母题（章节/金句/AI 引用同款）掉底/变色；
//   4. 减噪/强调规则不带 #id 前缀：压不过 gate 浅色档的全 pill 规则等于浅色档没减噪；
//   5. 死声明回归：字幕列表只存在于 #biliscript-reading-view 里，裸类名
//      .biliscript-reading-item.is-active 的 background 恒被 #id 规则全量覆盖；
//   6. 态合并回归：is-active（文字列胶囊 + 时间戳主色）与 :hover（仅时间戳主色）
//      待遇不同，合并同规则即互相污染；
//   7. 胶囊越界回归：胶囊底只能落在 .biliscript-reading-text 上——挂回行容器
//      （.is-active 行底）会重新盖掉时间戳列；时间戳不得反白（它不在胶囊内）；
//   8. gate 浅色档强调档漏挂 is-active：活动行时间戳会回落 accent 亮蓝，
//      浅色底上 3.4:1 不达 4.5 门。
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

describe("字幕活动行：实心主色胶囊、下划线删、时间戳减噪", () => {
  it("活动行不再有下划线：任何活动行规则块都不带 text-decoration", () => {
    expect(readCss()).not.toMatch(/\.biliscript-reading-item\.is-active[^{]*\{[^}]*text-decoration/);
  });

  it("本表不再把 success 绿当线色", () => {
    expect(readCss()).not.toMatch(/text-decoration-color:\s*var\(--biliscript-reader-success\)/);
  });

  it("删的是活动行那条线：正文基础段不带 text-decoration", () => {
    expect(ruleBody(readCss(), "\\.biliscript-reading-text")).not.toMatch(/text-decoration/);
  });

  it("活动行胶囊只包文字列：行底不染色，胶囊底落在文字元素上", () => {
    const css = readCss();

    // 行容器不得再带底色——挂回 .is-active 行底会重新盖掉时间戳列。
    expect(css).not.toMatch(
      /(?:^|\n)[ \t]*#biliscript-reading-view \.biliscript-reading-item\.is-active\s*\{[^}]*background/
    );
  });

  it("活动行文字列胶囊：accent 压深 25% 实底 + 恒白 + 加粗 + 圆角内边距", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-text"
    );

    expect(declaration(block, "background")).toBe(
      "color-mix(in srgb, var(--biliscript-reader-accent), #000000 25%)"
    );
    expect(declaration(block, "color")).toBe("#ffffff");
    expect(declaration(block, "font-weight")).toBe("600");
    expect(declaration(block, "border-radius")).toBe("10px");
    expect(declaration(block, "padding")).toBe("2px 10px");
  });

  it("活动行时间戳在胶囊外：回主色加粗，不反白", () => {
    const block = ruleBody(
      readCss(),
      "#biliscript-reading-view \\.biliscript-reading-item\\.is-active \\.biliscript-reading-time"
    );

    expect(declaration(block, "color")).toBe("var(--biliscript-reader-accent)");
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

  it("浅色档时间戳强调档挂悬停 + 活动：time-color token 按色板定稿主色", () => {
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
    // 活动行时间戳在胶囊外回主色，浅色档必须与悬停同规则挂 is-active——
    // 漏挂则回落 reader.css 的 accent 亮蓝，对比不足。
    expect(gate).toContain(
      "#biliscript-reading-view:not([data-theme=\"dark\"]) .biliscript-reading-item.is-active .biliscript-reading-time,"
    );
  });

  it("裸类名活动行规则不回来：面板内它恒被 #id 规则覆盖，是死声明", () => {
    const bare = readCss().match(/(?:^|\n)[ \t]*\.biliscript-reading-item\.is-active\s*\{([^}]*)\}/);

    expect(bare, "不应存在 .biliscript-reading-item.is-active 裸类名规则").toBe(null);
  });
});
