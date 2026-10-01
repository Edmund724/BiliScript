// search/search-runtime.ts 联网搜索运行时解析器测试（spec §1 S4、§3 落点表第 14 行、
// §5 查询缓存 / §10 第 33–36 行）。chrome.runtime 三消息通道全覆盖：
// resolve-search-provider 往返 + search-cache get/put（命中直回、未命中跑链后写、
// 失败一律不写）+ provider-http 代发（executeWebSearch 缺省走 providerFetchViaBackground）。
// 覆盖：
// 1. 成功组装：链夹具（有序候选 + 各自 Key）/ maxToolCalls 透传 / executeSearch 真跑 /
//    abort signal 透传；
// 2. 第二道闸：chain 空 → runtime 缺省 + notice 单源（未配置文案）；空链带
//    chainEmptyReason:'cooldown' → 冷却专属文案（不误报未配置，spec §12.7 第 6 条翻案）；
//    chain 有候选且 apiKey:"" → 放行组装（keyless 无 Key，出向请求头不含鉴权头）；
// 3. 链内单候选失败静默试下一个，platform 取实际成功家 + downgradedFrom 透传；
//    全败抛分类错误（额度类走额度文案，其余类用末条原因）；
// 4. 缓存：命中直回（链与 provider-http 零调用）/ 未命中成功后 put / 失败与中止不写；
// 5. maxToolCalls 缺省 / 非法回落 5。
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveWebSearchRuntime,
  SEARCH_COOLDOWN_NOTICE,
  SEARCH_NOT_CONFIGURED_NOTICE
} from "../../extension/search/search-runtime.js";
import type {
  ResolveSearchProviderResponse,
  SearchCacheMessage,
  SearchCacheResponse,
  SearchHealthMessage
} from "../../extension/shared/messaging-protocol.js";

