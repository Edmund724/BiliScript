import type { SubtitleBodyItem, SubtitleTrack, SubtitleWord } from "../shared/video-dto.js";
import {
  getYoutubeSameOriginFetch,
  type YoutubeCaptionTrackSnapshot,
  type YoutubePageSnapshot,
  type YoutubeSameOriginFetch
} from "./main-world-bridge.js";

export const YOUTUBE_NO_SUBTITLES_ERROR_CODE = "YOUTUBE_NO_SUBTITLES";
export const YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE = "YOUTUBE_CAPTIONS_UNAVAILABLE";
export const YOUTUBE_LIVE_UNSUPPORTED_ERROR_CODE = "YOUTUBE_LIVE_UNSUPPORTED";

const DISALLOWED_INNERTUBE_CLIENTS = new Set([
  "ANDROID",
  "IOS",
  "MWEB",
  "ANDROID_EMBEDDED_PLAYER",
  "IOS_EMBEDDED_PLAYER"
]);

const DEFAULT_CUE_FALLBACK_DURATION_MS = 2000;

export class YoutubeSubtitleError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = "YoutubeSubtitleError";
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

export function isYoutubeAutoCaptionTrack(
  track: Pick<YoutubeCaptionTrackSnapshot, "kind"> | null | undefined
): boolean {
  return String(track?.kind || "").trim().toLowerCase() === "asr";
}

function stripYoutubeAutoLabelSuffix(label: string): string {
  const cleaned = label
    .replace(/\s*[（(]\s*(?:auto[- ]?generated|自动生成|自動生成)\s*[）)]\s*$/i, "")
    .trim();
  return cleaned || label;
}

export function normalizeYoutubeTimedtextUrl(rawUrl: unknown): string {
  const text = String(rawUrl ?? "").trim();
  if (!text) {
    return "";
  }
  if (text.startsWith("//")) {
    return `https:${text}`;
  }
  if (text.startsWith("/")) {
    return `https://www.youtube.com${text}`;
  }
  if (text.startsWith("https://") || text.startsWith("http://")) {
    return text;
  }
  return "";
}

function buildYoutubeTrackId(
  track: YoutubeCaptionTrackSnapshot,
  index: number,
  seenIds: Set<string>
): string {
  const prefix = isYoutubeAutoCaptionTrack(track) ? "yt-auto" : "yt-cc";
  const rawSuffix = String(track.vssId || track.languageCode || index).trim();
  const safeSuffix = rawSuffix.replace(/[^A-Za-z0-9._-]+/g, "-") || String(index);
  let candidate = `${prefix}-${safeSuffix}`;
  if (seenIds.has(candidate)) {
    candidate = `${prefix}-${safeSuffix}-${index}`;
  }
  seenIds.add(candidate);
  return candidate;
}

export function mapYoutubeCaptionTracks(
  captionTracks: readonly YoutubeCaptionTrackSnapshot[] | null | undefined
): SubtitleTrack[] {
  const seenIds = new Set<string>();
  const mapped: SubtitleTrack[] = [];

  for (let index = 0; index < (captionTracks || []).length; index += 1) {
    const raw = captionTracks![index];
    if (!raw) {
      continue;
    }
    const subtitleUrl = normalizeYoutubeTimedtextUrl(raw.baseUrl);
    const lan = String(raw.languageCode || "").trim();
    if (!subtitleUrl && !lan) {
      continue;
    }
    const isAuto = isYoutubeAutoCaptionTrack(raw);
    const rawName = String(raw.name || "").trim();
    const cleanName = isAuto ? stripYoutubeAutoLabelSuffix(rawName) : rawName;
    const lanDoc = cleanName || lan;
    const id = buildYoutubeTrackId(raw, index, seenIds);

    mapped.push({
      id,
      lan,
      lanDoc,
      subtitleUrl,
      source: isAuto ? "youtube-auto" : "youtube-cc",
      origin: "youtube",
      ...(isAuto ? { kind: "asr" } : raw.kind ? { kind: raw.kind } : {}),
      site: "youtube"
    });
  }

  return mapped;
}

function isYoutubeTimedtextUrl(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();
  return (host === "youtube.com" || host.endsWith(".youtube.com")) && parsed.pathname.includes("/api/timedtext");
}

interface ObservedTimedtextMatch {
  parsed: URL;
  pot: string;
  potc: string;
  c: string;
  cver: string;
  lang: string;
  kind: string;
}

