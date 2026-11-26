import { type DetachedWindowMode } from "../core/defaults.js";
import { clampDetachedWindowBounds, type DetachedWindowBounds } from "../core/detached-bounds-store.js";
import {
  getActiveReaderDocument,
  getOpenerDocument,
  getOpenerWindow,
  resetActiveReaderHost
} from "../shared/active-host.js";
import { clearMirroredStyles } from "../shared/style-injector.js";

export type { DetachedWindowMode, DetachedWindowBounds };

export interface DetachedWindowOpenOptions {
  mode: DetachedWindowMode;
  bounds: DetachedWindowBounds;
  onExternalClose: () => void;
  onResizeBounds: (bounds: DetachedWindowBounds) => void;
}

export interface DetachedWindowHostOpenSuccess {
  ok: true;
  window: Window;
  document: Document;
  actualMode: DetachedWindowMode;
}

export type DetachedWindowOpenResult =
  | DetachedWindowHostOpenSuccess
  | { ok: false; reason: "blocked" | "unsupported" };

export interface DetachedWindowSwitchOptions extends DetachedWindowOpenOptions {
  beforeClosePrevious?: (next: DetachedWindowHostOpenSuccess) => void | Promise<void>;
}

export type DetachedWindowSwitchResult =
  | DetachedWindowHostOpenSuccess
  | { ok: false; reason: "blocked" };

export interface DetachedWindowHostSnapshot {
  window: Window;
  document: Document;
  actualMode: DetachedWindowMode;
}

interface DetachedWindowInstance {
  id: number;
  window: Window;
  document: Document;
  actualMode: DetachedWindowMode;
  windowName: string | null;
  intentionalClose: boolean;
  lastBounds: DetachedWindowBounds;
  resizeTimer: ReturnType<typeof setTimeout> | null;
  onExternalClose: () => void;
  onResizeBounds: (bounds: DetachedWindowBounds) => void;
  cleanupListeners: () => void;
}

interface CandidateHostSuccess {
  ok: true;
  window: Window;
  document: Document;
  actualMode: DetachedWindowMode;
  windowName: string | null;
}

type CandidateHostResult =
  | CandidateHostSuccess
  | { ok: false; reason: "blocked" | "unsupported" };

const POPUP_WINDOW_BASE_NAME = "biliscript-detached-reader";
const POPUP_WINDOW_ALT_NAME = "biliscript-detached-reader-alt";
const RESIZE_DEBOUNCE_MS = 200;

let activeInstance: DetachedWindowInstance | null = null;
let nextInstanceId = 0;
let latestOpenToken = 0;

function isWindowClosed(win: Window): boolean {
  try {
    return win.closed === true;
  } catch {
    return true;
  }
}

function readWindowDocument(win: Window): Document | null {
  try {
    const doc = win.document;
    if (!doc || typeof doc.createElement !== "function") {
      return null;
    }
    return doc;
  } catch {
    return null;
  }
}

function safeCloseWindow(win: Window): void {
  try {
    if (!isWindowClosed(win)) {
      win.close();
    }
  } catch {
  }
}

function clearInstanceTimer(instance: DetachedWindowInstance): void {
  if (instance.resizeTimer !== null) {
    globalThis.clearTimeout(instance.resizeTimer);
    instance.resizeTimer = null;
  }
}

function unwaiveWindow(win: Window): Window {
  const xpcWrap = (globalThis as unknown as { XPCNativeWrapper?: (obj: unknown) => Window }).XPCNativeWrapper;
  if (typeof xpcWrap === "function") {
    try {
      const wrapped = xpcWrap(win);
      if (wrapped && typeof wrapped === "object") {
        return wrapped;
      }
    } catch {
    }
  }
  return win;
}

