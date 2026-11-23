import { vi } from "vitest";
import { NORMAL_PAGE_URL, resetModuleState, setLocationUrl } from "../../setup.js";
import { mockPlayerRects, mountPlayerChain } from "../../helpers/reader-skeleton.js";
import {
  installDetachedPlatformFake,
  type DetachedPlatformFake,
  type FakeDetachedWindow,
  type PipFakeMode,
  type PopupFakeMode
} from "./detached-window-fake.js";
import {
  EXPECTED_DETACH_BTN_ID,
  loadActiveHostContract,
  loadShellContract,
  type DetachedWindowMode
} from "./detached-contracts.js";

export interface StorageChangeListenerEntry {
  listener: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void;
}

export interface StorageBridge {
  syncMap: Map<string, unknown>;
  localMap: Map<string, unknown>;
  failNextSyncSet: () => void;
  emitExternalChange: (areaName: "sync" | "local", key: string, oldValue: unknown, newValue: unknown) => void;
}

export interface BootOptions {
  url?: string;
  pipMode?: PipFakeMode;
  popupMode?: PopupFakeMode;
  availHeight?: number;
  viewportWidth?: number;
  viewportHeight?: number;
  extensionBaseUrl?: string;
  sync?: Record<string, unknown>;
  local?: Record<string, unknown>;
  bootContentScript?: boolean;
  rightAnchorPresent?: boolean;
}

export interface DetachedE2EHarness {
  readonly fakePlatform: DetachedPlatformFake;
  readonly storage: StorageBridge;
  readonly video: HTMLVideoElement;
  readonly videoPlaySpy: ReturnType<typeof vi.fn>;
  readonly openerFocusSpy: DetachedPlatformFake["openerFocusSpy"];
  flushStyles: (extraDocs?: Document[]) => Promise<void>;
  flushTimersAndMicrotasks: (ms?: number) => Promise<void>;
  dispatchMessage: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  openReaderInPage: () => Promise<void>;
  detachReader: () => Promise<FakeDetachedWindow>;
  attemptDetachReader: () => Promise<FakeDetachedWindow | null>;
  redockReader: () => Promise<void>;
  openSettingsInActiveHost: () => Promise<Document>;
  switchTabInActiveHost: (tab: "subtitle" | "overview" | "chat") => Promise<Document>;
  clickHeaderCloseInActiveHost: () => Promise<void>;
  clickHeaderThemeInActiveHost: () => Promise<void>;
  triggerSpaNavigation: (nextUrl: string, nextClip?: { bvid?: string; cid?: string; title?: string; subtitleText?: string }) => Promise<void>;
  toggleWebpageFullscreen: (fullscreen: boolean) => Promise<void>;
  seedClipData: (opts?: { bvid?: string; cid?: string; title?: string; subtitleText?: string }) => Promise<void>;
  getActiveHostDocument: () => Promise<Document>;
  getReadingView: () => Promise<HTMLElement | null>;
  cleanup: () => Promise<void>;
}

function createReactiveMemoryArea(
  map: Map<string, unknown>,
  areaName: "sync" | "local",
  emitChanges: (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void,
  shouldFailNextSet: () => boolean
) {
  return {
    get: vi.fn(async (keys?: string | string[] | Record<string, unknown> | null) => {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(map.entries());
      }
      if (typeof keys === "string") {
        return map.has(keys) ? { [keys]: map.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const out: Record<string, unknown> = {};
        for (const key of keys) {
          if (map.has(key)) {
            out[key] = map.get(key);
          }
        }
        return out;
      }
      const out: Record<string, unknown> = { ...keys };
      for (const key of Object.keys(keys)) {
        if (map.has(key)) {
          out[key] = map.get(key);
        }
      }
      return out;
    }),
    getKeys: vi.fn(async () => Array.from(map.keys())),
    set: vi.fn(async (items: Record<string, unknown>) => {
      if (shouldFailNextSet()) {
        throw new Error(`Simulated ${areaName} storage write failure`);
      }
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items ?? {})) {
        const oldValue = map.get(key);
        map.set(key, value);
        changes[key] = { oldValue, newValue: value };
      }
      if (Object.keys(changes).length > 0) {
        emitChanges(changes, areaName);
      }
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of list) {
        if (map.has(key)) {
          const oldValue = map.get(key);
          map.delete(key);
          changes[key] = { oldValue, newValue: undefined };
        }
      }
      if (Object.keys(changes).length > 0) {
        emitChanges(changes, areaName);
      }
    }),
    clear: vi.fn(async () => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, oldValue] of map.entries()) {
        changes[key] = { oldValue, newValue: undefined };
      }
      map.clear();
      if (Object.keys(changes).length > 0) {
        emitChanges(changes, areaName);
      }
    })
  };
}

