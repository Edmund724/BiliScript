import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FRAME_TIMEOUT_MS,
  connectWebSocket,
  requestDaemon,
  startDaemon
} from "../../skills/biliscript/scripts/biliscript.mjs";

let cleanup = async () => {};

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanup();
  cleanup = async () => {};
});

describe("Agent Bridge Daemon 截帧生命周期", () => {
  it("默认 frameTimeoutMs 为 95_000 毫秒并作用于未显式覆盖的 Daemon", async () => {
    expect(DEFAULT_FRAME_TIMEOUT_MS).toBe(95_000);
    const port = 24000 + Math.floor(Math.random() * 1000);
    const server = await startDaemon({ port });
    const extension = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"a".repeat(32)}`
    });
    cleanup = async () => {
      extension.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    extension.onMessage = (message: { type?: string; id?: string; command?: string }) => {
      if (message.type !== "request" || message.command !== "frame") return;
      extension.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: {
          bvid: "BV1test000000",
          cid: "100",
          frames: [{ data: "/9j/2Q==", anchorTime: 10, targetTime: 10, currentTime: 10 }]
        }
      });
    };

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const response = await requestDaemon("frame", {
      port,
      options: { bvid: "BV1test000000", times: [10], targetTime: 10, spanSeconds: 0 },
      timeoutMs: 2000
    });
    expect(response).toMatchObject({ bvid: "BV1test000000" });
    expect(setTimeoutSpy.mock.calls.some((call) => call[1] === 95_000)).toBe(true);
  });

  it("扩展不回包时超时返回，后续截帧仍可执行", async () => {
    const port = 24000 + Math.floor(Math.random() * 1000);
    const server = await startDaemon({ port, frameTimeoutMs: 50 });
    const extension = await connectWebSocket({
      port,
      protocol: "biliscript-extension-v1",
      origin: `chrome-extension://${"a".repeat(32)}`
    });
    cleanup = async () => {
      extension.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
    const requests: string[] = [];
    extension.onMessage = (message: { type?: string; id?: string; command?: string }) => {
      if (message.type !== "request" || message.command !== "frame") return;
      requests.push(String(message.id));
      if (requests.length === 1) return;
      extension.sendJSON({
        type: "response",
        id: message.id,
        ok: true,
        result: { bvid: "BV1test000000", cid: "100", frames: [] }
      });
    };

    const firstRequest = {
      port,
      options: { bvid: "BV1test000000", times: [10], targetTime: 10, spanSeconds: 0 },
      timeoutMs: 500
    };
    await expect(requestDaemon("frame", firstRequest)).rejects.toThrow("视频截帧超时");

    const secondRequest = {
      port,
      options: { bvid: "BV1test000000", times: [20, 40], targetTime: 20, spanSeconds: 0 },
      timeoutMs: 500
    };
    await expect(requestDaemon("frame", secondRequest)).resolves.toMatchObject({ bvid: "BV1test000000" });
    expect(requests).toHaveLength(2);
  });
});
