// tests/core/save-settings-handler.test.ts
// core/save-settings-handler.ts（save-settings SW 端 handler 工厂）与
// search/search-opt-out.ts（撤回判据纯函数 + 撤回钩子）的行为契约：
//   - 撤回只在 webSearchEnabled true→false 时触发，且先判（保存前快照）后写、
//     钩子跟在落盘之后；
//   - 落盘失败回 { ok:false, error } 信封，钩子不执行；
//   - 撤回钩子清空失败静默（logWarn），不阻断保存回包；
//   - isSearchOptOut：true→false / false→false / payload 非 false / 缺键。

import { describe, expect, it, vi } from "vitest";
import { createSaveSettingsHandler } from "../../extension/core/save-settings-handler.js";
import { createSearchOptOutHook, isSearchOptOut } from "../../extension/search/search-opt-out.js";

function callSave(
  handler: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => void,
  message: unknown
) {
  return new Promise<unknown>((resolve) => {
    handler(message, {}, (response) => resolve(response));
  });
}

describe("isSearchOptOut（撤回判据纯函数）", () => {
  it("true→false 才是撤回；false→false、true→true、缺键、非 false 值都不是", () => {
    expect(isSearchOptOut(true, { webSearchEnabled: false })).toBe(true);
    expect(isSearchOptOut(false, { webSearchEnabled: false })).toBe(false);
    expect(isSearchOptOut(true, { webSearchEnabled: true })).toBe(false);
    expect(isSearchOptOut(true, {})).toBe(false);
    expect(isSearchOptOut(true, { webSearchEnabled: "false" })).toBe(false);
    expect(isSearchOptOut(true, null)).toBe(false);
    expect(isSearchOptOut(true, undefined)).toBe(false);
  });
});

describe("createSaveSettingsHandler（save-settings 编排）", () => {
  it("撤回（true→false）：先取保存前快照判定，落盘后调撤回钩子", async () => {
    const order: string[] = [];
    const saveSettingsWithInvalidate = vi.fn(async () => {
      order.push("save");
    });
    const getSettingsSnapshot = vi.fn(async () => {
      order.push("read");
      return { webSearchEnabled: true };
    });
    const onSearchOptOut = vi.fn(async () => {
      order.push("opt-out");
    });
    const handler = createSaveSettingsHandler({ saveSettingsWithInvalidate, getSettingsSnapshot, onSearchOptOut });

    const response = await callSave(handler, { type: "save-settings", settings: { webSearchEnabled: false } });

    expect(response).toEqual({ ok: true });
    expect(order).toEqual(["read", "save", "opt-out"]);
    expect(saveSettingsWithInvalidate).toHaveBeenCalledWith({ webSearchEnabled: false });
  });

  it("非撤回保存（false→false / 缺键）：只落盘，不调钩子", async () => {
    const onSearchOptOut = vi.fn(async () => {});
    const saveSettingsWithInvalidate = vi.fn(async () => {});
    const handler = createSaveSettingsHandler({
      saveSettingsWithInvalidate,
      getSettingsSnapshot: async () => ({ webSearchEnabled: false }),
      onSearchOptOut
    });

    await callSave(handler, { type: "save-settings", settings: { webSearchEnabled: false, aiThinkingLevel: "high" } });
    await callSave(handler, { type: "save-settings", settings: { aiThinkingLevel: "high" } });

    expect(saveSettingsWithInvalidate).toHaveBeenCalledTimes(2);
    expect(onSearchOptOut).not.toHaveBeenCalled();
  });

  it("落盘失败：回 { ok:false, error } 信封，撤回钩子不执行", async () => {
    const onSearchOptOut = vi.fn(async () => {});
    const handler = createSaveSettingsHandler({
      saveSettingsWithInvalidate: vi.fn(async () => {
        throw new Error("storage quota");
      }),
      getSettingsSnapshot: async () => ({ webSearchEnabled: true }),
      onSearchOptOut
    });

    const response = await callSave(handler, { type: "save-settings", settings: { webSearchEnabled: false } });

    expect(response).toEqual({ ok: false, error: "storage quota" });
    expect(onSearchOptOut).not.toHaveBeenCalled();
  });
});

describe("createSearchOptOutHook（撤回钩子）", () => {
  it("清缓存失败静默：logWarn 记一次，钩子本身不拒绝", async () => {
    const logWarn = vi.fn();
    const onSearchOptOut = createSearchOptOutHook({
      clearCache: async () => {
        throw new Error("cache boom");
      },
      logWarn
    });

    await expect(onSearchOptOut()).resolves.toBeUndefined();
    expect(logWarn).toHaveBeenCalledWith("[BILISCRIPT] search cache clear on opt-out failed", expect.any(Error));
  });

  it("清缓存成功：直接通过，不记日志", async () => {
    const logWarn = vi.fn();
    const clearCache = vi.fn(async () => {});
    const onSearchOptOut = createSearchOptOutHook({ clearCache, logWarn });

    await onSearchOptOut();

    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(logWarn).not.toHaveBeenCalled();
  });
});
