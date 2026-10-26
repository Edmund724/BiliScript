// tests/reader/inner-cards-glass.test.ts
// AI 对话与设置内嵌卡片 Flyme 玻璃材质样式契约。
// 涉及 3 处内嵌卡片与容器：
// 1. .biliscript-reading-explain-card-dialog（选区解释卡）
// 2. .chat-search-card（联网搜索时间线卡）
// 3. .provider-editor-fetch-list（设置「获取可用模型」弹窗内的模型勾选列表容器）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const GATE_CSS = "extension/entry/styles/reader-gate.css";
const READER_CSS = "extension/entry/styles/reader.css";
const PROVIDERS_CSS = "extension/entry/styles/reader-settings-providers.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBody(css: string, selector: string): string {
  const text = stripComments(css);
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const bodies = rules
    .map((rule) => {
      const [head, body] = rule.split("{");
      return { head: head.trim(), body };
    })
    .filter((rule) => rule.head.split(",").map((part) => part.trim()).includes(selector))
    .map((rule) => rule.body);
  expect(bodies.length, `应存在 ${selector} 规则`).toBeGreaterThan(0);
  return bodies.join("\n");
}

describe("AI 对话与设置内嵌卡片 Flyme 玻璃材质", () => {
  const TARGET_SELECTORS = [
    ".biliscript-reading-explain-card-dialog",
    ".chat-search-card",
    ".provider-editor-fetch-list"
  ];

  it("Flyme 浅色与深色：3 处内嵌卡片/容器均去除 1px 实线边框，统一液态玻璃卡面与折射高光", () => {
    const gate = stripComments(readCss(GATE_CSS));

    for (const sel of TARGET_SELECTORS) {
      expect(gate, `gate 表应包含 ${sel}`).toContain(sel);
    }

    // 无边框 + 液态玻璃卡面（--biliscript-reader-card）+ 折射高光 token（明暗两档随主题块 token 自动换值）
    const cardGroup = ruleBody(
      readCss(GATE_CSS),
      "#biliscript-reading-view .biliscript-reading-chat .chat-search-card"
    );
    expect(cardGroup).toContain("background: var(--biliscript-reader-card)");
    expect(cardGroup).toContain("border: none");
    expect(cardGroup).toContain("box-shadow: var(--biliscript-reader-card-highlight)");
  });

  it("思考块与助手正文共用板面，无卡面、边框、阴影与内边距", () => {
    const thinkingBody = ruleBody(readCss(CHAT_CSS), ".biliscript-reading-chat .chat-thinking");
    expect(thinkingBody).toContain("background: transparent");
    expect(thinkingBody).toContain("border: 0");
    expect(thinkingBody).toContain("box-shadow: none");
    expect(thinkingBody).toContain("padding: 0");
  });

  it("联网搜索步骤间虚线保持清晰可读，不被误删", () => {
    const chatCss = stripComments(readCss(CHAT_CSS));
    expect(chatCss).toContain("border-top: 1px dashed var(--biliscript-reader-border)");
  });

  it("助手消息为全宽纯文本流，无气泡圆角与内边距", () => {
    const chatCss = readCss(CHAT_CSS);
    const assistantBody = ruleBody(chatCss, ".biliscript-reading-chat .chat-msg-assistant");

    expect(assistantBody).toContain("background: transparent");
    expect(assistantBody).toContain("border-radius: 0");
    expect(assistantBody).toContain("padding: 0");
  });

  it("思考时长数字节点声明 tabular-nums 防抖", () => {
    const chatCss = readCss(CHAT_CSS);
    const numBody = ruleBody(chatCss, ".biliscript-reading-chat .chat-thinking-duration-num");
    expect(numBody).toContain("font-variant-numeric: tabular-nums");
  });

  it("editorial 数字刊物色板下：3 处内嵌卡片与容器维持 1px 实线边框与零投影", () => {
    const gate = stripComments(readCss(GATE_CSS));

    for (const sel of TARGET_SELECTORS) {
      expect(
        gate.includes(`[data-palette="editorial"]`) && gate.includes(sel),
        `editorial 规则中应包含 ${sel}`
      ).toBe(true);
    }

    const editorialBlock = ruleBody(
      readCss(GATE_CSS),
      `#biliscript-reading-view[data-palette="editorial"] .biliscript-reading-chat .chat-search-card`
    );
    expect(editorialBlock).toContain("border: 1px solid var(--biliscript-reader-border)");
    expect(editorialBlock).toContain("box-shadow: none");
  });
});
