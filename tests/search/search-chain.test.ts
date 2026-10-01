// search/search-chain.ts 测试（spec §1 S1/S4/S6-S8、§3 落点表第 8 行、§6.4、§12.1–§12.3、
// §10 第 59–67、83 行）。
// 覆盖 resolveSearchChain 的两模式：
//   ① 单选（activeId = 记录 id）= 独苗链，无回退；悬空按空处理走智能链；进组判据不变
//      （free-quota 无 Key 不进 → 单选它得到空链，走既有「未配置」路径）；
//   ② 智能（哨兵 / 空串）= 全部在组记录按「归一 order 下标 > 内置默认序
//      DEFAULT_SEARCH_PROVIDER_ORDER」排序 → 同 presetId 取排序最靠前的合格记录
//      → 剔除 cooldownUntil[presetId] > now 的引擎（单选不消费冷却）。
// 另覆盖 normalizeSearchProviderOrder 的脏值整体作废（非数组 / 元素非字符串或空串 /
// 未知 id / 重复 id → []）与候选形状（provider 增 presetId）。
// 执行器面：classifySearchFailure 的三等映射（§6.4 / §10 第 44/45 行）、
// executeSearchChain 的顺序回退 / 失败静默保序 / 额度与其余两类终态文案 /
// 链级预算 30s（§4 / §10 第 16 行）/ 调用方中止出口。时间一律走 fake timers 或
// 注入桩，不测真实网络与墙钟（§10 非断言节）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SEARCH_PROVIDER_ORDER, SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import { SMART_SEARCH_ACTIVE_ID } from "../../extension/core/search-mode.js";
import type { SearchProvider } from "../../extension/search/search-provider-normalize.js";
import { parseDoubaoSearchResponse } from "../../extension/search/adapters/doubao.js";
import {
  SEARCH_CHAIN_BUDGET_MS,
  classifySearchFailure,
  executeSearchChain,
  normalizeSearchProviderOrder,
  resolveSearchChain,
  type SearchChainCandidate,
  type SearchChainError,
  type SearchChainOptions
} from "../../extension/search/search-chain.js";

// 记录夹具：presetId 是链成员资格的唯一判据（spec §7「只挂预设表，记录不带副本」）。
const FIRECRAWL: SearchProvider = {
  id: "search_firecrawl",
  presetId: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  enabled: true
};
// 用户手加的同一家：生成式 id（ui/provider-row.ts），presetId 仍是 firecrawl
const FIRECRAWL_USER: SearchProvider = {
  id: "firecrawl-picked",
  presetId: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
  enabled: true
};
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
const PARALLEL: SearchProvider = {
  id: "search_parallel",
  presetId: "parallel",
  name: "Parallel",
  type: "parallel",
  baseUrl: "https://search.parallel.ai",
  enabled: true
};
const EXA: SearchProvider = {
  id: "search_exa",
  presetId: "exa",
  name: "Exa",
  type: "exa",
  baseUrl: "https://api.exa.ai",
  enabled: true
};

// options 夹具：mode 由消费方（background 的 resolveSearchMode）给出，纯函数不自己取时间。
function smart(overrides: Partial<SearchChainOptions> = {}): SearchChainOptions {
  return { mode: "smart", order: [], cooldownUntil: {}, now: 0, ...overrides };
}
function single(overrides: Partial<SearchChainOptions> = {}): SearchChainOptions {
  return { mode: "single", order: [], cooldownUntil: {}, now: 0, ...overrides };
}

function ids(chain: Array<{ provider: { id: string } }>): string[] {
  return chain.map((candidate) => candidate.provider.id);
}

describe("链序常量（spec §12.2 / §10 第 63 行）", () => {
  it("DEFAULT_SEARCH_PROVIDER_ORDER = Exa → 豆包 → Tavily → Firecrawl → AnySearch → Parallel，且 ≠ 预设表序", () => {
    expect(DEFAULT_SEARCH_PROVIDER_ORDER).toEqual([
      "exa",
      "doubao",
      "tavily",
      "firecrawl",
      "anysearch",
      "parallel"
    ]);
    // 表序只管预设目录（Firecrawl 起头），不再是链序
    expect(DEFAULT_SEARCH_PROVIDER_ORDER).not.toEqual(SEARCH_PROVIDER_PRESETS.map((preset) => preset.id));
  });
});

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

