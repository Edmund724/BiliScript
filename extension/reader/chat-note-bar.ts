import { chatSessionState } from "../chat/chat-state.js";
import type { NotePromptPreset } from "../core/defaults.js";
import { state } from "../core/state.js";
import { normalizeNotePromptPreset } from "../core/validators.js";
import { getNotePromptPresetLabel, NOTE_PROMPT_PRESET_OPTIONS } from "../notes/note-prompts.js";
import { isElementNode, resolveNodeDocument } from "../shared/cross-doc.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { escapeHtml } from "../shared/string-utils.js";
import { renderUiIcon } from "../ui/icon-registry.js";
import { READING_CHEVRON_DOWN_ICON } from "../ui/reading-icons.js";

export interface CreateChatNoteBarDeps {
  host: HTMLElement | null;
  hasSelectableModels: () => boolean;
  onPickVideoNote: () => void;
  onPresetChange?: (preset: NotePromptPreset) => void;
  onOpenMenu?: () => void;
}

export interface ChatNoteBar {
  refresh: () => void;
  closeMenu: (options?: { restoreFocus?: boolean }) => void;
  handleOutsideClick: (event: Event) => void;
  handleEscapeKey: (event: KeyboardEvent) => void;
}

function currentNotePreset(): NotePromptPreset {
  return normalizeNotePromptPreset(state.settings?.notePromptPreset);
}

function buildSplitNotePillHtml(preset: NotePromptPreset, menuId: string): string {
  const label = getNotePromptPresetLabel(preset);
  const fullLabel = `生成视频笔记 · ${label}`;
  const optionsHtml = NOTE_PROMPT_PRESET_OPTIONS.map((option) => {
    const active = option.value === preset;
    return `<button type="button" class="chat-note-preset-item${active ? " is-active" : ""}" role="menuitemradio" aria-checked="${active ? "true" : "false"}" data-note-preset="${option.value}"><span class="chat-note-preset-item-label">${escapeHtml(option.label)}</span></button>`;
  }).join("");
  return (
    `<div class="chat-note-split-pill">` +
    `<button type="button" class="chat-note-pill-main" title="${escapeHtml(fullLabel)}" aria-label="${escapeHtml(fullLabel)}">${renderUiIcon("notebookPen")}<span class="chat-note-pill-label">笔记</span></button>` +
    `<button type="button" class="chat-note-pill-toggle" aria-haspopup="menu" aria-controls="${escapeHtml(menuId)}" aria-expanded="false" aria-label="切换视频笔记预设" title="切换视频笔记预设">${READING_CHEVRON_DOWN_ICON}</button>` +
    `<div id="${escapeHtml(menuId)}" class="chat-note-preset-menu" role="menu" aria-label="视频笔记预设" hidden>${optionsHtml}</div>` +
    `</div>`
  );
}

