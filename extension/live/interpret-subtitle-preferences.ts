export const LIVE_INTERPRET_TARGET_LANG_OPTIONS = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日语" },
  { value: "ko", label: "韩语" },
  { value: "de", label: "德语" },
  { value: "fr", label: "法语" },
  { value: "es", label: "西班牙语" },
  { value: "ru", label: "俄语" },
  { value: "it", label: "意大利语" },
  { value: "pt", label: "葡萄牙语" },
  { value: "tr", label: "土耳其语" },
  { value: "el", label: "希腊语" },
  { value: "id", label: "印尼语" },
  { value: "ms", label: "马来语" }
] as const;

export type LiveInterpretTargetLang = (typeof LIVE_INTERPRET_TARGET_LANG_OPTIONS)[number]["value"];

export const LIVE_INTERPRET_TARGET_BCP47: Record<LiveInterpretTargetLang, string> = {
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP",
  ko: "ko-KR",
  de: "de-DE",
  fr: "fr-FR",
  es: "es-ES",
  ru: "ru-RU",
  it: "it-IT",
  pt: "pt-PT",
  tr: "tr-TR",
  el: "el-GR",
  id: "id-ID",
  ms: "ms-MY"
};

export const LIVE_INTERPRET_DISPLAY_MODE_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "translation", label: "仅译文" },
  { value: "bilingual", label: "双语" }
] as const;
export type InterpretSubtitleDisplayMode = (typeof LIVE_INTERPRET_DISPLAY_MODE_OPTIONS)[number]["value"];

export const BILINGUAL_DISPLAY_ORDER_OPTIONS = [
  { value: "original-first", label: "主轨/原文在上" },
  { value: "translation-first", label: "副轨/译文在上" }
] as const;
export type BilingualDisplayOrder = (typeof BILINGUAL_DISPLAY_ORDER_OPTIONS)[number]["value"];

export const LIVE_INTERPRET_LATIN_TARGET_LANGS = new Set<LiveInterpretTargetLang>([
  "en", "fr", "de", "es", "it", "pt", "tr", "id", "ms"
]);

export const INTERPRET_SUBTITLE_SCALE_STEPS = [
  75, 80, 90, 100, 110, 120, 130, 140, 150
] as const;

export const INTERPRET_SUBTITLE_SCALE_MIN = 75;
export const INTERPRET_SUBTITLE_SCALE_MAX = 150;
export const INTERPRET_SUBTITLE_SCALE_DEFAULT = 100;

export function normalizeInterpretFontScale(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return INTERPRET_SUBTITLE_SCALE_DEFAULT;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return INTERPRET_SUBTITLE_SCALE_DEFAULT;
  }
  return Math.min(
    INTERPRET_SUBTITLE_SCALE_MAX,
    Math.max(INTERPRET_SUBTITLE_SCALE_MIN, Math.round(parsed))
  );
}

export function stepInterpretFontScale(current: number, direction: -1 | 1): number {
  const normalized = normalizeInterpretFontScale(current);
  if (direction < 0) {
    for (let i = INTERPRET_SUBTITLE_SCALE_STEPS.length - 1; i >= 0; i -= 1) {
      if (INTERPRET_SUBTITLE_SCALE_STEPS[i] < normalized) {
        return INTERPRET_SUBTITLE_SCALE_STEPS[i];
      }
    }
    return INTERPRET_SUBTITLE_SCALE_MIN;
  }
  for (let i = 0; i < INTERPRET_SUBTITLE_SCALE_STEPS.length; i += 1) {
    if (INTERPRET_SUBTITLE_SCALE_STEPS[i] > normalized) {
      return INTERPRET_SUBTITLE_SCALE_STEPS[i];
    }
  }
  return INTERPRET_SUBTITLE_SCALE_MAX;
}
