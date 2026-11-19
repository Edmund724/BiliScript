// extension/live/player-interpret.ts
// 播放器实时字幕翻译全链路模块：双语/单语显示行判定、全屏字幕浮层、仿原生字幕菜单、
// 快捷按钮状态同步，以及与播放器/扩展设置/页面生命周期的自包含接线。

import { state } from "../core/state.js";
import { getSettings } from "../core/runtime.js";
import { getFullscreenHost } from "../bilibili/fullscreen.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { ensureInterpretSubtitleStyles } from "../shared/style-injector.js";
import { watchStorageKeys } from "../shared/watch-storage-keys.js";
import { subscribeReaderPresenter } from "../reader/reader-bus.js";
import {
  INTERPRET_SUBTITLE_SCALE_DEFAULT,
  INTERPRET_SUBTITLE_SCALE_MAX,
  INTERPRET_SUBTITLE_SCALE_MIN,
  LIVE_INTERPRET_LATIN_TARGET_LANGS,
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  normalizeInterpretFontScale,
  stepInterpretFontScale,
  type BilingualDisplayOrder,
  type InterpretSubtitleDisplayMode,
  type LiveInterpretTargetLang
} from "./interpret-subtitle-preferences.js";
import {
  clampInterpretPositionRatio,
  loadInterpretPositionRatio,
  saveInterpretPositionRatio
} from "./interpret-position-persistence.js";
import {
  classifySubtitleTrack,
  findManualForeignTrackForAiRefine,
  findTrackByRef,
  getAvailableTargetLangOptions,
  isLoadableNativeTrack,
  isMonolingualNativeTracks,
  resolveTargetLang
} from "../subtitle/selection.js";
import {
  createInterpretSessionController,
  type InterpretAiRefineMode,
  type InterpretSessionController
} from "./interpret-session-controller.js";
import {
  createPlayerNoticeHost,
  findVideoPlayerHost,
  notifyPlayerOrConsumer,
  setPlayerNoticeConsumer,
  sharedPlayerNotice,
  showPlayerToast,
  type PlayerNoticeHost
} from "./player-notice.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "../ui/trigger-motion.js";

ensureInterpretSubtitleStyles();

export type { InterpretSubtitleDisplayMode } from "./interpret-subtitle-preferences.js";

export interface InterpretSubtitleLines {
  showOriginal: boolean;
  showTranslation: boolean;
}

type ScriptCategory = "han" | "kana" | "hangul" | "latin" | "cyrillic" | "greek";
const TARGET_SCRIPTS: Record<string, readonly ScriptCategory[]> = {
  zh: ["han"],
  ja: ["han", "kana"],
  ko: ["hangul"],
  ru: ["cyrillic"],
  el: ["greek"]
};

const SCRIPT_PATTERNS: ReadonlyArray<readonly [ScriptCategory, RegExp]> = [
  ["han", /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/],
  ["kana", /[\u3040-\u30ff\u31f0-\u31ff]/],
  ["hangul", /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/],
  ["latin", /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/],
  ["cyrillic", /[\u0400-\u052f]/],
  ["greek", /[\u0370-\u03ff\u1f00-\u1fff]/]
];

function dominantScript(text: string): ScriptCategory | null {
  const counts = new Map<ScriptCategory, number>();
  for (const char of text) {
    for (const [category, pattern] of SCRIPT_PATTERNS) {
      if (!pattern.test(char)) continue;
      counts.set(category, (counts.get(category) || 0) + 1);
      break;
    }
  }

  let dominant: ScriptCategory | null = null;
  let max = 0;
  for (const [category] of SCRIPT_PATTERNS) {
    const count = counts.get(category) || 0;
    if (count > max) {
      dominant = category;
      max = count;
    }
  }
  return dominant;
}

export function resolveInterpretSubtitleLines(
  sourceText: string,
  targetLang: LiveInterpretTargetLang,
  mode: InterpretSubtitleDisplayMode
): InterpretSubtitleLines {
  if (mode === "translation") return { showOriginal: false, showTranslation: true };
  if (mode === "bilingual") return { showOriginal: true, showTranslation: true };

  const sourceScript = dominantScript(sourceText);
  const sameScript = sourceScript !== null && TARGET_SCRIPTS[targetLang]?.includes(sourceScript) === true;
  const showOriginal = LIVE_INTERPRET_LATIN_TARGET_LANGS.has(targetLang) || !sameScript;
  return { showOriginal, showTranslation: true };
}

export interface InterpretSubtitleOverlayDeps {
  getPlayerHost: () => HTMLElement | null;
  getTargetLang: () => LiveInterpretTargetLang;
  getDisplayMode: () => InterpretSubtitleDisplayMode;
  getDisplayOrder?: () => BilingualDisplayOrder;
  getFontScale?: () => number;
  getBlurSecondary?: () => boolean;
  loadPositionRatio?: () => Promise<number | null>;
  savePositionRatio?: (ratio: number) => void;
  noticeHost?: PlayerNoticeHost;
}

export const DEFAULT_INTERPRET_SUBTITLE_BOTTOM_PX = 40;
export const DEFAULT_CONTROL_BAR_CLEARANCE_PX = 68;
export const INTERPRET_DRAG_THRESHOLD_PX = 4;

export interface InterpretOverlayVerticalPositionInput {
  playerClientHeight: number;
  windowHeight?: number;
  positionRatio: number | null;
  controlsVisible: boolean;
  controlBarHeight?: number;
  isHovered?: boolean;
  frozenBottomPx?: number | null;
}

export function computeInterpretSubtitleBottomPx(
  input: InterpretOverlayVerticalPositionInput
): number {
  if (
    input.isHovered &&
    input.frozenBottomPx !== null &&
    input.frozenBottomPx !== undefined &&
    Number.isFinite(input.frozenBottomPx)
  ) {
    return input.frozenBottomPx;
  }

  const hostHeight =
    Number.isFinite(input.playerClientHeight) && input.playerClientHeight > 0
      ? input.playerClientHeight
      : 0;
  const clampedRatio = clampInterpretPositionRatio(input.positionRatio, null);
  const baseBottom =
    clampedRatio !== null && hostHeight > 0
      ? clampedRatio * hostHeight
      : DEFAULT_INTERPRET_SUBTITLE_BOTTOM_PX;
  const clearance =
    Number.isFinite(input.controlBarHeight) && (input.controlBarHeight ?? 0) > 0
      ? Math.ceil(input.controlBarHeight!) + 16
      : DEFAULT_CONTROL_BAR_CLEARANCE_PX;
  const targetBottom = input.controlsVisible ? Math.max(baseBottom, clearance) : baseBottom;

  if (hostHeight <= 0) {
    return Math.max(12, Math.round(targetBottom));
  }

  const minBottom = Math.round(hostHeight * 0.04);
  const ratioMaxBottom = Math.round(hostHeight * 0.85);
  const windowHeight =
    Number.isFinite(input.windowHeight) && (input.windowHeight ?? 0) > 0
      ? input.windowHeight!
      : 0;
  const maxBottom = Math.max(
    minBottom,
    windowHeight > 0 ? Math.min(ratioMaxBottom, hostHeight - windowHeight - 8) : ratioMaxBottom
  );
  return Math.round(Math.min(maxBottom, Math.max(minBottom, targetBottom)));
}

