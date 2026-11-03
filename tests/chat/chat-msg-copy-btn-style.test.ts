// tests/chat/chat-msg-copy-btn-style.test.ts
// AI 对话消息操作键（.chat-msg-action-btn）的 CSS 契约：与图标键母题同一视觉
// 语言（无框、8px 圆角、悬停/焦点 fill-hover 底），样式只留 reader-chat.css
// （分区回流由 tests/entry/reader-chat-css-split.test.ts 守）。防「改一半」：
//   1. 边框摘了 hover/focus 里的 border-color 留着（无边框时的孤儿声明）；
//   2. 悬停底被摘（操作键的存在感只剩图标本身）；
//   3. focus-visible 缺失（键盘焦点无反馈，与母题不一致）；
//   4. 尺寸被顺手改（消息操作行版面回归）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";

function readCss(): string {
  return readFileSync(join(ROOT, CHAT_CSS), "utf8");
}

function ruleBody(css: string, selector: string): string {
  const match = css.match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`));
  expect(match, `应存在 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function declaration(block: string, prop: string): string | undefined {
  return block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`))?.[1].trim();
}

const BASE = "\\.biliscript-reading-chat \\.chat-msg-action-btn";

describe("AI 对话消息操作键的样式契约", () => {
  it("无框：border 摘净且 hover/focus 不留孤儿 border-color", () => {
    const base = ruleBody(readCss(), BASE);

    expect(declaration(base, "border")).toBe("0");
    const css = readCss();
    expect(ruleBody(css, `${BASE}:hover`)).not.toMatch(/border-color:/);
    expect(ruleBody(css, `${BASE}:focus-visible`)).not.toMatch(/border-color:/);
  });

  it("悬停/焦点底是 fill-hover 令牌（与图标键母题同一档）", () => {
    const css = readCss();
    for (const state of [":hover", ":focus-visible"]) {
      const block = ruleBody(css, `${BASE}${state}`);
      expect(declaration(block, "background")).toBe("var(--biliscript-reader-fill-hover)");
    }
  });

  it("尺寸钉 32×32：消息操作行版面不回退", () => {
    const base = ruleBody(readCss(), BASE);

    expect(declaration(base, "width")).toBe("32px");
    expect(declaration(base, "height")).toBe("32px");
  });

  it("图标尺寸 18×18、描边 2：与全站阅读图标一致，不回退为过小的 14px", () => {
    const css = readCss();
    const svgBlock = ruleBody(css, `${BASE} svg`);

    expect(declaration(svgBlock, "width")).toBe("18px");
    expect(declaration(svgBlock, "height")).toBe("18px");
    expect(declaration(svgBlock, "stroke-width")).toBe("2");
  });

  it("各操作图标进行光学对齐补偿（消除圆环过大与方块留白过多偏差）", () => {
    const css = readCss();
    const copyBlock = ruleBody(css, "\\.biliscript-reading-chat \\.chat-msg-copy-btn svg");
    const speakBlock = ruleBody(css, "\\.biliscript-reading-chat \\.chat-msg-speak-btn svg");
    const regenBlock = ruleBody(css, "\\.biliscript-reading-chat \\.chat-msg-regenerate-btn svg");
    const exportBlock = ruleBody(css, "\\.biliscript-reading-chat \\.chat-msg-export-btn svg");

    expect(declaration(copyBlock, "width")).toBe("20px");
    expect(declaration(speakBlock, "width")).toBe("17px");
    expect(declaration(regenBlock, "width")).toBe("15px");
    expect(declaration(exportBlock, "width")).toBe("19px");
  });
});
