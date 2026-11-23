import {
  activeById,
  getActiveReaderDocument,
  getActiveReaderWindow,
  getOpenerWindow,
} from "./active-host.js";

export interface ActiveAnimationFrameHandle {
  cancel(): void;
  window: Window;
}

export function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Node).nodeType === "number"
  );
}

export function isElementNode(value: unknown): value is Element {
  return isNode(value) && value.nodeType === 1;
}

export function isHtmlElement(value: unknown): value is HTMLElement {
  return isElementNode(value) && typeof (value as HTMLElement).style !== "undefined";
}

export function isTextNode(value: unknown): value is Text {
  return isNode(value) && value.nodeType === 3;
}

export function isTagElement<K extends keyof HTMLElementTagNameMap>(
  value: unknown,
  tag: K
): value is HTMLElementTagNameMap[K] {
  return (
    isHtmlElement(value) &&
    typeof value.tagName === "string" &&
    value.tagName.toLowerCase() === tag
  );
}

export function isHtmlButton(value: unknown): value is HTMLButtonElement {
  return isTagElement(value, "button");
}

export function isEditableTarget(value: unknown): boolean {
  if (!isHtmlElement(value)) {
    return false;
  }
  const tag = typeof value.tagName === "string" ? value.tagName.toLowerCase() : "";
  if (tag === "input" || tag === "textarea" || Boolean(value.isContentEditable)) {
    return true;
  }
  const prop = typeof value.contentEditable === "string" ? value.contentEditable.toLowerCase() : "";
  if (prop === "true" || prop === "plaintext-only") {
    return true;
  }
  const attr = value.getAttribute("contenteditable");
  if (attr === null) {
    return false;
  }
  const normalized = attr.toLowerCase();
  return normalized === "" || normalized === "true" || normalized === "plaintext-only";
}

export function isBlobLike(value: unknown): value is Blob {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return true;
  }
  const activeWin = getActiveReaderWindow() as Window & { Blob?: typeof Blob };
  if (typeof activeWin?.Blob === "function" && value instanceof activeWin.Blob) {
    return true;
  }
  const candidate = value as Partial<Blob>;
  return (
    typeof candidate.size === "number" &&
    typeof candidate.type === "string" &&
    typeof candidate.arrayBuffer === "function"
  );
}

export function resolveNodeDocument(node?: Node | null): Document {
  if (node) {
    if (node.nodeType === 9) {
      return node as Document;
    }
    if (node.ownerDocument) {
      return node.ownerDocument;
    }
  }
  return getActiveReaderDocument();
}

export function resolveNodeWindow(node?: Node | null): Window {
  return resolveNodeDocument(node).defaultView ?? getActiveReaderWindow();
}

export function createActiveEvent(
  type: string,
  init?: EventInit,
  target?: Node | null
): Event {
  try {
    const win = target ? resolveNodeWindow(target) : getActiveReaderWindow();
    const EventCtor = (win as (Window & { Event?: typeof Event }) | null)?.Event;
    if (typeof EventCtor === "function") {
      return new EventCtor(type, init);
    }
  } catch {
  }
  return new Event(type, init);
}

export function dispatchCrossDocEvent(
  target: EventTarget,
  type: string,
  init?: EventInit
): boolean {
  const event = createActiveEvent(type, init, isNode(target) ? target : null);
  return target.dispatchEvent(event);
}

export function prefersActiveReducedMotion(target?: Node | null): boolean {
  try {
    const win = target ? resolveNodeWindow(target) : getActiveReaderWindow();
    if (!win || win.closed || typeof win.matchMedia !== "function") {
      return false;
    }
    return Boolean(win.matchMedia("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

export function requireActiveById<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = activeById<T>(id);
  if (!node) {
    throw new Error(`Missing node: ${id}`);
  }
  return node;
}

export function safeRemoveListener(
  target: EventTarget | null | undefined,
  type: string,
  listener: EventListenerOrEventListenerObject | ((event: never) => void) | null | undefined,
  options?: boolean | EventListenerOptions
): void {
  if (!target || !listener) {
    return;
  }
  try {
    target.removeEventListener(type, listener as EventListener, options);
  } catch {
  }
}

export function writeActiveClipboardText(
  text: string,
  preferredWin?: Window | null
): Promise<void> {
  const primaryWin = preferredWin ?? getActiveReaderWindow();
  const openerWin = getOpenerWindow();
  const primaryClipboard = primaryWin?.navigator?.clipboard;
  const fallbackClipboard =
    openerWin !== primaryWin ? openerWin?.navigator?.clipboard : undefined;
  const hasFallback =
    Boolean(fallbackClipboard) && typeof fallbackClipboard?.writeText === "function";

  if (primaryClipboard && typeof primaryClipboard.writeText === "function") {
    try {
      const attempt = Promise.resolve(primaryClipboard.writeText(text));
      if (!hasFallback) {
        return attempt;
      }
      return attempt.catch((primaryError) => {
        try {
          return Promise.resolve(fallbackClipboard!.writeText(text)).catch(() => {
            throw primaryError;
          });
        } catch {
          throw primaryError;
        }
      });
    } catch (error) {
      if (hasFallback) {
        try {
          return Promise.resolve(fallbackClipboard!.writeText(text));
        } catch {
          return Promise.reject(error);
        }
      }
      return Promise.reject(error);
    }
  }
  if (hasFallback) {
    try {
      return Promise.resolve(fallbackClipboard!.writeText(text));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return Promise.reject(new Error("Clipboard API unavailable"));
}

export function scheduleActiveAnimationFrame(
  callback: FrameRequestCallback,
  preferredWin?: Window | null
): ActiveAnimationFrameHandle {
  const targetWin = preferredWin ?? getActiveReaderWindow();
  let usedTargetWin = false;
  let id: number;
  try {
    if (typeof targetWin?.requestAnimationFrame === "function") {
      id = targetWin.requestAnimationFrame(callback);
      usedTargetWin = true;
    } else {
      id = requestAnimationFrame(callback);
    }
  } catch {
    id = requestAnimationFrame(callback);
  }
  let cancelled = false;
  return {
    window: targetWin,
    cancel() {
      if (cancelled) {
        return;
      }
      cancelled = true;
      if (usedTargetWin) {
        try {
          if (typeof targetWin?.cancelAnimationFrame === "function") {
            targetWin.cancelAnimationFrame(id);
            return;
          }
        } catch {
        }
      }
      try {
        cancelAnimationFrame(id);
      } catch {
      }
    },
  };
}
