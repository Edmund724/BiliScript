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

      expect(baseBlock).toContain("--biliscript-radius-panel: var(--biliscript-primitive-radius-28)");
      expect(baseBlock).toMatch(/--biliscript-radius-panel-inner:\s*(?:calc|max)\([^;]*var\(--biliscript-radius-panel\)[^;]*\)/);

      expect(baseBlock).toMatch(/--biliscript-radius-pill:\s*var\(--biliscript-primitive-radius-(?:pill|full)\)/);
      expect(baseBlock).toContain("--biliscript-radius-circle: var(--biliscript-primitive-radius-circle)");

      expect(baseBlock).toContain("--biliscript-radius-xs: var(--biliscript-primitive-radius-4)");
      expect(baseBlock).toContain("--biliscript-radius-sm: var(--biliscript-primitive-radius-8)");
      expect(baseBlock).toContain("--biliscript-radius-md: var(--biliscript-primitive-radius-12)");
      expect(baseBlock).toContain("--biliscript-radius-lg: var(--biliscript-primitive-radius-16)");
      expect(baseBlock).toContain("--biliscript-radius-xl: var(--biliscript-primitive-radius-20)");
    });

    it("规范联动 --biliscript-reader-font-scale 的完整 5 档字阶语义变量", () => {
      const baseBlock = FLYME_LIGHT();

      expect(baseBlock).toMatch(/--biliscript-font-size-sm:\s*calc\(var\(--biliscript-primitive-font-size-(?:12|sm)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-base:\s*calc\(var\(--biliscript-primitive-font-size-(?:14|base)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-md:\s*calc\(var\(--biliscript-primitive-font-size-(?:16|md)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-lg:\s*calc\(var\(--biliscript-primitive-font-size-(?:18|lg)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);
      expect(baseBlock).toMatch(/--biliscript-font-size-xl:\s*calc\(var\(--biliscript-primitive-font-size-(?:20|xl)\)\s*\*\s*var\(--biliscript-reader-font-scale,\s*1\)\)/);

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
        const hexMatches = block.match(/--(?:biliscript-reader|biliscript-gemini)-[a-z0-9-]+:\s*[^;]*#[0-9a-fA-F]+/g) || [];
        expect(hexMatches, `${name} 不应在变量右侧裸写 HEX 颜色`).toEqual([]);
      });

      it(`${name} 的色彩与材质语义变量中禁止裸写数值型 rgba(r, g, b, a)`, () => {
        const block = getBlock();
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
      expect(block).toContain("--biliscript-reader-card-highlight: none");
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
      expect(block).toContain("--biliscript-reader-card-highlight: none");
      expect(block).toContain("--biliscript-reader-border: var(--biliscript-primitive-color-charcoal-700)");
      expect(block).toContain("--biliscript-reader-text: var(--biliscript-primitive-color-charcoal-100)");
      expect(block).toContain("--biliscript-reader-muted: var(--biliscript-primitive-color-charcoal-400)");
      expect(block).toContain("--biliscript-reader-faint: var(--biliscript-primitive-color-charcoal-500)");
      expect(block).toContain("--biliscript-reader-accent: var(--biliscript-primitive-color-terracotta-400)");
      expect(block).toContain("--biliscript-reader-accent-ink: var(--biliscript-primitive-color-charcoal-950)");
      expect(block).toContain("--biliscript-reader-pill-bg: var(--biliscript-primitive-color-charcoal-800)");
      expect(block).toContain("--biliscript-reader-mist-line: var(--biliscript-primitive-color-charcoal-750)");
      expect(block).toContain("--biliscript-reader-on-fill: var(--biliscript-primitive-color-charcoal-950)");
    });
  });

  describe("3. OKLCH 4 层表面原语、color-scheme 与 WCAG AA 对比度数学校验", () => {
    const PRIMITIVE_CSS = "extension/entry/styles/tokens-primitive.css";

    function parsePrimitiveMap(): Map<string, string> {
      const css = readStyleFile(PRIMITIVE_CSS);
      const map = new Map<string, string>();
      for (const m of css.matchAll(/(--biliscript-primitive-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
        map.set(m[1], m[2].trim());
      }
      return map;
    }

    function resolveOklch(map: Map<string, string>, tokenName: string): { L: number; C: number; H: number } {
      let val = map.get(tokenName) ?? "";
      let guard = 0;
      while (val.startsWith("var(") && guard < 5) {
        const ref = val.match(/^var\((--biliscript-primitive-[a-z0-9-]+)\)$/)?.[1];
        if (!ref) break;
        val = map.get(ref) ?? "";
        guard += 1;
      }
      const m = val.match(/^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
      expect(m, `${tokenName} 必须为 OKLCH 表达式，实际: ${val}`).not.toBeNull();
      return { L: parseFloat(m![1]), C: parseFloat(m![2]), H: parseFloat(m![3]) };
    }

    function oklchLuminance(L: number, C: number, H: number): { relL: number; inGamut: boolean } {
      const h = (H * Math.PI) / 180;
      const a = C * Math.cos(h);
      const b = C * Math.sin(h);
      const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
      const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
      const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
      const l = l_ * l_ * l_;
      const m = m_ * m_ * m_;
      const s = s_ * s_ * s_;
      const r = +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
      const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
      const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
      const inGamut = r >= -0.001 && r <= 1.001 && g >= -0.001 && g <= 1.001 && bl >= -0.001 && bl <= 1.001;
      const cr = Math.min(1, Math.max(0, r));
      const cg = Math.min(1, Math.max(0, g));
      const cb = Math.min(1, Math.max(0, bl));
      return { relL: 0.2126 * cr + 0.7152 * cg + 0.0722 * cb, inGamut };
    }

    function contrastRatio(a: number, b: number): number {
      const [hi, lo] = a > b ? [a, b] : [b, a];
      return (hi + 0.05) / (lo + 0.05);
    }

    it("tokens-primitive.css 声明 4 层 OKLCH 表面原语且无裸 HEX 颜色", () => {
      const css = readStyleFile(PRIMITIVE_CSS);
      expect(css.match(/#[0-9a-fA-F]{3,8}\b/g) || []).toEqual([]);
      for (const layer of [
        "--biliscript-primitive-surface-bg-light",
        "--biliscript-primitive-surface-panel-light",
        "--biliscript-primitive-surface-elevated-light",
        "--biliscript-primitive-surface-border-light",
        "--biliscript-primitive-surface-bg-dark",
        "--biliscript-primitive-surface-panel-dark",
        "--biliscript-primitive-surface-elevated-dark",
        "--biliscript-primitive-surface-border-dark",
        "--biliscript-primitive-surface-paper-bg",
        "--biliscript-primitive-surface-paper-panel",
        "--biliscript-primitive-surface-paper-elevated",
        "--biliscript-primitive-surface-paper-border",
        "--biliscript-primitive-surface-charcoal-bg",
        "--biliscript-primitive-surface-charcoal-panel",
        "--biliscript-primitive-surface-charcoal-elevated",
        "--biliscript-primitive-surface-charcoal-border"
      ]) {
        expect(css, `缺少 4 层原语 ${layer}`).toContain(`${layer}:`);
      }
    });

    it("reader-gate.css 暴露 4 层表面语义别名并显式声明 light/dark color-scheme", () => {
      const light = FLYME_LIGHT();
      const dark = FLYME_DARK();
      expect(light).toContain("color-scheme: light;");
      expect(dark).toContain("color-scheme: dark;");
      expect(dark).toContain("--biliscript-reader-on-fill: var(--biliscript-primitive-color-dark-gray-950);");
      for (const alias of [
        "--biliscript-surface-bg:",
        "--biliscript-surface-panel:",
        "--biliscript-surface-elevated:",
        "--biliscript-surface-border:"
      ]) {
        expect(light).toContain(alias);
      }
    });

    it("四象限所有正文、次级与辅助标签及主强调按钮均落在 sRGB 色域内且满足对比度要求", () => {
      const map = parsePrimitiveMap();
      const lum = (token: string) => {
        const { L, C, H } = resolveOklch(map, token);
        const res = oklchLuminance(L, C, H);
        expect(res.inGamut, `${token} 应落在 sRGB 色域内`).toBe(true);
        return res.relL;
      };

      const suites = [
        {
          name: "Neutral Light",
          surfaces: ["--biliscript-primitive-color-gray-50", "--biliscript-primitive-color-gray-100", "--biliscript-primitive-color-gray-200"],
          texts: ["--biliscript-primitive-color-gray-950", "--biliscript-primitive-color-gray-600", "--biliscript-primitive-color-gray-500"],
          accent: "--biliscript-primitive-color-blue-500",
          onFill: "--biliscript-primitive-color-white",
          minAccentContrast: 3.0
        },
        {
          name: "Neutral Dark",
          surfaces: ["--biliscript-primitive-color-dark-gray-950", "--biliscript-primitive-color-dark-gray-900", "--biliscript-primitive-color-dark-gray-800"],
          texts: ["--biliscript-primitive-color-dark-gray-100", "--biliscript-primitive-color-dark-gray-400", "--biliscript-primitive-color-dark-gray-500"],
          accent: "--biliscript-primitive-color-blue-400",
          onFill: "--biliscript-primitive-color-dark-gray-950",
          minAccentContrast: 4.5
        },
        {
          name: "Editorial Light",
          surfaces: ["--biliscript-primitive-color-paper-50", "--biliscript-primitive-color-paper-100", "--biliscript-primitive-color-paper-200"],
          texts: ["--biliscript-primitive-color-paper-950", "--biliscript-primitive-color-paper-600", "--biliscript-primitive-color-paper-500"],
          accent: "--biliscript-primitive-color-terracotta-500",
          onFill: "--biliscript-primitive-color-white",
          minAccentContrast: 4.5
        },
        {
          name: "Editorial Dark",
          surfaces: ["--biliscript-primitive-color-charcoal-950", "--biliscript-primitive-color-charcoal-900", "--biliscript-primitive-color-charcoal-800"],
          texts: ["--biliscript-primitive-color-charcoal-100", "--biliscript-primitive-color-charcoal-400", "--biliscript-primitive-color-charcoal-500"],
          accent: "--biliscript-primitive-color-terracotta-400",
          onFill: "--biliscript-primitive-color-charcoal-950",
          minAccentContrast: 4.5
        }
      ];

      for (const s of suites) {
        for (const text of s.texts) {
          for (const bg of s.surfaces) {
            expect(
              contrastRatio(lum(text), lum(bg)),
              `${s.name}: ${text} on ${bg} 必须 ≥ 4.5:1`
            ).toBeGreaterThanOrEqual(4.5);
          }
        }
        expect(
          contrastRatio(lum(s.accent), lum(s.surfaces[0])),
          `${s.name}: accent on primary bg 必须 ≥ ${s.minAccentContrast}:1`
        ).toBeGreaterThanOrEqual(s.minAccentContrast);
        expect(
          contrastRatio(lum(s.onFill), lum(s.accent)),
          `${s.name}: onFill on accent 必须 ≥ ${s.minAccentContrast}:1`
        ).toBeGreaterThanOrEqual(s.minAccentContrast);
      }
    });
  });
});