function parseObservedTimedtextCandidate(
  rawUrl: unknown,
  expectedVideoId: string
): ObservedTimedtextMatch | null {
  const normalizedObs = normalizeYoutubeTimedtextUrl(rawUrl);
  if (!normalizedObs) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(normalizedObs);
  } catch {
    return null;
  }
  if (!isYoutubeTimedtextUrl(parsed)) {
    return null;
  }
  const obsVideoId = (parsed.searchParams.get("v") || "").trim();
  if (expectedVideoId && obsVideoId !== expectedVideoId) {
    return null;
  }
  const pot = (parsed.searchParams.get("pot") || "").trim();
  if (!pot || /\s/.test(pot)) {
    return null;
  }
  const c = (parsed.searchParams.get("c") || "").trim();
  if (c && c !== "WEB") {
    return null;
  }
  return {
    parsed,
    pot,
    potc: (parsed.searchParams.get("potc") || "").trim(),
    c,
    cver: (parsed.searchParams.get("cver") || "").trim(),
    lang: (parsed.searchParams.get("lang") || "").trim().toLowerCase(),
    kind: (parsed.searchParams.get("kind") || "").trim().toLowerCase()
  };
}

function isSameYoutubeTrackKind(observedKind: string, targetKind: string): boolean {
  return (observedKind === "asr") === (targetKind === "asr") && observedKind === targetKind;
}

function selectObservedTimedtextCandidate(
  observedUrls: readonly string[] | null | undefined,
  videoId: string,
  languageCode: string,
  kind: string
): { exact: ObservedTimedtextMatch | null; fallback: ObservedTimedtextMatch | null } {
  if (!Array.isArray(observedUrls) || observedUrls.length === 0) {
    return { exact: null, fallback: null };
  }
  const cleanVideoId = String(videoId || "").trim();
  const cleanLang = String(languageCode || "").trim().toLowerCase();
  const cleanKind = String(kind || "").trim().toLowerCase();
  let sameLangFallback: ObservedTimedtextMatch | null = null;
  let anyFallback: ObservedTimedtextMatch | null = null;

  for (let index = observedUrls.length - 1; index >= 0; index -= 1) {
    const candidate = parseObservedTimedtextCandidate(observedUrls[index], cleanVideoId);
    if (!candidate) {
      continue;
    }
    if (cleanLang && candidate.lang === cleanLang) {
      if (isSameYoutubeTrackKind(candidate.kind, cleanKind)) {
        return { exact: candidate, fallback: candidate };
      }
      sameLangFallback ??= candidate;
    }
    anyFallback ??= candidate;
  }

  return { exact: null, fallback: sameLangFallback ?? anyFallback };
}

export function hasMatchingYoutubeObservedPot(
  observedUrls: readonly string[] | null | undefined,
  videoId: string,
  languageCode = "",
  kind = ""
): boolean {
  const { exact, fallback } = selectObservedTimedtextCandidate(
    observedUrls,
    videoId,
    languageCode,
    kind
  );
  return Boolean(exact || fallback);
}

export function resolveYoutubeTimedtextRequestUrl({
  baseUrl,
  videoId = "",
  languageCode = "",
  observedTimedtextUrls = []
}: {
  baseUrl: string;
  videoId?: string;
  languageCode?: string;
  observedTimedtextUrls?: readonly string[];
}): string {
  const normalized = normalizeYoutubeTimedtextUrl(baseUrl);
  if (!normalized) {
    throw new YoutubeSubtitleError("YouTube 字幕轨 URL 无效。", YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE);
  }
  const parsed = new URL(normalized);
  const existingPot = (parsed.searchParams.get("pot") || "").trim();
  if (existingPot) {
    parsed.searchParams.set("fmt", "json3");
    return parsed.toString();
  }

  const effectiveVideoId = String(videoId || parsed.searchParams.get("v") || "").trim();
  const effectiveLang = String(languageCode || parsed.searchParams.get("lang") || "").trim();
  const effectiveKind = (parsed.searchParams.get("kind") || "").trim();
  const { exact, fallback } = selectObservedTimedtextCandidate(
    observedTimedtextUrls,
    effectiveVideoId,
    effectiveLang,
    effectiveKind
  );
  if (exact) {
    const reused = new URL(exact.parsed.toString());
    reused.searchParams.set("fmt", "json3");
    return reused.toString();
  }

  parsed.searchParams.set("fmt", "json3");
  if (fallback) {
    parsed.searchParams.set("pot", fallback.pot);
    parsed.searchParams.set("potc", fallback.potc || "1");
    if (fallback.c === "WEB") {
      parsed.searchParams.set("c", "WEB");
    }
    if (fallback.cver) {
      parsed.searchParams.set("cver", fallback.cver);
    }
  }

  return parsed.toString();
}

interface RawJson3Seg {
  utf8?: unknown;
  tOffsetMs?: unknown;
}

interface RawJson3Event {
  tStartMs?: unknown;
  dDurationMs?: unknown;
  segs?: unknown;
}

