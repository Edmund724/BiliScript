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

// 「概览整轮一个会话 id」的端到端口径：一轮概览会发出多次请求（分段并发逐段、
// 空正文加倍重试），x-opencode-session 必须同值——逐调用现造随机 id 会把同一轮
// 概览拆成多个会话（平台侧路由与 prompt 缓存都按会话走）。
describe("概览链整轮一个会话 id", () => {
  // 概览会落整份 / 分段缓存（chrome.storage.local）：内存实现避免缓存分支报错干扰。
  function memoryStorage() {
    const map = new Map<string, unknown>();
    return {
      get: vi.fn(async (keys: unknown) => {
        if (keys === null || keys === undefined) {
          return Object.fromEntries(map.entries());
        }
        const want = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(want.filter((k) => map.has(k as string)).map((k) => [k, map.get(k as string)]));
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        for (const [key, value] of Object.entries(items)) map.set(key, value);
      }),
      remove: vi.fn(async (keys: unknown) => {
        for (const key of Array.isArray(keys) ? keys : [keys]) map.delete(key as string);
      })
    };
  }

  // 第 N 次请求回不同流的代发桩（一次请求一个端口）：首代只吐思考（正文空 →
  // 触发空正文加倍重试），次代吐合法概览 JSON。
  function stubOffscreenRelaySequence(renders: string[]): OffscreenRelayMessage[] {
    const posted: OffscreenRelayMessage[] = [];
    const local = memoryStorage();
    let requestIndex = -1;
    vi.stubGlobal("chrome", {
      storage: { local },
      runtime: {
        lastError: null,
        sendMessage: vi.fn((_message: unknown, callback?: (resp?: unknown) => void) => {
          callback?.({ ok: true });
          return undefined;
        }),
        connect: vi.fn(() => {
          requestIndex += 1;
          const render = renders[Math.min(requestIndex, renders.length - 1)];
          const listeners: Array<(reply: unknown) => void> = [];
          return {
            name: "provider-http-offscreen",
            postMessage: (payload: OffscreenRelayMessage) => {
              posted.push(payload);
              queueMicrotask(() => {
                for (const listener of listeners) {
                  listener({ ok: true, status: 200 });
                  listener({ ok: true, status: 200, chunk: render });
                  listener({ ok: true, status: 200, done: true });
                }
              });
            },
            disconnect: vi.fn(),
            onMessage: { addListener: (listener: (reply: unknown) => void) => listeners.push(listener) },
            onDisconnect: { addListener: vi.fn() }
          };
        })
      }
    });
    return posted;
  }

  it("同一轮概览的多次请求带同一个 x-opencode-session", async () => {
    const chunk = (delta: Record<string, string>) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
    const posted = stubOffscreenRelaySequence([
      chunk({ reasoning_content: "把预算花在思考上" }),
      chunk({
        content: JSON.stringify({
          chapters: [{ title: "章1", timestampSeconds: 5, summary: "甲" }],
          keyQuotes: [{ quote: "金句1", timestampSeconds: 30 }]
        })
      })
    ]);
    const { runOverviewAnalysis } = await import("../../extension/ai/analysis.js");
    const { makeSubtitleBody } = await import("../setup.js");

    const analysis = await runOverviewAnalysis({
      provider: PROVIDER,
      context: {
        bvid: "BV1test",
        cid: "123",
        selectedSubtitleId: "sub-1",
        subtitleLang: "zh-CN",
        videoDuration: 300,
        subtitleBody: makeSubtitleBody(50000)
      },
      thinkingLevel: "off"
    });

    expect(analysis.chapters.map((item) => item.title)).toEqual(["章1"]);
    // 两次请求（空正文重试）都经 offscreen 代发，会话头同值
    expect(posted).toHaveLength(2);
    const sessions = posted.map((payload) => payload.headers["x-opencode-session"]);
    expect(sessions[0]).toMatch(UUID_V4);
    expect(sessions[1]).toBe(sessions[0]);
  });
});
