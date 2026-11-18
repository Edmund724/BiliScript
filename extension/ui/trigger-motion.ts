// extension/ui/trigger-motion.ts
// 触发式 UI（弹层 / 菜单 / 预览卡 / 模态弹窗 / 灯箱）的触发源锚定与进退场动效原语：
// 根据触发器几何坐标动态计算 transform-origin，使展开与收回始终指向触发源；
// 使用独立 CSS `scale` 属性 + `opacity` 执行 WAAPI 动画，不破坏既有居中 translate。
// 在 jsdom（无 Element.prototype.animate）或 prefers-reduced-motion: reduce 下
// 退场清理同步完成，不引入异步竞态。

export interface TriggerEnterOptions {
  target: HTMLElement;
  trigger?: Element | DOMRect | null;
  fallbackOrigin?: string;
  mask?: HTMLElement | null;
  fromScale?: number;
  durationMs?: number;
  easing?: string;
}

export interface TriggerExitOptions {
  target: HTMLElement;
  host?: HTMLElement | null;
  mask?: HTMLElement | null;
  trigger?: Element | DOMRect | null;
  fallbackOrigin?: string;
  toScale?: number;
  durationMs?: number;
  easing?: string;
  onFinish: () => void;
}

export const TRIGGER_ENTER_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
export const TRIGGER_EXIT_EASING = "cubic-bezier(0.4, 0, 1, 1)";
export const TRIGGER_ENTER_DURATION_MS = 180;
export const TRIGGER_EXIT_DURATION_MS = 130;

const activeAnimations = new WeakMap<HTMLElement, Animation[]>();
const savedTriggerRects = new WeakMap<HTMLElement, DOMRect>();
const exitCleanups = new WeakMap<Element, () => void>();

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function resolveTriggerElement(explicit?: Element | null): Element | null {
  if (explicit && explicit.isConnected) {
    return explicit;
  }
  if (typeof document === "undefined") {
    return null;
  }
  const active = document.activeElement;
  if (active instanceof Element && active !== document.body && active !== document.documentElement) {
    return active;
  }
  return null;
}

function isRectUsable(rect: { left: number; top: number; width: number; height: number } | null | undefined): boolean {
  if (!rect) return false;
  return rect.width > 0 || rect.height > 0 || rect.left !== 0 || rect.top !== 0;
}

export function captureTriggerRect(trigger?: Element | DOMRect | null): DOMRect | null {
  if (!trigger) {
    return null;
  }
  if (trigger instanceof Element) {
    if (!trigger.isConnected || typeof trigger.getBoundingClientRect !== "function") {
      return null;
    }
    const rect = trigger.getBoundingClientRect();
    return isRectUsable(rect) ? rect : null;
  }
  return isRectUsable(trigger) ? trigger : null;
}

export function computeRelativeOrigin(
  targetRect: { left: number; top: number; width: number; height: number },
  triggerRect: DOMRect | null,
  fallback = "top right"
): string {
  if (!triggerRect || (targetRect.width <= 0 && targetRect.height <= 0)) {
    return fallback;
  }
  const cx = triggerRect.left + triggerRect.width / 2;
  const cy = triggerRect.top + triggerRect.height / 2;
  const padX = Math.max(48, targetRect.width * 0.25);
  const padY = Math.max(48, targetRect.height * 0.25);
  const ox = Math.max(-padX, Math.min(targetRect.width + padX, cx - targetRect.left));
  const oy = Math.max(-padY, Math.min(targetRect.height + padY, cy - targetRect.top));
  return `${Math.round(ox)}px ${Math.round(oy)}px`;
}

function cancelActiveAnimations(el: HTMLElement | null | undefined): void {
  if (!el) return;
  const list = activeAnimations.get(el);
  if (list) {
    for (const anim of list) {
      try {
        anim.cancel();
      } catch {}
    }
    activeAnimations.delete(el);
  }
}

function trackAnimation(el: HTMLElement, anim: Animation): void {
  const list = activeAnimations.get(el);
  if (list) {
    list.push(anim);
  } else {
    activeAnimations.set(el, [anim]);
  }
}

export function getSavedTriggerRect(target: HTMLElement): DOMRect | null {
  return savedTriggerRects.get(target) ?? null;
}

export function applyElementTriggerOrigin(
  target: HTMLElement,
  trigger?: Element | DOMRect | null,
  fallback = "top right"
): string {
  const rect = typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
  const triggerRect = captureTriggerRect(trigger) ?? savedTriggerRects.get(target) ?? null;
  if (triggerRect) {
    savedTriggerRects.set(target, triggerRect);
  }
  const origin = rect ? computeRelativeOrigin(rect, triggerRect, fallback) : fallback;
  target.style.transformOrigin = origin;
  return origin;
}

export function cancelTriggerExit(hostOrTarget: Element | null | undefined): void {
  if (!hostOrTarget) return;
  const cleanup = exitCleanups.get(hostOrTarget);
  if (cleanup) {
    exitCleanups.delete(hostOrTarget);
    cleanup();
  }
}

