// tests/reader/scroll-fade-mask.test.ts
// 08 号票：字幕与概览滚动区顶底边缘渐隐遮罩样式契约。
// 为文摘面板的「字幕」列表滚动区（.biliscript-reading-subtitle）与「概览」内容滚动区
//（.biliscript-reading-overview）补齐与「AI 对话」消息区同款的顶底渐隐遮罩，消除滚动硬切边。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const READER_CSS = "extension/entry/styles/reader.css";

function readCss(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function ruleBody(css: string, selectorRegex: string): string {
  const text = stripComments(css);
  const rules = text.match(/[^{}]+\{[^}]*\}/g) || [];
  const re = new RegExp(`^${selectorRegex}$`);
  const bodies = rules
    .map((rule) => {
      const [head, body] = rule.split("{");
      return { head: head.trim(), body: body.replace(/\}$/, "").trim() };
    })
    .filter((rule) => rule.head.split(",").map((part) => part.trim()).some((part) => re.test(part)))
    .map((rule) => rule.body);
  expect(bodies.length, `应存在匹配 ${selectorRegex} 的 CSS 规则`).toBeGreaterThan(0);
  return bodies.join("\n");
}

function maskProperty(block: string, prop: "mask-image" | "-webkit-mask-image"): string {
  const match = block.match(new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+);`));
  expect(match, `容器应有 ${prop} 声明`).not.toBe(null);
  return match![1].trim();
}

interface MaskFadeParsed {
  direction: string;
  topLength: number;
  bottomLength: number;
}

// 解析双向渐隐遮罩：linear-gradient(to bottom, transparent 0, #000 <top>px, #000 calc(100% - <bottom>px), transparent 100%)
function parseBidirectionalMask(value: string): MaskFadeParsed {
  const normalized = value.replace(/\s+/g, " ");
  const match = normalized.match(
    /^linear-gradient\((to bottom),\s*transparent 0(?:px)?,\s*#000 (\d+(?:\.\d+)?)px,\s*#000 calc\(100% - (\d+(?:\.\d+)?)px\),\s*transparent 100%\)$/
  );
  expect(match, `渐隐遮罩应为顶底双向无色线性渐隐（transparent 0 → #000 Npx → #000 calc(100% - Npx) → transparent 100%），当前值：${value}`).not.toBe(null);
  return {
    direction: match![1],
    topLength: Number.parseFloat(match![2]),
    bottomLength: Number.parseFloat(match![3])
  };
}

const TARGET_CONTAINERS = [
  { name: "字幕列表", selector: "\\.biliscript-reading-subtitle" },
  { name: "概览内容", selector: "\\.biliscript-reading-overview" }
];

describe("08: 字幕与概览滚动区顶底边缘渐隐遮罩", () => {
  const css = readCss(READER_CSS);

  for (const { name, selector } of TARGET_CONTAINERS) {
    describe(`${name}（${selector}）`, () => {
      it("带有 -webkit-mask-image 与标准 mask-image 顶底渐隐声明，且两者数值一致", () => {
        const block = ruleBody(css, selector);
        const standard = maskProperty(block, "mask-image").replace(/\s+/g, " ");
        const prefixed = maskProperty(block, "-webkit-mask-image").replace(/\s+/g, " ");

        expect(prefixed).toBe(standard);
      });

      it("顶底渐隐长度在 8px–10px 范围，消除滚动硬切边", () => {
        const block = ruleBody(css, selector);
        const mask = maskProperty(block, "mask-image");
        const parsed = parseBidirectionalMask(mask);

        expect(parsed.direction).toBe("to bottom");
        expect(parsed.topLength).toBeGreaterThanOrEqual(8);
        expect(parsed.topLength).toBeLessThanOrEqual(10);
        expect(parsed.bottomLength).toBeGreaterThanOrEqual(8);
        expect(parsed.bottomLength).toBeLessThanOrEqual(10);
      });

      it("渐隐使用无色 stop（transparent / #000），不写死主题色，暗色不破相", () => {
        const block = ruleBody(css, selector);
        const standard = maskProperty(block, "mask-image");

        expect(standard).not.toMatch(/var\(/);
        expect(standard).not.toMatch(/rgba?\(/);
        // 只允许 #000（透明与黑的纯遮罩通道），不含其它十六进制主题色
        expect(standard.replace(/#000\b/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}/);
      });
    });
  }

  it("渐隐只挂在滚动容器上：外层宿主与面板壳不被遮罩", () => {
    const viewBlock = ruleBody(css, "#biliscript-reading-view");
    const panelBlock = ruleBody(css, "\\.biliscript-reading-script-panel");
    const tabBodyBlock = ruleBody(css, "\\.biliscript-reading-tab-body");

    expect(viewBlock).not.toMatch(/-?webkit-?mask|mask-image/);
    expect(panelBlock).not.toMatch(/-?webkit-?mask|mask-image/);
    expect(tabBodyBlock).not.toMatch(/-?webkit-?mask|mask-image/);
  });
});
