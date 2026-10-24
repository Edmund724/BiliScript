// 字幕列表条目 DOM 结构的唯一真源与条目索引维护。
//
// 条目形态（由 batched-render 的 buildReadingSubtitleItemHtml 产出）：
//
//   button.biliscript-reading-item[data-index][data-seconds]
//     span.biliscript-reading-time
//     span.biliscript-reading-text
//       主行文本节点 / 搜索 mark …
//       span.biliscript-reading-subtext[data-state]   （可选，块级副行）
//
// 主行 = text span 里除副行 span 之外的全部子节点；副行是 text span 内嵌的
// 块级 span，必须与主行分开读写——把副行混进主行文本会在重建时把两行压平成
// 一行。条目查找（按 data-index / 从任意节点向上找条目）、主行/副行的读取与
// 写入都只经本模块，消费方不持有类名或层级假设。
//
// 条目索引：以 WeakMap<Element, Map<number, HTMLElement>> 维护列表容器内的
// data-index → HTMLElement 快速映射。首批渲染、后续批次追加和整表重建均同步维护；
// 查找条目优先走索引（O(1)），索引未命中时回退属性选择器查找；若索引节点脱离
// 容器或脱离 DOM，则自动失效并不返回上一代节点。
//
// 零 import（只使用 DOM 类型）：batched-render 可以安全 import 类名与索引接口，
// 不会引入任何依赖边。

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

// 按 data-index 在列表容器内查条目：优先读索引，失效或缺失时回退全兄弟属性扫描。
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

// 从任意后代节点向上找所属条目。
export function closestSubtitleItem(node: Element | null | undefined): HTMLElement | null {
  return node?.closest<HTMLElement>(`.${SUBTITLE_ITEM_CLASS}`) ?? null;
}

// 主行原文：text span 里除副行 span 之外的全部子节点文本拼接（mark 在内时
// 拼回的仍是原文本）。不 trim，不把副行吃进来。
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

// 副行结构就绪 = 副行存在且 data-state 为 ready（真实译文）。占位行
// （loading / fail）不参与任何按文本的读写。只回答结构事实，不回答搜索对齐
// 是否可用（那取决于副轨配对索引）。
export function isSubtextReady(item: Element | null | undefined): boolean {
  return getSubtextNode(item)?.dataset.state === "ready";
}

// 用 fragment 重写主行内容：移除 text span 里除副行 span 之外的全部子节点，
// fragment 插到副行之前（无副行时追加到末尾）。副行节点身份与「主文在前、
// 副行在后」的顺序保持不变。找不到条目 / text span 时返回 false。
export function replaceMainLineContent(
  item: Element | null | undefined,
  fragment: DocumentFragment
): boolean {
  const textNode = getTextNode(item);
  if (!textNode) {
    return false;
  }
  const subtext = getSubtextNode(item);
  for (const child of Array.from(textNode.childNodes)) {
    if (child === subtext) {
      continue;
    }
    textNode.removeChild(child);
  }
  if (subtext) {
    textNode.insertBefore(fragment, subtext);
  } else {
    textNode.appendChild(fragment);
  }
  return true;
}