export function computeInterpretPositionRatio(
  bottomPx: number,
  playerClientHeight: number
): number | null {
  if (!Number.isFinite(bottomPx) || !Number.isFinite(playerClientHeight) || playerClientHeight <= 0) {
    return null;
  }
  return clampInterpretPositionRatio(bottomPx / playerClientHeight, null);
}

export function detectPlayerControlBarState(playerContainer: Element | null): {
  visible: boolean;
  height: number;
} {
  if (!playerContainer) {
    return { visible: false, height: 0 };
  }
  const hiddenByContainer =
    playerContainer.classList.contains("bpx-state-no-cursor") ||
    playerContainer.getAttribute("data-ctrl-hidden") === "true";
  const controlEl = playerContainer.querySelector<HTMLElement>(
    ".bpx-player-control-wrap, .bpx-player-control-entity, .bpx-player-control-bottom"
  );
  if (controlEl) {
    if (
      hiddenByContainer ||
      controlEl.hidden ||
      controlEl.getAttribute("aria-hidden") === "true" ||
      controlEl.classList.contains("is-hidden")
    ) {
      return { visible: false, height: 0 };
    }
    const measuredHeight =
      controlEl.getBoundingClientRect?.().height || controlEl.clientHeight || 0;
    return { visible: true, height: measuredHeight };
  }
  if (!hiddenByContainer && playerContainer.getAttribute("data-ctrl-hidden") === "false") {
    return { visible: true, height: 0 };
  }
  return { visible: false, height: 0 };
}

const NATIVE_SUBTITLE_TAKEOVER_ATTR = "data-biliscript-subtitle-takeover";

export function syncNativePlayerSubtitleTakeover(
  active: boolean,
  explicitHost?: HTMLElement | null
): void {
  if (!active) {
    document
      .querySelectorAll<HTMLElement>(`[${NATIVE_SUBTITLE_TAKEOVER_ATTR}]`)
      .forEach((node) => node.removeAttribute(NATIVE_SUBTITLE_TAKEOVER_ATTR));
    return;
  }
  const hosts = [
    explicitHost ?? null,
    getFullscreenHost(),
    document.querySelector<HTMLElement>(".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap")
  ].filter((node): node is HTMLElement => node instanceof HTMLElement);
  for (const host of hosts) {
    if (host.getAttribute(NATIVE_SUBTITLE_TAKEOVER_ATTR) !== "true") {
      host.setAttribute(NATIVE_SUBTITLE_TAKEOVER_ATTR, "true");
    }
  }
}

export interface InterpretSubtitleOverlay {
  clear(): void;
  clearForSeek(): void;
  unmount(): void;
  showNotice(message: string, autoHideMs?: number): void;
  setSubtitle(original: string, translation: string, expectedGeneration?: number): void;
  setSessionGeneration(generation: number): void;
  syncAppearance(): void;
  syncPosition(): void;
  isHovered(): boolean;
  getPositionRatio(): number | null;
  getContainerElement(): HTMLElement | null;
  getElement(): HTMLElement | null;
  dispose(): void;
}

