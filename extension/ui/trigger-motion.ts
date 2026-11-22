import { logWarn } from "../shared/logging.js";

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

function cancelAnimations(animations: readonly Animation[]): void {
  for (const anim of animations) {
    try {
      anim.cancel();
    } catch (error) {
      logWarn("[BILISCRIPT] trigger-motion animation cancel failed", error);
    }
  }
}

function cancelActiveAnimations(el: HTMLElement | null | undefined): void {
  if (!el) return;
  const list = activeAnimations.get(el);
  if (list) {
    cancelAnimations(list);
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

function startAnimation(
  el: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions
): Animation | null {
  try {
    const anim = el.animate(keyframes, options);
    trackAnimation(el, anim);
    return anim;
  } catch (error) {
    logWarn("[BILISCRIPT] trigger-motion animation failed", error);
    return null;
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

  startAnimation(
    target,
    [
      { opacity: 0, scale: String(fromScale) },
      { opacity: 1, scale: "1" }
    ],
    { duration: durationMs, easing, fill: "none" }
  );

  if (mask && typeof mask.animate === "function") {
    startAnimation(
      mask,
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: Math.min(durationMs, 160), easing: "ease-out", fill: "none" }
    );
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
    cancelAnimations(animations);
    activeAnimations.delete(target);
    if (mask) activeAnimations.delete(mask);
    closingEl.removeAttribute("data-biliscript-closing");
    closingEl.inert = false;
    closingEl.style.pointerEvents = "";
    closingEl.removeAttribute("aria-hidden");
    onFinish();
  };

  exitCleanups.set(closingEl, finish);

  const anim = startAnimation(
    target,
    [
      { opacity: Number(startOpacity) || 1, scale: startScale },
      { opacity: 0, scale: String(toScale) }
    ],
    { duration: durationMs, easing, fill: "forwards" }
  );
  if (!anim) {
    finish();
    return;
  }
  animations.push(anim);
  if (mask && typeof mask.animate === "function") {
    const maskAnim = startAnimation(
      mask,
      [{ opacity: Number(startMaskOpacity) || 1 }, { opacity: 0 }],
      { duration: durationMs, easing: "ease-out", fill: "forwards" }
    );
    if (maskAnim) {
      animations.push(maskAnim);
    }
  }
  anim.addEventListener("finish", finish, { once: true });
  anim.addEventListener("cancel", finish, { once: true });
  fallbackTimer = window.setTimeout(finish, durationMs + 80);
}
