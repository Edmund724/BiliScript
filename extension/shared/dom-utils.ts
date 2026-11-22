export function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

export const getReaderElement = byId;

export function isVisibleReaderControl(node: unknown): boolean {
  if (!node || typeof (node as Element).getBoundingClientRect !== "function") {
    return false;
  }
  const rect = (node as Element).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const style = window.getComputedStyle(node as Element);
  return style.display !== "none" && style.visibility !== "hidden" && style.pointerEvents !== "none";
}

export function isDomExceptionNamed(error: unknown, names: readonly string[]): boolean {
  const isDomException =
    (typeof DOMException !== "undefined" && error instanceof DOMException) ||
    (typeof window !== "undefined" &&
      typeof window.DOMException === "function" &&
      error instanceof window.DOMException);
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
