import type {
  YoutubeCaptionTrackSnapshot,
  YoutubeChapterSnapshot,
  YoutubePageSnapshot
} from "../shared/messaging-protocol.js";
import { sendRuntimeMessage } from "../shared/messaging.js";
import { extractYoutubeVideoId } from "../shared/site.js";
import { sleep } from "../shared/utils.js";
import type { Chapter } from "../shared/video-dto.js";
import { normalizeChapters } from "../subtitle/chapters.js";

export type {
  YoutubeCaptionTrackSnapshot,
  YoutubeChapterSnapshot,
  YoutubePageSnapshot
};

export interface YoutubeVideoMetaSnapshot {
  videoId: string;
  title: string;
  author: string;
  description: string;
  duration: number;
  publishDate: string;
  isLiveContent: boolean;
  isLiveNow: boolean;
  isLiveReplay: boolean;
  chapters: Chapter[];
  captionTracks: YoutubeCaptionTrackSnapshot[];
  innertubeContext: Record<string, unknown> | null;
  innertubeApiKey: string;
  transcriptParams: string;
  observedTimedtextUrls: string[];
}

export type YoutubeMainWorldReader = (
  expectedVideoId?: string
) => Promise<YoutubePageSnapshot | null | undefined>;

export type YoutubeFetchResponse = Pick<Response, "ok" | "status" | "text" | "json">;

export type YoutubeSameOriginFetch = (
  input: string,
  init?: RequestInit
) => Promise<YoutubeFetchResponse>;

export interface ReadYoutubePageSnapshotOptions {
  expectedVideoId?: string;
  maxAttempts?: number;
  retryDelayMs?: number;
}

const DEFAULT_MAX_SNAPSHOT_ATTEMPTS = 5;
const DEFAULT_SNAPSHOT_RETRY_DELAY_MS = 150;
const TRANSIENT_SNAPSHOT_ERROR = "未读取到 YouTube 页面播放器快照";

let mainWorldReaderForTests: YoutubeMainWorldReader | null = null;
let sameOriginFetchForTests: YoutubeSameOriginFetch | null = null;

export function setYoutubeMainWorldReaderForTests(reader: YoutubeMainWorldReader | null): void {
  mainWorldReaderForTests = reader;
}

export function setYoutubeSameOriginFetchForTests(fetcher: YoutubeSameOriginFetch | null): void {
  sameOriginFetchForTests = fetcher;
}

export function getYoutubeSameOriginFetch(): YoutubeSameOriginFetch {
  return sameOriginFetchForTests ?? ((input, init) => fetch(input, init));
}

function normalizePublishDate(raw: unknown): string {
  const text = String(raw ?? "").trim();
  if (!text) {
    return "";
  }
  const isoDate = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return isoDate ? isoDate[1] : text;
}

function normalizePlainObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeCaptionTrack(raw: unknown): YoutubeCaptionTrackSnapshot | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const item = raw as Partial<YoutubeCaptionTrackSnapshot>;
  const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
  const languageCode = typeof item.languageCode === "string" ? item.languageCode.trim() : "";
  if (!baseUrl && !languageCode) {
    return null;
  }
  const normalized: YoutubeCaptionTrackSnapshot = {
    baseUrl,
    languageCode,
    name: typeof item.name === "string" ? item.name.trim() : ""
  };
  if (typeof item.kind === "string" && item.kind.trim()) {
    normalized.kind = item.kind.trim();
  }
  if (typeof item.vssId === "string" && item.vssId.trim()) {
    normalized.vssId = item.vssId.trim();
  }
  if (typeof item.isTranslatable === "boolean") {
    normalized.isTranslatable = item.isTranslatable;
  }
  return normalized;
}

export function normalizeYoutubePageSnapshot(
  raw: YoutubePageSnapshot,
  expectedVideoId = ""
): YoutubeVideoMetaSnapshot {
  const videoId = String(raw.videoId || expectedVideoId || "").trim();
  const rawDuration = Number(raw.duration);
  const duration = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
  const isLiveContent = Boolean(raw.isLiveContent);
  const isLiveNow = Boolean(raw.isLiveNow);
  const captionTracks = (Array.isArray(raw.captionTracks) ? raw.captionTracks : [])
    .map(normalizeCaptionTrack)
    .filter((item): item is YoutubeCaptionTrackSnapshot => item !== null);
  const rawChapters = Array.isArray(raw.chapters) ? raw.chapters : [];
  const chapters = normalizeChapters(
    rawChapters.map((ch) => ({
      title: ch?.title ?? "",
      from: ch?.from ?? 0,
      to: ch?.to ?? 0,
      source: "youtube-chapters"
    }))
  );
  const observedTimedtextUrls = Array.isArray(raw.observedTimedtextUrls)
    ? raw.observedTimedtextUrls.filter(
        (url): url is string => typeof url === "string" && url.trim().length > 0
      )
    : [];

  return {
    videoId,
    title: String(raw.title || "").trim(),
    author: String(raw.author || "").trim(),
    description: typeof raw.description === "string" ? raw.description : "",
    duration,
    publishDate: normalizePublishDate(raw.publishDate),
    isLiveContent,
    isLiveNow,
    isLiveReplay: isLiveContent && !isLiveNow,
    chapters,
    captionTracks,
    innertubeContext: normalizePlainObject(raw.innertubeContext),
    innertubeApiKey: String(raw.innertubeApiKey || "").trim(),
    transcriptParams: String(raw.transcriptParams || "").trim(),
    observedTimedtextUrls
  };
}

async function readSnapshotOnce(expectedVideoId: string): Promise<YoutubePageSnapshot | null> {
  if (mainWorldReaderForTests) {
    return (await mainWorldReaderForTests(expectedVideoId || undefined)) ?? null;
  }
  const resp = await sendRuntimeMessage({ type: "youtube-page-snapshot" });
  if (!resp?.ok) {
    const errText = String(resp?.error || "").trim();
    if (errText && errText !== TRANSIENT_SNAPSHOT_ERROR) {
      throw new Error(errText);
    }
    return null;
  }
  return resp.snapshot ?? null;
}

export async function readYoutubePageSnapshot(
  options: ReadYoutubePageSnapshotOptions = {}
): Promise<YoutubeVideoMetaSnapshot> {
  const expectedVideoId = String(options.expectedVideoId || "").trim() || extractYoutubeVideoId();
  const maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_SNAPSHOT_ATTEMPTS));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? DEFAULT_SNAPSHOT_RETRY_DELAY_MS));

  let lastMismatchId = "";
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const raw = await readSnapshotOnce(expectedVideoId);
    const snapshotVideoId = String(raw?.videoId || "").trim();
    const videoIdMatches = !expectedVideoId || (Boolean(snapshotVideoId) && snapshotVideoId === expectedVideoId);
    if (raw && videoIdMatches) {
      return normalizeYoutubePageSnapshot(raw, expectedVideoId);
    }
    if (raw) {
      lastMismatchId = snapshotVideoId;
    }
    if (attempt + 1 < maxAttempts && retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }
  }

  if (expectedVideoId && lastMismatchId !== "") {
    throw new Error(
      `YouTube 页面视频快照尚未切换到目标视频（期望 ${expectedVideoId}，实际 ${lastMismatchId}）。`
    );
  }
  throw new Error(TRANSIENT_SNAPSHOT_ERROR);
}
