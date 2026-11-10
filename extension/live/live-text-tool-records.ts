import type { LiveTextToolVideo } from "./live-text-tool-history.js";

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
