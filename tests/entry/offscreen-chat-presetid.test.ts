import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";

let host: MinimalChromeHost;
let fetchMock: ReturnType<typeof vi.fn>;

const PROXY_BASE_URL = "https://thinking-proxy.example.com/v1";

function installHost() {
  host = installMinimalChromeHost({
    onConnect: true,
    offscreen: true,
    replies: {
      "resolve-ai-provider": () => ({
        ok: true,
        provider: {
          id: "p1",
          presetId: "ollama",
          name: "本地 Ollama",
          baseUrl: PROXY_BASE_URL,
          model: "llama3.2",
          enabled: true,
          requiresKey: false,
          hasSavedKey: true
        },
        apiKey: "test-key"
      })
    }
  });
}

function sseData(delta: { reasoning_content?: unknown; content?: unknown; tool_calls?: unknown }) {
  return `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
}

function sseResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (i < chunks.length) {
              return { value: encoder.encode(chunks[i++]), done: false };
            }
            return { done: true };
          }
        };
      }
    }
  };
}

async function importOffscreen() {
  vi.resetModules();
  installHost();
  fetchMock = vi.fn(async () => sseResponse([sseData({ content: "你好" }), "data: [DONE]\n\n"]));
  vi.stubGlobal("fetch", fetchMock);
  return import("../../extension/entry/offscreen.js");
}

function makeChatPort() {
  const listeners: { message: Array<(msg: unknown) => void>; disconnect: Array<() => void> } = { message: [], disconnect: [] };
  return {
    port: {
      name: "offscreen-chat",
      onMessage: {
        addListener: (fn: (msg: unknown) => void) => listeners.message.push(fn),
        removeListener: (fn: (msg: unknown) => void) => {}
      },
      onDisconnect: {
        addListener: (fn: () => void) => listeners.disconnect.push(fn),
        removeListener: (fn: () => void) => {}
      },
      postMessage: vi.fn(),
      disconnect: vi.fn()
    },
    listeners
  };
}

beforeEach(() => {});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offscreen 对话链 presetId 穿线", () => {
  it("resolveProviderWithKey 带回 presetId → 对话请求体按 preset 平台规则出 reasoning_effort（host 反代无规则也命中）", async () => {
    await importOffscreen();
    const session = makeChatPort();
    expect(host.onConnectListeners).toHaveLength(1);
    host.onConnectListeners.at(-1)!(session.port);

    const onMessage = session.listeners.message[0];
    await onMessage({
      action: "chat",
      providerId: "p1",
      thinkingLevel: "off",
      context: {
        title: "测试视频",
        bvid: "BV1test000000",
        cid: "1000",
        subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
      },
      prompt: "总结一下"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${PROXY_BASE_URL}/chat/completions`);
    expect(JSON.parse(init.body)).toMatchObject({
      model: "llama3.2",
      stream: true,
      reasoning_effort: "none"
    });
    const types = session.port.postMessage.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain("done");
  });

  it("评论工具按当前对话 context.aid 拉取并回填，不依赖当前页面", async () => {
    await importOffscreen();
    const modelBodies: Array<{ messages?: Array<{ role?: string; content?: string }>; tools?: unknown[] }> = [];
    fetchMock.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      if (String(url).startsWith("https://api.bilibili.com/x/v2/reply/main")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: {
              replies: [{ rpid: 1, member: { uname: "观众甲" }, like: 88, content: { message: "历史视频的热评" } }],
              top_replies: []
            }
          })
        };
      }
      modelBodies.push(JSON.parse(init!.body!));
      if (modelBodies.length === 1) {
        return sseResponse([
          `data: ${JSON.stringify({
            choices: [{
              delta: { tool_calls: [{ index: 0, id: "comment_1", type: "function", function: { name: "fetch_hot_comments", arguments: "{}" } }] },
              finish_reason: "tool_calls"
            }]
          })}\n\n`
        ]);
      }
      return sseResponse([sseData({ content: "评论回答" }), "data: [DONE]\n\n"]);
    });

    const session = makeChatPort();
    host.onConnectListeners.at(-1)!(session.port);
    await session.listeners.message[0]({
      action: "chat",
      providerId: "p1",
      thinkingLevel: "off",
      context: {
        title: "置顶历史视频",
        aid: "987654",
        bvid: "BV1history000",
        cid: "1000",
        subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
      },
      prompt: "评论区在讨论什么"
    });

    expect(String(fetchMock.mock.calls[1][0])).toContain("oid=987654");
    expect(modelBodies[0].tools).toEqual([
      expect.objectContaining({ function: expect.objectContaining({ name: "fetch_hot_comments" }) })
    ]);
    expect(modelBodies[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "tool",
        tool_call_id: "comment_1",
        content: JSON.stringify([{ uname: "观众甲", like: 88, message: "历史视频的热评" }])
      })
    ]));
    expect(session.port.postMessage.mock.calls.map((c) => c[0]?.type)).toContain("done");
  });
});
