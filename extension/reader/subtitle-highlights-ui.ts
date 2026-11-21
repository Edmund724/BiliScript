import { state } from "../core/state.js";
import {
  loadVideoHighlights,
  removeSubtitleIndexHighlights,
  resolveHighlightVideoKey,
  type NoteHighlightItem
} from "../notes/highlights-store.js";
import { findSubtitleItem, SUBTITLE_ITEM_CLASS } from "./subtitle-item-dom.js";
import { ids } from "./state.js";

export const SUBTITLE_HIGHLIGHT_CLASS = "is-note-highlighted";
export const SUBTITLE_HIGHLIGHT_BADGE_CLASS = "biliscript-reading-note-badge";

let cachedVideoKey = "";
let cachedSubtitleIndexes = new Set<number>();

export function currentHighlightVideoKey(): string {
  const url = state.clip.currentUrl || (typeof location !== "undefined" ? location.href : "");
  return resolveHighlightVideoKey(state.clip.bvid, url);
}

function collectHighlightedSubtitleIndexes(items: readonly NoteHighlightItem[]): Set<number> {
  const set = new Set<number>();
  for (const item of items) {
    if (item.source === "subtitle" && typeof item.subtitleIndex === "number" && item.subtitleIndex >= 0) {
      set.add(item.subtitleIndex);
    }
  }
  return set;
}

function ensureNoteBadge(itemEl: HTMLElement, highlighted: boolean): void {
  itemEl.classList.toggle(SUBTITLE_HIGHLIGHT_CLASS, highlighted);
  const existing = itemEl.querySelector<HTMLElement>(`.${SUBTITLE_HIGHLIGHT_BADGE_CLASS}`);
  if (!highlighted) {
    existing?.remove();
    return;
  }
  if (existing) {
    return;
  }
  const badge = document.createElement("span");
  badge.className = SUBTITLE_HIGHLIGHT_BADGE_CLASS;
  badge.setAttribute("role", "button");
  badge.setAttribute("tabindex", "0");
  badge.dataset.subtitleAction = "remove-highlight";
  badge.title = "已存笔记（点击取消高亮）";
  badge.setAttribute("aria-label", "取消该句笔记高亮");
  badge.textContent = "笔记";
  itemEl.appendChild(badge);
}

export function applySubtitleHighlightsToList(
  listEl: HTMLElement | null = document.getElementById(ids.readingSubtitleList),
  indexes: ReadonlySet<number> = cachedSubtitleIndexes
): void {
  if (!listEl) {
    return;
  }
  const items = listEl.querySelectorAll<HTMLElement>(`.${SUBTITLE_ITEM_CLASS}`);
  items.forEach((itemEl) => {
    const idx = Number(itemEl.dataset.index);
    const highlighted = Number.isInteger(idx) && indexes.has(idx);
    ensureNoteBadge(itemEl, highlighted);
  });
}

export function applySubtitleHighlightsToRange(
  listEl: HTMLElement | null,
  fromIndex: number,
  toIndex: number
): void {
  if (!listEl || cachedSubtitleIndexes.size === 0) {
    return;
  }
  for (let idx = fromIndex; idx < toIndex; idx += 1) {
    if (!cachedSubtitleIndexes.has(idx)) {
      continue;
    }
    const itemEl = findSubtitleItem(listEl, idx);
    if (itemEl) {
      ensureNoteBadge(itemEl, true);
    }
  }
}

export function syncSubtitleHighlightsCache(videoKey: string, items: readonly NoteHighlightItem[]): void {
  cachedVideoKey = videoKey;
  cachedSubtitleIndexes = collectHighlightedSubtitleIndexes(items);
  applySubtitleHighlightsToList();
}

export async function refreshSubtitleHighlightsFromStore(): Promise<void> {
  const videoKey = currentHighlightVideoKey();
  if (!videoKey) {
    cachedVideoKey = "";
    cachedSubtitleIndexes = new Set();
    applySubtitleHighlightsToList();
    return;
  }
  const items = await loadVideoHighlights(videoKey);
  if (videoKey !== currentHighlightVideoKey()) {
    return;
  }
  syncSubtitleHighlightsCache(videoKey, items);
}

export async function removeSubtitleItemHighlight(itemIndex: number): Promise<boolean> {
  const videoKey = currentHighlightVideoKey();
  if (!videoKey || !Number.isInteger(itemIndex) || itemIndex < 0) {
    return false;
  }
  const result = await removeSubtitleIndexHighlights(videoKey, itemIndex);
  if (videoKey === currentHighlightVideoKey()) {
    syncSubtitleHighlightsCache(videoKey, result.items);
  }
  return result.removedCount > 0;
}

export function getCachedHighlightVideoKey(): string {
  return cachedVideoKey;
}
