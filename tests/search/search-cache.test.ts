// 查询缓存（spec §5 / §3 落点表第 9 行 / §10 第 33–38 行）测试：
//   ① SW 叶 search/search-cache.ts——键与归一（64 位哈希、不落明文、跨引擎同一条）、
//      单键整张映射、TTL 300s、上限 50 按 ts 淘汰最旧、读写失败容错、clear 清空；
//   ② 发送方 proxy search/search-cache-client.ts——软超时 1000ms、读失败/无回包按
//      未命中、写失败静默 no-op（缓存绝不影响回答）。
// SW handler 的注册面在 tests/entry/offscreen-message-guard.test.ts（§10 第 39 行，
// 发送者含 content）与 tests/search/search-runtime.test.ts（命中直回 / 失败不写）。
// 时间走 fake timers，storage 走内存 fixture，不测真实网络与墙钟。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SEARCH_CACHE_KEY,
  SEARCH_CACHE_MAX_ENTRIES,
  SEARCH_CACHE_TTL_MS,
  clearSearchCache,
  getSearchCacheEntry,
  normalizeSearchCacheQuery,
  putSearchCacheEntry,
  searchCacheKey
} from "../../extension/search/search-cache.js";
import { searchCacheClient } from "../../extension/search/search-cache-client.js";

const RESULT = { title: "t", url: "https://example.com", snippet: "s" };

// ===== 内存 storage fixture（单键映射的形状断言直接读它）=====

let localFixture: Record<string, unknown>;

function asKeys(keys: unknown): string[] {
  return (Array.isArray(keys) ? keys : keys && typeof keys === "object" ? Object.keys(keys) : [keys]) as string[];
}

function readFixture(fixture: Record<string, unknown>, keys: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of asKeys(keys)) {
    if (key in fixture) out[key] = fixture[key];
  }
  return out;
}

function stubLocalStorage(
  overrides: Partial<Record<"get" | "set" | "remove", ReturnType<typeof vi.fn>>> = {}
): void {
  localFixture = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (keys: unknown) => readFixture(localFixture, keys)),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(localFixture, items);
        }),
        remove: vi.fn(async (keys: unknown) => {
          for (const key of asKeys(keys)) delete localFixture[key];
        }),
        ...overrides
      }
    }
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search-cache 键与归一（§5 / §10 第 37 行）", () => {
  it("键 = 64 位十六进制（两个不同盐的 32 位 lane），只含 [0-9a-f]，不落查询明文", () => {
    const query = "BiliBili 免 Key 搜索";
    const key = searchCacheKey(query);

    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).not.toContain("bilibili");
    expect(key).not.toContain("免");
    expect(searchCacheKey("abc")).not.toBe(searchCacheKey("abd"));
  });

  it("归一 = trim + 连续空白折叠单空格 + toLowerCase；同键跨大小写/空白不敏感", () => {
    expect(normalizeSearchCacheQuery("  BiliBili\t AI \n 搜索 ")).toBe("bilibili ai 搜索");
    expect(searchCacheKey("  BiliBili   AI ")).toBe(searchCacheKey("bilibili ai"));
    expect(searchCacheKey("bilibili ai")).not.toBe(searchCacheKey("bilibili  ai 搜索"));
  });
});

