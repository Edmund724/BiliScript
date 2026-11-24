import { DEFAULT_SETTINGS, type Settings } from "../core/defaults.js";
import { state } from "../core/state.js";
import {
  normalizeChatLineHeight,
  normalizeChatParagraphSpacing,
  normalizeSpeechVoiceVolume
} from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { SaveSettingsResponse } from "../shared/messaging-protocol.js";
import { supportsTtsSpeech } from "../shared/runtime-capabilities.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { bindResettableRangeSlider, type ResettableRangeSlider } from "../ui/range-slider.js";
import { applyReadingViewTypography } from "./presentation.js";

export type ChatDisplaySettingKey =
  | "chatLineHeight"
  | "chatParagraphSpacing"
  | "speechVoiceVolume";

export interface ChatDisplaySettingsPatch {
  chatLineHeight?: number;
  chatParagraphSpacing?: number;
  speechVoiceVolume?: number;
}

export interface ChatDisplaySliderSpec<K extends ChatDisplaySettingKey = ChatDisplaySettingKey> {
  readonly key: K;
  readonly label: string;
  readonly resetTitle: string;
  readonly resetAriaLabel: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  readonly defaultProgressPct: number;
  readonly normalize: (raw: unknown) => number;
  readonly format: (val: number) => string;
  readonly triggersTypography: boolean;
  readonly requiresTts?: boolean;
  readonly rangeLabels?: readonly [string, string];
}

export const CHAT_DISPLAY_SETTING_KEYS: readonly ChatDisplaySettingKey[] = [
  "chatLineHeight",
  "chatParagraphSpacing",
  "speechVoiceVolume"
] as const;

export const CHAT_DISPLAY_SLIDER_SPECS: Readonly<{
  [K in ChatDisplaySettingKey]: ChatDisplaySliderSpec<K>;
}> = {
  chatLineHeight: {
    key: "chatLineHeight",
    label: "对话行高",
    resetTitle: `恢复默认对话行高 (${DEFAULT_SETTINGS.chatLineHeight}%)`,
    resetAriaLabel: "恢复默认对话行高",
    min: 120,
    max: 200,
    step: 5,
    defaultValue: DEFAULT_SETTINGS.chatLineHeight,
    defaultProgressPct: 50,
    normalize: normalizeChatLineHeight,
    format: (val) => `${val}%`,
    triggersTypography: true,
    rangeLabels: ["紧凑", "宽松"]
  },
  chatParagraphSpacing: {
    key: "chatParagraphSpacing",
    label: "对话段落间距",
    resetTitle: `恢复默认对话段落间距 (${DEFAULT_SETTINGS.chatParagraphSpacing}px)`,
    resetAriaLabel: "恢复默认对话段落间距",
    min: 4,
    max: 20,
    step: 2,
    defaultValue: DEFAULT_SETTINGS.chatParagraphSpacing,
    defaultProgressPct: 50,
    normalize: normalizeChatParagraphSpacing,
    format: (val) => `${val}px`,
    triggersTypography: true,
    rangeLabels: ["紧凑", "宽松"]
  },
  speechVoiceVolume: {
    key: "speechVoiceVolume",
    label: "对话朗读音量",
    resetTitle: `恢复默认对话朗读音量 (${DEFAULT_SETTINGS.speechVoiceVolume}%)`,
    resetAriaLabel: "恢复默认对话朗读音量",
    min: 0,
    max: 100,
    step: 1,
    defaultValue: DEFAULT_SETTINGS.speechVoiceVolume,
    defaultProgressPct: 100,
    normalize: normalizeSpeechVoiceVolume,
    format: (val) => `${val}%`,
    triggersTypography: false,
    requiresTts: true
  }
};

type ChatDisplaySettingsInput = { [K in ChatDisplaySettingKey]?: unknown };
type ChatDisplaySettingsListener = (patch: ChatDisplaySettingsPatch) => void;

const localListeners = new Set<ChatDisplaySettingsListener>();

export function isChatDisplaySliderAvailable(key: ChatDisplaySettingKey): boolean {
  const spec = CHAT_DISPLAY_SLIDER_SPECS[key];
  return spec.requiresTts ? supportsTtsSpeech() : true;
}

function normalizeChatDisplayPatch(input: ChatDisplaySettingsInput): {
  patch: ChatDisplaySettingsPatch;
  hasChange: boolean;
  typographyChanged: boolean;
} {
  const patch: ChatDisplaySettingsPatch = {};
  let hasChange = false;
  let typographyChanged = false;
  for (const key of CHAT_DISPLAY_SETTING_KEYS) {
    if (key in input) {
      const spec = CHAT_DISPLAY_SLIDER_SPECS[key];
      patch[key] = spec.normalize(input[key]);
      hasChange = true;
      if (spec.triggersTypography) {
        typographyChanged = true;
      }
    }
  }
  return { patch, hasChange, typographyChanged };
}

