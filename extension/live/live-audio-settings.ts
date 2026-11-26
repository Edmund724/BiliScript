import { state } from "../core/state.js";
import type { Settings } from "../core/defaults.js";
import {
  normalizeLiveVoicePriority,
  normalizeLiveVoiceSpeed,
  normalizeLiveVoiceVolume,
  normalizeLiveShareVideoAudio
} from "../core/validators.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import type { LiveChatController } from "./live-chat-controller.js";

export interface LiveAudioSettingsPatch {
  liveVoiceVolume?: number;
  liveVoiceSpeed?: number;
  liveVoicePriority?: boolean;
  liveShareVideoAudio?: boolean;
}

export type LiveAudioChangeSource = "overlay" | "settings" | "server" | "storage";

export interface DispatchLiveAudioChangeOptions {
  source: Exclude<LiveAudioChangeSource, "storage">;
  persist?: boolean;
}

type LiveAudioController = Pick<
  LiveChatController,
  | "setVolume"
  | "getVolume"
  | "setSpeed"
  | "getSpeed"
  | "setVoicePriority"
  | "isVoicePriority"
  | "setShareVideoAudio"
  | "isSharingVideoAudio"
> & Partial<Pick<LiveChatController, "applyAudioSettings">>;

type LiveAudioSettingsInput = { [K in keyof LiveAudioSettingsPatch]?: unknown };
type LiveAudioSettingsListener = (
  patch: LiveAudioSettingsPatch,
  source: Exclude<LiveAudioChangeSource, "storage">
) => void;

const localListeners = new Set<LiveAudioSettingsListener>();

function normalizeLiveAudioPatch(patch: LiveAudioSettingsInput): LiveAudioSettingsPatch {
  const normalized: LiveAudioSettingsPatch = {};
  if ("liveVoiceVolume" in patch) {
    normalized.liveVoiceVolume = normalizeLiveVoiceVolume(patch.liveVoiceVolume);
  }
  if ("liveVoiceSpeed" in patch) {
    normalized.liveVoiceSpeed = normalizeLiveVoiceSpeed(patch.liveVoiceSpeed);
  }
  if ("liveVoicePriority" in patch) {
    normalized.liveVoicePriority = normalizeLiveVoicePriority(patch.liveVoicePriority);
  }
  if ("liveShareVideoAudio" in patch) {
    normalized.liveShareVideoAudio = normalizeLiveShareVideoAudio(patch.liveShareVideoAudio);
  }
  return normalized;
}

function diffServerPersistPatch(normalized: LiveAudioSettingsPatch): LiveAudioSettingsPatch {
  const current = state.settings;
  const diff: LiveAudioSettingsPatch = {};
  if (
    normalized.liveVoiceVolume !== undefined &&
    current?.liveVoiceVolume !== normalized.liveVoiceVolume
  ) {
    diff.liveVoiceVolume = normalized.liveVoiceVolume;
  }
  if (
    normalized.liveVoiceSpeed !== undefined &&
    current?.liveVoiceSpeed !== normalized.liveVoiceSpeed
  ) {
    diff.liveVoiceSpeed = normalized.liveVoiceSpeed;
  }
  if (
    normalized.liveVoicePriority !== undefined &&
    current?.liveVoicePriority !== normalized.liveVoicePriority
  ) {
    diff.liveVoicePriority = normalized.liveVoicePriority;
  }
  if (
    normalized.liveShareVideoAudio !== undefined &&
    current?.liveShareVideoAudio !== normalized.liveShareVideoAudio
  ) {
    diff.liveShareVideoAudio = normalized.liveShareVideoAudio;
  }
  return diff;
}

function applyPatchToController(
  controller: LiveAudioController,
  patch: LiveAudioSettingsPatch
): void {
  if (typeof controller.applyAudioSettings === "function") {
    controller.applyAudioSettings(patch);
    return;
  }
  if (patch.liveVoiceVolume !== undefined) controller.setVolume(patch.liveVoiceVolume / 100);
  if (patch.liveVoiceSpeed !== undefined) controller.setSpeed(patch.liveVoiceSpeed);
  if (patch.liveVoicePriority !== undefined) controller.setVoicePriority(patch.liveVoicePriority);
  if (patch.liveShareVideoAudio !== undefined) controller.setShareVideoAudio(patch.liveShareVideoAudio);
}

