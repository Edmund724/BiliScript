import { getActiveReaderWindow } from "../../shared/active-host.js";
import { isTextNode, resolveNodeDocument } from "../../shared/cross-doc.js";
import {
  animateTriggerEnter,
  animateTriggerExit,
  cancelTriggerExit
} from "../../ui/trigger-motion.js";
import { SEARCH_PREVIEW_MAX_CHARS, type ChatSearchSource } from "../search-sources.js";

export interface SourcePreviewDeps {
  messages: HTMLElement;
}

export interface SourcePreviewController {
  show: (anchor: Element, source: ChatSearchSource) => void;
  hide: () => void;
  bindAnchor: (anchor: HTMLElement, source: ChatSearchSource) => void;
  renderCitations: (root: HTMLElement, sources: ChatSearchSource[]) => void;
  openUrl: (url: string) => void;
}

export function openSourceUrl(url: string): void {
  const target = String(url || "").trim();
  if (!target || !/^https?:\/\//i.test(target)) {
    return;
  }
  getActiveReaderWindow().open(target, "_blank", "noopener");
}

function hideSourcePreview(container: HTMLElement): void {
  container.querySelectorAll<HTMLElement>("[data-chat-search-preview]").forEach((el) => {
    if (el.hasAttribute("data-biliscript-closing")) {
      cancelTriggerExit(el);
      return;
    }
    animateTriggerExit({
      target: el,
      fallbackOrigin: "top left",
      toScale: 0.96,
      durationMs: 110,
      onFinish: () => el.remove()
    });
  });
}

function showSourcePreview(container: HTMLElement, anchor: Element, source: ChatSearchSource): void {
  hideSourcePreview(container);
  let domain = "";
  try {
    domain = new URL(source.url).hostname;
  } catch {
    domain = "";
  }
  const doc = resolveNodeDocument(container);
  const card = doc.createElement("div");
  card.className = "chat-search-preview";
  card.setAttribute("data-chat-search-preview", "");
  const title = doc.createElement("div");
  title.className = "chat-search-preview-title";
  title.textContent = source.title || source.url;
  const host = doc.createElement("div");
  host.className = "chat-search-preview-host";
  host.textContent = domain || source.url;
  const excerpt = doc.createElement("div");
  excerpt.className = "chat-search-preview-excerpt";
  excerpt.textContent = String(source.snippet || "").slice(0, SEARCH_PREVIEW_MAX_CHARS);
  card.append(title, host);
  if (excerpt.textContent) {
    card.appendChild(excerpt);
  }
  container.appendChild(card);
  const anchorRect = anchor.getBoundingClientRect();
  const boxRect = container.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const minLeft = container.scrollLeft + 4;
  const left = Math.min(
    Math.max(anchorRect.left - boxRect.left + container.scrollLeft - 40, minLeft),
    Math.max(container.scrollLeft + boxRect.width - cardRect.width - 4, minLeft)
  );
  const belowTop = anchorRect.bottom - boxRect.top + container.scrollTop + 6;
  const aboveTop = anchorRect.top - boxRect.top + container.scrollTop - cardRect.height - 6;
  const belowFits = anchorRect.bottom + 6 + cardRect.height <= boxRect.bottom;
  const aboveFits = anchorRect.top - 6 - cardRect.height >= boxRect.top;
  const preferAbove = !belowFits && (aboveFits || anchorRect.top - boxRect.top > boxRect.bottom - anchorRect.bottom);
  const minTop = container.scrollTop + 4;
  const viewportHeight = container.clientHeight || boxRect.height;
  const maxTop = Math.max(container.scrollTop + viewportHeight - cardRect.height - 4, minTop);
  const top = Math.min(Math.max(preferAbove ? aboveTop : belowTop, minTop), maxTop);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  animateTriggerEnter({
    target: card,
    trigger: anchor,
    fallbackOrigin: preferAbove ? "bottom left" : "top left",
    fromScale: 0.94,
    durationMs: 150
  });
}

export function createSourcePreviewController(deps: SourcePreviewDeps): SourcePreviewController {
  const citationPattern = /\[(\d{1,2})\]/g;

  deps.messages.addEventListener("scroll", () => hideSourcePreview(deps.messages), { passive: true });
  deps.messages.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !deps.messages.querySelector("[data-chat-search-preview]")) {
      return;
    }
    hideSourcePreview(deps.messages);
    event.preventDefault();
    event.stopPropagation();
  });

  function show(anchor: Element, source: ChatSearchSource): void {
    showSourcePreview(deps.messages, anchor, source);
  }

  function hide(): void {
    hideSourcePreview(deps.messages);
  }

  function bindAnchor(anchor: HTMLElement, source: ChatSearchSource): void {
    anchor.addEventListener("mouseenter", () => showSourcePreview(deps.messages, anchor, source));
    anchor.addEventListener("mouseleave", () => hideSourcePreview(deps.messages));
    anchor.addEventListener("focus", () => showSourcePreview(deps.messages, anchor, source));
    anchor.addEventListener("blur", () => hideSourcePreview(deps.messages));
  }

  function renderCitations(root: HTMLElement, sources: ChatSearchSource[]): void {
    if (!sources.length) {
      return;
    }
    const doc = resolveNodeDocument(root);
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const current = walker.currentNode;
      if (!isTextNode(current)) {
        continue;
      }
      const parent = current.parentElement;
      if (!parent || parent.closest("a, code, pre, button, sup")) {
        continue;
      }
      citationPattern.lastIndex = 0;
      if (!citationPattern.test(current.textContent || "")) {
        continue;
      }
      textNodes.push(current);
    }
    textNodes.forEach((textNode) => {
      const text = textNode.textContent || "";
      const fragment = doc.createDocumentFragment();
      let lastIndex = 0;
      let hasMatch = false;
      citationPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = citationPattern.exec(text))) {
        hasMatch = true;
        if (match.index > lastIndex) {
          fragment.append(doc.createTextNode(text.slice(lastIndex, match.index)));
        }
        const marker = match[0];
        const index = Number(match[1]);
        const source = sources[index - 1];
        if (!source || !source.url) {
          fragment.append(doc.createTextNode(marker));
        } else {
          const cite = doc.createElement("sup");
          cite.className = "chat-cite";
          cite.tabIndex = 0;
          cite.setAttribute("role", "button");
          cite.setAttribute("aria-label", `打开来源 ${index}：${source.title || source.url}`);
          cite.setAttribute("data-cite-url", source.url);
          cite.textContent = marker;
          cite.addEventListener("click", () => {
            openSourceUrl(source.url);
          });
          cite.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") {
              return;
            }
            event.preventDefault();
            openSourceUrl(source.url);
          });
          bindAnchor(cite, source);
          fragment.append(cite);
        }
        lastIndex = match.index + marker.length;
      }
      if (!hasMatch) {
        return;
      }
      if (lastIndex < text.length) {
        fragment.append(doc.createTextNode(text.slice(lastIndex)));
      }
      textNode.replaceWith(fragment);
    });
  }

  return {
    show,
    hide,
    bindAnchor,
    renderCitations,
    openUrl: openSourceUrl
  };
}
