import { state } from "../core/state.js";
import { activeById } from "../shared/active-host.js";
import { formatClock } from "../shared/clock-text.js";
import { resolveNodeWindow } from "../shared/cross-doc.js";
import { ids } from "./state.js";

export type SubtitleFollowMode = "auto" | "manual";

export interface SubtitleScrollFollowDeps {
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface ProgrammaticScrollOptions {
  behavior: "auto" | "smooth";
  startTop?: number;
  targetTop?: number;
  idleMs?: number;
  maxMs?: number;
}

export interface SubtitleScrollFollowMachine {
  getMode(): SubtitleFollowMode;
  isManualPaused(): boolean;
  isProgrammaticScrolling(): boolean;
  pauseManual(durationMs?: number): void;
  resumeAuto(): void;
  resetForVideoSwitch(): void;
  guardLayoutReset(): void;
  beginProgrammaticScroll(options: ProgrammaticScrollOptions): number;
  attachProgrammaticScrollPromise(token: number, result: unknown): void;
  finishProgrammaticScroll(token?: number): void;
  handleWheel(input: { deltaY: number; deltaX?: number; canScroll: boolean }): boolean;
  handleTouchMove(input: { canScroll: boolean }): boolean;
  handleKeyDown(input: { key: string; canScroll: boolean; editable?: boolean }): boolean;
  handlePointerDown(input: {
    isDirectContainer: boolean;
    isScrollbar: boolean;
    canScroll: boolean;
  }): boolean;
  handlePointerUp(): void;
  handleScroll(input?: { scrollTop?: number }): boolean;
  handleScrollEnd(): void;
  dispose(): void;
}

const DEFAULT_AUTO_IDLE_MS = 120;
const DEFAULT_AUTO_MAX_MS = 240;
const DEFAULT_SMOOTH_IDLE_MS = 180;
const DEFAULT_SMOOTH_MAX_MS = 2000;
const OPPOSITE_SCROLL_TOLERANCE_PX = 12;
const OVERSHOOT_SCROLL_TOLERANCE_PX = 24;

const SCROLL_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " "
]);

export const FOLLOW_BUTTON_LABEL = "回到当前播放";

