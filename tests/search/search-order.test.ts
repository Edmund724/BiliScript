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
