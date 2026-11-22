import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMinimalChromeHost, type MinimalChromeHost } from "../helpers/chrome-runtime-host.js";
import { setupEnvironment } from "../setup.js";

const { chatCompletionMock } = vi.hoisted(() => ({ chatCompletionMock: vi.fn() }));

vi.mock("../../extension/ai/completion.js", async (importOriginal) => ({
  ...(await importOriginal()),
  chatCompletion: chatCompletionMock
}));

function makeBody() {
  return Array.from({ length: 2600 }, (_, i) => ({
    from: i * 4,
    to: i * 4 + 4,
    content: "字".repeat(80)
  }));
}

let host: MinimalChromeHost;

function installHost() {
  setupEnvironment();
  host = installMinimalChromeHost({
    preserveExisting: true,
    onConnect: true,
    offscreen: true,
    storage: true,
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
  installHost();
  return import("../../extension/entry/offscreen.js");
}

function connectChat() {
  expect(host.onConnectListeners).toHaveLength(1);
  let onMessageListener: ((message: unknown) => void) | undefined;
  const port = {
    name: "offscreen-chat",
    onMessage: {
      addListener: (fn: (message: unknown) => void) => {
        onMessageListener = fn;
      },
      removeListener: () => {}
    },
    onDisconnect: {
      addListener: (fn: () => void) => {},
      removeListener: () => {}
    },
    postMessage: vi.fn(),
    disconnect: vi.fn()
  };
  host.onConnectListeners.at(-1)!(port as unknown as chrome.runtime.Port);
  return {
    port,
    send: (msg: unknown) => onMessageListener!(msg)
  };
}

async function flushThroughChatCall(session: ReturnType<typeof connectChat>) {
  for (let i = 0; i < 50 && chatCompletionMock.mock.calls.length === 0; i++) {
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(chatCompletionMock.mock.calls.length).toBeGreaterThan(0);
}

beforeEach(async () => {
  chatCompletionMock.mockReset();
  await import("../../extension/ai/ladder.js");
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Map-Reduce 编排期间空闲超时暂停（回归）", () => {
  it("段调用（非流式）挂起远超 90 秒 → 不再出现空闲超时中止，运行保持等待", async () => {
    chatCompletionMock.mockImplementation(({ signal }) => {
      return new Promise((_, reject) => {
        if (signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { aborted: true }));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { aborted: true }));
        });
      });
    });

    await importOffscreen();
    const session = connectChat();
    session.send({
      action: "chat",
      providerId: "p1",
      contextKey: "video:BV1idle90|101",
      context: { title: "七小时长视频", subtitleBody: makeBody() },
      prompt: "总结"
    });

    for (let i = 0; i < 50; i++) {
      await vi.advanceTimersByTimeAsync(1);
      if (session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")) break;
    }
    expect(session.port.postMessage.mock.calls.some((c) => c[0]?.type === "cost-guard")).toBe(true);
    session.send({ action: "cost-guard-confirm", ok: true });

    await flushThroughChatCall(session);

    await vi.advanceTimersByTimeAsync(90_000);
    await vi.advanceTimersByTimeAsync(90_000);

    const posted = session.port.postMessage.mock.calls.map((c) => c[0]);
    expect(posted.some((m) => m?.type === "error" && String(m.error || "").includes("请求超时"))).toBe(false);
    expect(posted.some((m) => m?.type === "stopped")).toBe(false);
  });
});
