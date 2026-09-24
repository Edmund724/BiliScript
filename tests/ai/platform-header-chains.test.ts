// 平台预设额外请求头在 content 侧两条 AI 链上的落地（Opencode Go 的
// x-opencode-session，规则与取值单源在 ai/preset-headers.ts）：对话与连通性探针
// 之外，选区解释（SW 代发）与概览（offscreen 代发）也必须带上——两条链的 provider
// 都出自 ai/active-provider.ts 的 resolveActiveProvider（带记录 presetId）。
//
// 用真 completion + 打桩传输层，断言到**出向载荷**的请求头，而不是断言 provider
// 字段：链路任意一段把平台身份丢掉（provider 重建、代发通道丢头）都会在这里红。

import { afterEach, describe, expect, it, vi } from "vitest";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// 活动平台记录（resolveActiveProvider 的产物形状）：presetId 是平台身份。
const PROVIDER = {
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "sk-test",
  model: "glm-5.1",
  presetId: "opencodego"
};

const BODY = [
  { from: 0, content: "我们习惯把语言视为空气" },
  { from: 10, content: "我们习惯将其视为传递信息的工具" }
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===== 解释链：content → SW 代发（core/provider-http.ts）=====

type ProviderHttpRequest = { type: string; url: string; headers: Record<string, string>; body: string };

function stubSwRelay() {
  const sent: ProviderHttpRequest[] = [];
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((message: ProviderHttpRequest, callback?: (resp?: unknown) => void) => {
        sent.push(message);
        callback?.({
          ok: true,
          status: 200,
          body: JSON.stringify({ choices: [{ message: { content: "解释文本" } }] })
        });
        return undefined;
      })
    }
  });
  return sent;
}

describe("选区解释链（SW 代发）", () => {
  it("出向载荷带 x-opencode-session（provider 的平台身份一路到请求头）", async () => {
    const sent = stubSwRelay();
    const { explainSelection } = await import("../../extension/ai/explain.js");

    const text = await explainSelection({
      provider: PROVIDER,
      videoTitle: "语言与权力",
      selection: "传递信息的工具",
      line: "我们习惯将其视为传递信息的工具",
      from: 10,
      body: BODY,
      index: 1
    });

    expect(text).toBe("解释文本");
    const payload = sent.find((message) => message.type === "provider-http");
    expect(payload?.url).toBe(`${PROVIDER.baseUrl}/chat/completions`);
    expect(payload?.headers["x-opencode-session"]).toMatch(UUID_V4);
    // 代发通道经 Headers 归一，头名小写
    expect(payload?.headers.authorization).toBe("Bearer sk-test");
  });
});

// ===== 概览链：content → offscreen 代发（core/provider-http-offscreen.ts）=====

type OffscreenRelayMessage = { action: string; url: string; headers: Record<string, string> };

function stubOffscreenRelay() {
  const posted: OffscreenRelayMessage[] = [];
  const listeners: Array<(reply: unknown) => void> = [];
  const port = {
    name: "provider-http-offscreen",
    postMessage: (payload: OffscreenRelayMessage) => {
      posted.push(payload);
      // 一请求一端口：立即回「响应头 → 正文 → done」，让 chatCompletion 收束
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ ok: true, status: 200 });
          listener({ ok: true, status: 200, chunk: 'data: {"choices":[{"delta":{"content":"概"}}]}\n\n' });
          listener({ ok: true, status: 200, done: true });
        }
      });
    },
    disconnect: vi.fn(),
    onMessage: { addListener: (listener: (reply: unknown) => void) => listeners.push(listener) },
    onDisconnect: { addListener: vi.fn() }
  };
  vi.stubGlobal("chrome", {
    runtime: {
      lastError: null,
      sendMessage: vi.fn((_message: unknown, callback?: (resp?: unknown) => void) => {
        callback?.({ ok: true });
        return undefined;
      }),
      connect: vi.fn(() => port)
    }
  });
  return posted;
}

describe("概览链（offscreen 代发）", () => {
  it("端口载荷带 x-opencode-session（与概览编排同一条 providerFetchViaOffscreen 缝）", async () => {
    const posted = stubOffscreenRelay();
    const { chatCompletion } = await import("../../extension/ai/completion.js");
    const { providerFetchViaOffscreen } = await import("../../extension/core/provider-http-offscreen.js");

    // 概览的单发/分段路径都把 fetchImpl 钉在这个函数上、stream: true（ai/analysis-orchestrate.ts）
    await chatCompletion({
      provider: PROVIDER,
      messages: [{ role: "user", content: "生成概览" }],
      stream: true,
      fetchImpl: providerFetchViaOffscreen
    });

    const payload = posted[0];
    expect(payload?.url).toBe(`${PROVIDER.baseUrl}/chat/completions`);
    expect(payload?.headers["x-opencode-session"]).toMatch(UUID_V4);
    // 代发通道经 Headers 归一，头名小写
    expect(payload?.headers.authorization).toBe("Bearer sk-test");
  });
});
