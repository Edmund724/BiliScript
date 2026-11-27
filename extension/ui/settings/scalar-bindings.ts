import { cleanExpiredConversations } from "../../chat/conversation-store.js";
import { DEFAULT_SETTINGS, type DetachedWindowMode, type KnownSettingKey, type Settings } from "../../core/defaults.js";
import { normalizeSettingField } from "../../core/settings-store.js";
import { state } from "../../core/state.js";
import type { ReaderThemeMode } from "../../core/validators.js";
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
  onDetachedWindowModeChanged?: (val: DetachedWindowMode, elements: SettingsElements) => void;
  onDownloadsPermissionNeeded?: (elements: SettingsElements) => Promise<void> | void;
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
  readonly normalize?: (value: unknown) => Settings[K] & string;
  readonly readFromSettings?: (settings: Partial<Settings>) => unknown;
  readonly commitExtras?: () => Record<string, unknown>;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly onApply?: (val: Settings[K] & string) => void;
  readonly onChange?: (val: Settings[K] & string, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
  readonly onSaved?: (val: Settings[K] & string, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
}

export interface ToggleFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "toggle";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly normalize?: (value: unknown) => boolean;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly persist?: ScalarFieldPersist;
  readonly onApply?: (val: boolean) => void;
  readonly onChange?: (val: boolean, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
  readonly onSaved?: (val: boolean, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
}

export interface SliderFieldBinding<K extends KnownSettingKey = KnownSettingKey> {
  readonly kind: "slider";
  readonly key: K;
  readonly getElement: (elements: SettingsElements) => HTMLInputElement;
  readonly getBadge: (elements: SettingsElements) => HTMLElement;
  readonly getResetBtn: (elements: SettingsElements) => HTMLButtonElement;
  readonly defaultValue: number;
  readonly normalize?: (value: unknown) => number;
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
  readonly normalize?: (value: unknown) => string;
  readonly patchState?: boolean;
  readonly watchSync?: boolean;
  readonly onChange?: (val: string, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
  readonly onSaved?: (val: string, hooks: ScalarBindingRuntimeHooks, elements: SettingsElements) => void;
}

export type ScalarFieldBinding =
  | SelectFieldBinding
  | ToggleFieldBinding
  | SliderFieldBinding
  | DebouncedTextFieldBinding;

export function normalizeScalarBindingValue(binding: SelectFieldBinding, value: unknown): string;
export function normalizeScalarBindingValue(binding: ToggleFieldBinding, value: unknown): boolean;
export function normalizeScalarBindingValue(binding: SliderFieldBinding, value: unknown): number;
export function normalizeScalarBindingValue(binding: DebouncedTextFieldBinding, value: unknown): string;
export function normalizeScalarBindingValue(binding: ScalarFieldBinding, value: unknown): unknown {
  return binding.normalize ? binding.normalize(value) : normalizeSettingField(binding.key, value);
}

export const SCALAR_FIELD_BINDINGS: readonly ScalarFieldBinding[] = [
  {
    kind: "select",
    key: "downloadFormat",
    getElement: (el) => el.downloadFormat
  },
  {
    kind: "select",
    key: "noteExportTarget",
    getElement: (el) => el.noteExportTarget,
    watchSync: true,
    onChange: (val, hooks, elements) => {
      if (
        val === "download"
        && (Boolean(elements.noteDownloadSubdir.value.trim()) || elements.playerAiAutoExportNote.checked)
      ) {
        void hooks.onDownloadsPermissionNeeded?.(elements);
      }
    }
  },
  {
    kind: "debounced-text",
    key: "noteDownloadSubdir",
    getElement: (el) => el.noteDownloadSubdir,
    watchSync: true,
    onChange: (val, hooks, elements) => {
      if (val.trim() && normalizeSettingField("noteExportTarget", elements.noteExportTarget.value) === "download") {
        void hooks.onDownloadsPermissionNeeded?.(elements);
      }
    }
  },
  {
    kind: "select",
    key: "notePromptPreset",
    getElement: (el) => el.notePromptPreset,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "noteCustomPrompt",
    getElement: (el) => el.noteCustomPrompt,
    watchSync: true
  },
  {
    kind: "toggle",
    key: "noteIncludeKeyframes",
    getElement: (el) => el.noteIncludeKeyframes,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "noteExportTemplate",
    getElement: (el) => el.noteExportTemplate,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "obsidianVaultName",
    getElement: (el) => el.obsidianVaultName,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "obsidianFolder",
    getElement: (el) => el.obsidianFolder,
    watchSync: true
  },
  {
    kind: "select",
    key: "subtitleSegmentationStrategy",
    getElement: (el) => el.subtitleSegmentationStrategy
  },
  {
    kind: "select",
    key: "bilingualDisplayOrder",
    getElement: (el) => el.bilingualDisplayOrder,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "subtitleTranslateGlossary",
    getElement: (el) => el.subtitleTranslateGlossary,
    watchSync: true
  },
  {
    kind: "select",
    key: "readerTheme",
    getElement: (el) => el.readerTheme,
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
    format: CHAT_DISPLAY_SLIDER_SPECS.speechVoiceVolume.format,
    patchState: false,
    persist: persistChatDisplayField,
    onPreview: (val) => applyChatDisplaySettings({ speechVoiceVolume: val })
  },
  {
    kind: "select",
    key: "detachedWindowMode",
    getElement: (el) => el.detachedWindowMode,
    watchSync: true,
    onChange: (val, hooks, elements) => {
      hooks.onDetachedWindowModeChanged?.(val as DetachedWindowMode, elements);
    }
  },
  {
    kind: "toggle",
    key: "includeDateInFilename",
    getElement: (el) => el.includeDateInFilename
  },
  {
    kind: "toggle",
    key: "enablePlayerAiQuickAction",
    getElement: (el) => el.enablePlayerAiQuickAction
  },
  {
    kind: "select",
    key: "playerAiActionMode",
    getElement: (el) => el.playerAiActionMode,
    watchSync: true
  },
  {
    kind: "debounced-text",
    key: "playerAiQuickPrompt",
    getElement: (el) => el.playerAiQuickPrompt
  },
  {
    kind: "toggle",
    key: "playerAiAutoExportNote",
    getElement: (el) => el.playerAiAutoExportNote,
    watchSync: true,
    onChange: (val, hooks, elements) => {
      if (val && normalizeSettingField("noteExportTarget", elements.noteExportTarget.value) === "download") {
        void hooks.onDownloadsPermissionNeeded?.(elements);
      }
    }
  },
  {
    kind: "toggle",
    key: "includeTimestampInBody",
    getElement: (el) => el.includeTimestampInBody
  },
  {
    kind: "toggle",
    key: "enableDebugLogs",
    getElement: (el) => el.enableDebugLogs
  },
  {
    kind: "toggle",
    key: "enableAgentBridge",
    getElement: (el) => el.enableAgentBridge,
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
    onApply: async (val) => {
      if (val) {
        await cleanExpiredConversations();
      }
    }
  },
  {
    kind: "toggle",
    key: "autoOpenReader",
    getElement: (el) => el.autoOpenReader
  },
  {
    kind: "toggle",
    key: "enableCostGuard",
    getElement: (el) => el.enableCostGuard,
    watchSync: true
  },
  {
    kind: "toggle",
    key: "enableExtraPlaybackRates",
    getElement: (el) => el.enableExtraPlaybackRates
  },
  {
    kind: "toggle",
    key: "chatInputGlow",
    getElement: (el) => el.chatInputGlow,
    onApply: () => {
      applyChatInputGlow();
    }
  },
  {
    kind: "toggle",
    key: "reduceTransparency",
    getElement: (el) => el.reduceTransparency,
    onApply: () => {
      applyReduceTransparency();
    }
  },
  {
    kind: "debounced-text",
    key: "aiSystemPrompt",
    getElement: (el) => el.aiSystemPrompt
  },
  {
    kind: "toggle",
    key: "asrAutoFallback",
    getElement: (el) => el.asrAutoFallback,
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
    normalize: (value) => normalizeSettingField("liveVoiceSpeed", typeof value === "string" ? Number(value) : value),
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
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField
  },
  {
    kind: "toggle",
    key: "liveVoicePriority",
    getElement: (el) => el.liveVoicePriority,
    patchState: false,
    watchSync: true,
    persist: persistLiveAudioField
  },
  {
    kind: "toggle",
    key: "liveLowBandwidth",
    getElement: (el) => el.liveLowBandwidth,
    patchState: false,
    watchSync: true
  },
  {
    kind: "toggle",
    key: "allowPaidSearchProviders",
    getElement: (el) => el.allowPaidSearchProviders,
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
    patchState: false,
    watchSync: true
  }
];

export function syncPlayerQuickPromptVisibility(elements: SettingsElements): void {
  const enabled = elements.enablePlayerAiQuickAction.checked;
  const mode = normalizeSettingField("playerAiActionMode", elements.playerAiActionMode.value);
  const modeRow = elements.playerAiActionMode.closest<HTMLElement>(".biliscript-set-row");
  if (modeRow) {
    modeRow.hidden = !enabled;
  }
  elements.playerAiActionMode.disabled = !enabled;
  elements.playerAiQuickPrompt.hidden = !enabled || mode === "note";
}

export function syncNoteCustomPromptVisibility(elements: SettingsElements): void {
  const isCustom = normalizeSettingField("notePromptPreset", elements.notePromptPreset.value) === "custom";
  const row = elements.noteCustomPrompt.closest<HTMLElement>(".biliscript-set-row");
  if (row) {
    row.hidden = !isCustom;
  }
  elements.noteCustomPrompt.hidden = !isCustom;
}

export function syncNoteExportTargetAvailability(elements: SettingsElements): void {
  const isDownload = normalizeSettingField("noteExportTarget", elements.noteExportTarget.value) === "download";
  elements.noteDownloadSubdir.disabled = !isDownload;
  const subdirRow = elements.noteDownloadSubdir.closest<HTMLElement>(".biliscript-set-row");
  if (subdirRow) {
    subdirRow.hidden = !isDownload;
  }
  elements.obsidianVaultName.disabled = isDownload;
  const vaultRow = elements.obsidianVaultName.closest<HTMLElement>(".biliscript-set-row");
  if (vaultRow) {
    vaultRow.hidden = isDownload;
  }
  elements.obsidianFolder.disabled = isDownload;
  const folderRow = elements.obsidianFolder.closest<HTMLElement>(".biliscript-set-row");
  if (folderRow) {
    folderRow.hidden = isDownload;
  }
}

export function syncChatInputGlowAvailability(elements: SettingsElements): void {
  const isEditorial = normalizeSettingField("readerPalette", elements.readerPalette.value) === "editorial";
  const row = elements.chatInputGlow.closest<HTMLElement>(".biliscript-toggle-row");
  elements.chatInputGlow.disabled = isEditorial;
  syncToggleSwitch(elements.chatInputGlow);
  row?.classList.toggle("is-disabled", isEditorial);
  if (row) {
    row.title = isEditorial ? "仅在「蓝雾玻璃」外观色板下生效" : "";
  }
}

export function syncScalarSideEffects(key: KnownSettingKey, elements: SettingsElements): void {
  if (key === "enablePlayerAiQuickAction" || key === "playerAiActionMode") {
    syncPlayerQuickPromptVisibility(elements);
  } else if (key === "notePromptPreset") {
    syncNoteCustomPromptVisibility(elements);
  } else if (key === "noteExportTarget") {
    syncNoteExportTargetAvailability(elements);
  } else if (key === "readerPalette") {
    syncChatInputGlowAvailability(elements);
  }
}
