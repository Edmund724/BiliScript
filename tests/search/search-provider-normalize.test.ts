// normalizeSearchProvider 测试：字段齐全 + type 合法值校验（spec §6，域归一化
// 收口）。与 normalizeAsrProvider 同契约：apiKey 不归列表，未知 type 丢弃。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { normalizeSearchProvider } from "../../extension/search/search-provider-normalize.js";

beforeEach(() => {
  resetModuleState();
});

describe("normalizeSearchProvider", () => {
  it("合法条目全字段归一：baseUrl 去尾斜杠、enabled 缺省 true", () => {
    expect(
      normalizeSearchProvider({
        id: "search_1",
        presetId: "tavily",
        name: "Tavily",
        type: "tavily",
        baseUrl: "https://api.tavily.com/",
        enabled: false
      })
    ).toEqual({
      id: "search_1",
      presetId: "tavily",
      name: "Tavily",
      type: "tavily",
      baseUrl: "https://api.tavily.com",
      enabled: false
    });
  });

  it("enabled 缺省为 true，name 缺省回落「自定义」", () => {
    const out = normalizeSearchProvider({ id: "search_2", type: "exa", baseUrl: "https://api.exa.ai" });
    expect(out?.enabled).toBe(true);
    expect(out?.name).toBe("自定义");
    expect(out?.presetId).toBe("custom");
  });

  it("未知 type 的条目丢弃（不做自定义预设，spec 非目标）", () => {
    expect(normalizeSearchProvider({ id: "x", type: "serpapi", baseUrl: "https://x" })).toBeNull();
    expect(normalizeSearchProvider({ id: "x", type: "", baseUrl: "https://x" })).toBeNull();
  });

  it("缺 id / 非对象输入返回 null", () => {
    expect(normalizeSearchProvider({ type: "tavily" })).toBeNull();
    expect(normalizeSearchProvider(null)).toBeNull();
    expect(normalizeSearchProvider("tavily")).toBeNull();
  });
});
