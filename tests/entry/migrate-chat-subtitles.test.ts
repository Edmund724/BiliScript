// tests/entry/migrate-chat-subtitles.test.ts
// 对话面板与双语字幕样式迁移契约测试（reader-chat.css & bilingual-subtitles.css）：
// 验证业务样式全面接入 Primitive / Semantic / Component Token，消除硬编码圆角、字号及裸写色值。

import { describe, expect, it } from "vitest";
import { extractDeclarations, readStyleFile, stripCssComments } from "./css-token-test-utils.js";

const CHAT_CSS = "extension/entry/styles/reader-chat.css";
const BILINGUAL_CSS = "extension/entry/styles/bilingual-subtitles.css";

describe("对话面板与双语字幕样式 Token 迁移契约", () => {
  describe("1. bilingual-subtitles.css 迁移验证", () => {
    it("消除所有硬编码 border-radius（仅允许 0 或引用令牌）", () => {
      const decls = extractDeclarations(readStyleFile(BILINGUAL_CSS), "border-radius");
      expect(decls.length).toBeGreaterThan(0);

      for (const { selector, value } of decls) {
        if (value === "0") continue;
        expect(
          value,
          `bilingual-subtitles.css 中的 ${selector} 仍含有硬编码 border-radius: ${value}`
        ).toMatch(/var\(--(?:biliscript-radius|toggle-track-radius|toggle-thumb-radius|btn-radius)/);
      }
    });

    it("消除所有硬编码 font-size（一律消费 --biliscript-font-size-* 或组件令牌）", () => {
      const decls = extractDeclarations(readStyleFile(BILINGUAL_CSS), "font-size");
      expect(decls.length).toBe(8);

      for (const { selector, value } of decls) {
        expect(
          value,
          `bilingual-subtitles.css 中的 ${selector} 仍含有硬编码 font-size: ${value}`
        ).toMatch(/var\(--(?:biliscript-font-size|btn-font-size|chip-font-size)/);
      }
    });

    it("双语开关接入 toggle-switch 组件令牌且无裸写 hex 色值", () => {
      const css = stripCssComments(readStyleFile(BILINGUAL_CSS));
      expect(css).toMatch(/\.biliscript-bilingual-switch::after\s*\{[^}]*background:\s*var\(--toggle-thumb-bg/);
      expect(css).toMatch(/\.biliscript-bilingual-switch::after\s*\{[^}]*box-shadow:\s*var\(--toggle-thumb-shadow/);
      // 不得含有裸写 #ffffff 或字面 HEX 颜色
      expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    });
  });

  describe("2. reader-chat.css 迁移验证", () => {
    it("消除所有硬编码 border-radius（仅允许 0、inherit 或引用令牌）", () => {
      const decls = extractDeclarations(readStyleFile(CHAT_CSS), "border-radius");
      expect(decls.length).toBeGreaterThan(0);

      for (const { selector, value } of decls) {
        if (value === "0" || value === "inherit") continue;
        // 允许使用 var(--biliscript-radius-*)、var(--chat-input-*)、
        // var(--chat-model-option-radius / --chat-more-item-radius，弹层选项同心圆角
        // scoped 变量）、var(--btn-*)、var(--pill-*)、var(--chip-*) 或基于其的 calc 同心圆角
        const isTokenized =
          /var\(--(?:biliscript-(?:primitive-)?radius|chat-input|chat-model-option-radius|chat-more-item-radius|btn-radius|chip-radius|pill-radius)/.test(
            value
          ) ||
          /calc\([^)]*var\(--biliscript-(?:primitive-)?radius/.test(value) ||
          /calc\([^)]*var\(--chat-input/.test(value);

        expect(
          isTokenized,
          `reader-chat.css 中的 ${selector} 仍含有硬编码 border-radius: ${value}`
        ).toBe(true);
      }
    });

    it("消除所有硬编码 font-size（一律消费 --biliscript-font-size-* 或组件令牌）", () => {
      const decls = extractDeclarations(readStyleFile(CHAT_CSS), "font-size");
      expect(decls.length).toBeGreaterThan(30);

      for (const { selector, value } of decls) {
        // math font-size: 0.95em 属相对单位排版，予以放行
        if (value.endsWith("em") || value.endsWith("%")) continue;

        const isTokenized =
          /var\(--(?:biliscript-font-size|btn-font-size|chip-font-size|pill-font-size|chat-input-font-size|select-)/.test(
            value
          ) ||
          /calc\([^)]*var\(--biliscript-font-size/.test(value);

        expect(
          isTokenized,
          `reader-chat.css 中的 ${selector} 仍含有硬编码 font-size: ${value}`
        ).toBe(true);
      }
    });

    it("输入卡片、发送按钮接入专属组件级 Token", () => {
      const css = stripCssComments(readStyleFile(CHAT_CSS));

      // 输入卡片
      expect(css).toMatch(/\.chat-input-card\s*\{[^}]*border-radius:\s*var\(--chat-input-radius/);
      expect(css).toMatch(/\.chat-input-card\s*\{[^}]*background:\s*var\(--chat-input-bg/);
      expect(css).toMatch(/\.chat-input-card:focus-within\s*\{[^}]*border-color:\s*var\(--chat-input-focus-border/);
      expect(css).toMatch(/\.chat-input-card:focus-within\s*\{[^}]*box-shadow:\s*var\(--chat-input-focus-ring/);

      // 发送按钮
      expect(css).toMatch(/\.chat-send-btn\s*\{[^}]*border-radius:\s*var\(--chat-input-send-radius/);
      expect(css).toMatch(/\.chat-send-btn\s*\{[^}]*background:\s*var\(--chat-input-send-bg/);
      expect(css).toMatch(/\.chat-send-btn\s*\{[^}]*color:\s*var\(--chat-input-send-color/);

      // 输入框文字
      expect(css).toMatch(/#biliscript-reading-chat-input\s*\{[^}]*font-size:\s*var\(--chat-input-font-size/);
      expect(css).toMatch(/#biliscript-reading-chat-input\s*\{[^}]*line-height:\s*var\(--chat-input-line-height/);
    });

    it("消除思考滑块、颜色回退等处的字面 HEX 与硬编码 RGBA", () => {
      const css = stripCssComments(readStyleFile(CHAT_CSS));

      // 思考滑块白底换用 primitive 颜色令牌
      expect(css).toMatch(/\.chat-thinking-thumb\s*\{[^}]*background:\s*var\(--biliscript-primitive-color-white/);

      // 复制状态颜色回退不再硬编码 #2563eb
      expect(css).not.toContain("#2563eb");

      // 无裸写 rgba(0, 0, 0, ...) 或 rgba(255, 255, 255, ...) 阴影/描边（mask-image 与流动星点特殊粒子除外）
      expect(css).not.toMatch(/border:\s*1px\s+solid\s+rgba\(0,\s*0,\s*0,/);
      expect(css).not.toMatch(/box-shadow:[^;]*rgba\(0,\s*0,\s*0,/);
    });
  });
});
