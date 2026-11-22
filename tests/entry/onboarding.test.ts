import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetModuleState } from "../setup.js";

beforeEach(() => {
  resetModuleState();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-onboarding");
});

afterEach(() => {
  vi.doUnmock("../../extension/entry/onboarding.js");
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  document.documentElement.removeAttribute("data-biliscript-onboarding");
});

describe("onboarding 模块与入口包装边界", () => {
  it("直接导入 onboarding.js 即使存在 #onboardingAiForm 也不触发自动挂载", async () => {
    document.body.innerHTML = '<form id="onboardingAiForm"></form>';
    const sendMessage = vi.fn();
    (globalThis.chrome.runtime as unknown as { sendMessage: typeof sendMessage }).sendMessage = sendMessage;

    vi.resetModules();
    const mod = await import("../../extension/entry/onboarding.js");

    expect(typeof mod.mountOnboardingPage).toBe("function");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.documentElement.getAttribute("data-biliscript-onboarding")).toBeNull();
  });

  it("导入 onboarding-entry.js 在存在 #onboardingAiForm 时触发单次 mountOnboardingPage(document)", async () => {
    document.body.innerHTML = '<form id="onboardingAiForm"></form>';
    const mountOnboardingPage = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
      dispose: vi.fn()
    });

    vi.resetModules();
    vi.doMock("../../extension/entry/onboarding.js", () => ({ mountOnboardingPage }));
    await import("../../extension/entry/onboarding-entry.js");

    expect(mountOnboardingPage).toHaveBeenCalledTimes(1);
    expect(mountOnboardingPage).toHaveBeenCalledWith(document);
  });

  it("导入 onboarding-entry.js 在缺少 #onboardingAiForm 时不触发挂载", async () => {
    const mountOnboardingPage = vi.fn().mockResolvedValue({
      refresh: vi.fn(),
      dispose: vi.fn()
    });

    vi.resetModules();
    vi.doMock("../../extension/entry/onboarding.js", () => ({ mountOnboardingPage }));
    await import("../../extension/entry/onboarding-entry.js");

    expect(mountOnboardingPage).not.toHaveBeenCalled();
  });
});
