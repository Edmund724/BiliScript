// ui/markdown 代码围栏解析单测：```lang 的 info string 不再当正文吐出来
//（旧实现把 "mermaid" 这类语言名渲染成代码首行），以及 ```mermaid 围栏产出
// mermaid 图表占位（真正的 SVG 由 ui/mermaid-render 异步水合，见
// tests/ui/mermaid-render.test.ts）。

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../extension/ui/markdown.js";

describe("renderMarkdown 代码围栏", () => {
  it("```mermaid → 图表占位，语言名不进正文", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\nA --> B\n```");
    expect(html).toContain('class="boc-md-mermaid" data-boc-mermaid="pending"');
    expect(html).toContain("graph TD\nA --&gt; B");
    // 语言名只作为围栏标记被消费，绝不落进 <code>（本次修复的原始症状）
    expect(html).not.toContain("<code>mermaid");
    expect(html).not.toContain("mermaid\n");
  });

  it("语言名大小写不敏感（Mermaid / MERMAID 同为图表）", () => {
    expect(renderMarkdown("```Mermaid\ngraph TD\n```")).toContain("data-boc-mermaid");
    expect(renderMarkdown("``` MERMAID \ngraph TD\n```")).toContain("data-boc-mermaid");
  });

  it("其他语言的围栏：语言名同样不进正文，仍走普通代码块", () => {
    const html = renderMarkdown("```js\nconst a = 1;\n```");
    expect(html).toContain("<pre><code>");
    expect(html).toContain("const a = 1;");
    expect(html).not.toContain("js\n");
    expect(html).not.toContain("data-boc-mermaid");
  });

  it("无语言围栏与含空格的 info string 都不误吞正文", () => {
    expect(renderMarkdown("```\nplain\n```")).toBe("<pre><code>plain\n</code></pre>");
    // info string 是多个词时只取首词判语言，其余不落正文
    const html = renderMarkdown("```js title=foo\nx\n```");
    expect(html).toContain("x\n");
    expect(html).not.toContain("title=foo");
  });

  it("单行围栏（``` 与正文同行、无换行）：整段仍按正文，不被当 info string 吃掉", () => {
    expect(renderMarkdown("```js alert(1)```")).toBe("<pre><code>js alert(1)</code></pre>");
    expect(renderMarkdown("```plain```")).toBe("<pre><code>plain</code></pre>");
  });

  it("空 mermaid 围栏：仍产出占位（源码为空由水合侧跳过），单行写法按正文处理", () => {
    expect(renderMarkdown("```mermaid\n```")).toBe(
      '<div class="boc-md-mermaid" data-boc-mermaid="pending"><pre class="boc-md-mermaid-src"><code></code></pre></div>'
    );
    // 无换行的 ```mermaid``` 属于上面「单行围栏」一类：按正文，不产占位
    expect(renderMarkdown("```mermaid```")).toBe("<pre><code>mermaid</code></pre>");
  });

  it("图表源码仍先过 escapeHtml（不产出可执行标签）", () => {
    const html = renderMarkdown("```mermaid\ngraph TD\nA[<script>alert(1)</script>]\n```");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
  });

  it("围栏在流式切分中闭合于前缀：图表占位整块落在 stable", () => {
    const html = renderMarkdown("说明\n\n```mermaid\ngraph TD\nA --> B\n```");
    expect(html).toContain("data-boc-mermaid");
  });
});
