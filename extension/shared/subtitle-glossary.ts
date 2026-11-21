export const INDEX_TRANSLATE_MODELS = [
  "Index-Translate-35B-A3B",
  "Index-Translate-9B",
  "Index-Translate-2B"
] as const;

export type IndexTranslateModelId = (typeof INDEX_TRANSLATE_MODELS)[number];

export const INDEX_TRANSLATE_DEFAULT_MODEL: IndexTranslateModelId = "Index-Translate-35B-A3B";

function findCanonicalIndexTranslateModel(trimmed: string): IndexTranslateModelId | undefined {
  const lower = trimmed.toLowerCase();
  return INDEX_TRANSLATE_MODELS.find((candidate) => candidate.toLowerCase() === lower);
}

export function isIndexTranslateModelId(value: unknown): value is IndexTranslateModelId {
  return typeof value === "string" && (INDEX_TRANSLATE_MODELS as readonly string[]).includes(value);
}

export function normalizeIndexTranslateModel(model?: unknown): IndexTranslateModelId {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return INDEX_TRANSLATE_DEFAULT_MODEL;
  }
  return findCanonicalIndexTranslateModel(trimmed) ?? INDEX_TRANSLATE_DEFAULT_MODEL;
}

export function normalizeModelForSignature(rawModel: unknown): string {
  const trimmed = String(rawModel ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return findCanonicalIndexTranslateModel(trimmed) ?? trimmed;
}

export interface SubtitleGlossaryEntry {
  source: string;
  target: string;
  note?: string;
}

export type SubtitleGlossaryInput =
  | string
  | readonly SubtitleGlossaryEntry[]
  | Readonly<Record<string, string>>;

function upsertGlossaryEntry(
  deduped: Map<string, SubtitleGlossaryEntry>,
  rawSource: unknown,
  rawTarget: unknown,
  rawNote?: unknown
): void {
  const source = String(rawSource ?? "").replace(/\s+/g, " ").trim();
  if (!source || /^[=\-_*~`]+$/.test(source)) {
    return;
  }
  const target = String(rawTarget ?? "").replace(/\s+/g, " ").trim();
  const note = String(rawNote ?? "").replace(/\s+/g, " ").trim();
  const key = source.toLowerCase();
  const entry: SubtitleGlossaryEntry = note ? { source, target, note } : { source, target };
  if (deduped.has(key)) {
    deduped.delete(key);
  }
  deduped.set(key, entry);
}

export function parseSubtitleGlossary(
  input: SubtitleGlossaryInput | null | undefined
): SubtitleGlossaryEntry[] {
  if (!input) {
    return [];
  }

  const deduped = new Map<string, SubtitleGlossaryEntry>();

  if (typeof input === "string") {
    const lines = input.split(/\r?\n/);
    for (const rawLine of lines) {
      const trimmed = rawLine.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) {
        continue;
      }
      let eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) {
        eqIdx = trimmed.indexOf("＝");
      }
      if (eqIdx === -1) {
        upsertGlossaryEntry(deduped, trimmed, "");
        continue;
      }
      const source = trimmed.slice(0, eqIdx).trim();
      const target = trimmed.slice(eqIdx + 1).trim();
      if (!source) {
        continue;
      }
      upsertGlossaryEntry(deduped, source, target);
    }
    return [...deduped.values()];
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const rec = item as { source?: unknown; target?: unknown; note?: unknown };
      upsertGlossaryEntry(deduped, rec.source, rec.target, rec.note);
    }
    return [...deduped.values()];
  }

  if (typeof input === "object") {
    for (const [source, target] of Object.entries(input as Record<string, unknown>)) {
      upsertGlossaryEntry(deduped, source, target);
    }
  }

  return [...deduped.values()];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function compileGlossaryMatcher(source: string): RegExp {
  const normalized = String(source ?? "").trim();
  if (!normalized) {
    return /(?!)/;
  }
  const escapedParts = normalized
    .split(/\s+/)
    .map((part) => escapeRegExp(part));
  const body = escapedParts.join("\\s+");
  const hasWordStart = /^[A-Za-z0-9_]/.test(normalized);
  const hasWordEnd = /[A-Za-z0-9_]$/.test(normalized);
  const allowPluralS = hasWordEnd && normalized.length >= 3 && /[A-Za-rt-z]$/.test(normalized);
  const prefix = hasWordStart ? "(?<![A-Za-z0-9_])" : "";
  const suffix = hasWordEnd ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${prefix}${body}${allowPluralS ? "s?" : ""}${suffix}`, "i");
}

export function matchesGlossarySourceInText(source: string, text: string): boolean {
  const normalized = String(source ?? "").trim();
  if (!normalized) {
    return false;
  }
  return compileGlossaryMatcher(normalized).test(text);
}

export function filterGlossaryForText(
  glossary: SubtitleGlossaryInput | null | undefined,
  text: string
): SubtitleGlossaryEntry[] {
  const entries = parseSubtitleGlossary(glossary);
  const targetText = String(text ?? "");
  if (entries.length === 0 || !targetText.trim()) {
    return [];
  }
  return entries.filter((entry) => matchesGlossarySourceInText(entry.source, targetText));
}
