import type { LiveOverviewSource } from "../live/live-overview-context.js";

export interface ReaderOverviewSource {
  getSnapshot(): LiveOverviewSource | null;
  subscribe(listener: () => void): () => void;
  ensureOverview?(options?: { forceRefresh?: boolean }): Promise<LiveOverviewSource | null>;
  cancel?(): void;
}

let currentSource: ReaderOverviewSource | null = null;
let currentSourceUnsubscribe: (() => void) | null = null;
let defaultSourcePromise: Promise<ReaderOverviewSource> | null = null;
const subscribers = new Set<() => void>();

function notifySubscribers(): void {
  for (const listener of [...subscribers]) {
    try {
      listener();
    } catch {
    }
  }
}

export function registerReaderOverviewSource(source: ReaderOverviewSource): void {
  currentSourceUnsubscribe?.();
  currentSource = source;
  currentSourceUnsubscribe = source.subscribe(notifySubscribers);
}

async function ensureDefaultOverviewSource(): Promise<ReaderOverviewSource> {
  if (currentSource) return currentSource;
  if (defaultSourcePromise) return defaultSourcePromise;

  defaultSourcePromise = (async () => {
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
    if (currentSource) return currentSource;

    const coordinator = createOverviewCoordinator({
      getClip: () => state.clip,
      isReadingViewOpen: () => state.reader.readingViewOpen,
      resolveProvider: () => resolveActiveProvider(),
      loadAnalysis: () => import("../ai/analysis.js"),
      confirm: (options) =>
        state.reader.readingViewOpen ? confirmDialog(options) : Promise.resolve(true),
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
    return await defaultSourcePromise;
  } finally {
    defaultSourcePromise = null;
  }
}

export function getReaderOverviewSource(): LiveOverviewSource | null {
  return currentSource ? currentSource.getSnapshot() : null;
}

export async function ensureReaderOverviewSource(
  options?: { forceRefresh?: boolean }
): Promise<LiveOverviewSource | null> {
  const source = currentSource ?? (await ensureDefaultOverviewSource());
  if (typeof source.ensureOverview === "function") {
    return await source.ensureOverview(options);
  }
  return source.getSnapshot();
}

export function subscribeReaderOverviewSource(listener: () => void): () => void {
  if (typeof listener !== "function") {
    return () => {};
  }
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

export function cancelReaderOverviewSource(): void {
  currentSource?.cancel?.();
}
