// tests/ui/model-select-width.test.js
// model-select-width.js（候选09 自 sidepanel.js 迁出的纯 UI 度量叶子）的小
// 契约测试。工单 arch-review-2026-09/10 起模块自 ui/ 搬入 chat/（断 chat → ui
// 最后一条逻辑边），本测试留守 tests/ui/ 不随迁（scope 之外），仅改 import。
// 发送框重构起度量对象从原生 select 换成模型 chip：宽度写在 chip 上，文本源
// 是 chip 内的模型名 + 档位两个 span（拼接测量），宽度语义 = hug content：
// 按内容自适应夹在 [92, 260]（260 只防极端长名；溢出截断由 CSS 施加在模型名
// span 上，档位与 chevron 恒完整，度量不参与截断）。
// jsdom 不带 canvas npm 包，HTMLCanvasElement.getContext 返回 null
// （已实测：打印 "Not implemented" 通知但不抛错），恰好覆盖模块内既有的
// 降级路径（!ctx → 每字符 8px 估算），据此守住三个关键不变量：
// - 降级测宽下的期望宽度算式（文本 8px/字符 + "000" 24 + 36 装饰余量）；
// - [92, maxWidth] 区间夹取（短文案触底 92、长文案被上限截断）；
// - 文案缺失时回落「未配置平台」参与测量。
// getContext 显式 mock 为 null：不依赖 jsdom 版本的 canvas 行为，也消除
// "Not implemented" 的控制台噪音。260 上限用例：模型名 30 字符 + 档位 Off
// 拼接 34 字符 → 34×8 + 24 + 36 = 332 > 260 截断。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  measureTextWidth,
  scheduleModelSelectWidthUpdate,
  updateModelSelectWidth
} from "../../extension/chat/model-select-width.js";

beforeEach(() => {
  vi.spyOn(window.HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeChip(modelText, levelText = "Off") {
  const chip = document.createElement("button");
  const chipModel = document.createElement("span");
  const chipLevel = document.createElement("span");
  if (modelText !== undefined) {
    chipModel.textContent = modelText;
  }
  chipLevel.textContent = levelText;
  chip.append(chipModel, chipLevel);
  return { chip, chipModel, chipLevel };
}

function makeEls(modelText, levelText = "Off") {
  const { chip, chipModel, chipLevel } = makeChip(modelText, levelText);
  return { chip, chipModel, chipLevel };
}

describe("model-select-width", () => {
  it("measureTextWidth：canvas 不可用时按每字符 8px 降级估算", () => {
    expect(measureTextWidth("000", { fontSize: "11px" })).toBe(24);
    expect(measureTextWidth("", { fontSize: "11px" })).toBe(0);
  });

  it("updateModelSelectWidth：chip 缺失时直接返回，不写样式", () => {
    const els = { chip: null, chipModel: null, chipLevel: null };
    expect(() => updateModelSelectWidth(els)).not.toThrow();
  });

  it("updateModelSelectWidth：模型名 + 档位拼接测宽（「AI Off」= 6 字符 → 108px）", () => {
    const els = makeEls("AI"); // 6×8 + 24 + 36 = 108
    updateModelSelectWidth(els);
    expect(els.chip.style.width).toBe("108px");
  });

  it("updateModelSelectWidth：按内容自适应（hug content），模型名短 chip 就窄", () => {
    const els = makeEls("M"); // (1+1+3)×8 + 24 + 36 = 100
    updateModelSelectWidth(els);
    expect(els.chip.style.width).toBe("100px");
  });

  it("updateModelSelectWidth：无档位文本时不拼空格（「AI」= 2 字符 → 触底 92px）", () => {
    const els = makeEls("AI", ""); // 2×8 + 24 + 36 = 76 < 92
    updateModelSelectWidth(els);
    expect(els.chip.style.width).toBe("92px");
  });

  it("updateModelSelectWidth：极端长名被 260 上限截断（hug content 的保险）", () => {
    const els = makeEls("x".repeat(30)); // (30+1+3)×8 + 24 + 36 = 332 > 260
    updateModelSelectWidth(els);
    expect(els.chip.style.width).toBe("260px");
  });

  it("updateModelSelectWidth：chip 文案缺失时回落「未配置平台」参与测量", () => {
    const els = makeEls(undefined, ""); // 5×8 + 24 + 36 = 100
    updateModelSelectWidth(els);
    expect(els.chip.style.width).toBe("100px");
  });
});

// P2-3：resize 路径的 rAF 合帧。一帧内重复调度只落一帧，且写宽度发生在帧
// 回调里（合帧期内不写样式）；结果与直接调用 updateModelSelectWidth 逐字一致。
describe("scheduleModelSelectWidthUpdate（rAF 合帧）", () => {
  function installFakeRaf() {
    const pending = new Map();
    let nextId = 0;
    const original = window.requestAnimationFrame;
    const originalCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb) => {
      nextId += 1;
      pending.set(nextId, cb);
      return nextId;
    };
    window.cancelAnimationFrame = (id) => pending.delete(id);
    return {
      pending,
      flush() {
        const entries = [...pending.entries()];
        entries.forEach(([id, cb]) => {
          pending.delete(id);
          cb(0);
        });
      },
      restore() {
        window.requestAnimationFrame = original;
        window.cancelAnimationFrame = originalCancel;
      }
    };
  }

  it("一帧内多次调度只排一帧，帧回调才写宽度", () => {
    const raf = installFakeRaf();
    try {
      const els = makeEls("AI");
      scheduleModelSelectWidthUpdate(els);
      scheduleModelSelectWidthUpdate(els);
      scheduleModelSelectWidthUpdate(els);
      expect(raf.pending.size).toBe(1);
      expect(els.chip.style.width).toBe(""); // 合帧期内不写

      raf.flush();
      expect(els.chip.style.width).toBe("108px"); // 与同步调用同结果
    } finally {
      raf.restore();
    }
  });

  it("同帧重复调度以最后一次传入的 els 为准", () => {
    const raf = installFakeRaf();
    try {
      const first = makeEls("AI"); // 108px（"AI Off"）
      const second = makeEls("x".repeat(30)); // 截断 260
      scheduleModelSelectWidthUpdate(first);
      scheduleModelSelectWidthUpdate(second);
      raf.flush();

      expect(first.chip.style.width).toBe("");
      expect(second.chip.style.width).toBe("260px");
    } finally {
      raf.restore();
    }
  });
});
