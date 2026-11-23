import { prefersReducedMotion } from "./trigger-motion.js";

export type NavDirection = "forward" | "backward";

export const NAV_ENTER_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";
export const NAV_EXIT_EASING = "cubic-bezier(0.4, 0, 1, 1)";
export const NAV_ENTER_DURATION_MS = 220;
export const NAV_BACK_ENTER_DURATION_MS = 200;
export const NAV_EXIT_DURATION_MS = 110;
export const NAV_ENTER_DELAY_MS = 24;
export const NAV_TITLE_DURATION_MS = 180;
export const NAV_REDUCED_DURATION_MS = 120;

export interface NavOutgoingLayer {
  el: HTMLElement;
  distancePx?: number;
  offsetY?: number;
}

export interface NavIncomingLayer {
  el: HTMLElement;
  distancePx?: number;
}

export interface HorizontalLayerTransitionOptions {
  scope: HTMLElement;
  direction: NavDirection;
  outgoing?: readonly NavOutgoingLayer[];
  incoming?: readonly NavIncomingLayer[];
  title?: HTMLElement | null;
  durationEnterMs?: number;
  durationExitMs?: number;
  enterDelayMs?: number;
  onExitDone?: () => void;
  onAllDone?: () => void;
}

const activeScopeCleanups = new WeakMap<HTMLElement, () => void>();

export function supportsWebAnimations(el: HTMLElement | null | undefined): boolean {
  return Boolean(el && typeof el.animate === "function");
}

export function cancelNavTransition(scope: HTMLElement | null | undefined): void {
  if (!scope) return;
  const cleanup = activeScopeCleanups.get(scope);
  if (cleanup) {
    activeScopeCleanups.delete(scope);
    cleanup();
  }
}

export function animateNavFadeIn(
  el: HTMLElement | null | undefined,
  durationMs = NAV_REDUCED_DURATION_MS
): Animation | null {
  if (!el || !supportsWebAnimations(el)) {
    return null;
  }
  try {
    return el.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: durationMs, easing: "ease-out", fill: "backwards" }
    );
  } catch {
    return null;
  }
}

function safeCancel(animations: readonly Animation[]): void {
  for (const anim of animations) {
    try {
      anim.cancel();
    } catch {}
  }
}

function waitForAnimations(animations: readonly Animation[], fallbackMs: number, onSettled: () => void): () => void {
  const valid = animations.filter(
    (anim): anim is Animation => Boolean(anim && typeof anim.addEventListener === "function")
  );
  if (valid.length === 0) {
    onSettled();
    return () => {};
  }
  let remaining = valid.length;
  let settled = false;
  let timer = 0;

  const done = () => {
    if (settled) return;
    settled = true;
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    onSettled();
  };

  const onOne = () => {
    remaining -= 1;
    if (remaining <= 0) {
      done();
    }
  };

  for (const anim of valid) {
    anim.addEventListener("finish", onOne, { once: true });
    anim.addEventListener("cancel", onOne, { once: true });
  }
  timer = window.setTimeout(done, fallbackMs);

  return () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    settled = true;
  };
}

