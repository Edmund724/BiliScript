import { parseSubtitleGlossary } from "../../ai/subtitle-translate-config.js";
import { MAX_INITIAL_QUICK_PROMPTS } from "../../core/default-prompts.js";
import { DEFAULT_SETTINGS } from "../../core/defaults.js";
import { getNotePromptPresetLabel } from "../../notes/note-prompts.js";
import {
  normalizeChatHistoryMaxCount,
  normalizeDownloadFormat,
  normalizeNoteExportTarget,
  normalizePlayerAiActionMode,
  normalizeReaderFontSizeScale,
  normalizeReaderPalette,
  normalizeReaderTheme,
  normalizeVideoCacheMaxMb,
  normalizeWebSearchMaxToolCalls
} from "../../core/validators.js";
import { formatCacheLimitMb } from "./data-retention-settings.js";
import {
  CHAT_DISPLAY_SLIDER_SPECS,
  isChatDisplaySliderAvailable
} from "../../reader/chat-display-settings.js";
import { parseModelOptionValue } from "../../shared/selected-provider.js";
import type { AgentBridgeSettingsState } from "../agent-bridge-settings.js";
import type { ProviderRowItem } from "../provider-row.js";
import type { ProviderSummarySnapshot } from "../provider-settings-host.js";
import { resolveSettingsCapabilities, type SettingsElements } from "./elements.js";

export interface SettingsSummaryContext {
  providerSnapshot: ProviderSummarySnapshot | null;
  agentBridgeState: AgentBridgeSettingsState | null;
}

export interface SettingsSummaryFormValues {
  aiDefaultModelLabel: string;
  asrAutoFallback: boolean;
  webSearchMaxToolCalls: unknown;
  enableAiOverview?: boolean;
  autoGenerateOverview?: boolean;
  overviewAiSummary?: boolean;
  overviewAiChapters?: boolean;
  overviewAiQuotes?: boolean;
  enablePlayerAiQuickAction: boolean;
  playerAiActionMode?: unknown;
  playerAiAutoExportNote?: boolean;
  initialQuickPromptCount: number;
  speechVoiceVolume: unknown;
  downloadFormat: unknown;
  noteExportTarget?: unknown;
  notePromptPreset?: unknown;
  noteIncludeKeyframes?: boolean;
  subtitleTranslateModelLabel: string;
  subtitleTranslateGlossary: string;
  readerTheme: unknown;
  readerPalette: unknown;
  readerFontSizeScale: unknown;
  enableAgentBridge: boolean;
  chatHistoryMaxCount?: unknown;
  videoCacheMaxMb?: unknown;
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
  notesSettings: string;
  appearanceSettings: string;
  agentSettings: string;
  advancedSettings: string;
}

function resolveSelectedModelLabel(selectEl: HTMLSelectElement): string {
  const rawValue = selectEl.value;
  if (!rawValue) return "";
  const optionText = selectEl.options[selectEl.selectedIndex]?.textContent?.trim() || "";
  if (optionText && optionText !== "暂无可用模型") return optionText;
  return parseModelOptionValue(rawValue).model;
}

