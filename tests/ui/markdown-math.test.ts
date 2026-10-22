import { describe, expect, it } from "vitest";
import { renderMarkdown, renderMarkdownStripped, MATH_BLOCK_ATTR, MATH_BLOCK_SELECTOR } from "../../extension/ui/markdown.js";
import { hydrateMathPlaceholders } from "../../extension/ui/math-render.js";

describe("Markdown LaTeX 公式渲染与占位", () => {
  it("代码围栏 ```math / ```latex / ```katex → 块级数学公式占位", () => {
    const mathFence = renderMarkdown("```math\nE = mc^2\n```");
    expect(mathFence).toContain(`class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block"`);
    expect(mathFence).toContain('data-tex="E = mc^2"');
    expect(mathFence).toContain("$$E = mc^2$$");

    const latexFence = renderMarkdown("```latex\n\\frac{1}{2}\n```");
    expect(latexFence).toContain(`class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block"`);
    expect(latexFence).toContain('data-tex="\\frac{1}{2}"');
  });

  it("独立单行与多行 $$...$$ → 块级数学公式占位", () => {
    const singleLine = renderMarkdown("$$\\text{Agent} = \\text{Model} + \\text{Harness}$$");
    expect(singleLine).toContain(`class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block"`);
    expect(singleLine).toContain('data-tex="\\text{Agent} = \\text{Model} + \\text{Harness}"');

    const multiLine = renderMarkdown("$$\nx = 1\ny = 2\n$$");
    expect(multiLine).toContain(`class="biliscript-md-math biliscript-md-math-block" ${MATH_BLOCK_ATTR}="block"`);
    expect(multiLine).toContain("x = 1\ny = 2");
  });

  it("列表项内的 $$...$$（对齐用户场景）", () => {
    const listMath = renderMarkdown(
      "2. 主题与核心观点\n- 核心公式: $$\\text{Agent} = \\text{模型} + \\text{脚手架}$$"
    );
    expect(listMath).toContain('<ol start="2"><li>主题与核心观点</li></ol>');
    expect(listMath).toContain("<ul><li>核心公式: <span class=\"biliscript-md-math biliscript-md-math-block\"");
    expect(listMath).toContain(`${MATH_BLOCK_ATTR}="block"`);
    expect(listMath).toContain('data-tex="\\text{Agent} = \\text{模型} + \\text{脚手架}"');
  });

  it("段落内行内公式 $...$", () => {
    const inlineMath = renderMarkdown("根据质能方程 $E = mc^2$ 可知能量与质量守恒。");
    expect(inlineMath).toContain("<span class=\"biliscript-md-math biliscript-md-math-inline\"");
    expect(inlineMath).toContain(`${MATH_BLOCK_ATTR}="inline"`);
    expect(inlineMath).toContain('data-tex="E = mc^2"');
  });

  it("货币与普通美元符号防误伤", () => {
    const money = renderMarkdown("商品售价 $100，特价 $50.50，区间 $10 - $20。");
    expect(money).not.toContain(MATH_BLOCK_ATTR);
    expect(money).toContain("商品售价 $100，特价 $50.50，区间 $10 - $20。");

    const escaped = renderMarkdown("转义符号 \\$100 保持原样。");
    expect(escaped).not.toContain(MATH_BLOCK_ATTR);
    expect(escaped).toContain("转义符号 $100 保持原样。");
  });

  it("行内代码中的 $ 保持代码属性，不被当成公式", () => {
    const code = renderMarkdown("使用 `$x$` 变量。");
    expect(code).not.toContain(MATH_BLOCK_ATTR);
    expect(code).toContain("<code>$x$</code>");
  });
});

describe("math-render MathML 水合", () => {
  it("hydrateMathPlaceholders 将占位替换为真实 MathML 节点", () => {
    const container = document.createElement("div");
    container.innerHTML = renderMarkdown(
      "- 核心公式: $$\\text{Agent} = \\text{Model} + \\text{Harness}$$\n- 行内: $a^2 + b^2 = c^2$"
    );

    const placeholders = container.querySelectorAll(MATH_BLOCK_SELECTOR);
    expect(placeholders.length).toBe(2);

    hydrateMathPlaceholders(container);

    // 水合完成后标记状态为 done
    const hydrated = container.querySelectorAll(MATH_BLOCK_SELECTOR);
    expect(hydrated[0].getAttribute("data-biliscript-math-status")).toBe("done");
    expect(hydrated[1].getAttribute("data-biliscript-math-status")).toBe("done");

    // 检查生成的 MathML 标签
    const mathTags = container.querySelectorAll("math");
    expect(mathTags.length).toBe(2);
    expect(mathTags[0].getAttribute("display")).toBe("block");
    expect(container.innerHTML).toContain("<annotation encoding=\"application/x-tex\">");
  });

  it("公式语法错误时优雅降级并标记 error，不抛出异常", () => {
    const container = document.createElement("div");
    container.innerHTML = '<span data-biliscript-math="inline" data-tex="\\invalid{\\macro">error</span>';

    expect(() => hydrateMathPlaceholders(container)).not.toThrow();
    const el = container.querySelector(MATH_BLOCK_SELECTOR);
    expect(el?.getAttribute("data-biliscript-math-status")).toBe("done");
    expect(el?.innerHTML).toContain("katex-error");
  });
});
