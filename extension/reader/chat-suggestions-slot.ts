import { buildContextKey } from "../ai/conversation.js";
import { extractVideoId } from "../bilibili/video-id-shared.js";
import { chatSessionState } from "../chat/chat-state.js";
import { readCachedQuickPrompts } from "../chat/quick-prompt-cache.js";
import { resolveInitialQuickPrompts } from "../chat/quick-prompts.js";
import { state } from "../core/state.js";
import { resolveNodeDocument } from "../shared/cross-doc.js";
import { escapeHtml } from "../shared/string-utils.js";

export interface CreateChatSuggestionsSlotDeps {
  messages: HTMLElement;
  id: string;
  onPick: (prompt: string) => void;
}

export interface ChatSuggestionsSlot {
  reset: () => void;
  refresh: () => void;
  clear: () => void;
  isPresent: () => boolean;
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

export function createChatSuggestionsSlot(deps: CreateChatSuggestionsSlotDeps): ChatSuggestionsSlot {
  let node: HTMLElement | null = null;

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
    if (!prompts.length) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML =
      `<div class="chat-hero">` +
      `<span class="chat-hero-icon">${HERO_ICON_SVG}</span>` +
      `<p class="chat-hero-title">围绕这期视频，问点什么</p>` +
      `<div class="chat-hero-sugs">` +
      prompts
        .map((prompt) => `<button type="button" class="chat-chip">${escapeHtml(prompt)}</button>`)
        .join("") +
      `</div></div>`;
    target.querySelectorAll(".chat-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
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
    node?.remove();
    node = null;
  }

  return {
    reset,
    refresh,
    clear,
    isPresent
  };
}