export function createInterpretSubtitleOverlay(
  deps: InterpretSubtitleOverlayDeps
): InterpretSubtitleOverlay {
  const loadRatio = deps.loadPositionRatio ?? loadInterpretPositionRatio;
  const saveRatio = deps.savePositionRatio ?? saveInterpretPositionRatio;

  let containerEl: HTMLElement | null = null;
  let rootEl: HTMLElement | null = null;
  let originalEl: HTMLElement | null = null;
  let translationEl: HTMLElement | null = null;
  const noticeHost =
    deps.noticeHost ?? createPlayerNoticeHost(() => getFullscreenHost() || deps.getPlayerHost());

  let activeSessionGeneration = 0;
  let lastOriginal = "";
  let lastTranslation = "";
  let savedPositionRatio: number | null = null;
  let positionRatioLoaded = false;
  let positionRatioRequested = false;
  let hasUserDragged = false;
  let hovered = false;
  let frozenBottomPx: number | null = null;
  let currentBottomPx = DEFAULT_INTERPRET_SUBTITLE_BOTTOM_PX;

  let controlObserver: MutationObserver | null = null;
  let observedContainer: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let observedWrap: HTMLElement | null = null;
  let windowResizeBound = false;

  let activePointerId: number | null = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartBottomPx = DEFAULT_INTERPRET_SUBTITLE_BOTTOM_PX;
  let dragMoved = false;
  let suppressClickHandler: ((event: MouseEvent) => void) | null = null;
  let suppressClickTimer: ReturnType<typeof setTimeout> | null = null;

  function resolvePlayerContainer(): HTMLElement | null {
    const base = getFullscreenHost() || deps.getPlayerHost();
    if (!base) return null;
    if (base.matches?.(".bpx-player-container")) {
      return base;
    }
    return (
      base.querySelector<HTMLElement>(".bpx-player-container") ||
      base.closest<HTMLElement>(".bpx-player-container") ||
      base
    );
  }

  function getMountHost(): HTMLElement | null {
    const base = getFullscreenHost() || deps.getPlayerHost();
    if (!base) return null;
    if (base.matches?.(".bpx-player-video-wrap")) {
      return base;
    }
    return base.querySelector<HTMLElement>(".bpx-player-video-wrap") || base;
  }

  function measureHostHeight(): number {
    const host = containerEl?.parentElement || getMountHost();
    if (!host) return 0;
    return host.clientHeight || host.getBoundingClientRect?.().height || 0;
  }

  function measureWindowHeight(): number {
    if (!rootEl) return 0;
    return rootEl.getBoundingClientRect?.().height || rootEl.clientHeight || 0;
  }

  function clearClickSuppression(): void {
    if (suppressClickHandler) {
      document.removeEventListener("click", suppressClickHandler, true);
      suppressClickHandler = null;
    }
    if (suppressClickTimer !== null) {
      clearTimeout(suppressClickTimer);
      suppressClickTimer = null;
    }
  }

  function suppressNextClick(): void {
    clearClickSuppression();
    suppressClickHandler = (event: MouseEvent) => {
      clearClickSuppression();
      const target = event.target;
      if (target instanceof Node && rootEl?.contains(target)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", suppressClickHandler, true);
    suppressClickTimer = setTimeout(clearClickSuppression, 0);
  }

  function stopDragListeners(): void {
    activePointerId = null;
    if (typeof window !== "undefined") {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    }
  }

  function cancelDrag(): void {
    stopDragListeners();
    dragMoved = false;
    rootEl?.classList.remove("is-dragging");
    clearClickSuppression();
  }

  function clampBottomInContainer(rawBottomPx: number): number {
    const hostHeight = measureHostHeight();
    if (hostHeight <= 0) {
      return Math.max(12, Math.round(rawBottomPx));
    }
    const minBottom = Math.round(hostHeight * 0.04);
    const ratioMaxBottom = Math.round(hostHeight * 0.85);
    const windowHeight = measureWindowHeight();
    const maxBottom = Math.max(
      minBottom,
      windowHeight > 0 ? Math.min(ratioMaxBottom, hostHeight - windowHeight - 8) : ratioMaxBottom
    );
    return Math.round(Math.min(maxBottom, Math.max(minBottom, rawBottomPx)));
  }

  function syncPosition(): void {
    if (!rootEl) return;
    const playerContainer = resolvePlayerContainer();
    const controlState = detectPlayerControlBarState(playerContainer);
    const nextBottomPx = computeInterpretSubtitleBottomPx({
      playerClientHeight: measureHostHeight(),
      windowHeight: measureWindowHeight(),
      positionRatio: savedPositionRatio,
      controlsVisible: controlState.visible,
      controlBarHeight: controlState.height,
      isHovered: hovered,
      frozenBottomPx
    });
    currentBottomPx = nextBottomPx;
    const nextBottomCss = `${nextBottomPx}px`;
    if (rootEl.style.bottom !== nextBottomCss) {
      rootEl.style.bottom = nextBottomCss;
    }
  }

  function onPointerEnter(): void {
    if (hovered) return;
    hovered = true;
    frozenBottomPx = currentBottomPx;
    rootEl?.classList.add("is-hovered");
  }

  function onPointerLeave(): void {
    if (!hovered) return;
    hovered = false;
    frozenBottomPx = null;
    rootEl?.classList.remove("is-hovered");
    syncPosition();
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || activePointerId !== null || !rootEl) return;
    activePointerId = event.pointerId;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    dragStartBottomPx = currentBottomPx;
    dragMoved = false;
    if (typeof window !== "undefined") {
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      window.addEventListener("pointercancel", onPointerCancel);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (activePointerId === null || event.pointerId !== activePointerId || !rootEl) return;
    const dx = event.clientX - dragStartX;
    const dy = event.clientY - dragStartY;
    if (!dragMoved && Math.hypot(dx, dy) <= INTERPRET_DRAG_THRESHOLD_PX) {
      return;
    }
    if (!dragMoved) {
      dragMoved = true;
      rootEl.classList.add("is-dragging");
    }
    const nextBottomPx = clampBottomInContainer(dragStartBottomPx - dy);
    currentBottomPx = nextBottomPx;
    if (hovered) {
      frozenBottomPx = nextBottomPx;
    }
    rootEl.style.bottom = `${nextBottomPx}px`;
  }

  function finishDrag(event: PointerEvent | null, shouldPersist: boolean): void {
    if (activePointerId === null) return;
    if (event && event.pointerId !== activePointerId) return;
    const wasMoved = dragMoved;
    stopDragListeners();
    dragMoved = false;
    rootEl?.classList.remove("is-dragging");
    if (!wasMoved || !shouldPersist) {
      return;
    }
    hasUserDragged = true;
    if (hovered) {
      frozenBottomPx = currentBottomPx;
    }
    const ratio = computeInterpretPositionRatio(currentBottomPx, measureHostHeight());
    if (ratio !== null) {
      savedPositionRatio = ratio;
      positionRatioLoaded = true;
      saveRatio(ratio);
    }
    suppressNextClick();
  }

  function onPointerUp(event: PointerEvent): void {
    finishDrag(event, true);
  }

  function onPointerCancel(event: PointerEvent): void {
    finishDrag(event, false);
  }

  function onWindowResize(): void {
    if (containerEl?.isConnected) {
      syncPosition();
    }
  }

  function bindObservers(host: HTMLElement): void {
    const playerContainer = resolvePlayerContainer();
    if (observedContainer !== playerContainer) {
      controlObserver?.disconnect();
      controlObserver = null;
      observedContainer = playerContainer;
      if (playerContainer && typeof MutationObserver !== "undefined") {
        controlObserver = new MutationObserver(() => {
          syncPosition();
        });
        controlObserver.observe(playerContainer, {
          attributes: true,
          attributeFilter: ["class", "data-ctrl-hidden", "data-screen", "hidden", "aria-hidden"]
        });
        const controlEl = playerContainer.querySelector<HTMLElement>(
          ".bpx-player-control-wrap, .bpx-player-control-entity, .bpx-player-control-bottom"
        );
        if (controlEl) {
          controlObserver.observe(controlEl, {
            attributes: true,
            attributeFilter: ["class", "hidden", "aria-hidden", "data-state"]
          });
        }
      }
    }

    if (observedWrap !== host) {
      resizeObserver?.disconnect();
      resizeObserver = null;
      observedWrap = host;
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          syncPosition();
        });
        resizeObserver.observe(host);
      }
    }

    if (!windowResizeBound && typeof window !== "undefined") {
      window.addEventListener("resize", onWindowResize);
      windowResizeBound = true;
    }
  }

  function disconnectObservers(): void {
    controlObserver?.disconnect();
    controlObserver = null;
    observedContainer = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    observedWrap = null;
    if (windowResizeBound && typeof window !== "undefined") {
      window.removeEventListener("resize", onWindowResize);
      windowResizeBound = false;
    }
  }

  function ensurePositionRatioLoaded(): void {
    if (positionRatioLoaded || positionRatioRequested) return;
    positionRatioRequested = true;
    void Promise.resolve(loadRatio())
      .then((ratio) => {
        positionRatioLoaded = true;
        if (!hasUserDragged && ratio !== null) {
          savedPositionRatio = clampInterpretPositionRatio(ratio, null);
          if (containerEl?.isConnected) {
            syncPosition();
          }
        }
      })
      .catch(() => {
        positionRatioLoaded = true;
      });
  }

  function ensureMounted(): HTMLElement | null {
    const host = getMountHost();
    if (!host) return null;
    ensurePositionRatioLoaded();

    if (containerEl?.isConnected && rootEl?.isConnected) {
      if (containerEl.parentElement !== host) host.appendChild(containerEl);
      bindObservers(host);
      return rootEl;
    }

    const container = document.createElement("div");
    container.className = "biliscript-interpret-subtitle-container";
    container.setAttribute("data-biliscript-extension-node", "interpret-subtitle-container");
    container.hidden = true;

    const root = document.createElement("div");
    root.id = "biliscript-interpret-subtitle-overlay";
    root.className = "biliscript-interpret-subtitle-overlay";
    root.setAttribute("data-biliscript-extension-node", "interpret-subtitle-overlay");
    root.setAttribute("aria-live", "off");
    root.hidden = true;

    originalEl = document.createElement("div");
    originalEl.className = "biliscript-interpret-subtitle-original";
    translationEl = document.createElement("div");
    translationEl.className = "biliscript-interpret-subtitle-translation";
    root.append(originalEl, translationEl);
    container.appendChild(root);
    host.appendChild(container);

    root.addEventListener("pointerenter", onPointerEnter);
    root.addEventListener("pointerleave", onPointerLeave);
    root.addEventListener("pointerdown", onPointerDown);

    containerEl = container;
    rootEl = root;
    bindObservers(host);
    syncPosition();
    return root;
  }

  function applySubtitlePresentation(original: string, translation: string): void {
    if (!containerEl || !rootEl || !originalEl || !translationEl) return;
    const order = deps.getDisplayOrder?.() || "original-first";
    const expectedFirst = order === "translation-first" ? translationEl : originalEl;
    const expectedSecond = order === "translation-first" ? originalEl : translationEl;
    if (rootEl.firstElementChild !== expectedFirst) {
      rootEl.insertBefore(expectedFirst, expectedSecond);
    }

    const lines = resolveInterpretSubtitleLines(
      original,
      deps.getTargetLang(),
      deps.getDisplayMode()
    );
    const showOriginal = lines.showOriginal && Boolean(original.trim());
    const showTranslation = lines.showTranslation && Boolean(translation.trim());
    const nextRootHidden = !showOriginal && !showTranslation;

    const isBilingualLineMode = lines.showOriginal && lines.showTranslation;
    const blurSecondary = Boolean(deps.getBlurSecondary?.());
    expectedFirst.setAttribute("data-subtitle-role", "primary");
    expectedSecond.setAttribute(
      "data-subtitle-role",
      isBilingualLineMode ? "secondary" : "primary"
    );
    const nextBlurAttr = isBilingualLineMode && blurSecondary ? "true" : "false";
    if (rootEl.getAttribute("data-blur-secondary") !== nextBlurAttr) {
      rootEl.setAttribute("data-blur-secondary", nextBlurAttr);
    }

    const scale = normalizeInterpretFontScale(deps.getFontScale?.() ?? INTERPRET_SUBTITLE_SCALE_DEFAULT);
    const scaleValue = String(scale / 100);
    if (containerEl.style.getPropertyValue("--biliscript-interpret-font-scale") !== scaleValue) {
      containerEl.style.setProperty("--biliscript-interpret-font-scale", scaleValue);
    }

    if (originalEl.textContent !== original) originalEl.textContent = original;
    if (translationEl.textContent !== translation) translationEl.textContent = translation;
    if (originalEl.hidden !== !showOriginal) originalEl.hidden = !showOriginal;
    if (translationEl.hidden !== !showTranslation) translationEl.hidden = !showTranslation;
    if (rootEl.hidden !== nextRootHidden) rootEl.hidden = nextRootHidden;
    if (containerEl.hidden !== nextRootHidden) containerEl.hidden = nextRootHidden;
  }

  function clearCurrent(): void {
    lastOriginal = "";
    lastTranslation = "";
    if (originalEl && originalEl.textContent !== "") originalEl.textContent = "";
    if (translationEl && translationEl.textContent !== "") translationEl.textContent = "";
    if (originalEl && !originalEl.hidden) originalEl.hidden = true;
    if (translationEl && !translationEl.hidden) translationEl.hidden = true;
    if (rootEl && !rootEl.hidden) rootEl.hidden = true;
    if (containerEl && !containerEl.hidden) containerEl.hidden = true;
  }

  function clear(): void {
    clearCurrent();
  }

  function clearForSeek(): void {
    clearCurrent();
  }

  function unmount(): void {
    cancelDrag();
    disconnectObservers();
    hovered = false;
    frozenBottomPx = null;
    lastOriginal = "";
    lastTranslation = "";
    if (rootEl) {
      rootEl.removeEventListener("pointerenter", onPointerEnter);
      rootEl.removeEventListener("pointerleave", onPointerLeave);
      rootEl.removeEventListener("pointerdown", onPointerDown);
    }
    containerEl?.remove();
    containerEl = null;
    rootEl = null;
    originalEl = null;
    translationEl = null;
  }

  function showNotice(message: string, autoHideMs = 6000): void {
    noticeHost.show(message, autoHideMs);
  }

  function setSubtitle(
    original: string,
    translation: string,
    expectedGeneration?: number
  ): void {
    if (expectedGeneration !== undefined && expectedGeneration !== activeSessionGeneration) {
      return;
    }
    lastOriginal = original;
    lastTranslation = translation;
    if (!original.trim() && !translation.trim() && (!containerEl || !containerEl.isConnected)) {
      return;
    }
    const root = ensureMounted();
    if (!root || !originalEl || !translationEl) return;
    applySubtitlePresentation(original, translation);
    syncPosition();
  }

  function setSessionGeneration(generation: number): void {
    activeSessionGeneration = generation;
  }

  function syncAppearance(): void {
    if (!containerEl?.isConnected || !rootEl) return;
    applySubtitlePresentation(lastOriginal, lastTranslation);
    syncPosition();
  }

  function dispose(): void {
    noticeHost.dispose();
    unmount();
  }

  return {
    clear,
    clearForSeek,
    unmount,
    showNotice,
    setSubtitle,
    setSessionGeneration,
    syncAppearance,
    syncPosition,
    isHovered: () => hovered,
    getPositionRatio: () => savedPositionRatio,
    getContainerElement: () => containerEl,
    getElement: () => rootEl,
    dispose
  };
}

