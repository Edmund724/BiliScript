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
//（转写行上边框与按钮下边框贴着）。本轮把上下都加回同档留白：板面顶距 4 → 10px，
// 转写行 margin-top 0 → 10px（消息区自身 padding-top 12px 不动）。
// 局限与 chat-history-page 同：jsdom 无布局，本文件只能锁 CSS 取值与作用域，真正的
// 几何回归由 .scratch/chat-spacing-preview 的真实浏览器测量兜；防倒退：顶距再回到
// 单数字、或转写行贴回工具条（0/负边距）、或顶距覆写丢了 :has 作用域，本文件红。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";

function readChatCss(): string {
  return readFileSync(join(ROOT, CHAT_CSS), "utf8");
}

function chatHeaderBlock(): string {
  const match = readChatCss().match(/\.biliscript-reading-chat \.chat-header \{([^}]*)\}/);
  expect(match, "reader-chat.css 中应存在 .chat-header 规则块").not.toBe(null);
  return match![1];
}

// 对话面板的板面顶距覆写（只命中对话面板，字幕/概览两 tab 不受影响）。
function chatPanelPaddingTop(): string {
  const match = readChatCss().match(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\) \{([^}]*)\}/s);
  expect(match, "reader-chat.css 中应有对话面板的板面内边距覆写规则").not.toBe(null);
  const paddingTop = match![1].match(/padding-top:\s*([^;]+);/);
  expect(paddingTop, "板面覆写规则里应有 padding-top 声明").not.toBe(null);
  return paddingTop![1].trim();
}

// 转写状态行与工具条之间的间隔：简写 `margin` 的首值或 `margin-top`。
function asrNoticeTopGap(): string {
  const match = readChatCss().match(/\.biliscript-reading-chat \.chat-asr-notice \{([^}]*)\}/s);
  expect(match, "reader-chat.css 中应存在 .chat-asr-notice 规则块").not.toBe(null);
  const block = match![1];
  const shorthand = block.match(/(?:^|;)\s*margin:\s*([^;]+);/);
  if (shorthand) {
    return shorthand[1].trim().split(/\s+/)[0];
  }
  const marginTop = block.match(/(?:^|;)\s*margin-top:\s*([^;]+);/);
  expect(marginTop, "转写状态行的规则里应有纵向间隔声明（margin / margin-top）").not.toBe(null);
  return marginTop![1].trim();
}

function px(value: string): number {
  expect(value, `间距应是 px 字面值：${value}`).toMatch(/^-?\d+(\.\d+)?px$/);
  return Number.parseFloat(value);
}

describe("对话头部工具条紧凑化", () => {
  it("头部行不再预留自身纵高：块内既无 min-height 也无 padding", () => {
    const block = chatHeaderBlock();

    expect(block).not.toMatch(/min-height:/);
    expect(block).not.toMatch(/\bpadding:/);
  });

  it("对话面板板面顶距加回到同档留白：工具条不再贴住标签槽", () => {
    const paddingTop = px(chatPanelPaddingTop());

    expect(paddingTop).toBeGreaterThanOrEqual(8);
    expect(paddingTop).toBeLessThanOrEqual(16);
  });

  it("板面顶距覆写仍只作用域对话面板（字幕/概览两 tab 保持 reader.css 的 14px）", () => {
    const css = readChatCss();

    expect(css).toMatch(/\.biliscript-reading-tab-body:has\(> \.biliscript-reading-chat\)\s*\{[^}]*padding-top:/s);
    // 无作用域的 `.biliscript-reading-tab-body { … padding-top: … }` 覆写会把
    // 字幕/概览面板的首行正文一起下推，禁止出现。
    expect(css).not.toMatch(/\.biliscript-reading-tab-body\s*(?:,|\{)[^{}]*\{[^}]*\bpadding-top:/s);
  });

  it("转写状态行与工具条之间留出纵向间隔（不再以 0 贴合按钮下边框）", () => {
    const gap = px(asrNoticeTopGap());

    expect(gap).toBeGreaterThanOrEqual(8);
    expect(gap).toBeLessThanOrEqual(16);
  });
});
