import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyViewportOffset,
  bindViewportDrag,
  type ViewportDragHandle,
  type ViewportDragOffset
} from "../../extension/live/viewport-drag.js";

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => {}
  };
}

function pointer(type: string, x = 950, y = 20): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    button: 0,
    clientX: x,
    clientY: y,
    pointerId: 1
  });
}

describe("live/viewport-drag 浮窗拖拽", () => {
  let host: HTMLElement;
  let target: HTMLElement;
  let handle: HTMLElement;
  let dragHandle: ViewportDragHandle | null = null;
  let onClick = vi.fn<() => void>();
  let onDragEnd = vi.fn<(offset: ViewportDragOffset) => void>();

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    target = document.createElement("div");
    handle = document.createElement("div");
    host.getBoundingClientRect = () => rect(0, 0, 1000, 600);
    target.getBoundingClientRect = () => rect(900, 16, 100, 40);
    target.appendChild(handle);
    host.appendChild(target);
    document.body.appendChild(host);
    onClick = vi.fn<() => void>();
    onDragEnd = vi.fn<(offset: ViewportDragOffset) => void>();
  });

  afterEach(() => {
    dragHandle?.dispose();
    dragHandle = null;
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function bind(ignoreSelector?: string): void {
    dragHandle = bindViewportDrag({
      handleEl: handle,
      getTargetEl: () => target,
      getHostEl: () => host,
      ignoreSelector,
      onClickWithoutDrag: onClick,
      onDragEnd
    });
  }

  it("仅响应主指针左键，4px 内手抖仍视为点击", () => {
    bind();
    handle.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointermove", 952, 22));
    window.dispatchEvent(pointer("pointerup", 952, 22));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onDragEnd).not.toHaveBeenCalled();
    expect(target.classList.contains("is-dragging")).toBe(false);

    handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 1, pointerId: 2 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 1, pointerId: 2 }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("松手吸附右侧并保持纵向位置", () => {
    bind();
    handle.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointermove", 910, 50));
    window.dispatchEvent(pointer("pointerup", 910, 50));

    expect(target.style.right).toBe("16px");
    expect(target.style.left).toBe("auto");
    expect(target.style.top).toBe("46px");
    expect(onDragEnd).toHaveBeenCalledWith({
      edge: "right",
      left: 884,
      right: 16,
      top: 46
    } satisfies ViewportDragOffset);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("越过中线后松手吸附左侧并保留安全间距", () => {
    bind();
    handle.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointermove", 450, 80));
    window.dispatchEvent(pointer("pointerup", 450, 80));

    expect(target.style.left).toBe("16px");
    expect(target.style.right).toBe("auto");
    expect(target.style.top).toBe("76px");
    expect(onDragEnd).toHaveBeenCalledWith({
      edge: "left",
      left: 16,
      right: 884,
      top: 76
    } satisfies ViewportDragOffset);
  });

  it("拖拽后的兼容 click 不会触发展开或 handle 内挂断按钮", () => {
    const closeButton = document.createElement("button");
    const onClose = vi.fn();
    closeButton.addEventListener("click", onClose);
    handle.appendChild(closeButton);
    bind("button");

    handle.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointermove", 400, 20));
    window.dispatchEvent(pointer("pointerup", 400, 20));
    closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));

    expect(onClick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["pointercancel", "lostpointercapture", "pointerout", "blur"])("%s 后清理拖拽并吸附", (type) => {
    bind();
    handle.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointermove", 400, 70));
    if (type === "lostpointercapture") {
      handle.dispatchEvent(pointer(type));
    } else if (type === "blur") {
      window.dispatchEvent(new Event("blur"));
    } else {
      window.dispatchEvent(pointer(type));
    }

    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
    expect(target.classList.contains("is-dragging")).toBe(false);
    expect(handle.classList.contains("is-dragging")).toBe(false);

    window.dispatchEvent(pointer("pointermove", 800, 20));
    window.dispatchEvent(pointer("pointerup", 800, 20));
    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("左右锚点在宿主缩放后保持同侧并重新钳制纵横向位置", () => {
    let hostRect = rect(0, 0, 1000, 600);
    host.getBoundingClientRect = () => hostRect;
    target.getBoundingClientRect = () => rect(16, 500, 100, 40);
    let offset = applyViewportOffset(target, host, {
      edge: "left",
      left: 16,
      right: 884,
      top: 500
    });

    hostRect = rect(0, 0, 500, 300);
    offset = applyViewportOffset(target, host, offset);
    expect(offset).toEqual({ edge: "left", left: 16, right: 384, top: 244 });
    expect(target.style.left).toBe("16px");
    expect(target.style.top).toBe("244px");

    hostRect = rect(0, 0, 1200, 800);
    offset = applyViewportOffset(target, host, offset);
    expect(target.style.left).toBe("16px");
    expect(target.style.top).toBe("244px");

    hostRect = rect(0, 0, 120, 50);
    offset = applyViewportOffset(target, host, offset);
    expect(target.style.left).toBe("4px");
    expect(target.style.top).toBe("0px");
  });

  it.each([true, false])("prefers-reduced-motion=%s 时按偏好决定是否播放吸附动画", (reduceMotion) => {
    const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation);
    target.animate = animate;
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduceMotion }) as MediaQueryList));
    bind();

    handle.dispatchEvent(pointer("pointerdown"));
    window.dispatchEvent(pointer("pointermove", 400, 20));
    window.dispatchEvent(pointer("pointerup", 400, 20));

    if (reduceMotion) {
      expect(animate).not.toHaveBeenCalled();
    } else {
      expect(animate).toHaveBeenCalledWith(
        [{ transform: "translateX(318px)" }, { transform: "translateX(0)" }],
        { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
      );
    }
    expect(target.style.left).toBe("16px");
  });
});
