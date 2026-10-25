import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const STYLES_DIR = "extension/entry/styles";

function readSource(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function expectHarmonyOSFallback(stack: string): void {
  const regular = stack.indexOf('"HarmonyOS_Regular"');
  for (const font of ['"PingFang SC"', '"Hiragino Sans GB"', '"Microsoft YaHei UI"', '"Microsoft YaHei"']) {
    expect(stack.indexOf(font), stack).toBeGreaterThanOrEqual(0);
  }
  expect(regular, stack).toBeGreaterThan(stack.indexOf('"PingFang SC"'));
  expect(regular, stack).toBeGreaterThan(stack.indexOf('"Hiragino Sans GB"'));
  expect(regular, stack).toBeLessThan(stack.indexOf('"Microsoft YaHei UI"'));
  expect(regular, stack).toBeLessThan(stack.indexOf('"Microsoft YaHei"'));
}

describe("文摘面板鸿蒙无衬线字体栈", () => {
  it("常规正文、公式、Mermaid 与 Canvas 来源均复用视频页字体且保持系统回退顺序", () => {
    const gate = readSource(`${STYLES_DIR}/reader-gate.css`);
    const reader = readSource(`${STYLES_DIR}/reader.css`);
    const chat = readSource(`${STYLES_DIR}/reader-chat.css`);
    const mermaid = readSource("extension/ui/mermaid-render.ts");
    const quoteExport = readSource("extension/reader/quote-share-export.ts");

    const panelStack = gate.match(/--biliscript-reader-font-sans:\s*([^;]+);/)?.[1];
    expect(panelStack).toBeDefined();
    expectHarmonyOSFallback(panelStack!);

    for (const source of [reader, chat]) {
      const mathStack = source.match(/math mtext\s*\{[^}]*var\(--biliscript-reader-font-sans,\s*([^)]+)\)/s)?.[1];
      expect(mathStack).toBeDefined();
      expectHarmonyOSFallback(mathStack!);
    }

    const mermaidStack = mermaid.match(/const PANEL_FONT_FAMILY =\s*\n?\s*'([^']+)'/)?.[1];
    expect(mermaidStack).toBeDefined();
    expectHarmonyOSFallback(mermaidStack!);

    const canvasStack = quoteExport.match(/ctx\.font = '11px ([^']+)'/)?.[1];
    expect(canvasStack).toBeDefined();
    expectHarmonyOSFallback(canvasStack!);
  });

  it("中等字重栈由全部中粗控件、Markdown 加粗和标题消费", () => {
    const gate = readSource(`${STYLES_DIR}/reader-gate.css`);
    const reader = readSource(`${STYLES_DIR}/reader.css`);
    const mediumStack = gate.match(/--biliscript-reader-font-sans-medium:\s*([^;]+);/)?.[1];
    expect(mediumStack).toBeDefined();
    expectHarmonyOSFallback(mediumStack!);
    expect(mediumStack!.indexOf('"HarmonyOS_Medium"')).toBeGreaterThan(mediumStack!.indexOf('"PingFang SC"'));
    expect(mediumStack!.indexOf('"HarmonyOS_Medium"')).toBeLessThan(mediumStack!.indexOf('"HarmonyOS_Regular"'));

    expect(reader).toMatch(/#biliscript-reading-view :where\(strong, b, h1, h2, h3, h4, h5, h6\)\s*\{\s*font-family: var\(--biliscript-reader-font-sans-medium\);/);

    const buttonControls = [
      ".biliscript-reading-tab",
      ".biliscript-reading-follow-btn",
      ".biliscript-reading-explain-btn",
      ".biliscript-quote-preset-btn.is-active",
      ".biliscript-quote-pattern-btn.is-active",
      ".biliscript-quote-action-btn.is-primary"
    ];
    for (const selector of buttonControls) {
      expect(reader, `${selector} 应压过面板按钮的 ID 级字体继承`).toContain(`#biliscript-reading-view ${selector} {`);
    }
    const chat = readSource(`${STYLES_DIR}/reader-chat.css`);
    for (const selector of [".chat-thinking-single-pill", ".chat-timestamp-link", ".chat-search-card-head"]) {
      expect(chat, `${selector} 应压过面板按钮的 ID 级字体继承`).toContain(`#biliscript-reading-view .biliscript-reading-chat ${selector} {`);
    }

    for (const name of readdirSync(join(ROOT, STYLES_DIR)).filter((file) => /^reader.*\.css$/.test(file))) {
      const css = readSource(`${STYLES_DIR}/${name}`).replace(/\/\*[\s\S]*?\*\//g, "");
      for (const rule of css.matchAll(/([^{}]+)\{([^{}]*font-weight:\s*(?:500|600|700|bold)\s*[;}][^{}]*)\}/g)) {
        if (rule[1].includes(".biliscript-reading-time")) continue;
        const declarations = [...rule[2].matchAll(/font-family:\s*([^;]+);/g)];
        expect(declarations.at(-1)?.[1], `${name} 的 ${rule[1].trim()} 应消费中字重栈`).toBe("var(--biliscript-reader-font-sans-medium)");
      }
    }
  });

  it("AI 对话回复、解释卡引文与回答、章节概括使用无衬线栈，思源宋体仅保留给金句与 editorial 标题", () => {
    const reader = readSource(`${STYLES_DIR}/reader.css`).replace(/\/\*[\s\S]*?\*\//g, "");
    const chat = readSource(`${STYLES_DIR}/reader-chat.css`).replace(/\/\*[\s\S]*?\*\//g, "");
    const quoteExport = readSource("extension/reader/quote-share-export.ts");

    expect(chat).toMatch(
      /\.biliscript-reading-chat \.chat-msg-assistant-body\s*\{[^}]*font-family:\s*var\(--biliscript-reader-font-sans\);/
    );
    expect(chat).not.toContain("--biliscript-reader-font-serif");
    expect(chat).not.toContain("BiliScript Noto Serif SC");

    for (const selector of [
      "\\.biliscript-reading-explain-card-quote",
      "\\.biliscript-reading-explain-card-answer\\.markdown-body",
      "\\.biliscript-reading-ov-chapter-desc"
    ]) {
      expect(reader).toMatch(
        new RegExp(`${selector}\\s*\\{[^}]*font-family:\\s*var\\(--biliscript-reader-font-sans\\);`)
      );
    }

    const serifVarSelectors = [...reader.matchAll(/([^{}]+)\{[^{}]*var\(--biliscript-reader-font-serif\)[^{}]*\}/g)].map(
      (match) => match[1].trim()
    );
    expect(serifVarSelectors).toEqual(['#biliscript-reading-view[data-palette="editorial"] .biliscript-reading-ov-h']);

    const notoSerifRules = [...reader.matchAll(/([^{}]+)\{[^{}]*"BiliScript Noto Serif SC"[^{}]*\}/g)].map((match) =>
      match[1].trim()
    );
    expect(notoSerifRules).toEqual([
      "@font-face",
      ".biliscript-reading-ov-quote-text",
      ".biliscript-quote-card-text"
    ]);

    expect(quoteExport).toContain('document.fonts.load(\'400 16px "BiliScript Noto Serif SC"\'');
    expect(quoteExport).toContain(
      'ctx.font = `400 ${fontSize}px "BiliScript Noto Serif SC", Georgia, "Times New Roman", "Songti SC", "SimSun", serif`'
    );
  });
});
