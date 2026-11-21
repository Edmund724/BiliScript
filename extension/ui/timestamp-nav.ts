import { formatClock, parseClock } from "../shared/clock-text.js";
import { isTimestampOnlyInlineCode } from "./markdown.js";
import { animateTriggerEnter, animateTriggerExit, cancelTriggerExit } from "./trigger-motion.js";

export interface SubtitlePreviewItem {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

export interface SubtitlePreviewMatch {
  time: string;
  text: string;
}

export interface TimestampNavDeps {
  contextUrl?: string;
  isContextValid?: () => boolean;
  notice?: (message: string, autoHideMs?: number) => void;
  seek?: (seconds: number) => number | null;
  getSubtitlePreview?: (seconds: number) => SubtitlePreviewMatch | null;
  tooltipContainer?: HTMLElement | null;
}

const TIMESTAMP_CITATION_PATTERN = /(\[|【)?(\d{1,3}:\d{2}(?::\d{2})?)(\]|】)?/g;
const WORD_CHAR_RE = /\w/;
const SUBTITLE_PREVIEW_MAX_CHARS = 140;
const SUBTITLE_NEARBY_MAX_DIFF_SEC = 8;
const TOOLTIP_HIDE_DELAY_MS = 120;

let nextTooltipId = 0;

interface TooltipHostState {
  activeTip: HTMLElement | null;
  activeAnchor: HTMLElement | null;
  hideTimer: number;
}

const tooltipHostStates = new WeakMap<HTMLElement, TooltipHostState>();
const boundTooltipHosts = new WeakSet<HTMLElement>();

function getTooltipHostState(host: HTMLElement): TooltipHostState {
  let state = tooltipHostStates.get(host);
  if (!state) {
    state = { activeTip: null, activeAnchor: null, hideTimer: 0 };
    tooltipHostStates.set(host, state);
  }
  return state;
}

function clearTooltipHideTimer(state: TooltipHostState): void {
  if (state.hideTimer) {
    window.clearTimeout(state.hideTimer);
    state.hideTimer = 0;
  }
}

function hideTimestampTooltip(host: HTMLElement, immediate = false): void {
  const state = tooltipHostStates.get(host);
  if (!state) {
    return;
  }
  clearTooltipHideTimer(state);
  const tip = state.activeTip;
  const anchor = state.activeAnchor;
  state.activeTip = null;
  state.activeAnchor = null;
  if (anchor && tip && anchor.getAttribute("aria-describedby") === tip.id) {
    anchor.removeAttribute("aria-describedby");
  }
  if (!tip) {
    return;
  }
  if (immediate) {
    cancelTriggerExit(tip);
    tip.remove();
    return;
  }
  animateTriggerExit({
    target: tip,
    fallbackOrigin: "bottom left",
    toScale: 0.96,
    durationMs: 110,
    onFinish: () => tip.remove()
  });
}

function scheduleHideTimestampTooltip(host: HTMLElement): void {
  const state = getTooltipHostState(host);
  clearTooltipHideTimer(state);
  state.hideTimer = window.setTimeout(() => {
    state.hideTimer = 0;
    hideTimestampTooltip(host);
  }, TOOLTIP_HIDE_DELAY_MS);
}

function ensureTooltipHostListeners(host: HTMLElement): void {
  if (boundTooltipHosts.has(host)) {
    return;
  }
  boundTooltipHosts.add(host);
  host.addEventListener("scroll", () => hideTimestampTooltip(host, true), { passive: true });
  host.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    const state = tooltipHostStates.get(host);
    if (!state?.activeTip) {
      return;
    }
    hideTimestampTooltip(host, true);
    event.preventDefault();
    event.stopPropagation();
  });
}

