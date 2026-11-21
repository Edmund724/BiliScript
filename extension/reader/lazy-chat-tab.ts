import { createLazyLoader } from "../shared/lazy-import.js";
import type { LiveChatController } from "../live/live-chat-controller.js";
import type { FullscreenLiveOverlay } from "../live/fullscreen-live-overlay.js";

export interface ReaderChatTabDomain {
  ensureChatTabActivated(opts?: { consumeIntent?: boolean }): Promise<void>;
  stopChatSpeech(): void;
  closeChatSession(): void;
  runQuickActionPrompt(prompt: string): Promise<boolean>;
  stopLiveCompanion(): void;
  startLiveCompanion(): Promise<boolean>;
  getLiveController(): LiveChatController | null;
  ensureFullscreenOverlay(): FullscreenLiveOverlay;
  getFullscreenLiveOverlay(): FullscreenLiveOverlay | null;
}

const loader = createLazyLoader<ReaderChatTabDomain>(() => import("./chat-tab.js"));

export function ensureReaderChatTab(): Promise<ReaderChatTabDomain> {
  return loader.load();
}

export function isReaderChatTabLoaded(): boolean {
  return loader.isLoaded();
}
