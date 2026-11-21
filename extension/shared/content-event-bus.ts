// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import {
  createDisposableContext,
  createTypedEventBus,
  type DisposableContext,
  type TypedEventBus
} from "./typed-event-bus.js";

export interface ClipSwitchStartEvent {
  url: string;
  signature: string;
  runId: number;
}

export interface ClipSwitchSettledEvent {
  url: string;
  signature: string;
}

export interface HostUrlChangeEvent {
  url: string;
}

export interface ContentEventMap {
  "subtitle:status-phase": string;
  "reader:closed": void;
  "host:url-change": HostUrlChangeEvent;
  "clip:switch-start": ClipSwitchStartEvent;
  "clip:switch-settled": ClipSwitchSettledEvent;
}

interface ContentEventBusSlot {
  bus: TypedEventBus<ContentEventMap>;
  lastSubtitleStatusPhase: string;
  clipScope: DisposableContext;
}

const CONTENT_EVENT_BUS_SLOT_KEY = "__BILISCRIPT_EVENT_BUS__";

function getContentEventBusSlot(): ContentEventBusSlot {
  const host = globalThis as unknown as Record<string, ContentEventBusSlot | undefined>;
  let slot = host[CONTENT_EVENT_BUS_SLOT_KEY];
  if (!slot) {
    slot = {
      bus: createTypedEventBus<ContentEventMap>(),
      lastSubtitleStatusPhase: "",
      clipScope: createDisposableContext()
    };
    host[CONTENT_EVENT_BUS_SLOT_KEY] = slot;
  }
  return slot;
}

export function getContentEventBus(): TypedEventBus<ContentEventMap> {
  return getContentEventBusSlot().bus;
}

export const contentEventBus: TypedEventBus<ContentEventMap> = {
  on(event, listener, options) {
    return getContentEventBusSlot().bus.on(event, listener, options);
  },
  once(event, listener, options) {
    return getContentEventBusSlot().bus.once(event, listener, options);
  },
  emit(event, ...args) {
    return getContentEventBusSlot().bus.emit(event, ...args);
  },
  listenerCount(event) {
    return getContentEventBusSlot().bus.listenerCount(event);
  },
  clear() {
    getContentEventBusSlot().bus.clear();
  }
};

export function getLastSubtitleStatusPhase(): string {
  return getContentEventBusSlot().lastSubtitleStatusPhase;
}

export function setLastSubtitleStatusPhase(phase: string): void {
  getContentEventBusSlot().lastSubtitleStatusPhase = phase;
}

export function getCurrentClipScope(): DisposableContext {
  const slot = getContentEventBusSlot();
  if (slot.clipScope.isDisposed()) {
    slot.clipScope = createDisposableContext();
  }
  return slot.clipScope;
}

export function resetClipScope(): DisposableContext {
  const slot = getContentEventBusSlot();
  slot.clipScope.dispose();
  slot.clipScope = createDisposableContext();
  return slot.clipScope;
}
