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
});
