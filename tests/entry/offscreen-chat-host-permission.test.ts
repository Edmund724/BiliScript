// offscreen 对话链 host 权限预检（ADR-0010 残留收口）。
//
// 对话链的平台请求在 offscreen 内直发（ai/completion.ts 的默认 globalThis.fetch，
// 经 offscreen-chat 端口），而 offscreen 文档只有 chrome.runtime、查不了
// chrome.permissions——未授权落到 fetch 上只表现为「网络错误：Failed to fetch」，
// 用户看不出是权限问题（与 SW 代发通道 / 概览代发通道的口径不一致）。
// 本轮在链入口（entry/offscreen.ts 的 chat 消息处理器，resolveProviderWithKey 之后、
// 起空闲超时之前）补一层经 SW 代查的预检：未授权即以 HOST_PERMISSION_HINT 经 port
// error 回吐，且一个请求都不发。
//
// 不 mock ladder（真链路）+ promise 风格 sendMessage stub，手法沿
// offscreen-chat-presetid.test.js。

import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";

const BASE_URL = "https://api.siliconflow.cn/v1";

let onConnectListeners: Array<(port: chrome.runtime.Port) => void> = [];
let fetchMock: ReturnType<typeof vi.fn>;
// 消息与请求的到达顺序（跨两个 stub 共用）：断言预检发生在发请求之前
let events: string[] = [];
// check-provider-origin 的回包（undefined = 无回包，fail-open 用例）
let checkReply: unknown;

function stubChromeRuntime() {
  vi.stubGlobal("chrome", {
    runtime: {
      onConnect: {
        addListener: (fn: (port: chrome.runtime.Port) => void) => onConnectListeners.push(fn)
      },
      sendMessage: vi.fn(async (message: { type?: string }) => {
        events.push(`msg:${message?.type}`);
        if (message?.type === "resolve-ai-provider") {
          return {
            ok: true,
            provider: {
              id: "p1",
              presetId: "custom",
              name: "硅基流动",
              baseUrl: BASE_URL,
              model: "deepseek-ai/DeepSeek-V3",
              enabled: true,
              requiresKey: true,
              hasSavedKey: true
            },
            apiKey: "sk-test"
          };
        }
        if (message?.type === "check-provider-origin") {
          return checkReply;
        }
        return { ok: true };
      })
    }
  });
}

// 组装一条 OpenAI 兼容 SSE data: 行（对话链走流式）。
function sseData(delta: { content?: unknown }) {
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
  onConnectListeners = [];
  events = [];
  checkReply = { granted: true };
  stubChromeRuntime();
  fetchMock = vi.fn(async () => {
    events.push("fetch");
    return sseResponse([sseData({ content: "你好" }), "data: [DONE]\n\n"]);
  });
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

// 连一条聊天端口并完整跑完一轮（监听器本身是 async：await 即等到本轮收尾）。
async function runChatTurn() {
  const session = makeChatPort();
  expect(onConnectListeners).toHaveLength(1);
  onConnectListeners[0](session.port);
  await session.listeners.message[0]({
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
  return session;
}

function postedTypes(session: { port: { postMessage: ReturnType<typeof vi.fn> } }): Array<string | undefined> {
  return session.port.postMessage.mock.calls.map((call) => (call[0] as { type?: string } | null)?.type);
}

function postedErrors(session: { port: { postMessage: ReturnType<typeof vi.fn> } }): Array<{ type?: string; error?: unknown }> {
  return session.port.postMessage.mock.calls
    .map((call) => call[0] as { type?: string; error?: unknown } | null)
    .filter((message): message is { type?: string; error?: unknown } => message?.type === "error");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("offscreen 对话链 host 权限预检", () => {
  it("未授权（SW 回 { granted: false }）→ port 回可操作文案，一个请求都不发", async () => {
    await importOffscreen();
    checkReply = { granted: false };

    const session = await runChatTurn();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(postedErrors(session)).toEqual([expect.objectContaining({ error: HOST_PERMISSION_HINT })]);
    // 预检在发请求之前：代查消息排在 provider 解析之后、且没有任何 fetch
    expect(events).toContain("msg:check-provider-origin");
    expect(events.indexOf("msg:check-provider-origin")).toBeGreaterThan(events.indexOf("msg:resolve-ai-provider"));
  });

  it("已授权（{ granted: true }）→ 照常走完一轮（预检不改变既有成功路径）", async () => {
    await importOffscreen();
    checkReply = { granted: true };

    const session = await runChatTurn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events.indexOf("msg:check-provider-origin")).toBeLessThan(events.indexOf("fetch"));
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });

  it("无回包（旧 SW 不认识这条消息）→ fail-open，不新造拦截面", async () => {
    await importOffscreen();
    checkReply = undefined;

    const session = await runChatTurn();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });
});
