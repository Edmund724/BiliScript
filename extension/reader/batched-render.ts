import { escapeHtml } from "../shared/string-utils.js";
import { formatClock } from "../shared/clock-text.js";
import { clipState, state } from "../core/state.js";
import { secondaryAlignmentFor } from "../subtitle/alignment.js";
import type { ReadingSubtitleItem } from "../subtitle/core.js";
import {
  SUBTITLE_ITEM_CLASS,
  SUBTITLE_SUBTEXT_CLASS,
  SUBTITLE_TEXT_CLASS,
  registerSubtitleItem
} from "./subtitle-item-dom.js";

const SUBTITLE_FIRST_BATCH = 120;
const TRANSCRIPT_APPEND_BATCH = 200;

interface SubtitleAppendTask {
  listEl: HTMLElement;
  items: ReadingSubtitleItem[];
  cursor: number;
  withHours: boolean;
}

let subtitleAppendTask: SubtitleAppendTask | null = null;
let subtitleAppendRafId = 0;

const SECONDARY_LOADING_TEXT = "译文加载中…";
const SECONDARY_FAIL_TEXT = "译文加载失败";

type ReadingSubtextState = "ready" | "loading" | "fail";

interface ReadingSubtext {
  text: string;
  state: ReadingSubtextState;
}

function resolveReadingSubtext(item: ReadingSubtitleItem): ReadingSubtext | null {
  if (!state.settings.bilingualSubtitles) {
    return null;
  }
  const slot = clipState.secondarySubtitle;
  if (!slot) {
    return null;
  }
  if (slot.state === "loading") {
    return { text: SECONDARY_LOADING_TEXT, state: "loading" };
  }
  if (slot.state === "error") {
    return { text: SECONDARY_FAIL_TEXT, state: "fail" };
  }
  if (slot.state !== "ready") {
    return null;
  }
  const body = slot.body;
  if (!Array.isArray(body) || body.length === 0) {
    return null;
  }
  const text = secondaryAlignmentFor(body).query(item);
  return text ? { text, state: "ready" } : null;
}

function buildReadingSubtextHtml(item: ReadingSubtitleItem): string {
  const subtext = resolveReadingSubtext(item);
  if (!subtext) {
    return "";
  }
  return `<span class="${SUBTITLE_SUBTEXT_CLASS}" data-state="${subtext.state}">${escapeHtml(
    subtext.text
  )}</span>`;
}

export function buildReadingSubtitleItemHtml(item: ReadingSubtitleItem, withHours: boolean) {
  const subtextHtml = buildReadingSubtextHtml(item);
  const mainHtml = escapeHtml(item.content);
  const textBodyHtml =
    subtextHtml && state.settings.bilingualDisplayOrder === "translation-first"
      ? `${subtextHtml}${mainHtml}`
      : `${mainHtml}${subtextHtml}`;
  return `
    <button
      type="button"
      class="${SUBTITLE_ITEM_CLASS}"
      data-index="${item.index}"
      data-seconds="${item.from}"
    >
      <span class="biliscript-reading-time">${escapeHtml(
        formatClock(item.from, { hours: withHours ? "always" : "never" })
      )}</span>
      <span class="${SUBTITLE_TEXT_CLASS}">${textBodyHtml}</span>
    </button>
  `;
}

function insertReadingSubtitleRange(
  listEl: HTMLElement,
  items: ReadingSubtitleItem[],
  from: number,
  to: number,
  withHours: boolean
) {
  if (to <= from) {
    return;
  }
  const prevCount = listEl.children.length;
  let html = "";
  for (let i = from; i < to; i += 1) {
    html += buildReadingSubtitleItemHtml(items[i], withHours);
  }
  listEl.insertAdjacentHTML("beforeend", html);
  const newCount = listEl.children.length;
  for (let i = prevCount; i < newCount; i += 1) {
    const child = listEl.children[i] as HTMLElement;
    const indexStr = child?.dataset?.index;
    if (indexStr !== undefined) {
      registerSubtitleItem(listEl, Number(indexStr), child);
    }
  }
}

type ReadingSubtitleBatchHook = (fromIndex: number, toIndex: number) => void;

