import { ensureToggleSwitchStyles } from "../shared/style-injector.js";

ensureToggleSwitchStyles();

const SPRING_STIFFNESS = 600;
const SPRING_DAMPING = 34;
const MAX_FRAME_DT = 1 / 30;
const VELOCITY_PROJECTION_MS = 120;
const DRAG_THRESHOLD_PX = 3;

const FALLBACK_TRAVEL_PX = 16;

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

const shellOps = new WeakMap<HTMLInputElement, { sync: () => void }>();

export function syncToggleSwitch(input: HTMLInputElement): void {
  shellOps.get(input)?.sync();
}

export function initToggleSwitch(input: HTMLInputElement): void {
  if (input.dataset.toggleSwitchInitialized === "1") return;
  const track = input.nextElementSibling;
  if (!(track instanceof HTMLElement) || !track.classList.contains("biliscript-toggle-track")) {
    return;
  }
  const thumb = track.firstElementChild;
  if (!(thumb instanceof HTMLElement)) return;
  input.dataset.toggleSwitchInitialized = "1";
  const label = input.closest("label");

  const travel = (): number => {
    const measured = track.clientWidth - thumb.getBoundingClientRect().width - 3.2;
    return measured > 0 ? measured : FALLBACK_TRAVEL_PX;
  };

  let pos = input.checked ? travel() : 0;
  let vel = 0;
  let raf = 0;

  const apply = (): void => {
    thumb.style.transform = pos === 0 ? "none" : `translateX(${pos}px)`;
  };
  apply();

  const settle = (): void => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const springTo = (target: number, initialVel = 0): void => {
    settle();
    if (prefersReducedMotion()) {
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
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
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
  const onDragResize = (): void => {
    if (dragging) {
      cachedTravel = travel();
    }
  };
  let samples: { x: number; t: number }[] = [];

  const releaseVelocity = (endEvent: Event): number => {
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
    window.addEventListener("resize", onDragResize);
    if (typeof ResizeObserver !== "undefined") {
      dragObserver = new ResizeObserver(onDragResize);
      dragObserver.observe(track);
    }
    try {
      track.setPointerCapture?.(e.pointerId);
    } catch {
    }
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

  const finishDrag = (e: Event): void => {
    if (!dragging) return;
    dragging = false;
    window.removeEventListener("resize", onDragResize);
    if (dragObserver) {
      dragObserver.disconnect();
      dragObserver = null;
    }
    const currentTravel = cachedTravel ?? travel();
    cachedTravel = null;
    if (!moved) return;
    if (e.type === "pointercancel") {
      springTo(input.checked ? currentTravel : 0);
      return;
    }
    samples.push({ x: (e as PointerEvent).clientX ?? samples[samples.length - 1]?.x ?? 0, t: e.timeStamp });
    const vPxMs = releaseVelocity(e);
    const range = currentTravel;
    const projected = pos + vPxMs * VELOCITY_PROJECTION_MS;
    const target = projected >= range / 2 ? range : 0;
    if (e.type === "pointerup") {
      let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
      const cleanup = (): void => {
        document.removeEventListener("click", suppress, true);
        if (cleanupTimer !== null) {
          clearTimeout(cleanupTimer);
          cleanupTimer = null;
        }
      };
      const suppress = (clickEvent: Event): void => {
        cleanup();
        if (label && clickEvent.target instanceof Node && label.contains(clickEvent.target)) {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();
        }
      };
      document.addEventListener("click", suppress, { capture: true });
      cleanupTimer = setTimeout(cleanup, 0);
    }
    const nextChecked = target === range;
    if (input.checked !== nextChecked) {
      dragHandledChange = true;
      input.checked = nextChecked;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      dragHandledChange = false;
    }
    springTo(target, vPxMs * 1000);
  };

  track.addEventListener("pointerup", finishDrag);
  track.addEventListener("pointercancel", finishDrag);

  shellOps.set(input, { sync });
}
