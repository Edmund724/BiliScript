// tests/entry/tokens-component.test.ts
// Component Token 组件层契约测试（工单 03）：
// 验证 5 类高频公共组件（Buttons & Chips、Segmented Controls / Pills & Tabs、
// Chat Input card、Custom Select、Toggle Switch）的组件级 Token 提取与接入。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GATE_CSS = "extension/entry/styles/reader-gate.css";
const CUSTOM_SELECT_CSS = "extension/entry/styles/custom-select.css";
const TOGGLE_SWITCH_CSS = "extension/entry/styles/toggle-switch.css";

function readFile(relPath: string): string {
  return readFileSync(join(ROOT, relPath), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// 提取指定结尾选择器的主题块 body
function getGateBlock(tailSelector: string, headStartsWith?: string): string {
  const text = stripComments(readFile(GATE_CSS));
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const hit = rules.find((rule) => {
    const head = rule.split("{")[0].trim();
    return head.endsWith(tailSelector) && (!headStartsWith || head.startsWith(headStartsWith));
  });
  expect(hit, `reader-gate.css 应存在以 ${tailSelector} 结尾的规则块`).not.toBeUndefined();
  return hit!.split("{")[1];
}

describe("03 Component Tokens: 组件层契约测试", () => {
  const BASE_GATE = () => getGateBlock("#biliscript-reading-view", "html[data-biliscript-reader-mode=\"1\"]");
  const DARK_GATE = () => getGateBlock("#biliscript-reading-view[data-theme=\"dark\"]");

  describe("1. 操作按钮与 Chips（Buttons & Chips）组件 Token", () => {
    it("声明完整的 --btn-* 与 --chip-* 组件级 Token", () => {
      const block = BASE_GATE();

      // 基础按钮度量与色彩
      expect(block).toContain("--btn-bg:");
      expect(block).toContain("--btn-text: var(--biliscript-reader-text)");
      expect(block).toContain("--btn-border: var(--biliscript-reader-border)");
      expect(block).toContain("--btn-radius: var(--biliscript-radius-pill)");
      expect(block).toContain("--btn-font-size: var(--biliscript-font-size-base)");
      expect(block).toContain("--btn-hover-bg: var(--biliscript-reader-fill-hover)");
      expect(block).toContain("--btn-active-scale: var(--biliscript-reader-press-scale");

      // 主要、次要与危险按钮变体
      expect(block).toContain("--btn-primary-bg: var(--biliscript-reader-accent)");
      expect(block).toContain("--btn-primary-text: var(--biliscript-reader-on-fill)");
      expect(block).toContain("--btn-secondary-bg: var(--biliscript-reader-surface-2)");
      expect(block).toContain("--btn-secondary-text: var(--biliscript-reader-muted)");
      expect(block).toContain("--btn-danger-bg: var(--biliscript-reader-danger)");
      expect(block).toContain("--btn-danger-text: var(--biliscript-reader-on-fill)");

      // Chips 类组件 Token
      expect(block).toContain("--chip-bg:");
      expect(block).toContain("--chip-text: var(--biliscript-reader-text)");
      expect(block).toContain("--chip-border: var(--biliscript-reader-border)");
      expect(block).toContain("--chip-radius: var(--biliscript-radius-pill)");
      expect(block).toContain("--chip-font-size: var(--biliscript-font-size-sm)");
      expect(block).toContain("--chip-hover-bg: var(--biliscript-reader-fill-hover)");
      expect(block).toContain("--chip-active-bg: var(--biliscript-reader-accent-soft)");
      expect(block).toContain("--chip-active-text: var(--biliscript-reader-accent)");
    });
  });

  describe("2. 分段控件与标签项（Segmented Controls / Pills & Tabs）组件 Token", () => {
    it("声明完整的 --pill-* 组件级 Token", () => {
      const block = BASE_GATE();

      expect(block).toContain("--pill-bg: var(--biliscript-reader-pill-bg)");
      expect(block).toContain("--pill-text: var(--biliscript-reader-muted)");
      expect(block).toContain("--pill-radius: var(--biliscript-radius-md)");
      expect(block).toContain("--pill-radius-full: var(--biliscript-radius-pill)");
      expect(block).toContain("--pill-indicator-bg: var(--biliscript-reader-card)");
      expect(block).toContain("--pill-active-text: var(--biliscript-reader-accent)");
      expect(block).toContain("--pill-indicator-shadow:");
      expect(block).toContain("--pill-gap: var(--biliscript-space-sm)");
      expect(block).toContain("--pill-pad-x: var(--biliscript-space-xs)");
      expect(block).toContain("--pill-pad-y: var(--biliscript-space-xs)");
    });

    it("深色模式下提供暗面专用的 --pill-indicator-shadow", () => {
      const darkBlock = DARK_GATE();
      expect(darkBlock).toContain("--pill-indicator-shadow:");
    });
  });

  describe("3. 聊天输入卡片（Chat Input Card）组件 Token", () => {
    it("声明输入卡片卡面、聚焦环与操作区组件 Token", () => {
      const block = BASE_GATE();

      expect(block).toContain("--chat-input-bg: var(--biliscript-reader-surface)");
      expect(block).toContain("--chat-input-border: var(--biliscript-reader-border)");
      expect(block).toContain("--chat-input-radius: var(--biliscript-radius-panel)");
      expect(block).toContain("--chat-input-focus-border: var(--biliscript-reader-accent)");
      expect(block).toContain("--chat-input-focus-ring: 0 0 0 2px var(--biliscript-reader-accent-soft)");
      expect(block).toContain("--chat-input-action-shadow: var(--biliscript-reader-card-highlight)");
      expect(block).toContain("--chat-input-font-size: var(--biliscript-font-size-base)");
    });
  });

  describe("4. 自定义下拉（Custom Select）组件 Token 与样式接入", () => {
    it("reader-gate.css 中声明 --select-* 组件级 Token", () => {
      const block = BASE_GATE();

      expect(block).toContain("--select-trigger-bg: var(--biliscript-reader-card)");
      expect(block).toContain("--select-trigger-text: var(--biliscript-reader-text)");
      expect(block).toContain("--select-trigger-border: var(--biliscript-reader-border)");
      expect(block).toContain("--select-trigger-radius: var(--biliscript-radius-panel)");
      expect(block).toContain("--select-trigger-font-size: var(--biliscript-font-size-base)");
      expect(block).toContain("--select-dropdown-bg: var(--biliscript-reader-card)");
      expect(block).toContain("--select-dropdown-border: var(--biliscript-reader-border)");
      expect(block).toContain("--select-dropdown-radius: var(--biliscript-radius-panel)");
      expect(block).toContain("--select-dropdown-shadow:");
      expect(block).toContain("--select-option-radius: var(--biliscript-radius-panel-inner)");
      expect(block).toContain("--select-option-hover-bg: var(--biliscript-reader-surface-2)");
      expect(block).toContain("--select-option-selected-bg: var(--biliscript-reader-accent-soft)");
      expect(block).toContain("--select-option-selected-text: var(--biliscript-reader-accent)");
      expect(block).toContain("--select-search-radius: var(--biliscript-radius-pill)");
      expect(block).toContain("--select-search-font-size: var(--biliscript-font-size-sm)");
      expect(block).toContain("--select-arrow-color: var(--biliscript-reader-faint)");
    });

    it("custom-select.css 全面消费组件 Token 与语义 Token，无裸 HEX 与硬编码 28px/14px", () => {
      const css = stripComments(readFile(CUSTOM_SELECT_CSS));

      // 禁止裸 HEX 颜色（包括之前的 #00aeec 和 #999）
      const hexMatches = css.match(/#[0-9a-fA-F]{3,8}(?![a-zA-Z0-9_-])/g) || [];
      expect(hexMatches, "custom-select.css 中不应有裸 HEX 颜色").toEqual([]);

      // 弹层与触发器圆角应消费 --select-*-radius
      expect(css).toMatch(/border-radius:\s*var\(--select-dropdown-radius/);
      expect(css).toMatch(/border-radius:\s*var\(--select-trigger-radius/);

      // 选项行圆角应消费 --select-option-radius 或 --biliscript-radius-panel-inner
      expect(css).toMatch(/border-radius:\s*(?:var\(--select-option-radius|max\(0px,\s*var\(--select-option-radius)/);

      // 搜索框字号与圆角应消费 token
      expect(css).toMatch(/border-radius:\s*var\(--select-search-radius/);
      expect(css).toMatch(/font-size:\s*var\(--select-search-font-size/);

      // 箭头颜色消费 --select-arrow-color
      expect(css).toMatch(/color:\s*var\(--select-arrow-color/);
    });
  });

  describe("5. 自绘开关（Toggle Switch）组件 Token 与样式接入", () => {
    it("reader-gate.css 中声明 --toggle-* 组件级 Token", () => {
      const block = BASE_GATE();

      expect(block).toContain("--toggle-track-radius: var(--biliscript-radius-pill)");
      expect(block).toContain("--toggle-track-bg-off: var(--biliscript-reader-surface-3)");
      expect(block).toContain("--toggle-track-bg-on: var(--biliscript-reader-accent)");
      expect(block).toContain("--toggle-focus-ring: 0 0 0 2px var(--biliscript-reader-accent-soft)");
      expect(block).toContain("--toggle-thumb-radius: var(--biliscript-radius-circle)");
      expect(block).toContain("--toggle-thumb-bg: var(--biliscript-primitive-color-white)");
      expect(block).toContain("--toggle-thumb-shadow:");
    });

    it("toggle-switch.css 消费组件 Token 与语义 Token", () => {
      const css = stripComments(readFile(TOGGLE_SWITCH_CSS));

      // 轨道圆角消费 token
      expect(css).toMatch(/border-radius:\s*var\(--toggle-track-radius/);

      // 轨道关态与开态背景消费 token
      expect(css).toMatch(/background:\s*var\(--toggle-track-bg-off/);
      expect(css).toMatch(/background:\s*var\(--toggle-track-bg-on/);

      // 滑块圆角与背景消费 token
      expect(css).toMatch(/border-radius:\s*var\(--toggle-thumb-radius/);
      expect(css).toMatch(/background:\s*var\(--toggle-thumb-bg/);

      // 滑块微阴影消费 token
      expect(css).toMatch(/box-shadow:\s*var\(--toggle-thumb-shadow/);
    });
  });
});
