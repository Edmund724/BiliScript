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
>;

type LiveAudioSettingsInput = { [K in keyof LiveAudioSettingsPatch]?: unknown };
type LiveAudioSettingsListener = (patch: LiveAudioSettingsPatch) => void;

const localListeners = new Set<LiveAudioSettingsListener>();

function syncLiveAudioSettings(
  patch: LiveAudioSettingsInput,
  getController: () => LiveAudioController | null,
  onSync?: () => void
): void {
  const controller = getController();
  let changed = false;
  if ("liveVoiceVolume" in patch) {
    const volume = normalizeLiveVoiceVolume(patch.liveVoiceVolume);
    state.patchSettings({ liveVoiceVolume: volume });
    if (controller && controller.getVolume() !== volume / 100) controller.setVolume(volume / 100);
    changed = true;
  }
  if ("liveVoiceSpeed" in patch) {
    const speed = normalizeLiveVoiceSpeed(patch.liveVoiceSpeed);
    state.patchSettings({ liveVoiceSpeed: speed });
    if (controller && controller.getSpeed() !== speed) controller.setSpeed(speed);
    changed = true;
  }
  if ("liveVoicePriority" in patch) {
    const enabled = normalizeLiveVoicePriority(patch.liveVoicePriority);
    state.patchSettings({ liveVoicePriority: enabled });
    if (controller && controller.isVoicePriority() !== enabled) controller.setVoicePriority(enabled);
    changed = true;
  }
  if ("liveShareVideoAudio" in patch) {
    const enabled = normalizeLiveShareVideoAudio(patch.liveShareVideoAudio);
    state.patchSettings({ liveShareVideoAudio: enabled });
    if (controller && controller.isSharingVideoAudio() !== enabled) controller.setShareVideoAudio(enabled);
    changed = true;
  }
  if (changed) onSync?.();
}

export function applyLiveAudioSettings(patch: LiveAudioSettingsPatch): void {
  state.patchSettings(patch as Partial<Settings>);
  for (const listener of [...localListeners]) listener(patch);
}

export function persistLiveAudioSettings(patch: LiveAudioSettingsPatch) {
  applyLiveAudioSettings(patch);
  return sendRuntimeMessage({
    type: "save-settings",
    settings: patch
  }).catch((error) => ({ ok: false as const, error: (error as Error).message || "保存失败" }));
}

export function watchLiveAudioSettings(
  getController: () => LiveAudioController | null,
  onSync?: () => void
): () => void {
  const localListener: LiveAudioSettingsListener = (patch) => {
    syncLiveAudioSettings(patch, getController, onSync);
  };
  localListeners.add(localListener);
  const unsubscribeStorage = watchStorageKeys((changes) => {
    const patch: LiveAudioSettingsInput = {};
    if (changes.liveVoiceVolume) patch.liveVoiceVolume = changes.liveVoiceVolume.newValue;
    if (changes.liveVoiceSpeed) patch.liveVoiceSpeed = changes.liveVoiceSpeed.newValue;
    if (changes.liveVoicePriority) patch.liveVoicePriority = changes.liveVoicePriority.newValue;
    if (changes.liveShareVideoAudio) patch.liveShareVideoAudio = changes.liveShareVideoAudio.newValue;
    syncLiveAudioSettings(patch, getController, onSync);
  }, {
    sync: ["liveVoiceVolume", "liveVoiceSpeed", "liveVoicePriority", "liveShareVideoAudio"]
  });
  return () => {
    localListeners.delete(localListener);
    unsubscribeStorage();
  };
}
