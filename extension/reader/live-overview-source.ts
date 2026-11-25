// BILISCRIPT_DUAL_INSTANCE_STATEFUL
import type { LiveOverviewSource } from "../live/live-overview-context.js";

export interface ReaderOverviewSource {
  getSnapshot(): LiveOverviewSource | null;
  subscribe(listener: () => void): () => void;
  ensureOverview?(options?: { forceRefresh?: boolean }): Promise<LiveOverviewSource | null>;
  cancel?(): void;
}

interface OverviewSourceSlots {
  currentSource: ReaderOverviewSource | null;
  currentSourceUnsubscribe: (() => void) | null;
  defaultSourcePromise: Promise<ReaderOverviewSource> | null;
  subscribers: Set<() => void>;
}

const OVERVIEW_SOURCE_SLOT_KEY = "__BILISCRIPT_READER_OVERVIEW_SOURCE__";

declare global {
  var __BILISCRIPT_READER_OVERVIEW_SOURCE__: OverviewSourceSlots | undefined;
}

function overviewSourceSlots(): OverviewSourceSlots {
  let slots = globalThis[OVERVIEW_SOURCE_SLOT_KEY];
  if (!slots) {
    slots = {
      currentSource: null,
      currentSourceUnsubscribe: null,
      defaultSourcePromise: null,
      subscribers: new Set<() => void>()
    };
    globalThis[OVERVIEW_SOURCE_SLOT_KEY] = slots;
  } else if (!(slots.subscribers instanceof Set)) {
    slots.subscribers = new Set<() => void>();
  }
  return slots;
}

function notifySubscribers(): void {
  for (const listener of [...overviewSourceSlots().subscribers]) {
    try {
      listener();
    } catch {
    }
  }
}

export function registerReaderOverviewSource(source: ReaderOverviewSource): void {
  const slots = overviewSourceSlots();
  slots.currentSourceUnsubscribe?.();
  slots.currentSource = source;
  slots.currentSourceUnsubscribe = source.subscribe(notifySubscribers);
}

async function ensureDefaultOverviewSource(): Promise<ReaderOverviewSource> {
  const slots = overviewSourceSlots();
  if (slots.currentSource) return slots.currentSource;
  if (slots.defaultSourcePromise) return slots.defaultSourcePromise;

  slots.defaultSourcePromise = (async () => {
    const [
      { createOverviewCoordinator },
      { resolveActiveProvider },
      { confirmDialog },
      { state }
    ] = await Promise.all([
      import("./overview-coordinator.js"),
      import("../ai/active-provider.js"),
      import("../ui/confirm-dialog.js"),
      import("../core/state.js")
    ]);
    if (slots.currentSource) return slots.currentSource;

    const coordinator = createOverviewCoordinator({
      getClip: () => state.clip,
      isReadingViewOpen: () => state.reader.readingViewOpen,
      resolveProvider: () => resolveActiveProvider(),
      loadAnalysis: () => import("../ai/analysis.js"),
      confirm: (options) =>
        state.reader.readingViewOpen && state.settings?.enableCostGuard === true
          ? confirmDialog(options)
          : Promise.resolve(true),
      registerUiActions: () => {},
      now: () => Date.now(),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args)
    });

    const source: ReaderOverviewSource = {
      getSnapshot: () => coordinator.getSnapshot(),
      subscribe: (listener) => coordinator.subscribe(listener),
      ensureOverview: async (options) => {
        await coordinator.trigger(options);
        return coordinator.getSnapshot();
      },
      cancel: () => coordinator.cancel()
    };
    registerReaderOverviewSource(source);
    return source;
  })();

  try {
    return await slots.defaultSourcePromise;
  } finally {
    slots.defaultSourcePromise = null;
  }
}

export function getReaderOverviewSource(): LiveOverviewSource | null {
  const { currentSource } = overviewSourceSlots();
  return currentSource ? currentSource.getSnapshot() : null;
}

export async function ensureReaderOverviewSource(
  options?: { forceRefresh?: boolean }
): Promise<LiveOverviewSource | null> {
  const slots = overviewSourceSlots();
  const source = slots.currentSource ?? (await ensureDefaultOverviewSource());
  if (typeof source.ensureOverview === "function") {
    return await source.ensureOverview(options);
  }
  return source.getSnapshot();
}

export function subscribeReaderOverviewSource(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  const { subscribers } = overviewSourceSlots();
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function cancelReaderOverviewSource(): void {
  overviewSourceSlots().currentSource?.cancel?.();
}