export type InterpretSubtitleMenuSessionState = "idle" | "connecting" | "connected";

export type InterpretSubtitleMenuChoice =
  | { kind: "off" }
  | { kind: "native-bilingual" }
  | { kind: "ai-refine"; refineMode: "manual-refine" | "foreign-refine" }
  | { kind: "translation"; targetLang: LiveInterpretTargetLang }
  | { kind: "bilingual"; targetLang: LiveInterpretTargetLang }
  | { kind: "set-font-scale"; fontScale: number }
  | { kind: "toggle-blur-secondary"; blurSecondary: boolean };

export interface InterpretSubtitleMenuPreferences {
  targetLang: string;
  displayMode: string;
  sourceLan?: string;
  nativePairAvailable?: boolean;
  foreignRefineAvailable?: boolean;
  aiRefineMode?: InterpretAiRefineMode;
  fontScale?: number;
  blurSecondary?: boolean;
}

export interface InterpretSubtitleMenuDeps {
  getSessionState: () => InterpretSubtitleMenuSessionState;
  getPreferences: () => Promise<InterpretSubtitleMenuPreferences>;
  applyChoice: (choice: InterpretSubtitleMenuChoice) => Promise<void> | void;
}

const MENU_LANG_LABELS: Record<string, string> = {
  zh: "中文",
  en: "English",
  ja: "日本語",
  ko: "한국어",
  de: "Deutsch",
  fr: "Français",
  es: "Español",
  ru: "Русский",
  it: "Italiano",
  pt: "Português",
  tr: "Türkçe",
  el: "Ελληνικά",
  id: "Bahasa Indonesia",
  ms: "Bahasa Melayu"
};

const MENU_ID = "biliscript-interpret-menu";

let menuEl: HTMLElement | null = null;
let anchorEl: HTMLElement | null = null;
let triggerEl: HTMLElement | null = null;
let activeDeps: InterpretSubtitleMenuDeps | null = null;
let openGeneration = 0;

function langLabel(value: string): string {
  return MENU_LANG_LABELS[value] || value;
}

function normalizeTargetLang(value: string): LiveInterpretTargetLang {
  const found = LIVE_INTERPRET_TARGET_LANG_OPTIONS.find((option) => option.value === value);
  return (found ? found.value : "zh") as LiveInterpretTargetLang;
}

function buildAiBadge(): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "biliscript-interpret-menu-ai";
  badge.textContent = "AI";
  return badge;
}

