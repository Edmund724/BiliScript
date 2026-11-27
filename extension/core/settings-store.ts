import {
  DEFAULT_AI_SYSTEM_PROMPT,
  DEFAULT_PLAYER_AI_QUICK_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6
} from "./default-prompts.js";
import { DEFAULT_SETTINGS, type KnownSettingKey, type KnownSettings, type Settings } from "./defaults.js";
import { normalizeAsrLanguage } from "./presets.js";
import {
  INDEX_TRANSLATE_PROVIDER_ID,
  SILICONFLOW_TRANSLATE_PROVIDER_ID,
  normalizeIndexTranslateModel,
  normalizeSiliconFlowTranslateModel
} from "../ai/subtitle-translate-config.js";
import { DEFAULT_NOTE_TEMPLATE } from "../notes/template-defaults.js";
import { withTimeout } from "../shared/error-helpers.js";
import {
  booleanField,
  normalizeDownloadFormat,
  normalizeNoteExportTemplate,
  normalizeObsidianVaultName,
  normalizeObsidianFolder,
  normalizePlayerAiActionMode,
  normalizePlayerAiAutoExportNote,
  normalizeNotePromptPreset,
  normalizeNoteCustomPrompt,
  normalizeNoteExportTarget,
  normalizeNoteDownloadSubdir,
  normalizeNoteIncludeKeyframes,
  normalizeAgentBridgeUrl,
  normalizeEnablePlayerAiQuickAction,
  normalizePlayerAiQuickPrompt,
  normalizeReaderTheme,
  normalizeReaderPalette,
  normalizeChatInputGlow,
  normalizeReduceTransparency,
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
  normalizeChatHistoryMaxCount,
  normalizeVideoCacheMaxMb,
  normalizeReaderFontSizeScale,
  normalizeChatLineHeight,
  normalizeChatParagraphSpacing,
  toString
} from "./validators.js";

const LEGACY_AI_SYSTEM_PROMPTS = new Set<string>([
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V2,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V3,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V4,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V5,
  LEGACY_DEFAULT_AI_SYSTEM_PROMPT_V6
]);

function normalizeStoredAiSystemPrompt(value: unknown): string {
  const normalized = toString(value).trim();
  if (!normalized) {
    return "";
  }
  if (LEGACY_AI_SYSTEM_PROMPTS.has(normalized)) {
    return DEFAULT_AI_SYSTEM_PROMPT;
  }
  return normalized;
}

export interface SettingFieldSchema<K extends KnownSettingKey = KnownSettingKey> {
  readonly defaultValue: KnownSettings[K];
  readonly normalize?: (value: unknown) => KnownSettings[K];
  readonly passthrough?: true;
  readonly resetPreference?: true;
  readonly resetPreferenceValue?: KnownSettings[K];
}

type SettingSchemaTuple<K extends KnownSettingKey = KnownSettingKey> =
  | readonly [((value: unknown) => KnownSettings[K]) | null]
  | readonly [((value: unknown) => KnownSettings[K]) | null, true | KnownSettings[K]];

const boolFalse = booleanField(false);
const trimId = (value: unknown): string => String(value || "").trim();