function cleanCueWhitespace(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function msToSec(ms: number): number {
  return Math.round(ms) / 1000;
}

function extractJson3Words(
  rawSegs: readonly RawJson3Seg[],
  eventStartMs: number,
  eventEndMs: number
): SubtitleWord[] | undefined {
  const validSegs: Array<{ text: string; offsetMs: number; hasOffset: boolean }> = [];
  let anyOffset = false;

  for (const seg of rawSegs) {
    const rawText = typeof seg?.utf8 === "string" ? seg.utf8 : "";
    const text = cleanCueWhitespace(rawText);
    if (!text) {
      continue;
    }
    const rawOffset = Number(seg?.tOffsetMs);
    const hasOffset = Number.isFinite(rawOffset) && rawOffset >= 0;
    if (hasOffset) {
      anyOffset = true;
    }
    validSegs.push({
      text,
      offsetMs: hasOffset ? Math.round(rawOffset) : 0,
      hasOffset
    });
  }

  if (!anyOffset || validSegs.length === 0) {
    return undefined;
  }

  const words: SubtitleWord[] = [];
  for (let i = 0; i < validSegs.length; i += 1) {
    const seg = validSegs[i];
    const nextSeg = validSegs[i + 1];
    const startMs = Math.min(eventEndMs, eventStartMs + seg.offsetMs);
    const rawWordEndMs = nextSeg
      ? eventStartMs + Math.max(seg.offsetMs, nextSeg.offsetMs)
      : eventEndMs;
    const endMs = Math.max(startMs, Math.min(eventEndMs, rawWordEndMs));
    words.push({
      word: seg.text,
      startMs,
      endMs,
      start: msToSec(startMs),
      end: msToSec(endMs)
    });
  }

  return words.length > 0 ? words : undefined;
}

export function parseYoutubeJson3Subtitles(payload: unknown): SubtitleBodyItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const rawEvents = (payload as { events?: unknown }).events;
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return [];
  }

  const cleaned: Array<{
    startMs: number;
    durationMs: number;
    content: string;
    segs: RawJson3Seg[];
  }> = [];

  for (const rawEv of rawEvents) {
    if (!rawEv || typeof rawEv !== "object") {
      continue;
    }
    const ev = rawEv as RawJson3Event;
    if (!Array.isArray(ev.segs) || ev.segs.length === 0) {
      continue;
    }
    const startMs = Number(ev.tStartMs);
    if (!Number.isFinite(startMs) || startMs < 0) {
      continue;
    }
    const rawJoined = ev.segs
      .map((seg) => (seg && typeof (seg as RawJson3Seg).utf8 === "string" ? (seg as RawJson3Seg).utf8 : ""))
      .join("");
    const content = cleanCueWhitespace(rawJoined);
    if (!content) {
      continue;
    }
    const durationMs = Number(ev.dDurationMs);
    cleaned.push({
      startMs: Math.round(startMs),
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs) : 0,
      content,
      segs: ev.segs as RawJson3Seg[]
    });
  }

  const items: SubtitleBodyItem[] = [];
  for (let i = 0; i < cleaned.length; i += 1) {
    const ev = cleaned[i];
    const nextStartMs = i + 1 < cleaned.length ? cleaned[i + 1].startMs : null;
    const endMs =
      ev.durationMs > 0
        ? ev.startMs + ev.durationMs
        : nextStartMs !== null && nextStartMs > ev.startMs
          ? nextStartMs
          : ev.startMs + DEFAULT_CUE_FALLBACK_DURATION_MS;
    const words = extractJson3Words(ev.segs, ev.startMs, endMs);
    items.push({
      from: msToSec(ev.startMs),
      to: msToSec(endMs),
      content: ev.content,
      ...(words ? { words } : {})
    });
  }

  return items;
}

