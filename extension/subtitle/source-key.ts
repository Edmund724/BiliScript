import { normalizeSubtitleUrlForCache } from "../bilibili/native-payload.js";

export type TrackIdentity =
  | { kind: "track"; trackId: unknown }
  | { kind: "url"; url: unknown }
  | { kind: "lang"; lang: unknown }
  | { kind: "asr"; providerId: unknown; model: unknown; lang: unknown }
  | { kind: "translated"; targetLang: unknown }
  | { kind: "track-translated"; sourceKey: unknown; targetLang: unknown };

const ASR_VARIANT_ROOT = "asr";
export const ASR_SOURCE_KEY_PREFIX = `id_${ASR_VARIANT_ROOT}:`;

const TRANSLATED_VARIANT_ROOT = "translate-";
export const TRANSLATED_SOURCE_KEY_PREFIX = `id_${TRANSLATED_VARIANT_ROOT}`;

export function translatedTrackId(targetLang: unknown): string {
  return `${TRANSLATED_VARIANT_ROOT}${String(targetLang || "").trim()}`;
}

export function trackTranslatedSlotId(sourceKey: unknown, targetLang: unknown): string {
  return `${String(sourceKey || "").trim()}_${translatedTrackId(targetLang)}`;
}

function trackIdComponent(rawId: unknown): string {
  return `id_${String(rawId || "").trim()}`;
}

function asrSegmentText(value: unknown): string {
  return String(value || "");
}

export function trackIdentity(subtitleId: unknown, subtitleUrl: unknown, lang: unknown): TrackIdentity {
  if (String(subtitleId || "").trim()) {
    return { kind: "track", trackId: subtitleId };
  }
  if (normalizeSubtitleUrlForCache(subtitleUrl)) {
    return { kind: "url", url: subtitleUrl };
  }
  return { kind: "lang", lang };
}

export function subtitleSourceKey(identity: TrackIdentity): string {
  switch (identity.kind) {
    case "track":
      return trackIdComponent(identity.trackId);
    case "url":
      return `url_${normalizeSubtitleUrlForCache(identity.url)}`;
    case "lang":
      return `lang_${String(identity.lang || "").trim().toLowerCase() || "unknown"}`;
    case "asr":
      return trackIdComponent(
        `${ASR_VARIANT_ROOT}:${asrSegmentText(identity.providerId)}:${asrSegmentText(identity.model)}:${asrSegmentText(identity.lang)}`
      );
    case "translated":
      return trackIdComponent(translatedTrackId(identity.targetLang));
    case "track-translated":
      return trackTranslatedSlotId(identity.sourceKey, identity.targetLang);
  }
}

export function buildSubtitleSourceKey(subtitleId: unknown, subtitleUrl: unknown, lang: unknown): string {
  return subtitleSourceKey(trackIdentity(subtitleId, subtitleUrl, lang));
}

export function isAsrVariantSourceKey(sourceKey: unknown): boolean {
  return String(sourceKey || "").startsWith(ASR_SOURCE_KEY_PREFIX);
}

export function isTranslatedVariantSourceKey(sourceKey: unknown): boolean {
  return String(sourceKey || "").startsWith(TRANSLATED_SOURCE_KEY_PREFIX);
}
