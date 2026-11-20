// ui/settings/setup-flows.ts — AI / ASR 首配直达与续跑事务。

import { resolveAsrSetupState } from "../../asr/asr-setup.js";
import type { OverviewSetupErrorClass } from "../../core/overview-setup-error.js";
import { getSettings } from "../../core/runtime.js";
import { requestSubtitleRefresh } from "../../reader/reader-bus.js";
import { closeReaderSettingsMode, openReaderSettingsMode } from "../../reader/settings-mode.js";
import {
  consumeAsrSetupResumeToken,
  currentPageVideoKey,
  invalidateReaderSetupFlows,
  peekAsrSetupResumeToken,
  setAsrSetupResumeToken
} from "../../reader/setup-resume.js";
import { ids } from "../../reader/state.js";
import { logWarn } from "../../shared/logging.js";
import { sendRuntimeMessage } from "../../shared/messaging.js";
import { whenReaderSettingsStylesReady } from "../../shared/style-injector.js";
import { kickSubtitleFetch } from "../../subtitle/kick-subtitle-fetch.js";
import type { ProviderRowItem } from "../provider-row.js";
import type { ProviderSettingsHost } from "../provider-settings-host.js";
import { collectElements, setStatus, type SettingsElements } from "./elements.js";
import type { SettingsSubpageId } from "./navigation.js";

// 首配编辑会话回调：保存成功后与编辑器会话结束时的装配方出口（消费/作废续跑
// 意图、退出设置抽屉），由 reader 装配根注入。
export interface AiSetupSession {
  onAfterSave(): void;
  onSessionEnd(): void;
}

// 概览配置类错误（无平台 / 缺 Key / 无模型）的「去设置」直达：
// - "no-provider"：无记录 → 直接新增 AI 平台编辑器（保存并继续语义）；
// - "missing-key"：定位缺 Key 的启用记录 → 直接编辑该记录并聚焦 Key 输入框；
//   定位不到（缺失 / 禁用 / 无需 Key）则结束会话并在状态栏提示；
// - "no-model"：定位可编辑的启用 AI 平台并聚焦模型配置区。
export interface AiSetupTarget {
  // 缺 Key / 缺模型时调用方已知的已选平台记录：优先直达该记录；缺省按解析策略定位。
  providerId?: string;
  setupContextBanner?: string | null;
  focusField?: "apiKey" | "models";
}

export interface SetupFlowDeps {
  ensureRendered: () => Promise<void>;
  getHost: () => HTMLElement | null;
  getProviderHost: () => ProviderSettingsHost | null;
  openView: (view: SettingsSubpageId) => void;
}