function openPopupHost(
  bounds: DetachedWindowBounds,
  previousActive: DetachedWindowInstance | null
): CandidateHostResult {
  const openerWin = getOpenerWindow();
  const pageOpenerWin = (openerWin as unknown as { wrappedJSObject?: Window }).wrappedJSObject;
  const openTargetWin = pageOpenerWin && typeof pageOpenerWin.open === "function" ? pageOpenerWin : openerWin;
  if (typeof openTargetWin.open !== "function") {
    return { ok: false, reason: "unsupported" };
  }
  const targetName =
    previousActive?.actualMode === "popup" && previousActive.windowName === POPUP_WINDOW_BASE_NAME
      ? POPUP_WINDOW_ALT_NAME
      : POPUP_WINDOW_BASE_NAME;
  const features = `popup=yes,width=${bounds.width},height=${bounds.height},resizable=yes,scrollbars=yes`;
  let rawChildWin: Window | null = null;
  try {
    rawChildWin = openTargetWin.open("about:blank", targetName, features);
  } catch {
    return { ok: false, reason: "blocked" };
  }
  if (!rawChildWin) {
    return { ok: false, reason: "blocked" };
  }
  const childWin = openTargetWin === openerWin ? rawChildWin : unwaiveWindow(rawChildWin);
  if (
    childWin === openerWin ||
    childWin === openTargetWin ||
    rawChildWin === openTargetWin ||
    childWin === previousActive?.window ||
    isWindowClosed(childWin)
  ) {
    return { ok: false, reason: "blocked" };
  }
  const childDoc = readWindowDocument(childWin);
  if (!childDoc) {
    safeCloseWindow(childWin);
    return { ok: false, reason: "blocked" };
  }
  return {
    ok: true,
    window: childWin,
    document: childDoc,
    actualMode: "popup",
    windowName: targetName
  };
}

function openCandidateHost(
  mode: DetachedWindowMode,
  bounds: DetachedWindowBounds,
  allowPipFallback: boolean,
  previousActive: DetachedWindowInstance | null
): Promise<CandidateHostResult> {
  if (mode === "popup") {
    return Promise.resolve(openPopupHost(bounds, previousActive));
  }
  const openerWin = getOpenerWindow();
  let pipRequest: Promise<Window> | null = null;
  try {
    const pipApi = openerWin.documentPictureInPicture;
    if (pipApi && typeof pipApi.requestWindow === "function") {
      pipRequest = pipApi.requestWindow({
        width: bounds.width,
        height: bounds.height,
        disallowReturnToOpener: false
      });
    }
  } catch {
    pipRequest = null;
  }
  if (!pipRequest) {
    return Promise.resolve(
      allowPipFallback
        ? openPopupHost(bounds, previousActive)
        : { ok: false, reason: "blocked" }
    );
  }
  return Promise.resolve(pipRequest)
    .then((childWin): CandidateHostResult => {
      if (!childWin || childWin === openerWin || childWin === previousActive?.window || isWindowClosed(childWin)) {
        return allowPipFallback
          ? openPopupHost(bounds, previousActive)
          : { ok: false, reason: "blocked" };
      }
      const childDoc = readWindowDocument(childWin);
      if (!childDoc) {
        safeCloseWindow(childWin);
        return allowPipFallback
          ? openPopupHost(bounds, previousActive)
          : { ok: false, reason: "blocked" };
      }
      return {
        ok: true,
        window: childWin,
        document: childDoc,
        actualMode: "pip",
        windowName: null
      };
    })
    .catch((): CandidateHostResult => {
      return allowPipFallback
        ? openPopupHost(bounds, previousActive)
        : { ok: false, reason: "blocked" };
    });
}

function bindDetachedInstance(
  candidate: CandidateHostSuccess,
  opts: DetachedWindowOpenOptions,
  clampedBounds: DetachedWindowBounds
): DetachedWindowInstance {
  const openerWin = getOpenerWindow();
  const instance: DetachedWindowInstance = {
    id: ++nextInstanceId,
    window: candidate.window,
    document: candidate.document,
    actualMode: candidate.actualMode,
    windowName: candidate.windowName,
    intentionalClose: false,
    lastBounds: clampedBounds,
    resizeTimer: null,
    onExternalClose: opts.onExternalClose,
    onResizeBounds: opts.onResizeBounds,
    cleanupListeners: () => {}
  };

  const onChildPageHide = () => {
    if (activeInstance !== instance || instance.intentionalClose) {
      return;
    }
    ++latestOpenToken;
    clearInstanceTimer(instance);
    instance.cleanupListeners();
    activeInstance = null;
    instance.onExternalClose();
  };

  const onOpenerPageHide = () => {
    if (activeInstance !== instance) {
      return;
    }
    ++latestOpenToken;
    instance.intentionalClose = true;
    clearInstanceTimer(instance);
    instance.cleanupListeners();
    activeInstance = null;
    safeCloseWindow(instance.window);
  };

  const onChildResize = () => {
    if (activeInstance !== instance || instance.intentionalClose) {
      return;
    }
    clearInstanceTimer(instance);
    instance.resizeTimer = globalThis.setTimeout(() => {
      instance.resizeTimer = null;
      if (activeInstance !== instance || instance.intentionalClose || isWindowClosed(instance.window)) {
        return;
      }
      let width = instance.lastBounds.width;
      let height = instance.lastBounds.height;
      try {
        const innerW = Number(instance.window.innerWidth);
        const innerH = Number(instance.window.innerHeight);
        if (Number.isFinite(innerW) && innerW > 0) {
          width = innerW;
        }
        if (Number.isFinite(innerH) && innerH > 0) {
          height = innerH;
        }
      } catch {
      }
      const nextBounds = clampDetachedWindowBounds({ width, height });
      instance.lastBounds = nextBounds;
      instance.onResizeBounds(nextBounds);
    }, RESIZE_DEBOUNCE_MS);
  };

  instance.cleanupListeners = () => {
    try {
      instance.window.removeEventListener("pagehide", onChildPageHide);
    } catch {
    }
    try {
      instance.window.removeEventListener("resize", onChildResize);
    } catch {
    }
    try {
      openerWin.removeEventListener("pagehide", onOpenerPageHide);
    } catch {
    }
  };

  try {
    instance.window.addEventListener("pagehide", onChildPageHide);
    instance.window.addEventListener("resize", onChildResize, { passive: true });
    openerWin.addEventListener("pagehide", onOpenerPageHide);
  } catch {
  }

  return instance;
}

