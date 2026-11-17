// extension/subtitle/text-classification.ts
// 字幕文本分类与拼接工具（参考 fishjar/kiss-translator subtitleTextClassification）：
//   - isNonSpeechSegment：识别纯音效/环境/说话人标记或纯音符包裹行；
//   - isNoSpaceLanguage：判断语言代码或文本是否属于无空格分隔语言（zh/ja/ko/th 等）；
//   - joinSubtitleText：按语种与标点边界拼接相邻字幕文本。

// 纯音效/环境/说话人标记（方括号 / 全角括号，支持可选 ">> " 前缀与多标签串接）
const NON_SPEECH_BRACKET_RE = /^(?:>>\s*)?(?:(?:\[[^\]\r\n]+\]|（[^）\r\n]+）)\s*)+$/u;

// 纯音符符号或由音符包裹的行（如 "♪"、"♪♪"、"♪ Music ♪"、"♫ Instrumental ♫"、">> ♪ Music ♪"）
const NON_SPEECH_MUSIC_NOTE_RE = /^(?:>>\s*)?[♪♫♩♬](?:[^\r\n]*[♪♫♩♬])?$/u;

// 无空格分隔语言主标签（ISO 639-1 / 639-3 及常见别名）
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

// 纯语言代码串（兼容 B 站 AI 字幕前缀如 "ai-zh"）
const LANG_CODE_RE = /^(?:ai-)?([a-z]{2,3})(?:-[a-z0-9]{2,8})*$/i;

// 无空格书写系统字符检测（汉字、假名、谚文、泰/老挝/高棉/缅甸/藏文）
const NO_SPACE_SCRIPT_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;

// 紧贴前词的闭合/句中标点（其前不加空格）与紧贴后词的开括号/全角标点（其后不加空格）
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
