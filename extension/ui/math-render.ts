import katex from "katex";
import { resolveNodeDocument } from "../shared/cross-doc.js";
import { MATH_BLOCK_ATTR, MATH_BLOCK_SELECTOR } from "./markdown-block-constants.js";

const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

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
    if (el.getAttribute("data-biliscript-math-status") === "done" || el.hasAttribute("data-streaming-open")) {
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
      if (isBlock) {
        alignEquationAtEquals(el);
      }
    } catch {
      el.setAttribute("data-biliscript-math-status", "error");
    }
  }
}

const OPEN_DELIMITERS = new Set(["(", "[", "{", "⟨", "⌈", "⌊"]);
const CLOSE_DELIMITERS = new Set([")", "]", "}", "⟩", "⌉", "⌋"]);

function updateDelimiterDepth(node: Element, depth: number): number {
  const tag = node.tagName.toLowerCase();
  const delimiterEl =
    tag === "mo"
      ? node
      : tag === "msup" || tag === "msub" || tag === "msubsup"
        ? node.firstElementChild?.tagName.toLowerCase() === "mo"
          ? node.firstElementChild
          : null
        : null;
  if (!delimiterEl) {
    return depth;
  }
  const text = delimiterEl.textContent?.trim() ?? "";
  if (OPEN_DELIMITERS.has(text)) {
    return depth + 1;
  }
  if (CLOSE_DELIMITERS.has(text)) {
    return Math.max(0, depth - 1);
  }
  return depth;
}

function isTopLevelBinaryOp(node: Element): boolean {
  return node.tagName.toLowerCase() === "mo" && /^[+\-±∓−]$/.test(node.textContent?.trim() ?? "");
}

function createBlockMathFromNodes(
  doc: Document,
  nodes: Element[],
  annotation?: Element | null
): Element {
  const math = doc.createElementNS(MATHML_NS, "math");
  math.setAttribute("display", "block");
  math.setAttribute("aria-hidden", "true");
  const mstyle = doc.createElementNS(MATHML_NS, "mstyle");
  mstyle.setAttribute("displaystyle", "true");
  const mrow = doc.createElementNS(MATHML_NS, "mrow");
  for (const node of nodes) {
    mrow.appendChild(node);
  }
  mstyle.appendChild(mrow);
  if (annotation) {
    const semantics = doc.createElementNS(MATHML_NS, "semantics");
    semantics.appendChild(mstyle);
    semantics.appendChild(annotation);
    math.appendChild(semantics);
  } else {
    math.appendChild(mstyle);
  }
  return math;
}

function alignEquationAtEquals(container: Element): void {
  const mathEl = container.querySelector("math");
  if (!mathEl || !mathEl.parentElement) {
    return;
  }
  const mrow = mathEl.querySelector(":scope > semantics > mrow") || mathEl.querySelector(":scope > mrow");
  if (!mrow) {
    return;
  }

  const children = Array.from(mrow.children);
  let eqIndex = -1;
  let depth = 0;
  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (depth === 0 && child.tagName.toLowerCase() === "mo" && child.textContent?.trim() === "=") {
      eqIndex = i;
      break;
    }
    depth = updateDelimiterDepth(child, depth);
  }

  if (eqIndex < 0 || eqIndex >= children.length - 1) {
    return;
  }

  const annotation = mathEl.querySelector(":scope > semantics > annotation");
  const lhsNodes = children.slice(0, eqIndex + 1);

  const rhsTerms: Element[][] = [];
  let currentTerm: Element[] = [];
  depth = 0;
  for (let i = eqIndex + 1; i < children.length; i++) {
    const child = children[i];
    if (depth === 0 && currentTerm.length > 0 && isTopLevelBinaryOp(child)) {
      rhsTerms.push(currentTerm);
      currentTerm = [child];
    } else {
      currentTerm.push(child);
    }
    depth = updateDelimiterDepth(child, depth);
  }
  if (currentTerm.length > 0) {
    rhsTerms.push(currentTerm);
  }

  const doc = resolveNodeDocument(container);
  const aligned = doc.createElement("span");
  aligned.className = "biliscript-math-aligned";
  aligned.setAttribute("role", "math");
  const accessibleTex = (annotation?.textContent ?? container.getAttribute("data-tex") ?? "").trim();
  if (accessibleTex) {
    aligned.setAttribute("aria-label", accessibleTex);
  }

  const lhs = doc.createElement("span");
  lhs.className = "biliscript-math-lhs";
  lhs.appendChild(createBlockMathFromNodes(doc, lhsNodes, annotation));

  const rhs = doc.createElement("span");
  rhs.className = "biliscript-math-rhs";
  for (const termNodes of rhsTerms) {
    const term = doc.createElement("span");
    term.className = "biliscript-math-term";
    term.appendChild(createBlockMathFromNodes(doc, termNodes));
    rhs.appendChild(term);
  }

  aligned.appendChild(lhs);
  aligned.appendChild(rhs);
  mathEl.replaceWith(aligned);
}
