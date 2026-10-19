// tests/reader/bilingual-switch-style.test.ts
// 09 号票：双语字幕选轨弹层开关与设置开关视觉对齐样式契约。
// 将播放器控制条双语字幕选轨弹层内的开关控件（.biliscript-bilingual-switch）
// 在轨道与滑块的内嵌比例、关态轨道色值、滑块微阴影、开合过渡曲线以及焦点环上
// 向设置抽屉的 toggle-switch 规范对齐。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const BILINGUAL_CSS = "extension/entry/styles/bilingual-subtitles.css";
const TOGGLE_SWITCH_CSS = "extension/entry/styles/toggle-switch.css";

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

describe("09: 双语字幕选轨弹层开关与设置开关视觉对齐", () => {
  it("关态轨道底色改用 surface-3，开态保持 accent，不再直接拿 border 色充当轨道底色", () => {
    const css = readCss(BILINGUAL_CSS);
    const switchRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch");
    const onRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch\\[data-on=\"true\"\\]");

    // 关态底色为 surface-3，不为 border
    expect(switchRule).toMatch(/background:\s*var\(--biliscript-reader-surface-3\)/);
    expect(switchRule).not.toMatch(/background:\s*var\(--biliscript-reader-border\)/);

    // 开态底色为 accent
    expect(onRule).toMatch(/background:\s*var\(--biliscript-reader-accent\)/);
  });

  it("滑块采用纯白底色（#ffffff）及与设置开关一致的双层微阴影", () => {
    const css = readCss(BILINGUAL_CSS);
    const toggleCss = readCss(TOGGLE_SWITCH_CSS);
    const thumbRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch::after");

    // 滑块底色为纯白
    expect(thumbRule).toMatch(/background:\s*#(?:ffffff|fff)\b/);
    expect(thumbRule).not.toContain("var(--biliscript-reader-card)");

    // 双层微阴影与 toggle-switch 规格一致（0 0 3px ... + 0 0 1px ...）
    const expectedShadow = "0 0 3px rgba(23, 24, 26, 0.16), 0 0 1px rgba(23, 24, 26, 0.22)";
    expect(thumbRule).toContain(`box-shadow: ${expectedShadow}`);
    expect(toggleCss).toContain(`box-shadow: ${expectedShadow}`);
  });

  it("滑块与轨道几何维持内嵌胶囊比例，四周均有 2px 呼吸边距", () => {
    const css = readCss(BILINGUAL_CSS);
    const switchRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch");
    const thumbRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch::after");
    const onThumbRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch\\[data-on=\"true\"\\]::after");

    // 轨道尺寸 34×20
    expect(switchRule).toMatch(/width:\s*34px/);
    expect(switchRule).toMatch(/height:\s*20px/);

    // 滑块 16×16，静止左侧位距 2px、顶部 2px
    expect(thumbRule).toMatch(/width:\s*16px/);
    expect(thumbRule).toMatch(/height:\s*16px/);
    expect(thumbRule).toMatch(/top:\s*2px/);
    expect(thumbRule).toMatch(/left:\s*2px/);

    // 开启态 left 16px（34 - 16 - 16 = 2px 右侧呼吸边距）
    expect(onThumbRule).toMatch(/left:\s*16px/);
  });

  it("轨道变色与滑块位移过渡曲线对齐 --biliscript-reader-ease-spring", () => {
    const css = readCss(BILINGUAL_CSS);
    const switchRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch");
    const thumbRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch::after");

    // 轨道变色：background-color 0.2s var(--biliscript-reader-ease-spring, ease)
    expect(switchRule).toMatch(
      /transition:\s*background-color\s+0\.2s\s+var\(--biliscript-reader-ease-spring,\s*ease\)/
    );

    // 滑块位移：left 0.2s var(--biliscript-reader-ease-spring, ease)
    expect(thumbRule).toMatch(
      /transition:\s*left\s+0\.2s\s+var\(--biliscript-reader-ease-spring,\s*ease\)/
    );
  });

  it("减少动态（prefers-reduced-motion: reduce）下退化为无动画切换", () => {
    const css = stripComments(readCss(BILINGUAL_CSS));
    const mediaBlock = css.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([^}]*\{[^}]*\})*\s*\}/);
    expect(mediaBlock, "应存在 prefers-reduced-motion: reduce 媒体查询").not.toBeNull();

    const blockContent = mediaBlock![0];
    expect(blockContent).toContain(".biliscript-bilingual-switch");
    expect(blockContent).toContain(".biliscript-bilingual-switch::after");
    expect(blockContent).toMatch(/transition:\s*none/);
  });

  it("键盘焦点态（:focus-visible）补齐 accent-soft 2px 软光环", () => {
    const css = readCss(BILINGUAL_CSS);
    const focusRule = ruleBody(css, "#biliscript-reading-view \\.biliscript-bilingual-switch:focus-visible");

    expect(focusRule).toMatch(/outline:\s*none/);
    expect(focusRule).toMatch(/box-shadow:\s*0\s+0\s+0\s+2px\s+var\(--biliscript-reader-accent-soft\)/);
  });
});
