import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindResettableRangeSlider,
  initRangeSlider,
  setResettableRangeValue,
  syncRangeProgress
} from "../../extension/ui/range-slider.js";

function mountSliderDom(attrs: { min?: number; max?: number; value?: number } = {}) {
  const min = attrs.min ?? 70;
  const max = attrs.max ?? 130;
  const value = attrs.value ?? 100;
  document.body.innerHTML = `
    <div>
      <input id="slider" type="range" min="${min}" max="${max}" value="${value}" />
      <span id="badge"></span>
      <button id="reset" type="button">重置</button>
    </div>
  `;
  return {
    input: document.getElementById("slider") as HTMLInputElement,
    badge: document.getElementById("badge") as HTMLElement,
    resetBtn: document.getElementById("reset") as HTMLButtonElement
  };
}

function clampScale(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 100;
  return Math.max(70, Math.min(130, Math.round(n)));
}

describe("range-slider", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("syncRangeProgress 与 initRangeSlider 计算并同步 --range-progress", () => {
    const { input } = mountSliderDom({ min: 0, max: 200, value: 50 });
    initRangeSlider(input);
    expect(input.style.getPropertyValue("--range-progress")).toBe("25%");

    input.value = "150";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.style.getPropertyValue("--range-progress")).toBe("75%");

    input.value = "200";
    syncRangeProgress(input);
    expect(input.style.getPropertyValue("--range-progress")).toBe("100%");
  });

  it("bindResettableRangeSlider：初始水合、input 预览、change 提交与 reset 完整闭环", () => {
    const { input, badge, resetBtn } = mountSliderDom({ min: 70, max: 130, value: 100 });
    const onPreview = vi.fn();
    const onCommit = vi.fn();

    const controller = bindResettableRangeSlider({
      input,
      badge,
      resetBtn,
      defaultValue: 100,
      normalize: clampScale,
      format: (v) => `${v}%`,
      initialValue: 115,
      onPreview,
      onCommit
    });

    expect(input.value).toBe("115");
    expect(input.style.getPropertyValue("--range-progress")).toBe("75%");
    expect(badge.textContent).toBe("115%");
    expect(resetBtn.disabled).toBe(false);
    expect(onPreview).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();

    // input 事件：归一化、刷新进度/徽标/重置态，触发 onPreview
    input.value = "130";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.style.getPropertyValue("--range-progress")).toBe("100%");
    expect(badge.textContent).toBe("130%");
    expect(resetBtn.disabled).toBe(false);
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenLastCalledWith(130);
    expect(onCommit).not.toHaveBeenCalled();

    // change 事件：触发 onCommit
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenLastCalledWith(130);

    // 点击重置：恢复默认值、同步 --range-progress、置灰重置键，并同时触发 onPreview 与 onCommit
    resetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(input.value).toBe("100");
    expect(input.style.getPropertyValue("--range-progress")).toBe("50%");
    expect(badge.textContent).toBe("100%");
    expect(resetBtn.disabled).toBe(true);
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onPreview).toHaveBeenLastCalledWith(100);
    expect(onCommit).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenLastCalledWith(100);

    // 外部 setValue / setResettableRangeValue：只更新 UI，不触发回调
    controller.setValue(85);
    expect(input.value).toBe("85");
    expect(input.style.getPropertyValue("--range-progress")).toBe("25%");
    expect(badge.textContent).toBe("85%");
    expect(resetBtn.disabled).toBe(false);

    setResettableRangeValue(input, 100);
    expect(input.value).toBe("100");
    expect(input.style.getPropertyValue("--range-progress")).toBe("50%");
    expect(badge.textContent).toBe("100%");
    expect(resetBtn.disabled).toBe(true);
    expect(onPreview).toHaveBeenCalledTimes(2);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("支持先 setResettableRangeValue 后 bindResettableRangeSlider 的水合顺序", () => {
    const { input, badge, resetBtn } = mountSliderDom({ min: 70, max: 130, value: 100 });

    setResettableRangeValue(input, 85);
    bindResettableRangeSlider({
      input,
      badge,
      resetBtn,
      defaultValue: 100,
      normalize: clampScale,
      format: (v) => `${v}%`
    });

    expect(input.value).toBe("85");
    expect(input.style.getPropertyValue("--range-progress")).toBe("25%");
    expect(badge.textContent).toBe("85%");
    expect(resetBtn.disabled).toBe(false);
  });

  it("重复调用 bindResettableRangeSlider 幂等，不叠加重复事件监听", () => {
    const { input, badge, resetBtn } = mountSliderDom({ min: 70, max: 130, value: 100 });
    const onPreview1 = vi.fn();
    const onCommit1 = vi.fn();
    const onPreview2 = vi.fn();
    const onCommit2 = vi.fn();

    bindResettableRangeSlider({
      input,
      badge,
      resetBtn,
      defaultValue: 100,
      normalize: clampScale,
      format: (v) => `${v}%`,
      onPreview: onPreview1,
      onCommit: onCommit1
    });

    bindResettableRangeSlider({
      input,
      badge,
      resetBtn,
      defaultValue: 100,
      normalize: clampScale,
      format: (v) => `${v}%`,
      onPreview: onPreview2,
      onCommit: onCommit2
    });

    input.value = "115";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPreview1).not.toHaveBeenCalled();
    expect(onCommit1).not.toHaveBeenCalled();
    expect(onPreview2).toHaveBeenCalledTimes(1);
    expect(onCommit2).toHaveBeenCalledTimes(1);

    resetBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onPreview2).toHaveBeenCalledTimes(2);
    expect(onCommit2).toHaveBeenCalledTimes(2);
  });
});
