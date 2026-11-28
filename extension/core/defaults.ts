import type { ThinkingLevelValue } from "../ai/thinking-levels.js";
import type {
  BilingualDisplayOrder,
  InterpretSubtitleDisplayMode,
  LiveInterpretTargetLang
} from "../live/interpret-subtitle-preferences.js";
import type { SubtitleSegmentationStrategy } from "../subtitle/segmentation.js";
import type { ShortcutBindings } from "../shared/shortcuts.js";
export type { SubtitleSegmentationStrategy, BilingualDisplayOrder, ShortcutBindings };

export type DetachedWindowMode = "pip" | "popup";
export type PlayerAiActionMode = "summary" | "note" | "overview";
export type NotePromptPreset = "general" | "tutorial" | "course" | "opinion" | "custom";
export type NoteExportTarget = "download" | "obsidian";
export type ChatHistoryMaxCount = 0 | 20 | 50 | 100 | 200;
export type VideoCacheMaxMb = 50 | 150 | 300 | 500 | 1024;

export { BILISCRIPT_VERSION } from "./version.js";

export const AI_PROVIDER_MODELS_LOCAL_KEY = "biliscript_ai_provider_models_v1";

export interface KnownSettings {
  downloadFormat: string;
  includeDateInFilename: boolean;
  enablePlayerAiQuickAction: boolean;
  aiBtnDefaultOnMigrated: boolean;
  playerAiQuickPrompt: string;
  includeTimestampInBody: boolean;
  enableDebugLogs: boolean;
  enableAgentBridge: boolean;
  agentBridgeUrl: string;
  readerTheme: string;
  readerThemeUserSet: boolean;
  readerPalette: string;
  chatInputGlow: boolean;
  reduceTransparency: boolean;
  aiSystemPrompt: string;
  aiInitialQuickPrompts: string[];
  defaultModel: string;
  defaultAiModel: string;
  aiThinkingLevel: ThinkingLevelValue;
  enableCostGuard: boolean;
  activeAsrProviderId: string;
  activeLiveProviderId: string;
  liveVoiceVolume: number;
  liveVoiceSpeed: number;
  speechVoiceVolume: number;
  liveVoicePriority: boolean;
  liveShareVideoAudio: boolean;
  liveGeminiNativeSearch: boolean;
  liveLowBandwidth: boolean;
  subtitleTranslateProviderId: string;
  subtitleTranslateModel: string;
  subtitleTranslateGlossary: string;
  liveInterpretTargetLang: LiveInterpretTargetLang;
  liveInterpretDisplayMode: InterpretSubtitleDisplayMode;
  liveInterpretFontScale: number;
  liveInterpretBlurSecondary: boolean;
  asrAutoFallback: boolean;
  asrLanguage: string;
  activeSearchProviderId: string;
  webSearchEnabled: boolean;
  webSearchMaxToolCalls: number;
  allowPaidSearchProviders: boolean;
  searchPresetsAutoActivated: boolean;
  searchOptInNoticeAcknowledged: boolean;
  bilingualSubtitles: boolean;
  secondarySubtitleLang: string;
  bilingualDisplayOrder: BilingualDisplayOrder;
  subtitleSegmentationStrategy: SubtitleSegmentationStrategy;
  readerFontSizeScale: number;
  chatLineHeight: number;
  chatParagraphSpacing: number;
  customPanelWidthEnabled: boolean;
  customPanelWidth: number;
  detachedWindowMode: DetachedWindowMode;
  autoOpenReader: boolean;
  chatHistoryMaxCount: ChatHistoryMaxCount;
  videoCacheMaxMb: VideoCacheMaxMb;
  enableExtraPlaybackRates: boolean;
  noteExportTemplate: string;
  obsidianVaultName: string;
  obsidianFolder: string;
  playerAiActionMode: PlayerAiActionMode;
  playerAiAutoExportNote: boolean;
  notePromptPreset: NotePromptPreset;
  noteCustomPrompt: string;
  noteExportTarget: NoteExportTarget;
  noteDownloadSubdir: string;
  noteIncludeKeyframes: boolean;
  autoGenerateOverview: boolean;
  overviewAiSummary: boolean;
  overviewAiChapters: boolean;
  overviewAiQuotes: boolean;
  shortcuts: Partial<ShortcutBindings>;
}

export interface Settings extends KnownSettings {
  [key: string]: unknown;
}

export type KnownSettingKey = keyof KnownSettings;

export const DEFAULT_SETTINGS: Settings = {
  downloadFormat: "srt",
  includeDateInFilename: true,
  enablePlayerAiQuickAction: true,
  aiBtnDefaultOnMigrated: false,
  playerAiQuickPrompt: "",
  includeTimestampInBody: true,
  enableDebugLogs: false,
  enableAgentBridge: false,
  agentBridgeUrl: "ws://127.0.0.1:18492",
  readerTheme: "bilibili",
  readerThemeUserSet: false,
  readerPalette: "flyme",
  chatInputGlow: true,
  reduceTransparency: false,
  aiSystemPrompt: "",
  aiInitialQuickPrompts: [],
  defaultModel: "",
  defaultAiModel: "",
  aiThinkingLevel: "default",
  enableCostGuard: false,
  activeAsrProviderId: "",
  activeLiveProviderId: "",
  liveVoiceVolume: 100,
  liveVoiceSpeed: 1,
  speechVoiceVolume: 100,
  liveVoicePriority: true,
  liveShareVideoAudio: false,
  liveGeminiNativeSearch: false,
  liveLowBandwidth: false,
  subtitleTranslateProviderId: "bilibili-index-translate",
  subtitleTranslateModel: "Index-Translate-35B-A3B",
  subtitleTranslateGlossary: "",
  liveInterpretTargetLang: "zh",
  liveInterpretDisplayMode: "auto",
  liveInterpretFontScale: 100,
  liveInterpretBlurSecondary: false,
  asrAutoFallback: true,
  asrLanguage: "auto",
  activeSearchProviderId: "",
  webSearchEnabled: false,
  webSearchMaxToolCalls: 5,
  allowPaidSearchProviders: false,
  searchPresetsAutoActivated: false,
  searchOptInNoticeAcknowledged: false,
  bilingualSubtitles: false,
  secondarySubtitleLang: "en-US",
  bilingualDisplayOrder: "original-first",
  subtitleSegmentationStrategy: "auto",
  readerFontSizeScale: 100,
  chatLineHeight: 160,
  chatParagraphSpacing: 12,
  customPanelWidthEnabled: false,
  customPanelWidth: 540,
  detachedWindowMode: "pip",
  autoOpenReader: false,
  chatHistoryMaxCount: 0,
  videoCacheMaxMb: 150,
  enableExtraPlaybackRates: false,
  noteExportTemplate: "",
  obsidianVaultName: "",
  obsidianFolder: "",
  playerAiActionMode: "summary",
  playerAiAutoExportNote: false,
  notePromptPreset: "general",
  noteCustomPrompt: "",
  noteExportTarget: "download",
  noteDownloadSubdir: "",
  noteIncludeKeyframes: false,
  autoGenerateOverview: true,
  overviewAiSummary: true,
  overviewAiChapters: true,
  overviewAiQuotes: true,
  shortcuts: {}
};
