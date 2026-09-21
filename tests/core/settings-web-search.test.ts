// 联网搜索三标量的归一化测试（spec §3.2）：activeSearchProviderId（string，
// "" = 无激活）、webSearchEnabled（仅显式 true 开，默认关）、
// webSearchMaxToolCalls（整数夹取 1–10，非法回落 5）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";
import { DEFAULT_SETTINGS } from "../../extension/core/defaults.js";

beforeEach(() => {
  resetModuleState();
  vi.stubGlobal("chrome", { ...globalThis.chrome });
});

describe("normalizeSettings：联网搜索标量", () => {
  it("默认值：无激活平台、关、上限 5", () => {
    expect(DEFAULT_SETTINGS.activeSearchProviderId).toBe("");
    expect(DEFAULT_SETTINGS.webSearchEnabled).toBe(false);
    expect(DEFAULT_SETTINGS.webSearchMaxToolCalls).toBe(5);
  });

  it("activeSearchProviderId trim；null/undefined 归一为空串", async () => {
    const { normalizeSettings } = await import("../../extension/core/settings-store.js");
    expect(normalizeSettings({ activeSearchProviderId: " search_1 " }).activeSearchProviderId).toBe("search_1");
    expect(normalizeSettings({ activeSearchProviderId: null }).activeSearchProviderId).toBe("");
  });

  it("webSearchEnabled 仅显式 true 开，缺失/非法回落 false", async () => {
    const { normalizeSettings } = await import("../../extension/core/settings-store.js");
    expect(normalizeSettings({ webSearchEnabled: true }).webSearchEnabled).toBe(true);
    expect(normalizeSettings({}).webSearchEnabled).toBe(false);
    expect(normalizeSettings({ webSearchEnabled: "yes" }).webSearchEnabled).toBe(false);
  });

  it("webSearchMaxToolCalls 夹取 1–10，四舍五入取整，非法回落 5", async () => {
    const { normalizeSettings } = await import("../../extension/core/settings-store.js");
    expect(normalizeSettings({ webSearchMaxToolCalls: 3 }).webSearchMaxToolCalls).toBe(3);
    expect(normalizeSettings({ webSearchMaxToolCalls: 0 }).webSearchMaxToolCalls).toBe(1);
    expect(normalizeSettings({ webSearchMaxToolCalls: 99 }).webSearchMaxToolCalls).toBe(10);
    expect(normalizeSettings({ webSearchMaxToolCalls: 7.6 }).webSearchMaxToolCalls).toBe(8);
    expect(normalizeSettings({ webSearchMaxToolCalls: "abc" }).webSearchMaxToolCalls).toBe(5);
  });
});
