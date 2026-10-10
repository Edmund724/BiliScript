// tests/reader/chat-suggestions-visual.test.ts
// 建议问题区块的观感契约：chip 为填充式大圆角块（无描边、surface-3 底、14px
// 圆角、12/16 内边距），贴内容宽不撑满整行；空态欢迎区为「图标 + 引导语 +
// 建议 chips」结构，chips 随欢迎区整体居中、每条 chip 自身也居中（盒居中，
// 盒内文字左对齐）。
// 形状同其它 CSS 契约测试：直接断言 CSS 文本，防「改一半」——
//   只改圆角不改底（描边块 + 大圆角四不像）、写死色值
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

describe("建议问题与空态欢迎区观感", () => {
  it("空态欢迎区在消息区居中（margin:auto 双居中），不贴底", () => {
    const block = ruleBody("\\.biliscript-reading-chat \\.chat-suggestions");

    expect(block).toMatch(/margin:\s*auto;/);
    expect(block).not.toMatch(/margin-top:\s*auto;/);
  });

  it("欢迎区主角：accent-soft 圆底图标 + 17px/600 引导语", () => {
    const icon = ruleBody("\\.biliscript-reading-chat \\.chat-hero-icon");
    expect(icon).toMatch(/border-radius:\s*50%;/);
    expect(icon).toMatch(/background:\s*var\(--biliscript-reader-accent-soft\);/);
    expect(icon).toMatch(/color:\s*var\(--biliscript-reader-accent\);/);

    const title = ruleBody("\\.biliscript-reading-chat \\.chat-hero-title");
    expect(title).toMatch(/font-size:\s*17px;/);
    expect(title).toMatch(/font-weight:\s*600;/);
  });

  it("建议组随欢迎区居中，每条 chip 自身也居中（盒居中，盒内文字左对齐）", () => {
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-hero")).toMatch(/align-items:\s*center;/);
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-hero-sugs")).toMatch(/align-items:\s*center;/);
  });

  it("chip 是填充式大圆角块：无描边、surface-3 底、14px 圆角、12/16 内边距", () => {
    const block = ruleBody("\\.biliscript-reading-chat \\.chat-chip");

    expect(block).not.toMatch(/border:\s*1px/);
    expect(block).toMatch(/border-radius:\s*14px;/);
    expect(block).toMatch(/background:\s*var\(--biliscript-reader-surface-3\);/);
    expect(block).toMatch(/padding:\s*12px 16px;/);
  });

  it("chip 贴内容宽（不撑满整行），悬停走 accent-soft + accent 字母题", () => {
    // 内容宽来自居中容器（align-items: center 取代列方向默认 stretch），chip 不再
    // 写 align-self；盒内文字保持左对齐。
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-chip")).toMatch(/text-align:\s*left;/);

    const hover = ruleBody("\\.biliscript-reading-chat \\.chat-chip:hover");
    // 底色已占满中性色阶顶档（暗色最亮 / 亮色最深），中性「升一档」无落点，
    // 悬停改走全仓既有的 accent-soft 底 + accent 字（可点/选中母题）。
    expect(hover).toMatch(/background:\s*var\(--biliscript-reader-accent-soft\);/);
    expect(hover).toMatch(/color:\s*var\(--biliscript-reader-accent\);/);
  });

  it("配色只走 token，不写死色值（暗色主题自动跟随）", () => {
    expect(ruleBody("\\.biliscript-reading-chat \\.chat-chip")).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});
