import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../setup.js";

function clearPreloadGlobals(): void {
  const host = globalThis as Record<string, unknown>;
  delete host.__BILISCRIPT_SHARED_READY__;
  delete host.__BILISCRIPT_CHUNKS__;
  delete host.__BILISCRIPT_CHUNK_INFLIGHT__;
}

describe("ui/panel-preload: 按钮交互预注入 g-shared + g-app", () => {
  beforeEach(() => {
    resetModuleState();
    clearPreloadGlobals();
    document.body.innerHTML = "";
    setLocationUrl(NORMAL_PAGE_URL);
  });

  afterEach(() => {
    clearPreloadGlobals();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("pointerenter 与 focus 触发后按序预注入 g-shared 与 g-app 并复用 inflight 去重", async () => {
    const sentChunkIds: string[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
      message: { type?: string; chunkId?: string },
      callback?: (resp: unknown) => void
    ) => {
      if (message?.type === "content-chunk-load" && message.chunkId) {
        sentChunkIds.push(message.chunkId);
      }
      callback?.({ ok: true });
    }) as typeof chrome.runtime.sendMessage);

    const { bindPanelPreloadOnButton } = await import("../../extension/ui/panel-preload.js");
    const button = document.createElement("button");
    document.body.appendChild(button);

    bindPanelPreloadOnButton(button);
    bindPanelPreloadOnButton(button);
    expect(sentChunkIds).toEqual([]);

    button.dispatchEvent(new Event("pointerenter"));
    await vi.waitFor(() => expect(sentChunkIds).toEqual(["g-shared", "g-app"]));

    button.dispatchEvent(new Event("focus"));
    await Promise.resolve();
    expect(sentChunkIds).toEqual(["g-shared", "g-app"]);
    expect(document.head.querySelectorAll('link[rel="modulepreload"]')).toHaveLength(0);
  });

  it("非支持视频页或 g-app 已就绪时不发起预注入；预注入失败清理 inflight 允许后续重试", async () => {
    const sentChunkIds: string[] = [];
    vi.mocked(chrome.runtime.sendMessage).mockImplementation(((
      message: { type?: string; chunkId?: string },
      callback?: (resp: unknown) => void
    ) => {
      if (message?.type === "content-chunk-load" && message.chunkId) {
        sentChunkIds.push(message.chunkId);
        if (sentChunkIds.length === 1) {
          callback?.({ ok: false, error: "transient error" });
          return;
        }
      }
      callback?.({ ok: true });
    }) as typeof chrome.runtime.sendMessage);

    setLocationUrl("https://www.bilibili.com/");
    const mod = await import("../../extension/ui/panel-preload.js");
    mod.preloadReaderPanelChunks();
    expect(sentChunkIds).toEqual([]);

    setLocationUrl(NORMAL_PAGE_URL);
    mod.preloadReaderPanelChunks();
    await vi.waitFor(() => expect(sentChunkIds).toEqual(["g-shared"]));

    const host = globalThis as Record<string, unknown>;
    await vi.waitFor(() => {
      const inflight = host.__BILISCRIPT_CHUNK_INFLIGHT__ as Record<string, unknown>;
      expect(inflight["g-shared"]).toBeUndefined();
      expect(inflight["g-app"]).toBeUndefined();
    });

    mod.preloadReaderPanelChunks();
    await vi.waitFor(() => expect(sentChunkIds).toEqual(["g-shared", "g-shared", "g-app"]));

    (host.__BILISCRIPT_CHUNKS__ as Record<string, unknown>)["ui/ui-renderer.ts"] = {};
    mod.preloadReaderPanelChunks();
    await Promise.resolve();
    expect(sentChunkIds).toEqual(["g-shared", "g-shared", "g-app"]);
  });
});