export function createChatNoteBar(deps: CreateChatNoteBarDeps): ChatNoteBar {
  let menuOpen = false;
  let rendered = false;
  let docClickHost: Document | null = null;
  const menuId = `${deps.host?.id || "biliscript-reading-chat-note-bar"}-menu`;

  function shouldShow(): boolean {
    return Boolean(
      deps.host
      && chatSessionState.contextData
      && chatSessionState.contextData.isVideoContext !== false
      && chatSessionState.providers.length > 0
      && deps.hasSelectableModels()
    );
  }

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

  function getParts(): {
    pill: HTMLElement | null;
    mainBtn: HTMLButtonElement | null;
    toggle: HTMLButtonElement | null;
    menu: HTMLElement | null;
    items: HTMLButtonElement[];
  } {
    const pill = deps.host?.querySelector<HTMLElement>(".chat-note-split-pill") ?? null;
    const mainBtn = pill?.querySelector<HTMLButtonElement>(".chat-note-pill-main") ?? null;
    const toggle = pill?.querySelector<HTMLButtonElement>(".chat-note-pill-toggle") ?? null;
    const menu = pill?.querySelector<HTMLElement>(".chat-note-preset-menu") ?? null;
    const items = menu ? [...menu.querySelectorAll<HTMLButtonElement>(".chat-note-preset-item")] : [];
    return { pill, mainBtn, toggle, menu, items };
  }

  function syncMenuDom(): void {
    const { pill, toggle, menu } = getParts();
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

  function openMenu(focusTarget: "none" | "first" | "last" = "none"): void {
    if (!rendered) {
      return;
    }
    deps.onOpenMenu?.();
    menuOpen = true;
    syncMenuDom();
    if (focusTarget !== "none") {
      const { items } = getParts();
      const target = focusTarget === "last" ? items[items.length - 1] : items[0];
      target?.focus({ preventScroll: true });
    }
  }

  function closeMenu({ restoreFocus = false }: { restoreFocus?: boolean } = {}): void {
    if (!menuOpen) {
      unbindFallbackDocClick();
      return;
    }
    const { toggle } = getParts();
    menuOpen = false;
    syncMenuDom();
    if (restoreFocus) {
      toggle?.focus({ preventScroll: true });
    }
  }

  function syncPresetDom(preset: NotePromptPreset): void {
    const { mainBtn, items } = getParts();
    if (mainBtn) {
      const fullLabel = `生成视频笔记 · ${getNotePromptPresetLabel(preset)}`;
      mainBtn.title = fullLabel;
      mainBtn.setAttribute("aria-label", fullLabel);
    }
    for (const item of items) {
      const active = item.dataset.notePreset === preset;
      item.classList.toggle("is-active", active);
      item.setAttribute("aria-checked", active ? "true" : "false");
    }
  }

  function applyPresetSelection(nextPreset: NotePromptPreset, restoreFocus: boolean): void {
    state.patchSettings({ notePromptPreset: nextPreset });
    void sendRuntimeMessage({ type: "save-settings", settings: { notePromptPreset: nextPreset } }).catch(() => null);
    deps.onPresetChange?.(nextPreset);
    syncPresetDom(nextPreset);
    closeMenu({ restoreFocus });
  }

  function ensureRendered(): void {
    if (!deps.host) {
      return;
    }
    if (rendered && deps.host.querySelector(".chat-note-split-pill")) {
      return;
    }
    const preset = currentNotePreset();
    deps.host.innerHTML = buildSplitNotePillHtml(preset, menuId);
    rendered = true;

    const { mainBtn, toggle, menu, items } = getParts();
    mainBtn?.addEventListener("click", () => {
      closeMenu();
      deps.onPickVideoNote();
    });
    toggle?.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menuOpen) {
        closeMenu();
        return;
      }
      openMenu(event.detail === 0 ? "first" : "none");
    });
    toggle?.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        openMenu(event.key === "ArrowUp" ? "last" : "first");
      }
    });
    menu?.addEventListener("keydown", (event) => {
      if (!menuOpen) {
        return;
      }
      if (event.key === "Tab") {
        closeMenu();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        return;
      }
      const enabled = items.filter((item) => !item.disabled);
      if (!enabled.length) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const doc = resolveNodeDocument(menu);
      const current = enabled.indexOf(doc.activeElement as HTMLButtonElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? enabled.length - 1
            : current < 0
              ? event.key === "ArrowUp"
                ? enabled.length - 1
                : 0
              : (current + (event.key === "ArrowUp" ? -1 : 1) + enabled.length) % enabled.length;
      enabled[next]?.focus({ preventScroll: true });
    });
    for (const item of items) {
      item.addEventListener("click", (event) => {
        event.stopPropagation();
        const nextPreset = normalizeNotePromptPreset(item.dataset.notePreset);
        applyPresetSelection(nextPreset, event.detail === 0);
      });
    }
  }

  function handleOutsideClick(event: Event): void {
    if (!menuOpen) {
      return;
    }
    const { pill } = getParts();
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
    closeMenu({ restoreFocus: true });
  }

  function refresh(): void {
    if (!deps.host) {
      return;
    }
    if (!shouldShow()) {
      closeMenu();
      deps.host.hidden = true;
      return;
    }
    ensureRendered();
    syncPresetDom(currentNotePreset());
    deps.host.hidden = false;
  }

  return {
    refresh,
    closeMenu,
    handleOutsideClick,
    handleEscapeKey
  };
}
