// search/search-cache-handler.js SW 端消息 handler 工厂测试（arch-review-2026-09/08）：
// 直调 createSearchCacheHandler（同 ai/segment-cache-handler.test.ts 形态），不再起
// 真 background 入口 + chrome 桩——组合根只登记工厂实例，「路由表挂上本 handler」由
// tsc 的 satisfies 穷尽 + tests/shared/messaging-response-scan.test.ts 的键集扫描兜住。
// 覆盖：put → get 往返（单键映射、16 位哈希键、无查询明文、回包不带 ts）、归一
// 大小写/空白变体命中同一条、未命中回 { ok:true, hit:false }、未知 op → ok:false
// （不静默吞）、读写失败静默（缓存绝不影响回答）、来源口径（不进 offscreen-only 名单）。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { SEARCH_CACHE_KEY } from "../../extension/search/search-cache.js";
import { OFFSCREEN_ONLY_MESSAGE_TYPES } from "../../extension/shared/messaging-protocol.js";
import type { SearchCacheMessage, SearchCacheResponse } from "../../extension/shared/messaging-protocol.js";

let storage: ReturnType<typeof createMemoryStorage>;
let handler: ReturnType<typeof import("../../extension/search/search-cache-handler.js").createSearchCacheHandler>;

function createMemoryStorage() {
  const map = new Map<string, unknown>();
  const local = {
    get: vi.fn(async (keys: unknown) => {
      const want = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, unknown> = {};
      for (const key of want as string[]) {
        if (map.has(key)) out[key] = map.get(key);
      }
      return out;
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) map.set(key, value);
    }),
    remove: vi.fn(async (keys: unknown) => {
      for (const key of (Array.isArray(keys) ? keys : [keys]) as string[]) map.delete(key);
    })
  };
  return { map, local };
}

async function importModules() {
  resetModuleState();
  storage = createMemoryStorage();
  vi.stubGlobal("chrome", { storage: { local: storage.local } });
  const mod = await import("../../extension/search/search-cache-handler.js");
  handler = mod.createSearchCacheHandler();
}

function request(message: SearchCacheMessage): Promise<SearchCacheResponse> {
  return new Promise<SearchCacheResponse>((resolve) => handler(message, {}, resolve));
}

const ENTRY = {
  results: [{ title: "t", url: "https://example.com", snippet: "s" }],
  platform: "Firecrawl"
};

beforeEach(async () => {
  await importModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("search-cache 消息族：get / put（spec §5 / §3 落点表第 13 行）", () => {
  it("put → get 往返：落 local 单键（16 位十六进制哈希键、无查询明文），回包不含 ts", async () => {
    const put = await request({ type: "search-cache", op: "put", query: "bilibili ai", ...ENTRY });
    expect(put).toEqual({ ok: true });

    const stored = storage.map.get(SEARCH_CACHE_KEY) as Record<string, unknown>;
    expect([...storage.map.keys()]).toEqual([SEARCH_CACHE_KEY]);
    expect(Object.keys(stored)).toHaveLength(1);
    expect(Object.keys(stored)[0]).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(stored)).not.toContain("bilibili");

    const got = await request({ type: "search-cache", op: "get", query: "bilibili ai" });
    expect(got).toEqual({ ok: true, hit: true, entry: ENTRY });
  });

  it("归一在 SW 侧单源：大小写 / 连续空白变体命中同一条（调用方不拼键）", async () => {
    await request({ type: "search-cache", op: "put", query: "bilibili ai", ...ENTRY });

    const got = await request({ type: "search-cache", op: "get", query: "  BiliBili   AI " });

    expect(got).toEqual({ ok: true, hit: true, entry: ENTRY });
  });

  it("get 未命中：ok:true + hit:false（不算错误）", async () => {
    expect(await request({ type: "search-cache", op: "get", query: "never cached" })).toEqual({
      ok: true,
      hit: false
    });
  });

  it("put 脏载荷：results 非数组按线格式归一（空数组），platform 经 String 归一", async () => {
    const dirty = {
      type: "search-cache",
      op: "put",
      query: "dirty",
      results: "junk",
      platform: 42
    } as unknown as SearchCacheMessage;

    expect(await request(dirty)).toEqual({ ok: true });

    const stored = storage.map.get(SEARCH_CACHE_KEY) as Record<string, { results: unknown; platform: unknown }>;
    expect(Object.values(stored)[0]).toMatchObject({ results: [], platform: "42" });
  });

  it("未知 op → ok:false + 错误文案（不静默吞）", async () => {
    const response = await request({ type: "search-cache", op: "clear" } as unknown as SearchCacheMessage);

    expect(response.ok).toBe(false);
    expect(response.error).toContain("不支持的搜索缓存操作");
  });

  it("缓存读写失败静默（缓存绝不影响回答）：读按未命中、写仍回 ok:true", async () => {
    storage.local.get.mockRejectedValueOnce(new Error("storage failure"));
    expect(await request({ type: "search-cache", op: "get", query: "bilibili ai" })).toEqual({
      ok: true,
      hit: false
    });

    storage.local.set.mockRejectedValueOnce(new Error("quota"));
    expect(await request({ type: "search-cache", op: "put", query: "bilibili ai", ...ENTRY })).toEqual({
      ok: true
    });
  });

  it("来源口径：本族不进 offscreen-only 名单（发送者含 content；行为面由 tests/entry/offscreen-message-guard.test.ts 钉）", () => {
    expect([...OFFSCREEN_ONLY_MESSAGE_TYPES]).not.toContain("search-cache");
  });
});
