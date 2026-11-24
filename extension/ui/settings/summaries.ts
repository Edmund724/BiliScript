import { parseSubtitleGlossary } from "../../ai/subtitle-translate-config.js";
import { MAX_INITIAL_QUICK_PROMPTS } from "../../core/default-prompts.js";
import { state } from "../../core/state.js";
import {
  normalizeCustomPanelWidth,
  normalizeDownloadFormat,
  normalizeReaderFontSizeScale,
  normalizeReaderPalette,
  normalizeReaderTheme,
  normalizeWebSearchMaxToolCalls
} from "../../core/validators.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  isChatDisplaySliderAvailable
} from "../../reader/chat-display-settings.js";
import { parseModelOptionValue } from "../../shared/selected-provider.js";
import { detectActiveSite, getSiteCapabilities } from "../../shared/site.js";
import type { AgentBridgeSettingsState } from "../agent-bridge-settings.js";
import type { ProviderRowItem } from "../provider-row.js";
import type { ProviderSummarySnapshot } from "../provider-settings-host.js";
import type { SettingsElements } from "./elements.js";

export interface SettingsSummaryContext {
  providerSnapshot: ProviderSummarySnapshot | null;
  agentBridgeState: AgentBridgeSettingsState | null;
}

export interface SettingsSummaryFormValues {
  aiDefaultModelLabel: string;
  asrAutoFallback: boolean;
  webSearchMaxToolCalls: unknown;
  enablePlayerAiQuickAction: boolean;
  initialQuickPromptCount: number;
  speechVoiceVolume: unknown;
  downloadFormat: unknown;
  subtitleTranslateModelLabel: string;
  subtitleTranslateGlossary: string;
  readerTheme: unknown;
  readerPalette: unknown;
  readerFontSizeScale: unknown;
  customPanelWidth: unknown;
  enableAgentBridge: boolean;
  cleanConversationsOlderThan30Days: boolean;
  enableDebugLogs: boolean;
}

export interface SettingsSummariesInput {
  form: SettingsSummaryFormValues;
  providerSnapshot: ProviderSummarySnapshot | null;
  agentBridgeState: AgentBridgeSettingsState | null;
  speechVolumeAvailable?: boolean;
  playerQuickAiAvailable?: boolean;
}

export interface DerivedSettingsSummaries {
  aiProviders: string | null;
  liveSettings: string | null;
  asrSettings: string | null;
  searchSettings: string | null;
  aiPrompt: string;
  subtitleSettings: string;
  appearanceSettings: string;
  agentSettings: string;
  advancedSettings: string;
}

export function resolveSelectedModelLabel(selectEl: HTMLSelectElement): string {
  const rawValue = selectEl.value;
  if (!rawValue) return "";
  const optionText = selectEl.options[selectEl.selectedIndex]?.textContent?.trim() || "";
  if (optionText && optionText !== "暂无可用模型") return optionText;
  return parseModelOptionValue(rawValue).model;
}

export function resolveProviderName(
  providers: readonly ProviderRowItem[] | undefined,
  preferredId: string
): string {
  if (!providers || providers.length === 0) return "";
  const matched = preferredId
    ? providers.find((item) => String(item?.id || "") === preferredId)
    : providers[0];
  const target = matched ?? providers[0];
  return String(target?.name || target?.model || target?.presetId || "").trim();
}

export function collectInitialQuickPrompts(
  elements: Pick<SettingsElements, "aiInitialQuickPrompts">
): string[] {
  return Array.from(elements.aiInitialQuickPrompts || [])
    .map((input) => String(input.value || "").trim())
    .filter(Boolean)
    .slice(0, MAX_INITIAL_QUICK_PROMPTS);
}

const THEME_LABELS: Record<string, string> = {
  bilibili: "跟随当前站点",
  system: "跟随系统",
  light: "浅色",
  dark: "深色"
};

