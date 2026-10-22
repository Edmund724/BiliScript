// extension/ui/math-render.ts — LaTeX 数学公式渲染（ui/lazy-math 的动态 import 落点）
// 依赖 KaTeX 库，仅产出 Chromium 原生 MathML，零外部字体依赖、无 CSP 风险。

import katex from "katex";
import { MATH_BLOCK_ATTR, MATH_BLOCK_SELECTOR } from "./markdown.js";

export interface MathRenderModule {
  hydrateMathPlaceholders(root: ParentNode): void;
}

export function hydrateMathPlaceholders(root: ParentNode): void {
  const elements = root.querySelectorAll(MATH_BLOCK_SELECTOR);
  for (const el of elements) {
    if (el.getAttribute("data-biliscript-math-status") === "done") {
      continue;
    }
    const mode = el.getAttribute(MATH_BLOCK_ATTR);
    const isBlock = mode === "block";
    const tex = el.getAttribute("data-tex") ?? el.textContent ?? "";
    if (!tex.trim()) {
      continue;
    }
    try {
      const rendered = katex.renderToString(tex, {
        displayMode: isBlock,
        output: "mathml",
        throwOnError: false
      });
      el.innerHTML = rendered;
      el.setAttribute("data-biliscript-math-status", "done");
    } catch {
      el.setAttribute("data-biliscript-math-status", "error");
    }
  }
}
