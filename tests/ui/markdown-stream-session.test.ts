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

    // 帧 1：单个段落，无空行边界 → 全 tail
    session.flush("第一段正文", { cursor });
    expect(stableEl.children).toHaveLength(0);
    expect(tailEl.textContent).toContain("第一段正文");
    expect(tailEl.contains(cursor)).toBe(true);
    expect(session.stableText).toBe("");
    expect(session.tailText).toBe("第一段正文");

    // 帧 2：空行出现，第一段落定到 stable，第二段在 tail
    session.flush("\n\n第二段开头", { cursor });
    expect(stableEl.children).toHaveLength(1);
    expect(stableEl.querySelector("p")?.textContent).toBe("第一段正文");
    expect(tailEl.textContent).toContain("第二段开头");
    expect(tailEl.contains(cursor)).toBe(true);

    const firstParagraph = stableEl.querySelector("p");

    // 帧 3：第二段继续增长，第一段 DOM 节点保持 === 引用
    session.flush("，继续增长", { cursor });
    expect(stableEl.querySelector("p")).toBe(firstParagraph);
    expect(tailEl.textContent).toContain("第二段开头，继续增长");

    // 帧 4：再次出现空行，第二段落定
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

    // 帧 1：推送前言与表格第一行，切点在「前言」后
    session.flush("前言\n\n| 编号 | 项目 |\n| --- | --- |\n| 1 | 苹果 |\n\n");
    expect(stableEl.textContent).toContain("前言");
    expect(tailEl.querySelectorAll("table")).toHaveLength(1);

    // 帧 2：推送第二行与结尾，表格第一行提交到 stable 并包裹为 .biliscript-md-table，第二行紧随追加进原表
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

    // 模拟让出并在恢复后检测 stale
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

    // 若让出点处于 stale 状态，放弃后续提交
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

    // 重置后可重新独立使用
    session.flush("全新内容\n\n第二段");
    expect(stableEl.textContent).toBe("全新内容");
    expect(session.rawText).toBe("全新内容\n\n第二段");
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