function buildLangItem(targetLang: LiveInterpretTargetLang, selected: boolean): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "biliscript-interpret-menu-item";
  item.dataset.lang = targetLang;
  item.setAttribute("role", "menuitemradio");
  item.setAttribute("aria-checked", selected ? "true" : "false");
  const label = document.createElement("span");
  label.className = "biliscript-interpret-menu-item-label";
  label.textContent = langLabel(targetLang);
  item.append(label, buildAiBadge());
  if (selected) item.classList.add("is-selected");
  return item;
}

function buildMenuShell(): HTMLElement {
  const menu = document.createElement("div");
  menu.id = MENU_ID;
  menu.className = "biliscript-interpret-menu";
  menu.setAttribute("data-biliscript-extension-node", "interpret-subtitle-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "字幕");
  return menu;
}

async function renderMenu(): Promise<void> {
  const deps = activeDeps;
  if (!menuEl || !deps) return;
  const generation = ++openGeneration;
  const prefs = await deps.getPreferences();
  if (generation !== openGeneration || !menuEl || activeDeps !== deps) return;
  const sessionState = deps.getSessionState();

  const {
    targetLang,
    displayMode,
    sourceLan = "",
    nativePairAvailable = false,
    foreignRefineAvailable = false,
    aiRefineMode = "off",
    fontScale = INTERPRET_SUBTITLE_SCALE_DEFAULT,
    blurSecondary = false
  } = prefs;
  const currentScale = normalizeInterpretFontScale(fontScale);
  const running = sessionState === "connected" || sessionState === "connecting";
  const bilingualOn = running && displayMode !== "translation";
  const availableOptions = getAvailableTargetLangOptions(sourceLan);
  const currentLang = sourceLan
    ? resolveTargetLang(sourceLan, targetLang)
    : normalizeTargetLang(targetLang);
  const inNativePairMode = nativePairAvailable && aiRefineMode === "off";

  menuEl.replaceChildren();

  const title = document.createElement("div");
  title.className = "biliscript-interpret-menu-title";
  title.textContent = "字幕";
  menuEl.appendChild(title);

  const offItem = document.createElement("button");
  offItem.type = "button";
  offItem.className = "biliscript-interpret-menu-item";
  offItem.dataset.action = "off";
  offItem.setAttribute("role", "menuitemradio");
  offItem.setAttribute("aria-checked", running ? "false" : "true");
  const offLabel = document.createElement("span");
  offLabel.className = "biliscript-interpret-menu-item-label";
  offLabel.textContent = "关闭";
  offItem.appendChild(offLabel);
  if (!running) offItem.classList.add("is-selected");
  offItem.addEventListener("click", () => void choose({ kind: "off" }));
  menuEl.appendChild(offItem);

  if (nativePairAvailable) {
    const refineItem = document.createElement("button");
    refineItem.type = "button";
    refineItem.className = "biliscript-interpret-menu-item";
    if (aiRefineMode !== "off") {
      refineItem.dataset.action = "native-bilingual";
      const label = document.createElement("span");
      label.className = "biliscript-interpret-menu-item-label";
      label.textContent = "返回原生双轨配对";
      refineItem.appendChild(label);
      refineItem.addEventListener("click", () => void choose({ kind: "native-bilingual" }));
    } else {
      const mode = foreignRefineAvailable ? "foreign-refine" : "manual-refine";
      refineItem.dataset.action = mode;
      const label = document.createElement("span");
      label.className = "biliscript-interpret-menu-item-label";
      label.textContent = foreignRefineAvailable ? "基于原版外语轨 AI 精翻" : "改用 AI 重新精翻";
      refineItem.append(label, buildAiBadge());
      refineItem.addEventListener("click", () =>
        void choose({ kind: "ai-refine", refineMode: mode })
      );
    }
    menuEl.appendChild(refineItem);
  }

  if (!bilingualOn && !inNativePairMode) {
    const list = document.createElement("div");
    list.className = "biliscript-interpret-menu-langs";
    for (const option of availableOptions) {
      const selected = running && option.value === currentLang;
      const item = buildLangItem(option.value, selected);
      item.addEventListener("click", () => void choose({ kind: "translation", targetLang: option.value }));
      list.appendChild(item);
    }
    menuEl.appendChild(list);
  }

  const divider = document.createElement("div");
  divider.className = "biliscript-interpret-menu-divider";
  menuEl.appendChild(divider);

  const bilingualRow = document.createElement("div");
  bilingualRow.className = "biliscript-interpret-menu-bilingual-row";
  const bilingualLabel = document.createElement("span");
  bilingualLabel.className = "biliscript-interpret-menu-bilingual-label";
  bilingualLabel.textContent = "双语字幕";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "biliscript-interpret-menu-switch";
  toggle.setAttribute("role", "switch");
  toggle.setAttribute("aria-checked", bilingualOn ? "true" : "false");
  toggle.setAttribute("aria-label", "双语字幕");
  toggle.appendChild(document.createElement("span"));
  if (bilingualOn) toggle.classList.add("is-on");
  toggle.addEventListener("click", () => {
    if (inNativePairMode) {
      void choose(bilingualOn ? { kind: "off" } : { kind: "native-bilingual" });
      return;
    }
    void choose(
      bilingualOn
        ? { kind: "translation", targetLang: currentLang }
        : { kind: "bilingual", targetLang: currentLang }
    );
  });
  bilingualRow.append(bilingualLabel, toggle);
  menuEl.appendChild(bilingualRow);

  if (bilingualOn && !inNativePairMode) {
    const grid = document.createElement("div");
    grid.className = "biliscript-interpret-menu-grid";

    const primaryCol = document.createElement("div");
    primaryCol.className = "biliscript-interpret-menu-grid-col";
    const primaryTitle = document.createElement("div");
    primaryTitle.className = "biliscript-interpret-menu-grid-title";
    primaryTitle.textContent = "主字幕";
    primaryCol.appendChild(primaryTitle);
    for (const option of availableOptions) {
      const item = buildLangItem(option.value, option.value === currentLang);
      item.addEventListener("click", () =>
        void choose({ kind: "bilingual", targetLang: option.value })
      );
      primaryCol.appendChild(item);
    }

    const secondaryCol = document.createElement("div");
    secondaryCol.className = "biliscript-interpret-menu-grid-col";
    const secondaryTitle = document.createElement("div");
    secondaryTitle.className = "biliscript-interpret-menu-grid-title";
    secondaryTitle.textContent = "副字幕";
    secondaryCol.appendChild(secondaryTitle);
    const originalItem = document.createElement("div");
    originalItem.className = "biliscript-interpret-menu-item is-selected is-static";
    originalItem.setAttribute("aria-current", "true");
    const originalLabel = document.createElement("span");
    originalLabel.className = "biliscript-interpret-menu-item-label";
    originalLabel.textContent = "原文";
    originalItem.append(originalLabel, buildAiBadge());
    secondaryCol.appendChild(originalItem);

    grid.append(primaryCol, secondaryCol);
    menuEl.appendChild(grid);
  }

  const appearanceDivider = document.createElement("div");
  appearanceDivider.className = "biliscript-interpret-menu-divider";
  menuEl.appendChild(appearanceDivider);

  const blurRow = document.createElement("div");
  blurRow.className = "biliscript-interpret-menu-bilingual-row biliscript-interpret-menu-blur-row";
  const blurLabel = document.createElement("span");
  blurLabel.className = "biliscript-interpret-menu-bilingual-label";
  blurLabel.textContent = "模糊副字幕（悬停显字）";
  const blurToggle = document.createElement("button");
  blurToggle.type = "button";
  blurToggle.className = "biliscript-interpret-menu-switch biliscript-interpret-menu-blur-switch";
  blurToggle.dataset.action = "toggle-blur-secondary";
  blurToggle.setAttribute("role", "switch");
  blurToggle.setAttribute("aria-checked", blurSecondary ? "true" : "false");
  blurToggle.setAttribute("aria-label", "模糊副字幕（悬停显字）");
  blurToggle.appendChild(document.createElement("span"));
  if (blurSecondary) blurToggle.classList.add("is-on");
  blurToggle.addEventListener("click", () =>
    void choose({ kind: "toggle-blur-secondary", blurSecondary: !blurSecondary })
  );
  blurRow.append(blurLabel, blurToggle);
  menuEl.appendChild(blurRow);

  const scaleRow = document.createElement("div");
  scaleRow.className = "biliscript-interpret-menu-scale-row";
  const scaleLabel = document.createElement("span");
  scaleLabel.className = "biliscript-interpret-menu-bilingual-label";
  scaleLabel.textContent = "字幕大小";
  const stepper = document.createElement("div");
  stepper.className = "biliscript-interpret-menu-scale-stepper";

  const decBtn = document.createElement("button");
  decBtn.type = "button";
  decBtn.className = "biliscript-interpret-menu-scale-btn";
  decBtn.dataset.action = "scale-down";
  decBtn.textContent = "−";
  decBtn.setAttribute("aria-label", "减小字幕");
  decBtn.disabled = currentScale <= INTERPRET_SUBTITLE_SCALE_MIN;
  decBtn.addEventListener("click", () =>
    void choose({ kind: "set-font-scale", fontScale: stepInterpretFontScale(currentScale, -1) })
  );

  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "biliscript-interpret-menu-scale-value";
  resetBtn.dataset.action = "scale-reset";
  resetBtn.textContent = `${currentScale}%`;
  resetBtn.title = "点击恢复 100%";
  resetBtn.setAttribute("aria-label", `当前字幕缩放 ${currentScale}%，点击重置为 100%`);
  resetBtn.addEventListener("click", () =>
    void choose({ kind: "set-font-scale", fontScale: INTERPRET_SUBTITLE_SCALE_DEFAULT })
  );

  const incBtn = document.createElement("button");
  incBtn.type = "button";
  incBtn.className = "biliscript-interpret-menu-scale-btn";
  incBtn.dataset.action = "scale-up";
  incBtn.textContent = "+";
  incBtn.setAttribute("aria-label", "放大字幕");
  incBtn.disabled = currentScale >= INTERPRET_SUBTITLE_SCALE_MAX;
  incBtn.addEventListener("click", () =>
    void choose({ kind: "set-font-scale", fontScale: stepInterpretFontScale(currentScale, 1) })
  );

  stepper.append(decBtn, resetBtn, incBtn);
  scaleRow.append(scaleLabel, stepper);
  menuEl.appendChild(scaleRow);
}

async function choose(choice: InterpretSubtitleMenuChoice): Promise<void> {
  const deps = activeDeps;
  if (!deps) return;
  await deps.applyChoice(choice);
  await renderMenu();
}

function handleDocumentPointerDown(event: PointerEvent): void {
  if (!menuEl || !anchorEl) return;
  const target = event.target as Node | null;
  if (target && (menuEl.contains(target) || anchorEl.contains(target))) return;
  closeInterpretSubtitleMenu();
}

function handleDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeInterpretSubtitleMenu(true);
  }
}

