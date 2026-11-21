import { afterEach, describe, expect, it, vi } from "vitest";
import { installChromeHost } from "../helpers/chrome-host.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

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
    expect(payload?.headers.authorization).toBe("Bearer sk-test");
  });
});

type OffscreenRelayMessage = { action: string; url: string; headers: Record<string, string> };

function stubOffscreenRelay() {
  const posted: OffscreenRelayMessage[] = [];
  const listeners: Array<(reply: unknown) => void> = [];
  const port = {
    name: "provider-http-offscreen",
    postMessage: (payload: OffscreenRelayMessage) => {
      posted.push(payload);
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

    await chatCompletion({
      provider: PROVIDER,
      messages: [{ role: "user", content: "生成概览" }],
      stream: true,
      fetchImpl: providerFetchViaOffscreen
    });

    const payload = posted[0];
    expect(payload?.url).toBe(`${PROVIDER.baseUrl}/chat/completions`);
    expect(payload?.headers["x-opencode-session"]).toMatch(UUID_V4);
    expect(payload?.headers.authorization).toBe("Bearer sk-test");
  });
});

describe("概览链整轮一个会话 id", () => {
  function stubOffscreenRelaySequence(renders: string[]): OffscreenRelayMessage[] {
    const posted: OffscreenRelayMessage[] = [];
    let requestIndex = -1;
    installChromeHost({
      runtime: {
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
    expect(posted).toHaveLength(2);
    const sessions = posted.map((payload) => payload.headers["x-opencode-session"]);
    expect(sessions[0]).toMatch(UUID_V4);
    expect(sessions[1]).toBe(sessions[0]);
  });
});
