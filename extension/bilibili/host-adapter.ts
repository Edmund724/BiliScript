import {
  ANY_PLAYER_HOST_SELECTOR,
  BILI_HOST_SELECTORS,
  LIVE_ROOM_PLAYER_HOST_SELECTOR,
  LIVE_ROOM_VIDEO_SELECTOR,
  PLAYBACK_RATE_CONTAINER_SELECTOR,
  PLAYER_CONTROL_BAR_SELECTOR,
  PLAYER_PRIMARY_SELECTOR,
  PLAYER_SUBTITLE_CONTROL_ROOTS_SELECTOR,
  PLAYER_VIDEO_HOST_MATCH_SELECTOR,
  PLAYER_WEB_FULLSCREEN_SELECTOR,
  PLAYER_WEB_FULLSCREEN_TOGGLE_SELECTOR,
  TOOLBAR_HOST_SELECTOR,
  VIDEO_PLAYER_CONTAINER_SELECTOR,
  closestFallback,
  findAnyPlayerHost,
  findLiveRoomPlayerHost,
  findPlayerHostFromVideo,
  findPlayerHostWithVideoArea,
  findVideoPlayerContainer,
  isPlayerHostElement,
  querySelectorFallback,
  resolveBpxPlayerContainer
} from "./host-selectors.js";

export {
  ANY_PLAYER_HOST_SELECTOR,
  BILI_HOST_SELECTORS,
  LIVE_ROOM_PLAYER_HOST_SELECTOR,
  LIVE_ROOM_VIDEO_SELECTOR,
  PLAYBACK_RATE_CONTAINER_SELECTOR,
  PLAYER_CONTROL_BAR_SELECTOR,
  PLAYER_PRIMARY_SELECTOR,
  PLAYER_SUBTITLE_CONTROL_ROOTS_SELECTOR,
  PLAYER_VIDEO_HOST_MATCH_SELECTOR,
  PLAYER_WEB_FULLSCREEN_SELECTOR,
  PLAYER_WEB_FULLSCREEN_TOGGLE_SELECTOR,
  TOOLBAR_HOST_SELECTOR,
  VIDEO_PLAYER_CONTAINER_SELECTOR,
  closestFallback,
  findAnyPlayerHost,
  findLiveRoomPlayerHost,
  findPlayerHostFromVideo,
  findPlayerHostWithVideoArea,
  findVideoPlayerContainer,
  isPlayerHostElement,
  querySelectorFallback,
  resolveBpxPlayerContainer
};

export interface HostObserverHandle {
  disconnect(): void;
}

export interface ObserveHostContainerOptions {
  containerSelector?: string | readonly string[];
  containerObserveOptions?: MutationObserverInit;
  onMutations: (records: MutationRecord[]) => void;
  onObserverChange?: (observer: MutationObserver | null) => void;
  signal?: AbortSignal;
}

export interface ObserveHostElementOptions {
  observeOptions: MutationObserverInit;
  onMutations: (records: MutationRecord[]) => void;
  onObserverChange?: (observer: MutationObserver | null) => void;
  signal?: AbortSignal;
}

interface NormalizedObserveOptions {
  childList: boolean;
  subtree: boolean;
  attributes: boolean;
  characterData: boolean;
  attributeFilter: string[] | null;
}

