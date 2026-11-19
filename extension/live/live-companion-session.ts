// extension/live/live-companion-session.ts
// 视频页实时伴看会话组合根：将控制器、浮窗绑定、音频同步与设置监听委托给 liveOverlayBinding，
// 仅注入视频页工具桥与概览上下文；提示与消费槽经零重依赖叶 player-notice 共享，
// 不静态依赖 player-interpret。

import { exitPlayerFullscreenIfNeeded } from "../bilibili/fullscreen.js";
import { ensureReaderShell } from "../reader/lazy-shell.js";
import {
  cancelReaderOverviewSource,
  ensureReaderOverviewSource,
  getReaderOverviewSource,
  subscribeReaderOverviewSource
} from "../reader/live-overview-source.js";
import {
  setLiveCompanionStopHandler,
  subscribeReaderPresenter
} from "../reader/reader-bus.js";
import type { FullscreenLiveOverlay, LiveSettingsTarget } from "./fullscreen-live-overlay.js";
import type { LiveChatController } from "./live-chat-controller.js";
import {
  createLiveOverlayBinding,
  type LiveOverlayBinding,
  type LiveOverlayConsumerHooks
} from "./live-overlay-binding.js";
import { persistLiveTextToolRecord } from "./live-text-tool-records.js";
import { createLiveToolsBridge } from "./live-tools-bridge.js";
import {
  disposePlayerToast,
  findVideoPlayerHost,
  setPlayerNoticeConsumer,
  showPlayerToast
} from "./player-notice.js";

export type LiveSessionConsumerHooks = LiveOverlayConsumerHooks;

let sessionHooks: LiveSessionConsumerHooks | null = null;
let pageHideBound = false;

function createVideoLiveControllerDeps() {
  const notifyConsumer = (message: string, autoHideMs?: number) => {
    sessionHooks?.showNotice?.(message, autoHideMs);
  };
  const liveToolsBridge = createLiveToolsBridge({
    showNotice: notifyConsumer,
    getVideoBaseVolume: () => liveOverlayBinding.getController()?.getVideoBaseVolume() ?? null,
    setVideoBaseVolume: (volume) => liveOverlayBinding.getController()?.setVideoBaseVolume(volume) ?? null,
    isSharingVideoAudio: () => liveOverlayBinding.getController()?.isSharingVideoAudio() ?? false,
    getOverview: () => getReaderOverviewSource(),
    ensureOverview: (options) => ensureReaderOverviewSource(options)
  });
  return {
    showNotice: notifyConsumer,
    getVideoContext: liveToolsBridge.getVideoContext,
    executeTool: liveToolsBridge.executeTool,
    persistTextToolRecord: (record: Parameters<typeof persistLiveTextToolRecord>[0]) =>
      persistLiveTextToolRecord(record),
    subscribeVideoContextChanges: (listener: () => void) => {
      const unsubscribePresenter = subscribeReaderPresenter((event) => {
        if (
          event.kind === "reset" ||
          event.kind === "rerender" ||
          event.kind === "subtitle-ready"
        ) {
          listener();
        }
      });
      const unsubscribeOverview = subscribeReaderOverviewSource(listener);
      return () => {
        unsubscribePresenter();
        unsubscribeOverview();
      };
    }
  };
}

const liveOverlayBinding = createLiveOverlayBinding({
  getPlayerHost: findVideoPlayerHost,
  onOpenLiveSettings: (target) => {
    void openLiveCompanionSettings(target);
  },
  onStopTakeover: () => {
    showPlayerToast("伴看已切换到另一个标签页");
  },
  createControllerDeps: createVideoLiveControllerDeps
});

function onWindowPageHide(): void {
  disposeLiveCompanionSession();
}

function bindSessionPageLifecycle(): void {
  setLiveCompanionStopHandler((reason) => {
    stopLiveCompanion(reason);
  });
  if (!pageHideBound && typeof window !== "undefined") {
    window.addEventListener("pagehide", onWindowPageHide);
    pageHideBound = true;
  }
}

export function setLiveSessionHooks(hooks: LiveSessionConsumerHooks | null): void {
  sessionHooks = hooks;
  liveOverlayBinding.setConsumerHooks(hooks);
  setPlayerNoticeConsumer(hooks?.showNotice ?? null);
  bindSessionPageLifecycle();
}

export async function openLiveCompanionSettings(target: LiveSettingsTarget): Promise<void> {
  await exitPlayerFullscreenIfNeeded();
  const shell = await ensureReaderShell();
  await shell.enterReaderShell({ readerUrl: "", intent: "open", settingsTarget: target });
}

export function ensureLiveController(): LiveChatController {
  bindSessionPageLifecycle();
  return liveOverlayBinding.ensureController();
}

export function getLiveController(): LiveChatController | null {
  return liveOverlayBinding.getController();
}

export function getLiveOverlayBinding(): LiveOverlayBinding {
  return liveOverlayBinding;
}

export function getFullscreenLiveOverlay(): FullscreenLiveOverlay | null {
  return liveOverlayBinding.getOverlay();
}

export function ensureFullscreenOverlay(): FullscreenLiveOverlay {
  bindSessionPageLifecycle();
  liveOverlayBinding.ensureController();
  return liveOverlayBinding.ensureOverlay();
}

export function isLiveCompanionActive(): boolean {
  return liveOverlayBinding.isActive();
}

export async function startLiveCompanion(): Promise<boolean> {
  bindSessionPageLifecycle();
  return liveOverlayBinding.start();
}

export async function retryLiveCompanion(): Promise<boolean> {
  bindSessionPageLifecycle();
  return liveOverlayBinding.retry();
}

export function restoreLiveCompanionOverlay(): void {
  liveOverlayBinding.restoreOverlay();
}

export function stopLiveCompanion(reason?: "takeover"): void {
  void liveOverlayBinding.stop(reason);
}

export function disposeLiveCompanionSession(): void {
  if (pageHideBound && typeof window !== "undefined") {
    window.removeEventListener("pagehide", onWindowPageHide);
    pageHideBound = false;
  }
  setLiveCompanionStopHandler(null);
  sessionHooks = null;
  setPlayerNoticeConsumer(null);
  cancelReaderOverviewSource();
  liveOverlayBinding.dispose();
  disposePlayerToast();
}