export function createSubtitleScrollFollowMachine(
  deps: SubtitleScrollFollowDeps = {}
): SubtitleScrollFollowMachine {
  const now = deps.now ?? (() => Date.now());
  const scheduleTimeout =
    deps.setTimeout ??
    ((cb: () => void, ms: number) => globalThis.setTimeout(cb, ms));
  const cancelTimeout =
    deps.clearTimeout ??
    ((handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle));

  let manualPauseUntil = 0;
  let programmaticActive = false;
  let programmaticToken = 0;
  let programmaticStartTop: number | null = null;
  let programmaticTargetTop: number | null = null;
  let programmaticLastScrollTop: number | null = null;
  let programmaticIdleMs = DEFAULT_SMOOTH_IDLE_MS;
  let programmaticUntil = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let maxTimer: ReturnType<typeof setTimeout> | null = null;
  let pointerDownOnContainer = false;

  function clearProgrammaticTimers(): void {
    if (idleTimer !== null) {
      cancelTimeout(idleTimer);
      idleTimer = null;
    }
    if (maxTimer !== null) {
      cancelTimeout(maxTimer);
      maxTimer = null;
    }
  }

  function clearProgrammaticState(invalidateToken: boolean): void {
    clearProgrammaticTimers();
    if (invalidateToken) {
      programmaticToken += 1;
    }
    programmaticActive = false;
    programmaticStartTop = null;
    programmaticTargetTop = null;
    programmaticLastScrollTop = null;
    programmaticUntil = 0;
  }

  function armIdleTimer(token: number, idleMs: number): void {
    if (idleTimer !== null) {
      cancelTimeout(idleTimer);
      idleTimer = null;
    }
    idleTimer = scheduleTimeout(() => {
      finishProgrammaticScroll(token);
    }, idleMs);
  }

  function getMode(): SubtitleFollowMode {
    if (manualPauseUntil > 0 && now() >= manualPauseUntil) {
      manualPauseUntil = 0;
    }
    return manualPauseUntil > 0 && now() < manualPauseUntil ? "manual" : "auto";
  }

  function isManualPaused(): boolean {
    return getMode() === "manual";
  }

  function isProgrammaticScrolling(): boolean {
    if (programmaticActive && programmaticUntil > 0 && now() > programmaticUntil) {
      clearProgrammaticState(true);
      return false;
    }
    return programmaticActive;
  }

  function pauseManual(durationMs?: number): void {
    const nextUntil =
      durationMs !== undefined ? now() + Math.max(0, durationMs) : Number.POSITIVE_INFINITY;
    const hadProgrammatic = programmaticActive;
    if (hadProgrammatic) {
      clearProgrammaticState(true);
    }
    if (manualPauseUntil === nextUntil && !hadProgrammatic) {
      return;
    }
    manualPauseUntil = nextUntil;
  }

  function resumeAuto(): void {
    pointerDownOnContainer = false;
    if (manualPauseUntil === 0) {
      return;
    }
    manualPauseUntil = 0;
  }

  function resetForVideoSwitch(): void {
    pointerDownOnContainer = false;
    manualPauseUntil = 0;
    clearProgrammaticState(true);
  }

  function beginProgrammaticScroll(options: ProgrammaticScrollOptions): number {
    clearProgrammaticTimers();
    programmaticToken += 1;
    const token = programmaticToken;
    const isAuto = options.behavior === "auto";
    const idleMs = options.idleMs ?? (isAuto ? DEFAULT_AUTO_IDLE_MS : DEFAULT_SMOOTH_IDLE_MS);
    const maxMs = Math.max(idleMs, options.maxMs ?? (isAuto ? DEFAULT_AUTO_MAX_MS : DEFAULT_SMOOTH_MAX_MS));

    programmaticActive = true;
    programmaticStartTop = typeof options.startTop === "number" && Number.isFinite(options.startTop)
      ? options.startTop
      : null;
    programmaticTargetTop = typeof options.targetTop === "number" && Number.isFinite(options.targetTop)
      ? options.targetTop
      : null;
    programmaticLastScrollTop = programmaticStartTop;
    programmaticIdleMs = idleMs;
    programmaticUntil = now() + maxMs;

    armIdleTimer(token, idleMs);
    maxTimer = scheduleTimeout(() => {
      finishProgrammaticScroll(token);
    }, maxMs);
    return token;
  }

  function attachProgrammaticScrollPromise(token: number, result: unknown): void {
    if (
      !result ||
      (typeof result !== "object" && typeof result !== "function") ||
      typeof (result as PromiseLike<unknown>).then !== "function"
    ) {
      return;
    }
    const finish = () => {
      finishProgrammaticScroll(token);
    };
    void Promise.resolve(result).then(finish, finish);
  }

  function finishProgrammaticScroll(token?: number): void {
    if (!programmaticActive) {
      return;
    }
    if (token !== undefined && token !== programmaticToken) {
      return;
    }
    clearProgrammaticState(false);
  }

  function guardLayoutReset(): void {
    if (getMode() !== "auto") {
      return;
    }
    beginProgrammaticScroll({
      behavior: "auto",
      idleMs: DEFAULT_AUTO_IDLE_MS,
      maxMs: DEFAULT_AUTO_MAX_MS
    });
  }

  function handleWheel(input: { deltaY: number; deltaX?: number; canScroll: boolean }): boolean {
    if (!input.canScroll) {
      return false;
    }
    if (input.deltaY === 0 && (input.deltaX ?? 0) === 0) {
      return false;
    }
    pauseManual();
    return true;
  }

  function handleTouchMove(input: { canScroll: boolean }): boolean {
    if (!input.canScroll) {
      return false;
    }
    pauseManual();
    return true;
  }

  function handleKeyDown(input: { key: string; canScroll: boolean; editable?: boolean }): boolean {
    if (input.editable || !input.canScroll || !SCROLL_KEYS.has(input.key)) {
      return false;
    }
    pauseManual();
    return true;
  }

  function handlePointerDown(input: {
    isDirectContainer: boolean;
    isScrollbar: boolean;
    canScroll: boolean;
  }): boolean {
    pointerDownOnContainer = input.isDirectContainer && input.canScroll;
    if (input.isScrollbar && input.canScroll) {
      pauseManual();
      return true;
    }
    return false;
  }

  function handlePointerUp(): void {
    pointerDownOnContainer = false;
  }

  function isDivergedFromProgrammaticScroll(scrollTop: number): boolean {
    if (programmaticStartTop === null || programmaticTargetTop === null) {
      return false;
    }
    const expectedDelta = programmaticTargetTop - programmaticStartTop;
    if (Math.abs(expectedDelta) <= 4) {
      return Math.abs(scrollTop - programmaticTargetTop) > OVERSHOOT_SCROLL_TOLERANCE_PX;
    }
    const direction = expectedDelta > 0 ? 1 : -1;
    const prevTop = programmaticLastScrollTop ?? programmaticStartTop;
    const step = scrollTop - prevTop;
    if (step * direction < -OPPOSITE_SCROLL_TOLERANCE_PX) {
      return true;
    }
    const minBound = Math.min(programmaticStartTop, programmaticTargetTop) - OVERSHOOT_SCROLL_TOLERANCE_PX;
    const maxBound = Math.max(programmaticStartTop, programmaticTargetTop) + OVERSHOOT_SCROLL_TOLERANCE_PX;
    return scrollTop < minBound || scrollTop > maxBound;
  }

  function handleScroll(input?: { scrollTop?: number }): boolean {
    if (pointerDownOnContainer) {
      pauseManual();
      return true;
    }
    if (isProgrammaticScrolling()) {
      const scrollTop = input?.scrollTop;
      if (typeof scrollTop === "number" && Number.isFinite(scrollTop)) {
        if (isDivergedFromProgrammaticScroll(scrollTop)) {
          pauseManual();
          return true;
        }
        programmaticLastScrollTop = scrollTop;
      }
      const remaining = Math.max(0, programmaticUntil - now());
      if (remaining > 0) {
        armIdleTimer(programmaticToken, Math.min(programmaticIdleMs, remaining));
      }
      return false;
    }
    pauseManual();
    return true;
  }

  function handleScrollEnd(): void {
    finishProgrammaticScroll();
  }

  function dispose(): void {
    pointerDownOnContainer = false;
    clearProgrammaticTimers();
  }

  return {
    getMode,
    isManualPaused,
    isProgrammaticScrolling,
    pauseManual,
    resumeAuto,
    resetForVideoSwitch,
    guardLayoutReset,
    beginProgrammaticScroll,
    attachProgrammaticScrollPromise,
    finishProgrammaticScroll,
    handleWheel,
    handleTouchMove,
    handleKeyDown,
    handlePointerDown,
    handlePointerUp,
    handleScroll,
    handleScrollEnd,
    dispose
  };
}

