import { beforeEach, describe, expect, it, vi } from "vitest";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";
import { setupEnvironment } from "../setup.js";

const { runLadderChatMock } = vi.hoisted(() => ({ runLadderChatMock: vi.fn() }));

vi.mock("../../extension/ai/ladder.js", () => ({
  runLadderChat: runLadderChatMock
}));
vi.mock("../../extension/entry/offscreen-asr.js", () => ({
  createAsrDecodeHandler: vi.fn(() => vi.fn(async () => {}))
}));

const CONTEXT_KEY = "video:BV1body|101";
const BODY = [{ from: 0, to: 5, content: "第一句" }];

let host: MinimalChromeHost;

function installHost() {
  setupEnvironment();
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    offscreen: true,
    replies: {
      "resolve-ai-provider": () => ({
        ok: true,
        provider: { id: "p1", name: "测试平台", baseUrl: "https://api.example.com/v1", model: "m1", enabled: true, requiresKey: false, hasSavedKey: true },
        apiKey: "test-key"
      })
    }
  });
}

async function importOffscreen() {
  vi.resetModules();
  installHost();
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

function connectChat() {
  expect(host.onConnectListeners).toHaveLength(1);
  const session = makeChatPort();
  host.onConnectListeners.at(-1)!(session.port);
  return {
    port: session.port,
    send: (msg: unknown) => session.listeners.message[0](msg),
    flush: () => vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalled())
  };
}

beforeEach(() => {
  runLadderChatMock.mockReset();
});

describe("offscreen 聊天字幕体单槽缓存接线", () => {
  it("自带字幕体的消息 → 槽登记，回执统一附带 cachedContextKey", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "token", data: "x" });
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const session = connectChat();

    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: CONTEXT_KEY,
      context: { title: "长视频", subtitleBody: BODY },
      prompt: "总结"
    });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    const ladderMsg = runLadderChatMock.mock.calls[0][0].msg;
    expect(ladderMsg.context.subtitleBody).toBe(BODY);
    expect(ladderMsg.contextKey).toBe(CONTEXT_KEY);

    for (const call of session.port.postMessage.mock.calls) {
      expect(call[0].cachedContextKey).toBe(CONTEXT_KEY);
    }
  });

  it("未携带 + 槽 key 匹配 → 从槽补齐给 ladder，追问不再需要重传", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const session = connectChat();

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频" } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(2));

    const followupMsg = runLadderChatMock.mock.calls[1][0].msg;
    expect(followupMsg.context.subtitleBody).toBe(BODY);
  });

  it("未携带 + 槽 key 不匹配 → 字幕体缺失错误（不带 cachedContextKey），ladder 不再调", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const session = connectChat();

    session.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    session.send({ action: "chat", providerId: "p1", contextKey: "video:BV2|202", context: { title: "另一个视频" } });
    await vi.waitFor(() => expect(session.port.postMessage).toHaveBeenCalledTimes(2));

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(session.port.postMessage).toHaveBeenLastCalledWith({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
  });

  it("offscreen 文档重启（模块重载）后槽为空 → 未携带消息回缺失错误", async () => {
    runLadderChatMock.mockImplementation(async ({ port }) => {
      port.postMessage({ type: "done" });
    });
    await importOffscreen();
    const first = connectChat();
    first.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频", subtitleBody: BODY } });
    await vi.waitFor(() => expect(runLadderChatMock).toHaveBeenCalledTimes(1));

    await importOffscreen();
    const second = connectChat();
    second.send({ action: "chat", providerId: "p1", contextKey: CONTEXT_KEY, context: { title: "长视频" } });
    await vi.waitFor(() => expect(second.port.postMessage).toHaveBeenCalledTimes(1));

    expect(runLadderChatMock).toHaveBeenCalledTimes(1);
    expect(second.port.postMessage).toHaveBeenCalledWith({
      type: "error",
      error: "字幕体缺失，请重发一次",
      code: "subtitle-body-missing"
    });
  });
});