export function isInterpretSubtitleMenuOpen(): boolean {
  return Boolean(menuEl?.isConnected);
}

export function closeInterpretSubtitleMenu(restoreFocus = false): void {
  const closingMenu = menuEl;
  const savedTrigger = triggerEl ?? anchorEl;
  const triggerToFocus = restoreFocus ? triggerEl : null;
  openGeneration += 1;
  menuEl = null;
  anchorEl = null;
  triggerEl?.setAttribute("aria-expanded", "false");
  triggerEl = null;
  activeDeps = null;
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
  document.removeEventListener("keydown", handleDocumentKeyDown, true);
  triggerToFocus?.focus();
  if (closingMenu) {
    if (closingMenu.style.opacity === "0") {
      closingMenu.remove();
    } else {
      animateTriggerExit({
        target: closingMenu,
        trigger: savedTrigger,
        fallbackOrigin: "bottom right",
        toScale: 0.95,
        durationMs: 120,
        onFinish: () => closingMenu.remove()
      });
    }
  }
}

export const closePlayerInterpretMenu = closeInterpretSubtitleMenu;

export async function openInterpretSubtitleMenu(
  anchor: HTMLElement,
  deps: InterpretSubtitleMenuDeps
): Promise<void> {
  closeInterpretSubtitleMenu();
  cancelTriggerExit(document.getElementById(MENU_ID));
  anchorEl = anchor;
  triggerEl = anchor.querySelector<HTMLElement>("#biliscript-player-interpret-quick-action, button");
  triggerEl?.setAttribute("aria-expanded", "true");
  activeDeps = deps;
  const currentMenu = buildMenuShell();
  currentMenu.style.opacity = "0";
  menuEl = currentMenu;
  anchor.appendChild(currentMenu);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleDocumentKeyDown, true);
  await renderMenu();
  if (menuEl !== currentMenu || !currentMenu.isConnected) {
    return;
  }
  currentMenu.style.opacity = "";
  animateTriggerEnter({
    target: currentMenu,
    trigger: triggerEl ?? anchor,
    fallbackOrigin: "bottom right",
    fromScale: 0.93,
    durationMs: 160
  });
}

export async function toggleInterpretSubtitleMenu(
  anchor: HTMLElement,
  deps: InterpretSubtitleMenuDeps
): Promise<void> {
  if (isInterpretSubtitleMenuOpen() && anchorEl === anchor) {
    closeInterpretSubtitleMenu();
    return;
  }
  await openInterpretSubtitleMenu(anchor, deps);
}

export async function syncInterpretSubtitleMenu(): Promise<void> {
  if (!isInterpretSubtitleMenuOpen()) return;
  await renderMenu();
}

export function syncPlayerInterpretQuickActionState(
  controller: InterpretSessionController | null,
  shouldShow: boolean
): void {
  const button = document.getElementById("biliscript-player-interpret-quick-action");
  const wrap = document.getElementById("biliscript-player-interpret-quick-action-wrap");
  if (!(button instanceof HTMLButtonElement) || !wrap) return;
  wrap.hidden = !shouldShow;
  button.hidden = !shouldShow;
  if (!shouldShow || !controller) return;

  const hasCc = state.clip.subtitles.some((track) => isLoadableNativeTrack(track));
  const buttonText = hasCc ? "双语" : "字幕";
  if (button.textContent !== buttonText) {
    button.textContent = buttonText;
  }

  const interpretState = controller.getState();
  const availability = controller.getAvailability();
  const active = interpretState === "connecting" || interpretState === "connected";
  const unavailable = !availability.ok && !active;
  button.classList.toggle("is-active", interpretState === "connected");
  button.classList.toggle("is-connecting", interpretState === "connecting");
  button.setAttribute("aria-pressed", String(interpretState === "connected"));
  button.setAttribute("aria-busy", String(interpretState === "connecting"));
  button.setAttribute("aria-disabled", String(unavailable));
  if (!availability.ok) {
    button.setAttribute("aria-description", availability.error);
  } else {
    button.removeAttribute("aria-description");
  }
  const label = hasCc
    ? interpretState === "connecting"
      ? "正在准备双语字幕..."
      : interpretState === "connected"
        ? "关闭双语字幕"
        : "双语字幕"
    : interpretState === "connecting"
      ? "正在连接实时翻译..."
      : interpretState === "connected"
        ? "关闭实时翻译"
        : "字幕";
  button.title = unavailable && !availability.ok ? availability.error : label;
  button.setAttribute("aria-label", label);
}