function readYoutubeTextRuns(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "";
  }
  const obj = value as { simpleText?: unknown; runs?: unknown };
  if (typeof obj.simpleText === "string") {
    return obj.simpleText;
  }
  if (Array.isArray(obj.runs)) {
    return obj.runs
      .map((run) => {
        if (!run || typeof run !== "object") {
          return "";
        }
        const text = (run as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

interface RawTranscriptEntry {
  startMs: number;
  endMs: number;
  content: string;
}

function collectCueGroupsAndSegments(
  root: unknown
): { cueGroups: unknown[]; initialSegments: unknown[] } {
  const cueGroups: unknown[] = [];
  const initialSegments: unknown[] = [];
  const visited = new WeakSet<object>();

  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 14) {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    if (Array.isArray(record.cueGroups)) {
      cueGroups.push(...record.cueGroups);
    }
    if (Array.isArray(record.initialSegments)) {
      initialSegments.push(...record.initialSegments);
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        visit(value, depth + 1);
      }
    }
  };

  visit(root, 0);
  return { cueGroups, initialSegments };
}

function parseCueGroupsList(cueGroups: readonly unknown[]): RawTranscriptEntry[] {
  const entries: RawTranscriptEntry[] = [];

  for (const group of cueGroups) {
    if (!group || typeof group !== "object") {
      continue;
    }
    const groupRenderer = (group as { transcriptCueGroupRenderer?: unknown }).transcriptCueGroupRenderer;
    const cues =
      groupRenderer && typeof groupRenderer === "object"
        ? (groupRenderer as { cues?: unknown }).cues
        : undefined;
    if (!Array.isArray(cues)) {
      continue;
    }
    for (const rawCue of cues) {
      if (!rawCue || typeof rawCue !== "object") {
        continue;
      }
      const renderer = (rawCue as { transcriptCueRenderer?: unknown }).transcriptCueRenderer;
      if (!renderer || typeof renderer !== "object") {
        continue;
      }
      const cueObj = renderer as {
        cue?: unknown;
        startOffsetMs?: unknown;
        durationMs?: unknown;
      };
      const content = cleanCueWhitespace(readYoutubeTextRuns(cueObj.cue));
      const startMs = Number(cueObj.startOffsetMs);
      if (!content || !Number.isFinite(startMs) || startMs < 0) {
        continue;
      }
      const durationMs = Number(cueObj.durationMs);
      const endMs =
        Number.isFinite(durationMs) && durationMs > 0 ? Math.round(startMs + durationMs) : NaN;
      entries.push({ startMs: Math.round(startMs), endMs, content });
    }
  }

  return entries;
}

function parseInitialSegmentsList(initialSegments: readonly unknown[]): RawTranscriptEntry[] {
  const entries: RawTranscriptEntry[] = [];

  for (const item of initialSegments) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const renderer = (item as { transcriptSegmentRenderer?: unknown }).transcriptSegmentRenderer;
    if (!renderer || typeof renderer !== "object") {
      continue;
    }
    const segObj = renderer as { snippet?: unknown; startMs?: unknown; endMs?: unknown };
    const content = cleanCueWhitespace(readYoutubeTextRuns(segObj.snippet));
    const startMs = Number(segObj.startMs);
    if (!content || !Number.isFinite(startMs) || startMs < 0) {
      continue;
    }
    const rawEndMs = Number(segObj.endMs);
    const endMs = Number.isFinite(rawEndMs) && rawEndMs > startMs ? Math.round(rawEndMs) : NaN;
    entries.push({ startMs: Math.round(startMs), endMs, content });
  }

  return entries;
}

export function parseYoutubeGetTranscriptSubtitles(payload: unknown): SubtitleBodyItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const { cueGroups, initialSegments } = collectCueGroupsAndSegments(payload);
  const fromCueGroups = parseCueGroupsList(cueGroups);
  const entries = fromCueGroups.length > 0 ? fromCueGroups : parseInitialSegmentsList(initialSegments);

  return entries.map((entry, idx) => {
    const nextStartMs = idx + 1 < entries.length ? entries[idx + 1].startMs : null;
    const resolvedEndMs = Number.isFinite(entry.endMs)
      ? entry.endMs
      : nextStartMs !== null && nextStartMs > entry.startMs
        ? nextStartMs
        : entry.startMs + DEFAULT_CUE_FALLBACK_DURATION_MS;
    return {
      from: msToSec(entry.startMs),
      to: msToSec(resolvedEndMs),
      content: entry.content
    };
  });
}

export function assertWebInnertubeContext(
  context: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    throw new YoutubeSubtitleError(
      "缺少真实 WEB INNERTUBE_CONTEXT。",
      YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE
    );
  }
  const client = (context as { client?: { clientName?: unknown } }).client;
  const clientName = String(client?.clientName || "").trim().toUpperCase();
  if (DISALLOWED_INNERTUBE_CLIENTS.has(clientName)) {
    throw new YoutubeSubtitleError(
      `禁止伪装 ${clientName} InnerTube 客户端。`,
      YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE
    );
  }
  return context;
}

function readContextClientString(client: Record<string, unknown> | null, key: string): string {
  if (!client) {
    return "";
  }
  const raw = client[key];
  return typeof raw === "string" ? raw.trim() : "";
}

export function buildWebInnertubeHeaders(context: Record<string, unknown>): Record<string, string> {
  const rawClient = (context as { client?: unknown }).client;
  const client =
    rawClient && typeof rawClient === "object" && !Array.isArray(rawClient)
      ? (rawClient as Record<string, unknown>)
      : null;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Youtube-Client-Name": "1",
    "X-Origin": "https://www.youtube.com"
  };
  const clientVersion = readContextClientString(client, "clientVersion");
  if (clientVersion) {
    headers["X-Youtube-Client-Version"] = clientVersion;
  }
  const visitorData = readContextClientString(client, "visitorData");
  if (visitorData) {
    headers["X-Goog-Visitor-Id"] = visitorData;
  }
  return headers;
}