// 链夹具（spec §1 S4）：有序候选 + 各自 Key；keyless 候选的 apiKey 允许空串；
// provider 带 presetId（链候选形状）。
const CHAIN_OK: ResolveSearchProviderResponse = {
  ok: true,
  chain: [
    {
      provider: { id: "p1", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
      apiKey: "tvly-k"
    }
  ],
  maxToolCalls: 3
};

const FIRECRAWL_CANDIDATE = {
  provider: {
    id: "search_firecrawl",
    presetId: "firecrawl",
    name: "Firecrawl",
    type: "firecrawl",
    baseUrl: "https://api.firecrawl.dev"
  },
  apiKey: ""
};

// chrome.runtime 三通道替身（sendRuntimeMessage 走 callback + lastError；解析器
// 与缓存 proxy 直发走 Promise 风格，两种风格都回）：resolve-search-provider 回
// resp；search-cache 的 get 回 cacheGet（缺省未命中）、put 回 {ok:true} 并记账；
// search-health 的 record 回 {ok:true}（记账不占 provider-http 的调用计数）；
// provider-http 按顺序回 httpPayloads（最后一个重复用于后续调用；载荷是
// SW 端 ok/status 透传的形状，单候选失败即 !ok 或 status >= 400）。
function stubRuntime(
  resp: ResolveSearchProviderResponse,
  httpPayloads: Array<Record<string, unknown>> = [
    { ok: true, status: 200, body: JSON.stringify({ results: [{ title: "t", url: "u", content: "c" }] }) }
  ],
  cacheGet: SearchCacheResponse = { ok: true, hit: false }
) {
  let httpCall = 0;
  const reply = (msg: { type?: string; op?: string }) => {
    if (msg?.type === "resolve-search-provider") {
      return resp;
    }
    if (msg?.type === "search-cache") {
      return msg.op === "get" ? cacheGet : { ok: true };
    }
    if (msg?.type === "search-health") {
      return { ok: true };
    }
    const payload = httpPayloads[Math.min(httpCall, httpPayloads.length - 1)];
    httpCall += 1;
    return payload;
  };
  return {
    lastError: null,
    sendMessage: vi.fn((msg, callback) => {
      const payload = reply(msg);
      if (typeof callback === "function") {
        callback(payload);
        return undefined;
      }
      return Promise.resolve(payload);
    })
  };
}

// 第 index 个 provider-http 代发消息（search-cache / resolve-search-provider 不计入）。
function sentHttpMessage(index: number) {
  const httpMessages = vi
    .mocked(globalThis.chrome.runtime.sendMessage)
    .mock.calls.map((call) => call[0] as { type?: string; url?: string; headers: Record<string, string> })
    .filter((message) => message?.type === "provider-http");
  return httpMessages[index];
}

// 发往 chrome.runtime 的消息类型序列（缓存命中时断言「链与 provider-http 零调用」）。
function sentTypes(): Array<string | undefined> {
  return vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls.map(
    (call) => (call[0] as { type?: string })?.type
  );
}

// search-cache 通道收到的消息（get/put 与载荷）。
function cacheMessages(): SearchCacheMessage[] {
  return vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls
    .map((call) => call[0] as SearchCacheMessage)
    .filter((message) => message?.type === "search-cache");
}

// search-health 通道收到的记账消息（引擎级 presetId + ok + 延迟）。
function healthMessages(): SearchHealthMessage[] {
  return vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls
    .map((call) => call[0] as SearchHealthMessage)
    .filter((message) => message?.type === "search-health");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveWebSearchRuntime 联网搜索运行时解析", () => {
  it("成功组装：maxToolCalls 透传，executeSearch 经 provider-http 真跑并归一", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(CHAIN_OK) });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;
    expect(runtime.maxToolCalls).toBe(3);
    const outcome = await runtime.executeSearch("bilibili ai");
    expect(outcome.platform).toBe("Tavily");
    expect(outcome.results[0]).toEqual({ title: "t", url: "u", snippet: "c" });
    // provider-http 消息带搜索请求形状（url/headers 密钥不出 SW）
    const httpMsg = sentHttpMessage(0);
    expect(httpMsg.type).toBe("provider-http");
    expect(httpMsg.url).toBe("https://api.tavily.com/search");
    expect(httpMsg.headers.authorization).toBe("Bearer tvly-k");
  });

  it("abort signal 透传 executeSearch（调用方停止可中断在途搜索）", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(CHAIN_OK) });
    const controller = new AbortController();
    const runtime = ((await resolveWebSearchRuntime(controller.signal)).runtime)!;
    const { providerFetchViaBackground } = await import("../../extension/core/provider-http.js");
    controller.abort();
    await expect(runtime.executeSearch("q")).rejects.toMatchObject({ name: "AbortError" });
    // 仅为类型面引用（signal 透传链路同走 providerFetchViaBackground）
    expect(typeof providerFetchViaBackground).toBe("function");
  });

  it("chain 缺省 / 空（未配置搜索平台）→ runtime 缺省 + 未配置文案（notice 单源）", async () => {
    for (const resp of [{ ok: true }, { ok: true, chain: [] }]) {
      vi.stubGlobal("chrome", { runtime: stubRuntime(resp as ResolveSearchProviderResponse) });
      await expect(resolveWebSearchRuntime()).resolves.toEqual({ notice: SEARCH_NOT_CONFIGURED_NOTICE });
    }
  });

  it("chain 空且 chainEmptyReason:'cooldown' → runtime 缺省 + 冷却专属文案（不误报未配置）", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime({ ok: true, chainEmptyReason: "cooldown" }) });

    const resolution = await resolveWebSearchRuntime();

    expect(resolution.runtime).toBeUndefined();
    expect(resolution.notice).toBe(SEARCH_COOLDOWN_NOTICE);
    expect(resolution.notice).not.toContain("未配置");
  });

  it("chain 非空（脏 chainEmptyReason）→ 照常组装运行时、无 notice", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...CHAIN_OK, chainEmptyReason: "cooldown" })
    });

    const resolution = await resolveWebSearchRuntime();

    expect(resolution.runtime?.maxToolCalls).toBe(3);
    expect(resolution.notice).toBeUndefined();
  });

  it("chain 有候选且 apiKey:''（keyless）→ 组装成功，出向请求头不含鉴权头", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ok: true, chain: [FIRECRAWL_CANDIDATE], maxToolCalls: 4 })
    });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;
    expect(runtime.maxToolCalls).toBe(4);

    const outcome = await runtime.executeSearch("q");
    expect(outcome.platform).toBe("Firecrawl");

    const httpMsg = sentHttpMessage(0);
    expect(httpMsg.type).toBe("provider-http");
    expect(httpMsg.url).toBe("https://api.firecrawl.dev/v2/search");
    const headerNames = Object.keys(httpMsg.headers).map((name) => name.toLowerCase());
    expect(headerNames).not.toContain("authorization");
  });

  it("首候选失败 → 静默回退第二候选，platform 取实际成功家", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime(
        {
          ok: true,
          chain: [
            FIRECRAWL_CANDIDATE,
            {
              provider: { id: "p1", presetId: "tavily", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
              apiKey: "tvly-k"
            }
          ],
          maxToolCalls: 2
        },
        [
          { ok: true, status: 503, body: "" },
          { ok: true, status: 200, body: JSON.stringify({ results: [{ title: "t2", url: "u2", content: "c2" }] }) }
        ]
      )
    });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;

    const outcome = await runtime.executeSearch("q");

    expect(outcome.platform).toBe("Tavily");
    expect(outcome.results[0]).toEqual({ title: "t2", url: "u2", snippet: "c2" });
    // 降级成功：downgradedFrom = 链首 provider.name（模型侧降级注记的输入）
    expect(outcome.downgradedFrom).toBe("Firecrawl");
    expect([sentHttpMessage(0).url, sentHttpMessage(1).url]).toEqual([
      "https://api.firecrawl.dev/v2/search",
      "https://api.tavily.com/search"
    ]);
    // 记账（spec §12.4 第 1 条）：每次真实出网尝试各一次、按引擎级 presetId 保序
    expect(healthMessages().map(({ presetId, ok }) => ({ presetId, ok }))).toEqual([
      { presetId: "firecrawl", ok: false },
      { presetId: "tavily", ok: true }
    ]);
    expect(healthMessages().every((message) => typeof message.latencyMs === "number" && message.latencyMs >= 0)).toBe(
      true
    );
  });

  it("全部候选失败（其余类）→ 抛末条既有文案的链错误（§10 第 44 行）", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime(
        { ok: true, chain: [FIRECRAWL_CANDIDATE, { ...FIRECRAWL_CANDIDATE, provider: { ...FIRECRAWL_CANDIDATE.provider, id: "p2" } }] },
        [
          { ok: true, status: 503, body: "" },
          { ok: true, status: 500, body: "" }
        ]
      )
    });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;

    await expect(runtime.executeSearch("q")).rejects.toMatchObject({
      message: "HTTP 500",
      failures: ["other", "other"]
    });
    // 引擎级记账：两条记录同 presetId（firecrawl）各记一次失败（不是按记录 id 各立一户）
    expect(healthMessages().map(({ presetId, ok }) => ({ presetId, ok }))).toEqual([
      { presetId: "firecrawl", ok: false },
      { presetId: "firecrawl", ok: false }
    ]);
  });

  it("全部候选失败（额度类在列）→ 抛 §6.4 额度文案（§10 第 44 行）", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime(
        { ok: true, chain: [FIRECRAWL_CANDIDATE, { ...FIRECRAWL_CANDIDATE, provider: { ...FIRECRAWL_CANDIDATE.provider, id: "p2" } }] },
        [
          { ok: true, status: 503, body: "" },
          { ok: true, status: 429, body: "" }
        ]
      )
    });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;

    await expect(runtime.executeSearch("q")).rejects.toMatchObject({
      message: "搜索额度已用尽：可稍后再试，或在设置中为搜索平台配置 API Key 提升额度",
      failures: ["other", "quota"],
      searchFailureClass: "quota"
    });
  });

  it("缓存命中：直回缓存值，链与 provider-http 零调用（§10 第 33 行）", async () => {
    const entry = {
      results: [{ title: "cached", url: "https://cached.example", snippet: "cs" }],
      platform: "Firecrawl"
    };
    vi.stubGlobal("chrome", {
      runtime: stubRuntime(CHAIN_OK, [], { ok: true, hit: true, entry })
    });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;

    const outcome = await runtime.executeSearch("bilibili ai");

    expect(outcome).toEqual({ results: entry.results, platform: "Firecrawl" });
    // 只有 resolve 与一次 search-cache get：无 provider-http、无 put
    expect(sentTypes()).toEqual(["resolve-search-provider", "search-cache"]);
    expect(cacheMessages().map((message) => message.op)).toEqual(["get"]);
    // 缓存命中没有引擎被尝试 → 零记账（spec §12.4 第 2 条）
    expect(healthMessages()).toEqual([]);
  });

  it("缓存未命中：跑链成功后 put（query / results / platform，§5）", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(CHAIN_OK) });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;

    const outcome = await runtime.executeSearch("bilibili ai");

    expect(outcome.platform).toBe("Tavily");
    await vi.waitFor(() => expect(cacheMessages().map((message) => message.op)).toEqual(["get", "put"]));
    expect(cacheMessages()[1]).toMatchObject({
      type: "search-cache",
      op: "put",
      query: "bilibili ai",
      results: outcome.results,
      platform: "Tavily"
    });
  });

  it.each([
    ["HTTP 503", { ok: true, status: 503, body: "" }],
    ["HTTP 429", { ok: true, status: 429, body: "" }],
    ["HTTP 402", { ok: true, status: 402, body: "" }],
    ["HTTP 401", { ok: true, status: 401, body: "" }],
    ["非 JSON 正文", { ok: true, status: 200, body: "not-json" }],
    ["网络失败", { ok: false, error: "Failed to fetch" }]
  ])("链失败（%s）一律不写缓存（§10 第 34 行）", async (_label, payload) => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ok: true, chain: [FIRECRAWL_CANDIDATE] }, [payload])
    });
    const runtime = ((await resolveWebSearchRuntime()).runtime)!;

    await expect(runtime.executeSearch("q")).rejects.toBeTruthy();

    expect(cacheMessages().map((message) => message.op)).toEqual(["get"]);
  });

  it("用户中止 → 不写缓存（§10 第 34 行）", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime({ ok: true, chain: [FIRECRAWL_CANDIDATE] }) });
    const controller = new AbortController();
    const runtime = ((await resolveWebSearchRuntime(controller.signal)).runtime)!;
    controller.abort();

    await expect(runtime.executeSearch("q")).rejects.toMatchObject({ name: "AbortError" });

    expect(cacheMessages().map((message) => message.op)).toEqual(["get"]);
    expect(sentHttpMessage(0)).toBeUndefined();
    // 用户中止不是引擎的失败 → 零记账（spec §12.4 第 2 条）
    expect(healthMessages()).toEqual([]);
  });

  it("消息失败 / 无接收方（SW 冷启动竞态）→ runtime 缺省 + 未配置文案，不抛", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => { throw new Error("Could not establish connection"); }) } });
    await expect(resolveWebSearchRuntime()).resolves.toEqual({ notice: SEARCH_NOT_CONFIGURED_NOTICE });
  });

  it("maxToolCalls 缺省 / 非法回落 5", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...CHAIN_OK, maxToolCalls: 0 })
    });
    await expect(resolveWebSearchRuntime()).resolves.toMatchObject({ runtime: { maxToolCalls: 5 } });
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...CHAIN_OK, maxToolCalls: undefined })
    });
    await expect(resolveWebSearchRuntime()).resolves.toMatchObject({ runtime: { maxToolCalls: 5 } });
  });
});

