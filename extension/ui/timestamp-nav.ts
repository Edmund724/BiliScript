// timestamp-nav.ts — "assistant answer timestamp → clickable seek button" concern,
// extracted out of extension/pages/sidepanel.js (ticket 04 of sidepanel-split).
//
// Domain: ui (same dir as markdown.js / ui-renderer.js). Every dependency
// arrives via the injected deps object — no chrome/window imports here.
//
// Seek contract: the tab-message round trip is gone. `deps.seek(seconds)`
// performs the seek in-process and returns the applied position, or `null` when
// no video is bound (downgraded to a failure notice). The only production
// adapter is reader/chat-tab.ts's getTimestampNavDeps, which wraps the reader
// domain's seekReadingTarget. `deps.contextUrl` still guards the "no video
// context" case (empty → notice, no seek).
//
// TIMESTAMP_PATTERN has a single home in ./markdown.js — this module imports
// it instead of keeping a parallel copy.
// Exported functions:
//   - parseTimestampToSeconds(value)            pure; "mm:ss"/"hh:mm:ss" -> seconds
//   - unwrapTimestampInlineCode(text)           pure; strips backticks around timestamp-only inline code
//   - linkifyAssistantTimestamps(root, deps)    DOM walker; swaps timestamp text nodes for seek buttons
//   - jumpToAssistantTimestamp(seconds, label, deps)  async seek; deps injected at call time

import { formatClock, parseClock } from "../shared/clock-text.js";
import { isTimestampOnlyInlineCode, TIMESTAMP_PATTERN } from "./markdown.js";

export interface TimestampNavDeps {
  contextUrl?: string;
  isContextValid?: () => boolean;
  notice?: (message: string, autoHideMs?: number) => void;
  seek?: (seconds: number) => number | null;
}

export function unwrapTimestampInlineCode(text: unknown): string {
  return String(text || "").replace(/`([^`\n]+)`/g, (_, content: string) =>
    isTimestampOnlyInlineCode(content) ? content : `\`${content}\``
  );
}

export function linkifyAssistantTimestamps(root: Node | null | undefined, deps: TimestampNavDeps): void {
  if (!root) {
    return;
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
    TIMESTAMP_PATTERN.lastIndex = 0;
    if (!TIMESTAMP_PATTERN.test(current.textContent || "")) {
      continue;
    }
    textNodes.push(current);
  }

  textNodes.forEach((node) => {
    const text = node.textContent || "";
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let hasMatch = false;
    TIMESTAMP_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TIMESTAMP_PATTERN.exec(text))) {
      hasMatch = true;
      if (match.index > lastIndex) {
        fragment.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const timestamp = match[0];
      const seconds = parseClock(timestamp);
      if (seconds === null) {
        fragment.append(document.createTextNode(timestamp));
        lastIndex = match.index + timestamp.length;
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-timestamp-link";
      button.textContent = timestamp;
      button.setAttribute("title", `跳转到 ${timestamp}`);
      button.setAttribute("aria-label", `跳转到视频 ${timestamp}`);
      button.addEventListener("click", () => {
        void jumpToAssistantTimestamp(seconds, timestamp, deps);
      });
      fragment.append(button);
      lastIndex = match.index + timestamp.length;
    }
    if (!hasMatch) {
      return;
    }
    if (lastIndex < text.length) {
      fragment.append(document.createTextNode(text.slice(lastIndex)));
    }
    node.replaceWith(fragment);
  });
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
    // 进程内定位：content script 无 tab 消息链，seek 不经 chrome.tabs /
    // 跨标签导航，直接调注入的 seek（唯一生产实现是 reader 域单入口
    // seekReadingTarget）。返回 null = 未绑定到视频，与旧 { ok:false, error }
    // 回包同型降级。
    const seekedTo = deps.seek?.(safeSeconds);
    if (seekedTo === null) {
      throw new Error("视频时间跳转失败");
    }
  } catch (error) {
    deps.notice?.(`时间跳转失败：${(error as Error)?.message || error}`, 2600);
  }
}
