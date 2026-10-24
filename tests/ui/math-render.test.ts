import { beforeEach, describe, expect, it, vi } from "vitest";
import katex from "katex";
import { MATH_BLOCK_ATTR, MATH_BLOCK_SELECTOR } from "../../extension/ui/markdown.js";
import {
  MathRenderLruCache,
  buildMathCacheKey,
  clearMathCache,
  getMathCacheSize,
  hydrateMathPlaceholders,
  MATH_CACHE_LIMIT
} from "../../extension/ui/math-render.js";

describe("math-render LRU 缓存与水合测试", () => {
  beforeEach(() => {
    clearMathCache();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  describe("Requirement 1: 缓存键完整包含公式源码与展示模式", () => {
    it("行内和块级结果具有不同的缓存键，不会串用", () => {
      const tex = "E = mc^2";
      const blockKey = buildMathCacheKey(tex, true);
      const inlineKey = buildMathCacheKey(tex, false);

      expect(blockKey).not.toBe(inlineKey);
      expect(blockKey).toContain("block");
      expect(blockKey).toContain(tex);
      expect(inlineKey).toContain("inline");
      expect(inlineKey).toContain(tex);

      // 分别水合相同源码的块级与行内公式
      const container = document.createElement("div");
      container.innerHTML = `
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${tex}">$$${tex}$$</div>
        <span class="biliscript-md-math biliscript-md-math-inline" ${MATH_BLOCK_ATTR}="inline" data-tex="${tex}">$${tex}$</span>
      `;

      hydrateMathPlaceholders(container);

      const [blockEl, inlineEl] = container.querySelectorAll(MATH_BLOCK_SELECTOR);
      expect(blockEl.getAttribute("data-biliscript-math-status")).toBe("done");
      expect(inlineEl.getAttribute("data-biliscript-math-status")).toBe("done");

      // 块级公式 MathML 拥有 display="block"，行内公式没有
      const blockMath = blockEl.querySelector("math");
      const inlineMath = inlineEl.querySelector("math");
      expect(blockMath?.getAttribute("display")).toBe("block");
      expect(inlineMath?.getAttribute("display")).toBeNull();
    });
  });

  describe("Requirement 2: 有界 LRU 缓存命中、未命中、最近使用顺序更新与淘汰", () => {
    it("MathRenderLruCache 基础未命中与命中行为", () => {
      const cache = new MathRenderLruCache(3);
      expect(cache.size).toBe(0);

      // 未命中
      expect(cache.get("k1")).toBeUndefined();

      // 写入与命中
      cache.set("k1", "v1");
      expect(cache.size).toBe(1);
      expect(cache.get("k1")).toBe("v1");
    });

    it("MathRenderLruCache 访问时更新最近使用顺序（MRU），淘汰最久未使用（LRU）", () => {
      const cache = new MathRenderLruCache(3);
      cache.set("k1", "v1");
      cache.set("k2", "v2");
      cache.set("k3", "v3");
      expect(cache.size).toBe(3);

      // 访问 k1，使得 k1 成为最近使用的，顺序变为 k2 (最旧), k3, k1 (最新)
      expect(cache.get("k1")).toBe("v1");

      // 插入 k4，应该淘汰 k2
      cache.set("k4", "v4");
      expect(cache.size).toBe(3);
      expect(cache.get("k2")).toBeUndefined(); // 被淘汰
      expect(cache.get("k1")).toBe("v1");
      expect(cache.get("k3")).toBe("v3");
      expect(cache.get("k4")).toBe("v4");
    });

    it("更新已存在的键会更新值并提升为最新使用", () => {
      const cache = new MathRenderLruCache(2);
      cache.set("k1", "v1");
      cache.set("k2", "v2");

      // 更新 k1
      cache.set("k1", "v1-updated");

      // 插入 k3，应该淘汰 k2（因为 k1 刚被更新提升为最新）
      cache.set("k3", "v3");
      expect(cache.get("k2")).toBeUndefined();
      expect(cache.get("k1")).toBe("v1-updated");
      expect(cache.get("k3")).toBe("v3");
    });

    it("hydrateMathPlaceholders 在超出缓存上限时淘汰最久条目", () => {
      const smallCache = new MathRenderLruCache(2);
      const renderSpy = vi.spyOn(katex, "renderToString");

      const createEl = (tex: string) => {
        const div = document.createElement("div");
        div.innerHTML = `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${tex}">$$${tex}$$</div>`;
        return div;
      };

      // 渲染公式 1 和 2
      hydrateMathPlaceholders(createEl("f1"), smallCache);
      hydrateMathPlaceholders(createEl("f2"), smallCache);
      expect(renderSpy).toHaveBeenCalledTimes(2);
      expect(smallCache.size).toBe(2);

      // 渲染公式 3 -> f1 应该被淘汰
      hydrateMathPlaceholders(createEl("f3"), smallCache);
      expect(renderSpy).toHaveBeenCalledTimes(3);
      expect(smallCache.size).toBe(2);
      expect(smallCache.has(buildMathCacheKey("f1", true))).toBe(false);
      expect(smallCache.has(buildMathCacheKey("f2", true))).toBe(true);
      expect(smallCache.has(buildMathCacheKey("f3", true))).toBe(true);

      // 再次渲染 f2 -> 命中缓存，不增加调用次数
      hydrateMathPlaceholders(createEl("f2"), smallCache);
      expect(renderSpy).toHaveBeenCalledTimes(3);

      // 再次渲染已淘汰的 f1 -> 未命中，重新计算
      hydrateMathPlaceholders(createEl("f1"), smallCache);
      expect(renderSpy).toHaveBeenCalledTimes(4);
    });

    it("默认模块缓存导出容量限制为有界正数", () => {
      expect(MATH_CACHE_LIMIT).toBeGreaterThan(0);
      expect(typeof MATH_CACHE_LIMIT).toBe("number");
    });
  });

  describe("Requirement 3: 缓存命中与重新计算产生相同 HTML，失败处理保持现状", () => {
    it("缓存命中产生的 innerHTML 与首次计算完全一致", () => {
      const tex = "\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}";

      const container1 = document.createElement("div");
      container1.innerHTML = `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${tex}"></div>`;
      hydrateMathPlaceholders(container1);

      const container2 = document.createElement("div");
      container2.innerHTML = `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${tex}"></div>`;
      hydrateMathPlaceholders(container2);

      const html1 = container1.querySelector(MATH_BLOCK_SELECTOR)?.innerHTML;
      const html2 = container2.querySelector(MATH_BLOCK_SELECTOR)?.innerHTML;
      expect(html1).toBeTruthy();
      expect(html1).toBe(html2);
    });

    it("语法错误公式由 KaTeX 产出错误样式，缓存后表现一致", () => {
      const invalidTex = "\\invalid{\\macro";

      const container1 = document.createElement("div");
      container1.innerHTML = `<span class="biliscript-md-math biliscript-md-math-inline" ${MATH_BLOCK_ATTR}="inline" data-tex="${invalidTex}"></span>`;
      hydrateMathPlaceholders(container1);

      const el1 = container1.querySelector(MATH_BLOCK_SELECTOR);
      expect(el1?.getAttribute("data-biliscript-math-status")).toBe("done");
      expect(el1?.innerHTML).toContain("katex-error");

      // 第二次命中缓存
      const container2 = document.createElement("div");
      container2.innerHTML = `<span class="biliscript-md-math biliscript-md-math-inline" ${MATH_BLOCK_ATTR}="inline" data-tex="${invalidTex}"></span>`;
      hydrateMathPlaceholders(container2);

      const el2 = container2.querySelector(MATH_BLOCK_SELECTOR);
      expect(el2?.getAttribute("data-biliscript-math-status")).toBe("done");
      expect(el2?.innerHTML).toBe(el1?.innerHTML);
    });

    it("KaTeX 抛出硬异常时标记 error 且不污染缓存", () => {
      const tex = "boom";
      vi.spyOn(katex, "renderToString").mockImplementationOnce(() => {
        throw new Error("KaTeX internal failure");
      });

      const container = document.createElement("div");
      container.innerHTML = `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${tex}"></div>`;

      hydrateMathPlaceholders(container);

      const el = container.querySelector(MATH_BLOCK_SELECTOR);
      expect(el?.getAttribute("data-biliscript-math-status")).toBe("error");
      expect(getMathCacheSize()).toBe(0);
    });
  });

  describe("Requirement 4: 等号对齐在当前 DOM 下执行，不缓存过期几何", () => {
    it("缓存命中后，新的 DOM 节点仍独立完成等号对齐结构拆解与几何布局", () => {
      const eqTex = "f(x) = x^2 + 2x + 1";

      const c1 = document.createElement("div");
      c1.innerHTML = `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${eqTex}"></div>`;
      hydrateMathPlaceholders(c1);

      const el1 = c1.querySelector(MATH_BLOCK_SELECTOR)!;
      const aligned1 = el1.querySelector(".biliscript-math-aligned");
      const lhs1 = el1.querySelector(".biliscript-math-lhs");
      const rhs1 = el1.querySelector(".biliscript-math-rhs");
      expect(aligned1).not.toBeNull();
      expect(lhs1).not.toBeNull();
      expect(rhs1).not.toBeNull();

      // 第二次从缓存水合新的容器
      const c2 = document.createElement("div");
      c2.innerHTML = `<div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${eqTex}"></div>`;
      hydrateMathPlaceholders(c2);

      const el2 = c2.querySelector(MATH_BLOCK_SELECTOR)!;
      const aligned2 = el2.querySelector(".biliscript-math-aligned");
      const lhs2 = el2.querySelector(".biliscript-math-lhs");
      const rhs2 = el2.querySelector(".biliscript-math-rhs");
      expect(aligned2).not.toBeNull();
      expect(lhs2).not.toBeNull();
      expect(rhs2).not.toBeNull();

      // 验证是新 DOM 树上的独立节点，非同一实例浅拷贝
      expect(aligned1).not.toBe(aligned2);
      expect(lhs1).not.toBe(lhs2);
      expect(rhs1).not.toBe(rhs2);
    });
  });

  describe("Requirement 5: 稳定区重复渲染场景下，KaTeX 计算次数不再随块边界数量增长", () => {
    it("模拟流式追加块重建 stableEl，唯一公式 KaTeX 计算次数为常数 1", () => {
      const renderSpy = vi.spyOn(katex, "renderToString");

      const formulaA = "A = \\alpha + 1";
      const formulaB = "B = \\beta + 2";
      const formulaC = "C = \\gamma + 3";

      const stableEl = document.createElement("div");

      // 阶段 1：稳定区包含公式 A
      stableEl.innerHTML = `
        <p>段落 1</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaA}"></div>
      `;
      hydrateMathPlaceholders(stableEl);
      expect(renderSpy).toHaveBeenCalledTimes(1);

      // 阶段 2：新块到达，stableEl 整体被重新赋值 innerHTML（模拟 renderMarkdownStripped），包含公式 A 与 B
      stableEl.innerHTML = `
        <p>段落 1</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaA}"></div>
        <p>段落 2</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaB}"></div>
      `;
      hydrateMathPlaceholders(stableEl);
      // 公式 A 命中缓存不重复执行，只计算公式 B -> 累计调用 2 次
      expect(renderSpy).toHaveBeenCalledTimes(2);

      // 阶段 3：再次增加块，包含 A, B, C
      stableEl.innerHTML = `
        <p>段落 1</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaA}"></div>
        <p>段落 2</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaB}"></div>
        <p>段落 3</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaC}"></div>
      `;
      hydrateMathPlaceholders(stableEl);
      // 公式 A, B 均命中缓存，只计算新公式 C -> 累计调用 3 次
      expect(renderSpy).toHaveBeenCalledTimes(3);

      // 阶段 4：尾部再次重入（无新公式），调用次数不变
      stableEl.innerHTML = `
        <p>段落 1</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaA}"></div>
        <p>段落 2</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaB}"></div>
        <p>段落 3</p>
        <div class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block" data-tex="${formulaC}"></div>
        <p>段落 4（纯文本）</p>
      `;
      hydrateMathPlaceholders(stableEl);
      expect(renderSpy).toHaveBeenCalledTimes(3);
    });
  });
});
