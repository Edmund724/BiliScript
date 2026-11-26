import {
  activeById,
  getActiveReaderDocument,
  getActiveReaderWindow,
  getOpenerWindow,
  onActiveHostChange,
} from "./active-host.js";

export interface ActiveAnimationFrameHandle {
  cancel(): void;
  window: Window;
}

export interface MigratingFrameHandle {
  cancel(): void;
}

export interface ScheduleMigratingFrameOptions {
  targetNode?: Node | null;
  preferredWin?: Window | null;
  fallbackMs?: number;
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).nodeType === "number"
  );
}

export function isElementNode(value: unknown): value is Element {
  return isNode(value) && value.nodeType === 1;
}

export function isHtmlElement(value: unknown): value is HTMLElement {
  return isElementNode(value) && typeof (value as HTMLElement).style !== "undefined";
}

export function isTextNode(value: unknown): value is Text {
  return isNode(value) && value.nodeType === 3;
}

export function isTagElement<K extends keyof HTMLElementTagNameMap>(
  value: unknown,
  tag: K
): value is HTMLElementTagNameMap[K] {
  return (
    isHtmlElement(value) &&
    typeof value.tagName === "string" &&
    value.tagName.toLowerCase() === tag
  );
}

export function isHtmlButton(value: unknown): value is HTMLButtonElement {
  return isTagElement(value, "button");
}

export function isEditableTarget(value: unknown): boolean {
  if (!isHtmlElement(value)) {
    return false;
  }
  const tag = typeof value.tagName === "string" ? value.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || Boolean(value.isContentEditable)) {
    return true;
  }
  const prop = typeof value.contentEditable === "string" ? value.contentEditable.toLowerCase() : "";
  if (prop === "true" || prop === "plaintext-only") {
    return true;
  }
  const attr = value.getAttribute("contenteditable");
  if (attr === null) {
    return false;
  }
  const normalized = attr.toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "plaintext-only";
}

export function isBlobLike(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  const activeWin = getActiveReaderWindow() as Window & { Blob?: typeof Blob };
  if (typeof activeWin?.Blob === "function" && value instanceof activeWin.Blob) {
    return true;
  }
  const candidate = value as Partial<Blob>;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.arrayBuffer === "function"
  );
}

export function resolveNodeDocument(node?: Node | null): Document {
  if (node) {
    if (node.nodeType === 9) {
      return node as Document;
    }
    if (node.ownerDocument) {
      return node.ownerDocument;
    }
  }
  return getActiveReaderDocument();
}

export function resolveNodeWindow(node?: Node | null): Window {
  return resolveNodeDocument(node).defaultView ?? getActiveReaderWindow();
}

export function createActiveEvent(
  type: string,
  init?: EventInit,
  target?: Node | null
): Event {
  try {
    const win = target ? resolveNodeWindow(target) : getActiveReaderWindow();
    const EventCtor = (win as (Window & { Event?: typeof Event }) | null)?.Event;
    if (typeof EventCtor === "function") {
      return new EventCtor(type, init);
    }
  } catch {
  }
  return new Event(type, init);
}

export function dispatchCrossDocEvent(
  target: EventTarget,
  type: string,
  init?: EventInit
): boolean {
  const event = createActiveEvent(type, init, isNode(target) ? target : null);
  return target.dispatchEvent(event);
}

