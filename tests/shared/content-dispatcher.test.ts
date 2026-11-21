import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

const SLOT_KEY = "__BILISCRIPT_CONTENT_SCRIPT_DISPATCHER__";

describe("shared/messaging 页内分发原语", () => {
  beforeEach(() => {
    resetModuleState();
    delete (globalThis as Record<string, unknown>)[SLOT_KEY];
  });

  it("未注册时分发返回 false，globalThis 槽为空", async () => {
    const { dispatchContentScriptMessage } = await import("../../extension/shared/messaging.js");
    expect(dispatchContentScriptMessage({ type: "reader-enter" }, () => {})).toBe(false);
    expect((globalThis as Record<string, unknown>)[SLOT_KEY]).toBeUndefined();
  });

  it("注册写入 globalThis 槽，分发经槽路由到分发主体", async () => {
    const { registerContentScriptDispatcher, dispatchContentScriptMessage } = await import(
      "../../extension/shared/messaging.js"
    );
    const dispatcher = vi.fn(() => true);
    registerContentScriptDispatcher(dispatcher);
    expect((globalThis as Record<string, unknown>)[SLOT_KEY]).toBe(dispatcher);
    const sendResponse = vi.fn();
    const message = { type: "reader-enter", readerUrl: "https://www.bilibili.com/video/BV1?biliscript_reader=1" };
    expect(dispatchContentScriptMessage(message, sendResponse)).toBe(true);
    expect(dispatcher).toHaveBeenCalledWith(message, sendResponse);
  });
});
