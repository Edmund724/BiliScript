import { afterEach, describe, expect, it } from "vitest";
import {
  connectWebSocket,
  requestDaemon,
  startDaemon
} from "../../skills/biliscript/scripts/biliscript.mjs";

let cleanup = async () => {};

afterEach(async () => {
  await cleanup();
  cleanup = async () => {};
});

describe("Agent Bridge Daemon 截帧生命周期", () => {
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
      options: { bvid: "BV1test000000", targetTime: 10 },
      timeoutMs: 500
    };
    await expect(requestDaemon("frame", firstRequest)).rejects.toThrow("视频截帧超时");

    const secondRequest = {
      port,
      options: { bvid: "BV1test000000", targetTime: 20 },
      timeoutMs: 500
    };
    await expect(requestDaemon("frame", secondRequest)).resolves.toMatchObject({ bvid: "BV1test000000" });
    expect(requests).toHaveLength(2);
  });
});
