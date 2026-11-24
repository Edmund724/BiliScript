export const SEGMENT_CACHE_KEY_FIELDS = [
  { key: "bvid", context: "bvid" },
  { key: "cid", context: "cid" },
  { key: "subtitleId", context: "selectedSubtitleId" },
  { key: "subtitleUrl", context: "selectedSubtitleUrl" },
  { key: "lang", context: "subtitleLang" }
] as const;

export type SegmentCacheKeyFieldName = (typeof SEGMENT_CACHE_KEY_FIELDS)[number]["key"];
export type SegmentCacheContextFieldName = (typeof SEGMENT_CACHE_KEY_FIELDS)[number]["context"];

export type SegmentCacheKeyFields = { [K in SegmentCacheKeyFieldName]: unknown };

export type SegmentCacheKeyStringFields = { [K in SegmentCacheKeyFieldName]: string };

export type SegmentCacheContextFields = { [K in SegmentCacheContextFieldName]?: unknown } & { site?: unknown };

const YOUTUBE_UNIT_CID = "yt";
const YOUTUBE_STORAGE_KEY_PREFIX = "yt~";

function normalizeSegmentSite(value: unknown): "bilibili" | "youtube" {
  return typeof value === "string" && value.trim().toLowerCase() === "youtube"
    ? "youtube"
    : "bilibili";
}

function encodeYoutubeSegmentBvid(rawBvid: string): string {
  if (!rawBvid || rawBvid.startsWith(YOUTUBE_STORAGE_KEY_PREFIX)) {
    return rawBvid;
  }
  return `${YOUTUBE_STORAGE_KEY_PREFIX}${rawBvid.replace(/~/g, "~t").replace(/_/g, "~u")}`;
}

export function segmentCacheKeyFields(context?: Record<string, unknown> | null): SegmentCacheKeyFields {
  const fields = {} as Record<SegmentCacheKeyFieldName, unknown>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    fields[field.key] = context ? context[field.context] : undefined;
  }
  return fields;
}

export function segmentCacheKeyStringFields(
  context?: Record<string, unknown> | null,
  site?: unknown
): SegmentCacheKeyStringFields {
  const fields = {} as Record<SegmentCacheKeyFieldName, string>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    const raw = context ? context[field.context] : undefined;
    fields[field.key] = String(raw ?? "");
  }
  const explicitSite = site !== undefined && site !== null && String(site).trim() !== "" ? site : context?.site;
  const isYoutube =
    explicitSite !== undefined && explicitSite !== null && String(explicitSite).trim() !== ""
      ? normalizeSegmentSite(explicitSite) === "youtube"
      : fields.cid.trim() === YOUTUBE_UNIT_CID ||
        fields.bvid.trim().startsWith(YOUTUBE_STORAGE_KEY_PREFIX);
  if (isYoutube) {
    fields.bvid = encodeYoutubeSegmentBvid(fields.bvid.trim());
    fields.cid = YOUTUBE_UNIT_CID;
  }
  return fields;
}

export function projectSegmentCacheContext(context?: Record<string, unknown> | null): SegmentCacheContextFields {
  const fields = {} as SegmentCacheContextFields;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    fields[field.context] = context ? context[field.context] : undefined;
  }
  if (context && context.site !== undefined) {
    fields.site = context.site;
  }
  return fields;
}
