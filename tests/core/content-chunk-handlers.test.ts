import { describe, expect, it, vi } from "vitest";
import {
  ALLOWED_CONTENT_CHUNK_FILES,
  createContentChunkHandlers
} from "../../extension/core/content-chunk-handlers.js";
import type { MessageSender } from "../../extension/shared/messaging-protocol.js";

describe("content-chunk-handlers 静态白名单与发起方锁定", () => {
  it("允许白名单内分组注入，锁定 sender.tab.id 与 frameId 并忽略消息伪造字段", async () => {
    const executeScript = vi.fn(async () => []);
    const handlers = createContentChunkHandlers({
      scripting: { executeScript }
    });
    const sender: MessageSender = {
      tab: { id: 23, url: "https://www.bilibili.com/video/BV1xx" },
      frameId: 5
    };
    const reply = vi.fn();
    const spoofedMessage = {
      type: "content-chunk-load" as const,
      chunkId: "g-app",
      tabId: 999,
      frameId: 0
    };

    expect(handlers.load(spoofedMessage, sender, reply)).toBe("hold");
    await vi.waitFor(() => expect(reply).toHaveBeenCalledWith({ ok: true }));
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 23, frameIds: [5] },
      files: [...ALLOWED_CONTENT_CHUNK_FILES["g-app"]]
    });
  });

  it("未指定 frameId 时默认锁定主帧 [0]，且支持 g-shared、g-subtitle 与 g-live-room", async () => {
    const executeScript = vi.fn(async () => []);
    const handlers = createContentChunkHandlers({
      scripting: { executeScript }
    });
    const sender: MessageSender = {
      tab: { id: 31, url: "https://live.bilibili.com/6" }
    };

    const replyShared = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "g-shared" }, sender, replyShared)
    ).toBe("hold");
    await vi.waitFor(() => expect(replyShared).toHaveBeenCalledWith({ ok: true }));
    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 31, frameIds: [0] },
      files: [...ALLOWED_CONTENT_CHUNK_FILES["g-shared"]]
    });

    const replySubtitle = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "g-subtitle" }, sender, replySubtitle)
    ).toBe("hold");
    await vi.waitFor(() => expect(replySubtitle).toHaveBeenCalledWith({ ok: true }));
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 31, frameIds: [0] },
      files: [...ALLOWED_CONTENT_CHUNK_FILES["g-subtitle"]]
    });

    const replyLive = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "g-live-room" }, sender, replyLive)
    ).toBe("hold");
    await vi.waitFor(() => expect(replyLive).toHaveBeenCalledWith({ ok: true }));
    expect(executeScript).toHaveBeenNthCalledWith(3, {
      target: { tabId: 31, frameIds: [0] },
      files: [...ALLOWED_CONTENT_CHUNK_FILES["g-live-room"]]
    });
  });

  it("拒绝未知分组、原型链键名与非标签页发起方，不调用 executeScript", () => {
    const executeScript = vi.fn(async () => []);
    const handlers = createContentChunkHandlers({
      scripting: { executeScript }
    });
    const tabSender: MessageSender = { tab: { id: 11 }, frameId: 0 };

    const rUnknown = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "g-unknown" }, tabSender, rUnknown)
    ).toBe("answered");
    expect(rUnknown).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const rProto = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "__proto__" }, tabSender, rProto)
    ).toBe("answered");
    expect(rProto).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const rTraversal = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "../manifest.json" }, tabSender, rTraversal)
    ).toBe("answered");
    expect(rTraversal).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const rNoTab = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "g-app" }, {}, rNoTab)
    ).toBe("answered");
    expect(rNoTab).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    const rZeroTab = vi.fn();
    expect(
      handlers.load({ type: "content-chunk-load", chunkId: "g-app" }, { tab: { id: 0 } }, rZeroTab)
    ).toBe("answered");
    expect(rZeroTab).toHaveBeenCalledWith({ ok: false, error: expect.any(String) });

    expect(executeScript).not.toHaveBeenCalled();
  });

  it("executeScript 因宿主权限缺失报错时明确返回失败，不静默吞错或降级", async () => {
    const executeScript = vi.fn(async () => {
      throw new Error("Missing host permission for tab");
    });
    const handlers = createContentChunkHandlers({
      scripting: { executeScript }
    });
    const reply = vi.fn();

    expect(
      handlers.load(
        { type: "content-chunk-load", chunkId: "g-live-room" },
        { tab: { id: 44 }, frameId: 0 },
        reply
      )
    ).toBe("hold");
    await vi.waitFor(() =>
      expect(reply).toHaveBeenCalledWith({
        ok: false,
        error: "Missing host permission for tab"
      })
    );
  });
});