export async function readResponseJsonSafely(
  response: Awaited<ReturnType<YoutubeSameOriginFetch>>
): Promise<{
  ok: boolean;
  status: number;
  empty: boolean;
  data: unknown;
}> {
  if (!response.ok) {
    return { ok: false, status: response.status, empty: false, data: null };
  }
  if (typeof response.text === "function") {
    const rawText = await response.text();
    if (!rawText || !rawText.trim()) {
      return { ok: true, status: response.status, empty: true, data: null };
    }
    try {
      return { ok: true, status: response.status, empty: false, data: JSON.parse(rawText) };
    } catch {
      return { ok: true, status: response.status, empty: true, data: null };
    }
  }
  if (typeof response.json === "function") {
    try {
      const data = await response.json();
      return {
        ok: true,
        status: response.status,
        empty: data === null || data === undefined,
        data
      };
    } catch {
      return { ok: true, status: response.status, empty: true, data: null };
    }
  }
  return { ok: true, status: response.status, empty: true, data: null };
}

export async function fetchTimedtextJson3({
  baseUrl,
  videoId = "",
  languageCode = "",
  observedTimedtextUrls = [],
  fetchFn = getYoutubeSameOriginFetch()
}: {
  baseUrl: string;
  videoId?: string;
  languageCode?: string;
  observedTimedtextUrls?: readonly string[];
  fetchFn?: YoutubeSameOriginFetch;
}): Promise<{ items: SubtitleBodyItem[]; requestUrl: string; reason?: string; status?: number }> {
  const requestUrl = resolveYoutubeTimedtextRequestUrl({
    baseUrl,
    videoId,
    languageCode,
    observedTimedtextUrls
  });
  const response = await fetchFn(requestUrl, {
    method: "GET",
    credentials: "include",
    cache: "no-store"
  });
  const parsed = await readResponseJsonSafely(response);
  if (!parsed.ok) {
    return { items: [], requestUrl, reason: `HTTP ${parsed.status}`, status: parsed.status };
  }
  if (parsed.empty) {
    return { items: [], requestUrl, reason: "timedtext 返回空正文（可能受 PO Token 门控）" };
  }
  const items = parseYoutubeJson3Subtitles(parsed.data);
  if (items.length === 0) {
    return { items: [], requestUrl, reason: "timedtext 未解析到有效字幕条目" };
  }
  return { items, requestUrl };
}

