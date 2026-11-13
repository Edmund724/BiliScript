import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.doUnmock("../../extension/reader/lazy-shell.js");
  vi.restoreAllMocks();
});

describe("视频页伴看设置入口", () => {
  it("打开文摘面板并把 Gemini Key 定位目标交给阅读壳", async () => {
    const enterReaderShell = vi.fn(async () => {});
    vi.doMock("../../extension/reader/lazy-shell.js", () => ({
      ensureReaderShell: async () => ({ enterReaderShell })
    }));
    const session = await import("../../extension/live/live-companion-session.js");

    await session.openLiveCompanionSettings("gemini-key");

    expect(enterReaderShell).toHaveBeenCalledWith({
      readerUrl: "",
      intent: "open",
      settingsTarget: "gemini-key"
    });
  });

  it("浏览器全屏中先退出全屏，再打开可见的阅读设置", async () => {
    const fullscreenHost = document.createElement("div");
    Object.defineProperty(document, "fullscreenElement", { configurable: true, value: fullscreenHost });
    const exitFullscreen = vi.fn(async () => {
      Object.defineProperty(document, "fullscreenElement", { configurable: true, value: null });
    });
    Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
    const enterReaderShell = vi.fn(async () => {});
    vi.doMock("../../extension/reader/lazy-shell.js", () => ({
      ensureReaderShell: async () => ({ enterReaderShell })
    }));
    const session = await import("../../extension/live/live-companion-session.js");

    await session.openLiveCompanionSettings("live");

    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(enterReaderShell).toHaveBeenCalledWith({
      readerUrl: "",
      intent: "open",
      settingsTarget: "live"
    });
    expect(exitFullscreen.mock.invocationCallOrder[0]).toBeLessThan(enterReaderShell.mock.invocationCallOrder[0]);
  });
});
