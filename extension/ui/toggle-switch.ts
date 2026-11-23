import { onActiveHostChange } from "../shared/active-host.js";
import {
  dispatchCrossDocEvent,
  isHtmlElement,
  isNode,
  prefersActiveReducedMotion,
  resolveNodeDocument,
  resolveNodeWindow,
  safeRemoveListener,
  scheduleActiveAnimationFrame,
  type ActiveAnimationFrameHandle,
} from "../shared/cross-doc.js";
import { trySetPointerCapture } from "../shared/dom-utils.js";
import { ensureToggleSwitchStyles } from "../shared/style-injector.js";

ensureToggleSwitchStyles();

const SPRING_STIFFNESS = 600;
const SPRING_DAMPING = 34;
const MAX_FRAME_DT = 1 / 30;
const VELOCITY_PROJECTION_MS = 120;
const DRAG_THRESHOLD_PX = 3;

const FALLBACK_TRAVEL_PX = 16;

function prefersReducedMotion(target?: Element | null): boolean {
  return prefersActiveReducedMotion(target);
}

const shellOps = new WeakMap<HTMLInputElement, { sync: () => void }>();

export function syncToggleSwitch(input: HTMLInputElement): void {
  shellOps.get(input)?.sync();
}

export function initToggleSwitch(input: HTMLInputElement): void {
  if (input.dataset.toggleSwitchInitialized === "1") return;
  const track = input.nextElementSibling;
  if (!isHtmlElement(track) || !track.classList.contains("biliscript-toggle-track")) {
    return;
  }
  const thumb = track.firstElementChild;
  if (!isHtmlElement(thumb)) return;
  input.dataset.toggleSwitchInitialized = "1";
  const label = input.closest("label");

  const travel = (): number => {
    const measured = track.clientWidth - thumb.getBoundingClientRect().width - 3.2;
    return measured > 0 ? measured : FALLBACK_TRAVEL_PX;
  };

  let pos = input.checked ? travel() : 0;
  let vel = 0;
  let rafHandle: ActiveAnimationFrameHandle | null = null;

  const apply = (): void => {
    thumb.style.transform = pos === 0 ? "none" : `translateX(${pos}px)`;
  };
  apply();

  const settle = (): void => {
    if (rafHandle) {
      rafHandle.cancel();
      rafHandle = null;
    }
  };

  const springTo = (target: number, initialVel = 0): void => {
    settle();
    if (prefersReducedMotion(input)) {
      pos = target;
      vel = 0;
      apply();
      return;
    }
    pos = Math.min(Math.max(pos, 0), travel());
    vel = initialVel;
    let last = performance.now();
    const tick = (now: number): void => {
      const dt = Math.min((now - last) / 1000, MAX_FRAME_DT);
      last = now;
      const accel = -SPRING_STIFFNESS * (pos - target) - SPRING_DAMPING * vel;
      vel += accel * dt;
      pos += vel * dt;
      apply();
      if (Math.abs(pos - target) < 0.05 && Math.abs(vel) < 5) {
        pos = target;
        vel = 0;
        apply();
        rafHandle = null;
        return;
      }
      rafHandle = scheduleActiveAnimationFrame(tick, resolveNodeWindow(input));
    };
    rafHandle = scheduleActiveAnimationFrame(tick, resolveNodeWindow(input));
  };

  const sync = (): void => springTo(input.checked ? travel() : 0);

  let dragHandledChange = false;
  input.addEventListener("change", () => {
    if (dragHandledChange) return;
    sync();
  });

  let dragging = false;
  let moved = false;
  let startClientX = 0;
  let startPos = 0;
  let cachedTravel: number | null = null;
  let dragObserver: ResizeObserver | null = null;
  let dragWin: Window | null = null;
  let stopHostWatch: (() => void) | null = null;
  const onDragResize = (): void => {
    if (dragging) {
      cachedTravel = travel();
    }
  };
  let samples: { x: number; t: number }[] = [];

  const teardownDragTracking = (): void => {
    stopHostWatch?.();
    stopHostWatch = null;
    safeRemoveListener(dragWin, "resize", onDragResize);
    dragWin = null;
    if (dragObserver) {
      try {
        dragObserver.disconnect();
      } catch {
      }
      dragObserver = null;
    }
  };

  const releaseVelocity = (): number => {
    const end = samples[samples.length - 1];
    const prev = samples[samples.length - 2];
    if (!end || !prev) return 0;
    const dt = end.t - prev.t;
    if (dt <= 0) return 0;
    return (end.x - prev.x) / dt;
  };

  track.addEventListener("pointerdown", (e) => {
    if (input.disabled) return;
    dragging = true;
    moved = false;
    startClientX = e.clientX;
    startPos = pos;
    samples = [{ x: e.clientX, t: e.timeStamp }];
    settle();
    cachedTravel = travel();
    dragWin = resolveNodeWindow(input);
    dragWin?.addEventListener("resize", onDragResize);
    const Obs =
      (dragWin as (Window & { ResizeObserver?: typeof ResizeObserver }) | null)?.ResizeObserver ??
      (typeof ResizeObserver !== "undefined" ? ResizeObserver : undefined);
    if (Obs) {
      dragObserver = new Obs(onDragResize);
      dragObserver.observe(track);
    }
    stopHostWatch?.();
    stopHostWatch = onActiveHostChange(() => {
      if (!dragging) return;
      dragging = false;
      teardownDragTracking();
      const currentTravel = cachedTravel ?? travel();
      cachedTravel = null;
      if (moved) {
        springTo(input.checked ? currentTravel : 0);
      }
    });
    trySetPointerCapture(track, e.pointerId);
  });

  track.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startClientX;
    if (!moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
    moved = true;
    const currentTravel = cachedTravel ?? travel();
    pos = Math.min(Math.max(startPos + dx, 0), currentTravel);
    apply();
    samples.push({ x: e.clientX, t: e.timeStamp });
    if (samples.length > 4) samples.shift();
  });

  const finishDrag = (e: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    teardownDragTracking();
    const currentTravel = cachedTravel ?? travel();
    cachedTravel = null;
    if (!moved) return;
    if (e.type === "pointercancel") {
      springTo(input.checked ? currentTravel : 0);
      return;
    }
    samples.push({ x: e.clientX ?? samples[samples.length - 1]?.x ?? 0, t: e.timeStamp });
    const vPxMs = releaseVelocity();
    const range = currentTravel;
    const projected = pos + vPxMs * VELOCITY_PROJECTION_MS;
    const target = projected >= range / 2 ? range : 0;
    if (e.type === "pointerup") {
      const clickDoc = resolveNodeDocument(input);
      let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        safeRemoveListener(clickDoc, "click", suppress, true);
        if (cleanupTimer !== null) {
          clearTimeout(cleanupTimer);
          cleanupTimer = null;
        }
      };
      const suppress = (clickEvent: Event): void => {
        cleanup();
        if (label && isNode(clickEvent.target) && label.contains(clickEvent.target)) {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        }
      };
      clickDoc.addEventListener("click", suppress, { capture: true });
      cleanupTimer = setTimeout(cleanup, 0);
    }
    const nextChecked = target === range;
    if (input.checked !== nextChecked) {
      dragHandledChange = true;
      input.checked = nextChecked;
      dispatchCrossDocEvent(input, "change", { bubbles: true });
      dragHandledChange = false;
    }
    springTo(target, vPxMs * 1000);
  };

  track.addEventListener("pointerup", finishDrag);
  track.addEventListener("pointercancel", finishDrag);

  shellOps.set(input, { sync });
}
