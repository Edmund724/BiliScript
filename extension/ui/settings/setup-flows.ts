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
import { activeById } from "../../shared/active-host.js";
import { logWarn } from "../../shared/logging.js";
import { sendRuntimeMessage } from "../../shared/messaging.js";
import { whenReaderSettingsStylesReady } from "../../shared/style-injector.js";
import { kickSubtitleFetch } from "../../subtitle/kick-subtitle-fetch.js";
import type { ProviderRowItem } from "../provider-row.js";
import type { ProviderSettingsHost } from "../provider-settings-host.js";
import { collectElements, setStatus, type SettingsElements } from "./elements.js";
import type { SettingsSubpageId } from "./navigation.js";

export interface AiSetupSession {
  onAfterSave(): void;
  onSessionEnd(): void;
}

export interface AiSetupTarget {
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

async function loadProvidersByMessage(
  kind: "ai" | "asr",
  type: "ai-providers-list" | "asr-providers-list",
  providerHost?: ProviderSettingsHost | null
): Promise<ProviderRowItem[]> {
  if (providerHost) return providerHost.loadRows(kind);
  try {
    const resp = await sendRuntimeMessage({ type });
    if (!resp?.ok || !Array.isArray(resp.providers)) {
      logWarn(`[BILISCRIPT] load ${kind} providers returned invalid response`, resp);
      return [];
    }
    return resp.providers;
  } catch (error) {
    logWarn(`[BILISCRIPT] load ${kind} providers failed`, error);
    return [];
  }
}

export function loadAiProviders(providerHost?: ProviderSettingsHost | null): Promise<ProviderRowItem[]> {
  return loadProvidersByMessage("ai", "ai-providers-list", providerHost);
}

function loadAsrProviders(providerHost?: ProviderSettingsHost | null): Promise<ProviderRowItem[]> {
  return loadProvidersByMessage("asr", "asr-providers-list", providerHost);
}

async function resolveEditableAiProviderId(
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
  } catch (error) {
    logWarn("[BILISCRIPT] resolveEditableAiProviderId failed", error);
    return "";
  }
}

async function findMissingKeyAiProvider(
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

async function continueAsrSetupAfterToggleEnabled(
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

async function openReaderAiSetup(
  errorClass: OverviewSetupErrorClass,
  session: AiSetupSession,
  target: AiSetupTarget = {},
  deps?: SetupFlowDeps
): Promise<void> {
  if (!deps) return;
  openReaderSettingsMode();
  await deps.ensureRendered();
  deps.openView("ai-providers");
  const host = deps.getHost() ?? activeById(ids.readingSettingsHost);
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

async function openReaderAsrSetup(deps: SetupFlowDeps): Promise<void> {
  openReaderSettingsMode();
  await deps.ensureRendered();
  await whenReaderSettingsStylesReady();
  const host = deps.getHost() ?? activeById(ids.readingSettingsHost);
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
    elements.asrAutoFallback.focus();
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
