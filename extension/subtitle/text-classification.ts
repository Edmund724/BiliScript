const NON_SPEECH_BRACKET_RE = /^(?:>>\s*)?(?:(?:\[[^\]\r\n]+\]|（[^）\r\n]+）)\s*)+$/u;

const NON_SPEECH_MUSIC_NOTE_RE = /^(?:>>\s*)?[♪♫♩♬](?:[^\r\n]*[♪♫♩♬])?$/u;

const NO_SPACE_LANG_CODES = new Set([
  "zh",
  "yue",
  "wuu",
  "nan",
  "cmn",
  "ja",
  "jp",
  "ko",
  "kr",
  "th",
  "lo",
  "km",
  "my",
  "bo"
]);

const LANG_CODE_RE = /^(?:ai-)?([a-z]{2,3})(?:-[a-z0-9]{2,8})*$/i;

const NO_SPACE_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

const LEADING_NO_SPACE_PUNCT_RE = /^[.,!?;:)\]}”’」』）】。，！？；：、]/;
const TRAILING_NO_SPACE_PUNCT_RE = /[(（\[「『【“‘。，！？；：、]$/;
const LATIN_TAIL_RE = /[a-zA-Z0-9.!?,;:'")\]]$/;
const LATIN_HEAD_RE = /^[a-zA-Z0-9"'(\[]/;

export function isNonSpeechSegment(text: string): boolean {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) {
    return false;
  }
  if (NON_SPEECH_BRACKET_RE.test(trimmed) || NON_SPEECH_MUSIC_NOTE_RE.test(trimmed)) {
    return true;
  }
  if (trimmed.includes("\n")) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    return (
      lines.length > 0 &&
      lines.every((line) => NON_SPEECH_BRACKET_RE.test(line) || NON_SPEECH_MUSIC_NOTE_RE.test(line))
    );
  }
  return false;
}

export function isNoSpaceLanguage(langOrText?: string): boolean {
  const trimmed = String(langOrText ?? "").trim();
  if (!trimmed) {
    return false;
  }
  const normalized = trimmed.replace(/_/g, "-");
  const codeMatch = LANG_CODE_RE.exec(normalized);
  if (codeMatch) {
    return NO_SPACE_LANG_CODES.has(codeMatch[1].toLowerCase());
  }
  return NO_SPACE_SCRIPT_RE.test(trimmed);
}

export function joinSubtitleText(prev: string, next: string, lang?: string): string {
  const a = String(prev ?? "").trim();
  const b = String(next ?? "").trim();
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }

  if (LEADING_NO_SPACE_PUNCT_RE.test(b) || TRAILING_NO_SPACE_PUNCT_RE.test(a)) {
    return `${a}${b}`;
  }

  const lastChar = a[a.length - 1];
  const firstChar = b[0];

  if (NO_SPACE_SCRIPT_RE.test(lastChar) || NO_SPACE_SCRIPT_RE.test(firstChar)) {
    return `${a}${b}`;
  }

  const normalizedLang = String(lang ?? "").trim().toLowerCase();
  if (normalizedLang && normalizedLang !== "auto" && isNoSpaceLanguage(normalizedLang)) {
    if (LATIN_TAIL_RE.test(lastChar) && LATIN_HEAD_RE.test(firstChar)) {
      return `${a} ${b}`;
    }
    return `${a}${b}`;
  }

  return `${a} ${b}`;
}