describe("resolveSearchChain 单选模式（spec §12.1 / §10 第 59 行）", () => {
  it("chain 只含 activeId 那一条记录（无回退），apiKey 取该记录自己的", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, TAVILY_USER],
      { "tavily-picked": "tvly-k" },
      "tavily-picked",
      SEARCH_PROVIDER_PRESETS,
      single()
    );

    expect(ids(chain)).toEqual(["tavily-picked"]);
    expect(chain[0].apiKey).toBe("tvly-k");
  });

  it("单选不消费冷却（尊重用户明示选择，§12.4 第 5 条）", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, TAVILY_USER],
      { "tavily-picked": "tvly-k" },
      "tavily-picked",
      SEARCH_PROVIDER_PRESETS,
      single({ cooldownUntil: { tavily: 9_999_999_999 }, now: 1 })
    );

    expect(ids(chain)).toEqual(["tavily-picked"]);
  });

  it("单选选了未配 Key 的 free-quota → chain 空（收口裁定 2，走既有「未配置」路径）", () => {
    const chain = resolveSearchChain(
      [DOUBAO, TAVILY_USER],
      {},
      "search_doubao",
      SEARCH_PROVIDER_PRESETS,
      single()
    );

    expect(chain).toEqual([]);
  });

  it("单选选了 enabled:false 的记录 → chain 空（进组判据不变）", () => {
    const disabled: SearchProvider = { ...TAVILY_USER, enabled: false };
    const chain = resolveSearchChain([disabled], {}, "tavily-picked", SEARCH_PROVIDER_PRESETS, single());

    expect(chain).toEqual([]);
  });

  it("单选 + activeId 悬空（不存在记录）→ 按空处理走智能链（§6.8 / §10 第 82 行）", () => {
    const chain = resolveSearchChain(
      [TAVILY_USER, FIRECRAWL],
      {},
      "search_ghost",
      SEARCH_PROVIDER_PRESETS,
      single()
    );

    expect(ids(chain)).toEqual(["tavily-picked", "search_firecrawl"]);
  });

  it("单选链（单候选）失败即抛：执行器只调一次、无第二次（§10 第 59 行）", async () => {
    const chain = resolveSearchChain([FIRECRAWL, TAVILY_USER], {}, "search_firecrawl", SEARCH_PROVIDER_PRESETS, single());
    const calls: string[] = [];

    const error = (await executeSearchChain(chain, "q", {
      execute: async (candidate) => {
        calls.push(candidate.provider.id);
        throw httpError(503);
      }
    }).catch((thrown) => thrown)) as SearchChainError;

    expect(calls).toEqual(["search_firecrawl"]);
    expect(error.failures).toEqual(["other"]);
    expect(error.message).toBe("HTTP 503");
  });
});

