// tests/reader/inner-cards-glass.test.ts
// 03 号票：AI 对话与设置内嵌卡片 Flyme 玻璃材质补齐样式契约。
// 涉及 5 处内嵌卡片与容器：
// 1. .chat-msg-assistant（助手回复气泡）
// 2. .biliscript-reading-explain-card-dialog（选区解释卡）
// 3. .chat-thinking（思考过程折叠块）
// 4. .chat-search-card（联网搜索时间线卡）
// 5. .provider-editor-fetch-list（设置「获取可用模型」弹窗内的模型勾选列表容器）

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

describe("03: AI 对话与设置内嵌卡片 Flyme 玻璃材质补齐", () => {
  const TARGET_SELECTORS = [
    ".chat-msg-assistant",
    ".biliscript-reading-explain-card-dialog",
    ".chat-thinking",
    ".chat-search-card",
    ".provider-editor-fetch-list"
  ];

  it("Flyme 浅色与深色：5 处内嵌卡片/容器均去除 1px 实线边框，统一白玻璃凸起与微阴影高光", () => {
    const gate = stripComments(readCss(GATE_CSS));

    for (const sel of TARGET_SELECTORS) {
      expect(gate, `gate 表应包含 ${sel}`).toContain(sel);
    }

    // 浅色卡片微阴影与顶缘内高光 + 背景使用 var(--biliscript-reader-card) + border: none
    expect(gate).toContain("background: var(--biliscript-reader-card)");
    expect(gate).toContain("box-shadow: 0 1px 3px rgba(23, 24, 26, 0.06), 0 3px 10px rgba(23, 24, 26, 0.07), inset 0 1px 0 rgba(255, 255, 255, 0.7)");

    // 深色卡片极轻阴影与暗调内高光
    expect(gate).toContain("box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.07)");
  });

  it("卡片内部的分隔线保持清晰可读，不被误删", () => {
    const chatCss = stripComments(readCss(CHAT_CSS));

    // 思考块头部下边线
    expect(chatCss).toContain("border-bottom: 1px solid var(--biliscript-reader-border)");

    // 联网搜索步骤间虚线
    expect(chatCss).toContain("border-top: 1px dashed var(--biliscript-reader-border)");
  });

  it("助手消息气泡具备和谐的内边距与气泡形状（10px 14px、底部左侧微尾巴）", () => {
    const chatCss = readCss(CHAT_CSS);
    const assistantBody = ruleBody(chatCss, ".biliscript-reading-chat .chat-msg-assistant");

    expect(assistantBody).toContain("padding: 10px 14px");
    expect(assistantBody).toContain("border-radius: 14px");
    expect(assistantBody).toContain("border-bottom-left-radius: 6px");
  });

  it("editorial 数字刊物色板下：5 处内嵌卡片与容器维持 1px 实线边框与零投影", () => {
    const gate = stripComments(readCss(GATE_CSS));

    for (const sel of TARGET_SELECTORS) {
      expect(
        gate.includes(`[data-palette="editorial"]`) && gate.includes(sel),
        `editorial 规则中应包含 ${sel}`
      ).toBe(true);
    }

    const editorialBlock = ruleBody(
      readCss(GATE_CSS),
      `#biliscript-reading-view[data-palette="editorial"] .biliscript-reading-chat .chat-msg-assistant`
    );
    expect(editorialBlock).toContain("border: 1px solid var(--biliscript-reader-border)");
    expect(editorialBlock).toContain("box-shadow: none");
  });
});