let batchAppendedHook: ReadingSubtitleBatchHook | null = null;

export function setReadingSubtitleBatchHook(hook: ReadingSubtitleBatchHook | null): void {
  batchAppendedHook = typeof hook === "function" ? hook : null;
}

function notifyReadingSubtitleBatchAppended(fromIndex: number, toIndex: number): void {
  if (toIndex <= fromIndex || !batchAppendedHook) {
    return;
  }
  try {
    batchAppendedHook(fromIndex, toIndex);
  } catch {
  }
}

export function cancelReadingSubtitleAppend() {
  if (subtitleAppendRafId) {
    window.cancelAnimationFrame(subtitleAppendRafId);
    subtitleAppendRafId = 0;
  }
  if (calibrationRafId) {
    window.cancelAnimationFrame(calibrationRafId);
    calibrationRafId = 0;
  }
  subtitleAppendTask = null;
}

function scheduleReadingSubtitleAppend() {
  if (subtitleAppendRafId) {
    return;
  }
  subtitleAppendRafId = window.requestAnimationFrame(appendReadingSubtitleBatch);
}

function appendReadingSubtitleBatch() {
  subtitleAppendRafId = 0;
  const task = subtitleAppendTask;
  if (!task) {
    return;
  }
  if (!task.listEl?.isConnected) {
    subtitleAppendTask = null;
    return;
  }
  const end = Math.min(task.items.length, task.cursor + TRANSCRIPT_APPEND_BATCH);
  const batchFrom = task.cursor;
  insertReadingSubtitleRange(task.listEl, task.items, task.cursor, end, task.withHours);
  task.cursor = end;
  notifyReadingSubtitleBatchAppended(batchFrom, end);
  if (task.cursor < task.items.length) {
    scheduleReadingSubtitleAppend();
  } else {
    subtitleAppendTask = null;
  }
}

const SUBTITLE_SYNC_FLUSH_LIMIT = 200;

export function ensureReadingSubtitleRenderedUpTo(targetIndex: number) {
  const task = subtitleAppendTask;
  if (!task) {
    return true;
  }
  if (!task.listEl?.isConnected) {
    subtitleAppendTask = null;
    return true;
  }
  if (targetIndex < task.cursor) {
    return true;
  }
  const end = Math.min(task.items.length, targetIndex + 1);
  const flushEnd = Math.min(end, task.cursor + SUBTITLE_SYNC_FLUSH_LIMIT);
  const flushFrom = task.cursor;
  insertReadingSubtitleRange(task.listEl, task.items, task.cursor, flushEnd, task.withHours);
  task.cursor = flushEnd;
  notifyReadingSubtitleBatchAppended(flushFrom, flushEnd);
  if (task.cursor >= task.items.length) {
    subtitleAppendTask = null;
    return true;
  }
  scheduleReadingSubtitleAppend();
  return task.cursor > targetIndex;
}

export function startReadingSubtitleAppendTask(task: SubtitleAppendTask) {
  subtitleAppendTask = task;
  scheduleReadingSubtitleAppend();
}

const ITEM_ESTIMATE_VAR = "--biliscript-reader-item-estimate";

let calibrationRafId = 0;

export function calibrateReadingSubtitleItemEstimate(listEl: HTMLElement) {
  if (calibrationRafId) {
    window.cancelAnimationFrame(calibrationRafId);
  }
  calibrationRafId = window.requestAnimationFrame(() => {
    calibrationRafId = 0;
    if (!listEl.isConnected) {
      return;
    }
    const listRect = listEl.getBoundingClientRect();
    if (!(listRect.height > 0)) {
      return;
    }
    let total = 0;
    let count = 0;
    for (const child of listEl.children) {
      const rect = child.getBoundingClientRect();
      if (rect.bottom <= listRect.top || rect.top >= listRect.bottom) {
        continue;
      }
      total += rect.height;
      count += 1;
    }
    if (count < 3) {
      return;
    }
    listEl.style.setProperty(ITEM_ESTIMATE_VAR, `${Math.round(total / count)}px`);
  });
}

export { SUBTITLE_FIRST_BATCH };