describe("resolveSearchChain 智能模式（spec §12.2 / §10 第 61–64 行）", () => {
  it("无自定义 order → 全部在组记录按内置默认序（free-quota 无 Key 跳过）", () => {
    const chain = resolveSearchChain(
      [ANYSEARCH, PARALLEL, FIRECRAWL, TAVILY_USER, EXA, DOUBAO],
      { search_doubao: "db-key" },
      "",
      SEARCH_PROVIDER_PRESETS,
      smart()
    );

    expect(ids(chain)).toEqual([
      "search_doubao",
      "tavily-picked",
      "search_firecrawl",
      "search_anysearch",
      "search_parallel"
    ]);
  });

  it("哨兵与空串同解（都是智能链）", () => {
    const records = [ANYSEARCH, TAVILY_USER];
    expect(ids(resolveSearchChain(records, {}, SMART_SEARCH_ACTIVE_ID, SEARCH_PROVIDER_PRESETS, smart()))).toEqual([
      "tavily-picked",
      "search_anysearch"
    ]);
    expect(ids(resolveSearchChain(records, {}, "", SEARCH_PROVIDER_PRESETS, smart()))).toEqual([
      "tavily-picked",
      "search_anysearch"
    ]);
  });

  it("chain 顺序 = 归一 order 顺序，逐项相等（§10 第 61 行）", () => {
    const chain = resolveSearchChain(
      [TAVILY_USER, FIRECRAWL, ANYSEARCH, PARALLEL],
      {},
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ order: ["search_parallel", "search_firecrawl", "tavily-picked", "search_anysearch"] })
    );

    expect(ids(chain)).toEqual(["search_parallel", "search_firecrawl", "tavily-picked", "search_anysearch"]);
  });

  it("不在 order 里的记录排到数组内记录之后，相互之间按内置默认序（§10 第 62 行）", () => {
    const chain = resolveSearchChain(
      [ANYSEARCH, FIRECRAWL, TAVILY_USER, PARALLEL],
      {},
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ order: ["tavily-picked"] })
    );

    expect(ids(chain)).toEqual(["tavily-picked", "search_firecrawl", "search_anysearch", "search_parallel"]);
  });

  it("脏 order（未知 id）→ 整体作废回落到内置默认序（§10 第 65 行）", () => {
    const chain = resolveSearchChain(
      [TAVILY_USER, FIRECRAWL],
      {},
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ order: ["search_ghost", "tavily-picked"] })
    );

    expect(ids(chain)).toEqual(["tavily-picked", "search_firecrawl"]);
  });

  it("同 presetId 多记录：链代表 = 排序最靠前的合格记录（其 Key 生效），该家只入链一次（§10 第 64 行）", () => {
    const keys = { search_firecrawl: "auto-key", "firecrawl-picked": "user-key" };
    const userFirst = resolveSearchChain(
      [FIRECRAWL, FIRECRAWL_USER, TAVILY_USER],
      keys,
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ order: ["firecrawl-picked", "search_firecrawl"] })
    );
    const autoFirst = resolveSearchChain(
      [FIRECRAWL, FIRECRAWL_USER, TAVILY_USER],
      keys,
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ order: ["search_firecrawl", "firecrawl-picked"] })
    );

    expect(ids(userFirst)).toEqual(["firecrawl-picked", "tavily-picked"]);
    expect(userFirst[0].apiKey).toBe("user-key");
    expect(ids(autoFirst)).toEqual(["search_firecrawl", "tavily-picked"]);
    expect(autoFirst[0].apiKey).toBe("auto-key");
  });

  it("同 presetId 两条都不在 order 里 → 代表 = 输入顺序首条（稳定排序保输入序）", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, FIRECRAWL_USER],
      { search_firecrawl: "auto-key", "firecrawl-picked": "user-key" },
      "",
      SEARCH_PROVIDER_PRESETS,
      smart()
    );

    expect(ids(chain)).toEqual(["search_firecrawl"]);
    expect(chain[0].apiKey).toBe("auto-key");
  });
});

