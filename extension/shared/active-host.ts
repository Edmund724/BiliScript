// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import type { DetachedWindowMode } from "../core/defaults.js";

const ACTIVE_HOST_SLOT_KEY = "__BILISCRIPT_ACTIVE_HOST__";

export interface ActiveHostContext {
  doc: Document;
  win: Window;
  detached: boolean;
}

export type ActiveHostListener = (ctx: ActiveHostContext) => void;
export type DetachedModeSwitchHandler = (mode: DetachedWindowMode) => unknown;

interface ActiveHostSlot {
  doc: Document | null;
  win: Window | null;
  seq: number;
  listeners: Set<ActiveHostListener>;
  modeSwitchHandler: DetachedModeSwitchHandler | null;
}

function readActiveHostSlot(): ActiveHostSlot | undefined {
  const host = globalThis as unknown as Record<string, ActiveHostSlot | undefined>;
  return host[ACTIVE_HOST_SLOT_KEY];
}

function ensureActiveHostSlot(): ActiveHostSlot {
  const host = globalThis as unknown as Record<string, ActiveHostSlot | undefined>;
  return (host[ACTIVE_HOST_SLOT_KEY] ??= {
    doc: null,
    win: null,
    seq: 0,
    listeners: new Set(),
    modeSwitchHandler: null
  });
}

export function getOpenerDocument(): Document {
  return document;
}

export function getOpenerWindow(): Window {
  return window;
}

function hasLiveDetachedHost(
  slot: ActiveHostSlot | undefined
): slot is ActiveHostSlot & { doc: Document; win: Window } {
  if (!slot || !slot.doc || !slot.win || slot.doc === document || slot.win === window) {
    return false;
  }
  try {
    return slot.win.closed !== true && slot.doc.nodeType === 9;
  } catch {
    return false;
  }
}

export function isReaderDetached(): boolean {
  return hasLiveDetachedHost(readActiveHostSlot());
}

export function getActiveReaderDocument(): Document {
  const slot = readActiveHostSlot();
  return hasLiveDetachedHost(slot) ? slot.doc : document;
}

export function getActiveReaderWindow(): Window {
  const slot = readActiveHostSlot();
  return hasLiveDetachedHost(slot) ? slot.win : window;
}

function notifyActiveHostListeners(slot: ActiveHostSlot, ctx: ActiveHostContext): void {
  const seq = slot.seq;
  for (const listener of [...slot.listeners]) {
    if (slot.seq !== seq) {
      return;
    }
    try {
      listener(ctx);
    } catch {
    }
  }
}

export function setActiveReaderHost(doc: Document, win: Window): void {
  if (!doc || !win || doc === document || win === window) {
    resetActiveReaderHost();
    return;
  }
  const slot = ensureActiveHostSlot();
  if (slot.doc === doc && slot.win === win) {
    return;
  }
  slot.doc = doc;
  slot.win = win;
  slot.seq = (slot.seq ?? 0) + 1;
  notifyActiveHostListeners(slot, { doc, win, detached: true });
}

export function resetActiveReaderHost(): void {
  const slot = readActiveHostSlot();
  if (!slot || (slot.doc === null && slot.win === null)) {
    return;
  }
  slot.doc = null;
  slot.win = null;
  slot.seq = (slot.seq ?? 0) + 1;
  notifyActiveHostListeners(slot, { doc: document, win: window, detached: false });
}

export function onActiveHostChange(
  listener: ActiveHostListener,
  options?: { signal?: AbortSignal }
): () => void {
  if (typeof listener !== "function" || options?.signal?.aborted) {
    return () => {};
  }
  const slot = ensureActiveHostSlot();
  let active = true;
  const wrapped: ActiveHostListener = (ctx) => {
    if (!active) return;
    listener(ctx);
  };
  const unsubscribe = () => {
    if (!active) return;
    active = false;
    slot.listeners.delete(wrapped);
    options?.signal?.removeEventListener("abort", unsubscribe);
  };
  slot.listeners.add(wrapped);
  options?.signal?.addEventListener("abort", unsubscribe, { once: true });
  return unsubscribe;
}

export function activeById<T extends HTMLElement = HTMLElement>(id: string): T | null {
  return getActiveReaderDocument().getElementById(id) as T | null;
}

export function registerDetachedModeSwitchHandler(handler: DetachedModeSwitchHandler | null): () => void {
  const slot = ensureActiveHostSlot();
  slot.modeSwitchHandler = handler;
  return () => {
    if (slot.modeSwitchHandler === handler) {
      slot.modeSwitchHandler = null;
    }
  };
}

export function requestDetachedModeSwitch(mode: DetachedWindowMode): unknown {
  const handler = readActiveHostSlot()?.modeSwitchHandler;
  return handler ? handler(mode) : undefined;
}