const SETTINGS_SCHEMA_SPECS: { readonly [K in KnownSettingKey]: SettingSchemaTuple<K> } = {
  downloadFormat: [normalizeDownloadFormat, true],
  includeDateInFilename: [null, true],
  enablePlayerAiQuickAction: [normalizeEnablePlayerAiQuickAction, true],
  aiBtnDefaultOnMigrated: [null],
  playerAiQuickPrompt: [normalizePlayerAiQuickPrompt, DEFAULT_PLAYER_AI_QUICK_PROMPT],
  includeTimestampInBody: [null, true],
  enableDebugLogs: [null, true],
  enableAgentBridge: [boolFalse, true],
  agentBridgeUrl: [normalizeAgentBridgeUrl],
  readerTheme: [normalizeReaderTheme, true],
  readerThemeUserSet: [boolFalse],
  readerPalette: [normalizeReaderPalette, true],
  chatInputGlow: [normalizeChatInputGlow, true],
  reduceTransparency: [normalizeReduceTransparency, true],
  aiSystemPrompt: [normalizeStoredAiSystemPrompt, DEFAULT_AI_SYSTEM_PROMPT],
  aiInitialQuickPrompts: [normalizeAiInitialQuickPrompts, true],
  defaultModel: [normalizeDefaultModel],
  defaultAiModel: [normalizeDefaultAiModel],
  aiThinkingLevel: [normalizeAiThinkingLevel],
  enableCostGuard: [boolFalse, true],
  activeAsrProviderId: [trimId],
  activeLiveProviderId: [trimId],
  liveVoiceVolume: [normalizeLiveVoiceVolume, true],
  liveVoiceSpeed: [normalizeLiveVoiceSpeed, true],
  speechVoiceVolume: [normalizeSpeechVoiceVolume, true],
  liveVoicePriority: [normalizeLiveVoicePriority, true],
  liveShareVideoAudio: [normalizeLiveShareVideoAudio, true],
  liveGeminiNativeSearch: [normalizeLiveGeminiNativeSearch],
  liveLowBandwidth: [normalizeLiveLowBandwidth],
  subtitleTranslateProviderId: [normalizeSubtitleTranslateProviderId],
  subtitleTranslateModel: [normalizeSubtitleTranslateModel],
  subtitleTranslateGlossary: [normalizeSubtitleTranslateGlossary, true],
  liveInterpretTargetLang: [normalizeLiveInterpretTargetLang],
  liveInterpretDisplayMode: [normalizeLiveInterpretDisplayMode],
  liveInterpretFontScale: [normalizeLiveInterpretFontScale],
  liveInterpretBlurSecondary: [normalizeLiveInterpretBlurSecondary],
  asrAutoFallback: [booleanField(true)],
  asrLanguage: [normalizeAsrLanguage],
  activeSearchProviderId: [trimId],
  webSearchEnabled: [normalizeWebSearchEnabled],
  webSearchMaxToolCalls: [normalizeWebSearchMaxToolCalls],
  allowPaidSearchProviders: [normalizeAllowPaidSearchProviders],
  searchPresetsAutoActivated: [normalizeSearchPresetsAutoActivated],
  searchOptInNoticeAcknowledged: [normalizeSearchOptInNoticeAcknowledged],
  bilingualSubtitles: [normalizeBilingualSubtitles, true],
  secondarySubtitleLang: [normalizeSecondarySubtitleLang, true],
  bilingualDisplayOrder: [normalizeBilingualDisplayOrder, true],
  subtitleSegmentationStrategy: [normalizeSubtitleSegmentationStrategy, true],
  readerFontSizeScale: [normalizeReaderFontSizeScale, true],
  chatLineHeight: [normalizeChatLineHeight, true],
  chatParagraphSpacing: [normalizeChatParagraphSpacing, true],
  customPanelWidthEnabled: [normalizeCustomPanelWidthEnabled],
  customPanelWidth: [normalizeCustomPanelWidth],
  detachedWindowMode: [normalizeDetachedWindowMode, true],
  autoOpenReader: [normalizeAutoOpenReader, true],
  chatHistoryMaxCount: [normalizeChatHistoryMaxCount, true],
  videoCacheMaxMb: [normalizeVideoCacheMaxMb, true],
  enableExtraPlaybackRates: [boolFalse, true],
  noteExportTemplate: [normalizeNoteExportTemplate, DEFAULT_NOTE_TEMPLATE],
  obsidianVaultName: [normalizeObsidianVaultName, true],
  obsidianFolder: [normalizeObsidianFolder, true],
  playerAiActionMode: [normalizePlayerAiActionMode, true],
  playerAiAutoExportNote: [normalizePlayerAiAutoExportNote, true],
  notePromptPreset: [normalizeNotePromptPreset, true],
  noteCustomPrompt: [normalizeNoteCustomPrompt, true],
  noteExportTarget: [normalizeNoteExportTarget, true],
  noteDownloadSubdir: [normalizeNoteDownloadSubdir, true],
  noteIncludeKeyframes: [normalizeNoteIncludeKeyframes, true],
  enableAiOverview: [booleanField(true), true],
  autoGenerateOverview: [booleanField(true), true],
  overviewAiSummary: [booleanField(true), true],
  overviewAiChapters: [booleanField(true), true],
  overviewAiQuotes: [booleanField(true), true]
};

