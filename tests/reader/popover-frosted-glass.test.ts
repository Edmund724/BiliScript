// tests/reader/popover-frosted-glass.test.ts
// 02 号票：浮层与弹层毛玻璃防透字及无边框收口契约测试。
// 涉及 5 处浮层/弹层：
// 1. .chat-model-panel（AI 对话的模型与思考档位面板）
// 2. .chat-search-preview（联网搜索来源悬停预览卡）
// 3. .custom-select-dropdown（自定义下拉弹层）
// 4. .provider-editor-host .ai-provider-model-dropdown（平台编辑弹窗内的模型下拉）
// 5. .provider-editor-fetch-dialog（「获取可用模型」二级弹窗）

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const CUSTOM_SELECT_CSS = "extension/entry/styles/custom-select.css";
const ROWS_CSS = "extension/entry/styles/reader-settings-rows.css";
const PROVIDERS_CSS = "extension/entry/styles/reader-settings-providers.css";
const GATE_CSS = "extension/entry/styles/reader-gate.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("02: 浮层与弹层毛玻璃防透字及无边框收口", () => {
  it("基础表内声明：各浮层/弹层均配置 24px 毛玻璃背景模糊", () => {
    const chatCss = readCss(CHAT_CSS);
    expect(chatCss).toMatch(/\.chat-model-panel\s*\{[^}]*backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/);
    expect(chatCss).toMatch(/\.chat-search-preview\s*\{[^}]*backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/);

    const selectCss = readCss(CUSTOM_SELECT_CSS);
    expect(selectCss).toMatch(/\.custom-select-dropdown\s*\{[^}]*backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/);

    const rowsCss = readCss(ROWS_CSS);
    expect(rowsCss).toMatch(/\.ai-provider-model-dropdown\s*\{[^}]*backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/);

    const providersCss = readCss(PROVIDERS_CSS);
    expect(providersCss).toMatch(/\.provider-editor-fetch-dialog\s*\{[^}]*backdrop-filter:\s*blur\(24px\)\s*saturate\(180%\)/);
  });

  it("Flyme 浅色与深色：去除 1px 实线边框，由浮层阴影与顶缘内高光表达边界", () => {
    const gate = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");

    // 浅色浮层规则：无边框 + 白卡渐变底 + 顶缘内高光 (rgba(255, 255, 255, 0.7))
    expect(gate).toContain("body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .chat-model-panel");
    expect(gate).toContain("body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .chat-search-preview");
    expect(gate).toContain("body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .custom-select-dropdown");
    expect(gate).toContain("body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .provider-editor-host .ai-provider-model-dropdown");
    expect(gate).toContain("body[data-biliscript-reader-mode=\"1\"] #biliscript-reading-view .provider-editor-fetch-dialog");

    expect(gate).toMatch(/inset 0 1px 0 rgba\((255, 255, 255|var\(--biliscript-primitive-color-white-rgb\)), 0\.7\)/);
    expect(gate).toMatch(/inset 0 1px 0 rgba\((255, 255, 255|var\(--biliscript-primitive-color-white-rgb\)), 0\.07\)/);
  });

  it("减弱透明度（prefers-reduced-transparency: reduce）：浮层关停 backdrop-filter 并回退为实色背景", () => {
    const gate = readCss(GATE_CSS);
    const reducedBlock = gate.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reducedBlock, "gate 必须含 prefers-reduced-transparency 块").not.toBeNull();

    const content = reducedBlock![1];
    expect(content).toContain(".chat-model-panel");
    expect(content).toContain(".chat-search-preview");
    expect(content).toContain(".custom-select-dropdown");
    expect(content).toContain(".ai-provider-model-dropdown");
    expect(content).toContain(".provider-editor-fetch-dialog");
    expect(content).toContain("backdrop-filter: none");
    expect(content).toContain("background: var(--biliscript-reader-surface)");
  });

  it("滚动降级态（data-biliscript-script-scrolling=1）：各浮层同步关停 backdrop-filter", () => {
    const gate = readCss(GATE_CSS);
    const scrollRules = gate.match(/#biliscript-reading-view\[data-biliscript-script-scrolling="1"\][^{]*\{[^}]*\}/g) || [];
    expect(scrollRules.length).toBeGreaterThan(0);

    const merged = scrollRules.join("\n");
    expect(merged).toContain(".chat-model-panel");
    expect(merged).toContain(".chat-search-preview");
    expect(merged).toContain(".custom-select-dropdown");
    expect(merged).toContain(".ai-provider-model-dropdown");
    expect(merged).toContain(".provider-editor-fetch-dialog");
    expect(merged).toContain("backdrop-filter: none");
  });

  it("editorial 数字刊物色板：保留 1px 实线边框与平底，关停毛玻璃", () => {
    const gate = readCss(GATE_CSS).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const popover of [
      ".chat-model-panel",
      ".chat-search-preview",
      ".custom-select-dropdown",
      ".provider-editor-host .ai-provider-model-dropdown",
      ".provider-editor-fetch-dialog"
    ]) {
      expect(gate).toContain(`[data-palette="editorial"] ${popover}`);
    }

    // 验证 editorial 规则中含 border、box-shadow: none、backdrop-filter: none
    const editorialSection = gate.match(/#biliscript-reading-view\[data-palette="editorial"\][\s\S]*?\{[^}]*border:\s*1px solid var\(--biliscript-reader-border\)[^}]*\}/);
    expect(editorialSection).not.toBeNull();
    expect(editorialSection![0]).toContain("box-shadow: none");
    expect(editorialSection![0]).toContain("backdrop-filter: none");
  });
});
