import { afterEach, describe, expect, it, vi } from "vitest";
import { createMarkdownCommitCursor, renderMarkdown } from "../../extension/ui/markdown.js";
import { enhanceMarkdownTables } from "../../extension/ui/markdown-table.js";

function tableMarkdown(rows: string[]): string {
  return ["| 名称 | 说明 |", "| --- | --- |", ...rows].join("\n");
}

describe("Markdown 表格横滑容器", () => {
  it("包装表格且重复增强不嵌套", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(tableMarkdown(["| A | B |"]));

    enhanceMarkdownTables(root);
    enhanceMarkdownTables(root);

    expect(root.querySelectorAll(".biliscript-md-table")).toHaveLength(1);
    expect(root.querySelectorAll(".biliscript-md-table-scroll")).toHaveLength(1);
    expect(root.querySelector(".biliscript-md-table-scroll")?.getAttribute("role")).toBe("region");
    expect(root.querySelectorAll("table")).toHaveLength(1);
  });

  it("流式游标向已包装的原表继续追加行", () => {
    const root = document.createElement("div");
    const cursor = createMarkdownCommitCursor();
    cursor.commit(renderMarkdown(tableMarkdown(["| A | B |"])), root);
    enhanceMarkdownTables(root);
    const originalTable = root.querySelector("table");

    cursor.commit(renderMarkdown(tableMarkdown(["| C | D |"])), root);

    expect(root.querySelectorAll("table")).toHaveLength(1);
    expect(root.querySelector("table")).toBe(originalTable);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelector("tbody")?.textContent).toContain("C");
  });

  it("流式游标重置后仍可从 .biliscript-md-table 包装层找回原表并续接新行", () => {
    const root = document.createElement("div");
    const cursor = createMarkdownCommitCursor();
    cursor.commit(renderMarkdown(tableMarkdown(["| A | B |"])), root);
    enhanceMarkdownTables(root);
    const originalTable = root.querySelector("table");

    // 重置 activeTable，强制走 container.lastElementChild 的 .biliscript-md-table 匹配分支
    cursor.reset();
    cursor.commit(renderMarkdown(tableMarkdown(["| C | D |"])), root);

    expect(root.querySelectorAll("table")).toHaveLength(1);
    expect(root.querySelector("table")).toBe(originalTable);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(root.querySelector("tbody")?.textContent).toContain("C");
  });
});

describe("Markdown 长文本表格卡片布局", () => {
  it("2～4 列长文本表格使用卡片候选布局并注入真实字段标签", () => {
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown(tableMarkdown([`| OpenAI | ${"加密且不可读的压缩内容。".repeat(4)} |`]));

    enhanceMarkdownTables(root);
    enhanceMarkdownTables(root);

    expect(root.querySelector(".biliscript-md-table")?.classList.contains("biliscript-md-table-cards")).toBe(true);
    const cells = root.querySelectorAll("tbody td");
    expect(cells[0].querySelector(".biliscript-md-table-cell-label")).toBeNull();
    expect(cells[1].querySelectorAll(".biliscript-md-table-cell-label")).toHaveLength(1);
    expect(cells[1].querySelector(".biliscript-md-table-cell-label")?.textContent).toBe("说明");
  });

  it("短文本表格和五列表格保留标准布局", () => {
    const root = document.createElement("div");
    const wide = ["| A | B | C | D | E |", "| --- | --- | --- | --- | --- |", `| ${"长文本".repeat(20)} | 2 | 3 | 4 | 5 |`].join("\n");
    root.innerHTML = `${renderMarkdown(tableMarkdown(["| A | B |"]))}${renderMarkdown(wide)}`;

    enhanceMarkdownTables(root);

    expect(root.querySelectorAll(".biliscript-md-table-cards")).toHaveLength(0);
  });
});

describe("Markdown 表格展开视图", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  });

  it("复制表格到全页弹层，移除复制内容中的按钮并在关闭后清理", () => {
    const showModal = vi.fn();
    const close = vi.fn(function (this: HTMLDialogElement) {
      this.dispatchEvent(new Event("close"));
    });
    HTMLDialogElement.prototype.showModal = showModal;
    HTMLDialogElement.prototype.close = close;
    const view = document.createElement("div");
    view.id = "biliscript-reading-view";
    const root = document.createElement("div");
    view.appendChild(root);
    document.body.appendChild(view);
    root.innerHTML = renderMarkdown(tableMarkdown(["| A | B |"]));
    root.querySelector("tbody td")!.appendChild(Object.assign(document.createElement("button"), { textContent: "09:39" }));
    enhanceMarkdownTables(root);
    const originalTable = root.querySelector("table");

    root.querySelector<HTMLButtonElement>(".biliscript-md-table-expand")!.click();

    const dialog = view.querySelector<HTMLDialogElement>(".biliscript-md-table-dialog");
    expect(dialog).not.toBeNull();
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog?.querySelector("table")).not.toBe(originalTable);
    expect(dialog?.querySelector("table button")).toBeNull();
    expect(dialog?.textContent).toContain("09:39");
    expect(root.querySelector("table")).toBe(originalTable);

    dialog?.querySelector<HTMLButtonElement>(".biliscript-md-table-dialog-close")!.click();
    expect(close).toHaveBeenCalledOnce();
    expect(view.querySelector(".biliscript-md-table-dialog")).toBeNull();
  });
});
