// offscreen.js 对话链会话头穿线测试（Opencode Go 的 x-opencode-session，见
// ai/preset-headers.ts）：宿主随 chat 消息带的 conversationId 经
// runLadderChat → streamChat → chatCompletion 抵达唯一 fetch 点，转成会话头；
// 同一会话的请求共用同一个 id，新会话换新 id，未携带时也不缺该头（现造一个）。
//
// 不 mock ladder（真链路），只 stub globalThis.fetch 与 chrome.runtime.sendMessage。
// chrome 依赖 mock 与「vi.resetModules + 动态导入 = 文档纪元」手法沿
// offscreen-chat-presetid.test.js。

import { afterEach, describe, expect, it, vi } from "vitest";

let onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;

const BASE_URL = "https://opencode.ai/zen/go/v1";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: {
        addListener: (fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn)
      },
      sendMessage: vi.fn(async (message) => {
        if (message?.type === "resolve-ai-provider") {
          return {
            ok: true,
            provider: {
              id: "p1",
              presetId: "opencodego",
              name: "Opencode Go",
              baseUrl: BASE_URL,
              model: "glm-5.1",
              enabled: true,
              requiresKey: true,
              hasSavedKey: true
            },
            apiKey: "test-key"
          };
        }
        return { ok: true };
      })
    },
    offscreen: {
      closeDocument: vi.fn(async () => {})
    }
  });
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
  onConnectListeners = [];
  stubChromeRuntime();
  fetchMock = vi.fn(async () =>
    sseResponse([`data: ${JSON.stringify({ choices: [{ delta: { content: "你好" } }] })}\n\n`, "data: [DONE]\n\n"])
  );
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offscreen 对话链会话头穿线", () => {
  it("conversationId → x-opencode-session：同会话恒同值、新会话换新值、缺失也有值", async () => {
    await importOffscreen();
    const session = makeChatPort();
    expect(onConnectListeners).toHaveLength(1);
    onConnectListeners[0](session.port);
    const onMessage = session.listeners.message[0];

    const send = (conversationId?: string) =>
      onMessage({
        action: "chat",
        providerId: "p1",
        ...(conversationId ? { conversationId } : {}),
        context: {
          title: "测试视频",
          bvid: "BV1test000000",
          cid: "1000",
          subtitleBody: [{ from: 0, to: 5, content: "第一句话" }]
        },
        prompt: "总结一下"
      });

    await send("conv_e2e_1");
    await send("conv_e2e_1");
    await send("conv_e2e_2");
    await send();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const headers = fetchMock.mock.calls.map(([, init]) => (init as { headers: Record<string, string> }).headers);
    for (const [url] of fetchMock.mock.calls) {
      expect(url).toBe(`${BASE_URL}/chat/completions`);
    }
    // 同一会话的两轮共用同一个会话 id（平台据此做路由与 prompt 缓存）
    expect(headers[0]["x-opencode-session"]).toMatch(UUID_V4);
    expect(headers[1]["x-opencode-session"]).toBe(headers[0]["x-opencode-session"]);
    expect(headers[2]["x-opencode-session"]).not.toBe(headers[0]["x-opencode-session"]);
    // 旧宿主不携带 conversationId 也不缺该头（preset-headers 现造一个随机 id）
    expect(headers[3]["x-opencode-session"]).toMatch(UUID_V4);
    expect(headers[3]["x-opencode-session"]).not.toBe(headers[0]["x-opencode-session"]);
    // 鉴权头不受影响
    expect(headers[0].Authorization).toBe("Bearer test-key");
  });
});
