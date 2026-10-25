// tests/reader/explain-placeholder-fine-border.test.ts
// 选区解释卡与占位卡微描边与 20px 圆角规范契约

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const GATE_CSS = "extension/entry/styles/reader-gate.css";
const READER_CSS = "extension/entry/styles/reader.css";

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

describe("选区解释卡与概览空态卡微描边与圆角规范", () => {
  it("浅色与深色主题定义 0.5px 精细描边 token（浅色淡黑 12%，深色柔白 12%）", () => {
    const gate = readCss(GATE_CSS);
    expect(gate).toMatch(/--biliscript-reader-fine-border:\s*inset 0 0 0 0\.5px rgba\(\s*var\(--biliscript-primitive-color-black-rgb\),\s*0\.12\)/);
    expect(gate).toMatch(/--biliscript-reader-fine-border:\s*inset 0 0 0 0\.5px rgba\(\s*var\(--biliscript-primitive-color-white-rgb\),\s*0\.12\)/);
  });

  it("选区解释卡具有 20px 圆角与内侧 0.5px 精细描边微层叠", () => {
    const reader = readCss(READER_CSS);
    const explainBase = ruleBody(reader, ".biliscript-reading-explain-card-dialog");
    expect(explainBase).toMatch(/border-radius:\s*(?:20px|var\(--biliscript-radius-xl\))/);
    expect(explainBase).toContain("border: none");

    const gate = readCss(GATE_CSS);
    const explainGate = ruleBody(
      gate,
      '#biliscript-reading-view:not([data-palette="editorial"]) .biliscript-reading-explain-card-dialog'
    );
    expect(explainGate).toMatch(/border-radius:\s*(?:20px|var\(--biliscript-radius-xl\))/);
    expect(explainGate).toContain("var(--biliscript-reader-fine-border)");
    expect(explainGate).toContain("box-shadow: var(--biliscript-reader-shadow)");
  });

  it("概览 Tab 占位卡与空态卡具有 20px 圆角与 0.5px 精细描边并与 card-highlight 兼容", () => {
    const reader = readCss(READER_CSS);
    const placeholderBase = ruleBody(reader, ".biliscript-reading-placeholder");
    expect(placeholderBase).toMatch(/border-radius:\s*(?:20px|var\(--biliscript-radius-xl\))/);
    expect(placeholderBase).toContain("border: none");
    expect(placeholderBase).toContain("var(--biliscript-reader-card-highlight)");

    const gate = readCss(GATE_CSS);
    const placeholderGate = ruleBody(gate, "#biliscript-reading-view .biliscript-reading-placeholder");
    expect(placeholderGate).toMatch(/border-radius:\s*(?:20px|var\(--biliscript-radius-xl\))/);
    expect(placeholderGate).toContain("border: none");
    expect(placeholderGate).toContain("var(--biliscript-reader-card-highlight)");
    expect(placeholderGate).toContain("var(--biliscript-reader-fine-border)");

    const emptyCardGate = ruleBody(gate, "#biliscript-reading-view .biliscript-reading-ov-empty-card");
    expect(emptyCardGate).toMatch(/border-radius:\s*(?:20px|var\(--biliscript-radius-xl\))/);
    expect(emptyCardGate).toContain("var(--biliscript-reader-card-highlight)");
    expect(emptyCardGate).toContain("var(--biliscript-reader-fine-border)");
  });

  it("editorial 模式下空态卡与解释卡重置为纸面细实线与零阴影", () => {
    const gate = readCss(GATE_CSS);
    const editorialPlaceholder = ruleBody(
      gate,
      '#biliscript-reading-view[data-palette="editorial"] .biliscript-reading-placeholder'
    );
    expect(editorialPlaceholder).toContain("border: 1px solid var(--biliscript-reader-border)");
    expect(editorialPlaceholder).toContain("box-shadow: none");

    const editorialExplain = ruleBody(
      gate,
      '#biliscript-reading-view[data-palette="editorial"] .biliscript-reading-explain-card-dialog'
    );
    expect(editorialExplain).toContain("border: 1px solid var(--biliscript-reader-border)");
    expect(editorialExplain).toContain("box-shadow: none");
  });

  it("减弱透明度模式下空态卡与解释卡回退为不透明底色", () => {
    const gate = readCss(GATE_CSS);
    const reduced = gate.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{([\s\S]*?)\n\}/);
    expect(reduced).not.toBeNull();
    const reducedBlock = reduced![1];
    expect(reducedBlock).toContain(".biliscript-reading-explain-card-dialog");
    expect(reducedBlock).toContain(".biliscript-reading-placeholder");
    expect(reducedBlock).toContain(".biliscript-reading-ov-empty-card");
    expect(reducedBlock).toContain("background: var(--biliscript-reader-surface)");
  });
});
