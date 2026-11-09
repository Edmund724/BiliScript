// extension/live/viewport-drag.ts
// 宿主容器内 Pointer 拖拽、移动阈值判定与右上角相对偏移边界钳制原语

export interface ViewportDragOptions {
  handleEl: HTMLElement;
  getTargetEl: () => HTMLElement | null;
  getHostEl: () => HTMLElement;
  ignoreSelector?: string;
  clickMoveThresholdPx?: number;
  onClickWithoutDrag?: () => void;
  onDragEnd?: (offset: { right: number; top: number }) => void;
}

export interface ViewportDragHandle {
  dispose(): void;
}

export function bindViewportDrag(options: ViewportDragOptions): ViewportDragHandle {
  const threshold = options.clickMoveThresholdPx ?? 4;
  let isDragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let initialRight = 16;
  let initialTop = 16;

  function onPointerMove(e: PointerEvent): void {
    const targetEl = options.getTargetEl();
    if (!isDragging || !targetEl) return;

    const deltaX = e.clientX - startX;
    const deltaY = e.clientY - startY;
    if (Math.hypot(deltaX, deltaY) > threshold) {
      moved = true;
    }

    const host = options.getHostEl();
    const hostRect = host.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();

    let nextRight = initialRight - deltaX;
    let nextTop = initialTop + deltaY;

    if (hostRect.width > 0) {
      const maxRight = Math.max(0, hostRect.width - (rect.width || 0));
      nextRight = Math.max(0, Math.min(nextRight, maxRight));
    } else {
      nextRight = Math.max(0, nextRight);
    }

    if (hostRect.height > 0) {
      const maxTop = Math.max(0, hostRect.height - (rect.height || 0));
      nextTop = Math.max(0, Math.min(nextTop, maxTop));
    } else {
      nextTop = Math.max(0, nextTop);
    }

    targetEl.style.right = `${nextRight}px`;
    targetEl.style.top = `${nextTop}px`;
    targetEl.style.left = "auto";
    targetEl.style.bottom = "auto";
  }

  function stopDragListeners(): void {
    isDragging = false;
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    }
  }

  function onPointerUp(): void {
    const wasDragging = isDragging;
    const wasMoved = moved;
    stopDragListeners();
    if (wasDragging) {
      if (!wasMoved) {
        options.onClickWithoutDrag?.();
      } else {
        const targetEl = options.getTargetEl();
        if (targetEl) {
          const parsedRight = parseFloat(targetEl.style.right) || 0;
          const parsedTop = parseFloat(targetEl.style.top) || 0;
          options.onDragEnd?.({ right: parsedRight, top: parsedTop });
        }
      }
    }
  }

  function onPointerDown(e: PointerEvent): void {
    if (options.ignoreSelector) {
      const target = e.target as HTMLElement | null;
      if (target?.closest(options.ignoreSelector)) {
        return;
      }
    }
    const targetEl = options.getTargetEl();
    if (!targetEl) return;

    isDragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;

    const rect = targetEl.getBoundingClientRect();
    const host = options.getHostEl();
    const hostRect = host.getBoundingClientRect();

    let currentRight = 16;
    let currentTop = 16;

    if (hostRect.right > 0 && rect.right > 0) {
      currentRight = hostRect.right - rect.right;
    }
    if (hostRect.top > 0 && rect.top > 0) {
      currentTop = rect.top - hostRect.top;
    }

    if (targetEl.style.right && targetEl.style.right.endsWith("px")) {
      const parsedRight = parseFloat(targetEl.style.right);
      if (!Number.isNaN(parsedRight)) {
        currentRight = parsedRight;
      }
    }
    if (targetEl.style.top && targetEl.style.top.endsWith("px")) {
      const parsedTop = parseFloat(targetEl.style.top);
      if (!Number.isNaN(parsedTop)) {
        currentTop = parsedTop;
      }
    }

    initialRight = currentRight;
    initialTop = currentTop;

    targetEl.style.right = `${initialRight}px`;
    targetEl.style.top = `${initialTop}px`;
    targetEl.style.left = "auto";
    targetEl.style.bottom = "auto";

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }

  options.handleEl.addEventListener("pointerdown", onPointerDown);

  return {
    dispose(): void {
      options.handleEl.removeEventListener("pointerdown", onPointerDown);
      stopDragListeners();
    }
  };
}
