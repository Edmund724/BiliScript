import { vi } from "vitest";
import {
  clearSharedSlots,
  NORMAL_PAGE_URL,
  resetModuleState,
  setLocationUrl,
  setupEnvironment
} from "../../setup.js";
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
import type { TypedEventBus } from "../../../extension/shared/typed-event-bus.js";
import type { ContentEventMap } from "../../../extension/shared/content-event-bus.js";

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

interface ActiveHostSlotSnapshot {
  doc: Document | null;
  win: Window | null;
  seq: number;
  listeners: Set<unknown>;
  modeSwitchHandler: unknown;
}

interface ReaderBusSlotSnapshot {
  readers: unknown[];
  handlers: Record<string, unknown>;
  warnedMissing: Set<unknown>;
}

interface StateBundleSlotSnapshot {
  readerState: unknown;
  clipState: unknown;
  uiState: unknown;
  state: unknown;
  sessionBoundaryHooks: Set<unknown>;
}

interface EventBusSlotSnapshot {
  bus: TypedEventBus<ContentEventMap>;
  lastSubtitleStatusPhase: string;
  clipScope: { dispose: () => void; isDisposed: () => boolean };
}

interface WarmedModules {
  defaults: typeof import("../../../extension/core/defaults.js");
  coreState: typeof import("../../../extension/core/state.js");
  settingsStore: typeof import("../../../extension/core/settings-store.js");
  settingsSnapshot: typeof import("../../../extension/core/settings-snapshot.js");
  aiProviderStore: typeof import("../../../extension/core/ai-provider-store.js");
  providerHandlers: typeof import("../../../extension/core/provider-handlers.js");
  activeHost: typeof import("../../../extension/shared/active-host.js");
  messaging: typeof import("../../../extension/shared/messaging.js");
  contentEventBus: typeof import("../../../extension/shared/content-event-bus.js");
  watchStorageKeys: typeof import("../../../extension/shared/watch-storage-keys.js");
  typedEventBus: typeof import("../../../extension/shared/typed-event-bus.js");
  shell: typeof import("../../../extension/reader/shell.js");
  lifecycle: typeof import("../../../extension/reader/lifecycle.js");
  readerState: typeof import("../../../extension/reader/state.js");
  readerBus: typeof import("../../../extension/reader/reader-bus.js");
  initEssentials: typeof import("../../../extension/reader/init-essentials.js");
  commandPalette: typeof import("../../../extension/reader/command-palette.js");
  subtitleTabUi: typeof import("../../../extension/reader/subtitle-tab-ui.js");
  subtitleHighlightsUi: typeof import("../../../extension/reader/subtitle-highlights-ui.js");
  settingsMode: typeof import("../../../extension/reader/settings-mode.js");
  chatDisplaySettings: typeof import("../../../extension/reader/chat-display-settings.js");
  lazyChatTab: typeof import("../../../extension/reader/lazy-chat-tab.js");
  lazyPlayerAi: typeof import("../../../extension/ai/lazy-player-ai.js");
  playerAiState: typeof import("../../../extension/ai/player-ai-state.js");
  subtitleCore: typeof import("../../../extension/subtitle/core.js");
  subtitleLazy: typeof import("../../../extension/subtitle/lazy.js");
  uiRenderer: typeof import("../../../extension/ui/ui-renderer.js");
  settingsPanel: typeof import("../../../extension/ui/settings-panel.js");
  scalarEngine: typeof import("../../../extension/ui/settings/scalar-engine.js");
  customSelect: typeof import("../../../extension/ui/custom-select.js");
  themeButton: typeof import("../../../extension/ui/theme-button.js");
  messageHandler: typeof import("../../../extension/entry/message-handler.js");
}

interface ListenerTracker {
  removeTrackedListeners: () => void;
  restoreTargetMethods: () => void;
}

interface WarmedRuntime {
  modules: WarmedModules;
  stateBundle: StateBundleSlotSnapshot;
  baselineSessionBoundaryHooks: unknown[];
  baselineActiveHostListeners: unknown[];
  baselineModeSwitchHandler: unknown;
  baselineReaderBusReaders: unknown[];
  baselineReaderBusHandlers: Record<string, unknown>;
  baselineEventBus: TypedEventBus<ContentEventMap>;
  wrappedEventBus: TypedEventBus<ContentEventMap>;
  warmListenerTracker: ListenerTracker;
  warmOriginalPushStateDesc: PropertyDescriptor | undefined;
  warmOriginalReplaceStateDesc: PropertyDescriptor | undefined;
}

