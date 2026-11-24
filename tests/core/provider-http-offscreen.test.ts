import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { resetModuleState } from "../setup.js";
import { HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";

type Reply = { ok: boolean; status?: number; chunk?: string; done?: boolean; error?: string; accepted?: boolean };

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
let permissionGranted: boolean;
let lastPort: FakePort | null;

async function loadModule() {
  return import("../../extension/core/provider-http-offscreen.js");
}

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

async function flushAsync(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function rejectionOf(pending: Promise<Response>): Promise<Error> {
  return pending.then(
    () => new Error("预期失败但成功了"),
    (error: unknown) => error as Error
  );
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
        if ((message as { type?: string })?.type === "check-provider-origin") {
          callback?.({ granted: permissionGranted });
          return undefined;
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
  permissionGranted = true;
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
    expect(sentRuntimeMessages).toEqual([
      { type: "check-provider-origin", origin: "https://api.example.com/*" },
      { type: "ensure-offscreen-chat" }
    ]);
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
    const resp = await pending;

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

  it("signal 已中止 → 同步以 AbortError 拒绝，不发 ensure/预检/connect", async () => {
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
    expect(sentRuntimeMessages).toHaveLength(0);
    expect(connected).toHaveLength(0);
  });

  it("host 权限未授权 → 抛可操作提示，不发 ensure / 不连端口（与 SW 代发同口径）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();
    permissionGranted = false;

    await expect(
      providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" })
    ).rejects.toThrow(HOST_PERMISSION_HINT);

    expect(ensureCalls).toBe(0);
    expect(connected).toHaveLength(0);
    expect(sentRuntimeMessages).toEqual([
      { type: "check-provider-origin", origin: "https://api.example.com/*" }
    ]);
  });

  it("非法或缺失 URL → 直接拒绝，不发 check-provider-origin / ensure-offscreen-chat / 不连端口", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    await expect(
      providerFetchViaOffscreen("chrome-extension://x/y", { method: "POST" })
    ).rejects.toThrow("请求地址不合法");

    expect(ensureCalls).toBe(0);
    expect(connected).toHaveLength(0);
    expect(sentRuntimeMessages).toEqual([]);
  });

  it("host 权限已授权 → 照旧 ensure + connect（预检不改变成功路径）", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    lastPort!.send({ ok: true, status: 200, done: true });
    await resp.text();

    expect(ensureCalls).toBe(1);
    expect(connected).toHaveLength(1);
    expect(sentRuntimeMessages).toEqual([
      { type: "check-provider-origin", origin: "https://api.example.com/*" },
      { type: "ensure-offscreen-chat" }
    ]);
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
    await expect(reader.read()).rejects.toThrow("请求已中止");
  });

  it("首条回吐前断连 → 无盲等延迟直接重新 ensure 并重连一次（文档异常回收时自愈）", async () => {
    vi.useFakeTimers();
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
      await flushAsync();
      lastPort!.fireDisconnect();

      await flushAsync();
      expect(connected).toHaveLength(2);
      expect(ensureCalls).toBe(2);

      lastPort!.send({ ok: true, accepted: true });
      lastPort!.send({ ok: true, status: 200 });
      lastPort!.send({ ok: true, status: 200, chunk: "ok" });
      lastPort!.send({ ok: true, status: 200, done: true });
      expect(await (await pending).text()).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("两次都断在首条回吐前 → 报「代发通道已断开」", async () => {
    vi.useFakeTimers();
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
      const settled = rejectionOf(pending);
      await flushAsync();
      lastPort!.fireDisconnect();

      await flushAsync();
      expect(connected).toHaveLength(2);
      lastPort!.fireDisconnect();

      expect((await settled).message).toContain("代发通道已断开");
    } finally {
      vi.useRealTimers();
    }
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

  it("收到接管确认 → 通道判活，确认超时不再触发重连；确认本身不是响应头", async () => {
    vi.useFakeTimers();
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
      await flushAsync();
      expect(connected).toHaveLength(1);

      lastPort!.send({ ok: true, accepted: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(connected).toHaveLength(1);

      lastPort!.send({ ok: true, status: 200 });
      const resp = await pending;
      lastPort!.send({ ok: true, status: 200, chunk: "ok" });
      lastPort!.send({ ok: true, status: 200, done: true });
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("没有 ack 但直接回响应头（扩展重载后仍在的旧文档）→ 同样认账，不重连", async () => {
    vi.useFakeTimers();
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
      await flushAsync();
      lastPort!.send({ ok: true, status: 200 });
      const resp = await pending;
      lastPort!.send({ ok: true, status: 200, chunk: "pong" });
      lastPort!.send({ ok: true, status: 200, done: true });

      expect(await resp.text()).toBe("pong");
      await vi.advanceTimersByTimeAsync(5000);
      expect(connected).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("端口未被接管（无 ack、不断连）→ 确认超时后无盲等直接重连一次，第二次被接管即成功", async () => {
    vi.useFakeTimers();
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
      await flushAsync();
      const stray = lastPort!;

      await vi.advanceTimersByTimeAsync(2000);
      expect(stray.disconnectMock).toHaveBeenCalledTimes(1);

      await flushAsync();
      expect(connected).toHaveLength(2);

      lastPort!.send({ ok: true, accepted: true });
      lastPort!.send({ ok: true, status: 200 });
      lastPort!.send({ ok: true, status: 200, chunk: "ok" });
      lastPort!.send({ ok: true, status: 200, done: true });
      expect(await (await pending).text()).toBe("ok");
    } finally {
      vi.useRealTimers();
    }
  });

  it("两次都没被接管 → 以可读错误拒绝（不再无限挂起），两个端口都断开", async () => {
    vi.useFakeTimers();
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", { method: "POST" });
      const settled = rejectionOf(pending);
      await flushAsync();
      const first = lastPort!;

      await vi.advanceTimersByTimeAsync(2000);
      await flushAsync();
      expect(connected).toHaveLength(2);
      const second = lastPort!;

      await vi.advanceTimersByTimeAsync(2000);
      expect((await settled).message).toContain("代发通道无人接管");
      expect(first.disconnectMock).toHaveBeenCalled();
      expect(second.disconnectMock).toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(connected).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重连阶段 ensure 等待期间中止 → AbortError，不再发起第二次连接", async () => {
    vi.useFakeTimers();
    try {
      let resolveSecondEnsure!: () => void;
      let ensureAttempt = 0;
      stubChrome({
        runtime: {
          ...globalThis.chrome.runtime,
          sendMessage: vi.fn((message: unknown, callback?: (response?: unknown) => void) => {
            sentRuntimeMessages.push(message);
            const type = (message as { type?: string })?.type;
            if (type === "check-provider-origin") {
              callback?.({ granted: true });
              return undefined;
            }
            if (type === "ensure-offscreen-chat") {
              ensureCalls += 1;
              ensureAttempt += 1;
              if (ensureAttempt === 2) {
                resolveSecondEnsure = () => callback?.({ ok: true, ensured: true });
                return undefined;
              }
            }
            callback?.({ ok: true, ensured: true });
            return undefined;
          })
        }
      });

      const { providerFetchViaOffscreen } = await loadModule();
      const controller = new AbortController();

      const pending = providerFetchViaOffscreen("https://api.example.com/v1/messages", {
        method: "POST",
        signal: controller.signal
      });
      const settled = rejectionOf(pending);
      await flushAsync();

      await vi.advanceTimersByTimeAsync(2000);
      await flushAsync();
      controller.abort();
      resolveSecondEnsure();

      expect((await settled).name).toBe("AbortError");
      expect(connected).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("宿主 ReadableStream 构造抛 Firefox Xray 权限错时仍正常流式读取与 text() 消费", async () => {
    const prevReadableStream = globalThis.ReadableStream;
    const readableStreamStub = vi.fn(() => {
      throw new Error('Permission denied to access property "autoAllocateChunkSize"');
    });
    vi.stubGlobal("ReadableStream", readableStreamStub);
    try {
      const { providerFetchViaOffscreen } = await loadModule();

      const pendingStream = providerFetchViaOffscreen("https://api.example.com/v1/chat/completions", { method: "POST" });
      await vi.waitFor(() => expect(lastPort).toBeTruthy());
      lastPort!.send({ ok: true, status: 200 });
      const streamResp = await pendingStream;
      const reader = streamResp.body!.getReader();
      const decoder = new TextDecoder();

      lastPort!.send({ ok: true, status: 200, chunk: "data: a\n\n" });
      expect(decoder.decode((await reader.read()).value)).toBe("data: a\n\n");
      lastPort!.send({ ok: true, status: 200, done: true });
      expect((await reader.read()).done).toBe(true);

      const pendingText = providerFetchViaOffscreen("https://api.example.com/v1/chat/completions", { method: "POST" });
      await vi.waitFor(() => expect(connected).toHaveLength(2));
      lastPort!.send({ ok: true, status: 200 });
      const textResp = await pendingText;
      lastPort!.send({ ok: true, status: 200, chunk: "完整" });
      lastPort!.send({ ok: true, status: 200, chunk: "摘要" });
      lastPort!.send({ ok: true, status: 200, done: true });
      expect(await textResp.text()).toBe("完整摘要");

      expect(readableStreamStub).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("ReadableStream", prevReadableStream);
    }
  });

  it("消费端 reader.cancel() 释放端口并终止后续读取", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pending = providerFetchViaOffscreen("https://api.example.com/v1/chat/completions", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const resp = await pending;
    const reader = resp.body!.getReader();

    await reader.cancel();

    expect(lastPort!.disconnectMock).toHaveBeenCalledTimes(1);
    expect(await reader.read()).toEqual({ value: undefined, done: true });
  });

  it("支持 json() 解析且流中途报错拒绝未读缓冲而非吐出截断数据", async () => {
    const { providerFetchViaOffscreen } = await loadModule();

    const pendingJson = providerFetchViaOffscreen("https://api.example.com/v1/chat/completions", { method: "POST" });
    await vi.waitFor(() => expect(lastPort).toBeTruthy());
    lastPort!.send({ ok: true, status: 200 });
    const jsonResp = await pendingJson;
    lastPort!.send({ ok: true, status: 200, chunk: '{"ok":' });
    lastPort!.send({ ok: true, status: 200, chunk: "true}" });
    lastPort!.send({ ok: true, status: 200, done: true });
    expect(await jsonResp.json()).toEqual({ ok: true });

    const pendingErr = providerFetchViaOffscreen("https://api.example.com/v1/chat/completions", { method: "POST" });
    await vi.waitFor(() => expect(connected).toHaveLength(2));
    lastPort!.send({ ok: true, status: 200 });
    const errResp = await pendingErr;
    lastPort!.send({ ok: true, status: 200, chunk: "未消费的半截数据" });
    lastPort!.send({ ok: false, error: "truncated" });

    await expect(errResp.text()).rejects.toThrow("truncated");
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

    await vi.waitFor(() => expect(port.posted).toHaveLength(4));
    expect(port.posted).toEqual([
      { ok: true, accepted: true },
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

    await vi.waitFor(() => expect(port.posted).toHaveLength(3));
    expect(port.posted).toEqual([
      { ok: true, accepted: true },
      { ok: true, status: 204 },
      { ok: true, status: 204, done: true }
    ]);
  });

  it("URL 非法（空 / 非 http(s)）→ 先回接管确认再报错，不发 fetch（确认是派发活性，不是请求成败）", async () => {
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "chrome-extension://x/y", method: "POST" });

    await vi.waitFor(() => expect(port.posted).toHaveLength(2));
    expect(port.posted).toEqual([
      { ok: true, accepted: true },
      { ok: false, error: "请求地址不合法" }
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetch 抛错 → { ok:false, error }（文案经 completion 包装成「网络错误：…」）", async () => {
    fetchMock.mockRejectedValue(new Error("Failed to fetch"));
    const { attachProviderHttpPort } = await loadModule();
    const port = makeFakePort("provider-http-offscreen");

    attachProviderHttpPort(port as unknown as chrome.runtime.Port);
    port.send({ action: "provider-http", url: "https://api.example.com/v1/messages", method: "POST" });

    await vi.waitFor(() => expect(port.posted).toHaveLength(2));
    expect(port.posted[0]).toEqual({ ok: true, accepted: true });
    expect(port.posted[1]).toEqual({ ok: false, error: "Failed to fetch" });
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

    await vi.waitFor(() => expect(port.posted).toHaveLength(4));
    expect(port.posted).toEqual([
      { ok: true, accepted: true },
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
