import { cleanExpiredConversations } from "../../chat/conversation-store.js";
import { DEFAULT_SETTINGS, type KnownSettingKey, type Settings } from "../../core/defaults.js";
import { state } from "../../core/state.js";
import {
  normalizeBilingualDisplayOrder,
  normalizeChatInputGlow,
  normalizeCustomPanelWidth,
  normalizeDownloadFormat,
  normalizeLiveShareVideoAudio,
  normalizeLiveVoicePriority,
  normalizeLiveVoiceSpeed,
  normalizeLiveVoiceVolume,
  normalizeNoteExportTemplate,
  normalizeObsidianFolder,
  normalizeObsidianVaultName,
  normalizePlayerAiQuickPrompt,
  normalizeReaderFontSizeScale,
  normalizeReaderPalette,
  normalizeReaderTheme,
  normalizeReduceTransparency,
  normalizeSubtitleSegmentationStrategy,
  normalizeSubtitleTranslateGlossary,
  normalizeWebSearchMaxToolCalls,
  type ReaderThemeMode
} from "../../core/validators.js";
import {
  applyLiveAudioSettings,
  persistLiveAudioSettings,
  type LiveAudioSettingsPatch
} from "../../live/live-audio-settings.js";
import {
  applyChatDisplaySettings,
  CHAT_DISPLAY_SLIDER_SPECS,
  persistChatDisplaySettings,
  type ChatDisplaySettingsPatch
} from "../../reader/chat-display-settings.js";
import {
  applyChatInputGlow,
  applyReadingViewPresentation,
  applyReadingViewTypography,
  applyReduceTransparency
} from "../../reader/presentation.js";
import { relayoutScriptHost } from "../../reader/script-host.js";
import {
  resolveEffectiveTheme,
  resolveReaderThemeMode,
  writeThemeSnapshot
} from "../../shared/host-theme.js";
import type { SaveSettingsResponse } from "../../shared/messaging-protocol.js";
import { syncToggleSwitch } from "../toggle-switch.js";
import type { SettingsElements } from "./elements.js";

export interface ScalarBindingRuntimeHooks {
  onAgentBridgeSaved?: (val: boolean, elements: SettingsElements) => void;
  onAsrAutoFallbackSaved?: (val: boolean, elements: SettingsElements) => void;
}

export type ScalarFieldPersist = (patch: Record<string, unknown>) => Promise<SaveSettingsResponse>;

export const persistLiveAudioField: ScalarFieldPersist = (patch) =>
  persistLiveAudioSettings(patch as LiveAudioSettingsPatch);

export const persistChatDisplayField: ScalarFieldPersist = (patch) =>
  persistChatDisplaySettings(patch as ChatDisplaySettingsPatch);

export interface SelectFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "select";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLSelectElement;
  readonly normalize: (value: unknown) => Settings[K] & string;
  readonly readFromSettings?: (settings: Partial<Settings>) => unknown;
  readonly commitExtras?: () => Record<string, unknown>;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly onApply?: (val: Settings[K] & string) => void;
}

export interface ToggleFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "toggle";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly normalize: (value: unknown) => boolean;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly persist?: ScalarFieldPersist;
  readonly onApply?: (val: boolean) => void;
  readonly onSaved?: (val: boolean, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
}

export interface SliderFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "slider";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly getBadge: (elements: SettingsElements) => HTMLElement;
  readonly getResetBtn: (elements: SettingsElements) => HTMLButtonElement;
  readonly defaultValue: number;
  readonly normalize: (value: unknown) => number;
  readonly format?: (val: number) => string;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly persist?: ScalarFieldPersist;
  readonly commitExtras?: () => Record<string, unknown>;
  readonly resetExtras?: () => Record<string, unknown>;
  readonly onPreview?: (val: number) => void;
}

export interface DebouncedTextFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "debounced-text";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLTextAreaElement | HTMLInputElement;
  readonly normalize: (value: unknown) => string;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
}

