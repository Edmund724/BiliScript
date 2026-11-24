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

function findMatchingObservedPot(
  observedUrls: readonly string[] | null | undefined,
  videoId: string,
  languageCode: string
): string {
  if (!Array.isArray(observedUrls) || observedUrls.length === 0) {
    return "";
  }
  const cleanVideoId = String(videoId || "").trim();
  const cleanLang = String(languageCode || "").trim().toLowerCase();
  let fallbackPot = "";

  for (const rawUrl of observedUrls) {
    let parsed: URL;
    try {
      parsed = new URL(String(rawUrl || ""));
    } catch {
      continue;
    }
    if (!isYoutubeTimedtextUrl(parsed)) {
      continue;
    }
    const obsVideoId = (parsed.searchParams.get("v") || "").trim();
    if (cleanVideoId && obsVideoId !== cleanVideoId) {
      continue;
    }
    const pot = (parsed.searchParams.get("pot") || "").trim();
    if (!pot || /\s/.test(pot)) {
      continue;
    }
    const obsLang = (parsed.searchParams.get("lang") || "").trim().toLowerCase();
    if (cleanLang && obsLang === cleanLang) {
      return pot;
    }
    fallbackPot = pot;
  }

  return fallbackPot;
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
  parsed.searchParams.set("fmt", "json3");

  const existingPot = (parsed.searchParams.get("pot") || "").trim();
  if (!existingPot) {
    const effectiveVideoId = String(videoId || parsed.searchParams.get("v") || "").trim();
    const effectiveLang = String(languageCode || parsed.searchParams.get("lang") || "").trim();
    const observedPot = findMatchingObservedPot(observedTimedtextUrls, effectiveVideoId, effectiveLang);
    if (observedPot) {
      parsed.searchParams.set("pot", observedPot);
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

function assertWebInnertubeContext(context: Record<string, unknown> | null | undefined): Record<string, unknown> {
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

async function readResponseJsonSafely(response: Awaited<ReturnType<YoutubeSameOriginFetch>>): Promise<{
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
    headers: {
      "Content-Type": "application/json"
    },
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

export type YoutubeFetchTier = "timedtext" | "get_transcript";

export interface FetchYoutubeSubtitleTrackResult {
  items: SubtitleBodyItem[];
  tier: YoutubeFetchTier;
  requestUrl: string;
}

export type YoutubeSubtitleSnapshotInput = Pick<
  YoutubePageSnapshot,
  "videoId" | "observedTimedtextUrls" | "innertubeContext" | "innertubeApiKey" | "transcriptParams"
>;

export async function fetchYoutubeSubtitleTrackBody({
  trackUrl,
  videoId = "",
  languageCode = "",
  snapshot = null,
  fetchFn = getYoutubeSameOriginFetch()
}: {
  trackUrl: string;
  videoId?: string;
  languageCode?: string;
  snapshot?: YoutubeSubtitleSnapshotInput | null;
  fetchFn?: YoutubeSameOriginFetch;
}): Promise<FetchYoutubeSubtitleTrackResult> {
  let tier1Reason = "缺少 timedtext URL";
  let tier1Status: number | undefined;

  if (String(trackUrl || "").trim()) {
    try {
      const tier1 = await fetchTimedtextJson3({
        baseUrl: trackUrl,
        videoId: videoId || snapshot?.videoId || "",
        languageCode,
        observedTimedtextUrls: snapshot?.observedTimedtextUrls ?? [],
        fetchFn
      });
      if (tier1.items.length > 0) {
        return {
          items: tier1.items,
          tier: "timedtext",
          requestUrl: tier1.requestUrl
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

  throw new YoutubeSubtitleError(
    `未能获取 YouTube 字幕正文（timedtext：${tier1Reason}；get_transcript：${tier2Reason}）。`,
    YOUTUBE_CAPTIONS_UNAVAILABLE_ERROR_CODE,
    tier2Status ?? tier1Status
  );
}