let storageWatchPhase: "off" | "warm" | "test" = "off";
const warmStorageWatchUnsubs = new Set<() => void>();
const dynamicStorageWatchUnsubs = new Set<() => void>();
let trackDynamicEventBusListeners = false;
const dynamicEventBusUnsubs = new Set<() => void>();
let watchStorageMockInstalled = false;
let warmedRuntime: WarmedRuntime | null = null;
let moduleGraphDirty = false;
let nextFetchRunBase = 0;

function installWatchStorageKeysTracker(): void {
  if (watchStorageMockInstalled) {
    return;
  }
  watchStorageMockInstalled = true;
  vi.doMock("../../../extension/shared/watch-storage-keys.js", async () => {
    const actual = await vi.importActual<typeof import("../../../extension/shared/watch-storage-keys.js")>(
      "../../../extension/shared/watch-storage-keys.js"
    );
    return {
      ...actual,
      watchStorageKeys(
        handler: Parameters<typeof actual.watchStorageKeys>[0],
        watch?: Parameters<typeof actual.watchStorageKeys>[1]
      ) {
        const unsub = actual.watchStorageKeys(handler, watch);
        const phase = storageWatchPhase;
        if (phase === "off") {
          return unsub;
        }
        const bucket = phase === "warm" ? warmStorageWatchUnsubs : dynamicStorageWatchUnsubs;
        const wrapped = () => {
          bucket.delete(wrapped);
          unsub();
        };
        bucket.add(wrapped);
        return wrapped;
      }
    };
  });
}

function clearStorageWatcherBucket(bucket: Set<() => void>): void {
  for (const unsub of Array.from(bucket)) {
    try {
      unsub();
    } catch {
    }
  }
  bucket.clear();
}

function clearDynamicStorageWatchers(): void {
  storageWatchPhase = "off";
  clearStorageWatcherBucket(dynamicStorageWatchUnsubs);
}

function clearAllStorageWatchers(): void {
  storageWatchPhase = "off";
  clearStorageWatcherBucket(dynamicStorageWatchUnsubs);
  clearStorageWatcherBucket(warmStorageWatchUnsubs);
}

function clearDynamicEventBusListeners(): void {
  trackDynamicEventBusListeners = false;
  for (const unsub of Array.from(dynamicEventBusUnsubs)) {
    try {
      unsub();
    } catch {
    }
  }
  dynamicEventBusUnsubs.clear();
}

function ensureDomRuntimeDefaults(): void {
  if (typeof Element !== "undefined" && typeof Element.prototype.scrollIntoView !== "function") {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof window !== "undefined") {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
  }
  if (typeof Element !== "undefined") {
    const rect = Element.prototype.getBoundingClientRect as (() => DOMRect) & { __biliscriptDefaultPatched?: boolean };
    if (!rect.__biliscriptDefaultPatched) {
      const patched = function getBoundingClientRect() {
        return { x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 450, width: 800, height: 450, toJSON: () => ({}) };
      } as (() => DOMRect) & { __biliscriptDefaultPatched?: boolean };
      patched.__biliscriptDefaultPatched = true;
      Element.prototype.getBoundingClientRect = patched;
    }
  }
}

function teardownWarmedRuntime(): void {
  clearAllStorageWatchers();
  clearDynamicEventBusListeners();
  const current = warmedRuntime;
  warmedRuntime = null;
  if (!current) {
    return;
  }
  current.warmListenerTracker.removeTrackedListeners();
  current.warmListenerTracker.restoreTargetMethods();
  if (current.warmOriginalPushStateDesc) {
    Object.defineProperty(history, "pushState", current.warmOriginalPushStateDesc);
  } else {
    Reflect.deleteProperty(history, "pushState");
  }
  if (current.warmOriginalReplaceStateDesc) {
    Object.defineProperty(history, "replaceState", current.warmOriginalReplaceStateDesc);
  } else {
    Reflect.deleteProperty(history, "replaceState");
  }
}

