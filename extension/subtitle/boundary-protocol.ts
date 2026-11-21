import {
  mergeSubtitlesByRule,
  type AtomicSubtitleEvent,
  type MergeRuleOptions,
  type SubtitleOutputItem
} from "./segmentation.js";
import { isNonSpeechSegment, joinSubtitleText } from "./text-classification.js";

export interface BoundaryInputEvent {
  id: string;
  text: string;
  pauseMs?: number;
}

export interface RawBoundaryGroup {
  ids?: unknown;
  text?: unknown;
  translation?: unknown;
}

export interface BoundaryCue {
  startIndex: number;
  endIndex: number;
  from: number;
  to: number;
  text: string;
  translation: string;
}

export interface CcSubtitleInputItem {
  id: string;
  text: string;
}

export interface CcSubtitleTranslationItem {
  id: string;
  translation: string;
}

export interface FinalizeAiCuesOptions {
  sourceLang?: string;
  ruleOptions?: MergeRuleOptions;
  fallbackToOriginal?: boolean;
  translateFallbackLines?: (texts: string[]) => Promise<string[]>;
}

export interface FinalizedAiCuesResult {
  items: SubtitleOutputItem[];
  translations: SubtitleOutputItem[];
  cues: BoundaryCue[];
}

const DEFAULT_MAX_CHUNK_CHARS = 1000;
const SOFT_BOUNDARY_PAUSE_MS = 1000;
const SOFT_BOUNDARY_PUNCT_RE = /[。！？.!?…\)）]["'”’」』\]]*$/u;

export function splitEventsIntoAiChunks(
  events: readonly AtomicSubtitleEvent[],
  maxChunkChars = DEFAULT_MAX_CHUNK_CHARS
): AtomicSubtitleEvent[][] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const hardLimit = Math.max(1, Math.floor(Number(maxChunkChars) || DEFAULT_MAX_CHUNK_CHARS));
  const preferredBoundary = Math.floor(hardLimit * 0.8);

  const chunks: AtomicSubtitleEvent[][] = [];
  let currentChunk: AtomicSubtitleEvent[] = [];
  let currentChars = 0;

  for (let i = 0; i < events.length; i += 1) {
    const curr = events[i];
    const text = String(curr?.text ?? "");
    const len = text.length;

    if (currentChunk.length > 0 && currentChars + len > hardLimit) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(curr);
    currentChars += len;

    if (i < events.length - 1) {
      if (currentChars >= hardLimit) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentChars = 0;
        continue;
      }

      if (currentChars >= preferredBoundary) {
        const next = events[i + 1];
        const hasSentenceEnd = SOFT_BOUNDARY_PUNCT_RE.test(text.trim());
        const hasLongPause = next !== undefined && next.startMs - curr.endMs > SOFT_BOUNDARY_PAUSE_MS;
        if (hasSentenceEnd || hasLongPause) {
          chunks.push(currentChunk);
          currentChunk = [];
          currentChars = 0;
        }
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  return chunks;
}

export function formatBoundaryEvents(
  events: readonly AtomicSubtitleEvent[]
): BoundaryInputEvent[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  return events.map((event, index) => {
    const encoded: BoundaryInputEvent = {
      id: String(index),
      text: String(event?.text ?? "")
    };
    if (index + 1 < events.length) {
      const pauseMs = Math.round(events[index + 1].startMs - event.endMs);
      if (pauseMs > 0) {
        encoded.pauseMs = pauseMs;
      }
    }
    return encoded;
  });
}

export function formatCcSubtitleItems(
  items: ReadonlyArray<{ content?: unknown }>
): CcSubtitleInputItem[] {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  return items.map((item, index) => ({
    id: String(index),
    text: String(item?.content ?? "").trim()
  }));
}

function stripMarkdownCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fullFenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fullFenceMatch) {
    return fullFenceMatch[1].trim();
  }
  const openFenceMatch = /```(?:json)?\s*([\s\S]*)$/i.exec(trimmed);
  if (openFenceMatch) {
    return openFenceMatch[1].trim();
  }
  return trimmed;
}

export function stripTrailingCommasOutsideStrings(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ",") {
      let lookahead = i + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead])) {
        lookahead += 1;
      }
      const nextNonWs = input[lookahead];
      if (nextNonWs === "}" || nextNonWs === "]") {
        continue;
      }
    }

    out += ch;
  }

  return out;
}

function tryParseJson(candidate: string): { ok: true; value: unknown } | { ok: false } {
  const cleaned = stripTrailingCommasOutsideStrings(candidate.trim());
  if (!cleaned) {
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return { ok: false };
  }
}

function collectCompletedArrayObjectEnds(source: string, arrayOpenIndex: number): number[] {
  const ends: number[] = [];
  let inString = false;
  let escaped = false;
  let bracketDepth = 0;
  let braceDepth = 0;

  for (let i = arrayOpenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") {
      bracketDepth += 1;
    } else if (ch === "]") {
      bracketDepth -= 1;
      if (bracketDepth <= 0) {
        break;
      }
    } else if (ch === "{") {
      braceDepth += 1;
    } else if (ch === "}") {
      if (braceDepth > 0) {
        braceDepth -= 1;
        if (bracketDepth === 1 && braceDepth === 0) {
          ends.push(i);
        }
      }
    }
  }

  return ends;
}

export function salvageTruncatedSubtitleJson<T = unknown>(raw: string): T | null {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }

  const unfenced = stripMarkdownCodeFences(raw);
  const direct = tryParseJson(unfenced);
  if (direct.ok) {
    return direct.value as T;
  }

  const firstBrace = unfenced.indexOf("{");
  const firstBracket = unfenced.indexOf("[");
  const startIsObject =
    firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket);

  if (startIsObject) {
    const lastBrace = unfenced.lastIndexOf("}");
    if (lastBrace > firstBrace) {
      const wrapped = tryParseJson(unfenced.slice(firstBrace, lastBrace + 1));
      if (wrapped.ok) {
        return wrapped.value as T;
      }
    }
  } else if (firstBracket !== -1) {
    const lastBracket = unfenced.lastIndexOf("]");
    if (lastBracket > firstBracket) {
      const wrapped = tryParseJson(unfenced.slice(firstBracket, lastBracket + 1));
      if (wrapped.ok) {
        return wrapped.value as T;
      }
    }
  }

  const groupsArrayMatch = /"(?:groups|items|translations)"\s*:\s*\[/.exec(unfenced);
  if (groupsArrayMatch && firstBrace !== -1 && firstBrace <= groupsArrayMatch.index) {
    const arrayOpenIdx =
      groupsArrayMatch.index + groupsArrayMatch[0].lastIndexOf("[");
    const completedEnds = collectCompletedArrayObjectEnds(unfenced, arrayOpenIdx);
    for (let i = completedEnds.length - 1; i >= 0; i -= 1) {
      const prefix = `${unfenced.slice(firstBrace, completedEnds[i] + 1)}]}`;
      const salvaged = tryParseJson(prefix);
      if (salvaged.ok) {
        return salvaged.value as T;
      }
    }
  }

  if (firstBracket !== -1) {
    const completedEnds = collectCompletedArrayObjectEnds(unfenced, firstBracket);
    for (let i = completedEnds.length - 1; i >= 0; i -= 1) {
      const prefix = `${unfenced.slice(firstBracket, completedEnds[i] + 1)}]`;
      const salvaged = tryParseJson(prefix);
      if (salvaged.ok) {
        return salvaged.value as T;
      }
    }
  }

  return null;
}

export function parseSingleEventId(rawId: unknown): number | null {
  if (typeof rawId === "number") {
    return Number.isInteger(rawId) && rawId >= 0 ? rawId : null;
  }
  if (typeof rawId === "string") {
    const trimmed = rawId.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) ? parsed : null;
    }
  }
  return null;
}

export function parseGroupIdRange(ids: unknown): { startIndex: number; endIndex: number } | null {
  if (!Array.isArray(ids) || ids.length === 0) {
    return null;
  }

  const parsed: number[] = [];
  for (const raw of ids) {
    const n = parseSingleEventId(raw);
    if (n === null) {
      return null;
    }
    parsed.push(n);
  }

  if (parsed.length === 1) {
    return { startIndex: parsed[0], endIndex: parsed[0] };
  }

  if (parsed.length === 2) {
    return { startIndex: parsed[0], endIndex: parsed[1] };
  }

  for (let i = 1; i < parsed.length; i += 1) {
    if (parsed[i] !== parsed[i - 1] + 1) {
      return null;
    }
  }
  return { startIndex: parsed[0], endIndex: parsed[parsed.length - 1] };
}

export function takeContinuousCuePrefix<
  T extends { startIndex: number; endIndex: number }
>(
  cues: readonly T[],
  totalEvents?: number,
  initialExpectedIndex = 0
): T[] {
  if (!Array.isArray(cues) || cues.length === 0) {
    return [];
  }

  const prefix: T[] = [];
  let expectedNextIndex = initialExpectedIndex;

  for (const cue of cues) {
    if (
      !cue ||
      !Number.isInteger(cue.startIndex) ||
      !Number.isInteger(cue.endIndex)
    ) {
      break;
    }
    if (cue.startIndex !== expectedNextIndex || cue.endIndex < cue.startIndex) {
      break;
    }
    if (totalEvents !== undefined && cue.endIndex >= totalEvents) {
      break;
    }

    prefix.push(cue);
    expectedNextIndex = cue.endIndex + 1;
  }

  return prefix;
}

function extractRawGroups(groupsInput: unknown): RawBoundaryGroup[] {
  if (Array.isArray(groupsInput)) {
    return groupsInput as RawBoundaryGroup[];
  }
  if (
    groupsInput &&
    typeof groupsInput === "object" &&
    Array.isArray((groupsInput as { groups?: unknown }).groups)
  ) {
    return (groupsInput as { groups: RawBoundaryGroup[] }).groups;
  }
  return [];
}

export function joinEventsSliceText(
  slice: readonly AtomicSubtitleEvent[],
  sourceLang?: string
): string {
  let joined = "";
  for (const ev of slice) {
    joined = joinSubtitleText(joined, ev.text, sourceLang);
  }
  return joined;
}

export function mapBoundaryGroupsToCues(
  groupsInput: unknown,
  events: readonly AtomicSubtitleEvent[],
  sourceLang?: string
): BoundaryCue[] {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const rawGroups = extractRawGroups(groupsInput);
  if (rawGroups.length === 0) {
    return [];
  }

  const candidates: Array<{
    startIndex: number;
    endIndex: number;
    rawText: string;
    translation: string;
  }> = [];

  for (const group of rawGroups) {
    const range = parseGroupIdRange(group?.ids);
    if (!range) {
      candidates.push({
        startIndex: -1,
        endIndex: -1,
        rawText: "",
        translation: ""
      });
      break;
    }
    const rawTranslation = String(group?.translation ?? "").trim();
    const translation =
      rawTranslation ||
      (group?.translation === undefined ? String(group?.text ?? "").trim() : "");
    candidates.push({
      startIndex: range.startIndex,
      endIndex: range.endIndex,
      rawText: String(group?.text ?? "").trim(),
      translation
    });
  }

  const validPrefix = takeContinuousCuePrefix(candidates, events.length, 0);

  return validPrefix.map((entry) => {
    const slice = events.slice(entry.startIndex, entry.endIndex + 1);
    const joinedText = joinEventsSliceText(slice, sourceLang);
    return {
      startIndex: entry.startIndex,
      endIndex: entry.endIndex,
      from: events[entry.startIndex].startMs / 1000,
      to: events[entry.endIndex].endMs / 1000,
      text: joinedText || entry.rawText,
      translation: entry.translation
    };
  });
}

export function parseCcTranslationMap(
  rawOrParsed: unknown,
  itemCount: number
): Map<number, string> {
  const result = new Map<number, string>();
  if (itemCount <= 0) {
    return result;
  }

  const parsed =
    typeof rawOrParsed === "string"
      ? salvageTruncatedSubtitleJson(rawOrParsed)
      : rawOrParsed;

  let entries: unknown[] = [];
  if (Array.isArray(parsed)) {
    entries = parsed;
  } else if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.translations)) {
      entries = obj.translations;
    } else if (Array.isArray(obj.items)) {
      entries = obj.items;
    } else if (Array.isArray(obj.groups)) {
      entries = obj.groups;
    }
  }

  for (const rawEntry of entries) {
    if (!rawEntry || typeof rawEntry !== "object") {
      continue;
    }
    const entry = rawEntry as { id?: unknown; ids?: unknown; translation?: unknown; text?: unknown };
    let id = parseSingleEventId(entry.id);
    if (id === null && Array.isArray(entry.ids) && entry.ids.length === 1) {
      id = parseSingleEventId(entry.ids[0]);
    }
    if (id === null || id < 0 || id >= itemCount || result.has(id)) {
      continue;
    }
    const rawTranslation = String(entry.translation ?? "").trim();
    const translation =
      rawTranslation ||
      (entry.translation === undefined ? String(entry.text ?? "").trim() : "");
    if (translation) {
      result.set(id, translation);
    }
  }

  return result;
}

export async function finalizeAiCues(
  cues: readonly BoundaryCue[],
  events: readonly AtomicSubtitleEvent[],
  options: FinalizeAiCuesOptions = {}
): Promise<FinalizedAiCuesResult> {
  if (!Array.isArray(events) || events.length === 0) {
    return { items: [], translations: [], cues: [] };
  }

  const {
    sourceLang,
    ruleOptions,
    fallbackToOriginal = false,
    translateFallbackLines
  } = options;

  const continuousPrefix = takeContinuousCuePrefix(cues, events.length, 0);
  const validCues: BoundaryCue[] = [];
  let lastTo: number | null = null;

  for (const cue of continuousPrefix) {
    const text = String(cue.text ?? "").trim();
    if (
      !text ||
      !Number.isFinite(cue.from) ||
      !Number.isFinite(cue.to) ||
      !(cue.to > cue.from) ||
      (lastTo !== null && cue.from < lastTo)
    ) {
      break;
    }
    const translation =
      cue.translation && cue.translation.trim().length > 0
        ? cue.translation.trim()
        : fallbackToOriginal
          ? text
          : "";
    validCues.push({
      startIndex: cue.startIndex,
      endIndex: cue.endIndex,
      from: cue.from,
      to: cue.to,
      text,
      translation
    });
    lastTo = cue.to;
  }

  const coveredEnd =
    validCues.length > 0 ? validCues[validCues.length - 1].endIndex : -1;

  if (coveredEnd < events.length - 1) {
    const residualStart = coveredEnd + 1;
    const residualEvents = events.slice(residualStart);
    const mergedResidual = mergeSubtitlesByRule(residualEvents, {
      ...ruleOptions,
      lang: sourceLang ?? ruleOptions?.lang
    });

    if (mergedResidual.length > 0) {
      const speechIndices: number[] = [];
      const speechTexts: string[] = [];
      for (let i = 0; i < mergedResidual.length; i += 1) {
        const text = mergedResidual[i].text.trim();
        if (text && !isNonSpeechSegment(text)) {
          speechIndices.push(i);
          speechTexts.push(text);
        }
      }

      const fallbackTranslations = new Map<number, string>();
      if (speechTexts.length > 0 && translateFallbackLines) {
        try {
          const translatedLines = await translateFallbackLines(speechTexts);
          if (Array.isArray(translatedLines)) {
            for (let i = 0; i < speechIndices.length; i += 1) {
              const line = String(translatedLines[i] ?? "").trim();
              if (line) {
                fallbackTranslations.set(speechIndices[i], line);
              }
            }
          }
        } catch {
        }
      }

      let cursorIndex = residualStart;
      for (let i = 0; i < mergedResidual.length; i += 1) {
        const ev = mergedResidual[i];
        const rawFrom = ev.startMs / 1000;
        const rawTo = ev.endMs / 1000;
        const safeFrom =
          lastTo !== null && rawFrom < lastTo
            ? lastTo
            : Number.isFinite(rawFrom)
              ? rawFrom
              : lastTo ?? 0;
        const safeTo =
          Number.isFinite(rawTo) && rawTo > safeFrom
            ? rawTo
            : Number((safeFrom + 0.001).toFixed(3));

        let matchedEnd = cursorIndex;
        while (
          matchedEnd + 1 < events.length &&
          events[matchedEnd].endMs < ev.endMs
        ) {
          matchedEnd += 1;
        }
        if (i === mergedResidual.length - 1) {
          matchedEnd = events.length - 1;
        }

        const text = ev.text.trim();
        const translated = fallbackTranslations.get(i) ?? "";
        const finalTranslation =
          translated || (fallbackToOriginal ? text : "");

        validCues.push({
          startIndex: Math.min(cursorIndex, events.length - 1),
          endIndex: Math.min(Math.max(cursorIndex, matchedEnd), events.length - 1),
          from: safeFrom,
          to: safeTo,
          text,
          translation: finalTranslation
        });

        lastTo = safeTo;
        cursorIndex = matchedEnd + 1;
      }
    }
  }

  const items: SubtitleOutputItem[] = validCues.map((cue) => ({
    from: cue.from,
    to: cue.to,
    content: cue.text
  }));

  const translations: SubtitleOutputItem[] = validCues.map((cue) => ({
    from: cue.from,
    to: cue.to,
    content: cue.translation
  }));

  return {
    items,
    translations,
    cues: validCues
  };
}