function showTimestampTooltip(
  host: HTMLElement,
  anchor: HTMLElement,
  preview: SubtitlePreviewMatch
): void {
  ensureTooltipHostListeners(host);
  const state = getTooltipHostState(host);
  clearTooltipHideTimer(state);
  if (state.activeTip && state.activeAnchor === anchor) {
    return;
  }
  hideTimestampTooltip(host, true);

  const tip = document.createElement("div");
  tip.className = "chat-timestamp-tooltip";
  tip.id = `biliscript-ts-tip-${++nextTooltipId}`;
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("data-chat-timestamp-tooltip", "");

  const head = document.createElement("div");
  head.className = "chat-timestamp-tooltip-head";
  const timeEl = document.createElement("span");
  timeEl.className = "chat-timestamp-tooltip-time";
  timeEl.textContent = preview.time;
  const hintEl = document.createElement("span");
  hintEl.className = "chat-timestamp-tooltip-hint";
  hintEl.textContent = "点击跳转";
  head.append(timeEl, hintEl);

  const textEl = document.createElement("div");
  textEl.className = "chat-timestamp-tooltip-text";
  textEl.textContent = preview.text;

  tip.append(head, textEl);
  tip.addEventListener("mouseenter", () => clearTooltipHideTimer(state));
  tip.addEventListener("mouseleave", () => scheduleHideTimestampTooltip(host));

  host.appendChild(tip);
  anchor.setAttribute("aria-describedby", tip.id);
  state.activeTip = tip;
  state.activeAnchor = anchor;

  const anchorRect = anchor.getBoundingClientRect();
  const boxRect = host.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const minLeft = host.scrollLeft + 4;
  const left = Math.min(
    Math.max(anchorRect.left - boxRect.left + host.scrollLeft - 12, minLeft),
    Math.max(host.scrollLeft + boxRect.width - tipRect.width - 4, minLeft)
  );
  const aboveTop = anchorRect.top - boxRect.top + host.scrollTop - tipRect.height - 6;
  const belowTop = anchorRect.bottom - boxRect.top + host.scrollTop + 6;
  const aboveFits = anchorRect.top - 6 - tipRect.height >= boxRect.top;
  const belowFits = anchorRect.bottom + 6 + tipRect.height <= boxRect.bottom;
  const preferAbove = aboveFits || (!belowFits && anchorRect.top - boxRect.top >= boxRect.bottom - anchorRect.bottom);
  const minTop = host.scrollTop + 4;
  const viewportHeight = host.clientHeight || boxRect.height;
  const maxTop = Math.max(host.scrollTop + viewportHeight - tipRect.height - 4, minTop);
  const top = Math.min(Math.max(preferAbove ? aboveTop : belowTop, minTop), maxTop);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;

  animateTriggerEnter({
    target: tip,
    trigger: anchor,
    fallbackOrigin: preferAbove ? "bottom left" : "top left",
    fromScale: 0.94,
    durationMs: 140
  });
}

export function findSubtitlePreviewAtTime(
  subtitleBody: readonly SubtitlePreviewItem[] | null | undefined,
  seconds: number
): SubtitlePreviewMatch | null {
  if (!Array.isArray(subtitleBody) || subtitleBody.length === 0 || !Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  const normalized: Array<{ from: number; to: number; content: string }> = [];
  for (const item of subtitleBody) {
    const content = String(item?.content ?? "").replace(/\s+/g, " ").trim();
    const from = Number(item?.from);
    const rawTo = Number(item?.to);
    if (!content || !Number.isFinite(from)) {
      continue;
    }
    const to = Number.isFinite(rawTo) && rawTo >= from ? rawTo : from;
    normalized.push({ from, to, content });
  }
  if (normalized.length === 0) {
    return null;
  }

  let hitIndex = -1;
  for (let i = 0; i < normalized.length; i += 1) {
    if (normalized[i].from <= seconds && seconds <= normalized[i].to) {
      hitIndex = i;
      break;
    }
  }
  if (hitIndex < 0) {
    let bestDiff = Infinity;
    for (let i = 0; i < normalized.length; i += 1) {
      const diff = Math.min(Math.abs(normalized[i].from - seconds), Math.abs(normalized[i].to - seconds));
      if (diff < bestDiff) {
        bestDiff = diff;
        hitIndex = i;
      }
    }
    if (bestDiff > SUBTITLE_NEARBY_MAX_DIFF_SEC) {
      return null;
    }
  }

  const hit = normalized[hitIndex];
  let excerpt = hit.content;
  if (excerpt.length < 24 && hitIndex + 1 < normalized.length) {
    const next = normalized[hitIndex + 1];
    if (next.from - hit.to <= 4) {
      excerpt = `${excerpt} ${next.content}`;
    }
  }
  if (excerpt.length > SUBTITLE_PREVIEW_MAX_CHARS) {
    excerpt = `${excerpt.slice(0, SUBTITLE_PREVIEW_MAX_CHARS).trimEnd()}…`;
  }
  return {
    time: formatClock(hit.from, { hours: "auto" }),
    text: excerpt
  };
}

export function unwrapTimestampInlineCode(text: unknown): string {
  return String(text || "").replace(/`([^`\n]+)`/g, (_, content: string) =>
    isTimestampOnlyInlineCode(content) ? content : `\`${content}\``
  );
}

