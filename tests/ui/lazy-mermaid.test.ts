// ui/lazy-mermaid 可见性门控单测：mock 掉 mermaid-render（真渲染跑不了 jsdom），
// 钉住门控契约——屏外占位不装载（IntersectionObserver 滚入才水合）、视口内
// 占位立即水合（零感知）、force 与环境守卫（无 IntersectionObserver）绕过门控。
// 模块级 observer 状态经 resetModules + 动态导入隔离，每条用例拿干净实例。

import { beforeEach, describe, expect, it, vi } from "vitest";

const renderMock = vi.hoisted(() => ({
  hydrateMermaidPlaceholders: vi.fn(async () => {})
}));

vi.mock("../../extension/ui/mermaid-render.js", () => renderMock);

vi.mock("../../extension/core/state.js", () => ({
  state: { reader: { readingTheme: "light" } }
}));

class IOStub {
  static instances: IOStub[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback) {
    IOStub.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  trigger(target: Element, isIntersecting: boolean): void {
    this.cb([{ target, isIntersecting } as IntersectionObserverEntry], this as never);
  }
}

type LazyMermaidModule = typeof import("../../extension/ui/lazy-mermaid.js");

async function loadModule(): Promise<LazyMermaidModule> {
  vi.resetModules();
  return import("../../extension/ui/lazy-mermaid.js");
}

function mountBlock(state = "pending"): Element {
  document.body.innerHTML =
    `<div class="boc-md-mermaid" data-boc-mermaid="${state}">` +
    `<pre class="boc-md-mermaid-src"><code>flowchart LR
A-->B</code></pre></div>`;
  return document.querySelector(".boc-md-mermaid")!;
}

function setRect(block: Element, top: number): void {
  block.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + 24,
      left: 0,
      right: 100,
      width: 100,
      height: 24,
      x: 0,
      y: top,
      toJSON: () => ({})
    }) as DOMRect;
}

beforeEach(() => {
  document.body.innerHTML = "";
  renderMock.hydrateMermaidPlaceholders.mockClear();
  IOStub.instances.length = 0;
  vi.stubGlobal("IntersectionObserver", IOStub);
});

describe("hydrateMermaid 可见性门控", () => {
  it("屏外占位不装载，滚入视口才水合并解除观察", async () => {
    const block = mountBlock();
    setRect(block, window.innerHeight + 500);

    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(document.body);

    expect(renderMock.hydrateMermaidPlaceholders).not.toHaveBeenCalled();
    expect(IOStub.instances).toHaveLength(1);
    expect(IOStub.instances[0].targets.has(block)).toBe(true);

    IOStub.instances[0].trigger(block, true);
    await vi.waitFor(() =>
      expect(renderMock.hydrateMermaidPlaceholders).toHaveBeenCalledTimes(1)
    );
    expect(IOStub.instances[0].targets.has(block)).toBe(false);
  });

  it("不相交事件不触发水合", async () => {
    const block = mountBlock();
    setRect(block, window.innerHeight + 500);

    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(document.body);

    IOStub.instances[0].trigger(block, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderMock.hydrateMermaidPlaceholders).not.toHaveBeenCalled();
    expect(IOStub.instances[0].targets.has(block)).toBe(true);
  });

  it("视口内占位立即水合，不挂观察器", async () => {
    const block = mountBlock();
    setRect(block, 100);

    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(document.body);

    await vi.waitFor(() =>
      expect(renderMock.hydrateMermaidPlaceholders).toHaveBeenCalledTimes(1)
    );
    expect(renderMock.hydrateMermaidPlaceholders).toHaveBeenCalledWith(
      block,
      expect.objectContaining({ theme: "light", force: false })
    );
    expect(IOStub.instances).toHaveLength(0);
  });

  it("force 绕过门控：屏外也立即水合", async () => {
    const block = mountBlock();
    setRect(block, window.innerHeight + 500);

    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(document.body, { force: true });

    await vi.waitFor(() =>
      expect(renderMock.hydrateMermaidPlaceholders).toHaveBeenCalledTimes(1)
    );
    expect(renderMock.hydrateMermaidPlaceholders).toHaveBeenCalledWith(
      document.body,
      expect.objectContaining({ force: true })
    );
    expect(IOStub.instances).toHaveLength(0);
  });

  it("无 IntersectionObserver 环境回退立即水合", async () => {
    vi.stubGlobal("IntersectionObserver", undefined);
    const block = mountBlock();
    setRect(block, window.innerHeight + 500);

    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(document.body);

    await vi.waitFor(() =>
      expect(renderMock.hydrateMermaidPlaceholders).toHaveBeenCalledTimes(1)
    );
    expect(IOStub.instances).toHaveLength(0);
  });

  it("非 pending 占位不水合也不观察", async () => {
    mountBlock("done");

    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(document.body);

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderMock.hydrateMermaidPlaceholders).not.toHaveBeenCalled();
    expect(IOStub.instances).toHaveLength(0);
  });

  it("无占位 / 空 root 直接返回", async () => {
    const { hydrateMermaid } = await loadModule();
    hydrateMermaid(null);
    hydrateMermaid(document.body);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(renderMock.hydrateMermaidPlaceholders).not.toHaveBeenCalled();
  });
});
