import { describe, expect, it } from "vitest";
import { select } from "../../scripts/vendor-d3-slim.mjs";
import { auditMermaidTransitionCalls } from "../../scripts/vendor-mermaid-slim.mjs";

describe("vendor-d3-slim 运行时门控", () => {
  it("允许的终态 setter 链立即生效且保持链式", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const sel = select(el);

    const transition = sel.transition();
    expect(transition.duration(200)).toBe(transition);
    expect(transition.style("opacity", "0.9")).toBe(transition);
    expect(transition.attr("data-x", "1")).toBe(transition);
    expect(transition.text("plain")).toBe(transition);
    expect(el.textContent).toBe("plain");
    expect(transition.html("<span>ok</span>")).toBe(transition);
    expect(el.innerHTML).toBe("<span>ok</span>");
    expect(el.style.opacity).toBe("0.9");
    expect(el.getAttribute("data-x")).toBe("1");
    expect(transition.selection()).toBe(sel);
    expect(await Promise.resolve(transition)).toBe(transition);
    expect(transition.remove()).toBe(transition);
    expect(el.isConnected).toBe(false);
  });

  it("对生命周期回调、时序插值、链式嵌套过渡与未知方法显式抛错", () => {
    const el = document.createElement("div");
    const sel = select(el);
    const t = sel.transition() as Record<string, (...args: unknown[]) => unknown>;

    expect(() => t.on("end", () => {})).toThrow(/vendor-d3-slim.*transition\.on\(\)/);
    expect(() => t.end()).toThrow(/vendor-d3-slim.*transition\.end\(\)/);
    expect(() => t.delay(50)).toThrow(/vendor-d3-slim.*transition\.delay\(\)/);
    expect(() => t.ease((x: number) => x)).toThrow(/vendor-d3-slim.*transition\.ease\(\)/);
    expect(() => t.tween("x", () => {})).toThrow(/vendor-d3-slim.*transition\.tween\(\)/);
    expect(() => t.styleTween("opacity", () => {})).toThrow(/vendor-d3-slim.*transition\.styleTween\(\)/);
    expect(() => t.attrTween("d", () => {})).toThrow(/vendor-d3-slim.*transition\.attrTween\(\)/);
    expect(() => t.transition()).toThrow(/vendor-d3-slim.*transition\.transition\(\)/);
    expect(() => t.futureD3Hook()).toThrow(/vendor-d3-slim.*transition\.futureD3Hook\(\)/);
  });

  it("对 getter 误用、undefined 写入、具名过渡与 interrupt 显式抛错", () => {
    const el = document.createElement("div");
    const sel = select(el) as unknown as {
      transition: (...args: unknown[]) => Record<string, (...args: unknown[]) => unknown>;
      interrupt: () => unknown;
    };
    const t = sel.transition();

    expect(() => t.duration()).toThrow(/仅支持 setter/);
    expect(() => t.duration(undefined)).toThrow(/仅支持 setter/);
    expect(() => t.style("opacity")).toThrow(/仅支持 setter/);
    expect(() => t.style("opacity", undefined)).toThrow(/仅支持 setter/);
    expect(() => t.attr("data-x")).toThrow(/仅支持 setter/);
    expect(() => t.text()).toThrow(/仅支持 setter/);
    expect(() => t.html()).toThrow(/仅支持 setter/);
    expect(() => sel.transition("venn")).toThrow(/具名或继承过渡不受支持/);
    expect(() => sel.interrupt()).toThrow(/selection\.interrupt\(\)/);
  });
});

describe("vendor-mermaid-slim 构建期 d3-transition 闭包审计", () => {
  it("放行 Mermaid 12 tooltip 终态写入链并忽略字符串、正则、注释与 d3-slim 自身模块", () => {
    const sample = [
      "// scripts/vendor-d3-slim.mjs",
      "selection.prototype.transition = function() { return this.transition().on('end', fn); };",
      "selection.prototype.interrupt = function() { return el.interrupt(); };",
      "// node_modules/mermaid/dist/chunks/flow.mjs",
      "const msg = 'x.transition().on(\"end\", cb); y.interrupt();';",
      "const rx = /[\"'`]/g;",
      "function setupToolTips(tooltipElem) {",
      "  tooltipElem.transition().duration(200).style('opacity', '.9');",
      "  tooltipElem.transition().duration(500).style('opacity', 0);",
      "}"
    ].join("\n");

    const { calls, violations } = auditMermaidTransitionCalls(sample, "flow.js");
    expect(violations).toEqual([]);
    expect(calls).toEqual([
      { source: "flow.js", line: 8, methods: ["duration", "style"] },
      { source: "flow.js", line: 9, methods: ["duration", "style"] }
    ]);
  });

  it("拦截 on/delay/ease/end/interrupt、具名过渡与 getter 调用", () => {
    const sample = [
      "el.transition().duration(200).on('end', done);",
      "el.transition().delay(50).style('opacity', 1);",
      "el.transition().ease(fn).style('opacity', 1);",
      "el.transition().end();",
      "el.transition('venn').duration(100);",
      "el.transition().style('opacity');",
      "el.interrupt();"
    ].join("\n");

    const { violations } = auditMermaidTransitionCalls(sample, "upgrade.js");
    expect(violations).toEqual([
      expect.stringContaining("upgrade.js:1: transition 链调用了未允许方法 .on()"),
      expect.stringContaining("upgrade.js:2: transition 链调用了未允许方法 .delay()"),
      expect.stringContaining("upgrade.js:3: transition 链调用了未允许方法 .ease()"),
      expect.stringContaining("upgrade.js:4: transition 链调用了未允许方法 .end()"),
      expect.stringContaining("upgrade.js:5: transition() 含 1 个参数"),
      expect.stringContaining("upgrade.js:6: transition.style() 参数不足"),
      expect.stringContaining("upgrade.js:7: 检测到 .interrupt() 调用")
    ]);
  });

  it("拦截返回值逃逸与动态下标绕过", () => {
    const sample = [
      "const t = el.transition().duration(200).style('opacity', 1);",
      "function f() { return el.transition().duration(200).style('opacity', 1); }",
      "const g = () => el.transition().duration(200).style('opacity', 1);",
      "consume(el.transition().duration(200).style('opacity', 1));",
      "el.transition()['on']('end', done);"
    ].join("\n");

    const { violations } = auditMermaidTransitionCalls(sample, "escape.js");
    expect(violations).toEqual([
      expect.stringContaining("escape.js:1: transition() 返回值可能逃逸"),
      expect.stringContaining("escape.js:2: transition() 返回值可能逃逸"),
      expect.stringContaining("escape.js:3: transition() 返回值可能逃逸"),
      expect.stringContaining("escape.js:4: transition() 返回值可能逃逸"),
      expect.stringContaining('escape.js:4: transition 链后紧跟 ")"'),
      expect.stringContaining("escape.js:5: transition() 后缺少已允许的终态写入链"),
      expect.stringContaining('escape.js:5: transition 链后紧跟 "["')
    ]);
  });
});