export async function openDetachedWindowHost(
  opts: DetachedWindowOpenOptions
): Promise<DetachedWindowOpenResult> {
  const clamped = clampDetachedWindowBounds(opts.bounds);
  const token = ++latestOpenToken;
  const candidate = await openCandidateHost(opts.mode, clamped, true, null);
  if (token !== latestOpenToken) {
    if (candidate.ok) {
      safeCloseWindow(candidate.window);
    }
    return { ok: false, reason: "blocked" };
  }
  if (!candidate.ok) {
    return candidate;
  }
  if (activeInstance) {
    const previous = activeInstance;
    previous.intentionalClose = true;
    clearInstanceTimer(previous);
    previous.cleanupListeners();
    activeInstance = null;
    if (previous.window !== candidate.window) {
      safeCloseWindow(previous.window);
    }
  }
  activeInstance = bindDetachedInstance(candidate, opts, clamped);
  return {
    ok: true,
    window: candidate.window,
    document: candidate.document,
    actualMode: candidate.actualMode
  };
}

export function closeDetachedWindowHost(intentional: boolean): void {
  ++latestOpenToken;
  const instance = activeInstance;
  if (!instance) {
    return;
  }
  clearInstanceTimer(instance);
  if (intentional) {
    instance.intentionalClose = true;
    instance.cleanupListeners();
    activeInstance = null;
    safeCloseWindow(instance.window);
    return;
  }
  safeCloseWindow(instance.window);
  if (activeInstance === instance) {
    instance.cleanupListeners();
    activeInstance = null;
    instance.onExternalClose();
  }
}

export function focusDetachedWindowHost(): boolean {
  const instance = activeInstance;
  if (!instance || isWindowClosed(instance.window)) {
    return false;
  }
  try {
    instance.window.focus();
    return true;
  } catch {
    return false;
  }
}

export async function switchDetachedWindowHostMode(
  opts: DetachedWindowSwitchOptions
): Promise<DetachedWindowSwitchResult> {
  const previous = activeInstance;
  if (!previous) {
    const result = await openDetachedWindowHost(opts);
    return result.ok ? result : { ok: false, reason: "blocked" };
  }
  const clamped = clampDetachedWindowBounds(opts.bounds);
  const allowPipFallback = previous.actualMode !== "popup";
  const token = ++latestOpenToken;
  const candidate = await openCandidateHost(opts.mode, clamped, allowPipFallback, previous);
  if (token !== latestOpenToken || activeInstance !== previous || isWindowClosed(previous.window)) {
    if (candidate.ok) {
      safeCloseWindow(candidate.window);
    }
    return { ok: false, reason: "blocked" };
  }
  if (!candidate.ok) {
    return { ok: false, reason: "blocked" };
  }
  const success: DetachedWindowHostOpenSuccess = {
    ok: true,
    window: candidate.window,
    document: candidate.document,
    actualMode: candidate.actualMode
  };
  try {
    await opts.beforeClosePrevious?.(success);
  } catch {
    safeCloseWindow(candidate.window);
    return { ok: false, reason: "blocked" };
  }
  if (token !== latestOpenToken || activeInstance !== previous || isWindowClosed(candidate.window)) {
    safeCloseWindow(candidate.window);
    return { ok: false, reason: "blocked" };
  }
  previous.intentionalClose = true;
  clearInstanceTimer(previous);
  previous.cleanupListeners();
  activeInstance = bindDetachedInstance(candidate, opts, clamped);
  if (previous.window !== candidate.window) {
    safeCloseWindow(previous.window);
  }
  return success;
}

