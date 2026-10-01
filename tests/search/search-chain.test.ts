// search/search-chain.ts 的链解析纯函数测试（spec §1 S1/S3/S4、§3 落点表第 8 行①）。
// 覆盖 resolveSearchChain：进组判据（access × 有无 Key）、预设表序 + 链首排序、
// 按记录 id 去重、脏 presetId / enabled 的保守排除、候选形状与纯函数不变式。
// 执行器 executeSearchChain / classifySearchFailure / SEARCH_CHAIN_BUDGET_MS 属
// 批次②（§10 第 16 行），届时在本文件邻域补链级预算与分类保序用例。
import { describe, expect, it } from "vitest";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import type { SearchProvider } from "../../extension/search/search-provider-normalize.js";
import { resolveSearchChain } from "../../extension/search/search-chain.js";

// 记录夹具：presetId 是链成员资格的唯一判据（spec §7「只挂预设表，记录不带副本」）。
const FIRECRAWL: SearchProvider = {
  id: "search_firecrawl",
  presetId: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  enabled: true
};
// 用户手加的同一家：生成式 id（ui/provider-row.ts），presetId 仍是 tavily
const TAVILY_USER: SearchProvider = {
  id: "tavily-picked",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};
const DOUBAO: SearchProvider = {
  id: "search_doubao",
  presetId: "doubao",
  name: "豆包",
  type: "doubao",
  baseUrl: "https://open.feedcoopapi.com",
  enabled: true
};
const ANYSEARCH: SearchProvider = {
  id: "search_anysearch",
  presetId: "anysearch",
  name: "AnySearch",
  type: "anysearch",
  baseUrl: "https://api.anysearch.com",
  enabled: true
};

function ids(chain: Array<{ provider: { id: string } }>): string[] {
  return chain.map((candidate) => candidate.provider.id);
}

describe("resolveSearchChain 回退链解析", () => {
  it("keyless 无 Key 无条件进候选（apiKey:''）；free-quota 无 Key 不进", () => {
    const chain = resolveSearchChain([DOUBAO, FIRECRAWL], {}, "", SEARCH_PROVIDER_PRESETS);

    expect(ids(chain)).toEqual(["search_firecrawl"]);
    expect(chain[0].apiKey).toBe("");
  });

  it("free-quota 有 Key 进候选，apiKey 取该记录自己的 Key", () => {
    const chain = resolveSearchChain(
      [DOUBAO, FIRECRAWL],
      { search_doubao: "db-key" },
      "",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["search_firecrawl", "search_doubao"]);
    expect(chain.map((candidate) => candidate.apiKey)).toEqual(["", "db-key"]);
  });

  it("空白 Key 视为无 Key（free-quota 不进候选）", () => {
    const chain = resolveSearchChain([DOUBAO], { search_doubao: "   " }, "", SEARCH_PROVIDER_PRESETS);

    expect(chain).toEqual([]);
  });

  it("排序 = 预设表顺序，与记录输入顺序无关", () => {
    const chain = resolveSearchChain(
      [ANYSEARCH, DOUBAO, TAVILY_USER, FIRECRAWL],
      { search_doubao: "db-key" },
      "",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["search_firecrawl", "tavily-picked", "search_doubao", "search_anysearch"]);
  });

  it("activeId 指向的在组记录排链首，链首不重复出现", () => {
    const chain = resolveSearchChain(
      [ANYSEARCH, TAVILY_USER, FIRECRAWL],
      {},
      "search_anysearch",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["search_anysearch", "search_firecrawl", "tavily-picked"]);
  });

  it("activeId 为空或悬空（不存在 / 不在组）→ 无链首，严格按预设表顺序", () => {
    for (const activeId of ["", null, undefined, "search_missing", "search_doubao"]) {
      const chain = resolveSearchChain([FIRECRAWL, TAVILY_USER, DOUBAO], {}, activeId, SEARCH_PROVIDER_PRESETS);

      expect(ids(chain)).toEqual(["search_firecrawl", "tavily-picked"]);
    }
  });

  it("presetId 查不到预设表（脏值 / 未知）→ 不进候选（最保守）", () => {
    const orphan: SearchProvider = {
      id: "search_orphan",
      presetId: "brave",
      name: "Brave",
      type: "tavily",
      baseUrl: "https://api.search.brave.com",
      enabled: true
    };

    const chain = resolveSearchChain([orphan, FIRECRAWL], {}, "", SEARCH_PROVIDER_PRESETS);

    expect(ids(chain)).toEqual(["search_firecrawl"]);
  });

  it("enabled === false 的记录不进候选（含链首指向它的情形）", () => {
    const disabled: SearchProvider = { ...FIRECRAWL, enabled: false };
    const chain = resolveSearchChain([disabled, TAVILY_USER], {}, "search_firecrawl", SEARCH_PROVIDER_PRESETS);

    expect(ids(chain)).toEqual(["tavily-picked"]);
  });

  it("按记录 id 去重（重复记录只留一条）", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, { ...FIRECRAWL }, TAVILY_USER],
      {},
      "search_firecrawl",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["search_firecrawl", "tavily-picked"]);
  });

  it("候选形状 = { provider:{id,name,type,baseUrl}, apiKey }，且不改写入参与 keys", () => {
    const records = [FIRECRAWL, DOUBAO];
    const keys = { search_doubao: "db-key" };
    const before = JSON.stringify({ records, keys });

    const chain = resolveSearchChain(records, keys, "", SEARCH_PROVIDER_PRESETS);

    expect(chain[0]).toEqual({
      provider: {
        id: "search_firecrawl",
        name: "Firecrawl",
        type: "firecrawl",
        baseUrl: "https://api.firecrawl.dev"
      },
      apiKey: ""
    });
    expect(JSON.stringify({ records, keys })).toBe(before);
  });
});
