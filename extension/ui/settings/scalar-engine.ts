import { DEFAULT_AI_SYSTEM_PROMPT } from "../../core/default-prompts.js";
import type { Settings } from "../../core/defaults.js";
import { resetDetachedWindowBounds } from "../../core/detached-bounds-store.js";
import { buildDefaultPreferencePatch, normalizeSettingField } from "../../core/settings-store.js";
import { state } from "../../core/state.js";
import { applyLiveAudioSettings } from "../../live/live-audio-settings.js";
import { DEFAULT_NOTE_TEMPLATE } from "../../notes/template-defaults.js";
import {
  CHAT_DISPLAY_SETTING_KEYS,
  applyChatDisplaySettings,
  type ChatDisplaySettingsPatch
} from "../../reader/chat-display-settings.js";
import { applyReadingViewTypography } from "../../reader/presentation.js";
import { getErrorMessage } from "../../shared/error-helpers.js";
import { sendRuntimeMessage } from "../../shared/messaging.js";
import { confirmDialog } from "../confirm-dialog.js";
import { initCustomSelect, setCustomSelectValue } from "../custom-select.js";
import { bindResettableRangeSlider, setResettableRangeValue } from "../range-slider.js";
import { initToggleSwitch, syncToggleSwitch } from "../toggle-switch.js";
import {
  clearStatusClearTimer,
  debounce,
  getStatusVersion,
  scheduleStatusAutoClear,
  setBusy,
  setStatus,
  type SettingsElements
} from "./elements.js";
import {
  SCALAR_FIELD_BINDINGS,
  normalizeScalarBindingValue,
  syncScalarSideEffects,
  type ScalarBindingRuntimeHooks,
  type ScalarFieldBinding,
  type ScalarFieldPersist
} from "./scalar-bindings.js";
import { collectInitialQuickPrompts } from "./summaries.js";

export { clearStatusClearTimer, type ScalarBindingRuntimeHooks };

export interface ScalarSettingsBindDeps {
  syncSummaries: () => void;
  reloadSettings: () => Promise<void>;
  hooks?: ScalarBindingRuntimeHooks;
}

const WATCHED_SCALAR_BINDINGS = SCALAR_FIELD_BINDINGS.filter((binding) => binding.watchSync);

export const WATCHED_SCALAR_SYNC_KEYS: readonly string[] = WATCHED_SCALAR_BINDINGS.map(
  (binding) => binding.key
);

const pendingDebounceCancels = new Set<() => void>();

export function disposeScalarBindings(): void {
  clearStatusClearTimer();
  for (const cancel of pendingDebounceCancels) {
    cancel();
  }
  pendingDebounceCancels.clear();
}

function hydrateScalarField(
  binding: ScalarFieldBinding,
  elements: SettingsElements,
  rawValue: unknown
): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      setCustomSelectValue(el, normalizeScalarBindingValue(binding, rawValue));
      initCustomSelect(el, "custom-select-wrapper");
      break;
    }
    case "toggle": {
      const el = binding.getElement(elements);
      el.checked = normalizeScalarBindingValue(binding, rawValue);
      syncToggleSwitch(el);
      break;
    }
    case "slider": {
      setResettableRangeValue(binding.getElement(elements), rawValue);
      break;
    }
    case "debounced-text": {
      binding.getElement(elements).value = String(rawValue || "");
      break;
    }
  }
  syncScalarSideEffects(binding.key, elements);
}

function renderInitialQuickPromptInputs(elements: SettingsElements, value: unknown): void {
  const prompts = Array.isArray(value) ? value : [];
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

export function hydrateScalarSettings(elements: SettingsElements, settings: Settings): void {
  for (const binding of SCALAR_FIELD_BINDINGS) {
    const rawValue =
      binding.kind === "select" && binding.readFromSettings
        ? binding.readFromSettings(settings)
        : settings[binding.key];
    hydrateScalarField(binding, elements, rawValue);
  }
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);
}

export function applyScalarStorageChanges(
  elements: SettingsElements,
  changes: Record<string, chrome.storage.StorageChange>
): void {
  for (const binding of WATCHED_SCALAR_BINDINGS) {
    const change = changes[binding.key];
    if (change) {
      hydrateScalarField(binding, elements, change.newValue);
    }
  }
}

