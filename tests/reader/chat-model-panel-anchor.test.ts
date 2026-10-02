// tests/reader/chat-model-panel-anchor.test.ts
// 模型面板的「锚点 + 宽度」契约（发送框紧凑化）：面板从 chip 上方呼出、
// 宽度跟 chip 可见宽，不再占满整个对话列。两半守卫：
// - 模板（chat-template）：面板与 chip 同挂在新增的 .chat-model-anchor 里（锚点
//   容器是输入行的 flex 项），面板不再是 footer 直下、不再与输入卡片同级——面板
//   的定位父级就是 chip 本身所在容器，bottom: calc(100% + …) 才落在 chip 上方；
// - CSS（reader-chat.css）：面板锚点改 right:0 + bottom: calc(100% + 6px)
//   （右缘对齐 chip 右缘、底边压在输入框上），与历史对话（2026-09 起改为整页
//   接管、不再是弹层）彻底分家；锚点容器 position:relative 并接管
//   margin-left:auto；窄面板里模型名换行（最多 2 行）保持可辨。
// 防倒退：面板几何一旦回流成「与历史同一条全宽弹层规则」，本文件红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const CHAT_PANEL = ".biliscript-reading-chat .chat-model-panel";
const HISTORY_POPOVER = ".biliscript-reading-chat .chat-history-popover";
const MODEL_ANCHOR = ".biliscript-reading-chat .chat-model-anchor";

let ids: typeof import("../../extension/reader/state.js").ids;
let buildChatTabBodyHtml: typeof import("../../extension/reader/chat-template.js").buildChatTabBodyHtml;

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  ids = (await import("../../extension/reader/state.js")).ids;
  buildChatTabBodyHtml = (await import("../../extension/reader/chat-template.js")).buildChatTabBodyHtml;
  document.body.innerHTML = buildChatTabBodyHtml();
});

// 顶层规则抽取（锚点规则都不嵌套在 at-rule 内）：剥注释后按 {…} 取 selector 部与
// 声明部（与 tests/entry/reader-chat-css-split.test.ts 的 findRule 同口径）。
function cssRules(): { head: string; body: string }[] {
  const css = readFileSync(join(ROOT, CHAT_CSS), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return (css.match(/[^{}]+\{[^}]*\}/g) || []).map((rule) => {
    const [head, body] = rule.split("{");
    return { head, body };
  });
}

function ruleBody(selector: string): string {
  return ruleBodies(selector).join("\n");
}

// 一个选择器可能落在多条规则里（共同壳 + 各自锚点），按出现顺序全部取回。
function ruleBodies(selector: string): string[] {
  return cssRules()
    .filter((rule) => rule.head.split(",").map((part) => part.trim()).includes(selector))
    .map((rule) => rule.body);
}

describe("模型面板锚点（模板结构）", () => {
  it("面板与 chip 同挂 .chat-model-anchor，锚点容器在输入行内", () => {
    const chip = document.getElementById(ids.readingChatModelChip) as HTMLElement;
    const panel = document.getElementById(ids.readingChatModelPanel) as HTMLElement;

    expect(chip.parentElement?.classList.contains("chat-model-anchor")).toBe(true);
    expect(panel.parentElement).toBe(chip.parentElement);
    expect(chip.parentElement?.parentElement?.id).toBe(ids.readingChatInputBar);
  });

  it("面板不再是 footer 直下（定位父级从 footer 换成 chip 锚点）", () => {
    const panel = document.getElementById(ids.readingChatModelPanel) as HTMLElement;

    expect(panel.parentElement?.classList.contains("chat-footer")).toBe(false);
    expect(panel.previousElementSibling?.id).toBe(ids.readingChatModelChip);
  });
});

describe("模型面板锚点（CSS 契约）", () => {
  it("面板锚在 chip 锚点上：右缘对齐 + 底边落在 chip 上方 6px（非全宽）", () => {
    const body = ruleBody(CHAT_PANEL);

    expect(body).toContain("left: auto");
    expect(body).toContain("right: 0");
    expect(body).toContain("bottom: calc(100% + 6px)");
    // 内联宽按 border-box：面板外宽 = chip 外宽（chip 是 button 本就 border-box）
    expect(body).toContain("box-sizing: border-box");
  });

  it("历史页不再是 footer 上方的小浮层，且与面板不共享弹层壳规则", () => {
    // 历史对话是整页接管：脱流覆盖层铺满对话区（2026-12 配色定稿起负 inset
    // 外溢 tab-body 内边距、盖满整张内容区白卡），没有任何 footer 锚点
    // ——带 footer 锚的浮层几何（bottom: calc(100% + 4px)）与「锚在自己内容上方」
    // 的定位（bottom 表达式）都不得出现；浮层几何的唯一合法持有者是模型面板。
    const historyBody = ruleBody(HISTORY_POPOVER);
    expect(historyBody).not.toContain("bottom: calc(100% + 4px)");
    expect(historyBody).not.toContain("bottom: calc");
    expect(historyBody).toMatch(/inset:\s*-\d+px\s+-\d+px\s+-\d+px/);

    const shared = cssRules().filter(
      (rule) => rule.head.includes("chat-history-popover") && rule.head.includes("chat-model-panel")
    );
    expect(shared).toEqual([]);
  });

  it("锚点容器 position:relative 并接管 margin-left:auto（chip 自身不再右推）", () => {
    const anchorBody = ruleBody(MODEL_ANCHOR);
    expect(anchorBody).toContain("position: relative");
    expect(anchorBody).toContain("margin-left: auto");

    expect(ruleBody(".biliscript-reading-chat .chat-model-chip")).not.toContain("margin-left");
  });

  it("窄面板里模型名换行且最多 2 行（超出才省略号）", () => {
    const body = ruleBody(".biliscript-reading-chat .chat-model-option-name");

    expect(body).toContain("-webkit-line-clamp: 2");
    expect(body).toContain("overflow-wrap: anywhere");
  });
});
