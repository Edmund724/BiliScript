// 联网搜索三标量的归一化测试（spec §3.2）：activeSearchProviderId（string，
// "" = 无激活）、webSearchEnabled（仅显式 true 开，默认关）、
// webSearchMaxToolCalls（整数夹取 1–10，非法回落 5）。

import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

beforeEach(() => {
  resetModuleState();
  vi.stubGlobal("chrome", { ...globalThis.chrome });
});

describe("normalizeSettings：联网搜索标量", () => {
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

  // searchProviderOrder 是偏好（记录 id 数组）不是可调设置项（spec §12.3 / §10 第 76 行）：
  // 无默认值 → 不进 DEFAULT_SETTINGS（否则 initializeSettingsStorage 会把「删除该键」
  // 重建成 []，「恢复默认顺序」失效），也不在 save-settings 白名单。
  it("searchProviderOrder 不在 DEFAULT_SETTINGS 键集，也不在 save-settings 白名单", async () => {
    const setMock = vi.fn(async (_payload: Record<string, unknown>) => {});
    vi.stubGlobal("chrome", { ...globalThis.chrome, storage: { ...globalThis.chrome?.storage, sync: { set: setMock } } });
    const { DEFAULT_SETTINGS } = await import("../../extension/core/defaults.js");
    const { saveSettings } = await import("../../extension/core/settings-store.js");

    expect(Object.keys(DEFAULT_SETTINGS)).not.toContain("searchProviderOrder");

    await saveSettings({ searchProviderOrder: ["tavily"], defaultModel: "openai" });

    expect(setMock).toHaveBeenCalledTimes(1);
    const payload = setMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("searchProviderOrder");
    expect(payload.defaultModel).toBe("openai");
  });
});
