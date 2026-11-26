import { buildContextKey } from "../ai/conversation.js";
import { extractVideoId } from "../bilibili/video-id-shared.js";
import { chatSessionState } from "../chat/chat-state.js";
import { readCachedQuickPrompts } from "../chat/quick-prompt-cache.js";
import { resolveInitialQuickPrompts } from "../chat/quick-prompts.js";
import type { NotePromptPreset } from "../core/defaults.js";
import { state } from "../core/state.js";
import { normalizeNotePromptPreset } from "../core/validators.js";
import { getNotePromptPresetLabel, NOTE_PROMPT_PRESET_OPTIONS } from "../notes/note-prompts.js";
import { isElementNode, resolveNodeDocument } from "../shared/cross-doc.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { READING_CHEVRON_DOWN_ICON } from "../ui/reading-icons.js";

export interface CreateChatSuggestionsSlotDeps {
  messages: HTMLElement;
  id: string;
  onPick: (prompt: string) => void;
  onPickVideoNote?: () => void;
  onPresetChange?: (preset: NotePromptPreset) => void;
}

export interface ChatSuggestionsSlot {
  reset: () => void;
  refresh: () => void;
  clear: () => void;
  isPresent: () => boolean;
  closeMenu: () => void;
  handleOutsideClick: (event: Event) => void;
  handleEscapeKey: (event: KeyboardEvent) => void;
}

const HERO_ICON_SVG =
  '<svg viewBox="0 0 24 24" focusable="false" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="biliscript-hero-g-light" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4285f4"/><stop offset=".3" stop-color="#9b72cb"/><stop offset=".68" stop-color="#d96570"/><stop offset="1" stop-color="#f49c46"/></linearGradient><linearGradient id="biliscript-hero-g-dark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#669df6"/><stop offset=".3" stop-color="#b388ff"/><stop offset=".68" stop-color="#f28b82"/><stop offset="1" stop-color="#fdd663"/></linearGradient></defs><path d="M12 5.2l1.84 4.96 4.96 1.84-4.96 1.84L12 18.8l-1.84-4.96L5.2 12l4.96-1.84L12 5.2z"/></svg>';

function currentPageVideoKey(): string {
  const clip = state.clip;
  if (!clip.subtitleBody?.length) {
    return "";
  }
  const bvid = String(clip.bvid || "").trim();
  if (!bvid || bvid !== extractVideoId(location.href)) {
    return "";
  }
  return buildContextKey({ site: clip.site, bvid, cid: clip.cid, aid: clip.aid, url: location.href });
}

function resolveSuggestionsForCurrentView(): string[] {
  if (
    !chatSessionState.contextData
    || !chatSessionState.providers.length
    || chatSessionState.chatHistory.length
    || chatSessionState.contextData.isVideoContext === false
  ) {
    return [];
  }
  return resolveInitialQuickPrompts(
    chatSessionState.aiPrefs.aiInitialQuickPrompts,
    readCachedQuickPrompts(currentPageVideoKey())
  );
}

function currentNotePreset(): NotePromptPreset {
  return normalizeNotePromptPreset(state.settings?.notePromptPreset);
}

function buildSplitNotePillHtml(preset: NotePromptPreset): string {
  const label = getNotePromptPresetLabel(preset);
  const optionsHtml = NOTE_PROMPT_PRESET_OPTIONS.map((option) => {
    const active = option.value === preset;
    return `<button type="button" class="chat-note-preset-item${active ? " is-active" : ""}" role="menuitemradio" aria-checked="${active ? "true" : "false"}" data-note-preset="${option.value}">${escapeHtml(option.label)}</button>`;
  }).join("");
  return (
    `<div class="chat-note-split-pill">` +
    `<button type="button" class="chat-note-pill-main">生成视频笔记 · ${escapeHtml(label)}</button>` +
    `<button type="button" class="chat-note-pill-toggle" aria-haspopup="menu" aria-expanded="false" aria-label="切换视频笔记预设" title="切换视频笔记预设">${READING_CHEVRON_DOWN_ICON}</button>` +
    `<div class="chat-note-preset-menu" role="menu" hidden>${optionsHtml}</div>` +
    `</div>`
  );
}

