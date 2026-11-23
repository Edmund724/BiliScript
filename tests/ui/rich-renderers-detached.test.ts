import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { createDetachedRealm, type DetachedRealm } from "../helpers/detached-realm.js";

let realm: DetachedRealm | null = null;

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(() => {
  realm?.close();
  realm = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ui 富文本渲染器（Markdown / Table / Mermaid / Math）的跨 Realm 与独立宿主行为", () => {
  it("markdown 代码块增强使用宿主文档创建元素并调用活跃窗口剪贴板", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const markdown = await import("../../extension/ui/markdown.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const root = realm.doc.createElement("div");
    root.innerHTML = `<pre data-lang="ts"><code>const x = 1;</code></pre>`;
    realm.doc.body.appendChild(root);

    markdown.enhanceMarkdownCodeBlocks(root);
    const copyBtn = root.querySelector<HTMLButtonElement>(".biliscript-md-code-copy")!;
    expect(copyBtn).not.toBeNull();
    expect(copyBtn.ownerDocument).toBe(realm.doc);

    copyBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    expect(realm.clipboardWriteText).toHaveBeenCalledWith("const x = 1;");
  });

  it("markdownTable 在跨 Realm 节点下剔除 cell-label 计算卡片宽度，并在宿主切换时关闭 dialog", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const mdTable = await import("../../extension/ui/markdown-table.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const root = realm.doc.createElement("div");
    root.innerHTML = `
      <table>
        <thead><tr><th>A</th><th>B</th></tr></thead>
        <tbody><tr><td>短文本</td><td>123</td></tr></tbody>
      </table>
    `;
    realm.doc.body.appendChild(root);

    mdTable.enhanceMarkdownTables(root);
    mdTable.enhanceMarkdownTables(root);
    const shell = root.querySelector<HTMLElement>(`.${mdTable.TABLE_SHELL_CLASS}`)!;
    expect(shell.classList.contains("biliscript-md-table-cards")).toBe(false);

    const label = root.querySelector<HTMLElement>(".biliscript-md-table-cell-label")!;
    expect(label instanceof window.HTMLElement).toBe(false);
    label.textContent = "这是一个非常非常长的列标题用于验证不会泄露进正文长度判断计算逻辑的文本内容";
    mdTable.enhanceMarkdownTables(root);
    expect(shell.classList.contains("biliscript-md-table-cards")).toBe(false);

    const expandBtn = root.querySelector<HTMLButtonElement>(".biliscript-md-table-expand")!;
    expandBtn.click();
    const dialog = realm.doc.querySelector<HTMLDialogElement>(".biliscript-md-table-dialog");
    expect(dialog).not.toBeNull();

    activeHost.resetActiveReaderHost();
    expect(realm.doc.querySelector(".biliscript-md-table-dialog")).toBeNull();
  });

  it("mermaid-render 与 lazy-mermaid 支持单个跨 Realm Mermaid 块并在宿主切换时重置观察器", async () => {
    realm = createDetachedRealm({ innerHeight: 500 });
    const activeHost = await import("../../extension/shared/active-host.js");

    vi.doMock("mermaid", () => ({
      default: {
        initialize: vi.fn(),
        detectType: vi.fn(() => "flowchart"),
        render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` })),
      },
    }));

    const mermaidRender = await import("../../extension/ui/mermaid-render.js");
    const lazyMermaid = await import("../../extension/ui/lazy-mermaid.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const block = realm.doc.createElement("div");
    block.setAttribute("data-biliscript-mermaid", "pending");
    block.innerHTML = `<pre class="biliscript-md-mermaid-src"><code>graph TD; A-->B;</code></pre>`;
    realm.doc.body.appendChild(block);

    expect(block instanceof window.Element).toBe(false);
    await mermaidRender.hydrateMermaidPlaceholders(block, { theme: "light" });
    expect(block.getAttribute("data-biliscript-mermaid")).toBe("done");
    const svgWrap = block.querySelector(".biliscript-md-mermaid-svg");
    expect(svgWrap?.ownerDocument).toBe(realm.doc);

    const disconnectSpy = vi.fn();
    const observeSpy = vi.fn();
    class MockIntersectionObserver {
      observe = observeSpy;
      unobserve = vi.fn();
      disconnect = disconnectSpy;
    }
    (realm.win as unknown as { IntersectionObserver: unknown }).IntersectionObserver = MockIntersectionObserver;

    const belowFoldBlock = realm.doc.createElement("div");
    belowFoldBlock.setAttribute("data-biliscript-mermaid", "pending");
    belowFoldBlock.innerHTML = `<pre class="biliscript-md-mermaid-src"><code>graph TD; C-->D;</code></pre>`;
    belowFoldBlock.getBoundingClientRect = () =>
      ({ x: 0, y: 900, top: 900, left: 0, right: 200, bottom: 1000, width: 200, height: 100, toJSON: () => ({}) }) as DOMRect;
    const container = realm.doc.createElement("div");
    container.appendChild(belowFoldBlock);
    realm.doc.body.appendChild(container);

    lazyMermaid.hydrateMermaid(container);
    expect(observeSpy).toHaveBeenCalledWith(belowFoldBlock);

    activeHost.resetActiveReaderHost();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it("math-render 在跨 Realm 容器中使用容器 ownerDocument 创建对齐公式节点", async () => {
    realm = createDetachedRealm();
    const activeHost = await import("../../extension/shared/active-host.js");
    const mathRender = await import("../../extension/ui/math-render.js");

    activeHost.setActiveReaderHost(realm.doc, realm.win);
    const container = realm.doc.createElement("div");
    const block = realm.doc.createElement("div");
    block.setAttribute("data-biliscript-math", "block");
    block.setAttribute("data-tex", "a = b + c");
    container.appendChild(block);
    realm.doc.body.appendChild(container);

    mathRender.hydrateMathPlaceholders(container);
    expect(block.getAttribute("data-biliscript-math-status")).toBe("done");
    const aligned = block.querySelector(".biliscript-math-aligned");
    expect(aligned).not.toBeNull();
    expect(aligned?.ownerDocument).toBe(realm.doc);
  });
});