describe("resolveSearchChain 进组判据与冷却（spec §2 / §12.4 / §10 第 66–67 行）", () => {
  it("keyless 无 Key 无条件进候选（apiKey:''）；free-quota 无 Key 不进", () => {
    const chain = resolveSearchChain([DOUBAO, FIRECRAWL], {}, "", SEARCH_PROVIDER_PRESETS, smart());

    expect(ids(chain)).toEqual(["search_firecrawl"]);
    expect(chain[0].apiKey).toBe("");
  });

  it("free-quota 有 Key 进候选，apiKey 取该记录自己的 Key；空白 Key 视为无 Key", () => {
    const withKey = resolveSearchChain(
      [DOUBAO, FIRECRAWL],
      { search_doubao: "db-key" },
      "",
      SEARCH_PROVIDER_PRESETS,
      smart()
    );
    const blankKey = resolveSearchChain(
      [DOUBAO],
      { search_doubao: "   " },
      "",
      SEARCH_PROVIDER_PRESETS,
      smart()
    );

    expect(ids(withKey)).toEqual(["search_doubao", "search_firecrawl"]);
    expect(withKey[0].apiKey).toBe("db-key");
    expect(blankKey).toEqual([]);
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

    const chain = resolveSearchChain([orphan, FIRECRAWL], {}, "", SEARCH_PROVIDER_PRESETS, smart());

    expect(ids(chain)).toEqual(["search_firecrawl"]);
  });

  it("enabled === false 的记录不进候选（智能链与单选链同判据）", () => {
    const disabled: SearchProvider = { ...FIRECRAWL, enabled: false };
    const smartChain = resolveSearchChain([disabled, TAVILY_USER], {}, "", SEARCH_PROVIDER_PRESETS, smart());
    const singleChain = resolveSearchChain(
      [disabled, TAVILY_USER],
      {},
      "search_firecrawl",
      SEARCH_PROVIDER_PRESETS,
      single()
    );

    expect(ids(smartChain)).toEqual(["tavily-picked"]);
    expect(singleChain).toEqual([]);
  });

  it("智能：cooldownUntil[presetId] > now 的引擎全部记录跳过；now ≥ cooldownUntil 回链（§10 第 66 行）", () => {
    const records = [FIRECRAWL, FIRECRAWL_USER, TAVILY_USER, ANYSEARCH];
    const cooled = resolveSearchChain(
      records,
      {},
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ cooldownUntil: { firecrawl: 2000 }, now: 1000 })
    );
    const expired = resolveSearchChain(
      records,
      {},
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ cooldownUntil: { firecrawl: 1000 }, now: 1000 })
    );

    expect(ids(cooled)).toEqual(["tavily-picked", "search_anysearch"]);
    expect(ids(expired)).toEqual(["tavily-picked", "search_firecrawl", "search_anysearch"]);
  });

  it("全部引擎冷却 → chain === []（§10 第 67 行，调用方走既有「未配置」路径）", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, TAVILY_USER],
      {},
      "",
      SEARCH_PROVIDER_PRESETS,
      smart({ cooldownUntil: { firecrawl: 5000, tavily: 5000 }, now: 1000 })
    );

    expect(chain).toEqual([]);
  });

  it("候选形状 = { provider:{id,presetId,name,type,baseUrl}, apiKey }，且不改写入参（§1 S4）", () => {
    const records = [FIRECRAWL, DOUBAO];
    const keys = { search_doubao: "db-key" };
    const order = ["search_firecrawl"];
    const cooldownUntil = { firecrawl: 0 };
    const before = JSON.stringify({ records, keys, order, cooldownUntil });

    const chain = resolveSearchChain(records, keys, "", SEARCH_PROVIDER_PRESETS, smart({ order, cooldownUntil, now: 1 }));

    expect(chain[0]).toEqual({
      provider: {
        id: "search_firecrawl",
        presetId: "firecrawl",
        name: "Firecrawl",
        type: "firecrawl",
        baseUrl: "https://api.firecrawl.dev"
      },
      apiKey: ""
    });
    expect(JSON.stringify({ records, keys, order, cooldownUntil })).toBe(before);
  });
});

// ===== 执行器面（spec §4 / §6.4 / §10 第 16、42–45 行）=====

const RESULT = { title: "t", url: "https://example.com", snippet: "s" };

// 链候选夹具（= ResolveSearchProviderResponse.chain 的元素，S4 单一形状）。
const FIRECRAWL_CHAIN: SearchChainCandidate = {
  provider: {
    id: "search_firecrawl",
    presetId: "firecrawl",
    name: "Firecrawl",
    type: "firecrawl",
    baseUrl: "https://api.firecrawl.dev"
  },
  apiKey: ""
};
const TAVILY_CHAIN: SearchChainCandidate = {
  provider: {
    id: "tavily-picked",
    presetId: "tavily",
    name: "Tavily",
    type: "tavily",
    baseUrl: "https://api.tavily.com"
  },
  apiKey: "tvly-k"
};

// 既有 executor 的失败形状：!response.ok 时抛 `HTTP <status>` 并附 status。
function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

