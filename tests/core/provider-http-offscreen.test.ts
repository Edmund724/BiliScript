// core/provider-http-offscreen.ts 测试：概览链的平台请求代发（content 发起 →
// offscreen 文档执行）。
//
// 与 core/provider-http.ts（SW 代发）同形，差别只在承载者、超时/取消策略与
// 回吐形态：概览已改流式（网关对非流式长请求返回 500 Request timed out），
// offscreen 一律按「响应头 → 正文分片 → done」分块回吐，content 侧合成带
// ReadableStream body 的标准 Response——非流式调用方（.json()/.text()）行为不变，
// 流式调用方（response.body.getReader()）拿增量。SW 代发的 15s 超时
//（provider-http.ts:56）与 MV3 service worker 生命周期都不适用；offscreen 是
// 扩展源、不过网页 CORS 预检（ModelScope 的 Anthropic 端点拒 anthropic-version /
// x-api-key 预检头即此因）。
//
// 覆盖两端：
// - content 侧 providerFetchViaOffscreen：ensure → connect → 出向载荷
//   （url/method/headers/body 原样）、首条回吐即落定并合成标准 Response（status
//   正确、text() 得完整拼接、getReader() 得增量）、中途 ok:false 让读流抛错
//   （不得静默截断当成功）、ok:false 抛原始文案（交 completion 包装）、signal
//   中止以 AbortError 拒绝且断开端口；
// - offscreen 侧 attachProviderHttpPort：URL 合法性预检（拒绝时不发 fetch）、
//   回吐顺序（响应头 → 分片 → done）、多字节字符跨分片不破损、body 为 null 时
//   直接 done、fetch 抛错与读流中途失败归 { ok:false, error }、端口断连即 abort。

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";

// 端口回吐消息（offscreen → content，同一端口严格按序）：
// 响应头 { ok, status } → 分片 { ok, status, chunk } → 收束 { ok, status, done }；
// 失败一律只带 { ok:false, error }（响应头已发 = 中途失败）。
type Reply = { ok: boolean; status?: number; chunk?: string; done?: boolean; error?: string };

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
let lastPort: FakePort | null;

async function loadModule() {
  return import("../../extension/core/provider-http-offscreen.js");
}

// 手动推进的假响应体：按 chunks 顺序供 reader.read()，供完即 done。
function makeBody(chunks: Array<string | Uint8Array>) {
  const encoder = new TextEncoder();
  const parts = chunks.map((part) => (typeof part === "string" ? encoder.encode(part) : part));
  let index = 0;
  return {
    getReader: () => ({
      read: async () =>
        index < parts.length ? { value: parts[index++], done: false } : { value: undefined, done: true }
    })
  };
}

// content 侧环境：ensure 消息计数 + connect 返回可手动驱动回吐的假端口
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
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, body: makeBody(["pong"]) }));
  vi.stubGlobal("fetch", fetchMock);
  connected = [];
  ensureCalls = 0;
  sentRuntimeMessages = [];
  lastPort = null;
  stubChrome();
});

