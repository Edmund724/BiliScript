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
  LIVE_INTERPRET_LATIN_TARGET_LANGS,
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type InterpretSubtitleDisplayMode,
  type LiveInterpretTargetLang
} from "./interpret-subtitle-preferences.js";
import {
  createInterpretSessionController,
  type InterpretSessionController
} from "./interpret-session-controller.js";

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
}

export interface InterpretSubtitleOverlay {
  clear(): void;
  clearForSeek(): void;
  showNotice(message: string, autoHideMs?: number): void;
  setSubtitle(original: string, translation: string): void;
  getElement(): HTMLElement | null;
  dispose(): void;
}

export function createInterpretSubtitleOverlay(
  deps: InterpretSubtitleOverlayDeps
): InterpretSubtitleOverlay {
  let rootEl: HTMLElement | null = null;
  let originalEl: HTMLElement | null = null;
  let translationEl: HTMLElement | null = null;
  let noticeEl: HTMLElement | null = null;
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;

  function getMountHost(): HTMLElement | null {
    return getFullscreenHost() || deps.getPlayerHost();
  }

  function ensureMounted(): HTMLElement | null {
    const host = getMountHost();
    if (!host) return null;
    if (rootEl?.isConnected) {
      if (rootEl.parentElement !== host) host.appendChild(rootEl);
      return rootEl;
    }

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
    host.appendChild(root);
    rootEl = root;
    return root;
  }

  function clearCurrent(): void {
    if (originalEl) originalEl.textContent = "";
    if (translationEl) translationEl.textContent = "";
    if (rootEl) rootEl.hidden = true;
  }

  function clear(): void {
    clearCurrent();
  }

  function clearForSeek(): void {
    clearCurrent();
  }

  function showNotice(message: string, autoHideMs = 6000): void {
    const host = getMountHost();
    if (!host) return;
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    if (!noticeEl) {
      noticeEl = document.createElement("div");
      noticeEl.className = "biliscript-interpret-notice";
      noticeEl.setAttribute("data-biliscript-extension-node", "interpret-notice");
      noticeEl.setAttribute("role", "status");
    }
    if (noticeEl.parentElement !== host) host.appendChild(noticeEl);
    noticeEl.textContent = message;
    if (autoHideMs > 0) {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        noticeEl?.remove();
        noticeEl = null;
      }, autoHideMs);
    }
  }

  function setSubtitle(original: string, translation: string): void {
    const root = ensureMounted();
    if (!root || !originalEl || !translationEl) return;
    const lines = resolveInterpretSubtitleLines(original, deps.getTargetLang(), deps.getDisplayMode());
    const showOriginal = lines.showOriginal && Boolean(original.trim());
    const showTranslation = lines.showTranslation && Boolean(translation.trim());

    originalEl.textContent = original;
    translationEl.textContent = translation;
    originalEl.hidden = !showOriginal;
    translationEl.hidden = !showTranslation;
    root.hidden = !showOriginal && !showTranslation;
  }

  function dispose(): void {
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    noticeTimer = null;
    noticeEl?.remove();
    noticeEl = null;
    rootEl?.remove();
    rootEl = null;
    originalEl = null;
    translationEl = null;
  }

  return { clear, clearForSeek, showNotice, setSubtitle, getElement: () => rootEl, dispose };
}

export type InterpretSubtitleMenuSessionState = "idle" | "connecting" | "connected";

export type InterpretSubtitleMenuChoice =
  | { kind: "off" }
  | { kind: "translation"; targetLang: LiveInterpretTargetLang }
  | { kind: "bilingual"; targetLang: LiveInterpretTargetLang };

export interface InterpretSubtitleMenuPreferences {
  targetLang: string;
  displayMode: string;
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
  if (!menuEl || !activeDeps) return;
  const generation = ++openGeneration;
  const [{ targetLang, displayMode }, sessionState] = [
    await activeDeps.getPreferences(),
    activeDeps.getSessionState()
  ];
  if (generation !== openGeneration || !menuEl) return;

  const running = sessionState === "connected" || sessionState === "connecting";
  const bilingualOn = running && displayMode !== "translation";
  const currentLang = normalizeTargetLang(targetLang);

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

  if (!bilingualOn) {
    const list = document.createElement("div");
    list.className = "biliscript-interpret-menu-langs";
    for (const option of LIVE_INTERPRET_TARGET_LANG_OPTIONS) {
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
    void choose(
      bilingualOn
        ? { kind: "translation", targetLang: currentLang }
        : { kind: "bilingual", targetLang: currentLang }
    );
  });
  bilingualRow.append(bilingualLabel, toggle);
  menuEl.appendChild(bilingualRow);

