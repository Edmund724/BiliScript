// extension/reader/quote-share-modal.ts
// 金句分享卡片预览模态弹窗与主题预设切换。

import { escapeHtml } from "../shared/string-utils.js";
import { formatClock } from "../shared/clock-text.js";
import { READING_CLOSE_ICON } from "../ui/reading-icons.js";
import { getQuoteShareNoiseDataUrl } from "./quote-share-noise.js";
import { ids } from "./state.js";

export interface QuoteCardPreset {
  id: string;
  name: string;
  dotColor: string;
}

export const QUOTE_CARD_PRESETS: QuoteCardPreset[] = [
  { id: "purple-gold", name: "紫粉·橙金", dotColor: "linear-gradient(135deg, #dc82c8, #f5aa32)" },
  { id: "slate-brown", name: "灰蓝·深棕", dotColor: "linear-gradient(135deg, #87a0b9, #c37d50)" },
  { id: "mist-deep-sea", name: "雾蓝·深海", dotColor: "linear-gradient(135deg, #73b4eb, #12325a)" },
  { id: "mist-forest-green", name: "雾蓝·墨绿", dotColor: "linear-gradient(135deg, #6eb0c3, #16462a)" },
  { id: "lavender-midnight", name: "薰衣草·深夜紫", dotColor: "linear-gradient(135deg, #aa8cdc, #150b2e)" },
  { id: "ash-rust", name: "天灰·锈红", dotColor: "linear-gradient(135deg, #a5b4be, #8c2d23)" }
];

export interface OpenQuoteShareModalOptions {
  content: string;
  from?: number;
  videoTitle?: string;
  preset?: string;
}

interface QuoteShareModalState {
  open: boolean;
  content: string;
  from: number;
  videoTitle: string;
  activePreset: string;
  host: HTMLElement | null;
}

const state: QuoteShareModalState = {
  open: false,
  content: "",
  from: 0,
  videoTitle: "",
  activePreset: "purple-gold",
  host: null
};

export function isQuoteShareModalOpen(): boolean {
  return state.open;
}

export function getActiveQuoteCardPreset(): string {
  return state.activePreset;
}

export function setActiveQuoteCardPreset(presetId: string): void {
  const matched = QUOTE_CARD_PRESETS.find((p) => p.id === presetId);
  if (!matched || state.activePreset === presetId) {
    return;
  }
  state.activePreset = presetId;
  updatePresetSelectionInDom(presetId);
}

function updatePresetSelectionInDom(presetId: string): void {
  if (!state.host) {
    return;
  }
  const card = state.host.querySelector<HTMLElement>(".biliscript-quote-card");
  if (card) {
    card.dataset.preset = presetId;
  }
  const buttons = state.host.querySelectorAll<HTMLElement>("[data-preset]");
  buttons.forEach((btn) => {
    const isActive = btn.dataset.preset === presetId;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

export function openQuoteShareModal(options: OpenQuoteShareModalOptions): void {
  closeQuoteShareModal();

  const content = String(options.content || "").trim();
  if (!content) {
    return;
  }

  state.open = true;
  state.content = content;
  state.from = Number(options.from) || 0;
  state.videoTitle = String(options.videoTitle || "").trim();
  if (options.preset && QUOTE_CARD_PRESETS.some((p) => p.id === options.preset)) {
    state.activePreset = options.preset;
  }

  const host = document.createElement("div");
  host.className = "biliscript-quote-share-host";
  host.innerHTML = buildModalHtml();

  bindModalEvents(host);

  const container = document.getElementById(ids.readingView) || document.body;
  container.appendChild(host);
  state.host = host;

  document.addEventListener("keydown", onDocumentKeyDown, true);
}

export function closeQuoteShareModal(): void {
  if (!state.open && !state.host) {
    return;
  }
  state.open = false;
  document.removeEventListener("keydown", onDocumentKeyDown, true);
  state.host?.remove();
  state.host = null;
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (!state.open || event.key !== "Escape") {
    return;
  }
  event.stopPropagation();
  closeQuoteShareModal();
}

function bindModalEvents(host: HTMLElement): void {
  host.addEventListener("click", (event) => {
    const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-action], [data-preset]");
    if (!target) {
      return;
    }
    const action = target.dataset.action;
    if (action === "close") {
      closeQuoteShareModal();
      return;
    }
    const preset = target.dataset.preset;
    if (preset) {
      setActiveQuoteCardPreset(preset);
      return;
    }
  });
}

function buildModalHtml(): string {
  const noiseUrl = getQuoteShareNoiseDataUrl();
  const timeFormatted = formatClock(state.from);

  const presetsHtml = QUOTE_CARD_PRESETS.map((preset) => {
    const isActive = preset.id === state.activePreset;
    return `
      <button type="button" class="biliscript-quote-preset-btn${isActive ? " is-active" : ""}" data-preset="${preset.id}" aria-pressed="${isActive ? "true" : "false"}" title="${escapeHtml(preset.name)}">
        <span class="biliscript-quote-preset-dot" style="background: ${preset.dotColor};" aria-hidden="true"></span>
        <span>${escapeHtml(preset.name)}</span>
      </button>
    `;
  }).join("");

  return `
    <div class="biliscript-quote-share-mask" data-action="close"></div>
    <section class="biliscript-quote-share-dialog" role="dialog" aria-modal="true" aria-label="分享金句卡片" tabindex="-1">
      <header class="biliscript-quote-share-header">
        <h3 class="biliscript-quote-share-title">分享金句卡片</h3>
        <button type="button" class="biliscript-quote-share-close" data-action="close" aria-label="关闭" title="关闭">
          ${READING_CLOSE_ICON}
        </button>
      </header>
      <div class="biliscript-quote-share-presets" role="toolbar" aria-label="渐变配色切换">
        ${presetsHtml}
      </div>
      <div class="biliscript-quote-share-preview">
        <div class="biliscript-quote-card" data-preset="${state.activePreset}">
          <div class="biliscript-quote-card-bg">
            <div class="biliscript-quote-card-blobs"></div>
            <div class="biliscript-quote-card-noise" style="background-image: url('${noiseUrl}');"></div>
          </div>
          <div class="biliscript-quote-card-content">
            <div class="biliscript-quote-card-quote-mark" aria-hidden="true">“</div>
            <p class="biliscript-quote-card-text">${escapeHtml(state.content)}</p>
            <footer class="biliscript-quote-card-footer">
              <span class="biliscript-quote-card-timestamp">${escapeHtml(timeFormatted)}</span>
              <span class="biliscript-quote-card-source">${escapeHtml(state.videoTitle || "BiliScript")}</span>
            </footer>
          </div>
        </div>
      </div>
    </section>
  `;
}