export const YOUTUBE_MODERN_TRANSCRIPT_PANEL_ID = "PAmodern_transcript_view";

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_BCP47_LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export function encodeModernYoutubeTranscriptParams(videoId: string): string {
  const cleanId = String(videoId || "").trim();
  if (!YOUTUBE_VIDEO_ID_RE.test(cleanId)) {
    return "";
  }
  const bytes = new Uint8Array(18);
  bytes[0] = 0xaa;
  bytes[1] = 0x09;
  bytes[2] = 0x0f;
  bytes[3] = 0x0a;
  bytes[4] = 0x0b;
  for (let i = 0; i < 11; i += 1) {
    bytes[5 + i] = cleanId.charCodeAt(i);
  }
  bytes[16] = 0x18;
  bytes[17] = 0x01;
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function parseTimestampTextMs(raw: unknown): number {
  const text = String(raw ?? "").trim();
  if (!text) return NaN;
  const parts = text.split(":").map((part) => Number(part));
  if (parts.length < 2 || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) {
    return NaN;
  }
  const totalSec =
    parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
  return Math.round(totalSec * 1000);
}

interface RawPanelSyncTiming {
  videoTimeMs: number;
  endTimeMs: number;
}

export function parseYoutubeGetPanelSubtitles(payload: unknown): SubtitleBodyItem[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const rawSegments: Array<{ text: string; startMs: number }> = [];
  const syncTimings: RawPanelSyncTiming[] = [];
  const visited = new WeakSet<object>();

  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 22) {
      return;
    }
    if (visited.has(node)) {
      return;
    }
    visited.add(node);

    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item, depth + 1);
      }
      return;
    }

    const record = node as Record<string, unknown>;
    const markerItem = record.macroMarkersPanelItemViewModel;
    if (markerItem && typeof markerItem === "object" && !Array.isArray(markerItem)) {
      const m = markerItem as Record<string, unknown>;
      const timelineItem = (m.item as Record<string, unknown> | undefined)?.timelineItemViewModel as
        | Record<string, unknown>
        | undefined;
      const contentItems = Array.isArray(timelineItem?.contentItems) ? timelineItem.contentItems : [];
      for (const ci of contentItems) {
        const segVm = (ci as Record<string, unknown> | undefined)?.transcriptSegmentViewModel as
          | Record<string, unknown>
          | undefined;
        if (!segVm || typeof segVm !== "object") continue;
        const content = cleanCueWhitespace(
          typeof segVm.simpleText === "string"
            ? segVm.simpleText
            : readYoutubeTextRuns(segVm.snippet ?? segVm.text)
        );
        if (!content) continue;
        const tapCmd = (m.onTap as Record<string, unknown> | undefined)?.innertubeCommand as
          | Record<string, unknown>
          | undefined;
        const startSec = Number(
          (tapCmd?.watchEndpoint as Record<string, unknown> | undefined)?.startTimeSeconds
        );
        const startMs =
          Number.isFinite(startSec) && startSec >= 0
            ? Math.round(startSec * 1000)
            : parseTimestampTextMs(segVm.timestamp ?? timelineItem?.timestamp);
        if (Number.isFinite(startMs) && startMs >= 0) {
          rawSegments.push({ text: content, startMs });
        }
      }
    }

    if (Array.isArray(record.timedSyncDataList)) {
      for (const rawSync of record.timedSyncDataList) {
        if (!rawSync || typeof rawSync !== "object") continue;
        const sync = rawSync as { videoTimeMs?: unknown; endTimeMs?: unknown };
        const videoTimeMs = Number(sync.videoTimeMs);
        const endTimeMs = Number(sync.endTimeMs);
        if (Number.isFinite(videoTimeMs) && videoTimeMs >= 0 && Number.isFinite(endTimeMs) && endTimeMs > videoTimeMs) {
          syncTimings.push({ videoTimeMs: Math.round(videoTimeMs), endTimeMs: Math.round(endTimeMs) });
        }
      }
    }

    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        visit(value, depth + 1);
      }
    }
  };

  visit(payload, 0);

  if (rawSegments.length === 0) {
    return [];
  }

  let syncCursor = 0;
  return rawSegments.map((seg, idx) => {
    let startMs = seg.startMs;
    let endMs = NaN;

    for (let look = syncCursor; look < Math.min(syncTimings.length, syncCursor + 4); look += 1) {
      const candidate = syncTimings[look];
      if (Math.abs(candidate.videoTimeMs - seg.startMs) <= 1500) {
        startMs = candidate.videoTimeMs;
        endMs = candidate.endTimeMs;
        syncCursor = look + 1;
        break;
      }
    }

    if (!Number.isFinite(endMs) || endMs <= startMs) {
      const nextStartMs = idx + 1 < rawSegments.length ? rawSegments[idx + 1].startMs : null;
      endMs =
        nextStartMs !== null && nextStartMs > startMs
          ? nextStartMs
          : startMs + DEFAULT_CUE_FALLBACK_DURATION_MS;
    }

    return {
      from: msToSec(startMs),
      to: msToSec(endMs),
      content: seg.text
    };
  });
}

export async function fetchYoutubeGetPanelTranscript({
  innertubeContext,
  innertubeApiKey = "",
  modernTranscriptParams = "",
  videoId = "",
  languageCode = "",
  fetchFn = getYoutubeSameOriginFetch()
}: {
  innertubeContext: Record<string, unknown> | null | undefined;
  innertubeApiKey?: string;
  modernTranscriptParams?: string;
  videoId?: string;
  languageCode?: string;
  fetchFn?: YoutubeSameOriginFetch;
}): Promise<{ items: SubtitleBodyItem[]; requestUrl: string; reason?: string; status?: number }> {
  const cleanParams =
    String(modernTranscriptParams || "").trim() || encodeModernYoutubeTranscriptParams(videoId);
  if (!cleanParams) {
    return { items: [], requestUrl: "", reason: "缺少 modernTranscriptParams" };
  }
  const safeContext = assertWebInnertubeContext(innertubeContext);
  const cleanLang = String(languageCode || "").trim();
  let requestContext = safeContext;
  if (cleanLang && YOUTUBE_BCP47_LANG_RE.test(cleanLang)) {
    const rawClient = (safeContext as { client?: unknown }).client;
    if (rawClient && typeof rawClient === "object" && !Array.isArray(rawClient)) {
      requestContext = {
        ...safeContext,
        client: {
          ...(rawClient as Record<string, unknown>),
          hl: cleanLang
        }
      };
    }
  }
  const cleanKey = String(innertubeApiKey || "").trim();
  const requestUrl = cleanKey
    ? `https://www.youtube.com/youtubei/v1/get_panel?key=${encodeURIComponent(cleanKey)}`
    : "https://www.youtube.com/youtubei/v1/get_panel";

  const response = await fetchFn(requestUrl, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: buildWebInnertubeHeaders(requestContext),
    body: JSON.stringify({
      context: requestContext,
      panelId: YOUTUBE_MODERN_TRANSCRIPT_PANEL_ID,
      params: cleanParams
    })
  });
  const parsed = await readResponseJsonSafely(response);
  if (!parsed.ok) {
    return { items: [], requestUrl, reason: `HTTP ${parsed.status}`, status: parsed.status };
  }
  if (parsed.empty) {
    return { items: [], requestUrl, reason: "get_panel 返回空正文" };
  }
  const items = parseYoutubeGetPanelSubtitles(parsed.data);
  if (items.length === 0) {
    return { items: [], requestUrl, reason: "get_panel 未解析到有效字幕条目" };
  }
  return { items, requestUrl };
}