function resolveProviderName(
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

  const playerQuickAiAvailable =
    input.playerQuickAiAvailable ?? resolveSettingsCapabilities().playerQuickAiAvailable;
  const promptParts: string[] = [];
  const overviewAiCount =
    (form.overviewAiSummary !== false ? 1 : 0) +
    (form.overviewAiChapters !== false ? 1 : 0) +
    (form.overviewAiQuotes !== false ? 1 : 0);
  if (form.enableAiOverview === false) {
    promptParts.push("概览按需生成");
  } else if (overviewAiCount === 0) {
    promptParts.push("概览 AI 已关");
  } else if (form.autoGenerateOverview === false) {
    promptParts.push("概览手动生成");
  } else if (overviewAiCount < 3) {
    promptParts.push(`概览 ${overviewAiCount}/3 项 AI`);
  }
  if (playerQuickAiAvailable && form.enablePlayerAiQuickAction) {
    const actionMode = normalizePlayerAiActionMode(form.playerAiActionMode);
    promptParts.push(actionMode === "note" ? "播放器快捷·笔记" : "播放器快捷开");
  }
  if (form.initialQuickPromptCount > 0) promptParts.push(`${form.initialQuickPromptCount} 条快捷问题`);
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

  const notePresetLabel = getNotePromptPresetLabel(form.notePromptPreset);
  const noteTargetLabel = normalizeNoteExportTarget(form.noteExportTarget) === "obsidian" ? "Obsidian" : "本地 .md";
  const notesParts = [
    notePresetLabel,
    noteTargetLabel,
    form.playerAiAutoExportNote ? "自动导出" : "",
    form.noteIncludeKeyframes ? "含截图" : ""
  ].filter(Boolean);
  const notesSettings = notesParts.join(" · ");

  const themeLabel = THEME_LABELS[normalizeReaderTheme(form.readerTheme)] ?? "跟随当前站点";
  const paletteLabel = normalizeReaderPalette(form.readerPalette) === "editorial" ? "数字刊物" : "蓝雾玻璃";
  const fontScale = normalizeReaderFontSizeScale(form.readerFontSizeScale);
  const speechVolume = CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.normalize(form.speechVoiceVolume);
  const appearanceParts = [
    themeLabel,
    paletteLabel,
    `${fontScale}%`,
    speechVolumeAvailable && speechVolume !== CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.defaultValue
      ? `朗读 ${speechVolume}%`
      : ""
  ].filter(Boolean);
  const appearanceSettings = appearanceParts.join(" · ");

  let agentSettings: string;
  if (agentBridgeState?.connected) {
    agentSettings = "已连接";
  } else if (agentBridgeState?.enabled || form.enableAgentBridge) {
    agentSettings = "已启用 · 未连接";
  } else {
    agentSettings = "未启用";
  }

  const advancedParts: string[] = [];
  const chatHistoryMaxCount = normalizeChatHistoryMaxCount(form.chatHistoryMaxCount);
  if (chatHistoryMaxCount > 0) {
    advancedParts.push(`保留 ${chatHistoryMaxCount} 条对话`);
  }
  const videoCacheMaxMb = normalizeVideoCacheMaxMb(form.videoCacheMaxMb);
  if (videoCacheMaxMb !== DEFAULT_SETTINGS.videoCacheMaxMb) {
    advancedParts.push(`缓存 ${formatCacheLimitMb(videoCacheMaxMb)}`);
  }
  if (form.enableDebugLogs) advancedParts.push("调试日志已开");
  const advancedSettings = advancedParts.length > 0 ? advancedParts.join(" · ") : "默认";

  return {
    aiProviders,
    liveSettings,
    asrSettings,
    searchSettings,
    aiPrompt,
    subtitleSettings,
    notesSettings,
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
      enableAiOverview: elements.enableAiOverview.checked,
      autoGenerateOverview: elements.autoGenerateOverview.checked,
      overviewAiSummary: elements.overviewAiSummary.checked,
      overviewAiChapters: elements.overviewAiChapters.checked,
      overviewAiQuotes: elements.overviewAiQuotes.checked,
      enablePlayerAiQuickAction: elements.enablePlayerAiQuickAction.checked,
      playerAiActionMode: elements.playerAiActionMode.value,
      playerAiAutoExportNote: elements.playerAiAutoExportNote.checked,
      initialQuickPromptCount: collectInitialQuickPrompts(elements).length,
      speechVoiceVolume: elements.speechVoiceVolume.value,
      downloadFormat: elements.downloadFormat.value,
      noteExportTarget: elements.noteExportTarget.value,
      notePromptPreset: elements.notePromptPreset.value,
      noteIncludeKeyframes: elements.noteIncludeKeyframes.checked,
      subtitleTranslateModelLabel: resolveSelectedModelLabel(elements.subtitleTranslateModel),
      subtitleTranslateGlossary: elements.subtitleTranslateGlossary.value,
      readerTheme: elements.readerTheme.value,
      readerPalette: elements.readerPalette.value,
      readerFontSizeScale: elements.readerFontSizeScale.value,
      enableAgentBridge: elements.enableAgentBridge.checked,
      chatHistoryMaxCount: elements.chatHistoryMaxCount.value,
      videoCacheMaxMb: elements.videoCacheMaxMb.value,
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
  elements.notesSettingsSummary.textContent = derived.notesSettings;
  elements.appearanceSettingsSummary.textContent = derived.appearanceSettings;
  elements.agentSettingsSummary.textContent = derived.agentSettings;
  elements.advancedSettingsSummary.textContent = derived.advancedSettings;
}