export async function loadAiProviders(providerHost?: ProviderSettingsHost | null): Promise<ProviderRowItem[]> {
  if (providerHost) return providerHost.loadRows("ai");
  try {
    const resp = await sendRuntimeMessage({ type: "ai-providers-list" });
    return resp?.ok && Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

export async function loadAsrProviders(providerHost?: ProviderSettingsHost | null): Promise<ProviderRowItem[]> {
  if (providerHost) return providerHost.loadRows("asr");
  try {
    const resp = await sendRuntimeMessage({ type: "asr-providers-list" });
    return resp?.ok && Array.isArray(resp.providers) ? resp.providers : [];
  } catch {
    return [];
  }
}

/**
 * 缺模型错误进入设置时定位要编辑的启用 AI 平台 id（defaultModel 优先，否则首个启用平台）。
 */
export async function resolveEditableAiProviderId(
  providerHost?: ProviderSettingsHost | null
): Promise<string> {
  try {
    const [providers, settings] = await Promise.all([loadAiProviders(providerHost), getSettings()]);
    const enabled = providers.filter(
      (item) => Boolean(item) && item.enabled !== false && String(item.id || "").trim() !== ""
    );
    if (!enabled.length) {
      return "";
    }
    const preferredId = String(settings?.defaultModel || "").trim();
    const matched = preferredId ? enabled.find((item) => String(item.id) === preferredId) : null;
    return String((matched || enabled[0]).id || "").trim();
  } catch {
    return "";
  }
}

// 缺 Key 记录定位（resolve-ai-provider 解析策略的镜像：调用方给定的已选平台 →
// defaultModel 精确匹配 → 首个启用回落）：只对 requiresKey !== false 且未存 Key 的
// 启用记录给编辑入口。调用方给定记录时直达它——若已缺失/禁用/无需 Key 则返回 null。
export async function findMissingKeyAiProvider(
  preferredProviderId = "",
  providerHost?: ProviderSettingsHost | null
): Promise<ProviderRowItem | null> {
  const providers = await loadAiProviders(providerHost);
  const enabled = providers.filter(
    (p) => p && p.enabled !== false && String(p?.id || "").trim() !== ""
  );
  if (!enabled.length) {
    return null;
  }
  const exactId = String(preferredProviderId || "").trim();
  if (exactId) {
    const exact = enabled.find((p) => String(p.id) === exactId);
    return exact && exact.requiresKey !== false ? exact : null;
  }
  const settings = await getSettings();
  const preferredId = String(settings?.defaultModel || "").trim();
  const candidates = [
    ...(preferredId ? enabled.filter((p) => String(p.id) === preferredId) : []),
    ...enabled
  ];
  return candidates.find((p) => p.requiresKey !== false && !p.hasSavedKey) || null;
}

// 配置完成后的续跑（开关落盘 / 编辑器保存共用）：取走一次性令牌并校验——
// 令牌缺失、换视频或换分 P（页面身份键失配）都不续跑；
// 已在飞或字幕在手由 kick 的在手/在飞判定让位，通过后重新进入既有字幕抓取链。
export function resumeAsrSubtitleFetchAfterSetup(): boolean {
  const token = consumeAsrSetupResumeToken();
  if (!token) {
    return false;
  }
  if (token.videoKey !== currentPageVideoKey()) {
    return false;
  }
  void kickSubtitleFetch(() => requestSubtitleRefresh(), {
    skipIfInHandOrInFlight: true,
    awaitRefresh: false,
    onChainLoadFailed: (error) => logWarn("[BILISCRIPT] asr setup resume (summarize chain load) failed", { error }),
    onRefreshFailed: (error) => logWarn("[BILISCRIPT] asr setup resume refresh failed", { error })
  });
  return true;
}

export async function continueAsrSetupAfterToggleEnabled(
  elements: SettingsElements,
  getProviderHost: () => ProviderSettingsHost | null
): Promise<void> {
  const token = peekAsrSetupResumeToken();
  if (!token) return;
  if (token.videoKey !== currentPageVideoKey()) {
    consumeAsrSetupResumeToken();
    closeReaderSettingsMode({ restoreFocus: true });
    return;
  }
  const providerHost = getProviderHost();
  const [settings, providers] = await Promise.all([getSettings(), loadAsrProviders(providerHost)]);
  const setupState = resolveAsrSetupState({
    asrAutoFallback: true,
    activeAsrProviderId: settings.activeAsrProviderId,
    providers
  });
  if (!setupState.needsProviderSetup) {
    if (resumeAsrSubtitleFetchAfterSetup()) {
      closeReaderSettingsMode({ restoreFocus: true });
    }
    return;
  }
  setAsrSetupResumeToken({ videoKey: token.videoKey, kind: setupState.providerStatus });
  const isMissingKey = setupState.providerStatus === "missing-key";
  const targetId = isMissingKey ? setupState.targetProviderId : "";
  const banner = isMissingKey
    ? "请补充语音转写 API Key 后保存继续"
    : "保存可用语音转写平台后将自动返回继续";
  setStatus(
    elements,
    isMissingKey
      ? "已开启自动转写，请补充语音转写 API Key 后保存继续"
      : "已开启自动转写，请添加语音转写平台后保存继续"
  );
  await getProviderHost()?.openEditor({
    kind: "asr",
    providerId: targetId,
    setupSession: {
      onAfterSave: () => {
        resumeAsrSubtitleFetchAfterSetup();
        closeReaderSettingsMode({ restoreFocus: true });
      },
      onSessionEnd: () => invalidateReaderSetupFlows("asr")
    },
    setupContextBanner: banner,
    ...(isMissingKey ? { initialFocusField: "apiKey" as const } : {})
  });
}

export async function openReaderAiSetup(
  errorClass: OverviewSetupErrorClass,
  session: AiSetupSession,
  target: AiSetupTarget = {},
  deps?: SetupFlowDeps
): Promise<void> {
  if (!deps) return;
  openReaderSettingsMode();
  await deps.ensureRendered();
  deps.openView("ai-providers");
  const host = deps.getHost() ?? document.getElementById(ids.readingSettingsHost);
  const providerHost = deps.getProviderHost();
  const defaultBanner =
    errorClass === "missing-key"
      ? target.focusField === "models"
        ? "请至少添加一个可用模型后保存继续"
        : "请补充 API Key 后保存继续"
      : errorClass === "no-model"
        ? "请至少添加一个可用模型后保存继续"
        : "保存可用 AI 平台后将自动返回继续";
  const setupContextBanner =
    target.setupContextBanner !== undefined ? target.setupContextBanner : defaultBanner;

  if (errorClass === "missing-key") {
    const record = await findMissingKeyAiProvider(target.providerId, providerHost);
    if (!record) {
      session?.onSessionEnd?.();
      if (host) {
        setStatus(
          collectElements(host),
          "未找到需要补充 API Key 的启用 AI 平台，请检查平台启用状态或新增平台",
          true
        );
      }
      return;
    }
    await providerHost?.openEditor({
      kind: "ai",
      providerId: String(record.id || ""),
      setupSession: session,
      setupContextBanner,
      initialFocusField: target.focusField === "models" ? "models" : "apiKey"
    });
    return;
  }

  if (errorClass === "no-model") {
    const resolvedId = String(target.providerId || "").trim() || (await resolveEditableAiProviderId(providerHost));
    const providers = await loadAiProviders(providerHost);
    const record = resolvedId
      ? providers.find((p) => p && p.enabled !== false && String(p.id || "") === resolvedId) || null
      : null;
    if (!record) {
      session?.onSessionEnd?.();
      if (host) {
        setStatus(collectElements(host), "未找到可用的 AI 平台，请先添加并启用平台", true);
      }
      return;
    }
    await providerHost?.openEditor({
      kind: "ai",
      providerId: String(record.id || ""),
      setupSession: session,
      setupContextBanner,
      initialFocusField: "models"
    });
    return;
  }

  await providerHost?.openEditor({
    kind: "ai",
    providerId: "",
    setupSession: session,
    setupContextBanner
  });
}

/**
 * ASR 配置类阻塞的「前往设置」直达（字幕空态 / 概览空态 / 对话拦截共用）：
 * 点击时刻重新读实时设置与平台列表；打开前记录一次性续跑令牌，
 * 保存成功或开关落盘成功后回到原任务续跑，取消编辑或关闭抽屉作废令牌。
 */
export async function openReaderAsrSetup(deps: SetupFlowDeps): Promise<void> {
  openReaderSettingsMode();
  await deps.ensureRendered();
  await whenReaderSettingsStylesReady();
  const host = deps.getHost() ?? document.getElementById(ids.readingSettingsHost);
  if (!host) {
    return;
  }
  const providerHost = deps.getProviderHost();
  const elements = collectElements(host);
  const [settings, providers] = await Promise.all([getSettings(), loadAsrProviders(providerHost)]);
  const setupState = resolveAsrSetupState({
    asrAutoFallback: settings.asrAutoFallback,
    activeAsrProviderId: settings.activeAsrProviderId,
    providers
  });
  deps.openView("asr");
  setAsrSetupResumeToken({ videoKey: currentPageVideoKey(), kind: setupState.kind });
  if (!setupState.asrAutoFallback) {
    setStatus(
      elements,
      setupState.blockedByBoth
        ? "请先开启「无字幕时自动生成字幕」，随后补充语音转写平台配置"
        : "请先开启「无字幕时自动生成字幕」以自动转写视频语音"
    );
    elements.asrAutoFallback?.focus();
    return;
  }
  const banner =
    setupState.kind === "no-provider"
      ? "保存可用语音转写平台后将自动返回继续"
      : setupState.kind === "missing-key"
        ? "请补充语音转写 API Key 后保存继续"
        : "确认语音转写平台配置后保存继续";
  const isMissingKey = setupState.kind === "missing-key";
  await providerHost?.openEditor({
    kind: "asr",
    providerId: setupState.providerId,
    setupSession: {
      onAfterSave: () => {
        resumeAsrSubtitleFetchAfterSetup();
        closeReaderSettingsMode({ restoreFocus: true });
      },
      onSessionEnd: () => invalidateReaderSetupFlows("asr")
    },
    setupContextBanner: banner,
    ...(isMissingKey ? { initialFocusField: "apiKey" as const } : {})
  });
}

export function createSetupFlows(deps: SetupFlowDeps) {
  return {
    openReaderAiSetup: (
      errorClass: OverviewSetupErrorClass,
      session: AiSetupSession,
      target: AiSetupTarget = {}
    ) => openReaderAiSetup(errorClass, session, target, deps),
    openReaderAsrSetup: () => openReaderAsrSetup(deps),
    continueAsrSetupAfterToggleEnabled: (elements: SettingsElements) =>
      continueAsrSetupAfterToggleEnabled(elements, deps.getProviderHost),
    resolveEditableAiProviderId: () => resolveEditableAiProviderId(deps.getProviderHost())
  };
}
