// search/search-adapters.ts 注册表对账测试：键集与 SearchProviderType 词表
// （SEARCH_PROVIDER_PRESETS 的 type 集）一致；每个 adapter 的 type 自陈与所在键
// 相同；resolveSearchAdapter 对未知 / 非字符串值兜底 tavily（对齐
// resolveAdapter 的 openai 兜底语义）。

import { describe, expect, it } from "vitest";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import { SEARCH_ADAPTERS, resolveSearchAdapter } from "../../extension/search/search-adapters.js";

describe("SEARCH_ADAPTERS 注册表", () => {
  it("键集与 SEARCH_PROVIDER_PRESETS 的 type 集一致（加第 4 家 = adapter + 登记一行）", () => {
    const presetTypes = SEARCH_PROVIDER_PRESETS.map((preset) => preset.type).sort();
    expect(Object.keys(SEARCH_ADAPTERS).sort()).toEqual(presetTypes);
  });

  it("每个 adapter 的 type 自陈与所在键一致（登记错位在测试期即暴露）", () => {
    for (const [key, adapter] of Object.entries(SEARCH_ADAPTERS)) {
      expect(adapter.type).toBe(key);
      expect(typeof adapter.name).toBe("string");
      expect(adapter.name.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSearchAdapter", () => {
  it("已知 type：返回对应 adapter", () => {
    expect(resolveSearchAdapter("exa")).toBe(SEARCH_ADAPTERS.exa);
  });

  it("未知 / 非字符串值：兜底 tavily（行为零变化）", () => {
    expect(resolveSearchAdapter("unknown")).toBe(SEARCH_ADAPTERS.tavily);
    expect(resolveSearchAdapter(null)).toBe(SEARCH_ADAPTERS.tavily);
    expect(resolveSearchAdapter(undefined)).toBe(SEARCH_ADAPTERS.tavily);
  });
});
