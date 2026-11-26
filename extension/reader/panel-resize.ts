import { DEFAULT_SETTINGS } from "../core/defaults.js";
import { state } from "../core/state.js";
import { CUSTOM_PANEL_WIDTH_MIN } from "../core/validators.js";
import { isReaderDetached } from "../shared/active-host.js";
import { logWarn } from "../shared/logging.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import type { DisposableContext } from "../shared/typed-event-bus.js";
import { ids } from "./state.js";

const RESIZING_VIEW_ATTR = "data-biliscript-script-resizing";
const RESIZING_ROOT_ATTR = "data-biliscript-panel-resizing";
const FLOAT_ATTR = "data-biliscript-script-float";
const DETACHED_ATTR = "data-biliscript-detached";
const READY_ATTR = "data-biliscript-reader-ready";
const SCRIPT_WIDTH_VAR = "--biliscript-script-width";

type PanelWidthListener = (width: number) => void;

const widthListeners = new Set<PanelWidthListener>();

export function subscribePanelWidthSync(listener: PanelWidthListener): () => void {
  widthListeners.add(listener);
  return () => {
    widthListeners.delete(listener);
  };
}

function notifyPanelWidthSync(width: number): void {
  for (const listener of widthListeners) {
    try {
      listener(width);
    } catch {
    }
  }
}

export interface PanelResizeBindingDeps {
  getMaxWidth: () => number;
  applyLayout: () => void;
}

interface ActiveResizeSession {
  pointerId: number;
  handle: HTMLElement;
  readingView: HTMLElement;
  startX: number;
  startWidth: number;
  prevEnabled: boolean;
  prevWidth: number;
  currentWidth: number;
  pendingWidth: number | null;
  rafId: number;
  moved: boolean;
}

function resolveStartWidth(readingView: HTMLElement): number {
  const cssWidth = Number.parseFloat(readingView.style.getPropertyValue(SCRIPT_WIDTH_VAR));
  if (Number.isFinite(cssWidth) && cssWidth > 0) {
    return Math.round(cssWidth);
  }
  const rectWidth = readingView.getBoundingClientRect().width;
  if (Number.isFinite(rectWidth) && rectWidth > 0) {
    return Math.round(rectWidth);
  }
  if (state.settings?.customPanelWidthEnabled === true && Number.isFinite(state.settings.customPanelWidth)) {
    return Math.round(state.settings.customPanelWidth);
  }
  return DEFAULT_SETTINGS.customPanelWidth;
}

function canStartResize(readingView: HTMLElement): boolean {
  if (isReaderDetached() || readingView.hidden) {
    return false;
  }
  if (readingView.classList.contains("closing")) {
    return false;
  }
  if (readingView.getAttribute(FLOAT_ATTR) === "1") {
    return false;
  }
  if (readingView.getAttribute(DETACHED_ATTR) === "1") {
    return false;
  }
  if (readingView.getAttribute(READY_ATTR) === "0") {
    return false;
  }
  return true;
}

function clearResizingAttrs(readingView?: HTMLElement | null): void {
  readingView?.removeAttribute(RESIZING_VIEW_ATTR);
  document.documentElement?.removeAttribute(RESIZING_ROOT_ATTR);
}

