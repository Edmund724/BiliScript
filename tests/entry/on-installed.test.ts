import { describe, expect, it, vi } from "vitest";
import { ONBOARDING_PAGE_PATH, openOnboardingPage, runOnInstalled } from "../../extension/entry/on-installed.js";

function createDeps(overrides: Partial<Parameters<typeof runOnInstalled>[1]> = {}) {
  return {
    installReason: "install",
    getURL: vi.fn((path: string) => `chrome-extension://test-id/${path}`),
    createTab: vi.fn(async () => ({ id: 1 })),
    logWarn: vi.fn(),
    reapSessionRules: vi.fn(async () => {}),
    initializeSettingsStorage: vi.fn(async () => {}),
    autoActivateSearchPresets: vi.fn(async () => {}),
    ...overrides
  };
}

describe("onInstalled 引导页触发策略", () => {
  it("首次安装（install）时执行初始化并在最后打开 onboarding.html", async () => {
    const order: string[] = [];
    const deps = createDeps({
      reapSessionRules: vi.fn(async () => {
        order.push("reap");
      }),
      initializeSettingsStorage: vi.fn(async () => {
        order.push("init");
      }),
      autoActivateSearchPresets: vi.fn(async () => {
        order.push("search");
      }),
      createTab: vi.fn(async () => {
        order.push("tab");
        return { id: 9 };
      })
    });

    const result = await runOnInstalled({ reason: "install" }, deps);

    expect(result).toEqual({ openedOnboarding: true });
    expect(deps.getURL).toHaveBeenCalledWith(ONBOARDING_PAGE_PATH);
    expect(deps.createTab).toHaveBeenCalledTimes(1);
    expect(deps.createTab).toHaveBeenCalledWith({
      url: "chrome-extension://test-id/onboarding.html"
    });
    expect(order).toEqual(["reap", "init", "search", "tab"]);
  });

  it.each(["update", "chrome_update", "shared_module_update", undefined])(
    "非首次安装原因（%s）绝不弹出 onboarding.html",
    async (reason) => {
      const deps = createDeps();
      const result = await runOnInstalled(reason === undefined ? undefined : { reason }, deps);

      expect(result).toEqual({ openedOnboarding: false });
      expect(deps.initializeSettingsStorage).toHaveBeenCalledTimes(1);
      expect(deps.autoActivateSearchPresets).toHaveBeenCalledTimes(1);
      expect(deps.createTab).not.toHaveBeenCalled();
    }
  );

  it("安装与更新均执行可选 migrateLegacyStorage，且迁移失败不阻断引导页打开", async () => {
    const migrateLegacyStorage = vi.fn(async () => {
      throw new Error("migration failed");
    });
    const logWarn = vi.fn();
    const deps = createDeps({ migrateLegacyStorage, logWarn });

    const installResult = await runOnInstalled({ reason: "install" }, deps);
    expect(installResult).toEqual({ openedOnboarding: true });
    expect(migrateLegacyStorage).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledTimes(1);

    const updateResult = await runOnInstalled({ reason: "update" }, deps);
    expect(updateResult).toEqual({ openedOnboarding: false });
    expect(migrateLegacyStorage).toHaveBeenCalledTimes(2);
  });

  it("打开引导页失败时记录日志并安全返回 false，不抛出未捕获异常", async () => {
    const logWarn = vi.fn();
    const ok = await openOnboardingPage({
      getURL: (p) => `chrome-extension://test-id/${p}`,
      createTab: vi.fn(async () => {
        throw new Error("tabs unavailable");
      }),
      logWarn
    });

    expect(ok).toBe(false);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });
});
