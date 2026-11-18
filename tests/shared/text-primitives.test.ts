import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findNearestTimedLineIndex,
  fnv1a32,
  getSharedZhWordSegmenter,
  truncateWithEllipsis
} from "../../extension/shared/text-primitives.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getSharedZhWordSegmenter", () => {
  it("在支持 Intl.Segmenter 的环境返回惰性单例并正确切分中英文词元", () => {
    const first = getSharedZhWordSegmenter();
    const second = getSharedZhWordSegmenter();

    expect(first).not.toBeNull();
    expect(first).toBe(second);

    const segments = Array.from(first!.segment("原生Intl.Segmenter分词"), (s) => s.segment);
    expect(segments.length).toBeGreaterThanOrEqual(3);
  });

  it("在 Intl.Segmenter 不可用时安全返回 null", () => {
    vi.stubGlobal("Intl", {});
    expect(getSharedZhWordSegmenter()).toBeNull();
  });
});

describe("fnv1a32", () => {
  it("未传 seed 时使用标准 FNV-1a 偏移基准 0x811c9dc5 并返回无符号 32 位整数", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("hello")).toBe(0x4f9f2cab);
    expect(fnv1a32("hello")).toBe(fnv1a32("hello"));
    expect(fnv1a32("hello")).not.toBe(fnv1a32("world"));
  });

  it("传入 seed 时以 (seed ^ 0x811c9dc5) >>> 0 起算并与不同 seed 区分", () => {
    const seedA = 0x9e3779b9;
    const seedB = 0x85ebca6b;

    expect(fnv1a32("", seedA)).toBe((seedA ^ 0x811c9dc5) >>> 0);
    expect(fnv1a32("conv_a1", seedA)).toBe(fnv1a32("conv_a1", seedA));
    expect(fnv1a32("conv_a1", seedA)).not.toBe(fnv1a32("conv_a1", seedB));
    expect(fnv1a32("conv_a1", 0)).toBe(fnv1a32("conv_a1"));
  });
});

describe("truncateWithEllipsis", () => {
  it("处理空值、零上限及未超长文本", () => {
    expect(truncateWithEllipsis(null, 10)).toBe("");
    expect(truncateWithEllipsis(undefined, 10)).toBe("");
    expect(truncateWithEllipsis("abcdef", 0)).toBe("");
    expect(truncateWithEllipsis("abcdef", -3)).toBe("");
    expect(truncateWithEllipsis("abcdef", 6)).toBe("abcdef");
    expect(truncateWithEllipsis("abcdef", 5)).toBe("abcd…");
    expect(truncateWithEllipsis("abcdef", 1)).toBe("…");
  });

  it("UTF-16 代理对安全截断：绝不劈开四字节字符产生孤立高代理项", () => {
    const withEmoji = "A😀B";
    const cutBeforeLowSurrogate = truncateWithEllipsis(withEmoji, 3);
    expect(cutBeforeLowSurrogate).toBe("A…");
    expect(cutBeforeLowSurrogate.length).toBeLessThanOrEqual(3);
    expect(() => encodeURIComponent(cutBeforeLowSurrogate)).not.toThrow();

    const doubleEmoji = "😀😀";
    expect(truncateWithEllipsis(doubleEmoji, 2)).toBe("…");
    expect(truncateWithEllipsis(doubleEmoji, 3)).toBe("😀…");
    expect(truncateWithEllipsis(doubleEmoji, 4)).toBe("😀😀");
  });

  it("singleLine 为 true 时先折叠换行与多余空白再裁剪", () => {
    const multiline = "  第一行\n\t  第二行   第三行  ";
    expect(truncateWithEllipsis(multiline, 20, { singleLine: true })).toBe("第一行 第二行 第三行");
    expect(truncateWithEllipsis(multiline, 7, { singleLine: true })).toBe("第一行 第二…");
  });
});

describe("findNearestTimedLineIndex", () => {
  const lines = [
    { from: 10, content: "开场介绍背景" },
    { from: 30, content: "讨论 FlashAttention 分块矩阵" },
    { from: 40, content: "过渡一句普通话" },
    { from: 95, content: "远端节点讨论 FlashAttention" }
  ];

  it("空数组或非法目标时间返回 -1", () => {
    expect(findNearestTimedLineIndex([], 10)).toBe(-1);
    expect(findNearestTimedLineIndex(lines, Number.NaN)).toBe(-1);
    expect(findNearestTimedLineIndex(lines, Number.POSITIVE_INFINITY)).toBe(-1);
  });

  it("未提供 scoreLine 时默认按时间距离最近匹配", () => {
    expect(findNearestTimedLineIndex(lines, 38)).toBe(2);
    expect(findNearestTimedLineIndex(lines, 12)).toBe(0);
  });

  it("支持 maxTimeDistanceSeconds 过滤超距候选并在全部超距时返回 -1", () => {
    expect(findNearestTimedLineIndex(lines, 65, { maxTimeDistanceSeconds: 20 })).toBe(-1);
    expect(
      findNearestTimedLineIndex(lines, 38, {
        maxTimeDistanceSeconds: 20,
        scoreLine: (line, dist) => (line.content.includes("FlashAttention") ? 100 : 0) - dist
      })
    ).toBe(1);
  });
});