export function createChatSuggestionsSlot(deps: CreateChatSuggestionsSlotDeps): ChatSuggestionsSlot {
  let node: HTMLElement | null = null;
  let menuOpen = false;
  let docClickHost: Document | null = null;

  function unbindFallbackDocClick(): void {
    if (docClickHost) {
      try {
        docClickHost.removeEventListener("click", onFallbackDocClick);
      } catch {
      }
      docClickHost = null;
    }
  }

  function onFallbackDocClick(event: Event): void {
    handleOutsideClick(event);
  }

  function syncMenuDom(): void {
    const pill = node?.querySelector<HTMLElement>(".chat-note-split-pill");
    const toggle = pill?.querySelector<HTMLButtonElement>(".chat-note-pill-toggle");
    const menu = pill?.querySelector<HTMLElement>(".chat-note-preset-menu");
    if (!pill || !toggle || !menu) {
      menuOpen = false;
      unbindFallbackDocClick();
      return;
    }
    pill.classList.toggle("is-open", menuOpen);
    toggle.setAttribute("aria-expanded", menuOpen ? "true" : "false");
    menu.hidden = !menuOpen;
    if (menuOpen) {
      const hostDoc = resolveNodeDocument(pill);
      if (docClickHost !== hostDoc) {
        unbindFallbackDocClick();
        docClickHost = hostDoc;
        hostDoc.addEventListener("click", onFallbackDocClick);
      }
    } else {
      unbindFallbackDocClick();
    }
  }

  function closeMenu(): void {
    if (!menuOpen) {
      unbindFallbackDocClick();
      return;
    }
    menuOpen = false;
    syncMenuDom();
  }

  function handleOutsideClick(event: Event): void {
    if (!menuOpen) {
      return;
    }
    const pill = node?.querySelector<HTMLElement>(".chat-note-split-pill");
    if (!pill) {
      closeMenu();
      return;
    }
    if (isElementNode(event.target) && pill.contains(event.target)) {
      return;
    }
    closeMenu();
  }

  function handleEscapeKey(event: KeyboardEvent): void {
    if (!menuOpen || event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const toggle = node?.querySelector<HTMLButtonElement>(".chat-note-pill-toggle");
    closeMenu();
    toggle?.focus({ preventScroll: true });
  }

  function applyPresetSelection(nextPreset: NotePromptPreset): void {
    state.patchSettings({ notePromptPreset: nextPreset });
    void sendRuntimeMessage({ type: "save-settings", settings: { notePromptPreset: nextPreset } }).catch(() => null);
    deps.onPresetChange?.(nextPreset);
    const pill = node?.querySelector<HTMLElement>(".chat-note-split-pill");
    const mainBtn = pill?.querySelector<HTMLButtonElement>(".chat-note-pill-main");
    if (mainBtn) {
      mainBtn.textContent = `生成视频笔记 · ${getNotePromptPresetLabel(nextPreset)}`;
    }
    pill?.querySelectorAll<HTMLButtonElement>(".chat-note-preset-item").forEach((item) => {
      const active = item.dataset.notePreset === nextPreset;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-checked", active ? "true" : "false");
    });
    closeMenu();
  }

  function ensureNode(): HTMLElement {
    if (!node || !node.isConnected) {
      node = resolveNodeDocument(deps.messages).createElement("div");
      node.className = "chat-suggestions";
      node.id = deps.id;
      deps.messages.appendChild(node);
    }
    return node;
  }

  function renderInto(target: HTMLElement, prompts: readonly string[]): void {
    closeMenu();
    if (!prompts.length) {
      target.innerHTML = "";
      return;
    }
    const preset = currentNotePreset();
    target.innerHTML =
      `<div class="chat-hero">` +
      `<span class="chat-hero-icon">${HERO_ICON_SVG}</span>` +
      `<p class="chat-hero-title">围绕这期视频，问点什么</p>` +
      `<div class="chat-hero-sugs">` +
      buildSplitNotePillHtml(preset) +
      prompts
        .map((prompt) => `<button type="button" class="chat-chip">${escapeHtml(prompt)}</button>`)
        .join("") +
      `</div></div>`;

    const mainBtn = target.querySelector<HTMLButtonElement>(".chat-note-pill-main");
    const toggleBtn = target.querySelector<HTMLButtonElement>(".chat-note-pill-toggle");
    mainBtn?.addEventListener("click", () => {
      closeMenu();
      deps.onPickVideoNote?.();
    });
    toggleBtn?.addEventListener("click", (event) => {
      event.stopPropagation();
      menuOpen = !menuOpen;
      syncMenuDom();
    });
    target.querySelectorAll<HTMLButtonElement>(".chat-note-preset-item").forEach((item) => {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextPreset = normalizeNotePromptPreset(item.dataset.notePreset);
        applyPresetSelection(nextPreset);
      });
    });
    target.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        closeMenu();
        deps.onPick(btn.textContent || "");
      });
    });
  }

  function isPresent(): boolean {
    return Boolean(node?.isConnected);
  }

  function reset(): void {
    renderInto(ensureNode(), resolveSuggestionsForCurrentView());
  }

  function refresh(): void {
    if (!isPresent()) {
      return;
    }
    renderInto(node!, resolveSuggestionsForCurrentView());
  }

  function clear(): void {
    closeMenu();
    node?.remove();
    node = null;
  }

  return {
    reset,
    refresh,
    clear,
    isPresent,
    closeMenu,
    handleOutsideClick,
    handleEscapeKey
  };
}