export function applyChatDisplayPatch(
  elements: SettingsElements,
  patch: ChatDisplaySettingsPatch
): void {
  for (const key of CHAT_DISPLAY_SETTING_KEYS) {
    if (key in patch) {
      setResettableRangeValue(elements[key], patch[key]);
    }
  }
}

async function resetPreferences(
  elements: SettingsElements,
  deps: { reloadSettings: () => Promise<void> }
): Promise<void> {
  if (!(await confirmDialog({
    message: "确定要把偏好设置恢复默认值吗？AI 平台、密钥与语音转写配置不受影响。",
    confirmText: "恢复默认",
    danger: true
  }))) {
    return;
  }
  setBusy(elements, true);
  try {
    const payload = buildDefaultPreferencePatch();
    const resp = await sendRuntimeMessage({ type: "save-settings", settings: payload });
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "重置失败", true);
      return;
    }
    await resetDetachedWindowBounds();
    state.patchSettings(payload);
    applyReadingViewTypography();
    applyChatDisplaySettings({
      chatLineHeight: payload.chatLineHeight,
      chatParagraphSpacing: payload.chatParagraphSpacing,
      speechVoiceVolume: payload.speechVoiceVolume
    });
    applyLiveAudioSettings({
      liveVoiceVolume: payload.liveVoiceVolume,
      liveVoiceSpeed: payload.liveVoiceSpeed,
      liveShareVideoAudio: payload.liveShareVideoAudio,
      liveVoicePriority: payload.liveVoicePriority
    });
    await deps.reloadSettings();
    setStatus(elements, "已恢复默认设置");
  } catch (error) {
    setStatus(elements, getErrorMessage(error, "重置失败"), true);
  } finally {
    setBusy(elements, false);
  }
}

export async function saveSettingField(
  elements: SettingsElements,
  patch: Record<string, unknown>,
  persist?: ScalarFieldPersist
): Promise<boolean> {
  const statusVerAtStart = getStatusVersion();
  try {
    const resp = persist
      ? await persist(patch)
      : await sendRuntimeMessage({ type: "save-settings", settings: patch });
    if (!resp?.ok) {
      setStatus(elements, resp?.error || "保存失败", true);
      return false;
    }
    if (getStatusVersion() === statusVerAtStart) {
      setStatus(elements, "已保存");
      scheduleStatusAutoClear(elements, "已保存", 1500);
    }
    return true;
  } catch (error) {
    setStatus(elements, getErrorMessage(error, "保存失败"), true);
    return false;
  }
}

