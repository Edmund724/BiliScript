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

export const LIVE_INTERPRET_DISPLAY_MODE_OPTIONS = [
  { value: "auto", label: "自动" },
  { value: "translation", label: "仅译文" },
  { value: "bilingual", label: "双语" }
] as const;
export type InterpretSubtitleDisplayMode = (typeof LIVE_INTERPRET_DISPLAY_MODE_OPTIONS)[number]["value"];

export const LIVE_INTERPRET_LATIN_TARGET_LANGS = new Set<LiveInterpretTargetLang>([
  "en", "fr", "de", "es", "it", "pt", "tr", "id", "ms"
]);
