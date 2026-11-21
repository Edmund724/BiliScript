import { describe, expect, it, vi } from "vitest";
import {
  createMarkdownStreamSession,
  hydrateMarkdownContent,
  MATH_BLOCK_ATTR,
  MERMAID_BLOCK_ATTR
} from "../../extension/ui/markdown.js";

describe("MarkdownStreamSession 双容器流式会话", () => {
  it("增量推入段落并正确提交到 stable 容器与 tail 容器", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const cursor = document.createElement("span");
    cursor.className = "test-cursor";

    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("第一段正文", { cursor });
    expect(stableEl.children).toHaveLength(0);
    expect(tailEl.textContent).toContain("第一段正文");
    expect(tailEl.contains(cursor)).toBe(true);
    expect(session.stableText).toBe("");
    expect(session.tailText).toBe("第一段正文");

    session.flush("\n\n第二段开头", { cursor });
    expect(stableEl.children).toHaveLength(1);
    expect(stableEl.querySelector("p")?.textContent).toBe("第一段正文");
    expect(tailEl.textContent).toContain("第二段开头");
    expect(tailEl.contains(cursor)).toBe(true);

    const firstParagraph = stableEl.querySelector("p");

    const removedFromTail: Node[] = [];
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.removedNodes.forEach((node) => removedFromTail.push(node));
      }
    });
    observer.observe(tailEl, { childList: true });

    session.flush("，继续增长", { cursor });
    expect(stableEl.querySelector("p")).toBe(firstParagraph);
    expect(tailEl.textContent).toContain("第二段开头，继续增长");
    expect(tailEl.lastElementChild).toBe(cursor);
    expect(removedFromTail.includes(cursor)).toBe(false);
    observer.disconnect();

    session.flush("\n\n第三段", { cursor });
    expect(stableEl.children).toHaveLength(2);
    expect(stableEl.querySelector("p")).toBe(firstParagraph);
    expect(stableEl.querySelectorAll("p")[1].textContent).toBe("第二段开头，继续增长");
    expect(tailEl.textContent).toContain("第三段");

    expect(session.rawText).toBe("第一段正文\n\n第二段开头，继续增长\n\n第三段");
    expect(session.strippedText).toBe("第一段正文\n\n第二段开头，继续增长\n\n第三段");
  });

  it("自动剥除 <think> 思考块且不破坏流式切分", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("<think>正在深入分析问题...</think>正式回答内容\n\n后续段落");
    expect(stableEl.textContent).toBe("正式回答内容");
    expect(tailEl.textContent).toBe("后续段落");
    expect(stableEl.textContent).not.toContain("深入分析");
    expect(session.strippedText).toBe("正式回答内容\n\n后续段落");
    expect(session.rawText).toContain("<think>");
  });

  it("表格增量续接并保持 .biliscript-md-table 结构完整", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("前言\n\n| 编号 | 项目 |\n| --- | --- |\n| 1 | 苹果 |\n\n");
    expect(stableEl.textContent).toContain("前言");
    expect(tailEl.querySelectorAll("table")).toHaveLength(1);

    session.flush("| 2 | 香蕉 |\n\n结尾");
    expect(stableEl.querySelectorAll("table")).toHaveLength(1);
    expect(stableEl.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(stableEl.querySelector("tbody")?.textContent).toContain("香蕉");
  });

  it("长任务预算耗尽时让出主线程并具备代际过期保护", async () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    let yieldCount = 0;
    const yieldToMain = vi.fn(async () => {
      yieldCount++;
    });

    let isStale = false;
    const res = session.flush("段落一\n\n段落二", {
      shouldYield: () => true,
      yieldToMain,
      isStale: () => isStale
    });

    expect(res).toBeInstanceOf(Promise);
    await res;
    expect(yieldToMain).toHaveBeenCalled();
    expect(stableEl.textContent).toContain("段落一");

    isStale = true;
    yieldToMain.mockClear();
    await session.flush("\n\n段落三\n\n段落四", {
      shouldYield: () => true,
      yieldToMain,
      isStale: () => isStale
    });
    expect(yieldToMain).toHaveBeenCalled();
    expect(stableEl.textContent).not.toContain("段落三");
  });

  it("reset() 完全重置 DOM 容器与内部游标状态", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("第一段\n\n第二段");
    expect(stableEl.innerHTML).not.toBe("");
    expect(session.rawText).not.toBe("");

    session.reset();
    expect(stableEl.innerHTML).toBe("");
    expect(tailEl.innerHTML).toBe("");
    expect(session.rawText).toBe("");
    expect(session.stableText).toBe("");
    expect(session.tailText).toBe("");
    expect(session.stableCut).toBe(-2);
    expect(session.committedCut).toBe(0);

    session.flush("全新内容\n\n第二段");
    expect(stableEl.textContent).toBe("全新内容");
    expect(session.rawText).toBe("全新内容\n\n第二段");
  });

  it("流式未闭合代码围栏（```）实时容错补全为代码块且带外壳，闭合后无缝衔接", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("说明\n\n```ts\nconst a = 1;\n");
    expect(stableEl.textContent).toBe("说明");
    const streamingCode = tailEl.querySelector(".biliscript-md-code");
    expect(streamingCode).toBeTruthy();
    expect(streamingCode?.querySelector(".biliscript-md-code-lang")?.textContent).toBe("ts");
    const pre = streamingCode?.querySelector("pre");
    expect(pre?.getAttribute("data-lang")).toBe("ts");
    expect(pre?.getAttribute("data-streaming-open")).toBe("true");
    expect(pre?.textContent).toContain("const a = 1;");
    expect(tailEl.querySelector("p")).toBeNull();

    session.flush("```\n\n后续段落");
    expect(stableEl.querySelector(".biliscript-md-code pre")?.getAttribute("data-streaming-open")).toBeNull();
    expect(tailEl.textContent).toContain("后续段落");
  });

  it("流式未闭合 mermaid 围栏保持 streaming 源码态，不提前触发渲染", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("```mermaid\ngraph TD\nA --> ");
    const block = tailEl.querySelector<HTMLElement>(`[${MERMAID_BLOCK_ATTR}]`);
    expect(block).toBeTruthy();
    expect(block?.getAttribute(MERMAID_BLOCK_ATTR)).toBe("streaming");
    expect(block?.getAttribute("data-streaming-open")).toBe("true");
  });

  it("流式未闭合多行公式（$$）含空行不被切裂，容错渲染为稳定占位直到闭合", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("推导如下\n\n$$\na = 1\n\nb = 2");
    expect(stableEl.textContent).toBe("推导如下");
    const mathEl = tailEl.querySelector<HTMLElement>(`[${MATH_BLOCK_ATTR}="block"]`);
    expect(mathEl).toBeTruthy();
    expect(mathEl?.getAttribute("data-streaming-open")).toBe("true");
    expect(mathEl?.textContent).toContain("a = 1");
    expect(mathEl?.textContent).toContain("b = 2");

    session.flush("\n$$\n\n结论");
    const stableMath = stableEl.querySelector<HTMLElement>(`[${MATH_BLOCK_ATTR}="block"]`);
    expect(stableMath).toBeTruthy();
    expect(stableMath?.getAttribute("data-streaming-open")).toBeNull();
    expect(tailEl.textContent).toContain("结论");
  });

  it("流式尾部未闭合行内加粗、代码与公式做防抖容错，不露出孤立标记", () => {
    const stableEl = document.createElement("div");
    const tailEl = document.createElement("div");
    const session = createMarkdownStreamSession(stableEl, tailEl);

    session.flush("这是 **重点内容");
    expect(tailEl.querySelector("strong")?.textContent).toBe("重点内容");
    expect(tailEl.textContent).not.toContain("**");

    session.reset();
    session.flush("变量 `fooBar");
    expect(tailEl.querySelector("code")?.textContent).toBe("fooBar");
    expect(tailEl.textContent).not.toContain("`");

    session.reset();
    session.flush("- 公式: $$E = mc");
    const inlineBlockMath = tailEl.querySelector(`[${MATH_BLOCK_ATTR}="block"][data-streaming-open="true"]`);
    expect(inlineBlockMath).toBeTruthy();
  });
});

describe("hydrateMarkdownContent 统一水合", () => {
  it("对含有表格的节点水合横滑与卡片层", () => {
    const root = document.createElement("div");
    root.innerHTML = "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>";

    hydrateMarkdownContent(root);
    expect(root.querySelectorAll(".biliscript-md-table")).toHaveLength(1);
    expect(root.querySelectorAll(".biliscript-md-table-scroll")).toHaveLength(1);
  });

  it("对含有数学公式与 Mermaid 占位的节点安全触发水合", () => {
    const root = document.createElement("div");
    root.innerHTML = `
      <div class="biliscript-md-mermaid" ${MERMAID_BLOCK_ATTR}="pending">
        <pre class="biliscript-md-mermaid-src"><code>graph TD; A-->B;</code></pre>
      </div>
      <span class="biliscript-md-math biliscript-md-math-inline" ${MATH_BLOCK_ATTR}="inline" data-tex="x^2">$x^2$</span>
    `;

    expect(() => hydrateMarkdownContent(root)).not.toThrow();
  });
});