let interpretController: InterpretSessionController | null = null;
let interpretSessionGeneration = 0;
let unsubscribePresenter: (() => void) | null = null;
let unsubscribeStorageWatcher: (() => void) | null = null;
let pageHideBound = false;
let playerAiRefineMode: InterpretAiRefineMode = "off";
let playerAiRefineVideoKey = "";
let pendingSyncSettingsPatch: Record<string, unknown> = {};
let syncSettingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

const SYNC_SETTINGS_SAVE_DEBOUNCE_MS = 300;

function flushDebouncedSyncSettingsSave(): void {
  if (syncSettingsSaveTimer !== null) {
    clearTimeout(syncSettingsSaveTimer);
    syncSettingsSaveTimer = null;
  }
  const patch = pendingSyncSettingsPatch;
  if (Object.keys(patch).length === 0) {
    return;
  }
  pendingSyncSettingsPatch = {};
  void sendRuntimeMessage({ type: "save-settings", settings: patch }).catch(() => null);
}

function scheduleDebouncedSyncSettingsSave(patch: Record<string, unknown>): void {
  pendingSyncSettingsPatch = { ...pendingSyncSettingsPatch, ...patch };
  if (syncSettingsSaveTimer !== null) {
    clearTimeout(syncSettingsSaveTimer);
  }
  syncSettingsSaveTimer = setTimeout(() => {
    syncSettingsSaveTimer = null;
    flushDebouncedSyncSettingsSave();
  }, SYNC_SETTINGS_SAVE_DEBOUNCE_MS);
}

function getPlayerAiRefineMode(): InterpretAiRefineMode {
  const key = `${state.clip.bvid}|${state.clip.cid}`;
  if (playerAiRefineVideoKey !== key) {
    playerAiRefineVideoKey = key;
    playerAiRefineMode = "off";
  }
  return playerAiRefineMode;
}

function setPlayerAiRefineMode(mode: InterpretAiRefineMode): void {
  playerAiRefineVideoKey = `${state.clip.bvid}|${state.clip.cid}`;
  playerAiRefineMode = mode;
}

function resolveCurrentPlayerSourceLan(): string {
  const tracks = state.clip.subtitles || [];
  const current =
    findTrackByRef(tracks, {
      id: state.clip.selectedSubtitleId,
      url: state.clip.selectedSubtitleUrl
    }) ??
    tracks[0] ??
    null;
  if (!current) {
    return "";
  }
  if (classifySubtitleTrack(current) === "asr") {
    const asrLang = String(state.settings?.asrLanguage || "auto").trim().toLowerCase();
    return asrLang === "zh" || asrLang === "en" ? `asr-${asrLang}` : "";
  }
  return String(current.lan || "");
}

function shouldShowInterpret(): boolean {
  return state.clip.subtitleFetchState === "empty" || state.clip.subtitleFetchState === "ready";
}

const interpretSubtitleOverlay = createInterpretSubtitleOverlay({
  getPlayerHost: findVideoPlayerHost,
  noticeHost: sharedPlayerNotice,
  getTargetLang: () => state.settings?.liveInterpretTargetLang || "zh",
  getDisplayMode: () => state.settings?.liveInterpretDisplayMode || "auto",
  getDisplayOrder: () => state.settings?.bilingualDisplayOrder || "original-first",
  getFontScale: () =>
    normalizeInterpretFontScale(state.settings?.liveInterpretFontScale ?? INTERPRET_SUBTITLE_SCALE_DEFAULT),
  getBlurSecondary: () => state.settings?.liveInterpretBlurSecondary === true
});

export function showPlayerInterpretNotice(message: string, autoHideMs?: number): void {
  showPlayerToast(message, autoHideMs);
}

export function setPlayerInterpretNoticeConsumer(
  handler: ((message: string, autoHideMs?: number) => void) | null
): void {
  setPlayerNoticeConsumer(handler);
}

function onWindowPageHide(): void {
  disposePlayerInterpret();
}

function bindInterpretLifecycleListeners(): void {
  if (!unsubscribePresenter) {
    unsubscribePresenter = subscribeReaderPresenter((event) => {
      if (event.kind === "reset") {
        setPlayerAiRefineMode("off");
      }
      if (event.kind === "reset" || event.kind === "rerender" || event.kind === "subtitle-ready") {
        syncPlayerInterpretQuickAction();
        if (event.kind === "subtitle-ready" && shouldShowInterpret()) {
          void interpretController?.refreshAvailability();
        }
      }
    });
  }
  if (!unsubscribeStorageWatcher) {
    unsubscribeStorageWatcher = watchStorageKeys(
      (changes) => {
        let appearanceChanged = false;
        if (changes.bilingualDisplayOrder && typeof changes.bilingualDisplayOrder.newValue === "string") {
          state.patchSettings({
            bilingualDisplayOrder:
              changes.bilingualDisplayOrder.newValue === "translation-first"
                ? "translation-first"
                : "original-first"
          });
          appearanceChanged = true;
        }
        if (changes.liveInterpretFontScale) {
          state.patchSettings({
            liveInterpretFontScale: normalizeInterpretFontScale(changes.liveInterpretFontScale.newValue)
          });
          appearanceChanged = true;
        }
        if (changes.liveInterpretBlurSecondary) {
          state.patchSettings({
            liveInterpretBlurSecondary: changes.liveInterpretBlurSecondary.newValue === true
          });
          appearanceChanged = true;
        }
        if (appearanceChanged) {
          interpretSubtitleOverlay.syncAppearance();
          void syncInterpretSubtitleMenu();
        }
        void interpretController?.refreshAvailability();
      },
      {
        sync: [
          "asrProviders",
          "activeAsrProviderId",
          "aiProviders",
          "activeAiProviderId",
          "subtitleTranslateProviderId",
          "subtitleTranslateModel",
          "bilingualDisplayOrder",
          "liveInterpretFontScale",
          "liveInterpretBlurSecondary"
        ],
        local: ["asrProviderKeys", "aiProviderKeys"]
      }
    );
  }
  if (!pageHideBound && typeof window !== "undefined") {
    window.addEventListener("pagehide", onWindowPageHide);
    pageHideBound = true;
  }
}

