import { AI_PROVIDERS_STORAGE } from "../../core/ai-provider-store.js";
import { DEFAULT_AI_SYSTEM_PROMPT, DEFAULT_PLAYER_AI_QUICK_PROMPT } from "../../core/default-prompts.js";
import { DEFAULT_SETTINGS, type Settings } from "../../core/defaults.js";
import { resetDetachedWindowBounds } from "../../core/detached-bounds-store.js";
import { getSettings } from "../../core/runtime.js";
import { state } from "../../core/state.js";
import {
  normalizeNoteExportTemplate,
  normalizeObsidianFolder,
  normalizeObsidianVaultName
} from "../../core/validators.js";
import { applyLiveAudioSettings } from "../../live/live-audio-settings.js";
import {
  LIVE_VOICE_FALLBACK_NOTICE_TEXT,
  takeLiveVoiceFallbackNotice
} from "../../live/live-voice-fallback-notice.js";
import { copyCurrentVideoNote, openCurrentVideoInObsidian } from "../../notes/export-actions.js";
import { DEFAULT_NOTE_TEMPLATE } from "../../notes/template-defaults.js";
import {
  CHAT_DISPLAY_SETTING_KEYS,
  applyChatDisplaySettings,
  watchChatDisplaySettings
} from "../../reader/chat-display-settings.js";
import { applyReadingViewTypography } from "../../reader/presentation.js";
import { getErrorMessage } from "../../shared/error-helpers.js";
import { sendRuntimeMessage } from "../../shared/messaging.js";
import { supportsLiveCompanion } from "../../shared/runtime-capabilities.js";
import { detectActiveSite, getSiteCapabilities } from "../../shared/site.js";
import { watchStorageKeys } from "../../shared/watch-storage-keys.js";
import { confirmDialog } from "../confirm-dialog.js";
import { initCustomSelect, setCustomSelectValue } from "../custom-select.js";
import { bindResettableRangeSlider, setResettableRangeValue } from "../range-slider.js";
import { initToggleSwitch, syncToggleSwitch } from "../toggle-switch.js";
import { collectElements, debounce, getStatusVersion, setBusy, setStatus, type SettingsElements } from "./elements.js";
import {
  SCALAR_FIELD_BINDINGS,
  syncScalarSideEffects,
  type ScalarBindingRuntimeHooks,
  type ScalarFieldBinding,
  type ScalarFieldPersist
} from "./scalar-bindings.js";
import { collectInitialQuickPrompts } from "./summaries.js";

export interface ScalarLoadDeps {
  syncAgentBridge?: (settings: Settings) => void;
  loadProviders?: (settings: Settings) => Promise<void>;
  syncSummaries: (elements: SettingsElements) => void;
}

export interface ScalarFieldEventDeps {
  syncSummaries: (elements: SettingsElements) => void;
  hooks?: ScalarBindingRuntimeHooks;
}

export interface ScalarActionDeps {
  syncSummaries: (elements: SettingsElements) => void;
  reloadSettings: (elements: SettingsElements) => Promise<void>;
}

export interface ScalarExternalSyncDeps {
  syncSummaries: (elements: SettingsElements) => void;
  onAgentBridgeUrlChanged?: (newValue: unknown) => void;
  onEnableAgentBridgeChanged?: () => void;
  onAiModelsExternalChanged?: (elements: SettingsElements) => void;
}

let statusClearTimer: ReturnType<typeof setTimeout> | null = null;
let unwatchChatDisplay: (() => void) | null = null;
let unwatchStorageSync: (() => void) | null = null;
const pendingDebounceCancels = new Set<() => void>();

export function clearStatusClearTimer(): void {
  if (statusClearTimer) {
    clearTimeout(statusClearTimer);
    statusClearTimer = null;
  }
}

export function disposeScalarBindings(): void {
  clearStatusClearTimer();
  for (const cancel of pendingDebounceCancels) {
    cancel();
  }
  pendingDebounceCancels.clear();
  unwatchChatDisplay?.();
  unwatchChatDisplay = null;
  unwatchStorageSync?.();
  unwatchStorageSync = null;
}

