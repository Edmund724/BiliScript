import type { FullscreenLiveOverlay, LiveSettingsTarget } from "./fullscreen-live-overlay.js";
import type { LiveChatController } from "./live-chat-controller.js";
import type { LiveOverlayBinding, LiveOverlayConsumerHooks } from "./live-overlay-binding.js";

export type LiveSessionConsumerHooks = LiveOverlayConsumerHooks;

export function setLiveSessionHooks(_hooks: LiveSessionConsumerHooks | null): void {}

export async function openLiveCompanionSettings(_target: LiveSettingsTarget): Promise<void> {}

export function ensureLiveController(): LiveChatController {
  throw new Error("Live companion is unsupported on Firefox.");
}

export function getLiveController(): LiveChatController | null {
  return null;
}

export function getLiveOverlayBinding(): LiveOverlayBinding {
  throw new Error("Live companion is unsupported on Firefox.");
}

export function getFullscreenLiveOverlay(): FullscreenLiveOverlay | null {
  return null;
}

export function ensureFullscreenOverlay(): FullscreenLiveOverlay {
  throw new Error("Live companion is unsupported on Firefox.");
}

export function isLiveCompanionActive(): boolean {
  return false;
}

export async function startLiveCompanion(): Promise<boolean> {
  return false;
}

export async function retryLiveCompanion(): Promise<boolean> {
  return false;
}

export function restoreLiveCompanionOverlay(): void {}

export function stopLiveCompanion(_reason?: "takeover"): void {}

export function disposeLiveCompanionSession(): void {}