export const subtitleScrollFollow = createSubtitleScrollFollowMachine();

export function isElementScrollable(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  return element.clientHeight > 0 && element.scrollHeight > element.clientHeight + 1;
}

export function isPointerOnVerticalScrollbar(element: HTMLElement, clientX: number): boolean {
  const scrollbarWidth = element.offsetWidth - element.clientWidth;
  if (scrollbarWidth <= 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0) {
    return false;
  }
  const view = resolveNodeWindow(element);
  const isRtl =
    typeof view !== "undefined" &&
    typeof view.getComputedStyle === "function" &&
    view.getComputedStyle(element).direction === "rtl";
  if (isRtl) {
    return clientX >= rect.left && clientX <= rect.left + scrollbarWidth;
  }
  return clientX >= rect.left + element.clientWidth && clientX <= rect.right;
}

export function formatFollowButtonClock(seconds: unknown): string | null {
  if (seconds === undefined || seconds === null || seconds === "") {
    return null;
  }
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return null;
  }
  return formatClock(numeric, { hours: "auto" });
}

function resolveCurrentPlaybackSeconds(overrideSeconds?: number): number | undefined {
  if (overrideSeconds !== undefined) {
    return overrideSeconds;
  }
  const video = state.reader.readingVideoEl;
  if (!video) {
    return undefined;
  }
  const numeric = Number(video.currentTime);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

export function projectReaderFollowUi(
  mode: SubtitleFollowMode = subtitleScrollFollow.getMode(),
  overrideSeconds?: number
): void {
  const readingView = activeById(ids.readingView);
  if (readingView && readingView.getAttribute("data-biliscript-reader-follow") !== mode) {
    readingView.setAttribute("data-biliscript-reader-follow", mode);
  }

  if (mode !== "manual") {
    return;
  }

  const followBtn = activeById(ids.readingFollowBtn);
  if (!followBtn) {
    return;
  }
  const clock = formatFollowButtonClock(resolveCurrentPlaybackSeconds(overrideSeconds));
  const timeEl = followBtn.querySelector<HTMLElement>(".biliscript-reading-follow-time");
  const metaEl = followBtn.querySelector<HTMLElement>(".biliscript-reading-follow-meta");

  if (timeEl && metaEl) {
    if (clock) {
      if (metaEl.hidden) {
        metaEl.hidden = false;
      }
      if (timeEl.textContent !== clock) {
        timeEl.textContent = clock;
      }
    } else if (!metaEl.hidden) {
      metaEl.hidden = true;
      timeEl.textContent = "";
    }
    return;
  }

  const nextText = clock ? `${FOLLOW_BUTTON_LABEL} · ${clock}` : FOLLOW_BUTTON_LABEL;
  if (followBtn.textContent !== nextText) {
    followBtn.textContent = nextText;
  }
}