export function prefersActiveReducedMotion(target?: Node | null): boolean {
  try {
    const win = target ? resolveNodeWindow(target) : getActiveReaderWindow();
    if (!win || win.closed || typeof win.matchMedia !== "function") {
      return false;
    }
    return Boolean(win.matchMedia("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

export function requireActiveById<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = activeById<T>(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

export function safeRemoveListener(
  target: EventTarget | null | undefined,
  type: string,
  listener: EventListenerOrEventListenerObject | ((event: never) => void) | null | undefined,
  options?: boolean | EventListenerOptions
): void {
  if (!target || !listener) {
    return;
  }
  try {
    target.removeEventListener(type, listener as EventListener, options);
  } catch {
  }
}

export function writeActiveClipboardText(
  text: string,
  preferredWin?: Window | null
): Promise<void> {
  const primaryWin = preferredWin ?? getActiveReaderWindow();
  const openerWin = getOpenerWindow();
  const primaryClipboard = primaryWin?.navigator?.clipboard;
  const fallbackClipboard =
    openerWin !== primaryWin ? openerWin?.navigator?.clipboard : undefined;
  const hasFallback =
    Boolean(fallbackClipboard) && typeof fallbackClipboard?.writeText === "function";

  if (primaryClipboard && typeof primaryClipboard.writeText === "function") {
    try {
      const attempt = Promise.resolve(primaryClipboard.writeText(text));
      if (!hasFallback) {
        return attempt;
      }
      return attempt.catch((primaryError) => {
        try {
          return Promise.resolve(fallbackClipboard!.writeText(text)).catch(() => {
            throw primaryError;
          });
        } catch {
          throw primaryError;
        }
      });
    } catch (error) {
      if (hasFallback) {
        try {
          return Promise.resolve(fallbackClipboard!.writeText(text));
        } catch {
          return Promise.reject(error);
        }
      }
      return Promise.reject(error);
    }
  }
  if (hasFallback) {
    try {
      return Promise.resolve(fallbackClipboard!.writeText(text));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return Promise.reject(new Error("Clipboard API unavailable"));
}

export function scheduleActiveAnimationFrame(
  callback: FrameRequestCallback,
  preferredWin?: Window | null
): ActiveAnimationFrameHandle {
  const targetWin = preferredWin ?? getActiveReaderWindow();
  let usedTargetWin = false;
  let id: number;
  try {
    if (typeof targetWin?.requestAnimationFrame === "function") {
      id = targetWin.requestAnimationFrame(callback);
      usedTargetWin = true;
    } else {
      id = requestAnimationFrame(callback);
    }
  } catch {
    id = requestAnimationFrame(callback);
  }
  let cancelled = false;
  return {
    window: targetWin,
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (usedTargetWin) {
        try {
          if (typeof targetWin?.cancelAnimationFrame === "function") {
            targetWin.cancelAnimationFrame(id);
            return;
          }
        } catch {
        }
      }
      try {
        cancelAnimationFrame(id);
      } catch {
      }
    },
  };
}

function isLiveWindow(win: Window | null | undefined): win is Window {
  if (!win) {
    return false;
  }
  try {
    return win.closed !== true;
  } catch {
    return false;
  }
}

function resolveMigratingInitialWindow(options?: ScheduleMigratingFrameOptions): Window | null {
  if (options?.preferredWin) {
    return options.preferredWin;
  }
  if (options?.targetNode && isNode(options.targetNode)) {
    try {
      const nodeWin = resolveNodeWindow(options.targetNode);
      if (isLiveWindow(nodeWin)) {
        return nodeWin;
      }
    } catch {
    }
  }
  return getActiveReaderWindow();
}

function currentTimestamp(): number {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch {
  }
  return Date.now();
}

export function scheduleMigratingFrame(
  callback: FrameRequestCallback,
  options?: ScheduleMigratingFrameOptions
): MigratingFrameHandle {
  const fallbackMs =
    typeof options?.fallbackMs === "number" && options.fallbackMs >= 0 ? options.fallbackMs : 16;
  let settled = false;
  let attemptId = 0;
  let cancelCurrent: (() => void) | null = null;
  let stopHostWatch: (() => void) | null = null;

  const cleanup = () => {
    stopHostWatch?.();
    stopHostWatch = null;
    const cancel = cancelCurrent;
    cancelCurrent = null;
    if (cancel) {
      try {
        cancel();
      } catch {
      }
    }
  };

  const scheduleOn = (candidateWin: Window | null | undefined) => {
    if (settled) {
      return;
    }
    const prevCancel = cancelCurrent;
    cancelCurrent = null;
    if (prevCancel) {
      try {
        prevCancel();
      } catch {
      }
    }

    const token = ++attemptId;
    const targetWin = isLiveWindow(candidateWin) ? candidateWin : getActiveReaderWindow();
    const onFire = (time: number) => {
      if (settled || token !== attemptId) {
        return;
      }
      settled = true;
      cancelCurrent = null;
      stopHostWatch?.();
      stopHostWatch = null;
      callback(time);
    };

    let hasWinRaf = false;
    try {
      hasWinRaf = isLiveWindow(targetWin) && typeof targetWin.requestAnimationFrame === "function";
    } catch {
      hasWinRaf = false;
    }

    if (hasWinRaf && targetWin) {
      let rafId: number | null = null;
      try {
        rafId = targetWin.requestAnimationFrame(onFire);
      } catch {
        rafId = null;
      }
      if (rafId !== null) {
        if (!settled && token === attemptId) {
          let cancelledAttempt = false;
          cancelCurrent = () => {
            if (cancelledAttempt) {
              return;
            }
            cancelledAttempt = true;
            try {
              if (typeof targetWin.cancelAnimationFrame === "function") {
                targetWin.cancelAnimationFrame(rafId!);
                return;
              }
            } catch {
            }
            try {
              cancelAnimationFrame(rafId!);
            } catch {
            }
          };
        }
        return;
      }
    }

    let timerId: ReturnType<typeof setTimeout> | number;
    let usedWinTimer = false;
    const runFallback = () => onFire(currentTimestamp());
    try {
      if (isLiveWindow(targetWin) && typeof targetWin.setTimeout === "function") {
        timerId = targetWin.setTimeout(runFallback, fallbackMs);
        usedWinTimer = true;
      } else {
        timerId = setTimeout(runFallback, fallbackMs);
      }
    } catch {
      timerId = setTimeout(runFallback, fallbackMs);
    }

    if (!settled && token === attemptId) {
      let cancelledAttempt = false;
      cancelCurrent = () => {
        if (cancelledAttempt) {
          return;
        }
        cancelledAttempt = true;
        if (usedWinTimer && targetWin) {
          try {
            targetWin.clearTimeout(timerId as number);
            return;
          } catch {
          }
        }
        try {
          clearTimeout(timerId);
        } catch {
        }
      };
    }
  };

  scheduleOn(resolveMigratingInitialWindow(options));

  if (!settled) {
    stopHostWatch = onActiveHostChange((ctx) => {
      if (settled) {
        stopHostWatch?.();
        stopHostWatch = null;
        return;
      }
      scheduleOn(ctx.win);
    });
  }

  return {
    cancel() {
      if (settled) {
        return;
      }
      settled = true;
      attemptId += 1;
      cleanup();
    },
  };
}

export function yieldToActiveMainThread(): Promise<void> {
  const activeWin = getActiveReaderWindow();
  const liveWin = isLiveWindow(activeWin) ? activeWin : null;
  if (liveWin) {
    try {
      const schedulerApi = (
        liveWin as Window & { scheduler?: { yield?: () => Promise<void> } }
      ).scheduler;
      if (typeof schedulerApi?.yield === "function") {
        return schedulerApi.yield();
      }
    } catch {
    }
  } else {
    try {
      const globalScheduler = (
        globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }
      ).scheduler;
      if (typeof globalScheduler?.yield === "function") {
        return globalScheduler.yield();
      }
    } catch {
    }
  }
  return new Promise((resolve) => {
    if (liveWin) {
      try {
        if (typeof liveWin.setTimeout === "function") {
          liveWin.setTimeout(resolve, 0);
          return;
        }
      } catch {
      }
    }
    setTimeout(resolve, 0);
  });
}
