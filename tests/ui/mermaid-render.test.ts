// ui/mermaid-render 水合单测：mock 掉 mermaid 本体（真渲染需要布局引擎，jsdom
// 里跑不了），只钉住本模块自己的契约——状态机（pending → done / error）、源码
// 保留、插入时换新 id、缓存命中不重渲染、主题切换才重渲染。
//
// 模块内（svgCache / pendingRenders / idSeq / configuredTheme）是模块级状态，
// 每条用例 resetModules 后重新动态导入，拿到干净实例。

import { beforeEach, describe, expect, it, vi } from "vitest";

const mermaidMock = vi.hoisted(() => {
  const render = vi.fn();
  return {
    initialize: vi.fn(),
    render,
    // mermaid.render(id, source) 的实际入参（断言换新 id / 源码透传用）
    calls: [] as Array<{ id: string; source: string }>
  };
});

vi.mock("mermaid", () => ({ default: { initialize: mermaidMock.initialize, render: mermaidMock.render } }));

type RenderModule = typeof import("../../extension/ui/mermaid-render.js");

async function loadModule(): Promise<RenderModule> {
  vi.resetModules();
  return import("../../extension/ui/mermaid-render.js");
}

function mountBlock(source: string): Element {
  document.body.innerHTML =
    `<div class="boc-md-mermaid" data-boc-mermaid="pending">` +
    `<pre class="boc-md-mermaid-src"><code>${source}</code></pre></div>`;
  return document.querySelector(".boc-md-mermaid")!;
}

// mermaid 的 SVG 以根 id 作内部 id 前缀（<style> 选择器与 url(#…) 引用）
function svgFor(id: string): string {
  return `<svg id="${id}"><style>#${id} .node{fill:#fff}</style><rect fill="url(#${id})"></rect></svg>`;
}

beforeEach(() => {
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  mermaidMock.calls.length = 0;
  mermaidMock.render.mockImplementation(async (id: string, source: string) => {
    mermaidMock.calls.push({ id, source });
    return { svg: svgFor(id) };
  });
  document.body.innerHTML = "";
});

describe("hydrateMermaidPlaceholders", () => {
  it("成功：状态翻 done、SVG 换入、源码 <pre> 保留（由 CSS 按 done 隐藏）", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    const block = mountBlock("graph TD\nA --> B");

    await hydrateMermaidPlaceholders(document.body, { theme: "light" });

    expect(mermaidMock.calls).toEqual([{ id: expect.stringMatching(/^boc-mermaid-/), source: "graph TD\nA --> B" }]);
    expect(block.getAttribute("data-boc-mermaid")).toBe("done");
    expect(block.querySelector(".boc-md-mermaid-src code")!.textContent).toBe("graph TD\nA --> B");
    expect(block.querySelector(".boc-md-mermaid-svg svg")).toBeTruthy();
  });

  it("插入时换新 id：<style> 选择器与 url(#…) 引用整体改写，不复用渲染时的 id", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    const block = mountBlock("graph TD");

    await hydrateMermaidPlaceholders(document.body);

    const renderedId = mermaidMock.calls[0].id;
    const html = block.querySelector(".boc-md-mermaid-svg")!.innerHTML;
    const mountedId = /<svg id="([^"]+)"/.exec(html)![1];
    expect(mountedId).not.toBe(renderedId);
    expect(html).toContain(`#${mountedId} .node`);
    expect(html).toContain(`url(#${mountedId})`);
    expect(html).not.toContain(renderedId);
  });

  it("失败：状态置 error、源码保留、补一行降级说明，且不影响后续图表", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    let call = 0;
    mermaidMock.render.mockImplementation(async (id: string, source: string) => {
      mermaidMock.calls.push({ id, source });
      call += 1;
      if (call === 1) {
        throw new Error("Parse error");
      }
      return { svg: svgFor(id) };
    });
    document.body.innerHTML =
      `<div class="boc-md-mermaid" data-boc-mermaid="pending"><pre class="boc-md-mermaid-src"><code>bad</code></pre></div>` +
      `<div class="boc-md-mermaid" data-boc-mermaid="pending"><pre class="boc-md-mermaid-src"><code>good</code></pre></div>`;

    await hydrateMermaidPlaceholders(document.body);

    const [bad, good] = Array.from(document.querySelectorAll(".boc-md-mermaid"));
    expect(bad.getAttribute("data-boc-mermaid")).toBe("error");
    expect(bad.querySelector(".boc-md-mermaid-fallback")!.textContent).toContain("图表渲染失败");
    expect(bad.querySelector(".boc-md-mermaid-src")!.textContent).toContain("bad");
    expect(good.getAttribute("data-boc-mermaid")).toBe("done");
  });

  it("空源码占位不调用 mermaid，状态保持 pending", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    const block = mountBlock("   ");

    await hydrateMermaidPlaceholders(document.body);

    expect(mermaidMock.render).not.toHaveBeenCalled();
    expect(block.getAttribute("data-boc-mermaid")).toBe("pending");
  });

  it("缓存：同主题同源码再水合一次不重渲染（流式 stable 每增长一次就整体重建）", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    mountBlock("graph TD\nA --> B");
    await hydrateMermaidPlaceholders(document.body);

    // 整体重建：新节点、pending 状态、同样源码
    mountBlock("graph TD\nA --> B");
    await hydrateMermaidPlaceholders(document.body);

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector(".boc-md-mermaid")!.getAttribute("data-boc-mermaid")).toBe("done");
  });

  it("主题：异主题各自渲染并重配 mermaid；force + 同主题跳过", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    const block = mountBlock("graph TD");

    await hydrateMermaidPlaceholders(document.body, { theme: "light" });
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "default" }));

    // 同主题 force：块记录的渲染主题一致 → 跳过（applyReadingViewPresentation
    // 在进入阅读模式等路径上会重复调用，不能白闪一次）
    await hydrateMermaidPlaceholders(document.body, { theme: "light", force: true });
    expect(mermaidMock.render).toHaveBeenCalledTimes(1);

    // 异主题 force：重渲染
    await hydrateMermaidPlaceholders(document.body, { theme: "dark", force: true });
    expect(mermaidMock.render).toHaveBeenCalledTimes(2);
    expect(mermaidMock.initialize).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dark" }));
    expect(mermaidMock.initialize).toHaveBeenCalledTimes(2);
    expect(block.getAttribute("data-boc-mermaid")).toBe("done");
  });

  it("非 force 水合不动已渲染的块（换主题不经 force 不会重做）", async () => {
    const { hydrateMermaidPlaceholders } = await loadModule();
    mountBlock("graph TD");

    await hydrateMermaidPlaceholders(document.body, { theme: "light" });
    await hydrateMermaidPlaceholders(document.body, { theme: "dark" });

    expect(mermaidMock.render).toHaveBeenCalledTimes(1);
  });
});