interface StorageBridgeInternal extends StorageBridge {
  drain: () => Promise<void>;
}

function installStorageAndRuntimeBridge(options: {
  extensionBaseUrl: string;
  initialSync?: Record<string, unknown>;
  initialLocal?: Record<string, unknown>;
}): StorageBridgeInternal {
  const syncMap = new Map<string, unknown>(Object.entries(options.initialSync ?? {}));
  const localMap = new Map<string, unknown>(Object.entries(options.initialLocal ?? {}));
  const changeListeners = new Set<(changes: Record<string, chrome.storage.StorageChange>, areaName: string) => void>();
  const messageListeners = new Set<
    (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void
  >();
  const pendingRoutes = new Set<Promise<unknown>>();
  let disposed = false;
  let failSyncSet = false;

  const emitChanges = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    for (const listener of Array.from(changeListeners)) {
      listener(changes, areaName);
    }
  };

  const syncArea = createReactiveMemoryArea(syncMap, "sync", emitChanges, () => {
    if (!failSyncSet) {
      return false;
    }
    failSyncSet = false;
    return true;
  });
  const localArea = createReactiveMemoryArea(localMap, "local", emitChanges, () => false);

  const handleBackgroundRoute = async (message: Record<string, unknown>): Promise<unknown> => {
    const type = message.type;
    if (type === "get-settings") {
      const { getMergedSettings } = await import("../../../extension/core/settings-store.js");
      return { ok: true, settings: await getMergedSettings() };
    }
    if (type === "save-settings") {
      const { saveSettings } = await import("../../../extension/core/settings-store.js");
      const { invalidate } = await import("../../../extension/core/settings-snapshot.js");
      try {
        const settingsPayload = (message.settings ?? {}) as Record<string, unknown>;
        await saveSettings(settingsPayload);
        await invalidate(Object.keys(settingsPayload));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (type === "player-ai-quick-action") {
      const { dispatchContentScriptMessage } = await import("../../../extension/shared/messaging.js");
      const prompt = typeof message.prompt === "string" ? message.prompt : "";
      return await new Promise((resolve) => {
        dispatchContentScriptMessage(
          { type: "reader-enter", readerUrl: "", chat: { prompt } },
          (resp) => resolve(resp ?? { ok: true })
        );
      });
    }
    if (type === "ai-providers-list") {
      const { aiProviderStore } = await import("../../../extension/core/ai-provider-store.js");
      const { createProviderMessageHandlers } = await import("../../../extension/core/provider-handlers.js");
      const handlers = createProviderMessageHandlers({
        loadProviders: () => aiProviderStore.loadProviders(),
        saveProviders: (items) => aiProviderStore.saveProviders(items),
        deleteProvider: (providerId) => aiProviderStore.deleteProvider(providerId),
        loadKeys: () => aiProviderStore.loadKeys()
      });
      return await new Promise((resolve) => {
        handlers.list(message, {}, resolve);
      });
    }
    if (type === "resolve-ai-provider") {
      const { aiProviderStore } = await import("../../../extension/core/ai-provider-store.js");
      const { createAiResolvedProviderHandler } = await import("../../../extension/core/provider-handlers.js");
      const { getSettingsSnapshot } = await import("../../../extension/core/settings-snapshot.js");
      const handler = createAiResolvedProviderHandler({
        getMergedSettings: getSettingsSnapshot,
        loadProviders: () => aiProviderStore.loadProviders(),
        loadKeys: () => aiProviderStore.loadKeys()
      });
      return await new Promise((resolve) => {
        handler(message, {}, resolve);
      });
    }
    if (type === "agent-bridge-status") {
      return { ok: true, connected: false };
    }
    return { ok: true };
  };

  const baseUrl = options.extensionBaseUrl.endsWith("/")
    ? options.extensionBaseUrl
    : `${options.extensionBaseUrl}/`;

  const prevChrome = globalThis.chrome as unknown as Record<string, unknown>;
  const prevRuntime = (prevChrome?.runtime ?? {}) as Record<string, unknown>;

  vi.stubGlobal("chrome", {
    ...prevChrome,
    runtime: {
      ...prevRuntime,
      lastError: null,
      getURL: vi.fn((path: string) => `${baseUrl}${String(path).replace(/^\/+/, "")}`),
      connect: vi.fn((info?: { name?: string }) => ({
        name: info?.name ?? "",
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onMessage: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) },
        onDisconnect: { addListener: vi.fn(), removeListener: vi.fn(), hasListener: vi.fn(() => false) }
      })),
      onMessage: {
        addListener: vi.fn((listener) => messageListeners.add(listener)),
        removeListener: vi.fn((listener) => messageListeners.delete(listener)),
        hasListener: vi.fn((listener) => messageListeners.has(listener))
      },
      sendMessage: vi.fn((rawMessage: unknown, callback?: (resp: unknown) => void) => {
        const msg = (rawMessage && typeof rawMessage === "object" ? rawMessage : {}) as Record<string, unknown>;
        let tracked!: Promise<unknown>;
        tracked = (async () => {
          if (disposed) {
            return { ok: false };
          }
          const resp = await handleBackgroundRoute(msg);
          if (!disposed) {
            callback?.(resp);
          }
          return resp;
        })().finally(() => {
          pendingRoutes.delete(tracked);
        });
        pendingRoutes.add(tracked);
        return callback ? undefined : tracked;
      })
    },
    storage: {
      local: localArea,
      sync: syncArea,
      onChanged: {
        addListener: vi.fn((listener) => changeListeners.add(listener)),
        removeListener: vi.fn((listener) => changeListeners.delete(listener)),
        hasListener: vi.fn((listener) => changeListeners.has(listener))
      }
    }
  });

  return {
    syncMap,
    localMap,
    failNextSyncSet: () => {
      failSyncSet = true;
    },
    emitExternalChange: (areaName, key, oldValue, newValue) => {
      const targetMap = areaName === "sync" ? syncMap : localMap;
      if (newValue === undefined) {
        targetMap.delete(key);
      } else {
        targetMap.set(key, newValue);
      }
      emitChanges({ [key]: { oldValue, newValue } }, areaName);
    },
    drain: async () => {
      disposed = true;
      while (pendingRoutes.size > 0) {
        await Promise.allSettled(Array.from(pendingRoutes));
      }
    }
  };
}

