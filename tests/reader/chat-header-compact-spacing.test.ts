// tests/reader/chat-header-compact-spacing.test.ts
// 2026-10 用户决议（截图，两轮）：头部只剩两个 32px 高的操作键，而头部盒仍是
// min-height 42px + padding 6px/8px——「历史对话」上下各空出一截。第一轮把头部盒
// 收为控件等高（32px）+ 上下留白 2px/4px，但上方仍空：上面的空档除头部自身 2px 外
// 还有 .biliscript-reading-tab-body 给三个 tab 共用的 14px 板面顶距。第二轮在
// reader-chat.css 里按对话面板（:has(> .biliscript-reading-chat)）把它单独收到 4px
// ——对话面板首行是工具条而非正文，不需要正文级的板面留白；字幕/概览两 tab 的
// 14px 不动（规则在 reader.css 域）。
// 形状同 chat-header-context-chip-removed：直接断言 CSS 文本，防「改一半」
//（只改 min-height 忘 padding、或只改头部忘上方板面顶距）。
// 2026-10 第三～五轮（加框 → 每键各一个框 → 统一 8px 方框，见
// chat-header-toolbox.test.ts）：头部盒的 0/4 左右内边距与 2/4 上下留白先后被按钮
// 自身的边框取代——第五轮两键改成 34px 方框后，键高（34 + 上下 1px 边框 = 36px）
// 已高于原 32px 控件，头部行不再需要任何自身留白：min-height 与 padding 一并删掉，
// 「无额外纵高」改由「块内既无 min-height 也无 padding」接住。
// 2026-11 用户决议（截图，第六轮）：4px 顶距 + 转写状态行 0 顶距又走到了另一头——
// 用户报「历史对话上下太挤了，转写的时候甚至略有重叠」。实测（headless Chromium，
// .scratch/chat-spacing-preview）：标签槽底到按钮顶 8px、按钮底到转写行顶 **0px**
//（转写行上边框与按钮下边框贴着）。本轮把板面顶距 4 → 10px、转写状态行 margin-top
// 0 → 10px（消息区自身 padding-top 12px 不动）。
// 2026-11 第七轮（同一份用户反馈的后半句「下方依然有间距问题」+ 截图）：上方好了，
// 下方只修了转写行——消息区滚动起来后，被裁剪的消息内容仍然正好贴在按钮下边框上
//（消息区顶边 = 头部行底边，容器内的内容滚到顶边即被裁在 0px 处）。散落在每个后继
// 块上的间隔无法覆盖消息区这条路径（它没有 margin），故改由**头部行自己承担下方
// 间隔**：.chat-header 加 margin-bottom，转写行的自备 margin-top 退回 0。于是意图卡 /
// 转写行 / 消息区（含滚动裁剪线）三处间隔同源同值，新增后继块也自动继承。
// 局限与 chat-history-page 同：jsdom 无布局，本文件只能锁 CSS 取值与作用域，真正的
// 几何回归由 .scratch/chat-spacing-preview 的真实浏览器测量兜；防倒退：板面顶距再回到
// 单数字、头部行丢掉 margin-bottom（消息区又贴回按钮）、任一块再自备一份顶距（间隔
// 叠成双倍）、或顶距覆写丢了 :has 作用域，本文件红。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const READER_CSS = "extension/entry/styles/reader.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function readChatCss(): string {
  return readCss(CHAT_CSS);
}

function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector} \\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function chatHeaderBlock(): string {
  return ruleBody(readChatCss(), "\\.biliscript-reading-chat \\.chat-header");
}

// 对话面板的板面顶距覆写（只命中对话面板，字幕/概览两 tab 不受影响）。
function chatPanelPaddingTop(): string {
  const match = readChatCss().match(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\) \{([^}]*)\}/s);
  expect(match, "reader-chat.css 中应有对话面板的板面内边距覆写规则").not.toBe(null);
  const paddingTop = match![1].match(/padding-top:\s*([^;]+);/);
  expect(paddingTop, "板面覆写规则里应有 padding-top 声明").not.toBe(null);
  return paddingTop![1].trim();
}

// 某条规则的纵向顶距：简写 `margin` 的首值（缺省即 0），或显式 `margin-top`。
function topGap(block: string): string {
  const shorthand = block.match(/(?:^|;)\s*margin:\s*([^;]+);/);
  if (shorthand) {
    return shorthand[1].trim().split(/\s+/)[0];
  }
  const marginTop = block.match(/(?:^|;)\s*margin-top:\s*([^;]+);/);
  return marginTop ? marginTop![1].trim() : "0px";
}

function chatHeaderBottomGap(): string {
  const marginBottom = chatHeaderBlock().match(/(?:^|;)\s*margin-bottom:\s*([^;]+);/);
  expect(marginBottom, "头部行应自备 margin-bottom（下方间隔的唯一来源）").not.toBe(null);
  return marginBottom![1].trim();
}

function asrNoticeTopGap(): string {
  return topGap(ruleBody(readChatCss(), "\\.biliscript-reading-chat \\.chat-asr-notice"));
}

function intentCardTopGap(): string {
  return topGap(ruleBody(readCss(READER_CSS), "\\.biliscript-reading-chat-intent"));
}

function px(value: string): number {
  expect(value, `间距应是 px 字面值（0 可省单位）：${value}`).toMatch(/^-?\d+(\.\d+)?(px)?$/);
  return Number.parseFloat(value);
}