export async function fetchYoutubeGetTranscript({
  innertubeContext,
  innertubeApiKey = "",
  transcriptParams,
  fetchFn = getYoutubeSameOriginFetch()
}: {
  innertubeContext: Record<string, unknown> | null | undefined;
  innertubeApiKey?: string;
  transcriptParams: string;
  fetchFn?: YoutubeSameOriginFetch;
}): Promise<{ items: SubtitleBodyItem[]; requestUrl: string; reason?: string; status?: number }> {
  const cleanParams = String(transcriptParams || "").trim();
  if (!cleanParams) {
    return { items: [], requestUrl: "", reason: "缺少 transcriptParams" };
  }
  const safeContext = assertWebInnertubeContext(innertubeContext);
  const cleanKey = String(innertubeApiKey || "").trim();
  const requestUrl = cleanKey
    ? `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(cleanKey)}`
    : "https://www.youtube.com/youtubei/v1/get_transcript";

  const response = await fetchFn(requestUrl, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
    headers: buildWebInnertubeHeaders(safeContext),
    body: JSON.stringify({
      context: safeContext,
      params: cleanParams
    })
  });
  const parsed = await readResponseJsonSafely(response);
  if (!parsed.ok) {
    return { items: [], requestUrl, reason: `HTTP ${parsed.status}`, status: parsed.status };
  }
  if (parsed.empty) {
    return { items: [], requestUrl, reason: "get_transcript 返回空正文" };
  }
  const items = parseYoutubeGetTranscriptSubtitles(parsed.data);
  if (items.length === 0) {
    return { items: [], requestUrl, reason: "get_transcript 未解析到有效字幕条目" };
  }
  return { items, requestUrl };
}

export type YoutubeFetchTier = "timedtext" | "get_panel" | "get_transcript";

export interface FetchYoutubeSubtitleTrackResult {
  items: SubtitleBodyItem[];
  tier: YoutubeFetchTier;
  requestUrl: string;
  capturedTimedtextUrls?: string[];
}

export type YoutubeSubtitleSnapshotInput = Pick<
  YoutubePageSnapshot,
  "videoId" | "observedTimedtextUrls" | "innertubeContext" | "innertubeApiKey" | "transcriptParams"
> & {
  modernTranscriptParams?: string;
};

function extractTrackKindFromUrl(rawUrl: string): string {
  const normalized = normalizeYoutubeTimedtextUrl(rawUrl);
  if (!normalized) return "";
  try {
    return (new URL(normalized).searchParams.get("kind") || "").trim();
  } catch {
    return "";
  }
}

function trackUrlAlreadyHasPot(rawUrl: string): boolean {
  const normalized = normalizeYoutubeTimedtextUrl(rawUrl);
  if (!normalized) return false;
  try {
    return Boolean((new URL(normalized).searchParams.get("pot") || "").trim());
  } catch {
    return false;
  }
}

function mergeUniqueUrls(
  base: readonly string[] | null | undefined,
  extra: readonly string[] | null | undefined
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [base, extra]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const clean = String(item || "").trim();
      if (clean && !seen.has(clean)) {
        seen.add(clean);
        out.push(clean);
      }
    }
  }
  return out;
}