export function bindPanelResizeHandle(
  scope: DisposableContext,
  deps: PanelResizeBindingDeps
): void {
  let session: ActiveResizeSession | null = null;

  const clampWidth = (raw: number): number => {
    const maxWidth = Math.max(CUSTOM_PANEL_WIDTH_MIN, deps.getMaxWidth());
    return Math.max(CUSTOM_PANEL_WIDTH_MIN, Math.min(maxWidth, Math.round(raw)));
  };

  const applyWidthPreview = (width: number): void => {
    state.patchSettings({
      customPanelWidthEnabled: true,
      customPanelWidth: width
    });
    deps.applyLayout();
    notifyPanelWidthSync(width);
  };

  const flushPendingPreview = (active: ActiveResizeSession): void => {
    if (active.rafId) {
      scope.cancelAnimationFrame(active.rafId);
      active.rafId = 0;
    }
    if (active.pendingWidth === null) {
      return;
    }
    const nextWidth = active.pendingWidth;
    active.pendingWidth = null;
    if (nextWidth !== active.currentWidth || !active.moved) {
      active.currentWidth = nextWidth;
      active.moved = true;
      applyWidthPreview(nextWidth);
    }
  };

  const releaseCapture = (active: ActiveResizeSession): void => {
    if (typeof active.handle.releasePointerCapture === "function") {
      try {
        if (
          typeof active.handle.hasPointerCapture !== "function" ||
          active.handle.hasPointerCapture(active.pointerId)
        ) {
          active.handle.releasePointerCapture(active.pointerId);
        }
      } catch {
      }
    }
  };

  const finishSession = (commit: boolean): void => {
    const active = session;
    if (!active) {
      return;
    }
    session = null;
    if (commit) {
      flushPendingPreview(active);
    } else if (active.rafId) {
      scope.cancelAnimationFrame(active.rafId);
      active.rafId = 0;
    }
    releaseCapture(active);
    clearResizingAttrs(active.readingView);

    if (!active.moved) {
      return;
    }

    if (commit) {
      const finalWidth = active.currentWidth;
      void sendRuntimeMessage({
        type: "save-settings",
        settings: {
          customPanelWidth: finalWidth,
          customPanelWidthEnabled: true
        }
      }).catch((error) => {
        logWarn("[BILISCRIPT] failed to save resized panel width", error);
      });
      return;
    }

    state.patchSettings({
      customPanelWidthEnabled: active.prevEnabled,
      customPanelWidth: active.prevWidth
    });
    deps.applyLayout();
    notifyPanelWidthSync(active.prevWidth);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || session) {
      return;
    }
    const target = event.target as Element | null;
    const handle =
      typeof target?.closest === "function"
        ? (target.closest(`#${ids.readingResizeHandle}`) as HTMLElement | null)
        : null;
    if (!handle) {
      return;
    }
    const readingView = document.getElementById(ids.readingView);
    if (!readingView || !canStartResize(readingView)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const startWidth = resolveStartWidth(readingView);
    const prevEnabled = state.settings?.customPanelWidthEnabled === true;
    const prevWidth = Number.isFinite(state.settings?.customPanelWidth)
      ? Math.round(state.settings.customPanelWidth)
      : DEFAULT_SETTINGS.customPanelWidth;

    session = {
      pointerId: event.pointerId,
      handle,
      readingView,
      startX: event.clientX,
      startWidth,
      prevEnabled,
      prevWidth,
      currentWidth: startWidth,
      pendingWidth: null,
      rafId: 0,
      moved: false
    };

    if (typeof handle.setPointerCapture === "function") {
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
      }
    }

    readingView.setAttribute(RESIZING_VIEW_ATTR, "1");
    document.documentElement?.setAttribute(RESIZING_ROOT_ATTR, "1");
  };

  const onPointerMove = (event: PointerEvent): void => {
    const active = session;
    if (!active || event.pointerId !== active.pointerId) {
      return;
    }
    const delta = active.startX - event.clientX;
    if (!active.moved && Math.abs(delta) < 1) {
      return;
    }
    const nextWidth = clampWidth(active.startWidth + delta);
    if (!active.moved && nextWidth === active.startWidth) {
      return;
    }
    active.pendingWidth = nextWidth;
    if (!active.rafId) {
      let ranSynchronously = false;
      const rafId = scope.requestAnimationFrame(() => {
        ranSynchronously = true;
        if (session === active) {
          active.rafId = 0;
          flushPendingPreview(active);
        }
      });
      active.rafId = ranSynchronously ? 0 : rafId;
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }
    finishSession(true);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (!session || event.pointerId !== session.pointerId) {
      return;
    }
    finishSession(false);
  };

  const onWindowBlur = (): void => {
    if (session) {
      finishSession(false);
    }
  };

  scope.addListener(document, "pointerdown", onPointerDown as EventListener);
  scope.addListener(window, "pointermove", onPointerMove as EventListener);
  scope.addListener(window, "pointerup", onPointerUp as EventListener);
  scope.addListener(window, "pointercancel", onPointerCancel as EventListener);
  scope.addListener(window, "blur", onWindowBlur);
  scope.track(() => {
    if (session) {
      const active = session;
      session = null;
      if (active.rafId) {
        scope.cancelAnimationFrame(active.rafId);
        active.rafId = 0;
      }
      releaseCapture(active);
      clearResizingAttrs(active.readingView);
    } else {
      clearResizingAttrs(document.getElementById(ids.readingView));
    }
  });
}