export function hydrateScalarField(
  binding: ScalarFieldBinding,
  elements: SettingsElements,
  rawValue: unknown
): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      setCustomSelectValue(el, binding.normalize(rawValue));
      initCustomSelect(el, "custom-select-wrapper");
      break;
    }
    case "toggle": {
      const el = binding.getElement(elements);
      el.checked = binding.normalize(rawValue);
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

export async function syncLiveVoiceFallbackHint(elements: SettingsElements): Promise<void> {
  const site =
    state.clip.site === "youtube" || detectActiveSite() === "youtube"
      ? "youtube"
      : state.clip.site;
  if (!supportsLiveCompanion() || !getSiteCapabilities(site).supportsLiveCompanion) {
    return;
  }
  const notice = await takeLiveVoiceFallbackNotice();
  const hint = elements.liveVoiceFallbackHint;
  hint.textContent = notice ? LIVE_VOICE_FALLBACK_NOTICE_TEXT : "";
  hint.hidden = !notice;
}

export function renderInitialQuickPromptInputs(elements: SettingsElements, value: unknown): void {
  const prompts = Array.isArray(value) ? value : [];
  elements.aiInitialQuickPrompts.forEach((input, index) => {
    input.value = String(prompts[index] || "");
  });
}

export async function loadSettings(elements: SettingsElements, deps: ScalarLoadDeps): Promise<void> {
  const settings = await getSettings();

  for (const binding of SCALAR_FIELD_BINDINGS) {
    const rawValue =
      binding.kind === "select" && binding.readFromSettings
        ? binding.readFromSettings(settings)
        : settings[binding.key];
    hydrateScalarField(binding, elements, rawValue);
  }
  deps.syncAgentBridge?.(settings);
  renderInitialQuickPromptInputs(elements, settings.aiInitialQuickPrompts);
  deps.syncSummaries(elements);

  await deps.loadProviders?.(settings);
  await syncLiveVoiceFallbackHint(elements);
  deps.syncSummaries(elements);
}

export function buildDefaultPreferencePayload() {
  return {
    downloadFormat: DEFAULT_SETTINGS.downloadFormat,
    subtitleSegmentationStrategy: DEFAULT_SETTINGS.subtitleSegmentationStrategy,
    subtitleTranslateGlossary: DEFAULT_SETTINGS.subtitleTranslateGlossary,
    includeDateInFilename: DEFAULT_SETTINGS.includeDateInFilename,
    enablePlayerAiQuickAction: DEFAULT_SETTINGS.enablePlayerAiQuickAction,
    playerAiQuickPrompt: DEFAULT_PLAYER_AI_QUICK_PROMPT,
    includeTimestampInBody: DEFAULT_SETTINGS.includeTimestampInBody,
    enableDebugLogs: DEFAULT_SETTINGS.enableDebugLogs,
    enableAgentBridge: DEFAULT_SETTINGS.enableAgentBridge,
    readerTheme: DEFAULT_SETTINGS.readerTheme,
    readerPalette: DEFAULT_SETTINGS.readerPalette,
    readerFontSizeScale: DEFAULT_SETTINGS.readerFontSizeScale,
    chatLineHeight: DEFAULT_SETTINGS.chatLineHeight,
    chatParagraphSpacing: DEFAULT_SETTINGS.chatParagraphSpacing,
    speechVoiceVolume: DEFAULT_SETTINGS.speechVoiceVolume,
    liveVoiceVolume: DEFAULT_SETTINGS.liveVoiceVolume,
    liveVoiceSpeed: DEFAULT_SETTINGS.liveVoiceSpeed,
    liveShareVideoAudio: DEFAULT_SETTINGS.liveShareVideoAudio,
    liveVoicePriority: DEFAULT_SETTINGS.liveVoicePriority,
    aiSystemPrompt: DEFAULT_AI_SYSTEM_PROMPT,
    aiInitialQuickPrompts: [],
    bilingualSubtitles: DEFAULT_SETTINGS.bilingualSubtitles,
    secondarySubtitleLang: DEFAULT_SETTINGS.secondarySubtitleLang,
    bilingualDisplayOrder: DEFAULT_SETTINGS.bilingualDisplayOrder,
    customPanelWidthEnabled: DEFAULT_SETTINGS.customPanelWidthEnabled,
    customPanelWidth: DEFAULT_SETTINGS.customPanelWidth,
    detachedWindowMode: DEFAULT_SETTINGS.detachedWindowMode,
    autoOpenReader: DEFAULT_SETTINGS.autoOpenReader,
    enableCostGuard: DEFAULT_SETTINGS.enableCostGuard,
    enableExtraPlaybackRates: DEFAULT_SETTINGS.enableExtraPlaybackRates,
    chatInputGlow: DEFAULT_SETTINGS.chatInputGlow,
    reduceTransparency: DEFAULT_SETTINGS.reduceTransparency,
    noteExportTemplate: DEFAULT_NOTE_TEMPLATE,
    obsidianVaultName: DEFAULT_SETTINGS.obsidianVaultName,
    obsidianFolder: DEFAULT_SETTINGS.obsidianFolder
  };
}

export async function resetPreferences(
  elements: SettingsElements,
  deps: { reloadSettings: (elements: SettingsElements) => Promise<void> }
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
    const payload = buildDefaultPreferencePayload();
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
    await deps.reloadSettings(elements);
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
      clearStatusClearTimer();
      statusClearTimer = setTimeout(() => {
        statusClearTimer = null;
        if (elements.status.dataset.error !== "true" && elements.status.textContent === "已保存") {
          setStatus(elements, "");
        }
      }, 1500);
    }
    return true;
  } catch (error) {
    setStatus(elements, getErrorMessage(error, "保存失败"), true);
    return false;
  }
}

