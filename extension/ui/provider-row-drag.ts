const DRAG_HANDLE_SELECTOR = ".provider-row-drag-handle";
const ROW_SELECTOR = ".search-provider-row";
const DRAG_THRESHOLD_PX = 4;
const DRAGGING_CLASS = "search-provider-row-dragging";

export interface ProviderRowDragOptions {
  onCommit: (orderedRecordIds: string[]) => void | Promise<void>;
}

interface DragSession {
  row: HTMLElement;
  pointerId: number;
  startY: number;
  dragging: boolean;
  originalOrder: string[];
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function ensureLiveStatusNode(listNode: HTMLElement): HTMLElement | null {
  const parent = listNode.parentElement;
  if (!parent) return null;
  const existing = parent.querySelector<HTMLElement>('[data-search-order-live="1"]');
  if (existing) return existing;
  const node = document.createElement("p");
  node.className = "biliscript-sr-only search-order-live-status";
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  node.dataset.searchOrderLive = "1";
  listNode.insertAdjacentElement("afterend", node);
  return node;
}

export function wireProviderRowDrag(listNode: HTMLElement, { onCommit }: ProviderRowDragOptions): void {
  let session: DragSession | null = null;

  const recordRows = (): HTMLElement[] =>
    Array.from(listNode.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(
      (row) => row.querySelector(DRAG_HANDLE_SELECTOR) !== null
    );
  const recordIds = (): string[] => recordRows().map((row) => row.dataset.providerId || "");

  const commitOrder = (ids: string[]): void => {
    try {
      const pending: unknown = onCommit(ids);
      if (typeof (pending as Promise<void> | null | undefined)?.catch === "function") {
        void (pending as Promise<void>).catch(() => {});
      }
    } catch {}
  };

  const restore = (ids: readonly string[]): void => {
    const byId = new Map(recordRows().map((row) => [row.dataset.providerId || "", row]));
    ids.forEach((id) => {
      const row = byId.get(id);
      if (row) listNode.appendChild(row);
    });
  };

  function detachActiveListeners(): void {
    document.removeEventListener("keydown", onKeyDown, true);
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    }
  }

  function end(commit: boolean): void {
    const current = session;
    if (!current) return;
    session = null;
    detachActiveListeners();
    current.row.classList.remove(DRAGGING_CLASS);
    try {
      listNode.releasePointerCapture?.(current.pointerId);
    } catch {}
    if (!current.dragging) return;
    if (!commit) {
      restore(current.originalOrder);
      return;
    }
    const ids = recordIds();
    if (sameIds(ids, current.originalOrder)) return;
    commitOrder(ids);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") end(false);
  }

  function moveTo(current: DragSession, clientY: number): void {
    const others = recordRows().filter((row) => row !== current.row);
    let before: HTMLElement | null = null;
    for (const row of others) {
      const rect = row.getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        before = row;
        break;
      }
    }
    if (before) {
      listNode.insertBefore(current.row, before);
    } else if (listNode.lastElementChild !== current.row) {
      listNode.appendChild(current.row);
    }
  }

  const onPointerDown = (event: PointerEvent): void => {
    if (session || event.button !== 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest<HTMLElement>(DRAG_HANDLE_SELECTOR);
    if (!handle || !listNode.contains(handle)) return;
    const row = handle.closest<HTMLElement>(ROW_SELECTOR);
    if (!row || row.parentElement !== listNode) return;
    session = {
      row,
      pointerId: event.pointerId,
      startY: event.clientY,
      dragging: false,
      originalOrder: recordIds()
    };
    document.addEventListener("keydown", onKeyDown, true);
    if (typeof window !== "undefined") {
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    const current = session;
    if (!current || event.pointerId !== current.pointerId) return;
    if (!current.dragging) {
      if (Math.abs(event.clientY - current.startY) < DRAG_THRESHOLD_PX) return;
      current.dragging = true;
      try {
        listNode.setPointerCapture?.(current.pointerId);
      } catch {}
      current.row.classList.add(DRAGGING_CLASS);
    }
    moveTo(current, event.clientY);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (!session || event.pointerId !== session.pointerId) return;
    end(true);
  };

  const onPointerCancel = (event: PointerEvent): void => {
    if (!session || event.pointerId !== session.pointerId) return;
    end(false);
  };

  const onHandleKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    if (listNode.classList.contains("search-chain-single-mode")) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    const handle = target.closest<HTMLElement>(DRAG_HANDLE_SELECTOR);
    if (!handle || !listNode.contains(handle)) return;
    const row = handle.closest<HTMLElement>(ROW_SELECTOR);
    if (!row || row.parentElement !== listNode) return;

    const rows = recordRows();
    const index = rows.indexOf(row);
    if (index < 0) return;

    const delta = event.key === "ArrowUp" ? -1 : 1;
    const nextIndex = index + delta;
    if (nextIndex < 0 || nextIndex >= rows.length) {
      event.preventDefault();
      return;
    }

    event.preventDefault();
    if (delta < 0) {
      listNode.insertBefore(row, rows[nextIndex]);
    } else {
      const afterTarget = rows[nextIndex].nextElementSibling;
      listNode.insertBefore(row, afterTarget);
    }
    handle.focus({ preventScroll: true });
    const liveNode = ensureLiveStatusNode(listNode);
    if (liveNode) {
      const name = row.querySelector(".provider-row-name")?.textContent?.trim() || "当前平台";
      liveNode.textContent = `${name}已移至第 ${nextIndex + 1} 位，共 ${rows.length} 位`;
    }
    commitOrder(recordIds());
  };

  listNode.addEventListener("pointerdown", onPointerDown);
  listNode.addEventListener("keydown", onHandleKeyDown);
}