function mountBilibiliHostDom(options: { rightAnchorPresent: boolean }): HTMLVideoElement {
  document.body.innerHTML = "";
  const video = mountPlayerChain(document.body);
  video.src = "blob:test-video";
  mockPlayerRects();

  const container = document.querySelector(".bpx-player-container");
  container?.setAttribute("data-screen", "normal");

  if (options.rightAnchorPresent) {
    const rightAnchor = document.createElement("div");
    rightAnchor.className = "right-container-inner";
    rightAnchor.getBoundingClientRect = () => ({
      x: 900,
      y: 120,
      top: 120,
      left: 900,
      right: 1260,
      bottom: 720,
      width: 360,
      height: 600,
      toJSON: () => ({})
    });
    document.body.appendChild(rightAnchor);
  }

  const toolbarAnchor = document.createElement("div");
  toolbarAnchor.id = "arc_toolbar_report";
  toolbarAnchor.className = "video-toolbar-container";
  const complaint = document.createElement("span");
  complaint.className = "complaint";
  complaint.textContent = "稿件举报";
  toolbarAnchor.appendChild(complaint);
  document.body.appendChild(toolbarAnchor);

  const playerControlWrap = document.createElement("div");
  playerControlWrap.className = "bpx-player-control-wrap";
  const controlBottomRight = document.createElement("div");
  controlBottomRight.className = "bpx-player-control-bottom-right";
  playerControlWrap.appendChild(controlBottomRight);
  document.querySelector(".bpx-player-container")?.appendChild(playerControlWrap);

  return video;
}

