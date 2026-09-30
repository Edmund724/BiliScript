// tests/reader/chat-input-autosize.test.ts
// 「打字/删除每敲一键输入框就长高一行」bug 的 CSS 侧回归（2026-11 用户报障）。
//
// 病灶（headless Chromium 实测，.scratch/input-autosize-probe）：
// 输入框是 UA 默认的 content-box，而 `autosizeInput` 把 `scrollHeight` 写回
// `min-height`，两者在 content-box 下**单位不一致**——Chromium 的 `scrollHeight`
// 含上下内边距（2px+2px=4px），`min-height` 却不含内边距。于是每次回写都被自己
// 放大 4px，下一个 input 事件再把放大后的高读回来 → 逐键 +4px、删除键同样 +4px，
// 上限 320 还得再加 4px 内边距（实测旧实现峰值 324 > CSS 的 max-height 320）。
//
// CSS 侧的唯一必要不变量：输入框改成 border-box，`scrollHeight` 与 `min-height`
// 才是同一个坐标系（padding-box 高度）。只改 JS（测量前清空行内高）解决不了
// 单位错位；只改 CSS 会留下「删字不缩」的迟滞（见下方第二条不变量与 JS 侧
// chat-tab.test.ts 的清空用例）。
// 几何回归由 .scratch/input-autosize-probe（真实浏览器）兜，本文件按仓库惯例只锁
// CSS 取值与作用域（同 chat-header-compact-spacing.test.ts 的局限声明）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const INPUT_SELECTOR = ".biliscript-reading-chat #biliscript-reading-chat-input";

function readChatCss(): string {
  return readFileSync(join(ROOT, CHAT_CSS), "utf8");
}

// 规则块抽取：先按选择器定位 `{ ... }`（输入框规则无嵌套 at-rule）。
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.#*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `reader-chat.css 中应有 ${selector} 规则块`).not.toBe(null);
  return match![1];
}

function declarationBody(block: string, prop: string): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `规则块里应有 ${prop} 声明`).not.toBe(null);
  return match![1].trim();
}

describe("输入框自适应高度：scrollHeight 与 min-height 同坐标系", () => {
  it("输入框是 border-box：scrollHeight 含内边距，min-height 必须同样含内边距", () => {
    const block = ruleBody(readChatCss(), INPUT_SELECTOR);

    expect(declarationBody(block, "box-sizing")).toBe("border-box");
  });

  it("JS 上限与 CSS 上限同值同坐标系：封顶高度不因内边距多出一截", () => {
    const block = ruleBody(readChatCss(), INPUT_SELECTOR);
    const cssMaxHeight = declarationBody(block, "max-height");
    // border-box 下两者都是屏上盒高，直接比字面值。
    expect(cssMaxHeight).toMatch(/^\d+px$/);
    const jsMaxHeight = readFileSync(join(ROOT, "extension/reader/chat-tab.ts"), "utf8").match(
      /const INPUT_MAX_HEIGHT = (\d+);/
    );
    expect(jsMaxHeight, "chat-tab.ts 应有 INPUT_MAX_HEIGHT 常量").not.toBe(null);
    expect(`${jsMaxHeight![1]}px`).toBe(cssMaxHeight);
  });

  it("聚焦下限写成屏上盒高（border-box）：56/48，不再额外叠加内边距", () => {
    const source = readFileSync(join(ROOT, "extension/reader/chat-tab.ts"), "utf8");

    expect(source).toMatch(/const INPUT_FOCUS_MIN_HEIGHT = 56;/);
    expect(source).toMatch(/const INPUT_FOCUS_MIN_HEIGHT_NON_VIDEO = 48;/);
  });
});