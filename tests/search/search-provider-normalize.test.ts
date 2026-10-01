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

  it("预设目录六家平台按链序（Firecrawl 起头）登记 id/name/type/baseUrl/access/note", async () => {
    const { SEARCH_PROVIDER_PRESETS, DEFAULT_SEARCH_PROVIDER_PRESET } = await import("../../extension/core/presets.js");
    expect(SEARCH_PROVIDER_PRESETS.map((p) => [p.id, p.name, p.type, p.baseUrl, p.access, p.note])).toEqual([
      ["firecrawl", "Firecrawl", "firecrawl", "https://api.firecrawl.dev", "keyless", undefined],
      ["tavily", "Tavily", "tavily", "https://api.tavily.com", "keyless", undefined],
      ["doubao", "豆包", "doubao", "https://open.feedcoopapi.com", "free-quota", "每月 500 次免费（需在火山控制台申请 Key）"],
      ["anysearch", "AnySearch", "anysearch", "https://api.anysearch.com", "keyless", undefined],
      ["parallel", "Parallel", "parallel", "https://search.parallel.ai", "keyless", undefined],
      ["exa", "Exa", "exa", "https://api.exa.ai", "free-quota", "每月 $10 赠送额度（新账户另赠 $10）"]
    ]);
    // 单源关系（spec §1 S3）：兜底预设恒等于表首项
    expect(DEFAULT_SEARCH_PROVIDER_PRESET).toBe(SEARCH_PROVIDER_PRESETS[0]);
  });
});
