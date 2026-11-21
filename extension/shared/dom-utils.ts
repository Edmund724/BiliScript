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
