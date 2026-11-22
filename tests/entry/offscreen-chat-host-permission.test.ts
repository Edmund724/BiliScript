import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_INVALID_ORIGIN_HINT, HOST_PERMISSION_HINT } from "../../extension/core/host-permissions.js";
import {
  SEARCH_COOLDOWN_NOTICE,
  SEARCH_NOT_CONFIGURED_NOTICE
} from "../../extension/search/search-runtime.js";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";
import { setupEnvironment } from "../setup.js";

const BASE_URL = "https://api.siliconflow.cn/v1";

let host: MinimalChromeHost;
let fetchMock: ReturnType<typeof vi.fn>;
let events: string[] = [];
let checkReply: unknown;
let searchReply: unknown = { ok: true };

function installHost() {
  setupEnvironment();
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    replies: {
      "resolve-ai-provider": () => {
        events.push("msg:resolve-ai-provider");
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
      },
      "check-provider-origin": () => {
        events.push("msg:check-provider-origin");
        return checkReply;
      },
      "resolve-search-provider": () => {
        events.push("msg:resolve-search-provider");
        return searchReply;
      }
    }
  });
}

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
  events = [];
  checkReply = { granted: true };
  searchReply = { ok: true };
  installHost();
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

async function runChatTurn(extra: Record<string, unknown> = {}) {
  const session = makeChatPort();
  expect(host.onConnectListeners).toHaveLength(1);
  host.onConnectListeners.at(-1)!(session.port);
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
    prompt: "总结一下",
    ...extra
  });
  return session;
}

function postedNotices(session: { port: { postMessage: ReturnType<typeof vi.fn> } }): string[] {
  return session.port.postMessage.mock.calls
    .map((call) => call[0] as { type?: string; data?: unknown } | null)
    .filter((message): message is { type?: string; data?: unknown } => message?.type === "notice")
    .map((message) => String(message.data || ""));
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

  it("provider.baseUrl 缺失或非法 → 显式失败，不发 check-provider-origin 也不发 fetch", async () => {
    vi.resetModules();
    events = [];
    checkReply = { granted: true, status: "granted" };
    searchReply = { ok: true };
    setupEnvironment();
    host = installMinimalChromeHost({
      preserveExisting: true,
      onConnect: true,
      replies: {
        "resolve-ai-provider": () => ({
          ok: true,
          provider: {
            id: "p1",
            presetId: "custom",
            name: "坏配置平台",
            baseUrl: "not-a-url",
            model: "deepseek-ai/DeepSeek-V3",
            enabled: true,
            requiresKey: true,
            hasSavedKey: true
          },
          apiKey: "sk-test"
        }),
        "check-provider-origin": () => {
          events.push("msg:check-provider-origin");
          return checkReply;
        },
        "resolve-search-provider": () => searchReply
      }
    });
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await import("../../extension/entry/offscreen.js");

    const session = await runChatTurn();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).not.toContain("msg:check-provider-origin");
    expect(postedErrors(session)).toEqual([expect.objectContaining({ error: HOST_INVALID_ORIGIN_HINT })]);
  });
});

describe("offscreen 对话链搜索运行时的未配置 notice（spec §10 第 10 行）", () => {
  it("keyless 无 Key（链非空、apiKey:''）→ 不弹「未配置搜索平台，本轮未联网」", async () => {
    await importOffscreen();
    searchReply = {
      ok: true,
      chain: [
        {
          provider: { id: "search_firecrawl", name: "Firecrawl", type: "firecrawl", baseUrl: "https://api.firecrawl.dev" },
          apiKey: ""
        }
      ],
      maxToolCalls: 2
    };

    const session = await runChatTurn({ webSearchEnabled: true });

    expect(events).toContain("msg:resolve-search-provider");
    expect(postedNotices(session).some((data) => data.includes("未配置搜索平台"))).toBe(false);
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });

  it("对照：chain 缺省（未配置）→ 仍弹该 notice（缺省分支未被动过）", async () => {
    await importOffscreen();
    searchReply = { ok: true };

    const session = await runChatTurn({ webSearchEnabled: true });

    expect(postedNotices(session)).toContain(SEARCH_NOT_CONFIGURED_NOTICE);
    expect(postedTypes(session)).toContain("done");
  });

  it("智能链合格记录全在冷却中 → 弹冷却专属文案，不误报「未配置」（spec §12.7 第 6 条翻案）", async () => {
    await importOffscreen();
    searchReply = { ok: true, chainEmptyReason: "cooldown" };

    const session = await runChatTurn({ webSearchEnabled: true });

    const notices = postedNotices(session);
    expect(notices).toContain(SEARCH_COOLDOWN_NOTICE);
    expect(notices.some((data) => data.includes("未配置搜索平台"))).toBe(false);
    expect(postedTypes(session)).toContain("done");
    expect(postedErrors(session)).toHaveLength(0);
  });
});