export async function fetchYoutubeSubtitleTrackBody({
  trackUrl,
  videoId = "",
  languageCode = "",
  snapshot = null,
  preferTimedtextPot = false,
  capturePot,
  fetchFn = getYoutubeSameOriginFetch()
}: {
  trackUrl: string;
  videoId?: string;
  languageCode?: string;
  snapshot?: YoutubeSubtitleSnapshotInput | null;
  preferTimedtextPot?: boolean;
  capturePot?: () => Promise<readonly string[]>;
  fetchFn?: YoutubeSameOriginFetch;
}): Promise<FetchYoutubeSubtitleTrackResult> {
  const effectiveVideoId = String(videoId || snapshot?.videoId || "").trim();
  const trackKind = extractTrackKindFromUrl(trackUrl);
  let effectiveObservedUrls = mergeUniqueUrls(snapshot?.observedTimedtextUrls, null);
  let capturedTimedtextUrls: string[] = [];
  let potCaptureAttempted = false;

  const tryCapturePotOnce = async (): Promise<boolean> => {
    if (potCaptureAttempted || !capturePot) {
      return false;
    }
    potCaptureAttempted = true;
    try {
      const freshUrls = await capturePot();
      if (!Array.isArray(freshUrls) || freshUrls.length === 0) {
        return false;
      }
      const prevCount = effectiveObservedUrls.length;
      effectiveObservedUrls = mergeUniqueUrls(effectiveObservedUrls, freshUrls);
      capturedTimedtextUrls = mergeUniqueUrls(capturedTimedtextUrls, freshUrls);
      return (
        effectiveObservedUrls.length > prevCount ||
        hasMatchingYoutubeObservedPot(freshUrls, effectiveVideoId, languageCode, trackKind)
      );
    } catch {
      return false;
    }
  };

  let tier1Reason = "缺少 timedtext URL";
  let tier1Status: number | undefined;

  const hasPotReady = (): boolean =>
    trackUrlAlreadyHasPot(trackUrl) ||
    hasMatchingYoutubeObservedPot(effectiveObservedUrls, effectiveVideoId, languageCode, trackKind);

  if (preferTimedtextPot && String(trackUrl || "").trim() && !hasPotReady()) {
    await tryCapturePotOnce();
  }

  if (String(trackUrl || "").trim()) {
    try {
      const tier1 = await fetchTimedtextJson3({
        baseUrl: trackUrl,
        videoId: effectiveVideoId,
        languageCode,
        observedTimedtextUrls: effectiveObservedUrls,
        fetchFn
      });
      if (tier1.items.length > 0) {
        return {
          items: tier1.items,
          tier: "timedtext",
          requestUrl: tier1.requestUrl,
          ...(capturedTimedtextUrls.length > 0 ? { capturedTimedtextUrls } : {})
        };
      }
      tier1Reason = tier1.reason || "timedtext 无可用字幕";
      tier1Status = tier1.status;
    } catch (error) {
      if (error instanceof YoutubeSubtitleError && error.code === YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE) {
        tier1Reason = error.message;
      } else {
        tier1Reason = error instanceof Error ? error.message : String(error);
      }
    }
  }

  let getPanelReason = "缺少页面 WEB 上下文或视频标识";
  let getPanelStatus: number | undefined;
  const resolvedModernParams =
    String(snapshot?.modernTranscriptParams || "").trim() ||
    encodeModernYoutubeTranscriptParams(effectiveVideoId);

  if (snapshot?.innertubeContext && resolvedModernParams) {
    try {
      const panelRes = await fetchYoutubeGetPanelTranscript({
        innertubeContext: snapshot.innertubeContext,
        innertubeApiKey: snapshot.innertubeApiKey,
        modernTranscriptParams: resolvedModernParams,
        videoId: effectiveVideoId,
        languageCode,
        fetchFn
      });
      if (panelRes.items.length > 0) {
        return {
          items: panelRes.items,
          tier: "get_panel",
          requestUrl: panelRes.requestUrl
        };
      }
      getPanelReason = panelRes.reason || "get_panel 无可用字幕";
      getPanelStatus = panelRes.status;
    } catch (error) {
      getPanelReason = error instanceof Error ? error.message : String(error);
    }
  }

  let tier2Reason = "缺少页面 transcript 参数或 WEB 上下文";
  let tier2Status: number | undefined;

  if (snapshot?.innertubeContext && snapshot?.transcriptParams) {
    try {
      const tier2 = await fetchYoutubeGetTranscript({
        innertubeContext: snapshot.innertubeContext,
        innertubeApiKey: snapshot.innertubeApiKey,
        transcriptParams: snapshot.transcriptParams,
        fetchFn
      });
      if (tier2.items.length > 0) {
        return {
          items: tier2.items,
          tier: "get_transcript",
          requestUrl: tier2.requestUrl
        };
      }
      tier2Reason = tier2.reason || "get_transcript 无可用字幕";
      tier2Status = tier2.status;
    } catch (error) {
      tier2Reason = error instanceof Error ? error.message : String(error);
    }
  }

  if (String(trackUrl || "").trim() && !hasPotReady() && (await tryCapturePotOnce())) {
    try {
      const retryTier1 = await fetchTimedtextJson3({
        baseUrl: trackUrl,
        videoId: effectiveVideoId,
        languageCode,
        observedTimedtextUrls: effectiveObservedUrls,
        fetchFn
      });
      if (retryTier1.items.length > 0) {
        return {
          items: retryTier1.items,
          tier: "timedtext",
          requestUrl: retryTier1.requestUrl,
          ...(capturedTimedtextUrls.length > 0 ? { capturedTimedtextUrls } : {})
        };
      }
      tier1Reason = retryTier1.reason || tier1Reason;
      tier1Status = retryTier1.status ?? tier1Status;
    } catch (error) {
      tier1Reason = error instanceof Error ? error.message : String(error);
    }
  }

  throw new YoutubeSubtitleError(
    `未能获取 YouTube 字幕正文（timedtext：${tier1Reason}；get_panel：${getPanelReason}；get_transcript：${tier2Reason}）。`,
    YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE,
    getPanelStatus ?? tier2Status ?? tier1Status
  );
}