function commitNormalizedPatch(
  patch: ChatDisplaySettingsPatch,
  typographyChanged: boolean
): void {
  state.patchSettings(patch as Partial<Settings>);
  if (typographyChanged) {
    applyReadingViewTypography();
  }
}

export function applyChatDisplaySettings(input: ChatDisplaySettingsInput): ChatDisplaySettingsPatch {
  const { patch, hasChange, typographyChanged } = normalizeChatDisplayPatch(input);
  if (!hasChange) {
    return patch;
  }
  commitNormalizedPatch(patch, typographyChanged);
  for (const listener of [...localListeners]) {
    listener(patch);
  }
  return patch;
}

export function persistChatDisplaySettings(
  input: ChatDisplaySettingsInput
): Promise<SaveSettingsResponse> {
  const patch = applyChatDisplaySettings(input);
  if (Object.keys(patch).length === 0) {
    return Promise.resolve({ ok: true });
  }
  return sendRuntimeMessage({
    type: "save-settings",
    settings: patch
  }).catch((error) => ({
    ok: false as const,
    error: (error as Error).message || "保存失败"
  }));
}

export function watchChatDisplaySettings(
  onSync: (patch: ChatDisplaySettingsPatch) => void
): () => void {
  const localListener: ChatDisplaySettingsListener = (patch) => {
    onSync(patch);
  };
  localListeners.add(localListener);
  const unsubscribeStorage = watchStorageKeys(
    (changes) => {
      const incoming: ChatDisplaySettingsInput = {};
      for (const key of CHAT_DISPLAY_SETTING_KEYS) {
        if (changes[key]) {
          incoming[key] = changes[key].newValue;
        }
      }
      const { patch, hasChange, typographyChanged } = normalizeChatDisplayPatch(incoming);
      if (!hasChange) {
        return;
      }
      commitNormalizedPatch(patch, typographyChanged);
      onSync(patch);
    },
    { sync: [...CHAT_DISPLAY_SETTING_KEYS] }
  );
  return () => {
    localListeners.delete(localListener);
    unsubscribeStorage();
  };
}

export interface ChatDisplaySliderSlot {
  input: HTMLInputElement | null | undefined;
  badge: HTMLElement | null | undefined;
  resetBtn: HTMLButtonElement | null | undefined;
  row?: HTMLElement | null | undefined;
}

export type ChatDisplaySliderSlots = Record<ChatDisplaySettingKey, ChatDisplaySliderSlot>;

export interface BindChatDisplaySlidersOptions {
  onPreview?: (patch: ChatDisplaySettingsPatch) => void;
  onCommit?: (patch: ChatDisplaySettingsPatch) => void | Promise<void>;
}

export interface ChatDisplaySlidersController {
  syncFromState: (source?: Partial<Settings> | ChatDisplaySettingsPatch) => void;
  syncPatch: (patch: ChatDisplaySettingsPatch) => void;
  syncVisibility: () => void;
}

export function bindChatDisplaySliders(
  slots: ChatDisplaySliderSlots,
  options: BindChatDisplaySlidersOptions = {}
): ChatDisplaySlidersController {
  const controllers = {} as Record<ChatDisplaySettingKey, ResettableRangeSlider>;

  for (const key of CHAT_DISPLAY_SETTING_KEYS) {
    const spec = CHAT_DISPLAY_SLIDER_SPECS[key];
    const slot = slots[key];
    controllers[key] = bindResettableRangeSlider({
      input: slot.input,
      badge: slot.badge,
      resetBtn: slot.resetBtn,
      defaultValue: spec.defaultValue,
      normalize: spec.normalize,
      format: spec.format,
      initialValue: state.settings?.[key],
      onPreview: (val) => {
        const patch: ChatDisplaySettingsPatch = { [key]: val };
        applyChatDisplaySettings(patch);
        options.onPreview?.(patch);
      },
      onCommit: (val) => {
        const patch: ChatDisplaySettingsPatch = { [key]: val };
        if (options.onCommit) {
          return options.onCommit(patch);
        }
        return persistChatDisplaySettings(patch).then(() => undefined);
      }
    });
  }

  function syncVisibility(): void {
    for (const key of CHAT_DISPLAY_SETTING_KEYS) {
      const row = slots[key].row;
      if (row) {
        row.hidden = !isChatDisplaySliderAvailable(key);
      }
    }
  }

  function syncFromState(source: Partial<Settings> | ChatDisplaySettingsPatch = state.settings): void {
    for (const key of CHAT_DISPLAY_SETTING_KEYS) {
      controllers[key].setValue(source?.[key]);
    }
  }

  function syncPatch(patch: ChatDisplaySettingsPatch): void {
    for (const key of CHAT_DISPLAY_SETTING_KEYS) {
      if (key in patch) {
        controllers[key].setValue(patch[key]);
      }
    }
  }

  syncVisibility();

  return {
    syncFromState,
    syncPatch,
    syncVisibility
  };
}

export function clearChatDisplaySettingsListenersForTests(): void {
  localListeners.clear();
}