// 上方几何间距（肉眼看到的那段）= 对话面板板面顶距 + 标签槽自身的内边距
//（reader.css 的「凹槽」4px）——即「粉色药丸下缘 → 工具条按钮上缘」。
function aboveGap(): number {
  const tabs = ruleBody(readCss(READER_CSS), "\\.biliscript-reading-tabs");
  const padding = tabs.match(/(?:^|;)\s*padding:\s*([^;]+);/);
  expect(padding, "reader.css 的标签槽应有 padding（凹槽内边距）").not.toBe(null);
  return px(chatPanelPaddingTop()) + px(padding![1].trim().split(/\s+/)[0]);
}

// 消息区规则块（渐隐遮罩的唯一落点）。
function chatMessagesBlock(): string {
  return ruleBody(readChatCss(), "\\.biliscript-reading-chat \\.chat-messages");
}

function maskImage(block: string, prop: "mask-image" | "-webkit-mask-image"): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `消息区应有 ${prop} 顶部渐隐声明`).not.toBe(null);
  return match![1].trim();
}

// 渐隐长度：从 transparent 0 淡到 #000 <N>px，返回 N。
function fadeLength(block: string): number {
  const mask = maskImage(block, "mask-image").replace(/\s+/g, " ");
  const match = mask.match(/^linear-gradient\(to bottom, transparent 0(?:px)?, #000 (\d+(?:\.\d+)?)px\)$/);
  expect(match, `渐隐应是 transparent → #000 的纵向渐变（无色值）：${mask}`).not.toBe(null);
  return Number.parseFloat(match![1]);
}

const SAME_DECK_MIN = 8;
const SAME_DECK_MAX = 16;
const TOP_BOTTOM_TOLERANCE = 2;

describe("对话头部工具条紧凑化", () => {
  it("头部行不再预留自身纵高：块内既无 min-height 也无 padding", () => {
    const block = chatHeaderBlock();

    expect(block).not.toMatch(/min-height:/);
    expect(block).not.toMatch(/\bpadding:/);
  });

  it("对话面板板面顶距加回到同档留白：工具条不再贴住标签槽", () => {
    const paddingTop = px(chatPanelPaddingTop());

    expect(paddingTop).toBeGreaterThanOrEqual(SAME_DECK_MIN);
    expect(paddingTop).toBeLessThanOrEqual(SAME_DECK_MAX);
  });

  it("板面顶距覆写仍只作用域对话面板（字幕/概览两 tab 保持 reader.css 的 14px）", () => {
    const css = readChatCss();

    expect(css).toMatch(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\)\s*\{[^}]*padding-top:/s);
    // 无作用域的 `.biliscript-reading-tab-body { … padding-top: … }` 覆写会把
    // 字幕/概览面板的首行正文一起下推，禁止出现。
    expect(css).not.toMatch(/\.biliscript-reading-tab-body\s*(?:,|\{)[^{}]*\{[^}]*\bpadding-top:/s);
  });

  it("下方间隔由头部行自己承担（消息区滚动裁剪的那条线也拉开）", () => {
    const gap = px(chatHeaderBottomGap());

    expect(gap).toBeGreaterThanOrEqual(SAME_DECK_MIN);
    expect(gap).toBeLessThanOrEqual(SAME_DECK_MAX);
  });

  it("意图卡 / 转写行不再自备顶距：三处间隔同源，不叠成双倍", () => {
    expect(px(intentCardTopGap())).toBe(0);
    expect(px(asrNoticeTopGap())).toBe(0);
  });

  it("转写行与工具条的总间隔仍是同档留白（头部行 margin-bottom 单份）", () => {
    const total = px(chatHeaderBottomGap()) + px(asrNoticeTopGap());

    expect(total).toBeGreaterThanOrEqual(SAME_DECK_MIN);
    expect(total).toBeLessThanOrEqual(SAME_DECK_MAX);
  });

  it("下方几何间距与上方对齐（肉眼上两边差不多宽）", () => {
    const above = aboveGap();
    const below = px(chatHeaderBottomGap());

    expect(Math.abs(below - above)).toBeLessThanOrEqual(TOP_BOTTOM_TOLERANCE);
  });

  it("消息区顶部有同档长度的渐隐：滚动的硬切变成淡出", () => {
    const length = fadeLength(chatMessagesBlock());

    expect(length).toBeGreaterThanOrEqual(SAME_DECK_MIN);
    expect(length).toBeLessThanOrEqual(SAME_DECK_MAX);
  });

  it("渐隐前缀双写且数值一致（-webkit- 与标准属性同值）", () => {
    const block = chatMessagesBlock();
    const standard = maskImage(block, "mask-image").replace(/\s+/g, " ");
    const prefixed = maskImage(block, "-webkit-mask-image").replace(/\s+/g, " ");

    expect(prefixed).toBe(standard);
  });

  it("渐隐只挂在消息区：工具条与对话根不被遮罩（否则按钮一起淡）", () => {
    const css = readChatCss();
    const header = chatHeaderBlock();
    const root = ruleBody(css, "\\.biliscript-reading-chat");

    expect(header).not.toMatch(/-?webkit-?mask|mask-image/);
    expect(root).not.toMatch(/-?webkit-?mask|mask-image/);
  });

  it("渐隐用无色 stop（transparent / #000），不写死主题色 → 暗色不破相", () => {
    const standard = maskImage(chatMessagesBlock(), "mask-image");

    expect(standard).not.toMatch(/var\(/);
    expect(standard).not.toMatch(/rgba?\(/);
    // 只允许 #000（透明 → 黑的无色遮罩）；出现别的色值就是写死了主题色
    expect(standard.replace(/#000\b/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });
});

