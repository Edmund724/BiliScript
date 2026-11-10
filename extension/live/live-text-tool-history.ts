import type { LiveTextToolRecord } from "./live-text-tool-records.js";

export const LIVE_TEXT_TOOL_HISTORY_KIND = "live-text-tool" as const;
export const MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO = 20;
export const LIVE_TEXT_TOOL_TEXT_LIMITS = {
  objective: 1000,
  summary: 500,
  markdown: 12000,
  error: 500,
  title: 200
} as const;

export interface LiveTextToolVideo {
  bvid: string;
  cid: string;
  pageIndex: number;
  pageTitle?: string;
  title: string;
  url: string;
}

export interface LiveTextToolHistoryEntry {
  id: string;
  kind: typeof LIVE_TEXT_TOOL_HISTORY_KIND;
  title: string;
  contextKey: string;
  contextTitle: string;
  contextUrl: string;
  isVideoContext: true;
  createdAt: number;
  updatedAt: number;
  contextRef: LiveTextToolVideo;
  messages: [];
  records: LiveTextToolRecord[];
  [key: string]: unknown;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function timestamp(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function truncateLiveTextToolText(value: unknown, maxChars: number): string {
  const text = stringValue(value).trim();
  const chars = Array.from(text);
  return chars.length > maxChars
    ? `${chars.slice(0, Math.max(0, maxChars - 1)).join("").trimEnd()}…`
    : text;
}

export function normalizeLiveTextToolVideo(value: unknown): LiveTextToolVideo | null {
  const raw = objectValue(value);
  const bvid = stringValue(raw.bvid).trim();
  const cid = stringValue(raw.cid).trim();
  if (!bvid || !cid) return null;
  const pageIndex = Number(raw.pageIndex);
  const pageTitle = truncateLiveTextToolText(raw.pageTitle, LIVE_TEXT_TOOL_TEXT_LIMITS.title);
  return {
    bvid: truncateLiveTextToolText(bvid, 32),
    cid: truncateLiveTextToolText(cid, 64),
    pageIndex: Number.isFinite(pageIndex) && pageIndex > 0 ? Math.floor(pageIndex) : 1,
    ...(pageTitle ? { pageTitle } : {}),
    title: truncateLiveTextToolText(raw.title, LIVE_TEXT_TOOL_TEXT_LIMITS.title) || bvid,
    url: truncateLiveTextToolText(raw.url, 2000)
  };
}

export function normalizeLiveTextToolRecord(value: unknown): LiveTextToolRecord | null {
  const raw = objectValue(value);
  const callId = stringValue(raw.callId).trim();
  const source = raw.source === "gemini" || raw.source === "moss" ? raw.source : null;
  const status = raw.status === "completed" || raw.status === "failed" ? raw.status : null;
  if (!callId || !source || !status) return null;
  const startedAt = timestamp(raw.startedAt, 0);
  const endedAt = Math.max(startedAt, timestamp(raw.endedAt, startedAt));
  const video = normalizeLiveTextToolVideo(raw.video);
  return {
    callId: truncateLiveTextToolText(callId, 200),
    source,
    status,
    objective: truncateLiveTextToolText(raw.objective, LIVE_TEXT_TOOL_TEXT_LIMITS.objective) || "伴看文本分析",
    summary: truncateLiveTextToolText(raw.summary, LIVE_TEXT_TOOL_TEXT_LIMITS.summary),
    markdown: truncateLiveTextToolText(raw.markdown, LIVE_TEXT_TOOL_TEXT_LIMITS.markdown),
    startedAt,
    endedAt,
    durationMs: endedAt - startedAt,
    ...(status === "failed"
      ? { error: truncateLiveTextToolText(raw.error, LIVE_TEXT_TOOL_TEXT_LIMITS.error) || "伴看文本模型调用失败" }
      : {}),
    ...(video ? { video } : {})
  };
}

export function isLiveTextToolHistoryEntry(value: unknown): value is LiveTextToolHistoryEntry {
  return objectValue(value).kind === LIVE_TEXT_TOOL_HISTORY_KIND;
}

export function normalizeLiveTextToolHistoryEntry(value: unknown): LiveTextToolHistoryEntry | null {
  const raw = objectValue(value);
  if (!isLiveTextToolHistoryEntry(raw)) return null;
  const ref = objectValue(raw.contextRef);
  const video = normalizeLiveTextToolVideo({
    ...ref,
    title: raw.contextTitle || ref.title || raw.title,
    url: ref.url || raw.contextUrl
  });
  if (!video || !Array.isArray(raw.records)) return null;

  const byCallId = new Map<string, LiveTextToolRecord>();
  const normalized = raw.records
    .map(normalizeLiveTextToolRecord)
    .filter((record): record is LiveTextToolRecord => Boolean(record))
    .sort((a, b) => (a.endedAt || a.startedAt) - (b.endedAt || b.startedAt));
  for (const record of normalized) byCallId.set(record.callId, record);
  const records = [...byCallId.values()]
    .sort((a, b) => (b.endedAt || b.startedAt) - (a.endedAt || a.startedAt))
    .slice(0, MAX_LIVE_TEXT_TOOL_RECORDS_PER_VIDEO)
    .map((record) => {
      const { video: _video, ...persisted } = record;
      return persisted;
    });
  if (!records.length) return null;

  const id = `live:${video.bvid}:${video.cid}`;
  const oldest = records[records.length - 1];
  const latest = records[0];
  return {
    id,
    kind: LIVE_TEXT_TOOL_HISTORY_KIND,
    title: video.title,
    contextKey: `video:${video.bvid}|${video.cid}`,
    contextTitle: video.title,
    contextUrl: video.url,
    isVideoContext: true,
    createdAt: timestamp(raw.createdAt, oldest.startedAt),
    updatedAt: timestamp(raw.updatedAt, latest.endedAt || latest.startedAt),
    contextRef: { ...video },
    messages: [],
    records
  };
}

export function upsertLiveTextToolHistoryEntry(
  entries: unknown[],
  value: LiveTextToolRecord
): unknown[] {
  const record = normalizeLiveTextToolRecord(value);
  if (!record?.video) return entries;
  const id = `live:${record.video.bvid}:${record.video.cid}`;
  const existing = entries.find((item) => isLiveTextToolHistoryEntry(item) && item.id === id);
  const current = existing ? normalizeLiveTextToolHistoryEntry(existing) : null;
  const next = normalizeLiveTextToolHistoryEntry({
    ...(current || {}),
    id,
    kind: LIVE_TEXT_TOOL_HISTORY_KIND,
    title: record.video.title,
    contextTitle: record.video.title,
    contextUrl: record.video.url,
    contextRef: record.video,
    createdAt: current?.createdAt || record.startedAt,
    updatedAt: record.endedAt || record.startedAt,
    messages: [],
    records: [record, ...(current?.records || []).filter((item) => item.callId !== record.callId)]
  });
  if (!next) return entries;
  return [next, ...entries.filter((item) => item !== existing)];
}