export type ScalarFieldBinding =
  | SelectFieldBinding
  | ToggleFieldBinding
  | SliderFieldBinding
  | DebouncedTextFieldBinding;

export const SCALAR_FIELD_BINDINGS: readonly ScalarFieldBinding[] = [
  {
    kind: "select",
    key: "downloadFormat",
    getElement: (el) => el.downloadFormat,
    normalize: normalizeDownloadFormat
  },
  {
    kind: "debounced-text",
    key: "noteExportTemplate",
    getElement: (el) => el.noteExportTemplate,
    normalize: normalizeNoteExportTemplate,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "obsidianVaultName",
    getElement: (el) => el.obsidianVaultName,
    normalize: normalizeObsidianVaultName,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "obsidianFolder",
    getElement: (el) => el.obsidianFolder,
    normalize: normalizeObsidianFolder,
    watchSync: true
  },
  {
    kind: "select",
    key: "subtitleSegmentationStrategy",
    getElement: (el) => el.subtitleSegmentationStrategy,
    normalize: normalizeSubtitleSegmentationStrategy
  },
  {
    kind: "select",
    key: "bilingualDisplayOrder",
    getElement: (el) => el.bilingualDisplayOrder,
    normalize: normalizeBilingualDisplayOrder,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "subtitleTranslateGlossary",
    getElement: (el) => el.subtitleTranslateGlossary,
    normalize: normalizeSubtitleTranslateGlossary,
    watchSync: true
  },
  {
    kind: "select",
    key: "readerTheme",
    getElement: (el) => el.readerTheme,
    normalize: normalizeReaderTheme,
    readFromSettings: (settings) => resolveReaderThemeMode(settings),
    commitExtras: () => ({ readerThemeUserSet: true }),
    watchSync: true,
    onApply: (val) => {
      const mode = val as ReaderThemeMode;
      const resolved = resolveEffectiveTheme(mode);
      state.reader?.setThemeMode?.(mode);
      state.reader?.setTheme?.(resolved);
      writeThemeSnapshot({
        mode,
        palette: state.reader?.readingPalette || "flyme",
        resolved
      });
      applyReadingViewPresentation();
    }
  },
  {
    kind: "select",
    key: "readerPalette",
    getElement: (el) => el.readerPalette,
    normalize: normalizeReaderPalette,
    onApply: (val) => {
      state.reader?.setPalette?.(val);
      writeThemeSnapshot({
        mode: (state.reader?.readingThemeMode || "bilibili") as ReaderThemeMode,
        palette: val,
        resolved: state.reader?.readingTheme === "dark" ? "dark" : "light"
      });
      applyReadingViewPresentation();
    }
  },
  {
    kind: "slider",
    key: "readerFontSizeScale",
    getElement: (el) => el.readerFontSizeScale,
    getBadge: (el) => el.readerFontSizeScaleValue,
    getResetBtn: (el) => el.readerFontSizeScaleResetBtn,
    defaultValue: DEFAULT_SETTINGS.readerFontSizeScale,
    normalize: normalizeReaderFontSizeScale,
    format: (val) => `${val}%`,
    onPreview: () => {
      applyReadingViewTypography();
    }
  },
  {
    kind: "slider",
    key: "chatLineHeight",
    getElement: (el) => el.chatLineHeight,
    getBadge: (el) => el.chatLineHeightValue,
    getResetBtn: (el) => el.chatLineHeightResetBtn,
    defaultValue: CHAT_DISPLAY_SLIDER_SPECS.chatLineHeight.defaultValue,
    normalize: CHAT_DISPLAY_SLIDER_SPECS.chatLineHeight.normalize,
    format: CHAT_DISPLAY_SLIDER_SPECS.chatLineHeight.format,
    patchState: false,
    persist: persistChatDisplayField,
    onPreview: (val) => applyChatDisplaySettings({ chatLineHeight: val })
  },
  {
    kind: "slider",
    key: "chatParagraphSpacing",
    getElement: (el) => el.chatParagraphSpacing,
    getBadge: (el) => el.chatParagraphSpacingValue,
    getResetBtn: (el) => el.chatParagraphSpacingResetBtn,
    defaultValue: CHAT_DISPLAY_SLIDER_SPECS.chatParagraphSpacing.defaultValue,
    normalize: CHAT_DISPLAY_SLIDER_SPECS.chatParagraphSpacing.normalize,
    format: CHAT_DISPLAY_SLIDER_SPECS.chatParagraphSpacing.format,
    patchState: false,
    persist: persistChatDisplayField,
    onPreview: (val) => applyChatDisplaySettings({ chatParagraphSpacing: val })
  },
  {
    kind: "slider",
    key: "speechVoiceVolume",
    getElement: (el) => el.speechVoiceVolume,
    getBadge: (el) => el.speechVoiceVolumeValue,
    getResetBtn: (el) => el.speechVoiceVolumeResetBtn,
    defaultValue: CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.defaultValue,
    normalize: CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.normalize,
    format: CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.format,
    patchState: false,
    persist: persistChatDisplayField,
    onPreview: (val) => applyChatDisplaySettings({ speechVoiceVolume: val })
  },
  {
    kind: "slider",
    key: "customPanelWidth",
    getElement: (el) => el.customPanelWidth,
    getBadge: (el) => el.customPanelWidthValue,
    getResetBtn: (el) => el.customPanelWidthResetBtn,
    defaultValue: DEFAULT_SETTINGS.customPanelWidth,
    normalize: normalizeCustomPanelWidth,
    format: (width) => `${width}px`,
    commitExtras: () => ({ customPanelWidthEnabled: true }),
    resetExtras: () => ({ customPanelWidthEnabled: false }),
    onPreview: () => {
      relayoutScriptHost();
    }
  },
  {
    kind: "toggle",
    key: "includeDateInFilename",
    getElement: (el) => el.includeDateInFilename,
    normalize: (val) => val !== false
  },
  {
    kind: "toggle",
    key: "enablePlayerAiQuickAction",
    getElement: (el) => el.enablePlayerAiQuickAction,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "debounced-text",
    key: "playerAiQuickPrompt",
    getElement: (el) => el.playerAiQuickPrompt,
    normalize: normalizePlayerAiQuickPrompt
  },
  {
    kind: "toggle",
    key: "includeTimestampInBody",
    getElement: (el) => el.includeTimestampInBody,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "toggle",
    key: "enableDebugLogs",
    getElement: (el) => el.enableDebugLogs,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "toggle",
    key: "enableAgentBridge",
    getElement: (el) => el.enableAgentBridge,
    normalize: (val) => val === true,
    patchState: false,
    watchSync: true,
    onSaved: (val, hooks, elements) => {
      hooks.onAgentBridgeSaved?.(val, elements);
    }
  },
  {
    kind: "toggle",
    key: "cleanConversationsOlderThan30Days",
    getElement: (el) => el.cleanConversationsOlderThan30Days,
    normalize: (val) => val === true,
    onApply: async (val) => {
      if (val) {
        await cleanExpiredConversations();
      }
    }
  },
  {
    kind: "toggle",
    key: "autoOpenReader",
    getElement: (el) => el.autoOpenReader,
    normalize: (val) => val === true
  },
  {
    kind: "toggle",
    key: "enableExtraPlaybackRates",
    getElement: (el) => el.enableExtraPlaybackRates,
    normalize: (val) => Boolean(val)
  },
  {
    kind: "toggle",
    key: "chatInputGlow",
    getElement: (el) => el.chatInputGlow,
    normalize: normalizeChatInputGlow,
    onApply: () => {
      applyChatInputGlow();
    }
  },
  {
    kind: "toggle",
    key: "reduceTransparency",
    getElement: (el) => el.reduceTransparency,
    normalize: normalizeReduceTransparency,
    onApply: () => {
      applyReduceTransparency();
    }
  },
  {
    kind: "debounced-text",
    key: "aiSystemPrompt",
    getElement: (el) => el.aiSystemPrompt,
    normalize: (val) => String(val || "").trim()
  },
  {
    kind: "toggle",
    key: "asrAutoFallback",
    getElement: (el) => el.asrAutoFallback,
    normalize: (val) => val !== false,
    patchState: false,
    watchSync: true,
    onSaved: (val, hooks, elements) => {
      hooks.onAsrAutoFallbackSaved?.(val, elements);
    }
  },
  {
    kind: "slider",
    key: "liveVoiceVolume",
    getElement: (el) => el.liveVoiceVolume,
    getBadge: (el) => el.liveVoiceVolumeValue,
    getResetBtn: (el) => el.liveVoiceVolumeResetBtn,
    defaultValue: DEFAULT_SETTINGS.liveVoiceVolume,
    normalize: normalizeLiveVoiceVolume,
    format: (val) => `${val}%`,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField,
    onPreview: (val) => applyLiveAudioSettings({ liveVoiceVolume: val })
  },
  {
    kind: "slider",
    key: "liveVoiceSpeed",
    getElement: (el) => el.liveVoiceSpeed,
    getBadge: (el) => el.liveVoiceSpeedValue,
    getResetBtn: (el) => el.liveVoiceSpeedResetBtn,
    defaultValue: DEFAULT_SETTINGS.liveVoiceSpeed,
    normalize: (value) => normalizeLiveVoiceSpeed(typeof value === "string" ? Number(value) : value),
    format: (val) => `${val}×`,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField,
    onPreview: (val) => applyLiveAudioSettings({ liveVoiceSpeed: val })
  },
  {
    kind: "toggle",
    key: "liveShareVideoAudio",
    getElement: (el) => el.liveShareVideoAudio,
    normalize: normalizeLiveShareVideoAudio,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField
  },
  {
    kind: "toggle",
    key: "liveVoicePriority",
    getElement: (el) => el.liveVoicePriority,
    normalize: normalizeLiveVoicePriority,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField
  },
  {
    kind: "toggle",
    key: "liveLowBandwidth",
    getElement: (el) => el.liveLowBandwidth,
    normalize: (val) => val === true,
    patchState: false,
    watchSync: true
  },
  {
    kind: "toggle",
    key: "allowPaidSearchProviders",
    getElement: (el) => el.allowPaidSearchProviders,
    normalize: (val) => val === true,
    patchState: false,
    watchSync: true
  },
  {
    kind: "slider",
    key: "webSearchMaxToolCalls",
    getElement: (el) => el.webSearchMaxToolCalls,
    getBadge: (el) => el.webSearchMaxToolCallsValue,
    getResetBtn: (el) => el.webSearchMaxToolCallsResetBtn,
    defaultValue: DEFAULT_SETTINGS.webSearchMaxToolCalls,
    normalize: normalizeWebSearchMaxToolCalls,
    patchState: false,
    watchSync: true
  }
];

export function syncPlayerQuickPromptVisibility(elements: SettingsElements): void {
  elements.playerAiQuickPrompt.hidden = !elements.enablePlayerAiQuickAction.checked;
}

export function syncChatInputGlowAvailability(elements: SettingsElements): void {
  const isEditorial = normalizeReaderPalette(elements.readerPalette.value) === "editorial";
  const row = elements.chatInputGlow.closest<HTMLElement>(".biliscript-toggle-row");
  elements.chatInputGlow.disabled = isEditorial;
  syncToggleSwitch(elements.chatInputGlow);
  row?.classList.toggle("is-disabled", isEditorial);
  if (row) {
    row.title = isEditorial ? "仅在「蓝雾玻璃」外观色板下生效" : "";
  }
}

export function syncScalarSideEffects(key: KnownSettingKey, elements: SettingsElements): void {
  if (key === "enablePlayerAiQuickAction") {
    syncPlayerQuickPromptVisibility(elements);
  } else if (key === "readerPalette") {
    syncChatInputGlowAvailability(elements);
  }
}