export const SETTINGS_SCHEMA: {
  readonly [K in KnownSettingKey]: SettingFieldSchema<K>;
} = Object.freeze(
  Object.fromEntries(
    (Object.entries(SETTINGS_SCHEMA_SPECS) as Array<[KnownSettingKey, SettingSchemaTuple]>).map(([key, spec]) => {
      const [normalize, reset] = spec;
      const entry: Record<string, unknown> = { defaultValue: DEFAULT_SETTINGS[key] };
      if (normalize) {
        entry.normalize = normalize;
      } else {
        entry.passthrough = true;
      }
      if (reset === true) {
        entry.resetPreference = true;
      } else if (reset !== undefined) {
        entry.resetPreferenceValue = reset;
      }
      return [key, entry];
    })
  ) as unknown as { readonly [K in KnownSettingKey]: SettingFieldSchema<K> }
);

export type PassthroughSettingKey =
  | "includeDateInFilename"
  | "includeTimestampInBody"
  | "enableDebugLogs"
  | "aiBtnDefaultOnMigrated";

export type NormalizableSettingKey = Exclude<KnownSettingKey, PassthroughSettingKey>;

export type DefaultPreferenceKey =
  | "downloadFormat"
  | "subtitleSegmentationStrategy"
  | "subtitleTranslateGlossary"
  | "includeDateInFilename"
  | "enablePlayerAiQuickAction"
  | "playerAiQuickPrompt"
  | "includeTimestampInBody"
  | "enableDebugLogs"
  | "enableAgentBridge"
  | "readerTheme"
  | "readerPalette"
  | "readerFontSizeScale"
  | "chatLineHeight"
  | "chatParagraphSpacing"
  | "speechVoiceVolume"
  | "liveVoiceVolume"
  | "liveVoiceSpeed"
  | "liveShareVideoAudio"
  | "liveVoicePriority"
  | "aiSystemPrompt"
  | "aiInitialQuickPrompts"
  | "bilingualSubtitles"
  | "secondarySubtitleLang"
  | "bilingualDisplayOrder"
  | "detachedWindowMode"
  | "autoOpenReader"
  | "enableCostGuard"
  | "enableExtraPlaybackRates"
  | "chatInputGlow"
  | "reduceTransparency"
  | "noteExportTemplate"
  | "obsidianVaultName"
  | "obsidianFolder"
  | "playerAiActionMode"
  | "playerAiAutoExportNote"
  | "notePromptPreset"
  | "noteCustomPrompt"
  | "noteExportTarget"
  | "noteDownloadSubdir"
  | "noteIncludeKeyframes"
  | "enableAiOverview"
  | "autoGenerateOverview"
  | "overviewAiSummary"
  | "overviewAiChapters"
  | "overviewAiQuotes";

export type DefaultPreferencePatch = Pick<KnownSettings, DefaultPreferenceKey>;

const SETTINGS_SCHEMA_ENTRIES = Object.entries(SETTINGS_SCHEMA) as Array<
  [KnownSettingKey, SettingFieldSchema]
>;

export const SETTINGS_PASSTHROUGH_KEYS: readonly PassthroughSettingKey[] = Object.freeze(
  SETTINGS_SCHEMA_ENTRIES
    .filter(([, entry]) => entry.passthrough === true)
    .map(([key]) => key as PassthroughSettingKey)
);

const SETTINGS_NORMALIZER_ENTRIES: Array<[NormalizableSettingKey, (value: unknown) => unknown]> =
  SETTINGS_SCHEMA_ENTRIES
    .filter(([, entry]) => entry.passthrough !== true && typeof entry.normalize === "function")
    .map(([key, entry]) => [key as NormalizableSettingKey, entry.normalize!]);