interface Subscription {
  resolveContainer: (() => Element | null) | null;
  options: NormalizedObserveOptions;
  onMutations: (records: MutationRecord[]) => void;
  onObserverChange?: (observer: MutationObserver | null) => void;
  target: Element | null;
  disposed: boolean;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface TargetWatch {
  target: Element;
  observer: MutationObserver;
  subscribers: Set<Subscription>;
  mergedKey: string;
}

function normalizeObserveOptions(init?: MutationObserverInit): NormalizedObserveOptions {
  const childList = Boolean(init?.childList);
  const attributes = Boolean(init?.attributes || (init?.attributeFilter && init.attributeFilter.length > 0));
  const characterData = Boolean(init?.characterData);
  const subtree = Boolean(init?.subtree);
  const attributeFilter =
    attributes && Array.isArray(init?.attributeFilter) && init.attributeFilter.length > 0
      ? [...new Set(init.attributeFilter)].sort()
      : null;
  if (!childList && !attributes && !characterData) {
    return { childList: true, subtree: true, attributes: false, characterData: false, attributeFilter: null };
  }
  return { childList, subtree, attributes, characterData, attributeFilter };
}

function mergeObserveOptions(subscribers: Iterable<Subscription>): {
  init: MutationObserverInit;
  key: string;
} {
  let childList = false;
  let subtree = false;
  let attributes = false;
  let characterData = false;
  let allAttributesUnfiltered = false;
  const filterSet = new Set<string>();

  for (const sub of subscribers) {
    if (sub.options.childList) childList = true;
    if (sub.options.subtree) subtree = true;
    if (sub.options.characterData) characterData = true;
    if (sub.options.attributes) {
      attributes = true;
      if (sub.options.attributeFilter === null) {
        allAttributesUnfiltered = true;
      } else {
        for (const attr of sub.options.attributeFilter) {
          filterSet.add(attr);
        }
      }
    }
  }

  const init: MutationObserverInit = {};
  if (childList) init.childList = true;
  if (subtree) init.subtree = true;
  if (attributes) {
    init.attributes = true;
    if (!allAttributesUnfiltered && filterSet.size > 0) {
      init.attributeFilter = [...filterSet].sort();
    }
  }
  if (characterData) init.characterData = true;

  const key = [
    childList ? "c1" : "c0",
    subtree ? "s1" : "s0",
    attributes ? "a1" : "a0",
    characterData ? "d1" : "d0",
    init.attributeFilter ? init.attributeFilter.join(",") : "*"
  ].join("|");
  return { init, key };
}

function recordMatchesSubscription(
  record: MutationRecord,
  target: Element,
  options: NormalizedObserveOptions
): boolean {
  if (!options.subtree && record.target !== target) {
    return false;
  }
  if (record.type === "childList") {
    return options.childList;
  }
  if (record.type === "attributes") {
    if (!options.attributes) {
      return false;
    }
    if (!options.attributeFilter) {
      return true;
    }
    return record.attributeName !== null && options.attributeFilter.includes(record.attributeName);
  }
  if (record.type === "characterData") {
    return options.characterData;
  }
  return false;
}

function createContainerResolver(selector?: string | readonly string[]): () => Element | null {
  if (!selector) {
    return () => document.querySelector(PLAYER_PRIMARY_SELECTOR);
  }
  if (typeof selector === "string") {
    return () => document.querySelector(selector);
  }
  const chain = [...selector];
  return () => querySelectorFallback<Element>(chain, document);
}

export interface BiliHostAdapter {
  readonly selectors: typeof BILI_HOST_SELECTORS;
  findVideoPlayerContainer: typeof findVideoPlayerContainer;
  findPlayerHostWithVideoArea: typeof findPlayerHostWithVideoArea;
  findPlayerHostFromVideo: typeof findPlayerHostFromVideo;
  findLiveRoomPlayerHost: typeof findLiveRoomPlayerHost;
  findAnyPlayerHost: typeof findAnyPlayerHost;
  resolveBpxPlayerContainer: typeof resolveBpxPlayerContainer;
  isPlayerHostElement: typeof isPlayerHostElement;
  observeContainer(options: ObserveHostContainerOptions): HostObserverHandle;
  observeElement(target: Element, options: ObserveHostElementOptions): HostObserverHandle;
  getActiveObserverCount(): number;
  getSubscriberCount(): number;
  disposeAll(): void;
}

export function createBiliHostAdapter(): BiliHostAdapter {
  const targetWatches = new Map<Element, TargetWatch>();
  const waitingSubscribers = new Set<Subscription>();
  let bodyObserver: MutationObserver | null = null;

  function ensureBodyObserver(): MutationObserver | null {
    if (typeof MutationObserver === "undefined" || typeof document === "undefined" || !document.body) {
      return null;
    }
    if (!bodyObserver) {
      bodyObserver = new MutationObserver(() => {
        for (const sub of [...waitingSubscribers]) {
          if (sub.disposed || !sub.resolveContainer) {
            waitingSubscribers.delete(sub);
            continue;
          }
          const nextContainer = sub.resolveContainer();
          if (!nextContainer) {
            continue;
          }
          waitingSubscribers.delete(sub);
          const watch = attachToTarget(nextContainer, sub);
          if (watch) {
            try {
              sub.onMutations([]);
            } catch {
            }
          }
        }
        teardownBodyObserverIfIdle();
      });
      bodyObserver.observe(document.body, { childList: true, subtree: true });
    }
    return bodyObserver;
  }

  function teardownBodyObserverIfIdle(): void {
    if (waitingSubscribers.size === 0 && bodyObserver) {
      bodyObserver.disconnect();
      bodyObserver = null;
    }
  }

  function syncTargetWatchOptions(watch: TargetWatch): void {
    if (watch.subscribers.size === 0) {
      watch.observer.disconnect();
      targetWatches.delete(watch.target);
      return;
    }
    const { init, key } = mergeObserveOptions(watch.subscribers);
    if (key === watch.mergedKey) {
      return;
    }
    watch.mergedKey = key;
    watch.observer.disconnect();
    watch.observer.observe(watch.target, init);
  }

  function attachToTarget(target: Element, sub: Subscription): TargetWatch | null {
    if (typeof MutationObserver === "undefined") {
      return null;
    }
    let watch = targetWatches.get(target);
    if (!watch) {
      const observer = new MutationObserver((records) => {
        const currentWatch = targetWatches.get(target);
        if (!currentWatch) {
          return;
        }
        if (!target.isConnected) {
          const detachedSubs = [...currentWatch.subscribers];
          currentWatch.subscribers.clear();
          currentWatch.observer.disconnect();
          targetWatches.delete(target);
          for (const detachedSub of detachedSubs) {
            detachedSub.target = null;
            if (detachedSub.disposed) {
              continue;
            }
            if (detachedSub.resolveContainer) {
              bindContainerSubscription(detachedSub);
            } else {
              detachedSub.onObserverChange?.(null);
            }
          }
          return;
        }

        for (const subscriber of [...currentWatch.subscribers]) {
          if (subscriber.disposed) {
            continue;
          }
          const matched = records.filter((record) =>
            recordMatchesSubscription(record, target, subscriber.options)
          );
          if (matched.length === 0) {
            continue;
          }
          try {
            subscriber.onMutations(matched);
          } catch {
          }
        }
      });
      watch = {
        target,
        observer,
        subscribers: new Set(),
        mergedKey: ""
      };
      targetWatches.set(target, watch);
    }

    sub.target = target;
    watch.subscribers.add(sub);
    syncTargetWatchOptions(watch);
    sub.onObserverChange?.(watch.observer);
    return watch;
  }

  function bindContainerSubscription(sub: Subscription): void {
    if (sub.disposed || !sub.resolveContainer) {
      return;
    }
    const container = sub.resolveContainer();
    if (container) {
      attachToTarget(container, sub);
      return;
    }
    const fallback = ensureBodyObserver();
    if (fallback) {
      waitingSubscribers.add(sub);
      sub.onObserverChange?.(fallback);
    }
  }

  function detachSubscription(sub: Subscription): void {
    if (sub.disposed) {
      return;
    }
    sub.disposed = true;
    if (sub.signal && sub.abortHandler) {
      sub.signal.removeEventListener("abort", sub.abortHandler);
    }
    waitingSubscribers.delete(sub);
    teardownBodyObserverIfIdle();

    if (sub.target) {
      const watch = targetWatches.get(sub.target);
      sub.target = null;
      if (watch) {
        watch.subscribers.delete(sub);
        syncTargetWatchOptions(watch);
      }
    }
    sub.onObserverChange?.(null);
  }

  function registerAbort(sub: Subscription, signal?: AbortSignal): void {
    if (!signal) {
      return;
    }
    const onAbort = () => detachSubscription(sub);
    sub.signal = signal;
    sub.abortHandler = onAbort;
    signal.addEventListener("abort", onAbort, { once: true });
  }

  function observeContainer(options: ObserveHostContainerOptions): HostObserverHandle {
    if (
      options.signal?.aborted ||
      typeof MutationObserver === "undefined" ||
      typeof document === "undefined" ||
      !document.body
    ) {
      return { disconnect() {} };
    }

    const sub: Subscription = {
      resolveContainer: createContainerResolver(options.containerSelector),
      options: normalizeObserveOptions(options.containerObserveOptions),
      onMutations: options.onMutations,
      onObserverChange: options.onObserverChange,
      target: null,
      disposed: false
    };
    registerAbort(sub, options.signal);
    bindContainerSubscription(sub);

    return {
      disconnect() {
        detachSubscription(sub);
      }
    };
  }

  function observeElement(target: Element, options: ObserveHostElementOptions): HostObserverHandle {
    if (options.signal?.aborted || typeof MutationObserver === "undefined" || !target) {
      return { disconnect() {} };
    }

    const sub: Subscription = {
      resolveContainer: null,
      options: normalizeObserveOptions(options.observeOptions),
      onMutations: options.onMutations,
      onObserverChange: options.onObserverChange,
      target: null,
      disposed: false
    };
    registerAbort(sub, options.signal);
    attachToTarget(target, sub);

    return {
      disconnect() {
        detachSubscription(sub);
      }
    };
  }

  function getActiveObserverCount(): number {
    return targetWatches.size + (bodyObserver ? 1 : 0);
  }

  function getSubscriberCount(): number {
    let count = waitingSubscribers.size;
    for (const watch of targetWatches.values()) {
      count += watch.subscribers.size;
    }
    return count;
  }

  function disposeAll(): void {
    for (const sub of [...waitingSubscribers]) {
      detachSubscription(sub);
    }
    for (const watch of [...targetWatches.values()]) {
      for (const sub of [...watch.subscribers]) {
        detachSubscription(sub);
      }
    }
    teardownBodyObserverIfIdle();
  }

  return {
    selectors: BILI_HOST_SELECTORS,
    findVideoPlayerContainer,
    findPlayerHostWithVideoArea,
    findPlayerHostFromVideo,
    findLiveRoomPlayerHost,
    findAnyPlayerHost,
    resolveBpxPlayerContainer,
    isPlayerHostElement,
    observeContainer,
    observeElement,
    getActiveObserverCount,
    getSubscriberCount,
    disposeAll
  };
}

export const biliHostAdapter: BiliHostAdapter = createBiliHostAdapter();