function bindScalarFieldEvents(
  binding: ScalarFieldBinding,
  elements: SettingsElements,
  deps: Pick<ScalarSettingsBindDeps, "syncSummaries" | "hooks">
): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      el.addEventListener("change", () => {
        const val = normalizeScalarBindingValue(binding, el.value);
        const patch = { [binding.key]: val, ...(binding.commitExtras?.() ?? {}) };
        if (binding.patchState !== false) {
          state.patchSettings(patch);
        }
        binding.onApply?.(val as never);
        try {
          binding.onChange?.(val as never, deps.hooks ?? {}, elements);
        } catch {
        }
        syncScalarSideEffects(binding.key, elements);
        deps.syncSummaries();
        void saveSettingField(elements, patch).then((ok) => {
          if (ok) binding.onSaved?.(val as never, deps.hooks ?? {}, elements);
        });
      });
      break;
    }
    case "toggle": {
      const el = binding.getElement(elements);
      initToggleSwitch(el);
      el.addEventListener("change", () => {
        const val = el.checked;
        try {
          binding.onChange?.(val, deps.hooks ?? {}, elements);
        } catch {
        }
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        binding.onApply?.(val);
        syncScalarSideEffects(binding.key, elements);
        deps.syncSummaries();
        void saveSettingField(elements, { [binding.key]: val }, binding.persist).then((ok) => {
          if (ok) binding.onSaved?.(val, deps.hooks ?? {}, elements);
        });
      });
      break;
    }
    case "slider": {
      bindResettableRangeSlider({
        input: binding.getElement(elements),
        badge: binding.getBadge(elements),
        resetBtn: binding.getResetBtn(elements),
        defaultValue: binding.defaultValue,
        normalize: (value) => normalizeScalarBindingValue(binding, value),
        format: binding.format,
        onPreview: (val) => {
          if (binding.patchState !== false) {
            state.patchSettings({ [binding.key]: val, ...(binding.commitExtras?.() ?? {}) });
          }
          binding.onPreview?.(val);
          deps.syncSummaries();
        },
        onCommit: (val) => {
          deps.syncSummaries();
          void saveSettingField(
            elements,
            { [binding.key]: val, ...(binding.commitExtras?.() ?? {}) },
            binding.persist
          );
        },
        onReset: binding.resetExtras
          ? (val) => {
              const patch = { [binding.key]: val, ...binding.resetExtras!() };
              if (binding.patchState !== false) {
                state.patchSettings(patch);
              }
              deps.syncSummaries();
              void saveSettingField(elements, patch, binding.persist);
            }
          : undefined
      });
      break;
    }
    case "debounced-text": {
      const el = binding.getElement(elements);
      const save = (normalizedVal?: string) => {
        const val = normalizedVal ?? normalizeScalarBindingValue(binding, el.value);
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        void saveSettingField(elements, { [binding.key]: val }).then((ok) => {
          if (ok) binding.onSaved?.(val, deps.hooks ?? {}, elements);
        });
      };
      const debouncedSave = debounce(() => save(), 400);
      pendingDebounceCancels.add(debouncedSave.cancel);
      el.addEventListener("input", () => {
        debouncedSave();
        deps.syncSummaries();
      });
      el.addEventListener("change", () => {
        debouncedSave.cancel();
        const val = normalizeScalarBindingValue(binding, el.value);
        try {
          binding.onChange?.(val, deps.hooks ?? {}, elements);
        } catch {
        }
        save(val);
      });
      el.addEventListener("blur", () => debouncedSave.flush());
      break;
    }
  }
}

function bindScalarSectionActions(
  elements: SettingsElements,
  deps: Pick<ScalarSettingsBindDeps, "syncSummaries" | "reloadSettings">
): void {
  const saveInitialQuickPrompts = () => {
    const prompts = collectInitialQuickPrompts(elements);
    state.patchSettings({ aiInitialQuickPrompts: prompts });
    void saveSettingField(elements, { aiInitialQuickPrompts: prompts });
  };
  const debouncedSaveInitialQuickPrompts = debounce(saveInitialQuickPrompts, 400);
  pendingDebounceCancels.add(debouncedSaveInitialQuickPrompts.cancel);
  elements.aiInitialQuickPrompts.forEach((input) => {
    input.addEventListener("input", () => {
      debouncedSaveInitialQuickPrompts();
      deps.syncSummaries();
    });
    input.addEventListener("blur", () => debouncedSaveInitialQuickPrompts.flush());
  });

  elements.resetBtn.addEventListener("click", () => {
    void resetPreferences(elements, { reloadSettings: deps.reloadSettings });
  });
  elements.aiSystemPromptResetBtn.addEventListener("click", () => {
    elements.aiSystemPrompt.value = DEFAULT_AI_SYSTEM_PROMPT;
    state.patchSettings({ aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT });
    void saveSettingField(elements, { aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT });
  });
  elements.noteExportResetTemplateBtn.addEventListener("click", () => {
    elements.noteExportTemplate.value = DEFAULT_NOTE_TEMPLATE;
    state.patchSettings({ noteExportTemplate: DEFAULT_NOTE_TEMPLATE });
    void saveSettingField(elements, { noteExportTemplate: DEFAULT_NOTE_TEMPLATE });
  });
  elements.openOnboardingBtn.addEventListener("click", () => {
    void sendRuntimeMessage({ type: "open-onboarding" }).then((resp) => {
      if (resp && !resp.ok) {
        setStatus(elements, resp.error || "打开引导页失败", true);
      }
    }).catch(() => {
      setStatus(elements, "打开引导页失败", true);
    });
  });
}

export function bindScalarSettings(
  elements: SettingsElements,
  deps: ScalarSettingsBindDeps
): void {
  for (const binding of SCALAR_FIELD_BINDINGS) {
    bindScalarFieldEvents(binding, elements, deps);
  }
  bindScalarSectionActions(elements, deps);
}