async function isWarmedModuleIdentityIntact(): Promise<boolean> {
  if (!warmedRuntime) {
    return false;
  }
  const currentActiveHost = await import("../../../extension/shared/active-host.js");
  return currentActiveHost === warmedRuntime.modules.activeHost;
}

function wrapBaselineEventBus(baseBus: TypedEventBus<ContentEventMap>): TypedEventBus<ContentEventMap> {
  return {
    on(event, listener, options) {
      const unsub = baseBus.on(event, listener, options);
      if (!trackDynamicEventBusListeners) {
        return unsub;
      }
      const wrapped = () => {
        dynamicEventBusUnsubs.delete(wrapped);
        unsub();
      };
      dynamicEventBusUnsubs.add(wrapped);
      return wrapped;
    },
    once(event, listener, options) {
      const unsub = baseBus.once(event, listener, options);
      if (!trackDynamicEventBusListeners) {
        return unsub;
      }
      const wrapped = () => {
        dynamicEventBusUnsubs.delete(wrapped);
        unsub();
      };
      dynamicEventBusUnsubs.add(wrapped);
      return wrapped;
    },
    emit(event, ...args) {
      return (baseBus.emit as (ev: keyof ContentEventMap, ...rest: unknown[]) => void)(event, ...args);
    },
    listenerCount(event) {
      return baseBus.listenerCount(event);
    },
    clear() {
      baseBus.clear();
    }
  };
}

