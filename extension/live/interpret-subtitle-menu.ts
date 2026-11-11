// extension/live/interpret-subtitle-menu.ts
// 播放器内「字幕」快捷按钮的仿原生弹层菜单：视觉复刻 B 站自带字幕菜单
//（标题 + 关闭 + 语言列表带 [AI] 徽标 + 双语字幕开关 + 双语双列网格）。
//
// 与原生菜单的语义映射（我们的引擎只产出 原文(ASR) + 译文 成对字幕轨）：
// - 关闭：停止字幕翻译会话；
// - 单选语言行 = 仅译文模式 + 该目标语言（会话未开时选语言即开启）；
// - 双语字幕开关开 = 双语模式：主字幕列选译文语言，副字幕固定为原文；
// - 「自动」显示模式在菜单里归入双语开（开关列主字幕语言 = 目标语言）。
//
// 菜单不直接碰会话与设置存储：状态经 deps 注入（getSessionState /
// getPreferences / applyChoice），宿主（live-companion-session + player-ai）
// 负责接线，本模块只做渲染与交互。

import {
  LIVE_INTERPRET_TARGET_LANG_OPTIONS,
  type LiveInterpretTargetLang
} from "./interpret-subtitle-preferences.js";

export type InterpretSubtitleMenuSessionState = "idle" | "connecting" | "connected";

export type InterpretSubtitleMenuChoice =
  | { kind: "off" }
  | { kind: "translation"; targetLang: LiveInterpretTargetLang }
  | { kind: "bilingual"; targetLang: LiveInterpretTargetLang };

export interface InterpretSubtitleMenuPreferences {
  targetLang: string;
  displayMode: string;
}export interface InterpretSubtitleMenuDeps {
  getSessionState: () => InterpretSubtitleMenuSessionState;
  getPreferences: () => Promise<InterpretSubtitleMenuPreferences>;
  applyChoice: (choice: InterpretSubtitleMenuChoice) => Promise<void> | void;
}

// 菜单内语言行用 B 站字幕菜单的语种标签（设置面板仍用中文标签，互不影响）。
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
let activeDeps: InterpretSubtitleMenuDeps | null = null;
let openGeneration = 0;

function langLabel(value: string): string {
  return MENU_LANG_LABELS[value] || value;
}

// deps 边界上语言是 string（宿主直读 settings），渲染与下发前归一化到词表值域。
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
    const originalItem = document.createElement("button");
    originalItem.type = "button";
    originalItem.className = "biliscript-interpret-menu-item is-selected";
    originalItem.setAttribute("role", "menuitemradio");
    originalItem.setAttribute("aria-checked", "true");
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
  if (event.key === "Escape") closeInterpretSubtitleMenu();
}

export function isInterpretSubtitleMenuOpen(): boolean {
  return Boolean(menuEl?.isConnected);
}

export function closeInterpretSubtitleMenu(): void {
  openGeneration += 1;
  menuEl?.remove();
  menuEl = null;
  anchorEl = null;
  activeDeps = null;
  document.removeEventListener("pointerdown", handleDocumentPointerDown, true);
  document.removeEventListener("keydown", handleDocumentKeyDown, true);
}

export async function openInterpretSubtitleMenu(
  anchor: HTMLElement,
  deps: InterpretSubtitleMenuDeps
): Promise<void> {
  closeInterpretSubtitleMenu();
  anchorEl = anchor;
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

// 会话状态/设置被其他入口改变（设置页、暂停超时自动关闭、换片）且菜单正开着时，
// 由宿主调用以刷新高亮态；菜单关闭时是空操作。
export async function syncInterpretSubtitleMenu(): Promise<void> {
  if (!isInterpretSubtitleMenuOpen()) return;
  await renderMenu();
}
