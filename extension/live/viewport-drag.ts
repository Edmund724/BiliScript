// extension/live/viewport-drag.ts
// 宿主容器内 Pointer 拖拽、左右边缘吸附与可达位置钳制原语

export const VIEWPORT_DRAG_SAFE_GAP_PX = 16;

export type ViewportDragEdge = "left" | "right";

export interface ViewportDragOffset {
  edge: ViewportDragEdge;
  left: number;
  right: number;
  top: number;
}

export interface ViewportDragOptions {
  handleEl: HTMLElement;
  getTargetEl: () => HTMLElement | null;
  getHostEl: () => HTMLElement;
  ignoreSelector?: string;
  clickMoveThresholdPx?: number;
  safeGapPx?: number;
  onClickWithoutDrag?: () => void;
  onDragEnd?: (offset: ViewportDragOffset) => void;
}

export interface ViewportDragHandle {
  dispose(): void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

function readPixels(value: string, fallback: number): number {
  if (!value.endsWith("px")) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function applyViewportOffset(
  el: HTMLElement,
  host: HTMLElement,
  offset: ViewportDragOffset,
  safeGapPx = VIEWPORT_DRAG_SAFE_GAP_PX
): ViewportDragOffset {
  const hostRect = host.getBoundingClientRect();
  const rect = el.getBoundingClientRect();
  const horizontalRange = hostRect.width > 0 ? hostRect.width - rect.width : 0;
  const verticalRange = hostRect.height > 0 ? hostRect.height - rect.height : 0;
  const maxInline = hostRect.width > 0 ? Math.max(0, horizontalRange - safeGapPx) : Number.POSITIVE_INFINITY;
  const maxTop = hostRect.height > 0 ? Math.max(0, verticalRange - safeGapPx) : Number.POSITIVE_INFINITY;
  const minInline = Math.min(safeGapPx, maxInline);
  const minTop = Math.min(safeGapPx, maxTop);
  const inline = clamp(offset.edge === "left" ? offset.left : offset.right, minInline, maxInline);
  const top = clamp(offset.top, minTop, maxTop);
  const left = offset.edge === "left" ? inline : horizontalRange - inline;
  const right = offset.edge === "right" ? inline : horizontalRange - inline;

  el.style.left = offset.edge === "left" ? `${left}px` : "auto";
  el.style.right = offset.edge === "right" ? `${right}px` : "auto";
  el.style.top = `${top}px`;
  el.style.bottom = "auto";

  return {
    edge: offset.edge,
    left: hostRect.width > 0 ? left : offset.left,
    right: hostRect.width > 0 ? right : offset.right,
    top
  };
}

export function bindViewportDrag(options: ViewportDragOptions): ViewportDragHandle {
  const threshold = options.clickMoveThresholdPx ?? 4;
  const safeGap = options.safeGapPx ?? VIEWPORT_DRAG_SAFE_GAP_PX;
  let activePointerId: number | null = null;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let initialLeft = safeGap;
  let initialRight = safeGap;
  let initialTop = safeGap;
  let currentOffset: ViewportDragOffset = {
    edge: "right",
    left: 0,
    right: safeGap,
    top: safeGap
  };
  let snapAnimation: Animation | null = null;
  let suppressClickHandler: ((event: MouseEvent) => void) | null = null;
  let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;

  function clearClickSuppression(): void {
    if (suppressClickHandler) {
      document.removeEventListener("click", suppressClickHandler, true);
      suppressClickHandler = null;
    }
    if (suppressClickTimer !== null) {
      clearTimeout(suppressClickTimer);
      suppressClickTimer = null;
    }
  }

  function suppressNextClick(): void {
    clearClickSuppression();
    suppressClickHandler = (event: MouseEvent) => {
      clearClickSuppression();
      const target = event.target;
      if (target instanceof Node && options.handleEl.contains(target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", suppressClickHandler, true);
    suppressClickTimer = setTimeout(clearClickSuppression, 0);
  }

  function updatePosition(event: PointerEvent): void {
    const targetEl = options.getTargetEl();
    if (activePointerId === null || event.pointerId !== activePointerId || !targetEl) return;

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    if (!moved && Math.hypot(deltaX, deltaY) <= threshold) return;
    if (!moved) {
      moved = true;
      targetEl.classList.add("is-dragging");
      options.handleEl.classList.add("is-dragging");
    }

    const right = initialRight - deltaX;
    const host = options.getHostEl();
    const hostWidth = host.getBoundingClientRect().width;
    const targetWidth = targetEl.getBoundingClientRect().width;
    const left = hostWidth > 0 ? hostWidth - targetWidth - right : initialLeft + deltaX;
    currentOffset = applyViewportOffset(targetEl, host, {
      edge: currentOffset.edge,
      left,
      right,
      top: initialTop + deltaY
    }, safeGap);
  }

  function releasePointerCapture(pointerId: number): void {
    try {
      if (options.handleEl.hasPointerCapture?.(pointerId)) {
        options.handleEl.releasePointerCapture(pointerId);
      }
    } catch {
      // 节点迁移或指针已释放时捕获可能已不存在。
    }
  }

  function finishDrag(event: PointerEvent | null, allowClick: boolean): void {
    if (activePointerId === null) return;
    if (event && activePointerId !== event.pointerId) return;
    if (event?.type === "pointerup") updatePosition(event);

    const pointerId = activePointerId;
    const wasMoved = moved;
    const targetEl = options.getTargetEl();
    stopDragListeners();
    releasePointerCapture(pointerId);
    targetEl?.classList.remove("is-dragging");
    options.handleEl.classList.remove("is-dragging");

    if (!wasMoved) {
      if (allowClick) options.onClickWithoutDrag?.();
      return;
    }

    if (targetEl) {
      const previousLeft = currentOffset.left;
      const edge: ViewportDragEdge = currentOffset.left <= currentOffset.right ? "left" : "right";
      const snapped = applyViewportOffset(targetEl, options.getHostEl(), {
        edge,
        left: edge === "left" ? safeGap : currentOffset.left,
        right: edge === "right" ? safeGap : currentOffset.right,
        top: currentOffset.top
      }, safeGap);
      currentOffset = snapped;
      const visualDeltaX = previousLeft - snapped.left;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      snapAnimation?.cancel();
      snapAnimation = null;
      if (!reduceMotion && visualDeltaX !== 0 && typeof targetEl.animate === "function") {
        snapAnimation = targetEl.animate(
          [{ transform: `translateX(${visualDeltaX}px)` }, { transform: "translateX(0)" }],
          { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
        );
      }
      options.onDragEnd?.(snapped);
    }
    suppressNextClick();
  }

  function onPointerMove(event: PointerEvent): void {
    updatePosition(event);
  }

  function onPointerUp(event: PointerEvent): void {
    finishDrag(event, true);
  }

  function onPointerCancel(event: PointerEvent): void {
    finishDrag(event, false);
  }

  function onLostPointerCapture(event: PointerEvent): void {
    finishDrag(event, false);
  }

  function onWindowPointerOut(event: PointerEvent): void {
    if (event.relatedTarget === null) finishDrag(event, false);
  }

  function onWindowBlur(): void {
    finishDrag(null, false);
  }

  function stopDragListeners(): void {
    activePointerId = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerCancel);
    window.removeEventListener("pointerout", onWindowPointerOut);
    window.removeEventListener("blur", onWindowBlur);
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || activePointerId !== null) return;
    if (options.ignoreSelector) {
      const target = event.target as HTMLElement | null;
      if (target?.closest(options.ignoreSelector)) return;
    }
    const targetEl = options.getTargetEl();
    if (!targetEl) return;

    clearClickSuppression();
    snapAnimation?.cancel();
    snapAnimation = null;
    moved = false;
    startX = event.clientX;
    startY = event.clientY;
    activePointerId = event.pointerId;

    const rect = targetEl.getBoundingClientRect();
    const hostRect = options.getHostEl().getBoundingClientRect();
    const measuredLeft = rect.left - hostRect.left;
    const measuredRight = hostRect.right - rect.right;
    initialLeft = hostRect.width > 0
      ? measuredLeft
      : readPixels(targetEl.style.left, safeGap);
    initialRight = hostRect.width > 0
      ? measuredRight
      : readPixels(targetEl.style.right, safeGap);
    initialTop = hostRect.height > 0
      ? rect.top - hostRect.top
      : readPixels(targetEl.style.top, safeGap);
    currentOffset = applyViewportOffset(targetEl, options.getHostEl(), {
      edge: initialLeft <= initialRight ? "left" : "right",
      left: initialLeft,
      right: initialRight,
      top: initialTop
    }, safeGap);
    initialLeft = currentOffset.left;
    initialRight = currentOffset.right;
    initialTop = currentOffset.top;

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    window.addEventListener("pointerout", onWindowPointerOut);
    window.addEventListener("blur", onWindowBlur);
    try {
      options.handleEl.setPointerCapture?.(event.pointerId);
    } catch {
      // 窗口级监听保证无捕获时也能完成本次手势。
    }
  }

  options.handleEl.addEventListener("pointerdown", onPointerDown);
  options.handleEl.addEventListener("lostpointercapture", onLostPointerCapture);

  return {
    dispose(): void {
      finishDrag(null, false);
      clearClickSuppression();
      snapAnimation?.cancel();
      snapAnimation = null;
      options.handleEl.removeEventListener("pointerdown", onPointerDown);
      options.handleEl.removeEventListener("lostpointercapture", onLostPointerCapture);
      stopDragListeners();
    }
  };
}