export function getDetachedWindowHost(): DetachedWindowHostSnapshot | null {
  const instance = activeInstance;
  if (!instance || isWindowClosed(instance.window)) {
    return null;
  }
  return {
    window: instance.window,
    document: instance.document,
    actualMode: instance.actualMode
  };
}

export function syncDetachedWindowHostTitle(title: string): void {
  const instance = activeInstance;
  if (!instance || isWindowClosed(instance.window)) {
    return;
  }
  const normalized = String(title || "").trim();
  if (!normalized) {
    return;
  }
  try {
    if (instance.document && instance.document.title !== normalized) {
      instance.document.title = normalized;
    }
  } catch {
  }
}

export function formatDetachedWindowTitle(
  clipTitle?: string | null,
  fallbackDocTitle?: string | null
): string {
  const normalizedClip = String(clipTitle || "").trim();
  if (normalizedClip) {
    return `${normalizedClip} - 文摘`;
  }
  const normalizedDoc = String(fallbackDocTitle || "").trim();
  return normalizedDoc ? `${normalizedDoc} - 文摘` : "文摘";
}

export function applyDetachedHostDocumentAttrs(targetDoc: Document): void {
  try {
    targetDoc.documentElement?.setAttribute("data-biliscript-reader-mode", "1");
    targetDoc.documentElement?.setAttribute("data-biliscript-detached", "1");
    targetDoc.body?.setAttribute("data-biliscript-reader-mode", "1");
    targetDoc.body?.setAttribute("data-biliscript-reading-active", "1");
    targetDoc.body?.setAttribute("data-biliscript-detached", "1");
  } catch {
  }
}

export function clearDetachedHostDocument(targetDoc: Document): void {
  try {
    targetDoc.documentElement?.removeAttribute("data-biliscript-detached");
    targetDoc.documentElement?.removeAttribute("data-biliscript-reader-mode");
    targetDoc.body?.removeAttribute("data-biliscript-detached");
    targetDoc.body?.removeAttribute("data-biliscript-reader-mode");
    targetDoc.body?.removeAttribute("data-biliscript-reading-active");
  } catch {
  }
  clearMirroredStyles(targetDoc);
}

export function blurActiveFocusInside(container: HTMLElement | null): boolean {
  if (!container) {
    return false;
  }
  const ownerDoc = container.ownerDocument ?? getActiveReaderDocument();
  const active = ownerDoc.activeElement;
  const contained = Boolean(active && container.contains(active as Node));
  if (contained && typeof (active as HTMLElement | null)?.blur === "function") {
    (active as HTMLElement).blur();
  }
  const openerDoc = getOpenerDocument();
  if (contained && ownerDoc !== openerDoc) {
    const openerActive = openerDoc.activeElement as
      | (HTMLElement & { contentDocument?: Document | null })
      | null;
    if (openerActive?.contentDocument === ownerDoc && typeof openerActive.blur === "function") {
      openerActive.blur();
    }
  }
  return contained;
}

export function reclaimDetachedViewToOpener(options: {
  readingView: HTMLElement | null;
  rootId: string;
  detachedDoc?: Document | null;
}): HTMLElement | null {
  const openerDoc = getOpenerDocument();
  const targetDetachedDoc =
    options.detachedDoc ??
    (options.readingView && options.readingView.ownerDocument !== openerDoc
      ? options.readingView.ownerDocument
      : null);
  if (targetDetachedDoc && targetDetachedDoc !== openerDoc) {
    clearDetachedHostDocument(targetDetachedDoc);
  }
  let reclaimed = options.readingView;
  if (reclaimed) {
    reclaimed.removeAttribute("data-biliscript-detached");
    let root = openerDoc.getElementById(options.rootId);
    if (!root) {
      root = openerDoc.createElement("div");
      root.id = options.rootId;
      openerDoc.body.appendChild(root);
    }
    if (reclaimed.ownerDocument !== openerDoc || !root.contains(reclaimed)) {
      try {
        reclaimed = openerDoc.adoptNode(reclaimed) as HTMLElement;
      } catch {
      }
      root.appendChild(reclaimed);
    }
  }
  resetActiveReaderHost();
  return reclaimed;
}
