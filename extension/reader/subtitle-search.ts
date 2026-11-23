import { clipState, state } from "../core/state.js";
import { activeById } from "../shared/active-host.js";
import { resolveNodeDocument } from "../shared/cross-doc.js";
import { getReadingSubtitleItems } from "../subtitle/core.js";
import { secondaryAlignmentFor } from "../subtitle/alignment.js";
import type { SecondaryAlignment } from "../subtitle/alignment.js";
import { ids } from "./state.js";
import { subtitleScrollFollow } from "./subtitle-scroll-follow.js";
import {
  findSubtitleItem,
  getSubtextNode,
  isSubtextReady,
  replaceMainLineContent
} from "./subtitle-item-dom.js";

const SEARCH_HIT_MARK_CLASS = "biliscript-reading-search-hit";
const SEARCH_CURRENT_CLASS = "search-current";

interface SearchRange {
  start: number;
  end: number;
}

interface SearchMatch {
  itemIndex: number;
  ordinal: number;
}

interface ItemHighlightRanges {
  mainText: string;
  mainRanges: SearchRange[];
  secondaryText: string | null;
  secondaryRanges: SearchRange[];
}

export interface SubtitleSearchDeps {
  getSearchInput(): HTMLInputElement | null;
  getSubtitleList(): HTMLElement | null;
  flushReadingSubtitleToIndex(itemIndex: number): void;
  noteManualReaderInteraction(): void;
}

export interface SubtitleSearch {
  refresh(options?: { preserveIndex?: boolean; scroll?: boolean }): void;
  move(direction: 1 | -1): void;
  clear(): void;
  handleRangeAppended(fromIndex: number, toIndex: number): void;
}

function findLiteralMatches(text: string, needle: string): SearchRange[] {
  const source = String(text || "");
  const target = String(needle || "").trim();
  if (!target) {
    return [];
  }
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matcher = new RegExp(escaped, "gi");
  const ranges: SearchRange[] = [];
  for (const match of source.matchAll(matcher)) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
  }
  return ranges;
}

function resolveSecondarySearchAlignment(): SecondaryAlignment | null {
  if (!state.settings.bilingualSubtitles) {
    return null;
  }
  const slot = clipState.secondarySubtitle;
  if (!slot || slot.state !== "ready" || !Array.isArray(slot.body) || slot.body.length === 0) {
    return null;
  }
  return secondaryAlignmentFor(slot.body);
}

function buildHighlightFragment(
  source: string,
  ranges: SearchRange[],
  doc: Document
): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      fragment.appendChild(doc.createTextNode(source.slice(cursor, range.start)));
    }
    const mark = doc.createElement("mark");
    mark.className = SEARCH_HIT_MARK_CLASS;
    mark.textContent = source.slice(range.start, range.end);
    fragment.appendChild(mark);
    cursor = range.end;
  }
  if (cursor < source.length) {
    fragment.appendChild(doc.createTextNode(source.slice(cursor)));
  }
  return fragment;
}

