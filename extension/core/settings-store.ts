import { DEFAULT_SETTINGS, type KnownSettingKey, type Settings } from "./defaults.js";
import { normalizeAsrLanguage } from "./presets.js";
import {
  INDEX_TRANSLATE_PROVIDER_ID,
  normalizeIndexTranslateModel
} from "../ai/subtitle-translate-config.js";
import { withTimeout } from "../shared/error-helpers.js";
import {
  booleanField,
  normalizeDownloadFormat,
  normalizeNoteExportTemplate,
  normalizeObsidianVaultName,
  normalizeObsidianFolder,
  normalizeAgentBridgeUrl,
  normalizeEnablePlayerAiQuickAction,
  normalizePlayerAiQuickPrompt,
  normalizeReaderTheme,
  normalizeReaderPalette,
  normalizeChatInputGlow,
  normalizeReduceTransparency,
  normalizeAiSystemPrompt,
  normalizeAiInitialQuickPrompts,
  normalizeDefaultModel,
  normalizeDefaultAiModel,
  normalizeAiThinkingLevel,
  normalizeLiveVoiceVolume,
  normalizeLiveVoiceSpeed,
  normalizeLiveVoicePriority,
  normalizeLiveShareVideoAudio,
  normalizeSpeechVoiceVolume,
  normalizeLiveGeminiNativeSearch,
  normalizeLiveLowBandwidth,
  normalizeSubtitleTranslateProviderId,
  normalizeSubtitleTranslateModel,
  normalizeSubtitleTranslateGlossary,
  normalizeLiveInterpretTargetLang,
  normalizeLiveInterpretDisplayMode,
  normalizeLiveInterpretFontScale,
  normalizeLiveInterpretBlurSecondary,
  normalizeWebSearchEnabled,
  normalizeWebSearchMaxToolCalls,
  normalizeSearchPresetsAutoActivated,
  normalizeSearchOptInNoticeAcknowledged,
  normalizeAllowPaidSearchProviders,
  normalizeBilingualSubtitles,
  normalizeSecondarySubtitleLang,
  normalizeBilingualDisplayOrder,
  normalizeSubtitleSegmentationStrategy,
  normalizeCustomPanelWidthEnabled,
  normalizeCustomPanelWidth,
  normalizeDetachedWindowMode,
  normalizeAutoOpenReader,
  normalizeReaderFontSizeScale,
  normalizeChatLineHeight,
  normalizeChatParagraphSpacing
} from "./validators.js";

export const SETTINGS_PASSTHROUGH_KEYS = Object.freeze([
  "includeDateInFilename",
  "includeTimestampInBody",
  "enableDebugLogs",
  "aiBtnDefaultOnMigrated"
] as const);

export type PassthroughSettingKey = (typeof SETTINGS_PASSTHROUGH_KEYS)[number];
export type NormalizableSettingKey = Exclude<KnownSettingKey, PassthroughSettingKey>;

