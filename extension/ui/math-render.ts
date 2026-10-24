// extension/ui/math-render.ts — LaTeX 数学公式渲染（ui/lazy-math 的动态 import 落点）
// 依赖 KaTeX 库，仅产出 Chromium 原生 MathML，零外部字体依赖、无 CSP 风险。

import katex from "katex";
import { MATH_BLOCK_ATTR, MATH_BLOCK_SELECTOR } from "./markdown.js";

export const MATH_CACHE_LIMIT = 200;

export function buildMathCacheKey(tex: string, isBlock: boolean): string {
  return `${isBlock ? "block" : "inline"}\u0000${tex}`;
}

export class MathRenderLruCache {
  private readonly capacity: number;
  private readonly cache = new Map<string, string>();

  constructor(capacity: number = MATH_CACHE_LIMIT) {
    this.capacity = capacity > 0 ? capacity : MATH_CACHE_LIMIT;
  }

  get(key: string): string | undefined {
    const value = this.cache.get(key);
    if (value === undefined) {
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: string, value: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, value);
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

const defaultMathCache = new MathRenderLruCache(MATH_CACHE_LIMIT);

export function clearMathCache(): void {
  defaultMathCache.clear();
}

export function getMathCacheSize(): number {
  return defaultMathCache.size;
}

export interface MathRenderModule {
  hydrateMathPlaceholders(root: ParentNode, cache?: MathRenderLruCache): void;
}

export function hydrateMathPlaceholders(root: ParentNode, cache: MathRenderLruCache = defaultMathCache): void {
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
      const cacheKey = buildMathCacheKey(tex, isBlock);
      let rendered = cache.get(cacheKey);
      if (rendered === undefined) {
        rendered = katex.renderToString(tex, {
          displayMode: isBlock,
          output: "mathml",
          throwOnError: false
        });
        cache.set(cacheKey, rendered);
      }
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

    // 精确收敛宽度以实现水平真正居中，避免 flex-wrap 将 RHS 撑满 100% 容器导致靠左
    if (typeof window !== "undefined" && typeof (window as any).requestAnimationFrame === "function") {
      (window as any).requestAnimationFrame(() => {
        const lhsW = (lhs as HTMLElement).offsetWidth ?? 0;
        let maxLineW = 0;
        const rhsChildren = Array.from(rhs.children) as HTMLElement[];
        for (const child of rhsChildren) {
          const lineW = lhsW + (child.offsetWidth ?? 0);
          if (lineW > maxLineW) {
            maxLineW = lineW;
          }
        }
        if (maxLineW > 0) {
          const targetW = Math.ceil(maxLineW) + 6;
          (mrow as HTMLElement).style.width = `${targetW}px`;
          (mrow as HTMLElement).style.maxWidth = "100%";
          (mrow as HTMLElement).style.margin = "0 auto";
        }
      });
    }
  }
}
