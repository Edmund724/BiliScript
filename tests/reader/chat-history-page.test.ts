// tests/reader/chat-history-page.test.ts
// 历史对话整页接管契约（2026-09 用户决议：历史对话不再是输入卡上方弹出的框，
// 改为类似设置那样盖住 AI 对话 tab 内容区的整页）。
//
// 两半守卫：
// - 模板（chat-template）：历史页是对话根的首个子元素（兄弟选择器成立的前提）、
//   返回键在头部内、不再挂在 .chat-footer 里；
// - CSS（reader-chat.css）：历史页流内接管（flex:1 占满对话区，不再绝对定位锚
//   footer 上方），`[hidden]` 单源 + `~ 对话内容` 兄弟选择器把 header/意图卡/
//   转写状态行/消息区/输入卡整体 display:none（与设置抽屉接管面板第 3–4 行同一
//   套纯属性反应）；材质与动效照抄设置壳层；模型面板仍是绝对定位弹层。
// 防倒退：历史页一旦回流成 footer 上方的绝对定位浮层，或对话内容不再被接管
//（浮层又盖在消息区之上），本文件红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const HISTORY_PAGE = ".biliscript-reading-chat .chat-history-popover";
const MODEL_PANEL = ".biliscript-reading-chat .chat-model-panel";

let ids: typeof import("../../extension/reader/state.js").ids;
let buildChatTabBodyHtml: typeof import("../../extension/reader/chat-template.js").buildChatTabBodyHtml;

beforeEach(async () => {
  resetModuleState();
  setLocationUrl(READER_MODE_URL);
  ids = (await import("../../extension/reader/state.js")).ids;
  buildChatTabBodyHtml = (await import("../../extension/reader/chat-template.js")).buildChatTabBodyHtml;
  document.body.innerHTML = buildChatTabBodyHtml();
});

// 顶层规则抽取（与 tests/reader/chat-model-panel-anchor.test.ts 的 cssRules 同口径）：
// 剥注释后按 {…} 取 selector 部与声明部。
function cssRules(): { head: string; body: string }[] {
  const css = readFileSync(join(ROOT, CHAT_CSS), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return (css.match(/[^{}]+\{[^}]*\}/g) || []).map((rule) => {
    const [head, body] = rule.split("{");
    return { head, body };
  });
}

function ruleBodies(selector: string): string[] {
  return cssRules()
    .filter((rule) => rule.head.split(",").map((part) => part.trim()).includes(selector))
    .map((rule) => rule.body);
}

function ruleBody(selector: string): string {
  return ruleBodies(selector).join("\n");
}

function element(id: string): HTMLElement {
  const node = document.getElementById(id) as HTMLElement | null;
  if (!node) {
    throw new Error(`模板缺节点 ${id}`);
  }
  return node;
}

describe("历史整页（模板结构）", () => {
  it("历史页是对话根的首个子元素，且紧邻其后的就是 .chat-header（兄弟选择器前提）", () => {
    const page = element(ids.readingChatHistoryPopover);
    const root = element(ids.readingChatRoot);

    expect(page.parentElement).toBe(root);
    expect(page.previousElementSibling).toBe(null);
    expect(page.nextElementSibling?.classList.contains("chat-header")).toBe(true);
  });

  it("历史页不再是输入卡（.chat-footer）里的一层浮层，默认 hidden", () => {
    const page = element(ids.readingChatHistoryPopover);

    expect(page.closest(".chat-footer")).toBe(null);
    expect(page.hidden).toBe(true);
  });

  it("头部：返回键在最左、标题居中、清空全部在最右；列表容器排在头部之后", () => {
    const page = element(ids.readingChatHistoryPopover);
    const head = page.querySelector(".chat-history-popover-head") as HTMLElement;
    const back = element(ids.readingChatHistoryBackBtn);
    const clear = element(ids.readingChatHistoryClearBtn);

    expect(head).not.toBe(null);
    expect(head.firstElementChild).toBe(back);
    expect(head.lastElementChild).toBe(clear);
    expect(Array.from(head.children).map((node) => node.textContent?.trim())).toEqual([
      "",
      "历史对话",
      "清空全部"
    ]);
    expect(back.getAttribute("aria-label")).toBe("返回对话");
    expect(page.querySelector(".chat-history-popover-title")?.textContent?.trim()).toBe("历史对话");

    const list = element(ids.readingChatHistoryList);
    expect(list.previousElementSibling?.classList.contains("chat-history-popover-head")).toBe(true);
  });
});

describe("历史整页（CSS 契约）", () => {
  it("流内接管：flex:1 占满对话区，不再绝对定位锚在 footer 上方", () => {
    const body = ruleBody(HISTORY_PAGE);

    expect(body).toContain("flex: 1");
    expect(body).not.toContain("position: absolute");
    expect(body).not.toContain("bottom: calc(100% + 4px)");
  });

  it("[hidden] 单源 + 兄弟选择器隐藏全部对话内容（与设置抽屉接管同款）", () => {
    const hiding = cssRules().filter((rule) => /chat-history-popover:not\(\[hidden\]\)\s*~/.test(rule.head));
    expect(hiding.length).toBeGreaterThan(0);

    const selectors = hiding.map((rule) => rule.head).join("\n");
    for (const hidden of [
      ".chat-header",
      ".biliscript-reading-chat-intent",
      ".chat-asr-notice",
      ".chat-messages",
      ".chat-footer"
    ]) {
      expect(selectors, `接管规则未覆盖 ${hidden}`).toContain(hidden);
    }
    expect(hiding.map((rule) => rule.body).join("\n")).toContain("display: none");
  });

  it("材质与动效照抄设置壳层：overlay 底 + 毛玻璃 + 0.2s opacity allow-discrete", () => {
    const body = ruleBody(HISTORY_PAGE);
    expect(body).toContain("var(--biliscript-reader-overlay-bg");
    expect(body).toContain("backdrop-filter: blur(20px) saturate(180%)");
    expect(body).toContain("transition: opacity 0.2s");
    expect(body).toContain("allow-discrete");
    // 头部固定、列表区独立滚动
    expect(ruleBody(".biliscript-reading-chat .chat-history-list")).toContain("overflow-y: auto");
  });

  it("模型面板仍是 footer 上方的绝对定位弹层，两壳不共享规则", () => {
    expect(ruleBody(MODEL_PANEL)).toContain("position: absolute");

    const shared = cssRules().filter(
      (rule) => rule.head.includes("chat-history-popover") && rule.head.includes("chat-model-panel")
    );
    expect(shared).toEqual([]);
  });
});
