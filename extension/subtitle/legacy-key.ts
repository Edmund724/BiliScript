import { TRANSLATED_SOURCE_KEY_PREFIX } from "./source-key.js";
import { toCanonicalTargetLangBcp47 } from "./selection.js";

export const SUBTITLE_CACHE_KEY_PREFIX = "biliscript_subtitle_cache_";

export type ParsedSubtitleCacheKey =
  | { kind: "raw"; bvid: string; cid: string; trackKey: string }
  | { kind: "translated"; bvid: string; cid: string; sourceTrackKey: string; targetLang: string };

export function parseSubtitleCacheKey(cacheKey: string): ParsedSubtitleCacheKey | null {
  const raw = String(cacheKey || "");
  if (!raw.startsWith(SUBTITLE_CACHE_KEY_PREFIX)) {
    return null;
  }
  const rest = raw.slice(SUBTITLE_CACHE_KEY_PREFIX.length);
  const firstSep = rest.indexOf("_");
  if (firstSep <= 0) return null;
  const secondSep = rest.indexOf("_", firstSep + 1);
  if (secondSep <= firstSep + 1) return null;
  const bvid = rest.slice(0, firstSep);
  const cid = rest.slice(firstSep + 1, secondSep);
  const sourceKey = rest.slice(secondSep + 1);
  if (!bvid || !cid || !sourceKey) {
    return null;
  }
  if (sourceKey.startsWith(TRANSLATED_SOURCE_KEY_PREFIX)) {
    const rawLang = sourceKey.slice(TRANSLATED_SOURCE_KEY_PREFIX.length);
    return {
      kind: "translated",
      bvid,
      cid,
      sourceTrackKey: "asr",
      targetLang: toCanonicalTargetLangBcp47(rawLang || "zh")
    };
  }
  const translatedMatch = /^(.+)_translate-(.+)$/.exec(sourceKey);
  if (translatedMatch) {
    return {
      kind: "translated",
      bvid,
      cid,
      sourceTrackKey: translatedMatch[1],
      targetLang: toCanonicalTargetLangBcp47(translatedMatch[2] || "zh")
    };
  }
  return {
    kind: "raw",
    bvid,
    cid,
    trackKey: sourceKey
  };
}
