import { describe, expect, it, vi } from "vitest";
import { hydrateMarkdownContent, renderMarkdown, renderMarkdownStripped } from "../../extension/ui/markdown.js";

describe("renderMarkdown 代码围栏", () => {
  it("```mermaid → 图表占位，语言名不进正文", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\nA --> B\n```");
    expect(html).toContain('class="biliscript-md-mermaid" data-biliscript-mermaid="pending"');
    expect(html).toContain("graph TD\nA --&gt; B");
    expect(html).not.toContain("<code>mermaid");
    expect(html).not.toContain("mermaid\n");
  });

  it("语言名大小写不敏感（Mermaid / MERMAID 同为图表）", () => {
    expect(renderMarkdown("```Mermaid\ngraph TD\n```")).toContain("data-biliscript-mermaid");
    expect(renderMarkdown("``` MERMAID \ngraph TD\n```")).toContain("data-biliscript-mermaid");
  });

  it("其他语言的围栏：语言名写入 data-lang 属性而不进正文，仍走普通代码块", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    expect(html).toContain('<pre data-lang="js"><code>');
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("js\n");
    expect(html).not.toContain("data-biliscript-mermaid");
  });

  it("无语言围栏与含空格的 info string 都不误吞正文", () => {
    expect(renderMarkdown("```\nplain\n```")).toBe("<pre><code>plain\n</code></pre>");
    const html = renderMarkdown("```js title=foo\nx\n```");
    expect(html).toContain('<pre data-lang="js"><code>x\n</code></pre>');
    expect(html).not.toContain("title=foo");
  });

  it("段中围栏标记按普通文本保留，不产出占位符", () => {
    const inlineFence = renderMarkdown("段落中 ```js\ncode\n``` 之后");
    expect(inlineFence).toBe("<p>段落中 ``<code>js code </code>`` 之后</p>");
    expect(inlineFence).not.toContain("\u0001BILISCRIPT_CODE");
    expect(renderMarkdown("```js alert(1)```")).toBe(
      "<p>``<code>js alert(1)</code>``</p>"
    );
    expect(renderMarkdown("```plain```")).toBe("<p>``<code>plain</code>``</p>");
    expect(renderMarkdown("   ```js\ncode\n```")).toBe('<pre data-lang="js"><code>code\n</code></pre>');
    expect(renderMarkdownStripped("    ```js\ncode\n```")).toBe(
      "<p>``<code>js code </code>``</p>"
    );
  });

  it("空 mermaid 围栏：仍产出占位（源码为空由水合侧跳过），单行写法按正文处理", () => {
    expect(renderMarkdown("```mermaid\n```")).toBe(
      '<div class="biliscript-md-mermaid" data-biliscript-mermaid="pending"><pre class="biliscript-md-mermaid-src"><code></code></pre></div>'
    );
    expect(renderMarkdown("```mermaid```")).toBe("<p>``<code>mermaid</code>``</p>");
  });

  it("图表源码仍先过 escapeHtml（不产出可执行标签）", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\nA[<script>alert(1)</script>]\n```");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("围栏在流式切分中闭合于前缀：图表占位整块落在 stable", () => {
    const html = renderMarkdown("说明\n\n```mermaid\ngraph TD\nA --> B\n```");
    expect(html).toContain("data-biliscript-mermaid");
  });

  it("hydrateMarkdownContent 幂等增强普通代码块：显示语言栏并支持一键复制，跳过 mermaid 源码", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true
    });
    const root = document.createElement("div");
    root.innerHTML = renderMarkdown("```ts\nconst x = 42;\n```\n\n```mermaid\ngraph TD\nA-->B\n```");

    hydrateMarkdownContent(root);
    hydrateMarkdownContent(root);

    const blocks = root.querySelectorAll(".biliscript-md-code");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].querySelector(".biliscript-md-code-lang")?.textContent).toBe("ts");
    const copyBtn = blocks[0].querySelector<HTMLButtonElement>(".biliscript-md-code-copy")!;
    expect(copyBtn.getAttribute("aria-label")).toBe("复制代码");
    copyBtn.click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith("const x = 42;\n"));
  });
});
