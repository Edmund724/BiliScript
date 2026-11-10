import {
  LIVE_INTERPRET_LATIN_TARGET_LANGS,
  type InterpretSubtitleDisplayMode,
  type LiveInterpretTargetLang
} from "./interpret-subtitle-preferences.js";

export type { InterpretSubtitleDisplayMode } from "./interpret-subtitle-preferences.js";

export interface InterpretSubtitleLines {
  showOriginal: boolean;
  showTranslation: boolean;
}

type ScriptCategory = "han" | "kana" | "hangul" | "latin" | "cyrillic" | "greek";
const TARGET_SCRIPTS: Record<string, readonly ScriptCategory[]> = {
  zh: ["han"],
  ja: ["han", "kana"],
  ko: ["hangul"],
  ru: ["cyrillic"],
  el: ["greek"]
};

const SCRIPT_PATTERNS: ReadonlyArray<readonly [ScriptCategory, RegExp]> = [
  ["han", /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/],
  ["kana", /[\u3040-\u30ff\u31f0-\u31ff]/],
  ["hangul", /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/],
  ["latin", /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/],
  ["cyrillic", /[\u0400-\u052f]/],
  ["greek", /[\u0370-\u03ff\u1f00-\u1fff]/]
];

function dominantScript(text: string): ScriptCategory | null {
  const counts = new Map<ScriptCategory, number>();
  for (const char of text) {
    for (const [category, pattern] of SCRIPT_PATTERNS) {
      if (!pattern.test(char)) continue;
      counts.set(category, (counts.get(category) || 0) + 1);
      break;
    }
  }

  let dominant: ScriptCategory | null = null;
  let max = 0;
  for (const [category] of SCRIPT_PATTERNS) {
    const count = counts.get(category) || 0;
    if (count > max) {
      dominant = category;
      max = count;
    }
  }
  return dominant;
}

export function resolveInterpretSubtitleLines(
  sourceText: string,
  targetLang: LiveInterpretTargetLang,
  mode: InterpretSubtitleDisplayMode
): InterpretSubtitleLines {
  if (mode === "translation") return { showOriginal: false, showTranslation: true };
  if (mode === "bilingual") return { showOriginal: true, showTranslation: true };

  const sourceScript = dominantScript(sourceText);
  const sameScript = sourceScript !== null && TARGET_SCRIPTS[targetLang]?.includes(sourceScript) === true;
  const showOriginal = LIVE_INTERPRET_LATIN_TARGET_LANGS.has(targetLang) || !sameScript;
  return { showOriginal, showTranslation: true };
}