export async function warmDetachedE2eRuntime(): Promise<WarmedRuntime> {
  if (warmedRuntime && !moduleGraphDirty && (await isWarmedModuleIdentityIntact())) {
    return warmedRuntime;
  }

  teardownWarmedRuntime();
  moduleGraphDirty = false;
  resetModuleState();
  installWatchStorageKeysTracker();
  storageWatchPhase = "warm";
  trackDynamicEventBusListeners = false;

  vi.useFakeTimers();
  const warmOriginalPushStateDesc = Object.getOwnPropertyDescriptor(history, "pushState");
  const warmOriginalReplaceStateDesc = Object.getOwnPropertyDescriptor(history, "replaceState");
  const warmListenerTracker = installEventListenerTracker([window, document]);

  const [
    defaults,
    coreState,
    settingsStore,
    settingsSnapshot,
    aiProviderStore,
    providerHandlers,
    activeHost,
    messaging,
    contentEventBus,
    watchStorageKeys,
    typedEventBus,
    shell,
    lifecycle,
    readerState,
    readerBus,
    initEssentials,
    commandPalette,
    subtitleTabUi,
    subtitleHighlightsUi,
    settingsMode,
    chatDisplaySettings,
    lazyChatTab,
    lazyPlayerAi,
    playerAiState,
    subtitleCore,
    subtitleLazy,
    uiRenderer,
    settingsPanel,
    scalarEngine,
    customSelect,
    themeButton,
    messageHandler
  ] = await Promise.all([
    import("../../../extension/core/defaults.js"),
    import("../../../extension/core/state.js"),
    import("../../../extension/core/settings-store.js"),
    import("../../../extension/core/settings-snapshot.js"),
    import("../../../extension/core/ai-provider-store.js"),
    import("../../../extension/core/provider-handlers.js"),
    import("../../../extension/shared/active-host.js"),
    import("../../../extension/shared/messaging.js"),
    import("../../../extension/shared/content-event-bus.js"),
    import("../../../extension/shared/watch-storage-keys.js"),
    import("../../../extension/shared/typed-event-bus.js"),
    import("../../../extension/reader/shell.js"),
    import("../../../extension/reader/lifecycle.js"),
    import("../../../extension/reader/state.js"),
    import("../../../extension/reader/reader-bus.js"),
    import("../../../extension/reader/init-essentials.js"),
    import("../../../extension/reader/command-palette.js"),
    import("../../../extension/reader/subtitle-tab-ui.js"),
    import("../../../extension/reader/subtitle-highlights-ui.js"),
    import("../../../extension/reader/settings-mode.js"),
    import("../../../extension/reader/chat-display-settings.js"),
    import("../../../extension/reader/lazy-chat-tab.js"),
    import("../../../extension/ai/lazy-player-ai.js"),
    import("../../../extension/ai/player-ai-state.js"),
    import("../../../extension/subtitle/core.js"),
    import("../../../extension/subtitle/lazy.js"),
    import("../../../extension/ui/ui-renderer.js"),
    import("../../../extension/ui/settings-panel.js"),
    import("../../../extension/ui/settings/scalar-engine.js"),
    import("../../../extension/ui/custom-select.js"),
    import("../../../extension/ui/theme-button.js"),
    import("../../../extension/entry/message-handler.js")
  ]);

  await Promise.all([
    import("../../../extension/reader/script-tab-activation.js"),
    import("../../../extension/reader/lazy-shell.js").then((m) => m.ensureReaderShell()),
    import("../../../extension/reader/lazy-reader.js").then((m) => m.ensureReaderDomain()),
    import("../../../extension/ui/lazy-ui.js"),
    subtitleLazy.ensureSummarizeChain()
  ]);

  initEssentials.bindSettingsWatcher();
  messageHandler.bindUrlChangeHandler();
  storageWatchPhase = "off";

  vi.clearAllTimers();
  vi.useRealTimers();
  warmListenerTracker.restoreTargetMethods();

  const slots = globalThis as unknown as Record<string, unknown>;
  const stateBundle = slots.__BILISCRIPT_STATE__ as StateBundleSlotSnapshot;
  const activeHostSlot = slots.__BILISCRIPT_ACTIVE_HOST__ as ActiveHostSlotSnapshot | undefined;
  const readerBusSlot = slots.__BILISCRIPT_READER_BUS__ as ReaderBusSlotSnapshot | undefined;
  const eventBusSlot = slots.__BILISCRIPT_EVENT_BUS__ as EventBusSlotSnapshot | undefined;
  const baselineEventBus = eventBusSlot?.bus ?? typedEventBus.createTypedEventBus<ContentEventMap>();

  warmedRuntime = {
    modules: {
      defaults,
      coreState,
      settingsStore,
      settingsSnapshot,
      aiProviderStore,
      providerHandlers,
      activeHost,
      messaging,
      contentEventBus,
      watchStorageKeys,
      typedEventBus,
      shell,
      lifecycle,
      readerState,
      readerBus,
      initEssentials,
      commandPalette,
      subtitleTabUi,
      subtitleHighlightsUi,
      settingsMode,
      chatDisplaySettings,
      lazyChatTab,
      lazyPlayerAi,
      playerAiState,
      subtitleCore,
      subtitleLazy,
      uiRenderer,
      settingsPanel,
      scalarEngine,
      customSelect,
      themeButton,
      messageHandler
    },
    stateBundle,
    baselineSessionBoundaryHooks: Array.from(stateBundle.sessionBoundaryHooks ?? []),
    baselineActiveHostListeners: Array.from(activeHostSlot?.listeners ?? []),
    baselineModeSwitchHandler: activeHostSlot?.modeSwitchHandler ?? null,
    baselineReaderBusReaders: [...(readerBusSlot?.readers ?? [])],
    baselineReaderBusHandlers: { ...(readerBusSlot?.handlers ?? {}) },
    baselineEventBus,
    wrappedEventBus: wrapBaselineEventBus(baselineEventBus),
    warmListenerTracker,
    warmOriginalPushStateDesc,
    warmOriginalReplaceStateDesc
  };

  delete slots.__BILISCRIPT_STYLE_INJECTOR__;
  delete slots.__BILISCRIPT_EVENT_BUS__;
  document.head.innerHTML = "";
  document.body.innerHTML = "";

  return warmedRuntime;
}