export function deriveSettingsSummaries(input: SettingsSummariesInput): DerivedSettingsSummaries {
  const { form, providerSnapshot, agentBridgeState } = input;
  const speechVolumeAvailable = input.speechVolumeAvailable ?? isChatDisplaySliderAvailable("speechVoiceVolume");

  let aiProviders: string | null = null;
  let liveSettings: string | null = null;
  let asrSettings: string | null = null;
  let searchSettings: string | null = null;

  if (providerSnapshot) {
    const aiTotal = providerSnapshot.aiProviders.length;
    const aiEnabled = providerSnapshot.aiProviders.filter((p) => p && p.enabled !== false).length;
    const defaultModelLabel = form.aiDefaultModelLabel;
    if (aiTotal === 0) {
      aiProviders = "未配置";
    } else if (aiEnabled === 0) {
      aiProviders = "已全部停用";
    } else {
      aiProviders = defaultModelLabel
        ? `${aiEnabled} 个启用 · ${defaultModelLabel}`
        : `${aiEnabled} 个启用`;
    }

    if (providerSnapshot.liveProviders.length === 0) {
      liveSettings = "未配置";
    } else {
      const liveName = resolveProviderName(providerSnapshot.liveProviders, providerSnapshot.activeLiveId);
      liveSettings = liveName || `${providerSnapshot.liveProviders.length} 个平台`;
    }

    const asrAuto = form.asrAutoFallback;
    if (providerSnapshot.asrProviders.length === 0) {
      asrSettings = asrAuto ? "自动开启 · 未配平台" : "已关闭";
    } else {
      const asrName = resolveProviderName(providerSnapshot.asrProviders, providerSnapshot.activeAsrId);
      asrSettings = `${asrName || "语音转写"} · ${asrAuto ? "自动开启" : "手动触发"}`;
    }

    const maxCalls = normalizeWebSearchMaxToolCalls(form.webSearchMaxToolCalls);
    if (providerSnapshot.searchProviders.length === 0) {
      searchSettings = "未配置";
    } else if (providerSnapshot.activeSearchProviderId) {
      const matched = providerSnapshot.searchProviders.find(
        (item) => String(item?.id || "") === providerSnapshot.activeSearchProviderId
      );
      const searchLabel = matched
        ? String(matched.name || matched.presetId || "指定平台").trim()
        : "智能回退";
      searchSettings = `${searchLabel} · 最多 ${maxCalls} 次`;
    } else {
      searchSettings = `智能回退 · 最多 ${maxCalls} 次`;
    }
  }

  const site =
    state.clip.site === "youtube" || detectActiveSite() === "youtube"
      ? "youtube"
      : state.clip.site;
  const playerQuickAiAvailable =
    input.playerQuickAiAvailable ?? getSiteCapabilities(site).supportsPlayerQuickAiButton;
  const promptParts: string[] = [];
  if (playerQuickAiAvailable && form.enablePlayerAiQuickAction) promptParts.push("播放器快捷开");
  if (form.initialQuickPromptCount > 0) promptParts.push(`${form.initialQuickPromptCount} 条快捷问题`);
  if (speechVolumeAvailable) {
    promptParts.push(`朗读 ${CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.normalize(form.speechVoiceVolume)}%`);
  }
  const aiPrompt = promptParts.length > 0 ? promptParts.join(" · ") : "默认";

  const normalizedFormat = normalizeDownloadFormat(form.downloadFormat);
  const formatLabel = normalizedFormat === "vtt-secondary" ? "VTT（仅副轨）" : normalizedFormat.toUpperCase();
  const glossaryCount = parseSubtitleGlossary(form.subtitleTranslateGlossary).length;
  const subtitleParts = [
    form.subtitleTranslateModelLabel,
    glossaryCount > 0 ? `${glossaryCount} 条术语` : "",
    formatLabel
  ].filter(Boolean);
  const subtitleSettings = subtitleParts.join(" · ");

  const themeLabel = THEME_LABELS[normalizeReaderTheme(form.readerTheme)] ?? "跟随当前站点";
  const paletteLabel = normalizeReaderPalette(form.readerPalette) === "editorial" ? "数字刊物" : "蓝雾玻璃";
  const fontScale = normalizeReaderFontSizeScale(form.readerFontSizeScale);
  const panelWidth = normalizeCustomPanelWidth(form.customPanelWidth);
  const appearanceSettings = `${themeLabel} · ${paletteLabel} · ${fontScale}% · ${panelWidth}px`;

  let agentSettings: string;
  if (agentBridgeState?.connected) {
    agentSettings = "已连接";
  } else if (agentBridgeState?.enabled || form.enableAgentBridge) {
    agentSettings = "已启用 · 未连接";
  } else {
    agentSettings = "未启用";
  }

  const advancedParts: string[] = [];
  if (form.cleanConversationsOlderThan30Days) advancedParts.push("30 天自动清理");
  if (form.enableDebugLogs) advancedParts.push("调试日志已开");
  const advancedSettings = advancedParts.length > 0 ? advancedParts.join(" · ") : "默认";

  return {
    aiProviders,
    liveSettings,
    asrSettings,
    searchSettings,
    aiPrompt,
    subtitleSettings,
    appearanceSettings,
    agentSettings,
    advancedSettings
  };
}

export function syncAllSummaries(elements: SettingsElements, context: SettingsSummaryContext): void {
  const derived = deriveSettingsSummaries({
    form: {
      aiDefaultModelLabel: resolveSelectedModelLabel(elements.aiDefaultModel),
      asrAutoFallback: elements.asrAutoFallback.checked,
      webSearchMaxToolCalls: elements.webSearchMaxToolCalls.value,
      enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
      initialQuickPromptCount: collectInitialQuickPrompts(elements).length,
      speechVoiceVolume: elements.speechVoiceVolume.value,
      downloadFormat: elements.downloadFormat.value,
      subtitleTranslateModelLabel: resolveSelectedModelLabel(elements.subtitleTranslateModel),
      subtitleTranslateGlossary: elements.subtitleTranslateGlossary.value,
      readerTheme: elements.readerTheme.value,
      readerPalette: elements.readerPalette.value,
      readerFontSizeScale: elements.readerFontSizeScale.value,
      customPanelWidth: elements.customPanelWidth.value,
      enableAgentBridge: elements.enableAgentBridge.checked,
      cleanConversationsOlderThan30Days: elements.cleanConversationsOlderThan30Days.checked,
      enableDebugLogs: elements.enableDebugLogs.checked
    },
    providerSnapshot: context.providerSnapshot,
    agentBridgeState: context.agentBridgeState
  });

  if (derived.aiProviders !== null) elements.aiProvidersSummary.textContent = derived.aiProviders;
  if (derived.liveSettings !== null) elements.liveSettingsSummary.textContent = derived.liveSettings;
  if (derived.asrSettings !== null) elements.asrSettingsSummary.textContent = derived.asrSettings;
  if (derived.searchSettings !== null) elements.searchSettingsSummary.textContent = derived.searchSettings;

  elements.aiPromptSummary.textContent = derived.aiPrompt;
  elements.subtitleSettingsSummary.textContent = derived.subtitleSettings;
  elements.appearanceSettingsSummary.textContent = derived.appearanceSettings;
  elements.agentSettingsSummary.textContent = derived.agentSettings;
  elements.advancedSettingsSummary.textContent = derived.advancedSettings;
}
