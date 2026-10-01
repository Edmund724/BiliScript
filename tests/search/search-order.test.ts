// tests/search/search-order.test.ts
// search/search-order.ts（零依赖叶，票 15 Q1-a）测试（spec §12.2 / §10 第 63–65 行）：
//   ① normalizeSearchProviderOrder——searchProviderOrder 归一（非数组 / 元素非字符串
//      或空串 / 未知 id / 重复 id → 整体作废 []）。用例原在 search-chain.test.ts
//      （归一实现搬入本叶后用例随属主迁移，断言逐条不变）；
//   ② providerOrderRank——链解析侧（search-chain）与设置列表侧（settings-panel）
//      共用的排序键：[order 下标 | +Infinity, 内置默认序下标 | 默认序长度]。
//      本组用例是「键规则唯一实现」的锚：两侧消费形态不同（链侧还带去重 / 冷却 /
//      单选短路，列表侧不过是滤不去重），但键的算法只此一份。
//   ③ 叶纪律：运行时相对 import 只允许 core/presets.js——多了任何一条都意味着
//      设置抽屉的懒 chunk 可能重新挂上搜索适配器边（票 15 Q2-a 的收益被撤销）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_PROVIDER_ORDER } from "../../extension/core/presets.js";
import {
  normalizeSearchProviderOrder,
  providerOrderRank
} from "../../extension/search/search-order.js";

describe("normalizeSearchProviderOrder 归一（spec §12.2 / §10 第 65 行）", () => {
  const KNOWN = ["tavily-picked", "search_firecrawl"];

  it("数组内全为已知记录 id → 原样返回（空数组 = 无自定义顺序）", () => {
    expect(normalizeSearchProviderOrder(["search_firecrawl", "tavily-picked"], KNOWN)).toEqual([
      "search_firecrawl",
      "tavily-picked"
    ]);
    expect(normalizeSearchProviderOrder([], KNOWN)).toEqual([]);
  });

  it("非数组（含 null / undefined / 字符串 / 对象）→ 整体作废 []", () => {
    for (const raw of [null, undefined, "tavily-picked", 7, { 0: "tavily-picked" }]) {
      expect(normalizeSearchProviderOrder(raw, KNOWN)).toEqual([]);
    }
  });

  it("元素非字符串 / 空串 / 空白串 → 整体作废 []", () => {
    for (const raw of [["tavily-picked", 7], ["tavily-picked", ""], ["tavily-picked", "   "], ["tavily-picked", null]]) {
      expect(normalizeSearchProviderOrder(raw, KNOWN)).toEqual([]);
    }
  });

  it("含未知 id（不在当前记录集合中）→ 整体作废 []，不部分采纳", () => {
    expect(normalizeSearchProviderOrder(["tavily-picked", "search_ghost"], KNOWN)).toEqual([]);
    expect(normalizeSearchProviderOrder(["search_ghost"], KNOWN)).toEqual([]);
  });

  it("含重复 id → 整体作废 []", () => {
    expect(normalizeSearchProviderOrder(["tavily-picked", "tavily-picked"], KNOWN)).toEqual([]);
  });
});

describe("providerOrderRank 排序键（spec §12.2 / §10 第 63–65 行）", () => {
  it("在 order 中 → [order 下标, 预设默认序下标]（首键即用户拖拽位次）", () => {
    expect(providerOrderRank("search_tavily", "tavily", ["search_tavily", "search_exa"])).toEqual([0, 2]);
    expect(providerOrderRank("search_exa", "exa", ["search_tavily", "search_exa"])).toEqual([1, 0]);
  });

  it("不在 order 中 → 首键 +Infinity（排到所有在组记录之后），次键仍按内置默认序", () => {
    expect(providerOrderRank("search_exa", "exa", ["search_tavily"])).toEqual([
      Number.POSITIVE_INFINITY,
      0
    ]);
    // 空 order（无自定义顺序 / 归一整体作废）= 全部取首哨兵 → 纯内置默认序
    expect(providerOrderRank("search_parallel", "parallel", [])).toEqual([
      Number.POSITIVE_INFINITY,
      DEFAULT_SEARCH_PROVIDER_ORDER.indexOf("parallel")
    ]);
  });

  it("presetId 不在内置默认序中 → 次键 = 默认序长度（排到已知预设之后）", () => {
    expect(providerOrderRank("picked", "custom", ["search_tavily"])).toEqual([
      Number.POSITIVE_INFINITY,
      DEFAULT_SEARCH_PROVIDER_ORDER.length
    ]);
  });

  it("双哨兵同取（记录不在 order、presetId 不在内置默认序）", () => {
    expect(providerOrderRank("picked-2", "unknown-preset", [])).toEqual([
      Number.POSITIVE_INFINITY,
      DEFAULT_SEARCH_PROVIDER_ORDER.length
    ]);
  });
});

describe("零依赖叶纪律（票 15 Q1-a）", () => {
  it("search-order.ts 的运行时相对 import 只有 core/presets.js", () => {
    const source = readFileSync(join(process.cwd(), "extension/search/search-order.ts"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );
    const specs = [
      ...source.matchAll(/(?:^|\n)[ \t]*(?:import|export)\s+([^;]*?)\s+from\s*["'](\.[^"']+)["']/g)
    ]
      .filter((match) => !/^\s*type\b/.test(match[1]) && !/^\{\s*type\s/.test(match[1]))
      .map((match) => match[2]);
    expect(specs).toEqual(["../core/presets.js"]);
  });
});
