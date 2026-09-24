// core/provider-http-offscreen.ts 测试：概览链的平台请求代发（content 发起 →
// offscreen 文档执行）。
//
// 与 core/provider-http.ts（SW 代发）同形，差别只在承载者与超时/取消策略：
// 概览是分钟级非流式请求，SW 代发的 15s 超时（provider-http.ts:56）与 MV3
// service worker 生命周期都不适用；offscreen 是扩展源、不过网页 CORS 预检
//（ModelScope 的 Anthropic 端点拒 anthropic-version/x-api-key 预检头即此因）。
//
// 覆盖两端：
// - content 侧 providerFetchViaOffscreen：ensure → connect → 出向载荷
//   （url/method/headers/body 原样）、回执合成标准 Response、ok:false 抛原始
//   文案（交 completion 包装）、signal 中止以 AbortError 拒绝且断开端口；
// - offscreen 侧 attachProviderHttpPort：URL 合法性预检（拒绝时不发 fetch）、
//   fetch 结果归一（{ok,status,body} / {ok:false,error}）、端口断连即 abort。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

type Receipt = { ok: boolean; status?: number; body?: string; error?: string };

interface FakePort {
  name: string;
  posted: unknown[];
  disconnectMock: Mock;
  send: (message: unknown) => void;
  fireDisconnect: () => void;
}

let fetchMock: Mock;
let connected: { name?: string }[];
let ensureCalls: number;
let sentRuntimeMessages: unknown[];
let replyFor: (message: unknown) => Receipt | undefined;
let lastPort: FakePort | null;

async function loadModule() {
  return import("../../extension/core/provider-http-offscreen.js");
}

// content 侧环境：ensure 消息计数 + connect 返回可手动驱动回执的假端口
function makeFakePort(name: string): FakePort {
  const messageListeners: Array<(message: unknown) => void> = [];
  const disconnectListeners: Array<() => void> = [];
  const port: FakePort = {
    name,
    posted: [],
    disconnectMock: vi.fn(),
    send: (message: unknown) => messageListeners.forEach((fn) => fn(message)),
    fireDisconnect: () => disconnectListeners.forEach((fn) => fn())
  };
  return Object.assign(port, {
    onMessage: {
      addListener: (fn: (message: unknown) => void) => messageListeners.push(fn),
      removeListener: () => {}
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.push(fn),
      removeListener: () => {}
    },
    postMessage: vi.fn((message: unknown) => {
      port.posted.push(message);
    }),
    disconnect: port.disconnectMock
  });
}

function stubChrome(overrides: Record<string, unknown> = {}) {
  const previous = globalThis.chrome;
  vi.stubGlobal("chrome", {
    ...previous,
    runtime: {
      ...(previous as { runtime?: object } | undefined)?.runtime,
      sendMessage: vi.fn((message: unknown, callback?: (response?: unknown) => void) => {
        sentRuntimeMessages.push(message);
        if ((message as { type?: string })?.type === "ensure-offscreen-chat") {
          ensureCalls += 1;
        }
        callback?.({ ok: true, ensured: true });
        return undefined;
      }),
      connect: vi.fn((info: { name?: string }) => {
        connected.push(info);
        const port = makeFakePort(String(info?.name || ""));
        lastPort = port;
        return port;
      })
    },
    ...overrides
  });
}

beforeEach(() => {
  resetModuleState();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "pong" }));
  vi.stubGlobal("fetch", fetchMock);
  connected = [];
  ensureCalls = 0;
  sentRuntimeMessages = [];
  lastPort = null;
  replyFor = () => ({ ok: true, status: 200, body: "pong" });
  stubChrome();
});