export function createSubtitleSearch(deps: SubtitleSearchDeps): SubtitleSearch {
  let query = "";
  let matches: SearchMatch[] = [];
  let matchesByItem = new Map<number, SearchMatch[]>();
  let itemRanges = new Map<number, ItemHighlightRanges>();
  let currentIndex = -1;

  let currentActiveItemNode: HTMLElement | null = null;
  let currentActiveMarkNode: HTMLElement | null = null;

  function getItemNode(itemIndex: number): HTMLElement | null {
    return findSubtitleItem(deps.getSubtitleList(), itemIndex);
  }

  function clearCurrentMatchHighlight(): void {
    if (currentActiveItemNode) {
      currentActiveItemNode.classList.remove(SEARCH_CURRENT_CLASS);
      currentActiveItemNode = null;
    }
    if (currentActiveMarkNode) {
      currentActiveMarkNode.classList.remove(SEARCH_CURRENT_CLASS);
      currentActiveMarkNode = null;
    }
  }

  function computeMatches(needle: string): void {
    matches = [];
    matchesByItem = new Map();
    itemRanges = new Map();
    const secondary = resolveSecondarySearchAlignment();
    for (const item of getReadingSubtitleItems(state.clip.subtitleBody)) {
      const mainRanges = findLiteralMatches(item.content, needle);
      const secondaryText = secondary ? secondary.query(item) : null;
      const secondaryRanges = secondaryText ? findLiteralMatches(secondaryText, needle) : [];
      const total = mainRanges.length + secondaryRanges.length;
      if (total === 0) {
        continue;
      }
      itemRanges.set(item.index, {
        mainText: item.content,
        mainRanges,
        secondaryText,
        secondaryRanges
      });
      const itemList: SearchMatch[] = [];
      for (let ordinal = 0; ordinal < total; ordinal += 1) {
        const match: SearchMatch = { itemIndex: item.index, ordinal };
        matches.push(match);
        itemList.push(match);
      }
      matchesByItem.set(item.index, itemList);
    }
  }

  function highlightItemNode(node: HTMLElement, itemIndex: number): boolean {
    const ranges = itemRanges.get(itemIndex);
    if (!ranges) {
      return false;
    }
    const { mainText, mainRanges, secondaryText, secondaryRanges } = ranges;
    const subtextSpan = getSubtextNode(node);
    if (subtextSpan && isSubtextReady(node) && secondaryRanges.length > 0) {
      const subtextRaw = secondaryText ?? subtextSpan.textContent ?? "";
      subtextSpan.replaceChildren(buildHighlightFragment(subtextRaw, secondaryRanges, resolveNodeDocument(node)));
    }
    return replaceMainLineContent(node, buildHighlightFragment(mainText, mainRanges, resolveNodeDocument(node)));
  }

  function clearSearchHighlights(): void {
    clearCurrentMatchHighlight();
    const list = deps.getSubtitleList();
    if (!list) {
      return;
    }
    list.querySelectorAll(`mark.${SEARCH_HIT_MARK_CLASS}`).forEach((mark) => {
      mark.replaceWith(resolveNodeDocument(mark).createTextNode(mark.textContent || ""));
    });
    list.normalize();
  }

  function applyHighlightsToRendered(needle: string): void {
    if (!needle || matches.length === 0) {
      return;
    }
    for (const itemIndex of matchesByItem.keys()) {
      const node = getItemNode(itemIndex);
      if (node) {
        highlightItemNode(node, itemIndex);
      }
    }
  }

  function revealCurrentMatch({ scroll = true }: { scroll?: boolean } = {}): void {
    clearCurrentMatchHighlight();
    const list = deps.getSubtitleList();
    if (!list) {
      return;
    }
    const match = matches[currentIndex];
    if (!match) {
      return;
    }
    let node = getItemNode(match.itemIndex);
    if (!node) {
      deps.flushReadingSubtitleToIndex(match.itemIndex);
      node = getItemNode(match.itemIndex);
    }
    if (!node) {
      return;
    }
    const mark = node.querySelectorAll(`mark.${SEARCH_HIT_MARK_CLASS}`)[match.ordinal] as HTMLElement | undefined;
    if (mark) {
      mark.classList.add(SEARCH_CURRENT_CLASS);
      currentActiveMarkNode = mark;
    }
    node.classList.add(SEARCH_CURRENT_CLASS);
    currentActiveItemNode = node;
    if (scroll) {
      deps.noteManualReaderInteraction();
      const listRect = list.getBoundingClientRect();
      const nodeRect = node.getBoundingClientRect();
      const targetTop =
        listRect.height > 0 && nodeRect.height > 0
          ? Math.max(
              0,
              Math.round(
                list.scrollTop + (nodeRect.top - listRect.top) - Math.max(0, (list.clientHeight - node.clientHeight) / 2)
              )
            )
          : Math.max(
              0,
              Math.round(node.offsetTop - list.offsetTop - Math.max(0, (list.clientHeight - node.clientHeight) / 2))
            );
      const token = subtitleScrollFollow.beginProgrammaticScroll({
        behavior: "smooth",
        startTop: list.scrollTop,
        targetTop
      });
      const scrollResult = list.scrollTo?.({ top: targetTop, behavior: "smooth" });
      subtitleScrollFollow.attachProgrammaticScrollPromise(token, scrollResult);
    }
  }

  function updateSearchControls(): void {
    const clearBtn = activeById<HTMLButtonElement>(ids.readingSearchClearBtn);
    const countNode = activeById(ids.readingSearchCount);
    const prev = activeById<HTMLButtonElement>(ids.readingSearchPrevBtn);
    const next = activeById<HTMLButtonElement>(ids.readingSearchNextBtn);
    if (clearBtn) {
      clearBtn.hidden = !query;
    }
    if (countNode) {
      countNode.textContent = !query
        ? ""
        : matches.length > 0
          ? `${currentIndex + 1} / ${matches.length}`
          : "无匹配";
    }
    if (prev) {
      prev.disabled = matches.length === 0;
    }
    if (next) {
      next.disabled = matches.length === 0;
    }
  }

  function refresh(
    { preserveIndex = false, scroll = true }: { preserveIndex?: boolean; scroll?: boolean } = {}
  ): void {
    const input = deps.getSearchInput();
    const nextQuery = String(input?.value || "").trim();
    if (!nextQuery && !query) {
      clearCurrentMatchHighlight();
      matches = [];
      matchesByItem = new Map();
      itemRanges = new Map();
      currentIndex = -1;
      updateSearchControls();
      return;
    }
    const previousIndex = currentIndex;
    clearSearchHighlights();
    matches = [];
    matchesByItem = new Map();
    itemRanges = new Map();
    currentIndex = -1;
    query = nextQuery;
    if (!query) {
      updateSearchControls();
      return;
    }
    computeMatches(query);
    applyHighlightsToRendered(query);
    if (matches.length > 0) {
      currentIndex = preserveIndex ? Math.min(Math.max(previousIndex, 0), matches.length - 1) : 0;
      revealCurrentMatch({ scroll });
    }
    updateSearchControls();
  }

  function move(direction: 1 | -1): void {
    if (matches.length === 0) {
      return;
    }
    currentIndex = (currentIndex + direction + matches.length) % matches.length;
    revealCurrentMatch();
    updateSearchControls();
  }

  function clear(): void {
    const input = deps.getSearchInput();
    if (input) {
      input.value = "";
    }
    if (query) {
      clearSearchHighlights();
    } else {
      clearCurrentMatchHighlight();
    }
    matches = [];
    matchesByItem = new Map();
    itemRanges = new Map();
    currentIndex = -1;
    query = "";
    updateSearchControls();
  }

  function handleRangeAppended(fromIndex: number, toIndex: number): void {
    if (!query || matches.length === 0) {
      return;
    }
    let lo = 0;
    let hi = matches.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (matches[mid].itemIndex < fromIndex) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    let lastItemIndex = -1;
    for (let i = lo; i < matches.length && matches[i].itemIndex < toIndex; i += 1) {
      const itemIndex = matches[i].itemIndex;
      if (itemIndex === lastItemIndex) {
        continue;
      }
      lastItemIndex = itemIndex;
      const node = getItemNode(itemIndex);
      if (node) {
        highlightItemNode(node, itemIndex);
      }
    }
  }

  return { refresh, move, clear, handleRangeAppended };
}