interface TrackedListenerEntry {
  target: EventTarget;
  type: string;
  listener: EventListenerOrEventListenerObject;
  capture: boolean;
  registeredListener: EventListenerOrEventListenerObject;
  cleanupAbort?: () => void;
}

interface TargetListenerState {
  prevAddDesc: PropertyDescriptor | undefined;
  prevRemoveDesc: PropertyDescriptor | undefined;
  origAdd: EventTarget["addEventListener"];
  origRemove: EventTarget["removeEventListener"];
}

function extractListenerCapture(options?: boolean | AddEventListenerOptions | EventListenerOptions): boolean {
  if (typeof options === "boolean") {
    return options;
  }
  if (options && typeof options === "object") {
    return Boolean(options.capture);
  }
  return false;
}

function installEventListenerTracker(targets: EventTarget[]) {
  const tracked: TrackedListenerEntry[] = [];
  const targetStates = new Map<EventTarget, TargetListenerState>();
  let methodsRestored = false;

  const removeTrackedEntry = (entry: TrackedListenerEntry): void => {
    const idx = tracked.indexOf(entry);
    if (idx >= 0) {
      tracked.splice(idx, 1);
    }
    entry.cleanupAbort?.();
    entry.cleanupAbort = undefined;
  };

  for (const target of targets) {
    const prevAddDesc = Object.getOwnPropertyDescriptor(target, "addEventListener");
    const prevRemoveDesc = Object.getOwnPropertyDescriptor(target, "removeEventListener");
    const origAdd = target.addEventListener;
    const origRemove = target.removeEventListener;
    targetStates.set(target, { prevAddDesc, prevRemoveDesc, origAdd, origRemove });

    const wrappedAdd = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ): void {
      if (!listener || (typeof listener !== "function" && typeof listener !== "object")) {
        origAdd.call(target, type, listener, options);
        return;
      }
      const typeStr = String(type);
      const capture = extractListenerCapture(options);
      const signal = typeof options === "object" && options !== null ? options.signal : undefined;
      if (signal?.aborted) {
        return;
      }
      const existingIdx = tracked.findIndex(
        (item) =>
          item.target === target &&
          item.type === typeStr &&
          item.listener === listener &&
          item.capture === capture
      );
      if (existingIdx >= 0) {
        return;
      }
      const once = typeof options === "object" && options !== null && Boolean(options.once);
      let entry: TrackedListenerEntry;
      const registeredListener: EventListenerOrEventListenerObject = once
        ? typeof listener === "function"
          ? function (this: unknown, event: Event) {
              removeTrackedEntry(entry);
              return listener.call(this, event);
            }
          : {
              handleEvent(event: Event) {
                removeTrackedEntry(entry);
                return listener.handleEvent(event);
              }
            }
        : listener;
      entry = {
        target,
        type: typeStr,
        listener,
        capture,
        registeredListener
      };
      if (signal) {
        const onAbort = () => {
          removeTrackedEntry(entry);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        entry.cleanupAbort = () => {
          signal.removeEventListener("abort", onAbort);
        };
      }
      origAdd.call(target, type, registeredListener, options);
      tracked.push(entry);
    };

    const wrappedRemove = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ): void {
      if (!listener || (typeof listener !== "function" && typeof listener !== "object")) {
        origRemove.call(target, type, listener, options);
        return;
      }
      const typeStr = String(type);
      const capture = extractListenerCapture(options);
      const idx = tracked.findIndex(
        (item) =>
          item.target === target &&
          item.type === typeStr &&
          item.listener === listener &&
          item.capture === capture
      );
      if (idx >= 0) {
        const [entry] = tracked.splice(idx, 1);
        entry.cleanupAbort?.();
        entry.cleanupAbort = undefined;
        origRemove.call(target, type, entry.registeredListener, options);
        return;
      }
      origRemove.call(target, type, listener, options);
    };

    Object.defineProperty(target, "addEventListener", {
      value: wrappedAdd,
      configurable: true,
      writable: true
    });
    Object.defineProperty(target, "removeEventListener", {
      value: wrappedRemove,
      configurable: true,
      writable: true
    });
  }

  return {
    removeTrackedListeners: (): void => {
      const snapshot = tracked.splice(0, tracked.length);
      for (const entry of snapshot) {
        entry.cleanupAbort?.();
        entry.cleanupAbort = undefined;
        const state = targetStates.get(entry.target);
        state?.origRemove.call(entry.target, entry.type, entry.registeredListener, entry.capture);
      }
    },
    restoreTargetMethods: (): void => {
      if (methodsRestored) {
        return;
      }
      methodsRestored = true;
      for (const [target, state] of targetStates.entries()) {
        if (state.prevAddDesc) {
          Object.defineProperty(target, "addEventListener", state.prevAddDesc);
        } else {
          Reflect.deleteProperty(target, "addEventListener");
        }
        if (state.prevRemoveDesc) {
          Object.defineProperty(target, "removeEventListener", state.prevRemoveDesc);
        } else {
          Reflect.deleteProperty(target, "removeEventListener");
        }
      }
    }
  };
}

