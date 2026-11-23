export type DetachedWindowMode = "pip" | "popup";

export interface DetachedWindowBounds {
  width: number;
  height: number;
}

export interface ActiveHostContext {
  doc: Document;
  win: Window;
  detached: boolean;
}

export interface ActiveHostContract {
  getOpenerDocument(): Document;
  getOpenerWindow(): Window;
  getActiveReaderDocument(): Document;
  getActiveReaderWindow(): Window;
  isReaderDetached(): boolean;
  setActiveReaderHost(doc: Document, win: Window): void;
  resetActiveReaderHost(): void;
  onActiveHostChange(listener: (ctx: ActiveHostContext) => void): () => void;
  activeById<T extends HTMLElement = HTMLElement>(id: string): T | null;
}

export interface DetachedWindowOpenOptions {
  mode: DetachedWindowMode;
  bounds: DetachedWindowBounds;
  onExternalClose: () => void;
  onResizeBounds: (bounds: DetachedWindowBounds) => void;
}

export type DetachedWindowOpenResult =
  | { ok: true; window: Window; document: Document; actualMode: DetachedWindowMode }
  | { ok: false; reason: "blocked" | "unsupported" };

export interface DetachedWindowContract {
  openDetachedWindowHost(opts: DetachedWindowOpenOptions): Promise<DetachedWindowOpenResult>;
  closeDetachedWindowHost(intentional: boolean): void;
  focusDetachedWindowHost(): boolean;
  switchDetachedWindowHostMode(opts: DetachedWindowOpenOptions): Promise<DetachedWindowOpenResult>;
}

export interface DetachedBoundsStoreContract {
  DETACHED_WINDOW_BOUNDS_KEY: string;
  MIN_DETACHED_WINDOW_WIDTH: number;
  MIN_DETACHED_WINDOW_HEIGHT: number;
  clampDetachedWindowBounds(bounds: { width: unknown; height: unknown }): DetachedWindowBounds;
  resolveInitialDetachedWindowBounds(opts: {
    saved: DetachedWindowBounds | null;
    customPanelWidthEnabled: boolean;
    customPanelWidth: number;
    availHeight: number;
  }): DetachedWindowBounds;
  loadDetachedWindowBounds(): Promise<DetachedWindowBounds | null>;
  saveDetachedWindowBounds(bounds: { width: unknown; height: unknown }): Promise<DetachedWindowBounds>;
  resetDetachedWindowBounds(): Promise<void>;
}

export interface StyleInjectorContract {
  ensureReaderStyles(): Promise<void>;
  removeReaderStyles(): void;
  ensureReaderSettingsStyles(): void;
  whenReaderSettingsStylesReady(): Promise<void>;
  ensureReaderChatStyles(): void;
  ensureCustomSelectStyles(): void;
  ensureToggleSwitchStyles(): void;
  ensureBilingualSubtitleStyles(): void;
  syncStylesToDocument(targetDoc: Document): void;
  clearMirroredStyles(targetDoc: Document): void;
}

export interface DetachedShellContract {
  isReaderShellIntact(): boolean;
  enterReaderShell(options: {
    readerUrl: string;
    intent: "open" | "restore" | "chat";
    prompt?: string;
    settingsTarget?: string;
  }): Promise<void>;
  enterReaderShellOnUrlNavigation(options: { readerUrl: string }): Promise<void>;
  exitReaderShell(): Promise<void>;
  detachReaderShell(): Promise<boolean>;
  redockReaderShell(): Promise<boolean>;
  switchDetachedWindowMode(nextMode: DetachedWindowMode): Promise<boolean>;
}

export const EXPECTED_DETACH_BTN_ID = "biliscript-reading-detach-btn";
export const EXPECTED_BOUNDS_KEY = "biliscript_detached_window_bounds_v1";
export const EXPECTED_MIN_WIDTH = 360;
export const EXPECTED_MIN_HEIGHT = 420;
export const EXPECTED_DEFAULT_MODE: DetachedWindowMode = "pip";

async function loadExtensionModule<T>(subpath: string): Promise<T> {
  const specifier = `../../../extension/${subpath}.js`;
  const mod = (await import(specifier)) as Record<string, unknown>;
  return mod as unknown as T;
}

function requireExport<T extends object>(mod: T, keys: Array<keyof T>, label: string): T {
  for (const key of keys) {
    if ((mod as Record<PropertyKey, unknown>)[key] === undefined) {
      throw new Error(`Contract missing export "${String(key)}" in ${label}`);
    }
  }
  return mod;
}

export async function loadActiveHostContract(): Promise<ActiveHostContract> {
  const mod = await loadExtensionModule<ActiveHostContract>("shared/active-host");
  return requireExport(
    mod,
    [
      "getOpenerDocument",
      "getOpenerWindow",
      "getActiveReaderDocument",
      "getActiveReaderWindow",
      "isReaderDetached",
      "setActiveReaderHost",
      "resetActiveReaderHost",
      "onActiveHostChange",
      "activeById"
    ],
    "extension/shared/active-host.ts"
  );
}

export async function loadDetachedWindowContract(): Promise<DetachedWindowContract> {
  const mod = await loadExtensionModule<DetachedWindowContract>("reader/detached-window");
  return requireExport(
    mod,
    [
      "openDetachedWindowHost",
      "closeDetachedWindowHost",
      "focusDetachedWindowHost",
      "switchDetachedWindowHostMode"
    ],
    "extension/reader/detached-window.ts"
  );
}

export async function loadDetachedBoundsContract(): Promise<DetachedBoundsStoreContract> {
  const mod = await loadExtensionModule<DetachedBoundsStoreContract>("core/detached-bounds-store");
  return requireExport(
    mod,
    [
      "DETACHED_WINDOW_BOUNDS_KEY",
      "MIN_DETACHED_WINDOW_WIDTH",
      "MIN_DETACHED_WINDOW_HEIGHT",
      "clampDetachedWindowBounds",
      "resolveInitialDetachedWindowBounds",
      "loadDetachedWindowBounds",
      "saveDetachedWindowBounds",
      "resetDetachedWindowBounds"
    ],
    "extension/core/detached-bounds-store.ts"
  );
}

export async function loadStyleInjectorContract(): Promise<StyleInjectorContract> {
  const mod = await loadExtensionModule<StyleInjectorContract>("shared/style-injector");
  return requireExport(
    mod,
    [
      "ensureReaderStyles",
      "removeReaderStyles",
      "ensureReaderSettingsStyles",
      "whenReaderSettingsStylesReady",
      "ensureReaderChatStyles",
      "ensureCustomSelectStyles",
      "ensureToggleSwitchStyles",
      "ensureBilingualSubtitleStyles",
      "syncStylesToDocument",
      "clearMirroredStyles"
    ],
    "extension/shared/style-injector.ts"
  );
}

export async function loadShellContract(): Promise<DetachedShellContract> {
  const mod = await loadExtensionModule<DetachedShellContract>("reader/shell");
  return requireExport(
    mod,
    [
      "isReaderShellIntact",
      "enterReaderShell",
      "enterReaderShellOnUrlNavigation",
      "exitReaderShell",
      "detachReaderShell",
      "redockReaderShell",
      "switchDetachedWindowMode"
    ],
    "extension/reader/shell.ts"
  );
}
