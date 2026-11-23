import { getActiveReaderWindow } from "./active-host.js";

export function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

export function isVisibleReaderControl(node: unknown): boolean {
  if (!node || typeof (node as Element).getBoundingClientRect !== "function") {
    return false;
  }
  const el = node as Element;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const view = el.ownerDocument?.defaultView ?? getActiveReaderWindow();
  const style = view.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}

export function isDomExceptionNamed(error: unknown, names: readonly string[]): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const activeWin = getActiveReaderWindow() as Window & { DOMException?: typeof DOMException };
  let isDomTag = false;
  try {
    isDomTag = Object.prototype.toString.call(error) === "[object DOMException]";
  } catch {
  }
  const isDomException =
    (typeof DOMException !== "undefined" && error instanceof DOMException) ||
    (typeof window !== "undefined" &&
      typeof window.DOMException === "function" &&
      error instanceof window.DOMException) ||
    (typeof activeWin?.DOMException === "function" && error instanceof activeWin.DOMException) ||
    (error as { constructor?: { name?: unknown } }).constructor?.name === "DOMException" ||
    isDomTag;
  return isDomException && names.includes((error as DOMException).name);
}

export function trySetPointerCapture(target: Element, pointerId: number | undefined): void {
  if (typeof target.setPointerCapture !== "function" || pointerId === undefined) {
    return;
  }
  try {
    target.setPointerCapture(pointerId);
  } catch (error) {
    if (isDomExceptionNamed(error, ["NotFoundError", "InvalidStateError"])) {
      return;
    }
    throw error;
  }
}
