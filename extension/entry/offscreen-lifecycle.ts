// offscreen-lifecycle.ts — Offscreen document lease tracking and ASR-terminal self-close arbitration.
//
// The shared offscreen document hosts long-lived ports (chat, live, provider-http),
// ASR decode ports, and non-port async message tasks (e.g. historical frame capture).
// While any generic port, other ASR port, or active async task is in flight, an ASR
// task reaching terminal state must not close the document; when ASR terminal close was
// deferred solely due to active tasks, finishing the last task triggers closeSelf once no
// active ports remain.

import { consumeRuntimeLastError } from "../shared/messaging.js";

export interface LifetimePort {
  onDisconnect: {
    addListener(listener: () => void): void;
  };
}

export interface OffscreenLifetime {
  trackPort(port: LifetimePort): void;
  trackAsrPort(port: LifetimePort): void;
  noteAsrTerminal(port: LifetimePort): void;
  withTask<T>(run: () => Promise<T>): Promise<T>;
}

/** Returns true only when both active non-ASR port and task counts are <= 0 (NaN/undefined preserve). */
export function shouldCloseAfterAsrTask(
  activePortCount: unknown,
  activeTaskCount: unknown
): boolean {
  return Number(activePortCount) <= 0 && Number(activeTaskCount) <= 0;
}

/** Creates an offscreen document lifetime tracker that invokes closeSelf when idle after ASR completion. */
export function createOffscreenLifetime({
  closeSelf
}: {
  closeSelf: () => void;
}): OffscreenLifetime {
  const activePorts = new Set<LifetimePort>();
  const activeAsrPorts = new Set<LifetimePort>();
  let activeTasks = 0;
  let pendingCloseAfterAsr = false;

  function canCloseNow(): boolean {
    return activeAsrPorts.size === 0 && shouldCloseAfterAsrTask(activePorts.size, activeTasks);
  }

  return {
    trackPort(port) {
      pendingCloseAfterAsr = false;
      activePorts.add(port);
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        activePorts.delete(port);
      });
    },
    trackAsrPort(port) {
      pendingCloseAfterAsr = false;
      activeAsrPorts.add(port);
      port.onDisconnect.addListener(() => {
        consumeRuntimeLastError();
        activeAsrPorts.delete(port);
      });
    },
    noteAsrTerminal(port) {
      activeAsrPorts.delete(port);
      if (activeAsrPorts.size > 0 || activePorts.size > 0) {
        return;
      }
      if (activeTasks > 0) {
        pendingCloseAfterAsr = true;
        return;
      }
      pendingCloseAfterAsr = false;
      if (canCloseNow()) {
        closeSelf();
      }
    },
    async withTask<T>(run: () => Promise<T>): Promise<T> {
      activeTasks += 1;
      try {
        return await run();
      } finally {
        activeTasks -= 1;
        if (pendingCloseAfterAsr && canCloseNow()) {
          pendingCloseAfterAsr = false;
          closeSelf();
        }
      }
    }
  };
}
