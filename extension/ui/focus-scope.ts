import { activeById, onActiveHostChange } from "../shared/active-host.js";
import {
  isHtmlElement,
  isNode,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
} from "../shared/cross-doc.js";
import { ids } from "../shared/dom-ids.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit,
  resolveTriggerElement
} from "./trigger-motion.js";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])"
].join(",");

export interface FocusScopeOptions {
  initialFocus?: HTMLElement | null;
  returnFocus?: HTMLElement | null;
  isActive?: () => boolean;
}

export interface FocusScope {
  dispose(restoreFocus?: boolean): void;
}

function isVisible(element: HTMLElement): boolean {
  try {
    if (element.hidden || element.closest("[hidden]")) return false;
    if (element.closest('[aria-hidden="true"]')) return false;
    for (let cur: HTMLElement | null = element; cur; cur = cur.parentElement) {
      if (cur.inert || cur.hasAttribute("inert")) return false;
    }
    const view = element.ownerDocument?.defaultView;
    if (!view) return true;
    if (view.closed) return false;
    const style = view.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  } catch {
    return false;
  }
}

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => element.tabIndex >= 0 && isVisible(element)
  );
}

function captureReturnTarget(
  explicit: HTMLElement | null | undefined,
  container?: HTMLElement | null
): HTMLElement | null {
  if (explicit) return explicit;
  const doc = resolveNodeDocument(container);
  const active = doc.activeElement;
  if (!isHtmlElement(active)) return null;
  if (active === doc.body || active === doc.documentElement) return null;
  return active;
}

export function isolateHostSiblings(host: HTMLElement): () => void {
  const parent = host.parentElement;
  if (!parent) return () => {};
  const isolated: HTMLElement[] = [];
  for (const child of Array.from(parent.children)) {
    if (!isHtmlElement(child) || child === host) continue;
    if (child.inert || child.hasAttribute("inert")) continue;
    child.inert = true;
    isolated.push(child);
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    for (const sibling of isolated) {
      sibling.inert = false;
    }
  };
}

export function createFocusScope(container: HTMLElement, options: FocusScopeOptions = {}): FocusScope {
  const isActive = options.isActive ?? (() => true);
  const returnTarget = captureReturnTarget(options.returnFocus, container);
  let disposed = false;

  const restore = (): void => {
    if (!isActive()) return;
    try {
      if (!returnTarget || !returnTarget.isConnected || !isVisible(returnTarget)) return;
      if ("disabled" in returnTarget && Boolean((returnTarget as HTMLButtonElement).disabled)) {
        return;
      }
      const targetWin = resolveNodeWindow(returnTarget);
      if (!targetWin || targetWin.closed) return;
      returnTarget.focus({ preventScroll: true });
    } catch {
    }
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!isActive() || event.key !== "Tab") return;
    const items = focusableWithin(container);
    if (items.length === 0) {
      event.preventDefault();
      container.focus({ preventScroll: true });
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = resolveNodeDocument(container).activeElement;
    if (event.shiftKey) {
      if (active === first || !container.contains(active)) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      }
      return;
    }
    if (active === last || !container.contains(active)) {
      event.preventDefault();
      first.focus({ preventScroll: true });
    }
  };

  const onFocusIn = (event: Event): void => {
    if (!isActive()) return;
    const target = event.target;
    if (isNode(target) && container.contains(target)) return;
    container.focus({ preventScroll: true });
  };

  let boundDoc = resolveNodeDocument(container);
  const bindToDoc = (doc: Document): void => {
    boundDoc = doc;
    boundDoc.addEventListener("keydown", onKeyDown, true);
    boundDoc.addEventListener("focusin", onFocusIn, true);
  };
  const unbindFromDoc = (): void => {
    safeRemoveListener(boundDoc, "keydown", onKeyDown, true);
    safeRemoveListener(boundDoc, "focusin", onFocusIn, true);
  };

  bindToDoc(boundDoc);
  const stopHostWatch = onActiveHostChange((ctx) => {
    if (disposed) return;
    unbindFromDoc();
    if (container.isConnected && container.ownerDocument === ctx.doc) {
      bindToDoc(ctx.doc);
    }
  });
  (options.initialFocus ?? container).focus({ preventScroll: true });

  return {
    dispose(restoreFocus = true): void {
      if (disposed) return;
      disposed = true;
      stopHostWatch();
      unbindFromDoc();
      if (restoreFocus) {
        restore();
      }
    }
  };
}

export type PanelModalDismissReason = "escape" | "outside-click";

export interface PanelModalShellOptions {
  hostClassName: string;
  html: string;
  dialogSelector: string;
  maskSelector?: string;
  mountHost?: HTMLElement | null;
  initialFocusSelector?: string;
  returnFocus?: HTMLElement | null;
  isTopLayer?: () => boolean;
  onRequestDismiss: (reason: PanelModalDismissReason) => void;
  onForceDismiss: () => void;
}

export interface PanelModalShell {
  host: HTMLElement;
  dialog: HTMLElement | null;
  dispose(restoreFocus?: boolean): void;
}

