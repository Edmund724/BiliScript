// extension/live/viewport-drag.ts
// 宿主容器内 Pointer 拖拽、移动阈值判定与边界钳制原语

export interface ViewportDragOptions {
  handleEl: HTMLElement;
  getTargetEl: () => HTMLElement | null;
  getHostEl: () => HTMLElement;
  ignoreSelector?: string;
  clickMoveThresholdPx?: number;
  onClickWithoutDrag?: () => void;
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
  let initialLeft = 0;
  let initialTop = 0;

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

    let nextLeft = initialLeft + deltaX;
    let nextTop = initialTop + deltaY;

    const maxLeft = Math.max(0, hostRect.width - rect.width);
    const maxTop = Math.max(0, hostRect.height - rect.height);

    nextLeft = Math.max(0, Math.min(nextLeft, maxLeft));
    nextTop = Math.max(0, Math.min(nextTop, maxTop));

    targetEl.style.left = `${nextLeft}px`;
    targetEl.style.top = `${nextTop}px`;
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
    if (wasDragging && !wasMoved) {
      options.onClickWithoutDrag?.();
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

    initialLeft = rect.left - hostRect.left;
    initialTop = rect.top - hostRect.top;

    targetEl.style.left = `${initialLeft}px`;
    targetEl.style.top = `${initialTop}px`;
    targetEl.style.right = "auto";
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
