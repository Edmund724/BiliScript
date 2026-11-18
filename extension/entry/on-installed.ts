// extension/entry/on-installed.ts
// SW 安装 / 更新生命周期编排与引导页打开入口。
// 抽成纯依赖注入模块，便于在 Vitest 中直接断言 install 触发 onboarding.html、
// update / chrome_update 等非首次安装原因绝不弹窗打扰老用户。

export const ONBOARDING_PAGE_PATH = "onboarding.html" as const;

export interface OpenOnboardingPageDeps {
  getURL: (path: string) => string;
  createTab: (createProperties: { url: string }) => Promise<unknown>;
  logWarn?: (message: string, error?: unknown) => void;
}

export async function openOnboardingPage({
  getURL,
  createTab,
  logWarn
}: OpenOnboardingPageDeps): Promise<boolean> {
  try {
    const url = getURL(ONBOARDING_PAGE_PATH);
    await createTab({ url });
    return true;
  } catch (error) {
    logWarn?.("[BILISCRIPT] failed to open onboarding page", error);
    return false;
  }
}

export interface OnInstalledDetailsLike {
  reason?: string;
}

export interface RunOnInstalledDeps extends OpenOnboardingPageDeps {
  installReason: string;
  reapSessionRules: () => Promise<void>;
  initializeSettingsStorage: () => Promise<void>;
  autoActivateSearchPresets: () => Promise<void>;
}

export async function runOnInstalled(
  details: OnInstalledDetailsLike | undefined,
  deps: RunOnInstalledDeps
): Promise<{ openedOnboarding: boolean }> {
  try {
    await deps.reapSessionRules();
  } catch (error) {
    deps.logWarn?.("[BILISCRIPT] asr session rule reap on install/update failed", error);
  }
  try {
    await deps.initializeSettingsStorage();
  } catch (error) {
    deps.logWarn?.("[BILISCRIPT] settings storage init on install/update failed", error);
  }
  try {
    await deps.autoActivateSearchPresets();
  } catch (error) {
    deps.logWarn?.("[BILISCRIPT] search presets auto activation on install/update failed", error);
  }

  if (details?.reason !== deps.installReason) {
    return { openedOnboarding: false };
  }
  const openedOnboarding = await openOnboardingPage(deps);
  return { openedOnboarding };
}
