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
      alignEquationAtEquals(el);
    } catch {
      el.setAttribute("data-biliscript-math-status", "error");
    }
  }
}

/**
 * 参考论文与学术规范：若顶层公式包含等号，将等号左侧（LHS+等号）与右侧（RHS）结构化分组，
 * 右侧作为独立的 flex 换行容器，确保多行换行时每一行均精确对齐在等号右边。
 */
function alignEquationAtEquals(container: Element): void {
  const mrow = container.querySelector("math > semantics > mrow") || container.querySelector("math > mrow");
  if (!mrow) {
    return;
  }

  const children = Array.from(mrow.children);
  let eqIndex = -1;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.tagName.toLowerCase() === "mo" && child.textContent?.trim() === "=") {
      eqIndex = i;
      break;
    }
  }

  if (eqIndex >= 0 && eqIndex < children.length - 1) {
    const lhs = document.createElement("mrow");
    lhs.className = "biliscript-math-lhs";
    const rhs = document.createElement("mrow");
    rhs.className = "biliscript-math-rhs";

    for (let i = 0; i <= eqIndex; i++) {
      lhs.appendChild(children[i]);
    }

    let i = eqIndex + 1;
    while (i < children.length) {
      const child = children[i];
      const isBinaryOp =
        child.tagName.toLowerCase() === "mo" && /^[+\-±∓−]$/.test(child.textContent?.trim() ?? "");
      if (isBinaryOp && i + 1 < children.length) {
        const term = document.createElement("mrow");
        term.className = "biliscript-math-term";
        term.appendChild(child);
        i++;
        term.appendChild(children[i]);
        i++;
        rhs.appendChild(term);
      } else {
        rhs.appendChild(child);
        i++;
      }
    }

    mrow.innerHTML = "";
    mrow.classList.add("biliscript-math-aligned");
    mrow.appendChild(lhs);
    mrow.appendChild(rhs);
  }
}
