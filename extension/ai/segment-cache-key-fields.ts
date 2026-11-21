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

export type SegmentCacheContextFields = { [K in SegmentCacheContextFieldName]?: unknown };

export function segmentCacheKeyFields(context?: Record<string, unknown> | null): SegmentCacheKeyFields {
  const fields = {} as Record<SegmentCacheKeyFieldName, unknown>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    fields[field.key] = context ? context[field.context] : undefined;
  }
  return fields;
}

export function segmentCacheKeyStringFields(context?: Record<string, unknown> | null): SegmentCacheKeyStringFields {
  const fields = {} as Record<SegmentCacheKeyFieldName, string>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    const raw = context ? context[field.context] : undefined;
    fields[field.key] = String(raw ?? "");
  }
  return fields;
}

export function projectSegmentCacheContext(context?: Record<string, unknown> | null): SegmentCacheContextFields {
  const fields = {} as Record<SegmentCacheContextFieldName, unknown>;
  for (const field of SEGMENT_CACHE_KEY_FIELDS) {
    fields[field.context] = context ? context[field.context] : undefined;
  }
  return fields;
}
