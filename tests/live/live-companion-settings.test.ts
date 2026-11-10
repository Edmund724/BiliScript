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
});