function ensureInterpretController(): InterpretSessionController {
  if (!interpretController) {
    interpretController = createInterpretSessionController({
      getTargetLang: () =>
        resolveTargetLang(resolveCurrentPlayerSourceLan(), state.settings?.liveInterpretTargetLang || "zh"),
      getDisplayMode: () => state.settings?.liveInterpretDisplayMode || "auto",
      getAiRefineMode: getPlayerAiRefineMode,
      showNotice: (message, autoHideMs) => {
        notifyPlayerOrConsumer(message, autoHideMs);
      },
      setSubtitle: (original, translation) =>
        interpretSubtitleOverlay.setSubtitle(original, translation, interpretSessionGeneration),
      clearSubtitles: interpretSubtitleOverlay.unmount,
      clearSubtitlesOnSeek: interpretSubtitleOverlay.clearForSeek,
      onGenerationChange: (nextGeneration) => {
        interpretSessionGeneration = nextGeneration;
        interpretSubtitleOverlay.setSessionGeneration(nextGeneration);
      },
      onStateChange: (nextState) => {
        const active = nextState === "connecting" || nextState === "connected";
        syncNativePlayerSubtitleTakeover(active, findVideoPlayerHost());
        if (!active) {
          interpretSubtitleOverlay.unmount();
        }
        syncPlayerInterpretQuickAction();
      },
      onAvailabilityChange: syncPlayerInterpretQuickAction
    });
    bindInterpretLifecycleListeners();
    void interpretController.refreshAvailability();
  }
  return interpretController;
}

export function syncPlayerInterpretQuickAction(): void {
  bindInterpretLifecycleListeners();
  const shouldShow = shouldShowInterpret();
  const controller = shouldShow ? ensureInterpretController() : interpretController;
  syncPlayerInterpretQuickActionState(controller, shouldShow);
  if (!shouldShow) {
    closeInterpretSubtitleMenu();
  } else {
    void syncInterpretSubtitleMenu();
  }
}

export function getInterpretSessionState(): InterpretSubtitleMenuSessionState {
  return interpretController?.getState() ?? "idle";
}

export async function applyInterpretMenuChoice(
  choice: InterpretSubtitleMenuChoice
): Promise<void> {
  if (choice.kind === "set-font-scale") {
    const fontScale = normalizeInterpretFontScale(choice.fontScale);
    state.patchSettings({ liveInterpretFontScale: fontScale });
    interpretSubtitleOverlay.syncAppearance();
    scheduleDebouncedSyncSettingsSave({ liveInterpretFontScale: fontScale });
    return;
  }

  if (choice.kind === "toggle-blur-secondary") {
    const blurSecondary = Boolean(choice.blurSecondary);
    state.patchSettings({ liveInterpretBlurSecondary: blurSecondary });
    interpretSubtitleOverlay.syncAppearance();
    scheduleDebouncedSyncSettingsSave({ liveInterpretBlurSecondary: blurSecondary });
    return;
  }

  const controller = ensureInterpretController();
  if (choice.kind === "off") {
    setPlayerAiRefineMode("off");
    await controller.stop();
    syncNativePlayerSubtitleTakeover(false);
    interpretSubtitleOverlay.unmount();
    return;
  }

  if (choice.kind === "native-bilingual") {
    setPlayerAiRefineMode("off");
    const patch = { liveInterpretDisplayMode: "bilingual" as const };
    state.patchSettings(patch);
    void sendRuntimeMessage({ type: "save-settings", settings: patch }).catch(() => null);
    if (controller.getState() !== "idle") {
      await controller.stop();
    }
    await controller.start();
    return;
  }

  if (choice.kind === "ai-refine") {
    setPlayerAiRefineMode(choice.refineMode);
    const sourceLan =
      choice.refineMode === "foreign-refine"
        ? (findManualForeignTrackForAiRefine(state.clip.subtitles)?.lan ?? resolveCurrentPlayerSourceLan())
        : resolveCurrentPlayerSourceLan();
    const resolvedLang =
      choice.refineMode === "foreign-refine"
        ? "zh"
        : resolveTargetLang(sourceLan, state.settings?.liveInterpretTargetLang || "zh");
    const patch = {
      liveInterpretTargetLang: resolvedLang,
      liveInterpretDisplayMode: "bilingual" as const
    };
    state.patchSettings(patch);
    void sendRuntimeMessage({ type: "save-settings", settings: patch }).catch(() => null);
    if (controller.getState() !== "idle") {
      await controller.stop();
    }
    await controller.start();
    return;
  }

  const resolvedLang = resolveTargetLang(resolveCurrentPlayerSourceLan(), choice.targetLang);
  const prevLang = String(state.settings?.liveInterpretTargetLang || "zh");
  const langChanged = resolvedLang !== prevLang;
  const patch = {
    liveInterpretTargetLang: resolvedLang,
    liveInterpretDisplayMode: (choice.kind === "bilingual" ? "bilingual" : "translation") as
      | "bilingual"
      | "translation"
  };
  state.patchSettings(patch);
  void sendRuntimeMessage({ type: "save-settings", settings: patch }).catch(() => null);

  const sessionState = controller.getState();
  if (sessionState === "idle") {
    await controller.start();
  } else if (langChanged) {
    await controller.stop();
    await controller.start();
  } else {
    interpretSubtitleOverlay.syncAppearance();
  }
}

export async function togglePlayerInterpretMenu(anchor: HTMLElement): Promise<void> {
  await toggleInterpretSubtitleMenu(anchor, {
    getSessionState: getInterpretSessionState,
    getPreferences: async () => {
      const settings = await getSettings();
      const tracks = state.clip.subtitles || [];
      const nativeTracks = tracks.filter((track) => isLoadableNativeTrack(track));
      const nativePairAvailable =
        nativeTracks.length >= 2 && !isMonolingualNativeTracks(nativeTracks);
      return {
        targetLang: String(settings.liveInterpretTargetLang || "zh"),
        displayMode: String(settings.liveInterpretDisplayMode || "auto"),
        sourceLan: resolveCurrentPlayerSourceLan(),
        nativePairAvailable,
        foreignRefineAvailable: Boolean(findManualForeignTrackForAiRefine(nativeTracks)),
        aiRefineMode: getPlayerAiRefineMode(),
        fontScale: normalizeInterpretFontScale(
          state.settings?.liveInterpretFontScale ?? settings.liveInterpretFontScale
        ),
        blurSecondary: Boolean(
          state.settings?.liveInterpretBlurSecondary ?? settings.liveInterpretBlurSecondary
        )
      };
    },
    applyChoice: applyInterpretMenuChoice
  });
}

export function disposePlayerInterpret(): void {
  flushDebouncedSyncSettingsSave();
  unsubscribeStorageWatcher?.();
  unsubscribeStorageWatcher = null;
  unsubscribePresenter?.();
  unsubscribePresenter = null;
  if (pageHideBound && typeof window !== "undefined") {
    window.removeEventListener("pagehide", onWindowPageHide);
    pageHideBound = false;
  }
  setPlayerAiRefineMode("off");
  syncNativePlayerSubtitleTakeover(false);
  interpretController?.dispose();
  interpretController = null;
  interpretSessionGeneration = 0;
  closeInterpretSubtitleMenu();
  interpretSubtitleOverlay.clear();
  interpretSubtitleOverlay.dispose();
}
