// search/search-chain.ts 测试（spec §1 S1/S3/S4、§3 落点表第 8 行）。
// 覆盖 resolveSearchChain：进组判据（access × 有无 Key）、预设表序 + 链首排序、
// 按 presetId 去重（代表记录 = activeId 指向的该预设记录，否则输入顺序首条）、
// 脏 presetId / enabled 的保守排除、候选形状与纯函数不变式。
// 另覆盖执行器面：classifySearchFailure 的三等映射（§6.4 / §10 第 44/45
// 行）、executeSearchChain 的顺序回退 / 失败静默保序 / 额度与其余两类终态文案 /
// 链级预算 30s（§4 / §10 第 16 行）/ 调用方中止出口。时间一律走 fake timers 或
// 注入桩，不测真实网络与墙钟（§10 非断言节）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEARCH_PROVIDER_PRESETS } from "../../extension/core/presets.js";
import type { SearchProvider } from "../../extension/search/search-provider-normalize.js";
import { parseDoubaoSearchResponse } from "../../extension/search/adapters/doubao.js";
import {
  SEARCH_CHAIN_BUDGET_MS,
  classifySearchFailure,
  executeSearchChain,
  resolveSearchChain,
  type SearchChainCandidate,
  type SearchChainError
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
// 用户手加的同一家：生成式 id（ui/provider-row.ts），presetId 仍是 tavily
const TAVILY_USER: SearchProvider = {
  id: "tavily-picked",
  presetId: "tavily",
  name: "Tavily",
  type: "tavily",
  baseUrl: "https://api.tavily.com",
  enabled: true
};
// 同一条预设（firecrawl）的第二条记录：用户手加过、生成式 id + 自带 Key
const FIRECRAWL_USER: SearchProvider = {
  id: "firecrawl-picked",
  presetId: "firecrawl",
  name: "Firecrawl",
  type: "firecrawl",
  baseUrl: "https://api.firecrawl.dev",
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

  // 去重口径（用户裁定②）：同一 presetId 只入链一次——旧口径按记录 id 去重，会让
  // 「手加的生成式 id Firecrawl + 自动激活的 search_firecrawl」两条都进链、同一家被
  // 试第二次；本用例逐条锁新口径（代表记录选取 + 不重复消耗预算）。
  it("同 presetId 只入链一次（重复记录只留一条，链首不重复出现）", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, { ...FIRECRAWL }, TAVILY_USER],
      {},
      "search_firecrawl",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["search_firecrawl", "tavily-picked"]);
  });

  it("同 presetId 的两条记录（自动激活的 search_firecrawl + 手加的生成式 id）→ 该家只出现一次", () => {
    const chain = resolveSearchChain([FIRECRAWL, FIRECRAWL_USER, TAVILY_USER], {}, "", SEARCH_PROVIDER_PRESETS);

    expect(ids(chain)).toEqual(["search_firecrawl", "tavily-picked"]);
  });

  it("activeId 指向同 presetId 的第二条 → 代表 = 第二条（apiKey 取第二条的）且排链首", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, FIRECRAWL_USER, TAVILY_USER],
      { "firecrawl-picked": "fc-user-key" },
      "firecrawl-picked",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["firecrawl-picked", "tavily-picked"]);
    expect(chain[0].apiKey).toBe("fc-user-key");
  });

  it("activeId 为空 → 代表 = 输入顺序的首条符合条件记录（含它的 Key）", () => {
    const chain = resolveSearchChain(
      [FIRECRAWL, FIRECRAWL_USER],
      { search_firecrawl: "fc-auto-key", "firecrawl-picked": "fc-user-key" },
      "",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["search_firecrawl"]);
    expect(chain[0].apiKey).toBe("fc-auto-key");
  });

  it("activeId 指向同 presetId 的不在组记录（free-quota 无 Key）→ 不代表权，取首条在组记录", () => {
    const doubaoKeyless: SearchProvider = { ...DOUBAO, id: "doubao-nokey" };
    const doubaoKeyed: SearchProvider = { ...DOUBAO, id: "doubao-keyed" };
    const chain = resolveSearchChain(
      [doubaoKeyless, doubaoKeyed],
      { "doubao-keyed": "db-key" },
      "doubao-nokey",
      SEARCH_PROVIDER_PRESETS
    );

    expect(ids(chain)).toEqual(["doubao-keyed"]);
    expect(chain[0].apiKey).toBe("db-key");
  });

  it("同 presetId 去重后执行器只调该家一次（预算不被同家二次消耗）", async () => {
    const chain = resolveSearchChain([FIRECRAWL, FIRECRAWL_USER], {}, "firecrawl-picked", SEARCH_PROVIDER_PRESETS);
    const calls: string[] = [];

    await executeSearchChain(chain, "q", {
      execute: async (candidate) => {
        calls.push(candidate.provider.id);
        throw httpError(503);
      }
    }).catch((thrown) => thrown);

    expect(calls).toEqual(["firecrawl-picked"]);
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

// ===== 执行器面（spec §4 / §6.4 / §10 第 16、42–45 行）=====

const RESULT = { title: "t", url: "https://example.com", snippet: "s" };

// 链候选夹具（= ResolveSearchProviderResponse.chain 的元素，S4 单一形状）。
const FIRECRAWL_CHAIN: SearchChainCandidate = {
  provider: { id: "search_firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev" },
  apiKey: ""
};
const TAVILY_CHAIN: SearchChainCandidate = {
  provider: { id: "tavily-picked", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
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
