// tests/reader/chat-history-page.test.ts
// 历史对话整页接管契约（2026-09 用户决议：历史对话不再是输入卡上方弹出的框，
// 改为类似设置那样盖住 AI 对话 tab 内容区的整页）。
//
// 两半守卫：
// - 模板（chat-template）：历史页是对话根的首个子元素（兄弟选择器成立的前提）、
//   返回键在头部内、不再挂在 .chat-footer 里；
// - CSS（reader-chat.css）：历史页脱流覆盖层（position:absolute + 负 inset 外溢
//   铺满整个 tab 内容区白卡，不再绝对定位锚 footer 上方，也不再以 flex:1 参与对话列），
//   `[hidden]` 单源 + `~ 对话内容` 兄弟选择器把 header/意图卡/转写状态行/消息区/输入卡
//   整体 display:none（与设置抽屉接管面板第 3–4 行同一套纯属性反应）；
//   2026-12 配色定稿：底色由 overlay 半透明白改为不透明 surface 页面灰（打开时兄弟
//   内容整体 display:none，背后本就没有需要透视的内容；半透白 + tab-body 内边距环正是
//   用户报的「一圈灰框」），白卡历史条目契约见 flyme-panel-layering.test.ts；
//   模型面板仍是绝对定位弹层。
// 为什么必须是脱流覆盖层（2026-10 关闭卡顿修复）：display 参与 allow-discrete 的
// 0.2s 淡出期间，历史页仍按 before-change 值渲染——若它是对话列的 flex 项，
// 淡出的这 0.2s 内它与 .chat-messages 平分列高，视频标题所在的 .chat-header
// 被挤到对话区中部，等 display 到点翻转才弹回顶部。脱流后对话内容从关闭首帧起
// 就按最终布局排好，历史页在它上方淡走（与设置抽屉「同占网格行」同一原理的
// flex 版：flex 列无法重叠，故用绝对定位顶替 grid 同行落位）。
// 局限：jsdom 无布局，本文件只能锁机制（脱流 + 接管规则），真正的位置回归由
// 真实浏览器验证；防倒退：历史页一旦回到流内（flex:1）或不再脱流，本文件红。
//
// 防倒退：历史页一旦回流成 footer 上方的绝对定位浮层，或对话内容不再被接管
//（浮层又盖在消息区之上），本文件红。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { READER_MODE_URL, resetModuleState, setLocationUrl } from "../setup.js";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const CHAT_ROOT = ".biliscript-reading-chat";
const HISTORY_PAGE = ".biliscript-reading-chat .chat-history-popover";
const MODEL_PANEL = ".biliscript-reading-chat .chat-model-panel";
const MESSAGES = ".biliscript-reading-chat .chat-messages";

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
  it("脱流覆盖层：absolute + 负 inset 外溢铺满 tab 内容区白卡，不再以 flex:1 参与对话列", () => {
    const body = ruleBody(HISTORY_PAGE);

    expect(body).toContain("position: absolute");
    // 负 inset 外溢对话面板的 tab-body 内边距（2026-12 配色定稿）：覆盖层要盖住
    // 整张白卡，否则四周内边距环露出异色底，正是用户报的「一圈灰框」
    expect(body).toMatch(/inset:\s*-\d+px\s+-\d+px\s+-\d+px/);
    // 参与对话列（flex:1）正是关闭淡出期把 header 挤到中部的原因，必须不回流
    expect(body).not.toContain("flex: 1");
    expect(body).not.toContain("bottom: calc(100% + 4px)");
  });

  it("覆盖层定位上下文 = 对话根（.biliscript-reading-chat 的 position: relative）", () => {
    expect(ruleBody(CHAT_ROOT)).toContain("position: relative");
  });

  it("覆盖层盖得住对话内容：z-index 高于消息区里的绝对定位元素（z-index 20）", () => {
    const z = /z-index:\s*(\d+)/.exec(ruleBody(HISTORY_PAGE));
    expect(z, "历史页缺 z-index，position:relative 的 .chat-messages 会按 DOM 顺序压在上面").not.toBe(null);
    expect(Number(z![1])).toBeGreaterThan(20);
    expect(ruleBody(MESSAGES)).toContain("position: relative");
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

  it("材质：不透明 surface 页面灰（无透视需求——打开时兄弟内容整体 display:none），动效不变", () => {
    const body = ruleBody(HISTORY_PAGE);
    // 2026-12 配色定稿：overlay 半透明白 + 四周内边距环 = 用户报的「一圈灰框」；
    // 铺满白卡后底色取页面灰，白卡历史条目在其上分层（见 flyme-panel-layering）
    expect(body).toContain("background: var(--biliscript-reader-surface)");
    expect(body).not.toContain("overlay-bg");
    expect(body).not.toContain("backdrop-filter");
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
