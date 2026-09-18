// vendor-d3-slim.mjs 契约单测：mermaid 11 的 flow tooltip（chunk-SHT3W25Y.mjs
// 的 setupToolTips）调用 `selection.transition().duration(n).style(k, v)` 链；
// mermaid 11.17.2 里 flowchart-v2/sequence 渲染路径实际不再调用 bindFunctions，
// 该链是保留代码里的死路径，但补丁契约仍要钉住——style 必须立即落到元素上
// （tooltip 初值 opacity 0，纯 no-op 会让 tooltip 永不出现），duration/delay/ease
// 等保持链式可调用，interrupt 返回 selection 自身。

import { describe, expect, it } from "vitest";
import { select } from "../../scripts/vendor-d3-slim.mjs";

describe("vendor-d3-slim transition 补丁", () => {
  it("transition().duration().style() 立即应用终值且保持链式", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);

    const transition = select(el).transition();
    const chained = transition.duration(200).delay(50).ease((t: number) => t);
    expect(chained).toBe(transition);

    const result = transition.style("opacity", "0.9").attr("data-x", "1");
    expect(result).toBe(transition);
    expect(el.style.opacity).toBe("0.9");
    expect(el.getAttribute("data-x")).toBe("1");

    el.remove();
  });

  it("嵌套 transition/selection/on/remove 不崩", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const sel = select(el);

    const t = sel.transition();
    expect(t.on("end", () => {})).toBe(t);
    expect(t.selection()).toBe(sel);
    const nested = t.transition();
    expect(nested.style("opacity", "0")).toBe(nested);
    expect(el.style.opacity).toBe("0");
    expect(sel.interrupt()).toBe(sel);

    el.remove();
  });

  it("select 直通 d3-selection 的完整 API", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const sel = select(el);
    sel.attr("class", "x").append("span").text("hi");
    expect(el.querySelector("span")?.textContent).toBe("hi");
    expect(el.getAttribute("class")).toBe("x");
    el.remove();
  });
});
