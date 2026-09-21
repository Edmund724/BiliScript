// search/search-runtime.ts 联网搜索运行时解析器测试（spec §2.3/§2.4）。
// chrome.runtime 双消息通道全覆盖：resolve-search-provider 往返 + provider-http
// 代发（executeWebSearch 缺省走 providerFetchViaBackground）。覆盖：
// 1. 成功组装：maxToolCalls 透传 / executeSearch 真跑 / abort signal 透传；
// 2. 未配置激活平台（provider 缺省）与消息失败 → undefined；
// 3. maxToolCalls 缺省/非法回落 5。
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWebSearchRuntime } from "../../extension/search/search-runtime.js";
import type { ResolveSearchProviderResponse } from "../../extension/shared/messaging-protocol.js";

const PROVIDER_OK = {
  ok: true,
  provider: { id: "p1", name: "Tavily", type: "tavily", baseUrl: "https://api.tavily.com" },
  apiKey: "tvly-k",
  maxToolCalls: 3
};

// chrome.runtime 双通道替身（sendRuntimeMessage 走 callback + lastError；解析器
// 直发走 Promise 风格，两种风格都回）：resolve-search-provider 回 resp，
// provider-http 回 HTTP 200 JSON（SW 端 ok:true + status 透传的载荷形状）。
function stubRuntime(resp: ResolveSearchProviderResponse, httpPayload = { results: [{ title: "t", url: "u", content: "c" }] }) {
  const reply = (msg: { type?: string }) => {
    if (msg?.type === "resolve-search-provider") {
      return resp;
    }
    return { ok: true, status: 200, body: JSON.stringify(httpPayload) };
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveWebSearchRuntime 联网搜索运行时解析", () => {
  it("成功组装：maxToolCalls 透传，executeSearch 经 provider-http 真跑并归一", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(PROVIDER_OK) });
    const runtime = (await resolveWebSearchRuntime())!;
    expect(runtime.maxToolCalls).toBe(3);
    const outcome = await runtime.executeSearch("bilibili ai");
    expect(outcome.platform).toBe("Tavily");
    expect(outcome.results[0]).toEqual({ title: "t", url: "u", snippet: "c" });
    // provider-http 消息带搜索请求形状（url/headers 密钥不出 SW）
    const httpMsg = vi.mocked(globalThis.chrome.runtime.sendMessage).mock.calls[1][0] as {
      type?: string;
      url?: string;
      headers: Record<string, string>;
    };
    expect(httpMsg.type).toBe("provider-http");
    expect(httpMsg.url).toBe("https://api.tavily.com/search");
    expect(httpMsg.headers.authorization).toBe("Bearer tvly-k");
  });

  it("abort signal 透传 executeSearch（调用方停止可中断在途搜索）", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime(PROVIDER_OK) });
    const controller = new AbortController();
    const runtime = (await resolveWebSearchRuntime(controller.signal))!;
    const { providerFetchViaBackground } = await import("../../extension/core/provider-http.js");
    controller.abort();
    await expect(runtime.executeSearch("q")).rejects.toMatchObject({ name: "AbortError" });
    // 仅为类型面引用（signal 透传链路同走 providerFetchViaBackground）
    expect(typeof providerFetchViaBackground).toBe("function");
  });

  it("未配置激活平台（provider 缺省）→ undefined", async () => {
    vi.stubGlobal("chrome", { runtime: stubRuntime({ ok: true }) });
    await expect(resolveWebSearchRuntime()).resolves.toBeUndefined();
  });

  it("消息失败 / 无接收方（SW 冷启动竞态）→ undefined，不抛", async () => {
    vi.stubGlobal("chrome", { runtime: { sendMessage: vi.fn(async () => { throw new Error("Could not establish connection"); }) } });
    await expect(resolveWebSearchRuntime()).resolves.toBeUndefined();
  });

  it("maxToolCalls 缺省 / 非法回落 5", async () => {
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...PROVIDER_OK, maxToolCalls: 0 })
    });
    await expect(resolveWebSearchRuntime()).resolves.toMatchObject({ maxToolCalls: 5 });
    vi.stubGlobal("chrome", {
      runtime: stubRuntime({ ...PROVIDER_OK, maxToolCalls: undefined })
    });
    await expect(resolveWebSearchRuntime()).resolves.toMatchObject({ maxToolCalls: 5 });
  });
});