  if (bilingualOn) {
    const grid = document.createElement("div");
    grid.className = "biliscript-interpret-menu-grid";

    const primaryCol = document.createElement("div");
    primaryCol.className = "biliscript-interpret-menu-grid-col";
    const primaryTitle = document.createElement("div");
    primaryTitle.className = "biliscript-interpret-menu-grid-title";
    primaryTitle.textContent = "主字幕";
    primaryCol.appendChild(primaryTitle);
    for (const option of LIVE_INTERPRET_TARGET_LANG_OPTIONS) {
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
  const triggerToFocus = restoreFocus ? triggerEl : null;
  openGeneration += 1;
  menuEl?.remove();
  menuEl = null;
  anchorEl = null;
  triggerEl?.setAttribute("aria-expanded", "false");
  triggerEl = null;
  activeDeps = null;
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
  document.removeEventListener("keydown", handleDocumentKeyDown, true);
  triggerToFocus?.focus();
}

export const closePlayerInterpretMenu = closeInterpretSubtitleMenu;

export async function openInterpretSubtitleMenu(
  anchor: HTMLElement,
  deps: InterpretSubtitleMenuDeps
): Promise<void> {
  closeInterpretSubtitleMenu();
  anchorEl = anchor;
  triggerEl = anchor.querySelector<HTMLElement>("#biliscript-player-interpret-quick-action, button");
  triggerEl?.setAttribute("aria-expanded", "true");
  activeDeps = deps;
  menuEl = buildMenuShell();
  anchor.appendChild(menuEl);
  document.addEventListener("pointerdown", handleDocumentPointerDown, true);
  document.addEventListener("keydown", handleDocumentKeyDown, true);
  await renderMenu();
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
  const label = interpretState === "connecting"
    ? "正在连接实时翻译..."
    : interpretState === "connected"
      ? "关闭实时翻译"
      : "字幕";
  button.title = unavailable && !availability.ok ? availability.error : label;
  button.setAttribute("aria-label", label);
}

let interpretController: InterpretSessionController | null = null;
let noticeConsumer: ((message: string, autoHideMs?: number) => void) | null = null;
let unsubscribePresenter: (() => void) | null = null;
let unsubscribeStorageWatcher: (() => void) | null = null;
let pageHideBound = false;

function getPlayerHost(): HTMLElement | null {
  return document.querySelector(".bpx-player-container, #bilibili-player, .player-wrap, #playerWrap");
}

function shouldShowInterpret(): boolean {
  const hasCc = state.clip.subtitles.some((track) =>
    Boolean(track.subtitleUrl) && !String(track.lan || "").startsWith("asr-")
  );
  return !hasCc && (state.clip.subtitleFetchState === "empty" || state.clip.subtitleFetchState === "ready");
}

const interpretSubtitleOverlay = createInterpretSubtitleOverlay({
  getPlayerHost,
  getTargetLang: () => state.settings?.liveInterpretTargetLang || "zh",
  getDisplayMode: () => state.settings?.liveInterpretDisplayMode || "auto"
});

export function showPlayerInterpretNotice(message: string, autoHideMs?: number): void {
  interpretSubtitleOverlay.showNotice(message, autoHideMs);
}

export function setPlayerInterpretNoticeConsumer(
  handler: ((message: string, autoHideMs?: number) => void) | null
): void {
  noticeConsumer = handler;
}

function onWindowPageHide(): void {
  disposePlayerInterpret();
}

function bindInterpretLifecycleListeners(): void {
  if (!unsubscribePresenter) {
    unsubscribePresenter = subscribeReaderPresenter((event) => {
      if (event.kind === "reset" || event.kind === "rerender" || event.kind === "subtitle-ready") {
        syncPlayerInterpretQuickAction();
      }
    });
  }
  if (!unsubscribeStorageWatcher) {
    unsubscribeStorageWatcher = watchStorageKeys(
      () => {
        void interpretController?.refreshAvailability();
      },
      {
        sync: [
          "asrProviders",
          "activeAsrProviderId",
          "aiProviders",
          "activeAiProviderId",
          "defaultModel",
          "subtitleTranslateProviderId",
          "subtitleTranslateModel"
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
      getTargetLang: () => state.settings?.liveInterpretTargetLang || "zh",
      getDisplayMode: () => state.settings?.liveInterpretDisplayMode || "auto",
      showNotice: (message, autoHideMs) => {
        if (noticeConsumer) {
          noticeConsumer(message, autoHideMs);
        } else {
          interpretSubtitleOverlay.showNotice(message, autoHideMs);
        }
      },
      setSubtitle: interpretSubtitleOverlay.setSubtitle,
      clearSubtitles: interpretSubtitleOverlay.clear,
      clearSubtitlesOnSeek: interpretSubtitleOverlay.clearForSeek,
      onStateChange: syncPlayerInterpretQuickAction,
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
  const controller = ensureInterpretController();
  if (choice.kind === "off") {
    await controller.stop();
    return;
  }

  const prevLang = String(state.settings?.liveInterpretTargetLang || "zh");
  const langChanged = choice.targetLang !== prevLang;
  const patch = {
    liveInterpretTargetLang: choice.targetLang,
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
  }
}

export async function togglePlayerInterpretMenu(anchor: HTMLElement): Promise<void> {
  await toggleInterpretSubtitleMenu(anchor, {
    getSessionState: getInterpretSessionState,
    getPreferences: async () => {
      const settings = await getSettings();
      return {
        targetLang: String(settings.liveInterpretTargetLang || "zh"),
        displayMode: String(settings.liveInterpretDisplayMode || "auto")
      };
    },
    applyChoice: applyInterpretMenuChoice
  });
}

export function disposePlayerInterpret(): void {
  unsubscribeStorageWatcher?.();
  unsubscribeStorageWatcher = null;
  unsubscribePresenter?.();
  unsubscribePresenter = null;
  if (pageHideBound && typeof window !== "undefined") {
    window.removeEventListener("pagehide", onWindowPageHide);
    pageHideBound = false;
  }
  interpretController?.dispose();
  interpretController = null;
  closeInterpretSubtitleMenu();
  interpretSubtitleOverlay.clear();
  interpretSubtitleOverlay.dispose();
}
