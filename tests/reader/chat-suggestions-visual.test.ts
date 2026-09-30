// tests/reader/chat-suggestions-visual.test.ts
// 建议问题区块的观感契约（2026-10 用户决议，参考抖音 AI 对话面板截图）：
// 原先是「1px 描边 + 10px 圆角 + surface 底」的窄 chip、且无任何小标题——用户报
// 「太丑了，参考抖音的设计」。照抖音改两处：
//   1. chip 去描边、改填充式（surface-2 底）+ 14px 大圆角 + 12/16 内边距，
//      align-self: flex-start 让 chip 贴内容宽（不是撑满整行的通栏块）；
//   2. chip 上方补一行带 sparkle 图标的提示（渲染在 chat-lists.ts，类名为契约）。
// 形状同其它 CSS 契约测试：直接断言 CSS 文本，防「改一半」——
//   只改圆角不改底（描边块 + 大圆角四不像）、只改 chip 不补提示行、写死色值
//   （暗色主题破相，token 在 reader-gate.css 两主题定义）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";

function readChatCss(): string {
  return readFileSync(join(ROOT, CHAT_CSS), "utf8");
}

function ruleBody(selector: string): string {
  const match = readChatCss().match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `reader-chat.css 中应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

describe("建议问题区块（参考抖音）", () => {
  it("chip 是填充式大圆角块：无描边、surface-2 底、14px 圆角、12/16 内边距", () => {
    const block = ruleBody("\\.biliscript-reading-chat \\.chat-chip");

    expect(block).not.toMatch(/border:\s*1px/);
    expect(block).toMatch(/border-radius:\s*14px;/);
    expect(block).toMatch(/background:\s*var\(--biliscript-reader-surface-2\);/);
    expect(block).toMatch(/padding:\s*12px 16px;/);
  });

  it("chip 贴内容宽（不撑满整行），悬停升一档底色", () => {
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-chip")).toMatch(/align-self:\s*flex-start;/);
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-chip:hover")).toMatch(
      /background:\s*var\(--biliscript-reader-surface-3\);/
    );
  });

  it("chip 上方有提示行：横排 + 小图标 + 次要色 14px 文案", () => {
    const block = ruleBody("\\.biliscript-reading-chat \\.chat-suggestions-hint");

    expect(block).toMatch(/display:\s*flex;/);
    expect(block).toMatch(/align-items:\s*center;/);
    expect(block).toMatch(/gap:\s*6px;/);
    expect(block).toMatch(/color:\s*var\(--biliscript-reader-muted\);/);
    expect(block).toMatch(/font-size:\s*14px;/);
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-suggestions-hint-icon svg")).toMatch(/width:\s*15px;/);
  });

  it("配色只走 token，不写死色值（暗色主题自动跟随）", () => {
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-chip")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-suggestions-hint")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
