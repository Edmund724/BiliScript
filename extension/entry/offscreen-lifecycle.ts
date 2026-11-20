// offscreen-lifecycle.ts — Offscreen document lease tracking and tiered idle reclaim arbitration.
//
// Tiered reclaim policy ("light stay-warm, heavy fast-reclaim, all-tabs-closed fallback"):
// - Light channels (chat, provider-http): when all active ports and tasks drop to zero,
//   schedule a long idle fallback timer (default 10 min) and a short-delay check asking SW
//   whether any `*://*.bilibili.com/*` tab remains open. If all Bilibili tabs are closed or
//   the document stays completely idle past 10 min, trigger closeSelf; otherwise keep warm.
// - Heavy media channels (ASR decode/probe, live companion, video frame capture): mark the
//   session as having used high-memory media resources (OfflineAudioContext / <video> buffers).
//   Once all active ports and tasks drop to zero, reclaim after a short grace window
//   (ASR: 4s; live/frame media: 45s). Any new port or task entering during the grace window
//   cancels the pending timer immediately.

import { consumeRuntimeLastError } from "../shared/messaging.js";
import type { OffscreenCloseReason } from "../shared/messaging-protocol.js";

export type { OffscreenCloseReason };

export const DEFAULT_ASR_IDLE_GRACE_MS = 4_000;
export const DEFAULT_MEDIA_IDLE_GRACE_MS = 45_000;
export const DEFAULT_LIGHT_IDLE_MS = 10 * 60_000;
export const DEFAULT_LIGHT_TAB_CHECK_DELAY_MS = 1_500;

export interface LifetimePort {
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

export interface OffscreenCloseRequest {
  reason: OffscreenCloseReason;
  onlyIfNoBilibiliTabs?: boolean;
}

export interface OffscreenLifetimeOptions {
  closeSelf: (request: OffscreenCloseRequest) => void | Promise<void>;
  asrIdleGraceMs?: number;
  mediaIdleGraceMs?: number;
  lightIdleMs?: number;
  lightTabCheckDelayMs?: number;
}

export interface OffscreenTaskOptions {
  heavy?: boolean;
}

export interface OffscreenLifetime {
  trackPort(port: LifetimePort): void;
  trackMediaPort(port: LifetimePort): void;
  trackAsrPort(port: LifetimePort): void;
  noteAsrTerminal(port: LifetimePort): void;
  withTask<T>(run: () => Promise<T>, options?: OffscreenTaskOptions): Promise<T>;
  notifyAllBilibiliTabsClosed(): void;
  dispose(): void;
}

/** Returns true only when both active non-ASR port and task counts are <= 0 (NaN/undefined preserve). */
export function shouldCloseAfterAsrTask(
  activePortCount: unknown,
  activeTaskCount: unknown
): boolean {
  return Number(activePortCount) <= 0 && Number(activeTaskCount) <= 0;
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

/** Creates a tiered offscreen document lifetime tracker. */
export function createOffscreenLifetime({
  closeSelf,
  asrIdleGraceMs = DEFAULT_ASR_IDLE_GRACE_MS,
  mediaIdleGraceMs = DEFAULT_MEDIA_IDLE_GRACE_MS,
  lightIdleMs = DEFAULT_LIGHT_IDLE_MS,
  lightTabCheckDelayMs = DEFAULT_LIGHT_TAB_CHECK_DELAY_MS
}: OffscreenLifetimeOptions): OffscreenLifetime {
  const asrGrace = normalizeDelay(asrIdleGraceMs, DEFAULT_ASR_IDLE_GRACE_MS);
  const mediaGrace = normalizeDelay(mediaIdleGraceMs, DEFAULT_MEDIA_IDLE_GRACE_MS);
  const lightIdle = normalizeDelay(lightIdleMs, DEFAULT_LIGHT_IDLE_MS);
  const tabCheckDelay = normalizeDelay(lightTabCheckDelayMs, DEFAULT_LIGHT_TAB_CHECK_DELAY_MS);

  const activePorts = new Set<LifetimePort>();
  const activeAsrPorts = new Set<LifetimePort>();
  let activeTasks = 0;
  let usedAsr = false;
  let usedMedia = false;
  let hasObservedActivity = false;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;
  let tabCheckTimer: ReturnType<typeof setTimeout> | null = null;

  function isIdle(): boolean {
    return activeAsrPorts.size === 0 && shouldCloseAfterAsrTask(activePorts.size, activeTasks);
  }

  function clearTimers(): void {
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (tabCheckTimer !== null) {
      clearTimeout(tabCheckTimer);
      tabCheckTimer = null;
    }
  }

  function invokeClose(request: OffscreenCloseRequest): void {
    if (!isIdle()) {
      return;
    }
    closeSelf(request);
  }

  function scheduleIdleReclaim(): void {
    if (!hasObservedActivity || !isIdle()) {
      clearTimers();
      return;
    }
    clearTimers();

    if (usedAsr) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        invokeClose({ reason: "asr-idle" });
      }, asrGrace);
      return;
    }

    if (usedMedia) {
      closeTimer = setTimeout(() => {
        closeTimer = null;
        invokeClose({ reason: "media-idle" });
      }, mediaGrace);
      return;
    }

    closeTimer = setTimeout(() => {
      closeTimer = null;
      tabCheckTimer = null;
      invokeClose({ reason: "light-idle" });
    }, lightIdle);

    tabCheckTimer = setTimeout(() => {
      tabCheckTimer = null;
      invokeClose({ reason: "no-bilibili-tabs", onlyIfNoBilibiliTabs: true });
    }, tabCheckDelay);
  }

  function trackGenericPort(port: LifetimePort, heavyMedia: boolean): void {
    hasObservedActivity = true;
    if (heavyMedia) {
      usedMedia = true;
    }
    clearTimers();
    activePorts.add(port);
    port.onDisconnect.addListener(() => {
      consumeRuntimeLastError();
      if (activePorts.delete(port)) {
        scheduleIdleReclaim();
      }
    });
  }

  return {
    trackPort(port) {
      trackGenericPort(port, false);
    },
    trackMediaPort(port) {
      trackGenericPort(port, true);
    },
    trackAsrPort(port) {
      hasObservedActivity = true;
      usedAsr = true;
      clearTimers();
      activeAsrPorts.add(port);
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        if (activeAsrPorts.delete(port)) {
          scheduleIdleReclaim();
        }
      });
    },
    noteAsrTerminal(port) {
      hasObservedActivity = true;
      usedAsr = true;
      activeAsrPorts.delete(port);
      scheduleIdleReclaim();
    },
    async withTask<T>(run: () => Promise<T>, options?: OffscreenTaskOptions): Promise<T> {
      hasObservedActivity = true;
      if (options?.heavy) {
        usedMedia = true;
      }
      clearTimers();
      activeTasks += 1;
      try {
        return await run();
      } finally {
        activeTasks -= 1;
        scheduleIdleReclaim();
      }
    },
    notifyAllBilibiliTabsClosed() {
      if (!isIdle()) {
        return;
      }
      if (tabCheckTimer !== null) {
        clearTimeout(tabCheckTimer);
        tabCheckTimer = null;
      }
      invokeClose({ reason: "no-bilibili-tabs", onlyIfNoBilibiliTabs: true });
    },
    dispose() {
      clearTimers();
    }
  };
}