// 豆包 HTTP 200 信封错误：经真实适配器 parse 抛出（带 providerCode）。
function doubaoEnvelopeError(error: Record<string, unknown>): unknown {
  try {
    parseDoubaoSearchResponse({ ResponseMetadata: { Error: error }, Result: { WebResults: [] } });
  } catch (thrown) {
    return thrown;
  }
  throw new Error("豆包信封错误未被适配器抛出");
}

function rejectMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

describe("classifySearchFailure 失败分类（§6.4 唯一映射表）", () => {
  it("HTTP 402 / 429 → 额度类", () => {
    for (const status of [402, 429]) {
      expect(classifySearchFailure(httpError(status))).toBe("quota");
    }
  });

  it("HTTP 401 / 403 → 鉴权类", () => {
    for (const status of [401, 403]) {
      expect(classifySearchFailure(httpError(status))).toBe("auth");
    }
  });

  it("providerCode 额度码（10406 / 10407 / 700429，字符串与数字都认）→ 额度类", () => {
    for (const providerCode of ["10406", "10407", "700429", 10406, 10407, 700429]) {
      expect(classifySearchFailure(Object.assign(new Error("豆包信封"), { providerCode }))).toBe("quota");
    }
  });

  it("providerCode 鉴权码（700901 / 10403，字符串与数字都认）→ 鉴权类", () => {
    for (const providerCode of ["700901", "10403", 700901, 10403]) {
      expect(classifySearchFailure(Object.assign(new Error("豆包信封"), { providerCode }))).toBe("auth");
    }
  });

  it("超时 / 网络 / 5xx / 形状 4xx / 解析失败 / 非 Error → 其余类", () => {
    expect(classifySearchFailure(new Error("请求超时，请检查 baseUrl 或稍后重试"))).toBe("other");
    expect(classifySearchFailure(new Error("Failed to fetch"))).toBe("other");
    for (const status of [500, 502, 503, 400, 404, 422]) {
      expect(classifySearchFailure(httpError(status))).toBe("other");
    }
    expect(classifySearchFailure(new Error("搜索响应解析失败：Unexpected token"))).toBe("other");
    expect(classifySearchFailure(undefined)).toBe("other");
    expect(classifySearchFailure("boom")).toBe("other");
    expect(classifySearchFailure(Object.assign(new Error("x"), { providerCode: "999999" }))).toBe("other");
  });

  it("豆包 HTTP 200 信封码经真实适配器 parse → 分类映射（§10 第 45 行）", () => {
    for (const code of ["10406", "10407", "700429"]) {
      expect(classifySearchFailure(doubaoEnvelopeError({ Code: code, Message: "quota" }))).toBe("quota");
    }
    for (const code of ["700901", "10403"]) {
      expect(classifySearchFailure(doubaoEnvelopeError({ CodeN: code }))).toBe("auth");
    }
    // Code / CodeN 双查：Code 无效（"0"）时落 CodeN，数字码也认
    expect(classifySearchFailure(doubaoEnvelopeError({ Code: "0", CodeN: 10406 }))).toBe("quota");
  });
});