export const SETTINGS_FIELD_NORMALIZERS: {
  readonly [K in NormalizableSettingKey]: (value: unknown) => Settings[K];
} = Object.freeze(
  Object.fromEntries(SETTINGS_NORMALIZER_ENTRIES) as {
    readonly [K in NormalizableSettingKey]: (value: unknown) => Settings[K];
  }
);

export const SETTINGS_NORMALIZER_KEYS: readonly string[] = Object.freeze(
  SETTINGS_NORMALIZER_ENTRIES.map(([key]) => key)
);

const SETTINGS_STORAGE_KEYS = new Set<string>(Object.keys(SETTINGS_SCHEMA));

export function normalizeSettingField<K extends KnownSettingKey>(
  key: K,
  value: unknown
): KnownSettings[K] {
  const schema = SETTINGS_SCHEMA[key] as SettingFieldSchema<K>;
  if (schema.normalize) {
    return schema.normalize(value);
  }
  if (typeof schema.defaultValue === "boolean") {
    return (schema.defaultValue ? value !== false : value === true) as KnownSettings[K];
  }
  return (value === undefined ? schema.defaultValue : value) as KnownSettings[K];
}

export function buildDefaultPreferencePatch(): DefaultPreferencePatch {
  const patch: Record<string, unknown> = {};
  for (const [key, entry] of SETTINGS_SCHEMA_ENTRIES) {
    if (entry.resetPreferenceValue !== undefined) {
      patch[key] = Array.isArray(entry.resetPreferenceValue)
        ? [...entry.resetPreferenceValue]
        : entry.resetPreferenceValue;
    } else if (entry.resetPreference) {
      patch[key] = Array.isArray(entry.defaultValue)
        ? [...entry.defaultValue]
        : entry.defaultValue;
    }
  }
  return patch as DefaultPreferencePatch;
}

function applySubtitleTranslateModelNormalization(target: Record<string, unknown>): void {
  if (!("subtitleTranslateModel" in target)) {
    return;
  }
  if (target.subtitleTranslateProviderId === INDEX_TRANSLATE_PROVIDER_ID) {
    target.subtitleTranslateModel = normalizeIndexTranslateModel(target.subtitleTranslateModel);
  } else if (target.subtitleTranslateProviderId === SILICONFLOW_TRANSLATE_PROVIDER_ID) {
    target.subtitleTranslateModel = normalizeSiliconFlowTranslateModel(target.subtitleTranslateModel);
  }
}

export function normalizeSettings(merged: Record<string, unknown>): Settings {
  const source: Record<string, unknown> = { ...merged };
  const normalized: Record<string, unknown> = { ...merged };
  for (const [key, normalizeField] of SETTINGS_NORMALIZER_ENTRIES) {
    normalized[key] = normalizeField(source[key]);
  }
  applySubtitleTranslateModelNormalization(normalized);
  if (
    normalized.customPanelWidthEnabled !== true &&
    normalized.customPanelWidth !== DEFAULT_SETTINGS.customPanelWidth
  ) {
    normalized.customPanelWidthEnabled = true;
  }
  return normalized as Settings;
}

export function normalizeSettingsPatch(settings: unknown): Partial<KnownSettings> {
  const payload = settings && typeof settings === "object" ? (settings as Record<string, unknown>) : {};
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || !SETTINGS_STORAGE_KEYS.has(key)) {
      continue;
    }
    const schema = SETTINGS_SCHEMA[key as KnownSettingKey];
    normalized[key] = schema.passthrough ? value : schema.normalize!(value);
  }
  applySubtitleTranslateModelNormalization(normalized);
  return normalized as Partial<KnownSettings>;
}

export async function getMergedSettings(timeoutMs = 5000): Promise<Settings> {
  const syncSettings = await withTimeout(
    chrome.storage.sync.get(DEFAULT_SETTINGS),
    timeoutMs,
    new Error("storage timeout")
  ).catch(() => ({}));

  return normalizeSettings({ ...DEFAULT_SETTINGS, ...(syncSettings as Record<string, unknown>) });
}

export async function saveSettings(settings: unknown): Promise<void> {
  await chrome.storage.sync.set(normalizeSettingsPatch(settings));
}
