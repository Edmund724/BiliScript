import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { installSendMessageHost } from "../helpers/chrome-runtime-host.js";

type ProxyResponse = { ok: boolean; status?: number; body?: string; error?: string };
type ProxyResponder = (message: unknown) => ProxyResponse | undefined;

let fetchMock: Mock;
let sent: unknown[];
let responder: ProxyResponder;

async function loadModule() {
  return import("../../extension/core/provider-http.js");
}

function installProxyBus(next?: ProxyResponder) {
  responder = next || (() => ({ ok: true, status: 200, body: "" }));
  const host = installSendMessageHost({ "provider-http": (message: unknown) => responder(message) });
  sent = host.sent;
}

function stubChrome(overrides = {}) {
  const previous = globalThis.chrome;
  vi.stubGlobal("chrome", { ...previous, ...overrides });
  installProxyBus();
}

beforeEach(() => {
  resetModuleState();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "pong" }));
  vi.stubGlobal("fetch", fetchMock);
  stubChrome({ permissions: { contains: vi.fn(async () => true) } });
});

describe("handleProviderHttpRequest（SW 侧代发）", () => {
  it("URL 非法（空 / 非 http(s)）→ 拒绝，不发 fetch", async () => {
    const { handleProviderHttpRequest } = await loadModule();

    expect(await handleProviderHttpRequest({ url: "" })).toEqual({ ok: false, error: "请求地址不合法" });
    expect(await handleProviderHttpRequest({ url: "chrome-extension://x/y" })).toEqual({
      ok: false,
      error: "请求地址不合法"
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("域名未授权 → 可操作提示，不发 fetch", async () => {
    stubChrome({ permissions: { contains: vi.fn(async () => false) } });
    const { handleProviderHttpRequest } = await loadModule();

    const resp = await handleProviderHttpRequest({
      url: "https://token.sensenova.cn/v1/chat/completions",
      method: "POST"
    });

    expect(resp).toEqual({ ok: false, error: "该平台域名未授权，请在保存时允许权限" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("代发成功 → 透传 status 与响应体文本（探针据此判 response.ok）", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => '{"error":"bad key"}' });
    const { handleProviderHttpRequest } = await loadModule();

    const resp = await handleProviderHttpRequest({
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      headers: { accept: "application/json", authorization: "Bearer sk-1" },
      body: '{"model":"gpt"}'
    });

    expect(resp).toEqual({ ok: true, status: 401, body: '{"error":"bad key"}' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"model":"gpt"}');
    expect(init.headers.authorization).toBe("Bearer sk-1");
  });

  it("网络错误 → { ok:false, error }（文案经探针包装成「无法连接：…」）", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));
    const { handleProviderHttpRequest } = await loadModule();

    const resp = await handleProviderHttpRequest({ url: "https://api.example.com/v1/models" });

    expect(resp).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("超过 15s → 可操作超时文案", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { handleProviderHttpRequest } = await loadModule();

    const pending = handleProviderHttpRequest({ url: "https://api.example.com/v1/models" });
    await vi.advanceTimersByTimeAsync(15000);

    expect(await pending).toEqual({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
  });

  it("头已到、正文挂住 → 正文读取仍在 15s 档位内，到点回可操作超时文案", async () => {
    vi.useFakeTimers();
    const textMock = vi.fn(() => new Promise<string>(() => {}));
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: textMock });
    const { handleProviderHttpRequest } = await loadModule();

    let settled = false;
    const pending = handleProviderHttpRequest({ url: "https://api.example.com/v1/models" });
    pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(14999);
    expect(textMock).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
  });

  it("超时到点 → abort 在飞请求（signal.aborted === true），且不再读正文", async () => {
    vi.useFakeTimers();
    const textMock = vi.fn(() => new Promise<string>(() => {}));
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: textMock });
    const { handleProviderHttpRequest } = await loadModule();

    const pending = handleProviderHttpRequest({ url: "https://api.example.com/v1/models" });
    await vi.advanceTimersByTimeAsync(14999);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toEqual({ ok: false, error: "请求超时，请检查 baseUrl 或稍后重试" });
    expect(init.signal.aborted).toBe(true);
    expect(textMock).toHaveBeenCalledTimes(1);
  });
});

describe("providerFetchViaBackground（content 侧 fetch 兼容实现）", () => {
  it("出向载荷 = provider-http 消息（url/method/headers/body 原样过通道）", async () => {
    const { providerFetchViaBackground } = await loadModule();

    await providerFetchViaBackground("https://api.example.com/v1/chat/completions", {
      method: "POST",
      headers: { Accept: "application/json", Authorization: "Bearer sk-1" },
      body: '{"model":"gpt"}'
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      type: "provider-http",
      url: "https://api.example.com/v1/chat/completions",
      method: "POST",
      headers: { accept: "application/json", authorization: "Bearer sk-1" },
      body: '{"model":"gpt"}'
    });
  });

  it("合成标准 Response：status/ok/text/json 与 SW 回包一致", async () => {
    installProxyBus(() => ({ ok: true, status: 200, body: '{"choices":[{"message":{"content":"hi"}}]}' }));
    const { providerFetchViaBackground } = await loadModule();

    const resp = await providerFetchViaBackground("https://api.example.com/v1/chat/completions", { method: "POST" });

    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
    expect(await resp.text()).toContain('"content":"hi"');
  });

  it("非 2xx 也合成响应（探针按 response.ok 自己的语义报 HTTP 错误）", async () => {
    installProxyBus(() => ({ ok: true, status: 500, body: "boom" }));
    const { providerFetchViaBackground } = await loadModule();

    const resp = await providerFetchViaBackground("https://api.example.com/v1/chat/completions", { method: "POST" });

    expect(resp.status).toBe(500);
    expect(resp.ok).toBe(false);
  });

  it("通道 ok:false（未授权 / 网络错误 / 超时）→ 抛出原始文案，交给 completion 包装", async () => {
    installProxyBus(() => ({ ok: false, error: "该平台域名未授权，请在保存时允许权限" }));
    const { providerFetchViaBackground } = await loadModule();

    await expect(providerFetchViaBackground("https://api.example.com/v1/models")).rejects.toThrow(
      "该平台域名未授权，请在保存时允许权限"
    );
  });

  it("init.signal 已中止 → 同步以 AbortError 拒绝，不发消息", async () => {
    const { providerFetchViaBackground } = await loadModule();
    const controller = new AbortController();
    controller.abort();

    await expect(
      providerFetchViaBackground("https://api.example.com/v1/chat/completions", {
        method: "POST",
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(sent).toHaveLength(0);
  });

  it("等待中中止 → 以 AbortError 拒绝（在飞请求无法撤回，只结束本端等待）", async () => {
    installProxyBus(() => undefined);
    const { providerFetchViaBackground } = await loadModule();
    const controller = new AbortController();

    const pending = providerFetchViaBackground("https://api.example.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("未中止的 signal 不干扰正常回包（落定后摘监听，无悬挂）", async () => {
    const { providerFetchViaBackground } = await loadModule();
    const controller = new AbortController();

    const resp = await providerFetchViaBackground("https://api.example.com/v1/models", {
      signal: controller.signal
    });

    expect(resp.ok).toBe(true);
    controller.abort();
  });
});
