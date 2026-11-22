import { fnv1a32 } from "../shared/text-primitives.js";
import { normalizeSubtitleUrlForCache } from "../bilibili/native-payload.js";
import { buildSubtitleSourceKey } from "./source-key.js";
import type { SubtitleTrack } from "../bilibili/video-api.js";
import type { SubtitleTrackCandidate } from "./selection.js";
import type { SubtitleBodyItem } from "../ai/types.js";

export function normalizeSubtitleItems(items: unknown): SubtitleBodyItem[] {
  return (Array.isArray(items) ? items : []).filter(
    (item): item is SubtitleBodyItem =>
      Boolean(item) && String((item as { content?: unknown })?.content ?? "").trim().length > 0
  );
}

function chapterOutlineText(chapterOutline: unknown): string {
  return Array.isArray(chapterOutline)
    ? chapterOutline.map((item) => `${Number(item?.seconds) || 0}|${String(item?.title ?? "")}`).join("\n")
    : "";
}

export interface SubtitleSignatureInput {
  lang?: unknown;
  subtitleId?: unknown;
  subtitleUrl?: unknown;
  body?: unknown;
  chapters?: unknown;
  chapterOutline?: unknown;
}

interface BodySignatureMetrics {
  count: number;
  firstFrom: number;
  lastTo: number;
  totalChars: number;
}

const bodySignatureMetricsCache = new WeakMap<object, BodySignatureMetrics>();

function measureSubtitleBody(body: unknown): BodySignatureMetrics {
  const items = Array.isArray(body) ? body : [];
  const cached = bodySignatureMetricsCache.get(items);
  if (cached) {
    return cached;
  }
  let count = 0;
  let totalChars = 0;
  let firstFrom = 0;
  let lastTo = 0;
  for (const item of normalizeSubtitleItems(items)) {
    const content = String(item?.content ?? "").trim();
    if (!content) continue;
    if (count === 0) {
      firstFrom = Math.max(0, Math.floor(Number(item?.from) || 0));
    }
    lastTo = Math.max(0, Math.floor(Number(item?.to) || Number(item?.from) || 0));
    totalChars += content.length;
    count += 1;
  }
  const metrics = { count, firstFrom, lastTo, totalChars };
  bodySignatureMetricsCache.set(items, metrics);
  return metrics;
}

export function buildSubtitleSignature({
  lang,
  subtitleId,
  subtitleUrl,
  body,
  chapters,
  chapterOutline
}: SubtitleSignatureInput = {}): string {
  const sourceKey = buildSubtitleSourceKey(subtitleId, subtitleUrl, lang);
  const { count, firstFrom, lastTo, totalChars } = measureSubtitleBody(body);
  const basis = [
    "v4",
    sourceKey,
    String(lang ?? ""),
    String(count),
    String(firstFrom),
    String(lastTo),
    String(totalChars),
    String(Array.isArray(chapters) && chapters.length > 0),
    String(fnv1a32(chapterOutlineText(chapterOutline)))
  ].join("|");
  return `sig${fnv1a32(basis).toString(36)}`;
}

export function buildSubtitleCandidates<TTrack extends SubtitleTrackCandidate = SubtitleTrack>(
  subtitles: readonly TTrack[] | null | undefined,
  preferred: TTrack | null | undefined
): TTrack[] {
  const tracks = subtitles || [];
  const seen = new Set<string>();
  const list: TTrack[] = [];

  const pushUnique = (item: TTrack | null | undefined) => {
    if (!item) {
      return;
    }
    const key =
      `${String(item.id || "").trim()}|` +
      `${normalizeSubtitleUrlForCache(item.subtitleUrl)}|` +
      `${String(item.lan || "").trim().toLowerCase()}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    list.push(item);
  };

  pushUnique(preferred);
  for (const item of tracks) {
    pushUnique(item);
  }
  return list;
}
