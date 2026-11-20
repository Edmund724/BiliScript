// 字幕精读列表自动跟随滚动交互状态机（reader 域共享叶子）。
//
// 职责：
// 1. 维护跟随模式（"auto" | "manual"）与手动暂停截止时间（缺省无限期，显式传
//    durationMs 时到期自动回归 "auto"，兼容既有测试与定时暂停调用）。
// 2. 区分「程序化 scrollTo / 列表重建复位」与「用户主动滚动」：
//    - 程序化滚动按代次 token 跟踪，优先消费现代浏览器 scrollTo/scrollIntoView
//      返回的 Promise 与容器 scrollend 事件，辅以滚动帧刷新空闲计时器 + 硬上限
//      兜底，避免固定 800ms 窗口在长距离平滑滚动时过早过期、短距离时过长阻塞；
//    - 被新滚动打断的旧 Promise 按代次丢弃，防止提前解除新滚动的保护。
// 3. 物理手势即时断跟：wheel / touchmove / 滚动条 pointerdown / 滚动按键在任何
//    时刻（含程序化平滑滚动途中）立即解除程序化锁并切回 manual，避免与用户抢滚动条；
//    滚动期间若 scrollTop 反向或越界偏离程序化目标，同样立即让位给用户。
// 4. 切集 / 关闭复位（resetForVideoSwitch）：清空暂停态、指针拖拽态与在途程序化
//    滚动代次，防止上一集的 manual 态或迟到的 scroll/Promise 污染新剧集。
//
// 依赖方向：只依赖 core/state、shared/clock-text 与 ./state，不 import sync /
// lifecycle / ui-renderer；仅在轮 B（懒加载 chunk 区）内由 subtitle-tab-ui、
// sync、lifecycle、view-render、subtitle-search 共享同一份实例，不进入常驻主包。

import { state } from "../core/state.js";
import { formatClock } from "../shared/clock-text.js";
import {
  ids,
  setManualScrollPaused,
  setProgrammaticScrollUntil
} from "./state.js";

export type SubtitleFollowMode = "auto" | "manual";

export interface SubtitleScrollFollowDeps {
  now?: () => number;
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
  onStateChange?: (snapshot: {
    mode: SubtitleFollowMode;
    manualPauseUntil: number;
    programmaticActive: boolean;
    programmaticUntil: number;
  }) => void;
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

  function emitStateChange(): void {
    deps.onStateChange?.({
      mode: getMode(),
      manualPauseUntil,
      programmaticActive,
      programmaticUntil
    });
  }

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
      deps.onStateChange?.({
        mode: "auto",
        manualPauseUntil: 0,
        programmaticActive,
        programmaticUntil
      });
    }
    return manualPauseUntil > 0 && now() < manualPauseUntil ? "manual" : "auto";
  }

  function isManualPaused(): boolean {
    return getMode() === "manual";
  }

  function isProgrammaticScrolling(): boolean {
    if (programmaticActive && programmaticUntil > 0 && now() > programmaticUntil) {
      clearProgrammaticState(true);
      emitStateChange();
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
    emitStateChange();
  }

  function resumeAuto(): void {
    pointerDownOnContainer = false;
    if (manualPauseUntil === 0) {
      return;
    }
    manualPauseUntil = 0;
    emitStateChange();
  }

  function resetForVideoSwitch(): void {
    pointerDownOnContainer = false;
    manualPauseUntil = 0;
    clearProgrammaticState(true);
    emitStateChange();
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
    emitStateChange();
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
    emitStateChange();
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

// 生产共享单例：状态变更同步镜像回 reader/state.ts（保持既有导出与测试口径唯一真源）。
export const subtitleScrollFollow = createSubtitleScrollFollowMachine({
  onStateChange(snapshot) {
    setManualScrollPaused(snapshot.manualPauseUntil);
    setProgrammaticScrollUntil(snapshot.programmaticActive ? snapshot.programmaticUntil : 0);
  }
});

export function isElementScrollable(element: HTMLElement | null): boolean {
  if (!element) {
    return false;
  }
  // jsdom 默认 clientHeight=0 且 scrollHeight=0；真机可见容器 clientHeight>0 时
  // 严格判定是否真有溢出，避免短字幕列表上悬停滚轮误弹回位胶囊。
  return element.clientHeight === 0 || element.scrollHeight > element.clientHeight + 1;
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
  const isRtl =
    typeof window !== "undefined" &&
    typeof window.getComputedStyle === "function" &&
    window.getComputedStyle(element).direction === "rtl";
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
  const readingView = document.getElementById(ids.readingView);
  if (readingView && readingView.getAttribute("data-biliscript-reader-follow") !== mode) {
    readingView.setAttribute("data-biliscript-reader-follow", mode);
  }

  if (mode !== "manual") {
    return;
  }

  const followBtn = document.getElementById(ids.readingFollowBtn);
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
