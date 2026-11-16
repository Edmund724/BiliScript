import type { StoredConversation } from "../chat/conversation-storage.js";
import type { StorageArea } from "../chat/conversation-store.js";
import { formatClock } from "../shared/clock-text.js";
import {
  upsertLiveTextToolHistoryEntry,
  type LiveTextToolVideo
} from "./live-text-tool-history.js";

export type LiveTextToolSource = "gemini" | "moss";
export type LiveTextToolStatus = "running" | "completed" | "failed";

export interface LiveTextToolRecord {
  callId: string;
  source: LiveTextToolSource;
  status: LiveTextToolStatus;
  objective: string;
  summary: string;
  markdown: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  error?: string;
  video?: LiveTextToolVideo;
}

export type LiveTextToolRecordEvent =
  | {
      type: "started";
      callId: string;
      source: LiveTextToolSource;
      objective: string;
      startedAt: number;
      video?: LiveTextToolVideo;
      retry?: boolean;
    }
  | { type: "progress"; callId: string; summary: string; markdown: string }
  | {
      type: "completed";
      callId: string;
      summary: string;
      markdown: string;
      endedAt: number;
    }
  | { type: "failed"; callId: string; error: string; endedAt: number }
  | { type: "dismissed"; callId: string };

export interface LiveTextToolRecordStore {
  getSnapshot(): LiveTextToolRecord[];
  apply(event: LiveTextToolRecordEvent): void;
  failRunning(error: string, endedAt: number): void;
  clear(): void;
  subscribe(listener: () => void): () => void;
}

export interface LiveTextToolCoordinatorDeps {
  persistRecord?: (record: LiveTextToolRecord) => Promise<void> | void;
  canRetry?: () => boolean;
}

export interface StartLiveTextToolAttemptOptions {
  callId: string;
  retry?: boolean;
  source: LiveTextToolSource;
  objective: string;
  startedAt: number;
  video?: LiveTextToolVideo;
  onRetry: () => void;
}

export interface LiveTextToolCoordinator {
  getSnapshot(): LiveTextToolRecord[];
  subscribe(listener: () => void): () => void;
  startAttempt(options: StartLiveTextToolAttemptOptions): number | null;
  isCurrentAttempt(callId: string, attempt: number): boolean;
  apply(attempt: number, event: LiveTextToolRecordEvent): void;
  failRecord(callId: string, error: string): void;
  failRunning(error: string): void;
  clear(): void;
  retry(callId: string): boolean;
  dismiss(callId: string): void;
}

export interface LiveOverviewChapterInput {
  title?: string;
  time?: string;
  from?: number;
  summary?: string;
}

export interface LiveOverviewQuoteInput {
  content?: string;
  time?: string;
  from?: number;
}

export interface LiveOverviewMarkdownInput {
  summary?: string;
  chapters?: readonly LiveOverviewChapterInput[];
  quotes?: readonly LiveOverviewQuoteInput[];
}

export function formatLiveOverviewMarkdown(input: LiveOverviewMarkdownInput): string {
  const sections = ["# 全片概览", String(input.summary || "").trim()];
  const chapters = (input.chapters || []).flatMap((chapter) => {
    const title = String(chapter.title || "").trim();
    const time =
      chapter.time !== undefined
        ? String(chapter.time).trim()
        : typeof chapter.from === "number"
          ? formatClock(chapter.from, { hours: "auto" })
          : "";
    const detail = String(chapter.summary || "").trim();
    if (!title && !detail) return [];
    return [`### ${time ? `[${time}] ` : ""}${title}\n${detail}`.trim()];
  });
  if (chapters.length > 0) {
    sections.push("## 分章节详细笔记", ...chapters);
  }
  const quotes = (input.quotes || []).flatMap((quote) => {
    const content = String(quote.content || "").trim();
    const time =
      quote.time !== undefined
        ? String(quote.time).trim()
        : typeof quote.from === "number"
          ? formatClock(quote.from, { hours: "auto" })
          : "";
    return content ? [`- ${time ? `[${time}] ` : ""}${content}`] : [];
  });
  if (quotes.length > 0) {
    sections.push("## 关键原话", ...quotes);
  }
  return sections.filter(Boolean).join("\n\n");
}

export function formatLiveOverviewRecordResult(
  result: unknown
): { summary: string; markdown: string } | null {
  if (!result || typeof result !== "object") {
    return null;
  }
  const value = result as Record<string, unknown>;
  if (value.ok !== true) {
    return null;
  }
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  const chapters = Array.isArray(value.chapters)
    ? value.chapters.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const chapter = raw as Record<string, unknown>;
        return [{
          title: typeof chapter.title === "string" ? chapter.title : "",
          time: typeof chapter.time === "string" ? chapter.time : "",
          summary: typeof chapter.summary === "string" ? chapter.summary : ""
        }];
      })
    : [];
  const quotes = Array.isArray(value.quotes)
    ? value.quotes.flatMap((raw) => {
        if (!raw || typeof raw !== "object") return [];
        const quote = raw as Record<string, unknown>;
        return [{
          content: typeof quote.content === "string" ? quote.content : "",
          time: typeof quote.time === "string" ? quote.time : ""
        }];
      })
    : [];
  const markdown = formatLiveOverviewMarkdown({ summary, chapters, quotes });
  if (!markdown || markdown === "# 全片概览") return null;
  return { summary: summarizeLiveTextToolMarkdown(summary || markdown), markdown };
}