export function bindScalarFieldEvents(
  binding: ScalarFieldBinding,
  elements: SettingsElements,
  deps: ScalarFieldEventDeps
): void {
  switch (binding.kind) {
    case "select": {
      const el = binding.getElement(elements);
      el.addEventListener("change", () => {
        const val = binding.normalize(el.value);
        const patch = { [binding.key]: val, ...(binding.commitExtras?.() ?? {}) };
        if (binding.patchState !== false) {
          state.patchSettings(patch);
        }
        binding.onApply?.(val);
        try {
          binding.onChange?.(val, deps.hooks ?? {}, elements);
        } catch {
        }
        syncScalarSideEffects(binding.key, elements);
        deps.syncSummaries(elements);
        void saveSettingField(elements, patch);
      });
      break;
    }
    case "toggle": {
      const el = binding.getElement(elements);
      initToggleSwitch(el);
      el.addEventListener("change", () => {
        const val = el.checked;
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        binding.onApply?.(val);
        syncScalarSideEffects(binding.key, elements);
        deps.syncSummaries(elements);
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
        normalize: binding.normalize,
        format: binding.format,
        onPreview: (val) => {
          if (binding.patchState !== false) {
            state.patchSettings({ [binding.key]: val, ...(binding.commitExtras?.() ?? {}) });
          }
          binding.onPreview?.(val);
          deps.syncSummaries(elements);
        },
        onCommit: (val) => {
          deps.syncSummaries(elements);
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
              deps.syncSummaries(elements);
              void saveSettingField(elements, patch, binding.persist);
            }
          : undefined
      });
      break;
    }
    case "debounced-text": {
      const el = binding.getElement(elements);
      const save = () => {
        const val = binding.normalize(el.value);
        if (binding.patchState !== false) {
          state.patchSettings({ [binding.key]: val });
        }
        void saveSettingField(elements, { [binding.key]: val });
      };
      const debouncedSave = debounce(save, 400);
      pendingDebounceCancels.add(debouncedSave.cancel);
      el.addEventListener("input", () => {
        debouncedSave();
        deps.syncSummaries(elements);
      });
      el.addEventListener("blur", () => debouncedSave.flush());
      break;
    }
  }
}