function syncLiveAudioSettings(
  rawPatch: LiveAudioSettingsInput,
  source: LiveAudioChangeSource,
  getController: () => LiveAudioController | null,
  onSync?: () => void
): void {
  const normalized = normalizeLiveAudioPatch(rawPatch);
  if (Object.keys(normalized).length === 0) return;

  if (source === "storage") {
    state.patchSettings(normalized as Partial<Settings>);
  }

  const controller = getController();
  if (controller && source !== "server") {
    const controllerPatch: LiveAudioSettingsPatch = {};
    if (
      normalized.liveVoiceVolume !== undefined &&
      Math.round(controller.getVolume() * 100) !== normalized.liveVoiceVolume
    ) {
      controllerPatch.liveVoiceVolume = normalized.liveVoiceVolume;
    }
    if (
      normalized.liveVoiceSpeed !== undefined &&
      normalizeLiveVoiceSpeed(controller.getSpeed()) !== normalized.liveVoiceSpeed
    ) {
      controllerPatch.liveVoiceSpeed = normalized.liveVoiceSpeed;
    }
    if (
      normalized.liveVoicePriority !== undefined &&
      controller.isVoicePriority() !== normalized.liveVoicePriority
    ) {
      controllerPatch.liveVoicePriority = normalized.liveVoicePriority;
    }
    if (
      normalized.liveShareVideoAudio !== undefined &&
      controller.isSharingVideoAudio() !== normalized.liveShareVideoAudio
    ) {
      controllerPatch.liveShareVideoAudio = normalized.liveShareVideoAudio;
    }
    if (Object.keys(controllerPatch).length > 0) {
      applyPatchToController(controller, controllerPatch);
    }
  }
  onSync?.();
}

export function dispatchLiveAudioChange(
  patch: LiveAudioSettingsPatch,
  options: DispatchLiveAudioChangeOptions
) {
  const normalized = normalizeLiveAudioPatch(patch);
  if (Object.keys(normalized).length === 0) {
    return Promise.resolve({ ok: true as const });
  }
  const persistPatch = options.persist
    ? (options.source === "server" ? diffServerPersistPatch(normalized) : normalized)
    : {};
  state.patchSettings(normalized as Partial<Settings>);
  for (const listener of [...localListeners]) {
    listener(normalized, options.source);
  }
  if (!options.persist || Object.keys(persistPatch).length === 0) {
    return Promise.resolve({ ok: true as const });
  }
  return sendRuntimeMessage({
    type: "save-settings",
    settings: persistPatch
  }).catch((error) => ({ ok: false as const, error: (error as Error).message || "保存失败" }));
}

export function applyLiveAudioSettings(patch: LiveAudioSettingsPatch): void {
  void dispatchLiveAudioChange(patch, { source: "settings", persist: false });
}

export function persistLiveAudioSettings(patch: LiveAudioSettingsPatch) {
  return dispatchLiveAudioChange(patch, { source: "settings", persist: true });
}

export function watchLiveAudioSettings(
  getController: () => LiveAudioController | null,
  onSync?: () => void
): () => void {
  const localListener: LiveAudioSettingsListener = (patch, source) => {
    syncLiveAudioSettings(patch, source, getController, onSync);
  };
  localListeners.add(localListener);
  const unsubscribeStorage = watchStorageKeys((changes) => {
    const patch: LiveAudioSettingsInput = {};
    if (changes.liveVoiceVolume) patch.liveVoiceVolume = changes.liveVoiceVolume.newValue;
    if (changes.liveVoiceSpeed) patch.liveVoiceSpeed = changes.liveVoiceSpeed.newValue;
    if (changes.liveVoicePriority) patch.liveVoicePriority = changes.liveVoicePriority.newValue;
    if (changes.liveShareVideoAudio) patch.liveShareVideoAudio = changes.liveShareVideoAudio.newValue;
    syncLiveAudioSettings(patch, "storage", getController, onSync);
  }, {
    sync: ["liveVoiceVolume", "liveVoiceSpeed", "liveVoicePriority", "liveShareVideoAudio"]
  });
  return () => {
    localListeners.delete(localListener);
    unsubscribeStorage();
  };
}