describe("executeSearchChain 链执行（顺序回退 / 静默 / 保序分类）", () => {
  it("首个成功即返回：platform 取成功家、无 downgradedFrom、每候选只调一次", async () => {
    const calls: string[] = [];
    const outcome = await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "bilibili ai", {
      execute: async (candidate, query) => {
        calls.push(candidate.provider.id);
        expect(query).toBe("bilibili ai");
        return { results: [RESULT], platform: candidate.provider.name };
      }
    });

    expect(calls).toEqual(["search_firecrawl"]);
    expect(outcome).toEqual({ results: [RESULT], platform: "Firecrawl" });
  });

  it("链首失败静默试下一家；成功家非链首 → downgradedFrom = 链首 provider.name（§10 第 42 行）", async () => {
    const calls: string[] = [];
    const outcome = await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: async (candidate) => {
        calls.push(candidate.provider.id);
        if (candidate.provider.id === "search_firecrawl") throw httpError(503);
        return { results: [RESULT], platform: candidate.provider.name };
      }
    });

    expect(calls).toEqual(["search_firecrawl", "tavily-picked"]);
    expect(outcome).toEqual({ results: [RESULT], platform: "Tavily", downgradedFrom: "Firecrawl" });
  });

  it("整链无果：分类保序收集成列表，message 用最后一个错误的既有文案（§10 第 44 行）", async () => {
    const error = (await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: async (candidate) => {
        throw candidate.provider.id === "search_firecrawl" ? httpError(503) : httpError(400);
      }
    }).catch((thrown) => thrown)) as SearchChainError;

    expect(error.failures).toEqual(["other", "other"]);
    expect(error.searchFailureClass).toBe("other");
    expect(error.message).toBe("HTTP 400");
  });

  it("额度类在列 → 额度文案 + searchFailureClass:'quota'（其余类保序保留）", async () => {
    const error = (await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: async (candidate) => {
        throw candidate.provider.id === "search_firecrawl" ? httpError(503) : httpError(429);
      }
    }).catch((thrown) => thrown)) as SearchChainError;

    expect(error.failures).toEqual(["other", "quota"]);
    expect(error.searchFailureClass).toBe("quota");
    expect(error.message).toBe("搜索额度已用尽：可稍后再试，或在设置中为搜索平台配置 API Key 提升额度");
  });

  it("鉴权类在列但无额度 → 沿用其余类文案（§6.4 第 ② 行）", async () => {
    const lastMessage = "豆包联网搜索返回错误码 700901：invalid api key";
    const error = (await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: async (candidate) => {
        if (candidate.provider.id === "search_firecrawl") throw httpError(401);
        throw Object.assign(new Error(lastMessage), { providerCode: "700901" });
      }
    }).catch((thrown) => thrown)) as SearchChainError;

    expect(error.failures).toEqual(["auth", "auth"]);
    expect(error.searchFailureClass).toBe("auth");
    expect(error.message).toBe(lastMessage);
  });

  it("候选为空 → 抛既有兜底文案（无可用搜索平台）", async () => {
    const error = (await executeSearchChain([], "q", { execute: async () => ({ results: [], platform: "x" }) }).catch(
      (thrown) => thrown
    )) as Error;

    expect(rejectMessage(error)).toBe("搜索失败：无可用搜索平台");
    expect(classifySearchFailure(error)).toBe("other");
  });
});

describe("executeSearchChain 链级预算（§4 / §10 第 16 行）", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("链级预算常量 = 30000ms", () => {
    expect(SEARCH_CHAIN_BUDGET_MS).toBe(30000);
  });

  it("15s 超时 + 5.5s 成功 ≈ 20.5s → 整链成功（预算容得下最坏现实成功路径）", async () => {
    vi.useFakeTimers();
    const outcomePromise = executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: (candidate) =>
        new Promise<{ results: Array<typeof RESULT>; platform: string }>((resolve, reject) => {
          if (candidate.provider.id === "search_firecrawl") {
            setTimeout(() => reject(httpError(503)), 15000);
          } else {
            setTimeout(() => resolve({ results: [RESULT], platform: candidate.provider.name }), 5500);
          }
        })
    });

    await vi.advanceTimersByTimeAsync(15000);
    await vi.advanceTimersByTimeAsync(5500);

    await expect(outcomePromise).resolves.toEqual({
      results: [RESULT],
      platform: "Tavily",
      downgradedFrom: "Firecrawl"
    });
  });

  it("满 30s：主动放弃（中止在飞候选）并如实报失败，不是静默截断", async () => {
    vi.useFakeTimers();
    let abortedSignal = false;
    const execute = (_candidate: SearchChainCandidate, _query: string, signal?: AbortSignal | null) =>
      new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            abortedSignal = true;
            reject(Object.assign(new Error("请求已中止"), { name: "AbortError" }));
          },
          { once: true }
        );
      });

    const pending = executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", { execute });
    const settled = expect(pending).rejects.toMatchObject({ message: "搜索超时", failures: [] });

    await vi.advanceTimersByTimeAsync(SEARCH_CHAIN_BUDGET_MS);
    await settled;

    expect(abortedSignal).toBe(true);
  });

  it("预算到点不吞掉已发生的失败：保序分类 + 末条既有原因", async () => {
    vi.useFakeTimers();
    const execute = (candidate: SearchChainCandidate, _query: string, signal?: AbortSignal | null) => {
      if (candidate.provider.id === "search_firecrawl") {
        return Promise.reject(httpError(503));
      }
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("请求已中止"), { name: "AbortError" })),
          { once: true }
        );
      });
    };

    const pending = executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", { execute });
    const settled = expect(pending).rejects.toMatchObject({
      message: "HTTP 503",
      failures: ["other"],
      searchFailureClass: "other"
    });

    await vi.advanceTimersByTimeAsync(SEARCH_CHAIN_BUDGET_MS);
    await settled;
  });
});