export function bindScalarSectionActions(
  elements: SettingsElements,
  deps: ScalarActionDeps
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
      deps.syncSummaries(elements);
    });
    input.addEventListener("blur", () => debouncedSaveInitialQuickPrompts.flush());
  });

  elements.resetBtn.addEventListener("click", () => {
    void resetPreferences(elements, { reloadSettings: deps.reloadSettings });
  });
  elements.noteExportResetTemplateBtn.addEventListener("click", () => {
    elements.noteExportTemplate.value = DEFAULT_NOTE_TEMPLATE;
    state.patchSettings({ noteExportTemplate: DEFAULT_NOTE_TEMPLATE });
    void saveSettingField(elements, { noteExportTemplate: DEFAULT_NOTE_TEMPLATE });
  });
  elements.noteExportCopyBtn.addEventListener("click", () => {
    void (async () => {
      const normalizedTemplate = normalizeNoteExportTemplate(elements.noteExportTemplate.value);
      state.patchSettings({ noteExportTemplate: normalizedTemplate });
      const ok = await copyCurrentVideoNote();
      setStatus(elements, ok ? "已复制当前视频笔记" : "复制失败：请检查剪贴板权限或内容", !ok);
    })();
  });
  elements.noteExportObsidianBtn.addEventListener("click", () => {
    void (async () => {
      const normalizedTemplate = normalizeNoteExportTemplate(elements.noteExportTemplate.value);
      const vault = normalizeObsidianVaultName(elements.obsidianVaultName.value);
      const folder = normalizeObsidianFolder(elements.obsidianFolder.value);
      state.patchSettings({
        noteExportTemplate: normalizedTemplate,
        obsidianVaultName: vault,
        obsidianFolder: folder
      });
      const result = await openCurrentVideoInObsidian();
      if (!result.ok) {
        setStatus(elements, result.error || "写入 Obsidian 失败", true);
        return;
      }
      setStatus(
        elements,
        result.usedClipboardFallback
          ? "笔记较长，已复制并唤起 Obsidian 粘贴写入"
          : "已唤起 Obsidian 写入笔记"
      );
    })();
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

export function bindScalarExternalSync(
  host: HTMLElement,
  elements: SettingsElements,
  deps: ScalarExternalSyncDeps
): void {
  unwatchChatDisplay?.();
  unwatchChatDisplay = watchChatDisplaySettings((patch) => {
    if (!host.isConnected) return;
    const currentElements = collectElements(host);
    for (const key of CHAT_DISPLAY_SETTING_KEYS) {
      if (key in patch) {
        setResettableRangeValue(currentElements[key], patch[key]);
      }
    }
    deps.syncSummaries(currentElements);
  });

  const watchedSyncBindings = SCALAR_FIELD_BINDINGS.filter((binding) => binding.watchSync);
  unwatchStorageSync?.();
  unwatchStorageSync = watchStorageKeys(
    (changes) => {
      for (const binding of watchedSyncBindings) {
        const change = changes[binding.key];
        if (change) hydrateScalarField(binding, elements, change.newValue);
      }
      if (changes.agentBridgeUrl) deps.onAgentBridgeUrlChanged?.(changes.agentBridgeUrl.newValue);
      if (changes.enableAgentBridge) deps.onEnableAgentBridgeChanged?.();
      if (
        changes.defaultModel ||
        changes.defaultAiModel ||
        changes.subtitleTranslateProviderId ||
        changes.subtitleTranslateModel ||
        changes[AI_PROVIDERS_STORAGE]
      ) {
        deps.onAiModelsExternalChanged?.(collectElements(host));
      }
      deps.syncSummaries(collectElements(host));
    },
    {
      sync: [
        ...watchedSyncBindings.map((binding) => binding.key),
        "agentBridgeUrl",
        "defaultModel",
        "defaultAiModel",
        "subtitleTranslateProviderId",
        "subtitleTranslateModel",
        AI_PROVIDERS_STORAGE
      ]
    }
  );
}
