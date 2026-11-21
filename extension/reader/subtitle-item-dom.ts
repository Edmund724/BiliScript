export const SUBTITLE_ITEM_CLASS = "biliscript-reading-item";
export const SUBTITLE_TEXT_CLASS = "biliscript-reading-text";
export const SUBTITLE_SUBTEXT_CLASS = "biliscript-reading-subtext";

const subtitleItemIndex = new WeakMap<Element, Map<number, HTMLElement>>();

function isNodeValidInList(node: HTMLElement, listEl: Element): boolean {
  if (node.parentElement !== listEl) {
    return false;
  }
  if (listEl.isConnected && !node.isConnected) {
    return false;
  }
  return true;
}

export function clearSubtitleItemIndex(listEl: Element | null | undefined): void {
  if (!listEl) {
    return;
  }
  subtitleItemIndex.delete(listEl);
}

export function registerSubtitleItem(
  listEl: Element | null | undefined,
  itemIndex: number,
  itemEl: HTMLElement
): void {
  if (!listEl || !itemEl) {
    return;
  }
  let map = subtitleItemIndex.get(listEl);
  if (!map) {
    map = new Map<number, HTMLElement>();
    subtitleItemIndex.set(listEl, map);
  }
  map.set(itemIndex, itemEl);
}

export function indexSubtitleItems(
  listEl: Element | null | undefined,
  elements?: Iterable<Element> | ArrayLike<Element>
): void {
  if (!listEl) {
    return;
  }
  let map = subtitleItemIndex.get(listEl);
  if (!map) {
    map = new Map<number, HTMLElement>();
    subtitleItemIndex.set(listEl, map);
  }
  const targets = elements ?? listEl.children;
  if ("length" in targets) {
    const len = targets.length;
    for (let i = 0; i < len; i += 1) {
      const el = targets[i] as HTMLElement;
      if (el?.dataset?.index !== undefined) {
        const idx = Number(el.dataset.index);
        if (!Number.isNaN(idx)) {
          map.set(idx, el);
        }
      }
    }
  } else {
    for (const el of targets) {
      const htmlEl = el as HTMLElement;
      if (htmlEl?.dataset?.index !== undefined) {
        const idx = Number(htmlEl.dataset.index);
        if (!Number.isNaN(idx)) {
          map.set(idx, htmlEl);
        }
      }
    }
  }
}

function getTextNode(item: Element | null | undefined): HTMLElement | null {
  return item?.querySelector<HTMLElement>(`.${SUBTITLE_TEXT_CLASS}`) ?? null;
}

export function findSubtitleItem(
  listEl: Element | null | undefined,
  itemIndex: number
): HTMLElement | null {
  if (!listEl) {
    return null;
  }
  const map = subtitleItemIndex.get(listEl);
  if (map) {
    const node = map.get(itemIndex);
    if (node) {
      if (isNodeValidInList(node, listEl)) {
        return node;
      }
      map.delete(itemIndex);
    }
  }
  return listEl.querySelector<HTMLElement>(`[data-index="${itemIndex}"]`) ?? null;
}

export function closestSubtitleItem(node: Element | null | undefined): HTMLElement | null {
  return node?.closest<HTMLElement>(`.${SUBTITLE_ITEM_CLASS}`) ?? null;
}

export function getMainLineText(item: Element | null | undefined): string {
  const textNode = getTextNode(item);
  if (!textNode) {
    return "";
  }
  const subtext = getSubtextNode(item);
  let raw = "";
  for (const child of Array.from(textNode.childNodes)) {
    if (child === subtext) {
      continue;
    }
    raw += child.textContent || "";
  }
  return raw;
}

export function getSubtextNode(item: Element | null | undefined): HTMLElement | null {
  return getTextNode(item)?.querySelector<HTMLElement>(`.${SUBTITLE_SUBTEXT_CLASS}`) ?? null;
}

export function isSubtextReady(item: Element | null | undefined): boolean {
  return getSubtextNode(item)?.dataset.state === "ready";
}

export function replaceMainLineContent(
  item: Element | null | undefined,
  fragment: DocumentFragment
): boolean {
  const textNode = getTextNode(item);
  if (!textNode) {
    return false;
  }
  const subtext = getSubtextNode(item);
  const subtextFirst = Boolean(subtext && textNode.firstChild === subtext);
  for (const child of Array.from(textNode.childNodes)) {
    if (child === subtext) {
      continue;
    }
    textNode.removeChild(child);
  }
  if (subtext && !subtextFirst) {
    textNode.insertBefore(fragment, subtext);
  } else {
    textNode.appendChild(fragment);
  }
  return true;
}