describe("providerFetchViaOffscreen（content 侧）", () => {
  it("先 ensure offscreen 文档，再连 provider-http-offscreen 端口", async () => {
    const { providerFetchViaOffscreen, PROVIDER_HTTP_OFFSCREEN_PORT_NAME } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(connected).toHaveLength(1));
    lastPort!.send({ ok: true, status: 200 });
    lastPort!.send({ ok: true, status: 200, done: true });
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
      body: '{"model":"claude","stream":true}'
    });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200, done: true });
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
      body: '{"model":"claude","stream":true}'
    });
  });

  it("首条回吐（响应头）即落定：status/ok 正确、text() 得完整拼接（非流式调用方行为不变）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending; // 不等正文：响应头到达即落定

    lastPort!.send({ ok: true, status: 200, chunk: "po" });
    lastPort!.send({ ok: true, status: 200, chunk: "ng" });
    lastPort!.send({ ok: true, status: 200, done: true });

    expect(resp.status).toBe(200);
    expect(resp.ok).toBe(true);
    expect(await resp.text()).toBe("pong");
  });

  it("非 2xx 也合成响应（HTTP 语义交给 completion 链）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 500 });
    const resp = await pending;

    expect(resp.status).toBe(500);
    expect(resp.ok).toBe(false);
  });

  it("readable body 按分片增量到达（不等 done 收束）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();

    lastPort!.send({ ok: true, status: 200, chunk: "甲" });
    expect(decoder.decode((await reader.read()).value)).toBe("甲");
    lastPort!.send({ ok: true, status: 200, chunk: "乙" });
    expect(decoder.decode((await reader.read()).value)).toBe("乙");

    lastPort!.send({ ok: true, status: 200, done: true });
    expect((await reader.read()).done).toBe(true);
  });

  it("流途中 ok:false → 读流抛原始文案（截断不得静默当成功）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    const reader = resp.body!.getReader();

    lastPort!.send({ ok: true, status: 200, chunk: "半句" });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("半句");
    lastPort!.send({ ok: false, error: "network error" });

    await expect(reader.read()).rejects.toThrow("network error");
  });

  it("首条回吐 ok:false → 抛原始文案（交 completion 包装成「网络错误：…」）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: false, error: "请求地址不合法" });

    await expect(pending).rejects.toThrow("请求地址不合法");
  });

  it("done 后断开端口（offscreen 侧不留悬挂监听）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    lastPort!.send({ ok: true, status: 200, done: true });
    await resp.text();

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

  it("流进行中中止 → 断开端口且读流立即抛错（offscreen 据此撤在飞请求）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();
    const controller = new AbortController();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", {
      method: "POST",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    const reader = resp.body!.getReader();

    controller.abort();

    expect(lastPort!.disconnectMock).toHaveBeenCalledTimes(1);
    // 挂起的读流不等 onDisconnect 回执也收束：消费侧据 signal.aborted 转中止
    await expect(reader.read()).rejects.toThrow("请求已中止");
  });

  it("首条回吐前断连（offscreen 被回收 / 未被认领）→ 可读错误", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.fireDisconnect();

    await expect(pending).rejects.toThrow("代发通道已断开");
  });

  it("流进行中断连 → 读流抛错（截断不得静默当成功）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    const reader = resp.body!.getReader();

    lastPort!.send({ ok: true, status: 200, chunk: "半句" });
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("半句");
    lastPort!.fireDisconnect();

    await expect(reader.read()).rejects.toThrow("代发通道已断开");
    // 断连后迟到的回吐分片：丢弃，不得对已出错的流 enqueue 抛 TypeError
    expect(() => lastPort!.send({ ok: true, status: 200, chunk: "迟到" })).not.toThrow();
  });

  it("未中止的 signal 不干扰正常回包（落定即摘监听）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();
    const controller = new AbortController();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", {
      method: "POST",
      signal: controller.signal
    });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    lastPort!.send({ ok: true, status: 200, chunk: "pong" });
    lastPort!.send({ ok: true, status: 200, done: true });

    expect(await resp.text()).toBe("pong");
    controller.abort();
  });
});

describe("attachProviderHttpPort（offscreen 侧）", () => {
  it("出向 fetch 原样 + 按「响应头 → 分片 → done」序回吐", async () => {
    fetchMock.mockResolvedValue({ status: 401, body: makeBody(['{"error":"bad key"}']) });
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({
      action: "provider-http",
      url: "https://api-inference.modelscope.cn/v1/messages",
      method: "POST",
      headers: { "x-api-key": "sk-1", "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: '{"model":"m","stream":true}'
    });

    await vi.waitFor(() => expect(port.posted).toHaveLength(3));
    expect(port.posted).toEqual([
      { ok: true, status: 401 },
      { ok: true, status: 401, chunk: '{"error":"bad key"}' },
      { ok: true, status: 401, done: true }
    ]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api-inference.modelscope.cn/v1/messages");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"model":"m","stream":true}');
    expect(init.headers["x-api-key"]).toBe("sk-1");
  });

  it("多字节字符跨 body 分片不破损（TextDecoder stream 模式，不得吐替换字符）", async () => {
    // "概览" = E6 A6 82 E8 A7 88：首片只给第一个字节（半截字符）
    const bytes = new TextEncoder().encode("概览");
    fetchMock.mockResolvedValue({ status: 200, body: makeBody([bytes.slice(0, 1), bytes.slice(1, 3), bytes.slice(3)]) });
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });

    await vi.waitFor(() => expect(port.posted.at(-1)).toEqual({ ok: true, status: 200, done: true }));
    const chunks = (port.posted as Reply[]).map((message) => message.chunk ?? "");
    expect(chunks.join("")).toBe("概览");
    expect(chunks.join("")).not.toContain("\uFFFD");
  });

  it("resp.body 为 null（如 204）→ 只回响应头与 done", async () => {
    fetchMock.mockResolvedValue({ status: 204, body: null });
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });

    await vi.waitFor(() => expect(port.posted).toHaveLength(2));
    expect(port.posted).toEqual([{ ok: true, status: 204 }, { ok: true, status: 204, done: true }]);
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

  it("读流中途失败（响应头已发）→ 补一条 { ok:false, error }，content 侧据此 error 掉读流", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      body: {
        getReader: () => {
          let reads = 0;
          return {
            read: async () => {
              reads += 1;
              if (reads === 1) {
                return { value: new TextEncoder().encode("半"), done: false };
              }
              throw new Error("network error");
            }
          };
        }
      }
    });
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });

    await vi.waitFor(() => expect(port.posted).toHaveLength(3));
    expect(port.posted).toEqual([
      { ok: true, status: 200 },
      { ok: true, status: 200, chunk: "半" },
      { ok: false, error: "network error" }
    ]);
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