export function linkifyAssistantTimestamps(root: Node | null | undefined, deps: TimestampNavDeps): number {
  if (!root) {
    return 0;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const current = walker.currentNode;
    if (!(current instanceof Text)) {
      continue;
    }
    const parent = current.parentElement;
    if (!parent || parent.closest("a, code, pre, button")) {
      continue;
    }
    TIMESTAMP_CITATION_PATTERN.lastIndex = 0;
    if (!TIMESTAMP_CITATION_PATTERN.test(current.textContent || "")) {
      continue;
    }
    textNodes.push(current);
  }

  const uniqueSeconds = new Set<number>();

  textNodes.forEach((node) => {
    const text = node.textContent || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let hasMatch = false;
    TIMESTAMP_CITATION_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP_CITATION_PATTERN.exec(text))) {
      const openBracket = match[1] || "";
      const timestamp = match[2];
      const closeBracket = match[3] || "";
      const pairedBrackets =
        (openBracket === "[" && closeBracket === "]") ||
        (openBracket === "【" && closeBracket === "】");

      const tsStart = match.index + openBracket.length;
      const tsEnd = tsStart + timestamp.length;
      const beforeTs = tsStart > 0 ? text[tsStart - 1] : "";
      const afterTs = tsEnd < text.length ? text[tsEnd] : "";
      if (WORD_CHAR_RE.test(beforeTs) || WORD_CHAR_RE.test(afterTs)) {
        continue;
      }

      const replaceStart = pairedBrackets ? match.index : tsStart;
      const replaceEnd = pairedBrackets ? match.index + match[0].length : tsEnd;
      const seconds = parseClock(timestamp);
      if (seconds === null) {
        continue;
      }

      hasMatch = true;
      uniqueSeconds.add(seconds);
      if (replaceStart > lastIndex) {
        fragment.append(document.createTextNode(text.slice(lastIndex, replaceStart)));
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-timestamp-link";
      button.dataset.timestampSeconds = String(seconds);
      button.textContent = `[${timestamp}]`;
      button.setAttribute("aria-label", `跳转到视频 ${timestamp}`);
      if (!deps.getSubtitlePreview) {
        button.setAttribute("title", `跳转到 ${timestamp}`);
      } else {
        const resolveHost = () =>
          deps.tooltipContainer ||
          (button.closest(".chat-messages") as HTMLElement | null) ||
          document.body;
        const triggerShow = () => {
          const preview = deps.getSubtitlePreview?.(seconds);
          if (!preview) {
            return;
          }
          showTimestampTooltip(resolveHost(), button, preview);
        };
        const triggerScheduleHide = () => {
          scheduleHideTimestampTooltip(resolveHost());
        };
        button.addEventListener("mouseenter", triggerShow);
        button.addEventListener("mouseleave", triggerScheduleHide);
        button.addEventListener("focus", triggerShow);
        button.addEventListener("blur", () => hideTimestampTooltip(resolveHost(), true));
      }
      button.addEventListener("click", () => {
        if (deps.getSubtitlePreview) {
          const host =
            deps.tooltipContainer ||
            (button.closest(".chat-messages") as HTMLElement | null) ||
            document.body;
          hideTimestampTooltip(host, true);
        }
        void jumpToAssistantTimestamp(seconds, timestamp, deps);
      });
      fragment.append(button);
      lastIndex = replaceEnd;
    }
    if (!hasMatch) {
      return;
    }
    if (lastIndex < text.length) {
      fragment.append(document.createTextNode(text.slice(lastIndex)));
    }
    node.replaceWith(fragment);
  });

  return uniqueSeconds.size;
}

async function jumpToAssistantTimestamp(
  seconds: number,
  label = "",
  deps: TimestampNavDeps = {}
): Promise<void> {
  if (deps.isContextValid && !deps.isContextValid()) {
    deps.notice?.("当前播放页与该对话所属视频不一致，无法跳转进度。", 2600);
    return;
  }
  const safeSeconds = Math.max(0, Number(seconds || 0) || 0);
  const targetUrl = String(deps.contextUrl || "").trim();
  if (!targetUrl) {
    deps.notice?.("当前没有可跳转的视频上下文。", 2200);
    return;
  }

  deps.notice?.(`正在跳转到 ${label || formatClock(safeSeconds, { hours: "auto" })}...`, 1800);

  try {
    const seekedTo = deps.seek?.(safeSeconds);
    if (seekedTo === null) {
      throw new Error("视频时间跳转失败");
    }
  } catch (error) {
    deps.notice?.(`时间跳转失败：${(error as Error)?.message || error}`, 2600);
  }
}