describe("providerFetchViaOffscreen（content 侧）", () => {
  it("先 ensure offscreen 文档，再连 provider-http-offscreen 端口", async () => {
    const { providerFetchViaOffscreen, PROVIDER_HTTP_OFFSCREEN_PORT_NAME } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(connected).toHaveLength(1));
    lastPort!.send(replyFor(null));
    await pending;

    expect(ensureCalls).toBe(1);
    expect(sentRuntimeMessages[0]).toEqual({ type: "ensure-offscreen-chat" });
    expect(connected[0]).toEqual({ name: PROVIDER_HTTP_OFFSCREEN_PORT_NAME });
  });

  it("出向载荷 = provider-http 端口消息（url/method/headers/body 原样，头键小写）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": "sk-1", "anthropic-version": "2023-06-01" },
      body: '{"model":"claude"}'
    });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200, body: "" });
    await pending;

    expect(lastPort!.posted[0]).toEqual({
      action: "provider-http",
      url: "https://api.example.com/v1/messages",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": "sk-1",
        "anthropic-version": "2023-06-01"
      },
      body: '{"model":"claude"}'
    });
  });

  it("合成标准 Response：status/ok/text/json 与回执一致", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send(replyFor(null));
    const resp = await pending;

    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
    expect(await resp.text()).toBe("pong");
  });

  it("非 2xx 也合成响应（HTTP 语义交给 completion 链）", async () => {
    replyFor = () => ({ ok: true, status: 500, body: "boom" });
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send(replyFor(null));
    const resp = await pending;

    expect(resp.status).toBe(500);
    expect(resp.ok).toBe(false);
  });

  it("回执 ok:false → 抛原始文案（交 completion 包装成「网络错误：…」）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: false, error: "请求地址不合法" });

    await expect(pending).rejects.toThrow("请求地址不合法");
  });

  it("成功后断开端口（offscreen 侧不留悬挂监听）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send(replyFor(null));
    await pending;

    expect(lastPort!.disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("signal 已中止 → 同步以 AbortError 拒绝，不发 ensure/connect", async () => {
    const { providerFetchViaOffscreen } = await loadModule();
    const controller = new AbortController();
    controller.abort();

    await expect(
      providerFetchViaOffscreen("https://api.example.com/v1/messages", {
        method: "POST",
        signal: controller.signal
      })
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(ensureCalls).toBe(0);
    expect(connected).toHaveLength(0);
  });

  it("等待中中止 → AbortError 且断开端口（offscreen 侧据此 abort 在飞请求）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();
    const controller = new AbortController();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", {
      method: "POST",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(lastPort!.disconnectMock).toHaveBeenCalledTimes(1);
  });

  it("回执前断连（offscreen 被回收 / 未被认领）→ 可读错误", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.fireDisconnect();

    await expect(pending).rejects.toThrow("代发通道已断开");
  });

  it("未中止的 signal 不干扰正常回包（落定后摘监听）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();
    const controller = new AbortController();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", {
      method: "POST",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send(replyFor(null));
    const resp = await pending;

    expect(resp.ok).toBe(true);
    controller.abort();
  });
});

describe("attachProviderHttpPort（offscreen 侧）", () => {
  it("出向 fetch 原样 + 回执透传 status 与响应体文本", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => '{"error":"bad key"}' });
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({
      action: "provider-http",
      url: "https://api-inference.modelscope.cn/v1/messages",
      method: "POST",
      headers: { "x-api-key": "sk-1", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: '{"model":"m"}'
    });

    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    expect(port.posted[0]).toEqual({ ok: true, status: 401, body: '{"error":"bad key"}' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-inference.modelscope.cn/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"model":"m"}');
    expect(init.headers["x-api-key"]).toBe("sk-1");
  });

  it("URL 非法（空 / 非 http(s)）→ 回执报错，不发 fetch", async () => {
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "chrome-extension://x/y", method: "POST" });

    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    expect(port.posted[0]).toEqual({ ok: false, error: "请求地址不合法" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch 抛错 → { ok:false, error }（文案经 completion 包装成「网络错误：…」）", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });

    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    expect(port.posted[0]).toEqual({ ok: false, error: "Failed to fetch" });
  });

  it("非 provider-http 动作 → 不 fetch 也不回执", async () => {
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "chat" });
    port.send(null);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(port.posted).toHaveLength(0);
  });

  it("端口断连 → abort 在飞 fetch（挂起的请求不留在 offscreen）", async () => {
    let seenSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: unknown, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          seenSignal = init.signal!;
          init.signal!.addEventListener("abort", () => reject(new Error("aborted")));
        })
    );
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });
    await vi.waitFor(() => expect(seenSignal).toBeTruthy());
    expect(seenSignal!.aborted).toBe(false);

    port.fireDisconnect();

    expect(seenSignal!.aborted).toBe(true);
  });
});
