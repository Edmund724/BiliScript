import type { LiveTextToolRecord } from "../live/live-text-tool-records.js";
import { escapeHtml } from "../shared/string-utils.js";
import { hydrateMarkdownContent, renderMarkdown } from "../ui/markdown.js";

export interface ChatLiveTextRecordsDeps {
  root: HTMLElement | null;
  getRecords: () => LiveTextToolRecord[];
  subscribe: (listener: () => void) => () => void;
  onRetry: (callId: string) => void;
  onContinue: (callId: string) => void;
}

export interface ChatLiveTextRecords {
  setOpen(open: boolean): void;
  sync(): void;
}

function sourceLabel(record: LiveTextToolRecord): string {
  return record.source === "gemini" ? "Gemini · 视频分析" : "MOSS · 视频分析";
}

function statusLabel(record: LiveTextToolRecord): string {
  if (record.status === "running") return "正在生成…";
  return record.status === "completed" ? "已完成" : "失败";
}

function durationLabel(record: LiveTextToolRecord): string {
  if (record.durationMs === undefined) return "";
  const seconds = record.durationMs / 1000;
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
}

export function renderLiveTextToolRecordHtml(
  record: LiveTextToolRecord,
  { readOnly = false }: { readOnly?: boolean } = {}
): string {
  const duration = durationLabel(record);
  const error = record.status === "failed"
    ? `<p class="chat-live-tool-record-error">${escapeHtml(record.error || "伴看文本模型调用失败")}</p>`
    : "";
  const summary = (record.status !== "failed" || readOnly) && (record.summary || record.status === "running")
    ? `<p class="chat-live-tool-record-summary">${escapeHtml(record.summary || "文本模型正在整理结果")}</p>`
    : "";
  const actions = record.status === "failed" && !readOnly
    ? `<div class="chat-live-status-actions chat-live-tool-record-actions">
         <button type="button" data-live-record-action="retry" data-call-id="${escapeHtml(record.callId)}">重试</button>
         <button type="button" data-live-record-action="continue" data-call-id="${escapeHtml(record.callId)}">继续伴看</button>
       </div>`
    : "";
  const details = record.markdown && (readOnly || record.status === "completed")
    ? `<details class="chat-live-tool-record-details" data-record-details="${escapeHtml(record.callId)}">
         <summary>完整结果</summary>
         <div class="chat-live-tool-record-markdown markdown-body">${renderMarkdown(record.markdown)}</div>
       </details>`
    : "";
  return `<article class="chat-live-tool-record" data-live-tool-record="${escapeHtml(record.callId)}" data-status="${record.status}">
    <div class="chat-live-tool-record-meta">
      <span>${sourceLabel(record)}</span>
      <span class="chat-live-tool-record-status">${statusLabel(record)}</span>
      ${duration ? `<span class="chat-live-tool-record-duration">${duration}</span>` : ""}
    </div>
    <p class="chat-live-tool-record-objective">${escapeHtml(record.objective)}</p>
    ${error}
    ${summary}
    ${actions}
    ${details}
  </article>`;
}

export function createChatLiveTextRecords(deps: ChatLiveTextRecordsDeps): ChatLiveTextRecords {
  let open = false;
  let unsubscribe: (() => void) | null = null;

  deps.root?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>("button[data-live-record-action]");
    const callId = button?.dataset.callId;
    if (!button || !callId) return;
    if (button.dataset.liveRecordAction === "retry") deps.onRetry(callId);
    else if (button.dataset.liveRecordAction === "continue") deps.onContinue(callId);
  });

  function sync(): void {
    const root = deps.root;
    if (!root) return;
    if (!open) {
      root.hidden = true;
      root.replaceChildren();
      return;
    }
    const expanded = new Set(
      [...root.querySelectorAll<HTMLDetailsElement>("details[data-record-details][open]")]
        .map((details) => details.dataset.recordDetails || "")
    );
    const records = deps.getRecords();
    root.hidden = records.length === 0;
    root.innerHTML = records.map((record) => renderLiveTextToolRecordHtml(record)).join("");
    for (const details of root.querySelectorAll<HTMLDetailsElement>("details[data-record-details]")) {
      details.open = expanded.has(details.dataset.recordDetails || "");
    }
    hydrateMarkdownContent(root);
  }

  function setOpen(nextOpen: boolean): void {
    if (open === nextOpen) {
      sync();
      return;
    }
    open = nextOpen;
    unsubscribe?.();
    unsubscribe = open ? deps.subscribe(sync) : null;
    sync();
  }

  return { setOpen, sync };
}
