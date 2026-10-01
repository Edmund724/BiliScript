// search/search-runtime.ts 联网搜索运行时解析器测试（spec §1 S4、§3 落点表第 14 行）。
// chrome.runtime 双消息通道全覆盖：resolve-search-provider 往返 + provider-http
// 代发（executeWebSearch 缺省走 providerFetchViaBackground）。覆盖：
// 1. 成功组装：链夹具（有序候选 + 各自 Key）/ maxToolCalls 透传 / executeSearch 真跑 /
//    abort signal 透传；
// 2. 第二道闸：chain 空（未配置）→ undefined；chain 有候选且 apiKey:"" → 放行组装
//    （keyless 无 Key，出向请求头不含鉴权头）；
// 3. 链内单候选失败静默试下一个，platform 取实际成功家；全败抛最后一个错误；
// 4. maxToolCalls 缺省 / 非法回落 5。
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWebSearchRuntime } from "../../extension/search/search-runtime.js";
import type { ResolveSearchProviderResponse } from "../../extension/shared/messaging-protocol.js";

// 链夹具（spec §1 S4）：有序候选 + 各自 Key；keyless 候选的 apiKey 允许空串。
const CHAIN_OK: ResolveSearchProviderResponse = {
  ok: true,
  chain: [
    {
      provider: { id: "p1", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
      apiKey: "tvly-k"
    }
  ],
  maxToolCalls: 3
};

const FIRECRAWL_CANDIDATE = {
  provider: { id: "search_firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev" },
  apiKey: ""
};

// chrome.runtime 双通道替身（sendRuntimeMessage 走 callback + lastError；解析器
// 直发走 Promise 风格，两种风格都回）：resolve-search-provider 回 resp，
// provider-http 按顺序回 httpPayloads（最后一个重复用于后续调用；载荷是
// SW 端 ok/status 透传的形状，单候选失败即 !ok 或 status >= 400）。
function stubRuntime(
  resp: ResolveSearchProviderResponse,
  httpPayloads: Array<Record<string, unknown>> = [
    { ok: true, status: 200, body: JSON.stringify({ results: [{ title: "t", url: "u", content: "c" }] }) }
  ]
) {
  let httpCall = 0;
  const reply = (msg: { type?: string }) => {
    if (msg?.type === "resolve-search-provider") {
      return resp;
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

function sentMessage(index: number) {
  return vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls[index][0] as {
    type?: string;
    url?: string;
    headers: Record<string, string>;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveWebSearchRuntime 联网搜索运行时解析", () => {
  it("成功组装：maxToolCalls 透传，executeSearch 经 provider-http 真跑并归一", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(CHAIN_OK) });
    const runtime = (await resolveWebSearchRuntime())!;
    expect(runtime.maxToolCalls).toBe(3);
    const outcome = await runtime.executeSearch("bilibili ai");
    expect(outcome.platform).toBe("Tavily");
    expect(outcome.results[0]).toEqual({ title: "t", url: "u", snippet: "c" });
    // provider-http 消息带搜索请求形状（url/headers 密钥不出 SW）
    const httpMsg = sentMessage(1);
    expect(httpMsg.type).toBe("provider-http");
    expect(httpMsg.url).toBe("https://api.tavily.com/search");
    expect(httpMsg.headers.authorization).toBe("Bearer tvly-k");
  });

  it("abort signal 透传 executeSearch（调用方停止可中断在途搜索）", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(CHAIN_OK) });
    const controller = new AbortController();
    const runtime = (await resolveWebSearchRuntime(controller.signal))!;
    const { providerFetchViaBackground } = await import("../../extension/core/provider-http.js");
    controller.abort();
    await expect(runtime.executeSearch("q")).rejects.toMatchObject({ name: "AbortError" });
    // 仅为类型面引用（signal 透传链路同走 providerFetchViaBackground）
    expect(typeof providerFetchViaBackground).toBe("function");
  });

  it("chain 缺省 / 空（未配置搜索平台）→ undefined", async () => {
    for (const resp of [{ ok: true }, { ok: true, chain: [] }]) {
      vi.stubGlobal("chrome", { runtime: stubRuntime(resp as ResolveSearchProviderResponse) });
      await expect(resolveWebSearchRuntime()).resolves.toBeUndefined();
    }
  });

  it("chain 有候选且 apiKey:''（keyless）→ 组装成功，出向请求头不含鉴权头", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ok: true, chain: [FIRECRAWL_CANDIDATE], maxToolCalls: 4 })
    });
    const runtime = (await resolveWebSearchRuntime())!;
    expect(runtime.maxToolCalls).toBe(4);

    const outcome = await runtime.executeSearch("q");
    expect(outcome.platform).toBe("Firecrawl");

    const httpMsg = sentMessage(1);
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
              provider: { id: "p1", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
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
    const runtime = (await resolveWebSearchRuntime())!;

    const outcome = await runtime.executeSearch("q");

    expect(outcome.platform).toBe("Tavily");
    expect(outcome.results[0]).toEqual({ title: "t2", url: "u2", snippet: "c2" });
    expect([sentMessage(1).url, sentMessage(2).url]).toEqual([
      "https://api.firecrawl.dev/v2/search",
      "https://api.tavily.com/search"
    ]);
  });

  it("全部候选失败 → 抛最后一个错误（正式链执行器属批次②）", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime(
        { ok: true, chain: [FIRECRAWL_CANDIDATE, { ...FIRECRAWL_CANDIDATE, provider: { ...FIRECRAWL_CANDIDATE.provider, id: "p2" } }] },
        [
          { ok: true, status: 503, body: "" },
          { ok: true, status: 429, body: "" }
        ]
      )
    });
    const runtime = (await resolveWebSearchRuntime())!;

    await expect(runtime.executeSearch("q")).rejects.toThrow("HTTP 429");
  });

  it("消息失败 / 无接收方（SW 冷启动竞态）→ undefined，不抛", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => { throw new Error("Could not establish connection"); }) } });
    await expect(resolveWebSearchRuntime()).resolves.toBeUndefined();
  });

  it("maxToolCalls 缺省 / 非法回落 5", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...CHAIN_OK, maxToolCalls: 0 })
    });
    await expect(resolveWebSearchRuntime()).resolves.toMatchObject({ maxToolCalls: 5 });
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...CHAIN_OK, maxToolCalls: undefined })
    });
    await expect(resolveWebSearchRuntime()).resolves.toMatchObject({ maxToolCalls: 5 });
  });
});