describe("search-cache 叶：读写 / TTL / 上限（§5 / §10 第 38 行）", () => {
  it("put → get 回原值（results / platform / ts），单键存整张映射、键名哈希", async () => {
    stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);

    await putSearchCacheEntry("bilibili ai", { results: [RESULT], platform: "Firecrawl" });
    const entry = await getSearchCacheEntry("  BiliBili   AI ");

    expect(entry).toEqual({ results: [RESULT], platform: "Firecrawl", ts: 1_000_000 });
    const stored = localFixture[SEARCH_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([searchCacheKey("bilibili ai")]);
    expect(Object.keys(stored)[0]).toMatch(/^[0-9a-f]{16}$/);
  });

  it("跨引擎同 query 同一条：键不含引擎 / 条数 / 链位次（后写覆盖先写）", async () => {
    stubLocalStorage();

    await putSearchCacheEntry("q", { results: [], platform: "Firecrawl" });
    await putSearchCacheEntry("q", { results: [RESULT], platform: "Tavily" });

    const stored = localFixture[SEARCH_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(1);
    await expect(getSearchCacheEntry("q")).resolves.toMatchObject({ results: [RESULT], platform: "Tavily" });
  });

  it("TTL 固定 300s：299999ms 命中、满 300s 未命中", async () => {
    stubLocalStorage();
    expect(SEARCH_CACHE_TTL_MS).toBe(300000);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    await putSearchCacheEntry("q", { results: [RESULT], platform: "Firecrawl" });

    vi.setSystemTime(SEARCH_CACHE_TTL_MS - 1);
    await expect(getSearchCacheEntry("q")).resolves.toMatchObject({ platform: "Firecrawl" });
    vi.setSystemTime(SEARCH_CACHE_TTL_MS);
    await expect(getSearchCacheEntry("q")).resolves.toBeNull();
  });

  it("过期条目在写路径清掉（内存内过期清理）", async () => {
    stubLocalStorage();
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await putSearchCacheEntry("old", { results: [], platform: "Firecrawl" });

    vi.setSystemTime(SEARCH_CACHE_TTL_MS + 1);
    await putSearchCacheEntry("new", { results: [], platform: "Tavily" });

    const stored = localFixture[SEARCH_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(stored)).toEqual([searchCacheKey("new")]);
  });

  it("上限 50 条：按 ts 淘汰最旧（第 51 条写入挤出最老一条）", async () => {
    stubLocalStorage();
    expect(SEARCH_CACHE_MAX_ENTRIES).toBe(50);
    vi.useFakeTimers();
    vi.setSystemTime(0);

    for (let index = 0; index <= SEARCH_CACHE_MAX_ENTRIES; index += 1) {
      vi.setSystemTime(index);
      await putSearchCacheEntry(`q${index}`, { results: [], platform: "Tavily" });
    }

    const stored = localFixture[SEARCH_CACHE_KEY] as Record<string, unknown>;
    expect(Object.keys(stored)).toHaveLength(SEARCH_CACHE_MAX_ENTRIES);
    await expect(getSearchCacheEntry("q0")).resolves.toBeNull();
    await expect(getSearchCacheEntry("q1")).resolves.toMatchObject({ platform: "Tavily" });
    await expect(getSearchCacheEntry(`q${SEARCH_CACHE_MAX_ENTRIES}`)).resolves.toMatchObject({ platform: "Tavily" });
  });
});

describe("search-cache 叶容错与 clear（§5：缓存绝不影响回答）", () => {
  it("读失败 → 按未命中（不抛）", async () => {
    stubLocalStorage({ get: vi.fn(async () => { throw new Error("storage read failed"); }) });

    await expect(getSearchCacheEntry("q")).resolves.toBeNull();
  });

  it("写失败 → 静默 no-op（不抛）", async () => {
    stubLocalStorage({ set: vi.fn(async () => { throw new Error("QUOTA_BYTES_PER_ITEM"); }) });

    await expect(putSearchCacheEntry("q", { results: [RESULT], platform: "Firecrawl" })).resolves.toBeUndefined();
  });

  it("存储值畸形（非对象 / 条目形状不对）→ 按未命中", async () => {
    stubLocalStorage();

    localFixture[SEARCH_CACHE_KEY] = "junk";
    await expect(getSearchCacheEntry("q")).resolves.toBeNull();
    localFixture[SEARCH_CACHE_KEY] = { [searchCacheKey("q")]: { results: "no", platform: 1, ts: "x" } };
    await expect(getSearchCacheEntry("q")).resolves.toBeNull();
  });

  it("clearSearchCache 清空整键（批次③撤回接线用，本批只导出）", async () => {
    stubLocalStorage();
    await putSearchCacheEntry("q", { results: [RESULT], platform: "Firecrawl" });

    await clearSearchCache();

    await expect(getSearchCacheEntry("q")).resolves.toBeNull();
    expect(localFixture[SEARCH_CACHE_KEY]).toBeUndefined();
  });
});

describe("search-cache-client 发送方 proxy（§5 容错口径 / §10 第 35、36 行）", () => {
  function stubRuntime(reply: (message: { op?: string; query?: string }) => unknown) {
    const sendMessage = vi.fn((message: { op?: string; query?: string }) =>
      Promise.resolve(reply(message))
    );
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    return sendMessage;
  }

  it("命中 → 回 {results, platform}；消息形状 {type:'search-cache', op:'get', query}", async () => {
    const entry = { results: [RESULT], platform: "Firecrawl" };
    const sendMessage = stubRuntime(() => ({ ok: true, hit: true, entry }));

    await expect(searchCacheClient.get("bilibili ai")).resolves.toEqual(entry);
    expect(sendMessage).toHaveBeenCalledWith({ type: "search-cache", op: "get", query: "bilibili ai" });
  });

  it("未命中 / 无回包 / ok:false / 条目形状非法 → null（按未命中继续）", async () => {
    for (const reply of [
      { ok: true, hit: false },
      undefined,
      { ok: false, error: "boom" },
      { ok: true, hit: true, entry: { results: "junk", platform: "x" } },
      { ok: true, hit: true }
    ]) {
      stubRuntime(() => reply);
      await expect(searchCacheClient.get("q")).resolves.toBeNull();
    }
  });

  it("读失败（messaging 抛错）→ 按未命中", async () => {
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(() => {
          throw new Error("Could not establish connection");
        })
      }
    });

    await expect(searchCacheClient.get("q")).resolves.toBeNull();
  });

  it("1000ms 无回包 → 软超时按未命中（不挂住回答）", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(() => new Promise(() => {})) } });

    const pending = searchCacheClient.get("q");
    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBeNull();
  });

  it("put 发 put 消息；写失败静默 no-op（不抛）", async () => {
    const sendMessage = stubRuntime(() => ({ ok: true }));

    await expect(
      searchCacheClient.put({ query: "q", results: [RESULT], platform: "Firecrawl" })
    ).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledWith({
      type: "search-cache",
      op: "put",
      query: "q",
      results: [RESULT],
      platform: "Firecrawl"
    });

    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(() => Promise.reject(new Error("no receiver"))) } });
    await expect(searchCacheClient.put({ query: "q", results: [], platform: "x" })).resolves.toBeUndefined();
  });
});