export function summarizeLiveTextToolMarkdown(markdown: string, maxChars = 180): string {
  const plain = String(markdown || "")
    .replace(/```[^\n]*(?:\n|$)/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+])\s+/gm, "")
    .replace(/[*_~`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(plain);
  return chars.length > maxChars
    ? `${chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`
    : plain;
}

function sanitizeError(error: string): string {
  const sanitized = String(error || "")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [已隐藏]")
    .replace(/\b(api[_-]?key|access_token|authorization)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1=[已隐藏]")
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[已隐藏]")
    .trim();
  return Array.from(sanitized || "伴看文本模型调用失败").slice(0, 500).join("");
}

export function createLiveTextToolRecordStore(): LiveTextToolRecordStore {
  const records = new Map<string, LiveTextToolRecord>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {}
    }
  }

  function apply(event: LiveTextToolRecordEvent): void {
    const callId = event.callId.trim();
    if (!callId) return;
    const current = records.get(callId);

    if (event.type === "dismissed") {
      if (records.delete(callId)) notify();
      return;
    }

    if (event.type === "started") {
      if (current && !event.retry) return;
      records.set(callId, {
        callId,
        source: event.source,
        status: "running",
        objective: event.objective.trim(),
        summary: "",
        markdown: "",
        startedAt: event.startedAt,
        ...(event.video ? { video: { ...event.video } } : {})
      });
      notify();
      return;
    }

    if (!current || current.status !== "running") return;

    if (event.type === "progress") {
      if (current.summary === event.summary && current.markdown === event.markdown) return;
      records.set(callId, {
        ...current,
        summary: event.summary,
        markdown: event.markdown
      });
      notify();
      return;
    }

    const endedAt = Math.max(current.startedAt, event.endedAt);
    if (event.type === "completed") {
      records.set(callId, {
        ...current,
        status: "completed",
        summary: event.summary,
        markdown: event.markdown,
        endedAt,
        durationMs: endedAt - current.startedAt,
        error: undefined
      });
    } else {
      records.set(callId, {
        ...current,
        status: "failed",
        endedAt,
        durationMs: endedAt - current.startedAt,
        error: sanitizeError(event.error)
      });
    }
    notify();
  }

  return {
    getSnapshot: () => [...records.values()].map((record) => ({ ...record })),
    apply,
    failRunning(error, endedAt) {
      for (const record of [...records.values()]) {
        if (record.status === "running") {
          apply({ type: "failed", callId: record.callId, error, endedAt });
        }
      }
    },
    clear() {
      if (records.size === 0) return;
      records.clear();
      notify();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export async function persistLiveTextToolRecord(
  record: LiveTextToolRecord,
  storage?: StorageArea
): Promise<void> {
  const target = storage || (typeof chrome !== "undefined" ? (chrome.storage?.local as StorageArea) : undefined);
  if (!target || (record.status !== "completed" && record.status !== "failed") || !record.video) return;
  const { updateConversationHistory } = await import("../chat/conversation-storage.js");
  await updateConversationHistory(target, (current) =>
    upsertLiveTextToolHistoryEntry(current, record) as StoredConversation[]
  );
}

export function createLiveTextToolCoordinator(
  deps: LiveTextToolCoordinatorDeps = {}
): LiveTextToolCoordinator {
  const store = createLiveTextToolRecordStore();
  const attempts = new Map<string, number>();
  const retries = new Map<string, () => void>();
  const persistence = new Map<string, string>();

  store.subscribe(() => {
    if (!deps.persistRecord) return;
    for (const record of store.getSnapshot()) {
      if (record.status !== "completed" && record.status !== "failed") continue;
      const key = `${record.status}:${record.startedAt}:${record.endedAt ?? ""}`;
      if (persistence.get(record.callId) === key) continue;
      persistence.set(record.callId, key);
      try {
        void Promise.resolve(deps.persistRecord(record)).catch(() => {});
      } catch {}
    }
  });

  function startAttempt(options: StartLiveTextToolAttemptOptions): number | null {
    const retry = Boolean(options.retry);
    if (!retry && retries.has(options.callId)) return null;
    const attempt = (attempts.get(options.callId) ?? 0) + 1;
    attempts.set(options.callId, attempt);
    retries.set(options.callId, options.onRetry);
    store.apply({
      type: "started",
      callId: options.callId,
      source: options.source,
      objective: options.objective,
      startedAt: options.startedAt,
      video: options.video,
      retry
    });
    return attempt;
  }

  function isCurrentAttempt(callId: string, attempt: number): boolean {
    return attempts.get(callId) === attempt;
  }

  function apply(attempt: number, event: LiveTextToolRecordEvent): void {
    if (attempts.get(event.callId) !== attempt) return;
    store.apply(event);
  }

  function failRecord(callId: string, error: string): void {
    if (!store.getSnapshot().some((record) => record.callId === callId && record.status === "running")) {
      return;
    }
    const attempt = (attempts.get(callId) ?? 0) + 1;
    attempts.set(callId, attempt);
    store.apply({ type: "failed", callId, error, endedAt: Date.now() });
  }

  function failRunning(error: string): void {
    for (const record of store.getSnapshot()) {
      if (record.status === "running") {
        failRecord(record.callId, error);
      }
    }
  }

  function clear(): void {
    failRunning("本次分析已取消。");
    attempts.clear();
    retries.clear();
    persistence.clear();
    store.clear();
  }

  function retry(callId: string): boolean {
    const record = store.getSnapshot().find((item) => item.callId === callId);
    const retryFn = retries.get(callId);
    if (record?.status !== "failed" || !retryFn || !(deps.canRetry?.() ?? true)) return false;
    retryFn();
    return true;
  }

  function dismiss(callId: string): void {
    const record = store.getSnapshot().find((item) => item.callId === callId);
    if (record?.status !== "failed") return;
    attempts.delete(callId);
    retries.delete(callId);
    store.apply({ type: "dismissed", callId });
  }

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    startAttempt,
    isCurrentAttempt,
    apply,
    failRecord,
    failRunning,
    clear,
    retry,
    dismiss
  };
}
