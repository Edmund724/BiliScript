import { afterEach, describe, expect, it, vi } from "vitest";
import { sendMessageToTab } from "../../extension/shared/tab-utils.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("shared/tab-utils sendMessageToTab", () => {
  it("正常回包：按 ContentScriptMessage 透传响应", async () => {
    const sendMessage = vi.fn((_tabId: number, _message: unknown, cb: (resp: unknown) => void) => {
      cb({ ok: true });
    });
    vi.stubGlobal("chrome", {
      runtime: { lastError: null },
      tabs: { sendMessage }
    });

    await expect(sendMessageToTab(7, { type: "reader-close" })).resolves.toEqual({ ok: true });
    expect(sendMessage).toHaveBeenCalledWith(7, { type: "reader-close" }, expect.any(Function));
  });

  it("chrome.runtime.lastError 存在时以错误消息 reject", async () => {
    const sendMessage = vi.fn((_tabId: number, _message: unknown, cb: (resp: unknown) => void) => {
      cb(undefined);
    });
    vi.stubGlobal("chrome", {
      runtime: { lastError: { message: "Receiving end does not exist." } },
      tabs: { sendMessage }
    });

    await expect(sendMessageToTab(7, { type: "agent-bridge-snapshot" })).rejects.toThrow(
      "Receiving end does not exist."
    );
  });

  it("tabs.sendMessage 同步抛错时在 Promise 内 reject 而不外泄同步异常", async () => {
    const sendMessage = vi.fn(() => {
      throw new Error("tab closed");
    });
    vi.stubGlobal("chrome", {
      runtime: { lastError: null },
      tabs: { sendMessage }
    });

    await expect(sendMessageToTab(9, { type: "agent-bridge-subtitles" })).rejects.toThrow("tab closed");
  });
});