export function animateTriggerEnter(options: TriggerEnterOptions): DOMRect | null {
  const {
    target,
    trigger,
    fallbackOrigin = "top right",
    mask = null,
    fromScale = 0.92,
    durationMs = TRIGGER_ENTER_DURATION_MS,
    easing = TRIGGER_ENTER_EASING
  } = options;

  cancelActiveAnimations(target);
  cancelActiveAnimations(mask);
  target.removeAttribute("data-biliscript-closing");
  target.inert = false;
  target.style.pointerEvents = "";
  if (target.getAttribute("aria-hidden") === "true") {
    target.removeAttribute("aria-hidden");
  }

  const resolvedRect = captureTriggerRect(trigger) ?? savedTriggerRects.get(target) ?? null;
  if (resolvedRect) {
    savedTriggerRects.set(target, resolvedRect);
  }
  applyElementTriggerOrigin(target, resolvedRect, fallbackOrigin);

  if (prefersReducedMotion() || typeof target.animate !== "function") {
    return resolvedRect;
  }

  try {
    const anim = target.animate(
      [
        { opacity: 0, scale: String(fromScale) },
        { opacity: 1, scale: "1" }
      ],
      { duration: durationMs, easing, fill: "none" }
    );
    trackAnimation(target, anim);
  } catch {
    // 忽略测试桩或不可动画宿主异常
  }

  if (mask && typeof mask.animate === "function") {
    try {
      const maskAnim = mask.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: Math.min(durationMs, 160), easing: "ease-out", fill: "none" }
      );
      trackAnimation(mask, maskAnim);
    } catch {}
  }

  return resolvedRect;
}

export function animateTriggerExit(options: TriggerExitOptions): void {
  const {
    target,
    host = null,
    mask = null,
    trigger,
    fallbackOrigin = "top right",
    toScale = 0.94,
    durationMs = TRIGGER_EXIT_DURATION_MS,
    easing = TRIGGER_EXIT_EASING,
    onFinish
  } = options;

  const closingEl = host ?? target;
  cancelTriggerExit(closingEl);

  const resolvedRect = captureTriggerRect(trigger) ?? savedTriggerRects.get(target) ?? null;
  if (resolvedRect) {
    savedTriggerRects.set(target, resolvedRect);
  }

  let startOpacity = "1";
  let startScale = "1";
  if (typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    const computed = window.getComputedStyle(target);
    if (computed.opacity) startOpacity = computed.opacity;
    if (computed.scale && computed.scale !== "none") startScale = computed.scale;
  }

  let startMaskOpacity = "1";
  if (mask && typeof window !== "undefined" && typeof window.getComputedStyle === "function") {
    const maskComputed = window.getComputedStyle(mask);
    if (maskComputed.opacity) startMaskOpacity = maskComputed.opacity;
  }

  cancelActiveAnimations(target);
  cancelActiveAnimations(mask);
  applyElementTriggerOrigin(target, resolvedRect, fallbackOrigin);

  if (prefersReducedMotion() || typeof target.animate !== "function") {
    onFinish();
    return;
  }

  closingEl.setAttribute("data-biliscript-closing", "1");
  closingEl.inert = true;
  closingEl.style.pointerEvents = "none";
  closingEl.setAttribute("aria-hidden", "true");

  let settled = false;
  let fallbackTimer = 0;
  const animations: Animation[] = [];

  const finish = () => {
    if (settled) return;
    settled = true;
    if (fallbackTimer) {
      window.clearTimeout(fallbackTimer);
      fallbackTimer = 0;
    }
    exitCleanups.delete(closingEl);
    for (const anim of animations) {
      try {
        anim.cancel();
      } catch {}
    }
    activeAnimations.delete(target);
    if (mask) activeAnimations.delete(mask);
    closingEl.removeAttribute("data-biliscript-closing");
    closingEl.inert = false;
    closingEl.style.pointerEvents = "";
    closingEl.removeAttribute("aria-hidden");
    onFinish();
  };

  exitCleanups.set(closingEl, finish);

  try {
    const anim = target.animate(
      [
        { opacity: Number(startOpacity) || 1, scale: startScale },
        { opacity: 0, scale: String(toScale) }
      ],
      { duration: durationMs, easing, fill: "forwards" }
    );
    animations.push(anim);
    trackAnimation(target, anim);
    if (mask && typeof mask.animate === "function") {
      const maskAnim = mask.animate(
        [{ opacity: Number(startMaskOpacity) || 1 }, { opacity: 0 }],
        { duration: durationMs, easing: "ease-out", fill: "forwards" }
      );
      animations.push(maskAnim);
      trackAnimation(mask, maskAnim);
    }
    anim.addEventListener("finish", finish, { once: true });
    anim.addEventListener("cancel", finish, { once: true });
    fallbackTimer = window.setTimeout(finish, durationMs + 80);
  } catch {
    finish();
  }
}