export function observeSettingsPanelHidden(onHidden: () => void): () => void {
  const panel = activeById(ids.readingSettingsPanel);
  if (!panel) {
    return () => {};
  }
  const win = resolveNodeWindow(panel) as Window & {
    MutationObserver?: typeof MutationObserver;
  };
  const Ctor =
    win?.MutationObserver ??
    (typeof MutationObserver === "function" ? MutationObserver : undefined);
  if (typeof Ctor !== "function") {
    return () => {};
  }
  const observer = new Ctor(() => {
    if (panel.hidden) {
      onHidden();
    }
  });
  observer.observe(panel, { attributes: true, attributeFilter: ["hidden"] });
  return () => {
    try {
      observer.disconnect();
    } catch {
    }
  };
}

export function mountPanelModalShell(options: PanelModalShellOptions): PanelModalShell {
  const mountHost = options.mountHost || activeById(ids.readingView);
  if (!mountHost) {
    throw new Error("Panel modal mount host not found");
  }
  const trigger = resolveTriggerElement(options.returnFocus);
  mountHost.querySelectorAll<HTMLElement>('[data-panel-modal-host="1"][data-biliscript-closing="1"]').forEach((el) => {
    if (el.querySelector(options.dialogSelector)) {
      cancelTriggerExit(el);
    }
  });
  const host = resolveNodeDocument(mountHost).createElement("div");
  host.className = options.hostClassName;
  host.dataset.panelModalHost = "1";
  host.innerHTML = options.html;
  mountHost.appendChild(host);

  const restoreSiblings = isolateHostSiblings(host);
  const isTopLayer = options.isTopLayer ?? (() => true);
  let disposed = false;

  host.addEventListener("click", (event) => {
    event.stopPropagation();
  });

  const onDocumentClickCapture = (event: MouseEvent): void => {
    if (disposed || !isTopLayer()) return;
    if (!host.isConnected) {
      options.onForceDismiss();
      return;
    }
    const view = host.parentElement || activeById(ids.readingView);
    if (view && isNode(event.target) && view.contains(event.target)) {
      return;
    }
    event.stopPropagation();
    options.onRequestDismiss("outside-click");
  };

  const onDocumentKeyDownCapture = (event: KeyboardEvent): void => {
    if (disposed || event.key !== "Escape" || !isTopLayer()) return;
    event.preventDefault();
    event.stopPropagation();
    options.onRequestDismiss("escape");
  };

  const mask = host.querySelector<HTMLElement>(options.maskSelector ?? ".confirm-dialog-mask");
  const dialog = host.querySelector<HTMLElement>(options.dialogSelector);
  const initialFocus =
    (options.initialFocusSelector ? host.querySelector<HTMLElement>(options.initialFocusSelector) : null) ??
    dialog;
  const focusScope = dialog
    ? createFocusScope(dialog, {
        initialFocus,
        returnFocus: options.returnFocus,
        isActive: isTopLayer
      })
    : null;

  if (dialog) {
    animateTriggerEnter({
      target: dialog,
      mask,
      trigger,
      fallbackOrigin: "top right",
      fromScale: 0.93,
      durationMs: 190
    });
  }

  let boundDoc = resolveNodeDocument(host);
  const bindToDoc = (doc: Document): void => {
    boundDoc = doc;
    boundDoc.addEventListener("click", onDocumentClickCapture, true);
    boundDoc.addEventListener("keydown", onDocumentKeyDownCapture, true);
  };
  const unbindFromDoc = (): void => {
    safeRemoveListener(boundDoc, "click", onDocumentClickCapture, true);
    safeRemoveListener(boundDoc, "keydown", onDocumentKeyDownCapture, true);
  };

  bindToDoc(boundDoc);
  const stopHostWatch = onActiveHostChange((ctx) => {
    if (disposed) return;
    unbindFromDoc();
    let sameHost = false;
    try {
      sameHost = Boolean(host.isConnected && host.ownerDocument === ctx.doc);
    } catch {
      sameHost = false;
    }
    if (sameHost) {
      bindToDoc(ctx.doc);
      return;
    }
    options.onForceDismiss();
  });
  const stopObservingHidden = observeSettingsPanelHidden(() => {
    if (!disposed) {
      options.onForceDismiss();
    }
  });

  return {
    host,
    dialog,
    dispose(restoreFocus = true): void {
      if (disposed) return;
      disposed = true;
      stopHostWatch();
      stopObservingHidden();
      unbindFromDoc();
      try {
        restoreSiblings();
      } catch {
      }
      try {
        focusScope?.dispose(restoreFocus);
      } catch {
      }
      if (dialog) {
        animateTriggerExit({
          target: dialog,
          host,
          mask,
          trigger,
          fallbackOrigin: "top right",
          toScale: 0.94,
          durationMs: 130,
          onFinish: () => {
            try {
              host.remove();
            } catch {
            }
          }
        });
      } else {
        try {
          host.remove();
        } catch {
        }
      }
    }
  };
}
