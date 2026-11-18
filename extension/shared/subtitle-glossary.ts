// extension/shared/subtitle-glossary.ts
// 字幕翻译术语表解析、词界匹配与内置 Index-Translate 模型名归一单源纯叶。
//
// 约束：零 chrome / DOM / storage / 外部依赖，可安全进入 Service Worker、content 与 offscreen。

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

/**
 * 归一化内置 Index-Translate 模型名：支持 3 个枚举模型（忽略大小写），缺省或未知值回落至旗舰默认模型 `Index-Translate-35B-A3B`。
 */
export function normalizeIndexTranslateModel(model?: unknown): IndexTranslateModelId {
  const trimmed = String(model ?? "").trim();
  if (!trimmed) {
    return INDEX_TRANSLATE_DEFAULT_MODEL;
  }
  return findCanonicalIndexTranslateModel(trimmed) ?? INDEX_TRANSLATE_DEFAULT_MODEL;
}

/**
 * 缓存签名用模型名归一：对内置 Index-Translate 枚举模型做大小写归一，自定义平台模型名原样保留。
 */
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

/**
 * 解析字幕翻译术语表配置：
 * - 支持多行文本：`原文 = 译文`（指定译文）、`原文 =` 或仅写 `原文`（译文留空，强制保留原词不翻译）；
 * - 自动忽略空行、`#` / `//` 注释行、分隔线及缺原文的异常行；
 * - 同时兼容数组与键值对象输入，按小写原文去重（后者覆盖前者）。
 */
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

/**
 * 编译术语原文的大小写不敏感词界匹配正则（支持英文复数尾缀 `s?`）。
 */
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

/**
 * 判断术语原文是否在给定文本中命中词界匹配。
 */
export function matchesGlossarySourceInText(source: string, text: string): boolean {
  const normalized = String(source ?? "").trim();
  if (!normalized) {
    return false;
  }
  return compileGlossaryMatcher(normalized).test(text);
}

/**
 * 按给定原文（大小写不敏感）过滤实际出现过的术语条目，避免全量词表浪费 Token。
 */
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