export const SETTINGS_FIELD_NORMALIZERS: {
  readonly [K in NormalizableSettingKey]: (value: unknown) => Settings[K];
} = Object.freeze({
  downloadFormat: normalizeDownloadFormat,
  enablePlayerAiQuickAction: normalizeEnablePlayerAiQuickAction,
  enableAgentBridge: booleanField(false),
  agentBridgeUrl: normalizeAgentBridgeUrl,
  playerAiQuickPrompt: normalizePlayerAiQuickPrompt,
  readerTheme: normalizeReaderTheme,
  readerThemeUserSet: booleanField(false),
  readerPalette: normalizeReaderPalette,
  chatInputGlow: normalizeChatInputGlow,
  reduceTransparency: normalizeReduceTransparency,
  aiSystemPrompt: normalizeAiSystemPrompt,
  aiInitialQuickPrompts: normalizeAiInitialQuickPrompts,
  defaultModel: normalizeDefaultModel,
  defaultAiModel: normalizeDefaultAiModel,
  aiThinkingLevel: normalizeAiThinkingLevel,
  enableCostGuard: booleanField(false),
  activeAsrProviderId: (value) => String(value || "").trim(),
  activeLiveProviderId: (value) => String(value || "").trim(),
  liveVoiceVolume: normalizeLiveVoiceVolume,
  liveVoiceSpeed: normalizeLiveVoiceSpeed,
  speechVoiceVolume: normalizeSpeechVoiceVolume,
  liveVoicePriority: normalizeLiveVoicePriority,
  liveShareVideoAudio: normalizeLiveShareVideoAudio,
  liveGeminiNativeSearch: normalizeLiveGeminiNativeSearch,
  liveLowBandwidth: normalizeLiveLowBandwidth,
  subtitleTranslateProviderId: normalizeSubtitleTranslateProviderId,
  subtitleTranslateModel: normalizeSubtitleTranslateModel,
  subtitleTranslateGlossary: normalizeSubtitleTranslateGlossary,
  liveInterpretTargetLang: normalizeLiveInterpretTargetLang,
  liveInterpretDisplayMode: normalizeLiveInterpretDisplayMode,
  liveInterpretFontScale: normalizeLiveInterpretFontScale,
  liveInterpretBlurSecondary: normalizeLiveInterpretBlurSecondary,
  asrAutoFallback: booleanField(true),
  asrLanguage: normalizeAsrLanguage,
  activeSearchProviderId: (value) => String(value || "").trim(),
  webSearchEnabled: normalizeWebSearchEnabled,
  webSearchMaxToolCalls: normalizeWebSearchMaxToolCalls,
  searchPresetsAutoActivated: normalizeSearchPresetsAutoActivated,
  searchOptInNoticeAcknowledged: normalizeSearchOptInNoticeAcknowledged,
  allowPaidSearchProviders: normalizeAllowPaidSearchProviders,
  bilingualSubtitles: normalizeBilingualSubtitles,
  secondarySubtitleLang: normalizeSecondarySubtitleLang,
  bilingualDisplayOrder: normalizeBilingualDisplayOrder,
  subtitleSegmentationStrategy: normalizeSubtitleSegmentationStrategy,
  readerFontSizeScale: normalizeReaderFontSizeScale,
  chatLineHeight: normalizeChatLineHeight,
  chatParagraphSpacing: normalizeChatParagraphSpacing,
  customPanelWidthEnabled: normalizeCustomPanelWidthEnabled,
  customPanelWidth: normalizeCustomPanelWidth,
  detachedWindowMode: normalizeDetachedWindowMode,
  autoOpenReader: normalizeAutoOpenReader,
  cleanConversationsOlderThan30Days: booleanField(false),
  enableExtraPlaybackRates: booleanField(false),
  noteExportTemplate: normalizeNoteExportTemplate,
  obsidianVaultName: normalizeObsidianVaultName,
  obsidianFolder: normalizeObsidianFolder
});

const SETTINGS_NORMALIZER_ENTRIES = Object.entries(SETTINGS_FIELD_NORMALIZERS) as Array<
  [NormalizableSettingKey, (value: unknown) => unknown]
>;

export function normalizeSettings(merged: Record<string, unknown>): Settings {
  const source: Record<string, unknown> = { ...merged };
  const normalized: Record<string, unknown> = { ...merged };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_ENTRIES) {
    normalized[key] = normalizeField(source[key]);
  }
  if (normalized.subtitleTranslateProviderId === INDEX_TRANSLATE_PROVIDER_ID) {
    normalized.subtitleTranslateModel = normalizeIndexTranslateModel(normalized.subtitleTranslateModel);
  }
  return normalized as Settings;
}

export const SETTINGS_NORMALIZER_KEYS: readonly string[] = Object.freeze(
  SETTINGS_NORMALIZER_ENTRIES.map(([key]) => key)
);

export async function getMergedSettings(timeoutMs = 5000): Promise<Settings> {
  const syncSettings = await withTimeout(
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    timeoutMs,
    new Error("storage timeout")
  ).catch(() => ({}));

  const merged = normalizeSettings({ ...DEFAULT_SETTINGS, ...(syncSettings as Record<string, unknown>) });
  if (merged.customPanelWidthEnabled !== true && merged.customPanelWidth !== DEFAULT_SETTINGS.customPanelWidth) {
    merged.customPanelWidthEnabled = true;
  }
  return merged;
}

const SETTINGS_STORAGE_KEYS = new Set<string>(Object.keys(DEFAULT_SETTINGS));

export async function saveSettings(settings: unknown): Promise<void> {
  const payload = settings && typeof settings === "object" ? settings as Record<string, unknown> : {};
  const syncPayload: Record<string, unknown> = { ...payload };
  for (const key of Object.keys(syncPayload)) {
    if (syncPayload[key] === undefined) delete syncPayload[key];
  }
  const source: Record<string, unknown> = { ...syncPayload };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_ENTRIES) {
    if (key in syncPayload) syncPayload[key] = normalizeField(source[key]);
  }
  if (
    syncPayload.subtitleTranslateProviderId === INDEX_TRANSLATE_PROVIDER_ID &&
    "subtitleTranslateModel" in syncPayload
  ) {
    syncPayload.subtitleTranslateModel = normalizeIndexTranslateModel(syncPayload.subtitleTranslateModel);
  }
  const whitelisted: Record<string, unknown> = {};
  for (const key of Object.keys(syncPayload)) {
    if (SETTINGS_STORAGE_KEYS.has(key)) whitelisted[key] = syncPayload[key];
  }

  await chrome.storage.sync.set(whitelisted);
}