export async function bootBilibiliVideoPage(options: BootOptions = {}): Promise<DetachedE2EHarness> {
  resetModuleState();
  vi.useFakeTimers();
  const listenerTracker = installEventListenerTracker([window, document]);
  const originalPushStateDesc = Object.getOwnPropertyDescriptor(history, "pushState");
  const originalReplaceStateDesc = Object.getOwnPropertyDescriptor(history, "replaceState");
  const trackedObservers = new Set<MutationObserver>();
  const OriginalMutationObserver = globalThis.MutationObserver;
  if (typeof OriginalMutationObserver === "function") {
    class TrackedMutationObserver extends OriginalMutationObserver {
      constructor(callback: MutationCallback) {
        super(callback);
        trackedObservers.add(this);
      }
    }
    vi.stubGlobal("MutationObserver", TrackedMutationObserver);
  }

  const originalFullscreenDesc = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
  const originalWebkitFullscreenDesc = Object.getOwnPropertyDescriptor(document, "webkitFullscreenElement");
  const originalBodyClassName = document.body.className;
  const originalDocElementClassName = document.documentElement.className;
  const originalHtmlAttrs = Array.from(document.documentElement.attributes).map((attr) => [attr.name, attr.value] as const);
  const originalBodyAttrs = Array.from(document.body.attributes).map((attr) => [attr.name, attr.value] as const);

  setLocationUrl(options.url ?? NORMAL_PAGE_URL);
  Object.defineProperty(window, "innerWidth", {
    value: options.viewportWidth ?? 1440,
    configurable: true,
    writable: true
  });
  Object.defineProperty(window, "innerHeight", {
    value: options.viewportHeight ?? 900,
    configurable: true,
    writable: true
  });
  Object.defineProperty(window, "scrollY", {
    value: 0,
    configurable: true,
    writable: true
  });

  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(() => true)
      })),
      configurable: true,
      writable: true
    });
  }

  const fakePlatform = installDetachedPlatformFake({
    pipMode: options.pipMode ?? "allow",
    popupMode: options.popupMode ?? "allow",
    availHeight: options.availHeight ?? 1080
  });

  const storage = installStorageAndRuntimeBridge({
    extensionBaseUrl: options.extensionBaseUrl ?? "chrome-extension://test/",
    initialSync: options.sync,
    initialLocal: options.local
  });

  const video = mountBilibiliHostDom({
    rightAnchorPresent: options.rightAnchorPresent ?? true
  });
  const videoPlaySpy = vi.fn(async () => {});
  Object.defineProperty(video, "play", {
    value: videoPlaySpy,
    configurable: true,
    writable: true
  });
  Object.defineProperty(video, "pause", {
    value: vi.fn(),
    configurable: true,
    writable: true
  });

  const flushStyles = async (extraDocs: Document[] = []) => {
    const docs = new Set<Document>([document, ...extraDocs]);
    for (const win of fakePlatform.openedWindows) {
      if (!win.closed) {
        docs.add(win.document);
      }
    }
    for (const doc of docs) {
      const links = Array.from(doc.querySelectorAll<HTMLLinkElement>('link[data-biliscript-style="1"]'));
      for (const link of links) {
        link.dispatchEvent(new Event("load"));
      }
    }
    await vi.advanceTimersByTimeAsync(60);
    await Promise.resolve();
  };

  const flushTimersAndMicrotasks = async (ms = 0) => {
    await vi.advanceTimersByTimeAsync(ms);
    await Promise.resolve();
    await Promise.resolve();
  };

  const seedClipData = async (clipOpts?: { bvid?: string; cid?: string; title?: string; subtitleText?: string }) => {
    const { clipState } = await import("../../../extension/core/state.js");
    const bvid = clipOpts?.bvid ?? "BV1test000000";
    const cid = clipOpts?.cid ?? "1001";
    const title = clipOpts?.title ?? "测试视频标题";
    const subtitleText = clipOpts?.subtitleText ?? "第一句测试字幕";
    clipState.setCurrentUrl(location.href);
    clipState.setBvid(bvid);
    clipState.setCid(cid);
    clipState.setTitle(title);
    clipState.setVideoDuration(600);
    clipState.setSubtitles([{ id: "ai-zh", lan: "ai-zh", lanDoc: "中文（自动）", subtitleUrl: "https://aisubtitle.hdslb.com/bfs/ai_subtitle/test.json" }]);
    clipState.setSelectedSubtitleId("ai-zh");
    clipState.setSubtitleBody([
      { from: 0, to: 10, content: subtitleText },
      { from: 30, to: 45, content: "第二句重点内容" },
      { from: 90, to: 120, content: "第三句关键节点" }
    ]);
    clipState.setSubtitleFetchState("ready");
    clipState.setChapters([
      { title: "开篇简介", from: 0, to: 30, source: "player-view-points" },
      { title: "核心原理", from: 90, to: 180, source: "player-view-points" }
    ]);
  };

  await seedClipData();

  if (options.bootContentScript) {
    await import("../../../extension/entry/content.js");
    for (let i = 0; i < 16; i += 1) {
      await flushStyles();
      await flushTimersAndMicrotasks(50);
    }
  } else {
    const { bindRuntimeEvents, bindUrlChangeHandler } = await import("../../../extension/entry/message-handler.js");
    const { bindSettingsWatcher } = await import("../../../extension/reader/init-essentials.js");
    const { bindNormalPageStateGuard } = await import("../../../extension/reader/state.js");
    const { registerContentCapabilities } = await import("../../../extension/reader/reader-bus.js");
    const { getMergedSettings, saveSettings } = await import("../../../extension/core/settings-store.js");
    const { state } = await import("../../../extension/core/state.js");

    state.setSettings(await getMergedSettings());
    bindRuntimeEvents();
    bindSettingsWatcher();
    registerContentCapabilities({
      persistSettings: () => {
        void saveSettings(state.settings);
      }
    });
    bindNormalPageStateGuard();
    bindUrlChangeHandler();
  }
  await import("../../../extension/core/settings-snapshot.js");

  const dispatchMessage = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { dispatchContentScriptMessage } = await import("../../../extension/shared/messaging.js");
    let settled = false;
    let payload: Record<string, unknown> = { ok: false };
    const promise = new Promise<Record<string, unknown>>((resolve) => {
      const handled = dispatchContentScriptMessage(message as never, (resp) => {
        settled = true;
        payload = (resp ?? { ok: true }) as Record<string, unknown>;
        resolve(payload);
      });
      if (!handled && !settled) {
        settled = true;
        resolve({ ok: false, unhandled: true });
      }
    });
    let ticks = 0;
    while (!settled && ticks < 120) {
      ticks += 1;
      await flushStyles();
      await flushTimersAndMicrotasks(50);
    }
    return await promise;
  };

  const getActiveHostDocument = async (): Promise<Document> => {
    try {
      const activeHost = await loadActiveHostContract();
      return activeHost.getActiveReaderDocument();
    } catch {
    }
    const activeWin = fakePlatform.getCurrentActiveChild();
    return activeWin ? activeWin.document : document;
  };

  const getReadingView = async (): Promise<HTMLElement | null> => {
    const activeDoc = await getActiveHostDocument();
    return activeDoc.getElementById("biliscript-reading-view") ?? document.getElementById("biliscript-reading-view");
  };

  const openReaderInPage = async () => {
    await dispatchMessage({
      type: "reader-enter",
      readerUrl: `${location.origin}${location.pathname}?biliscript_reader=1`
    });
    await flushStyles();
    await flushTimersAndMicrotasks(50);
  };

  const attemptDetachReader = async (): Promise<FakeDetachedWindow | null> => {
    const doc = await getActiveHostDocument();
    const detachBtn = doc.getElementById(EXPECTED_DETACH_BTN_ID);
    if (!detachBtn) {
      throw new Error(`Missing detach button #${EXPECTED_DETACH_BTN_ID}`);
    }
    detachBtn.click();
    await flushStyles();
    await flushTimersAndMicrotasks(50);
    return fakePlatform.getCurrentActiveChild();
  };

  const detachReader = async (): Promise<FakeDetachedWindow> => {
    const child = await attemptDetachReader();
    if (!child) {
      throw new Error("Expected detached FakeDetachedWindow after clicking detach button");
    }
    return child;
  };

  const redockReader = async () => {
    const shell = await loadShellContract();
    await shell.redockReaderShell();
    await flushStyles();
    await flushTimersAndMicrotasks(50);
  };

  const openSettingsInActiveHost = async (): Promise<Document> => {
    const doc = await getActiveHostDocument();
    const settingsBtn = doc.getElementById("biliscript-reading-settings-btn");
    if (!settingsBtn) {
      throw new Error("Missing #biliscript-reading-settings-btn in active host document");
    }
    settingsBtn.click();
    let ticks = 0;
    while (!doc.getElementById("biliscriptSettingsResetBtn") && ticks < 40) {
      ticks += 1;
      await flushStyles([doc]);
      await flushTimersAndMicrotasks(25);
    }
    return doc;
  };

  const switchTabInActiveHost = async (tab: "subtitle" | "overview" | "chat"): Promise<Document> => {
    const doc = await getActiveHostDocument();
    const tabIdMap = {
      subtitle: "biliscript-reading-tab-subtitle",
      overview: "biliscript-reading-tab-overview",
      chat: "biliscript-reading-tab-chat"
    } as const;
    const btn = doc.getElementById(tabIdMap[tab]);
    if (!btn) {
      throw new Error(`Missing tab button #${tabIdMap[tab]}`);
    }
    btn.click();
    await flushStyles([doc]);
    await flushTimersAndMicrotasks(50);
    return doc;
  };

  const clickHeaderCloseInActiveHost = async () => {
    const doc = await getActiveHostDocument();
    const closeBtn = doc.getElementById("biliscript-reading-close-btn");
    if (!closeBtn) {
      throw new Error("Missing #biliscript-reading-close-btn");
    }
    closeBtn.click();
    await flushTimersAndMicrotasks(450);
  };

  const clickHeaderThemeInActiveHost = async () => {
    const doc = await getActiveHostDocument();
    const themeBtn = doc.getElementById("biliscript-reading-theme-select");
    if (!themeBtn) {
      throw new Error("Missing #biliscript-reading-theme-select");
    }
    themeBtn.click();
    await flushTimersAndMicrotasks(50);
  };

  const triggerSpaNavigation = async (
    nextUrl: string,
    nextClip?: { bvid?: string; cid?: string; title?: string; subtitleText?: string }
  ) => {
    setLocationUrl(nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
    await flushTimersAndMicrotasks(20);
    if (nextClip) {
      const { clipState } = await import("../../../extension/core/state.js");
      clipState.setFetchRunId(clipState.fetchRunId + 1);
      await seedClipData(nextClip);
      const { notifyReaderPresenter } = await import("../../../extension/reader/reader-bus.js");
      notifyReaderPresenter({ kind: "subtitle-ready" });
    }
    await flushStyles();
    await flushTimersAndMicrotasks(150);
  };

  const toggleWebpageFullscreen = async (fullscreen: boolean) => {
    const container = document.querySelector(".bpx-player-container");
    container?.setAttribute("data-screen", fullscreen ? "web" : "normal");
    document.dispatchEvent(new Event("fullscreenchange"));
    await flushTimersAndMicrotasks(50);
  };

  const dismissOpenUiState = async () => {
    const docsToDismiss: Document[] = [document];
    for (const win of fakePlatform.openedWindows) {
      if (!win.closed && win.document) {
        docsToDismiss.push(win.document);
      }
    }
    for (const doc of docsToDismiss) {
      for (let i = 0; i < 4; i += 1) {
        try {
          doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        } catch {
        }
      }
      const modalHosts = doc.querySelectorAll(
        '[data-panel-modal-host="1"], .confirm-dialog-host, .biliscript-quote-share-host, .custom-select-dropdown, #biliscript-reading-explain-card, #biliscript-command-palette'
      );
      for (const el of Array.from(modalHosts)) {
        try {
          el.remove();
        } catch {
        }
      }
    }
    await Promise.resolve();
    await Promise.resolve();
  };

  const cleanup = async () => {
    await dismissOpenUiState();
    await storage.drain();
    for (const observer of trackedObservers) {
      try {
        observer.disconnect();
      } catch {
      }
    }
    trackedObservers.clear();
    for (const win of fakePlatform.openedWindows) {
      win.closed = true;
    }
    fakePlatform.restore();
    if (originalPushStateDesc) {
      Object.defineProperty(history, "pushState", originalPushStateDesc);
    } else {
      Reflect.deleteProperty(history, "pushState");
    }
    if (originalReplaceStateDesc) {
      Object.defineProperty(history, "replaceState", originalReplaceStateDesc);
    } else {
      Reflect.deleteProperty(history, "replaceState");
    }
    if (originalFullscreenDesc) {
      Object.defineProperty(document, "fullscreenElement", originalFullscreenDesc);
    } else {
      Reflect.deleteProperty(document, "fullscreenElement");
    }
    if (originalWebkitFullscreenDesc) {
      Object.defineProperty(document, "webkitFullscreenElement", originalWebkitFullscreenDesc);
    } else {
      Reflect.deleteProperty(document, "webkitFullscreenElement");
    }
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    for (const attr of Array.from(document.documentElement.attributes)) {
      document.documentElement.removeAttribute(attr.name);
    }
    for (const [name, value] of originalHtmlAttrs) {
      document.documentElement.setAttribute(name, value);
    }
    for (const attr of Array.from(document.body.attributes)) {
      document.body.removeAttribute(attr.name);
    }
    for (const [name, value] of originalBodyAttrs) {
      document.body.setAttribute(name, value);
    }
    document.body.className = originalBodyClassName;
    document.documentElement.className = originalDocElementClassName;
    try {
      window.localStorage?.clear?.();
    } catch {
    }
    listenerTracker.removeTrackedListeners();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    listenerTracker.restoreTargetMethods();
    vi.unstubAllGlobals();
  };

  return {
    fakePlatform,
    storage,
    video,
    videoPlaySpy,
    openerFocusSpy: fakePlatform.openerFocusSpy,
    flushStyles,
    flushTimersAndMicrotasks,
    dispatchMessage,
    openReaderInPage,
    detachReader,
    attemptDetachReader,
    redockReader,
    openSettingsInActiveHost,
    switchTabInActiveHost,
    clickHeaderCloseInActiveHost,
    clickHeaderThemeInActiveHost,
    triggerSpaNavigation,
    toggleWebpageFullscreen,
    seedClipData,
    getActiveHostDocument,
    getReadingView,
    cleanup
  };
}

export async function switchDetachedModeInSettings(
  harness: DetachedE2EHarness,
  mode: DetachedWindowMode
): Promise<Document> {
  const doc = await harness.openSettingsInActiveHost();
  const appearancePage = doc.getElementById("biliscriptSettingsSubpageAppearance");
  if (appearancePage?.hidden !== false) {
    doc.getElementById("openAppearanceBtn")?.click();
    await harness.flushTimersAndMicrotasks(60);
  }
  const select = doc.getElementById("detachedWindowMode") as HTMLSelectElement | null;
  if (!select) {
    throw new Error("Missing #detachedWindowMode select control in settings");
  }
  const wrapper = select.closest(".custom-select-wrapper");
  const trigger = wrapper?.querySelector<HTMLElement>(".custom-select-trigger");
  const option = wrapper?.querySelector<HTMLElement>(`.custom-select-option[data-value="${mode}"]`);
  if (trigger && option) {
    trigger.click();
    await harness.flushTimersAndMicrotasks(20);
    option.click();
  } else {
    select.value = mode;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await harness.flushStyles([doc]);
  await harness.flushTimersAndMicrotasks(80);
  return doc;
}
