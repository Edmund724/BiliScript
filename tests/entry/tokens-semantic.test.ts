// tests/entry/tokens-semantic.test.ts
// Semantic Token 语义层契约测试：
// 验证 reader-gate.css 中 4 象限主题（Flyme / Editorial × Light / Dark）的变量实现全部引用 Primitive，
// 并提供圆角语义、字阶语义与向后兼容。

import { describe, expect, it } from "vitest";
import { extractBlock, readStyleFile } from "./css-token-test-utils.js";

const GATE_CSS = "extension/entry/styles/reader-gate.css";

function getThemeBlock(tailSelector: string, headStartsWith?: string): string {
  return extractBlock(readStyleFile(GATE_CSS), tailSelector, headStartsWith);
}

describe("Semantic Tokens: reader-gate.css 语义层契约", () => {
  const FLYME_LIGHT = () => getThemeBlock("#biliscript-reading-view", "html[data-biliscript-reader-mode=\"1\"]");
  const FLYME_DARK = () => getThemeBlock("#biliscript-reading-view[data-theme=\"dark\"]");
  const EDITORIAL_LIGHT = () => getThemeBlock("#biliscript-reading-view[data-palette=\"editorial\"]");
  const EDITORIAL_DARK = () => getThemeBlock("#biliscript-reading-view[data-theme=\"dark\"][data-palette=\"editorial\"]");

  describe("1. 度量语义体系（Radius / Font Size / Spacing）", () => {
    it("定义完整的标准圆角语义 token 集合并映射到 primitive-radius", () => {
      const baseBlock = FLYME_LIGHT();

      // 面板外壳圆角与内嵌同心圆角
      expect(baseBlock).toContain("--biliscript-radius-panel: var(--biliscript-primitive-radius-28)");
      expect(baseBlock).toMatch(/--biliscript-radius-panel-inner:\s*(?:calc|max)\([^;]*var\(--biliscript-radius-panel\)[^;]*\)/);

      // 胶囊与圆形
      expect(baseBlock).toMatch(/--biliscript-radius-pill:\s*var\(--biliscript-primitive-radius-(?:pill|full)\)/);
      expect(baseBlock).toContain("--biliscript-radius-circle: var(--biliscript-primitive-radius-circle)");

      // 阶梯圆角
      expect(baseBlock).toContain("--biliscript-radius-xs: var(--biliscript-primitive-radius-4)");
      expect(baseBlock).toContain("--biliscript-radius-sm: var(--biliscript-primitive-radius-8)");
      expect(baseBlock).toContain("--biliscript-radius-md: var(--biliscript-primitive-radius-12)");
      expect(baseBlock).toContain("--biliscript-radius-lg: var(--biliscript-primitive-radius-16)");
      expect(baseBlock).toContain("--biliscript-radius-xl: var(--biliscript-primitive-radius-20)");
    });

    it("规范联动 --biliscript-reader-font-scale 的完整 6 档字阶语义变量", () => {
      const baseBlock = FLYME_LIGHT();

      expect(baseBlock).toMatch(/--biliscript-font-size-xs:\s*calc\(var\(--biliscript-primitive-font-size-(?:11|xs)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-sm:\s*calc\(var\(--biliscript-primitive-font-size-(?:12|sm)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-base:\s*calc\(var\(--biliscript-primitive-font-size-(?:14|base)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-md:\s*calc\(var\(--biliscript-primitive-font-size-(?:16|md)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-lg:\s*calc\(var\(--biliscript-primitive-font-size-(?:18|lg)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-xl:\s*calc\(var\(--biliscript-primitive-font-size-(?:20|xl)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);

      // 字幕字号保持向后兼容定义
      expect(baseBlock).toContain("--biliscript-reader-subtitle-font-size:");
    });

    it("提供基础间距语义阶梯", () => {
      const baseBlock = FLYME_LIGHT();
      expect(baseBlock).toContain("--biliscript-space-xs: var(--biliscript-primitive-space-4)");
      expect(baseBlock).toContain("--biliscript-space-sm: var(--biliscript-primitive-space-8)");
      expect(baseBlock).toContain("--biliscript-space-md: var(--biliscript-primitive-space-12)");
      expect(baseBlock).toContain("--biliscript-space-lg: var(--biliscript-primitive-space-16)");
      expect(baseBlock).toContain("--biliscript-space-xl: var(--biliscript-primitive-space-20)");
    });
  });

  describe("2. 四象限色彩语义引用 Primitive（无裸 HEX / 裸 RGBA）", () => {
    const quadrants = [
      { name: "Flyme Light (基准浅色)", getBlock: FLYME_LIGHT },
      { name: "Flyme Dark (深色)", getBlock: FLYME_DARK },
      { name: "Editorial Light (数字刊物浅色)", getBlock: EDITORIAL_LIGHT },
      { name: "Editorial Dark (数字刊物深色)", getBlock: EDITORIAL_DARK }
    ];

    for (const { name, getBlock } of quadrants) {
      it(`${name} 的色彩与材质语义变量中禁止直接裸写 HEX 颜色`, () => {
        const block = getBlock();
        // 查找 --biliscript-reader-* 或 --biliscript-gemini-* 声明中包含裸 HEX 的行
        const hexMatches = block.match(/--(?:biliscript-reader|biliscript-gemini)-[a-z0-9-]+:\s*[^;]*#[0-9a-fA-F]+/g) || [];
        expect(hexMatches, `${name} 不应在变量右侧裸写 HEX 颜色`).toEqual([]);
      });

      it(`${name} 的色彩与材质语义变量中禁止裸写数值型 rgba(r, g, b, a)`, () => {
        const block = getBlock();
        // 匹配右侧含有 rgba(数字, 数字, ... 的变量定义，合规写法必须是 rgba(var(--...-rgb), a)
        const rawRgbaMatches = block.match(/--(?:biliscript-reader|biliscript-gemini)-[a-z0-9-]+:\s*[^;]*rgba?\(\s*\d+\s*,/g) || [];
        expect(rawRgbaMatches, `${name} 的 rgba 必须消费 primitive 的 -rgb 通道变量`).toEqual([]);
      });
    }

    it("Flyme Light 色彩语义全部正确引用 Primitive 调色板", () => {
      const block = FLYME_LIGHT();
      expect(block).toContain("--biliscript-reader-surface: var(--biliscript-primitive-color-gray-50)");
      expect(block).toContain("--biliscript-reader-surface-2: var(--biliscript-primitive-color-gray-100)");
      expect(block).toContain("--biliscript-reader-surface-3: var(--biliscript-primitive-color-gray-200)");
      expect(block).toContain("--biliscript-reader-border: var(--biliscript-primitive-color-gray-300)");
      expect(block).toContain("--biliscript-reader-text: var(--biliscript-primitive-color-gray-950)");
      expect(block).toContain("--biliscript-reader-muted: var(--biliscript-primitive-color-gray-600)");
      expect(block).toContain("--biliscript-reader-faint: var(--biliscript-primitive-color-gray-500)");
      expect(block).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-blue-500)");
      expect(block).toContain("--biliscript-reader-accent-ink: var(--biliscript-primitive-color-white)");
      expect(block).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-blue-600)");
      expect(block).toContain("--biliscript-reader-pill-bg: var(--biliscript-primitive-color-gray-200)");
      expect(block).toContain("--biliscript-reader-success: var(--biliscript-primitive-color-green-500)");
      expect(block).toContain("--biliscript-reader-danger: var(--biliscript-primitive-color-red-500)");
      expect(block).toContain("--biliscript-reader-on-fill: var(--biliscript-primitive-color-white)");
    });

    it("Flyme Dark 色彩语义全部正确引用 Primitive 调色板", () => {
      const block = FLYME_DARK();
      expect(block).toContain("--biliscript-reader-surface: var(--biliscript-primitive-color-dark-gray-950)");
      expect(block).toContain("--biliscript-reader-surface-2: var(--biliscript-primitive-color-dark-gray-900)");
      expect(block).toContain("--biliscript-reader-surface-3: var(--biliscript-primitive-color-dark-gray-800)");
      expect(block).toContain("--biliscript-reader-text: var(--biliscript-primitive-color-dark-gray-100)");
      expect(block).toContain("--biliscript-reader-muted: var(--biliscript-primitive-color-dark-gray-400)");
      expect(block).toContain("--biliscript-reader-faint: var(--biliscript-primitive-color-dark-gray-500)");
      expect(block).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-blue-400)");
      expect(block).toContain("--biliscript-reader-accent-ink: var(--biliscript-primitive-color-dark-gray-950)");
      expect(block).toContain("--biliscript-reader-pill-bg: var(--biliscript-primitive-color-dark-gray-800)");
      expect(block).toContain("--biliscript-reader-danger: var(--biliscript-primitive-color-red-400)");
    });

    it("Editorial Light 色彩语义全部正确引用 Primitive 调色板", () => {
      const block = EDITORIAL_LIGHT();
      expect(block).toContain("--biliscript-reader-surface: var(--biliscript-primitive-color-paper-50)");
      expect(block).toContain("--biliscript-reader-surface-2: var(--biliscript-primitive-color-paper-100)");
      expect(block).toContain("--biliscript-reader-surface-3: var(--biliscript-primitive-color-paper-200)");
      expect(block).toContain("--biliscript-reader-card: var(--biliscript-primitive-color-paper-100)");
      expect(block).toContain("--biliscript-reader-border: var(--biliscript-primitive-color-paper-300)");
      expect(block).toContain("--biliscript-reader-text: var(--biliscript-primitive-color-paper-950)");
      expect(block).toContain("--biliscript-reader-muted: var(--biliscript-primitive-color-paper-600)");
      expect(block).toContain("--biliscript-reader-faint: var(--biliscript-primitive-color-paper-500)");
      expect(block).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-terracotta-500)");
      expect(block).toContain("--biliscript-reader-accent-ink: var(--biliscript-primitive-color-white)");
      expect(block).toContain("--biliscript-reader-pill-bg: var(--biliscript-primitive-color-paper-200)");
      expect(block).toContain("--biliscript-reader-time-color: var(--biliscript-primitive-color-terracotta-600)");
      expect(block).toContain("--biliscript-reader-mist-line: var(--biliscript-primitive-color-paper-250)");
    });

    it("Editorial Dark 色彩语义全部正确引用 Primitive 调色板", () => {
      const block = EDITORIAL_DARK();
      expect(block).toContain("--biliscript-reader-surface: var(--biliscript-primitive-color-charcoal-950)");
      expect(block).toContain("--biliscript-reader-surface-2: var(--biliscript-primitive-color-charcoal-900)");
      expect(block).toContain("--biliscript-reader-surface-3: var(--biliscript-primitive-color-charcoal-800)");
      expect(block).toContain("--biliscript-reader-card: var(--biliscript-primitive-color-charcoal-900)");
      expect(block).toContain("--biliscript-reader-border: var(--biliscript-primitive-color-charcoal-700)");
      expect(block).toContain("--biliscript-reader-text: var(--biliscript-primitive-color-charcoal-100)");
      expect(block).toContain("--biliscript-reader-muted: var(--biliscript-primitive-color-charcoal-400)");
      expect(block).toContain("--biliscript-reader-faint: var(--biliscript-primitive-color-charcoal-500)");
      expect(block).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-terracotta-400)");
      expect(block).toContain("--biliscript-reader-accent-ink: var(--biliscript-primitive-color-charcoal-950)");
      expect(block).toContain("--biliscript-reader-pill-bg: var(--biliscript-primitive-color-charcoal-800)");
      expect(block).toContain("--biliscript-reader-mist-line: var(--biliscript-primitive-color-charcoal-750)");
    });
  });
});