export function runHorizontalLayerTransition(options: HorizontalLayerTransitionOptions): boolean {
  const {
    scope,
    direction,
    outgoing = [],
    incoming = [],
    title = null,
    durationEnterMs = direction === "forward" ? NAV_ENTER_DURATION_MS : NAV_BACK_ENTER_DURATION_MS,
    durationExitMs = NAV_EXIT_DURATION_MS,
    enterDelayMs = NAV_ENTER_DELAY_MS,
    onExitDone,
    onAllDone
  } = options;

  cancelNavTransition(scope);

  const probe = incoming[0]?.el ?? outgoing[0]?.el ?? scope;
  if (!supportsWebAnimations(probe)) {
    onExitDone?.();
    onAllDone?.();
    return false;
  }

  let exitSettled = false;
  let allSettled = false;
  const outgoingAnims: Animation[] = [];
  const incomingAnims: Animation[] = [];
  let cancelExitWait = () => {};
  let cancelAllWait = () => {};

  const settleExit = () => {
    if (exitSettled) return;
    exitSettled = true;
    cancelExitWait();
    onExitDone?.();
    safeCancel(outgoingAnims);
    outgoingAnims.length = 0;
  };

  const settleAll = () => {
    if (allSettled) return;
    allSettled = true;
    cancelAllWait();
    if (activeScopeCleanups.get(scope) === cleanup) {
      activeScopeCleanups.delete(scope);
    }
    settleExit();
    onAllDone?.();
  };

  const cleanup = () => {
    cancelExitWait();
    cancelAllWait();
    settleExit();
    safeCancel(incomingAnims);
    incomingAnims.length = 0;
    settleAll();
  };

  if (prefersReducedMotion(probe)) {
    settleExit();
    for (const item of incoming) {
      const anim = animateNavFadeIn(item.el, NAV_REDUCED_DURATION_MS);
      if (anim) incomingAnims.push(anim);
    }
    if (incomingAnims.length === 0) {
      settleAll();
      return false;
    }
    activeScopeCleanups.set(scope, cleanup);
    cancelAllWait = waitForAnimations(incomingAnims, NAV_REDUCED_DURATION_MS + 80, settleAll);
    return true;
  }

  const exitSign = direction === "forward" ? -1 : 1;
  const enterSign = direction === "forward" ? 1 : -1;

  for (const item of outgoing) {
    if (!supportsWebAnimations(item.el)) continue;
    const dist = item.distancePx ?? (direction === "forward" ? 14 : 22);
    const y = item.offsetY ?? 0;
    try {
      const anim = item.el.animate(
        [
          { opacity: 1, transform: `translate3d(0, ${y}px, 0)` },
          { opacity: 0, transform: `translate3d(${exitSign * dist}px, ${y}px, 0)` }
        ],
        { duration: durationExitMs, easing: NAV_EXIT_EASING, fill: "forwards" }
      );
      if (anim) outgoingAnims.push(anim);
    } catch {}
  }

  for (const item of incoming) {
    if (!supportsWebAnimations(item.el)) continue;
    const dist = item.distancePx ?? (direction === "forward" ? 22 : 14);
    try {
      const anim = item.el.animate(
        [
          { opacity: 0, transform: `translate3d(${enterSign * dist}px, 0, 0)` },
          { opacity: 1, transform: "translate3d(0, 0, 0)" }
        ],
        {
          duration: durationEnterMs,
          delay: enterDelayMs,
          easing: NAV_ENTER_EASING,
          fill: "backwards"
        }
      );
      if (anim) incomingAnims.push(anim);
    } catch {}
  }

  if (title && supportsWebAnimations(title)) {
    const titleX = enterSign * 10;
    try {
      const titleAnim = title.animate(
        [
          { opacity: 0.35, transform: `translate3d(${titleX}px, 0, 0)` },
          { opacity: 1, transform: "translate3d(0, 0, 0)" }
        ],
        { duration: NAV_TITLE_DURATION_MS, easing: NAV_ENTER_EASING, fill: "none" }
      );
      if (titleAnim) incomingAnims.push(titleAnim);
    } catch {}
  }

  if (outgoingAnims.length === 0 && incomingAnims.length === 0) {
    settleAll();
    return false;
  }

  activeScopeCleanups.set(scope, cleanup);

  if (outgoingAnims.length > 0) {
    cancelExitWait = waitForAnimations(outgoingAnims, durationExitMs + 80, settleExit);
  } else {
    settleExit();
  }

  if (incomingAnims.length > 0) {
    cancelAllWait = waitForAnimations(
      incomingAnims,
      enterDelayMs + durationEnterMs + 100,
      settleAll
    );
  } else {
    settleAll();
  }

  return true;
}