// ===== 健康度记账接线（spec §12.4 第 1–2 条 / §12.5 第 7 行 / §10 第 72 行）=====
// 记账粒度 = 引擎级（候选 provider.presetId）；每次真实出网尝试记一次（成功 / 失败
// 各一次）；调用方中止（已中止 / 在飞中止）与自伤中止不构成引擎失败的口径见实现注释。
describe("executeSearchChain 健康度记账（§12.4 第 1–2 条 / §12.5 第 7 行）", () => {
  interface Recorded {
    presetId: string;
    ok: boolean;
    latencyMs: number;
  }

  function recorder(): { calls: Recorded[]; record: (presetId: string, ok: boolean, latencyMs: number) => void } {
    const calls: Recorded[] = [];
    return {
      calls,
      record: (presetId, ok, latencyMs) => {
        calls.push({ presetId, ok, latencyMs });
      }
    };
  }

  // 注入时钟：按顺序返回（延迟 = 两次读数之差）
  function clock(values: number[]): () => number {
    let index = 0;
    return () => values[Math.min(index++, values.length - 1)];
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("成功一次：按候选 presetId 记一次 ok + 实际延迟（now 注入，不取墙钟）", async () => {
    const { calls, record } = recorder();

    const outcome = await executeSearchChain([FIRECRAWL_CHAIN], "q", {
      execute: async () => ({ results: [RESULT], platform: "Firecrawl" }),
      recordAttempt: record,
      nowMs: clock([1000, 1042])
    });

    expect(outcome).toEqual({ results: [RESULT], platform: "Firecrawl" });
    expect(calls).toEqual([{ presetId: "firecrawl", ok: true, latencyMs: 42 }]);
  });

  it("失败回退：每次尝试各记一次，保序且按 presetId（引擎级，不按记录 id）", async () => {
    const { calls, record } = recorder();

    await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: async (candidate) => {
        if (candidate.provider.id === "search_firecrawl") throw httpError(503);
        return { results: [RESULT], platform: candidate.provider.name };
      },
      recordAttempt: record,
      nowMs: clock([0, 10, 20, 35])
    });

    expect(calls).toEqual([
      { presetId: "firecrawl", ok: false, latencyMs: 10 },
      { presetId: "tavily", ok: true, latencyMs: 15 }
    ]);
  });

  it("全部失败：每候选各一次 ok:false（额度类失败也照记，账不参与分类）", async () => {
    const { calls, record } = recorder();

    await executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: async (candidate) => {
        throw candidate.provider.id === "search_firecrawl" ? httpError(503) : httpError(429);
      },
      recordAttempt: record,
      nowMs: clock([0, 5, 10, 25])
    }).catch((thrown) => thrown);

    expect(calls).toEqual([
      { presetId: "firecrawl", ok: false, latencyMs: 5 },
      { presetId: "tavily", ok: false, latencyMs: 15 }
    ]);
  });

  it("单选链（独苗候选）照记账：不消费冷却但账照记（§12.4 第 1 条）", async () => {
    const { calls, record } = recorder();
    const chain = resolveSearchChain(
      [FIRECRAWL, TAVILY_USER],
      {},
      "search_firecrawl",
      SEARCH_PROVIDER_PRESETS,
      single()
    );

    await executeSearchChain(chain, "q", {
      execute: async () => {
        throw httpError(429);
      },
      recordAttempt: record,
      nowMs: clock([0, 8])
    }).catch((thrown) => thrown);

    expect(chain).toHaveLength(1);
    expect(calls).toEqual([{ presetId: "firecrawl", ok: false, latencyMs: 8 }]);
  });

  it("调用方中止：已中止 signal 零候选执行、零记账；在飞中止不试下一家也不记账（§12.4 第 2 条）", async () => {
    const aborted = recorder();
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({ results: [RESULT], platform: "Firecrawl" }));

    await expect(
      executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
        execute,
        signal: controller.signal,
        recordAttempt: aborted.record
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
    expect(aborted.calls).toEqual([]);

    const inflight = recorder();
    const running = new AbortController();
    const pending = executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute: (_candidate, _query, signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("请求已中止"), { name: "AbortError" })),
            { once: true }
          );
        }),
      signal: running.signal,
      recordAttempt: inflight.record
    });
    const settled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    running.abort();
    await settled;

    expect(inflight.calls).toEqual([]);
  });

  it("预算到点中止的在飞候选记一次失败（真实出网、未拿到结果），此前已归类的失败照记", async () => {
    vi.useFakeTimers();
    const { calls, record } = recorder();
    const execute = (candidate: SearchChainCandidate, _query: string, signal?: AbortSignal | null) => {
      if (candidate.provider.id === "search_firecrawl") {
        return Promise.reject(httpError(503));
      }
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => reject(Object.assign(new Error("请求已中止"), { name: "AbortError" })),
          { once: true }
        );
      });
    };

    const pending = executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute,
      recordAttempt: record,
      nowMs: clock([0, 10, 100, 30_100])
    });
    const settled = expect(pending).rejects.toMatchObject({ message: "HTTP 503" });

    await vi.advanceTimersByTimeAsync(SEARCH_CHAIN_BUDGET_MS);
    await settled;

    expect(calls).toEqual([
      { presetId: "firecrawl", ok: false, latencyMs: 10 },
      { presetId: "tavily", ok: false, latencyMs: 30_000 }
    ]);
  });

  it("记账抛错 / 返回 rejected promise 都不影响链结果（账失败静默）", async () => {
    const throwing = await executeSearchChain([FIRECRAWL_CHAIN], "q", {
      execute: async () => ({ results: [RESULT], platform: "Firecrawl" }),
      recordAttempt: () => {
        throw new Error("record boom");
      }
    });
    const rejecting = await executeSearchChain([FIRECRAWL_CHAIN], "q", {
      execute: async () => ({ results: [RESULT], platform: "Firecrawl" }),
      recordAttempt: async () => {
        throw new Error("record rejected");
      }
    });

    expect(throwing).toEqual({ results: [RESULT], platform: "Firecrawl" });
    expect(rejecting).toEqual({ results: [RESULT], platform: "Firecrawl" });
  });
});

describe("executeSearchChain 调用方中止出口（§4：不写缓存、不上 notice）", () => {
  it("已中止的 signal → 立即抛出、零候选执行", async () => {
    const controller = new AbortController();
    controller.abort();
    const execute = vi.fn(async () => ({ results: [RESULT], platform: "Firecrawl" }));

    await expect(
      executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", { execute, signal: controller.signal })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("在飞中止 → 立即抛出且不试下一家", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      (_candidate: SearchChainCandidate, _query: string, signal?: AbortSignal | null) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => reject(Object.assign(new Error("请求已中止"), { name: "AbortError" })),
            { once: true }
          );
        })
    );

    const pending = executeSearchChain([FIRECRAWL_CHAIN, TAVILY_CHAIN], "q", {
      execute,
      signal: controller.signal
    });
    const settled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await settled;

    expect(execute).toHaveBeenCalledTimes(1);
  });
});