function resetWarmedStateBeforeTest(runtime: WarmedRuntime, targetUrl: string): void {
  const { modules } = runtime;
  const slots = globalThis as unknown as Record<string, unknown>;

  clearSharedSlots();

  slots.__BILISCRIPT_STATE__ = runtime.stateBundle;
  slots.__BILISCRIPT_ACTIVE_HOST__ = {
    doc: null,
    win: null,
    seq: 0,
    listeners: new Set(runtime.baselineActiveHostListeners),
    modeSwitchHandler: runtime.baselineModeSwitchHandler
  };
  slots.__BILISCRIPT_READER_BUS__ = {
    readers: [...runtime.baselineReaderBusReaders],
    handlers: { ...runtime.baselineReaderBusHandlers },
    warnedMissing: new Set()
  };

  runtime.stateBundle.sessionBoundaryHooks.clear();
  for (const hook of runtime.baselineSessionBoundaryHooks) {
    runtime.stateBundle.sessionBoundaryHooks.add(hook);
  }

  const { state, clipState, uiState } = modules.coreState;
  state.setSettings({ ...modules.defaults.DEFAULT_SETTINGS });

  state.reader.readingShellState = "closed";
  state.reader.setDetachedMode(null);
  state.reader.setTheme("light");
  state.reader.setThemeMode("bilibili");
  state.reader.setPalette("flyme");
  state.reader.setSettingsExpanded(false);
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
  state.reader.setNextScrollBehavior("smooth");
  state.reader.readingVideoEl = null;
  state.reader.readingDocumentClickBound = false;
  state.reader.setViewReady(false);

  nextFetchRunBase += 100;
  clipState.setCurrentUrl(targetUrl);
  clipState.setFetchRunId(nextFetchRunBase);
  const clipVersionTarget = clipState as unknown as { acquisitionVersion: number; processingVersion: number };
  clipVersionTarget.acquisitionVersion = 0;
  clipVersionTarget.processingVersion = 0;
  clipState.setBvid("");
  clipState.setAid("");
  clipState.setCid("");
  clipState.setCidSource("");
  clipState.setPageIndex(1);
  clipState.setPageCount(0);
  clipState.setPageTitle("");
  clipState.setVideoDuration(0);
  clipState.setDescription("");
  clipState.setTitle("");
  clipState.setAuthor("");
  clipState.setUploadDate("");
  clipState.setSubtitles([]);
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  clipState.setSubtitleFetchState("idle");
  clipState.setNoSubtitleReason(null);
  clipState.setNoSubtitleDetail("");
  clipState.clearSecondarySubtitle();
  clipState.setChapters([]);
  clipState.setHotComments([]);
  clipState.setHotCommentsNotice("");
  clipState.setMarkdown("");
  clipState.setSrt("");
  clipState.setTxt("");
  clipState.setCurrentClipSignature("");

  uiState.setEventsBound(false);
  uiState.setRuntimeEventsBound(false);
  uiState.setSettingsWatcherBound(true);
  uiState.setNormalPageStateGuardBound(false);
  uiState.setUrlWatcherStarted(true);
  uiState.setStatusText("准备就绪，点击“刷新抓取”开始。");

  modules.settingsSnapshot.invalidate(
    modules.settingsSnapshot.SNAPSHOT_STORAGE_KEYS.map((entry) => entry.key)
  );
  modules.shell.resetDetachedShellStateForTests();
  modules.commandPalette.disposeCommandPalette();
  modules.subtitleTabUi.unbindSubtitleTabEvents();
  modules.subtitleHighlightsUi.syncSubtitleHighlightsCache("", []);
  modules.chatDisplaySettings.clearChatDisplaySettingsListenersForTests();
  modules.readerState.setReaderActiveScriptTab("subtitle");
  modules.settingsMode.registerReaderSettingsBackInterceptor(null);
  modules.settingsMode.registerReaderSettingsCloseListener(null);
  modules.scalarEngine.clearStatusClearTimer();
  modules.playerAiState.suppressUntil(0);
  modules.subtitleCore.invalidateDerived();
  modules.lifecycle.resetReaderOverviewState();
  modules.lifecycle.clearReadingSubtitleSearch();
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
  modules?: WarmedModules | null;
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
    const cached = options.modules ?? null;
    if (type === "get-settings") {
      const settingsStore = cached?.settingsStore ?? (await import("../../../extension/core/settings-store.js"));
      return { ok: true, settings: await settingsStore.getMergedSettings() };
    }
    if (type === "save-settings") {
      const settingsStore = cached?.settingsStore ?? (await import("../../../extension/core/settings-store.js"));
      const settingsSnapshot = cached?.settingsSnapshot ?? (await import("../../../extension/core/settings-snapshot.js"));
      try {
        const settingsPayload = (message.settings ?? {}) as Record<string, unknown>;
        await settingsStore.saveSettings(settingsPayload);
        await settingsSnapshot.invalidate(Object.keys(settingsPayload));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }
    if (type === "player-ai-quick-action") {
      const messaging = cached?.messaging ?? (await import("../../../extension/shared/messaging.js"));
      const prompt = typeof message.prompt === "string" ? message.prompt : "";
      return await new Promise((resolve) => {
        messaging.dispatchContentScriptMessage(
          { type: "reader-enter", readerUrl: "", chat: { prompt } },
          (resp) => resolve(resp ?? { ok: true })
        );
      });
    }
    if (type === "ai-providers-list") {
      const aiProviderStore = cached?.aiProviderStore ?? (await import("../../../extension/core/ai-provider-store.js"));
      const providerHandlers = cached?.providerHandlers ?? (await import("../../../extension/core/provider-handlers.js"));
      const handlers = providerHandlers.createProviderMessageHandlers({
        loadProviders: () => aiProviderStore.aiProviderStore.loadProviders(),
        saveProviders: (items) => aiProviderStore.aiProviderStore.saveProviders(items),
        deleteProvider: (providerId) => aiProviderStore.aiProviderStore.deleteProvider(providerId),
        loadKeys: () => aiProviderStore.aiProviderStore.loadKeys()
      });
      return await new Promise((resolve) => {
        handlers.list(message, {}, resolve);
      });
    }
    if (type === "resolve-ai-provider") {
      const aiProviderStore = cached?.aiProviderStore ?? (await import("../../../extension/core/ai-provider-store.js"));
      const providerHandlers = cached?.providerHandlers ?? (await import("../../../extension/core/provider-handlers.js"));
      const settingsSnapshot = cached?.settingsSnapshot ?? (await import("../../../extension/core/settings-snapshot.js"));
      const handler = providerHandlers.createAiResolvedProviderHandler({
        getMergedSettings: settingsSnapshot.getSettingsSnapshot,
        loadProviders: () => aiProviderStore.aiProviderStore.loadProviders(),
        loadKeys: () => aiProviderStore.aiProviderStore.loadKeys()
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
        if (msg.type === "fetch-json") {
          throw Object.assign(new Error("Stale refresh run"), { code: "STALE_RUN" });
        }
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

function installEventListenerTracker(targets: EventTarget[]): ListenerTracker {
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
  const targetUrl = options.url ?? NORMAL_PAGE_URL;
  const isContentScriptBoot = Boolean(options.bootContentScript);
  let activeWarmed: WarmedRuntime | null = null;

  if (isContentScriptBoot) {
    teardownWarmedRuntime();
    moduleGraphDirty = true;
    resetModuleState();
    installWatchStorageKeysTracker();
    storageWatchPhase = "test";
  } else {
    activeWarmed = await warmDetachedE2eRuntime();
    vi.useRealTimers();
    setupEnvironment();
    ensureDomRuntimeDefaults();
    resetWarmedStateBeforeTest(activeWarmed, targetUrl);
  }

  vi.useFakeTimers();
  const listenerTracker = installEventListenerTracker([window, document]);
  const originalPushStateDesc = isContentScriptBoot ? Object.getOwnPropertyDescriptor(history, "pushState") : undefined;
  const originalReplaceStateDesc = isContentScriptBoot ? Object.getOwnPropertyDescriptor(history, "replaceState") : undefined;
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

  setLocationUrl(targetUrl);
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
    initialLocal: options.local,
    modules: activeWarmed?.modules ?? null
  });

  if (activeWarmed) {
    storageWatchPhase = "off";
    activeWarmed.modules.watchStorageKeys.watchStorageKeys(() => {})();
    storageWatchPhase = "test";

    const slots = globalThis as unknown as Record<string, unknown>;
    slots.__BILISCRIPT_EVENT_BUS__ = {
      bus: activeWarmed.wrappedEventBus,
      lastSubtitleStatusPhase: "",
      clipScope: activeWarmed.modules.typedEventBus.createDisposableContext()
    };
    trackDynamicEventBusListeners = true;
  }

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
    const { clipState } = activeWarmed
      ? activeWarmed.modules.coreState
      : await import("../../../extension/core/state.js");
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

  if (isContentScriptBoot) {
    await import("../../../extension/entry/content.js");
    for (let i = 0; i < 16; i += 1) {
      await flushStyles();
      await flushTimersAndMicrotasks(50);
    }
    await import("../../../extension/core/settings-snapshot.js");
  } else if (activeWarmed) {
    const { coreState, settingsStore, messageHandler, readerBus, readerState } = activeWarmed.modules;
    coreState.state.setSettings(await settingsStore.getMergedSettings());
    messageHandler.bindRuntimeEvents();
    readerBus.registerContentCapabilities({
      persistSettings: () => {
        void settingsStore.saveSettings(coreState.state.settings);
      }
    });
    readerState.bindNormalPageStateGuard();
  }

  const dispatchMessage = async (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { dispatchContentScriptMessage } = activeWarmed
      ? activeWarmed.modules.messaging
      : await import("../../../extension/shared/messaging.js");
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
      const activeHost = activeWarmed
        ? activeWarmed.modules.activeHost
        : await loadActiveHostContract();
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
    const shell = activeWarmed ? activeWarmed.modules.shell : await loadShellContract();
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
    const { contentEventBus, resetClipScope } = activeWarmed
      ? activeWarmed.modules.contentEventBus
      : await import("../../../extension/shared/content-event-bus.js");
    let switchStarted = false;
    let switchSettled = false;
    const unsubStart = contentEventBus.once("clip:switch-start", () => {
      switchStarted = true;
    });
    const unsubSettled = contentEventBus.once("clip:switch-settled", () => {
      switchSettled = true;
    });
    setLocationUrl(nextUrl);
    window.dispatchEvent(new PopStateEvent("popstate"));
    if (switchStarted) {
      let ticks = 0;
      while (!switchSettled && ticks < 40) {
        ticks += 1;
        await flushStyles();
        await flushTimersAndMicrotasks(20);
      }
    } else {
      await flushTimersAndMicrotasks(20);
    }
    unsubStart();
    unsubSettled();
    if (nextClip) {
      const { clipState } = activeWarmed
        ? activeWarmed.modules.coreState
        : await import("../../../extension/core/state.js");
      resetClipScope();
      clipState.setFetchRunId(clipState.fetchRunId + 1);
      await seedClipData(nextClip);
      const { notifyReaderPresenter } = activeWarmed
        ? activeWarmed.modules.readerBus
        : await import("../../../extension/reader/reader-bus.js");
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

  let cleanedUp = false;

  const cleanup = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    await dismissOpenUiState();

    if (activeWarmed) {
      const { modules } = activeWarmed;
      const identityIntact = await isWarmedModuleIdentityIntact();
      const loadedDirtyModule =
        !identityIntact ||
        modules.lazyChatTab.isReaderChatTabLoaded() ||
        modules.lazyPlayerAi.isPlayerAiLoaded() ||
        modules.contentEventBus.contentEventBus.listenerCount("reader:closed") > 0;
      if (loadedDirtyModule) {
        moduleGraphDirty = true;
      }

      if (identityIntact) {
        try {
          modules.customSelect.closeAllCustomSelects();
        } catch {
        }
        try {
          modules.coreState.state.reader.setThemeMode("__reset__");
          modules.themeButton.refreshThemeButton();
        } catch {
        }
        try {
          modules.lifecycle.closeReadingView();
        } catch {
        }
        try {
          modules.shell.resetDetachedShellStateForTests();
          modules.commandPalette.disposeCommandPalette();
          modules.subtitleTabUi.unbindSubtitleTabEvents();
          modules.chatDisplaySettings.clearChatDisplaySettingsListenersForTests();
          modules.settingsMode.registerReaderSettingsBackInterceptor(null);
          modules.settingsMode.registerReaderSettingsCloseListener(null);
          modules.scalarEngine.clearStatusClearTimer();
        } catch {
        }
      }
    }

    clearDynamicStorageWatchers();
    clearDynamicEventBusListeners();
    const slots = globalThis as unknown as Record<string, unknown>;
    const eventBusSlot = slots.__BILISCRIPT_EVENT_BUS__ as EventBusSlotSnapshot | undefined;
    eventBusSlot?.clipScope?.dispose?.();
    delete slots.__BILISCRIPT_EVENT_BUS__;

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
    if (isContentScriptBoot) {
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
    if (activeWarmed && !moduleGraphDirty) {
      try {
        activeWarmed.modules.customSelect.closeAllCustomSelects();
      } catch {
      }
    }
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
