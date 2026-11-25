import { getSourceAudioUrl } from "./audio-source.js";
import type { JsonTransport } from "../bilibili/gateway-core.js";
import { createOffscreenChunkHost } from "./offscreen-bridge.page.js";
import type {
  AudioStreamSource,
  OffscreenChunkHost,
  AsrChunkRecord,
  AsrChunkResult
} from "./offscreen-bridge.page.js";
import { readAsrFailureSummary, projectAsrFailureSummary } from "./protocol.js";
import type { AsrAttemptOutcome, AsrTriggerMode } from "./protocol.js";
import type { SubtitleItem } from "./fallback.js";
import type { SiteId } from "../shared/site.js";
import { isNonSpeechSegment, joinSubtitleText } from "../subtitle/text-classification.js";
import { logWarn } from "../shared/logging.js";

const SENTENCE_DELIMITER_RE = /(?:[。！？!?…]+|\.+(?!\d)(?=\s|$|["'”’」』）\)\]]))["'”’」』）\)\]]*|\r?\n+/g;
const SENTENCE_END_PUNCT_RE = /[。！？.!?…]["'”’」』）\)\]]*$/;
const STRIP_NORM_RE = /[\s\p{P}\p{S}]/u;
const NO_SPACE_CHAR_RE =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}\p{Script=Tibetan}]/u;
const ASCII_WORD_CHAR_RE = /^[a-z0-9]$/;
const LEADING_TRIM_PUNCT_RE = /^[，。！？、；：,.!?;:」』）\)\]”’\s]+/;
const TRAILING_DANGLING_PUNCT_RE = /[，,、；;：:（\(\[「『“‘\s]+$/;

const OVERLAP_WINDOW_SEC = 1.8;
const MAX_NORM_OVERLAP_CHARS = 48;
const STITCH_BOUNDARY_GAP_SEC = 0.45;
const STITCH_MAX_DURATION_SEC = 10;

export function mergeShortSentences(sentences: string[], minChars = 4): string[] {
  if (sentences.length <= 1 || minChars <= 0) {
    return sentences;
  }
  const merged: string[] = [];

  for (const s of sentences) {
    if (merged.length === 0) {
      merged.push(s);
    } else if (s.length < minChars) {
      merged[merged.length - 1] = joinSubtitleText(merged[merged.length - 1], s);
    } else if (merged[merged.length - 1].length < minChars) {
      merged[merged.length - 1] = joinSubtitleText(merged[merged.length - 1], s);
    } else {
      merged.push(s);
    }
  }

  return merged;
}

export function splitTextIntoSentences(text: string, minChars = 4): string[] {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return [];
  }

  const rawSentences: string[] = [];
  let lastIndex = 0;

  for (const match of trimmed.matchAll(SENTENCE_DELIMITER_RE)) {
    const end = (match.index ?? 0) + match[0].length;
    const piece = trimmed.slice(lastIndex, end).trim();
    if (piece) {
      rawSentences.push(piece);
    }
    lastIndex = end;
  }
  const remaining = trimmed.slice(lastIndex).trim();
  if (remaining) {
    rawSentences.push(remaining);
  }

  if (rawSentences.length <= 1 || minChars <= 0) {
    return rawSentences;
  }

  return mergeShortSentences(rawSentences, minChars);
}

export type SynthesizedWord = {
  word: string;
  start: number;
  end: number;
};

export interface RichSubtitleItem extends SubtitleItem {
  words?: SynthesizedWord[];
}

export function interpolateSentenceTimestamps({
  sentences,
  startSec,
  durationSec
}: {
  sentences: string[];
  startSec: number;
  durationSec: number;
}): RichSubtitleItem[] {
  if (!sentences || sentences.length === 0) {
    return [];
  }
  const start = Number(startSec) || 0;
  const dur = Number(durationSec) || 0;

  if (sentences.length === 1) {
    return [{
      from: start,
      to: dur > 0 ? start + dur : start,
      content: sentences[0]
    }];
  }

  if (!(dur > 0)) {
    return sentences.map((content) => ({
      from: start,
      to: start,
      content
    }));
  }

  const weights = sentences.map((s) => Math.max(1, s.length));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);

  const out: RichSubtitleItem[] = [];
  let currentFrom = start;
  let accumulatedWeight = 0;

  for (let i = 0; i < sentences.length; i++) {
    accumulatedWeight += weights[i];
    const currentTo = (i === sentences.length - 1)
      ? start + dur
      : start + (dur * accumulatedWeight) / totalWeight;

    out.push({
      from: currentFrom,
      to: currentTo,
      content: sentences[i]
    });
    currentFrom = currentTo;
  }

  return out;
}

function clampChunkTime(startSec: number, relSec: number, chunkDur: number): number {
  const abs = Number(startSec) + relSec;
  return chunkDur > 0 ? Math.min(abs, Number(startSec) + chunkDur) : abs;
}

export function synthesizeChunk({ startSec, durationSec, result }: {
  startSec: number;
  durationSec: number;
  result: AsrChunkResult | null;
}): RichSubtitleItem[] {
  const out: RichSubtitleItem[] = [];
  const chunkDur = Number(result?.durationSec || 0) || Number(durationSec) || 0;
  const normalizedWords = Array.isArray(result?.words) && result.words.length > 0
    ? result.words
        .map((w) => {
          const word = String(w?.word ?? "").trim();
          const wStart = Math.max(0, Number(w?.start));
          const wEnd = Number(w?.end);
          if (!word || !Number.isFinite(Number(w?.start)) || !Number.isFinite(wEnd)) {
            return null;
          }
          const from = Number(startSec) + wStart;
          const to = Math.max(from, clampChunkTime(startSec, wEnd, chunkDur));
          return { word, start: from, end: to };
        })
        .filter((item): item is { word: string; start: number; end: number } => item !== null)
    : [];

  if (result?.segments && result.segments.length > 0) {
    for (const seg of result.segments) {
      const content = String(seg.text || "").trim();
      if (!content) {
        continue;
      }
      const from = Number(startSec) + Math.max(0, Number(seg.start) || 0);
      const to = Math.max(from, clampChunkTime(startSec, Number(seg.end) || 0, chunkDur));
      const segWords = normalizedWords.length > 0
        ? normalizedWords.filter((w) => w.end > from && w.start < to)
        : [];
      out.push(segWords.length > 0 ? { from, to, content, words: segWords } : { from, to, content });
    }
  } else if (normalizedWords.length > 0) {
    for (const w of normalizedWords) {
      out.push({ from: w.start, to: w.end, content: w.word });
    }
  } else {
    const text = String(result?.text || "").trim();
    if (text) {
      const sentences = splitTextIntoSentences(text);
      return interpolateSentenceTimestamps({
        sentences,
        startSec: Number(startSec) || 0,
        durationSec: chunkDur > 0 ? chunkDur : Number(durationSec) || 0
      });
    }
  }
  return out;
}

function cloneRichItem(item: RichSubtitleItem): RichSubtitleItem {
  const cloned: RichSubtitleItem = {
    from: item.from,
    to: item.to,
    content: item.content
  };
  if (Array.isArray(item.words) && item.words.length > 0) {
    cloned.words = item.words.map((w) => ({ ...w }));
  }
  return cloned;
}

function countNormChars(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    if (!STRIP_NORM_RE.test(ch)) {
      count += ch.toLowerCase().length;
    }
    i += ch.length;
  }
  return count;
}

function takeRawPrefixByNormCount(text: string, keepNorm: number): string {
  if (keepNorm <= 0) return "";
  let count = 0;
  let endIdx = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (!STRIP_NORM_RE.test(ch)) {
      const len = ch.toLowerCase().length;
      if (count + len > keepNorm) break;
      count += len;
    }
    endIdx = next;
    i = next;
    if (count >= keepNorm) break;
  }
  const closingMatch = text.slice(endIdx).match(/^[。！？.!?…]["'”’」』）\)\]]*/);
  if (closingMatch) {
    endIdx += closingMatch[0].length;
  }
  return text.slice(0, endIdx).replace(TRAILING_DANGLING_PUNCT_RE, "").trim();
}

function dropRawPrefixByNormCount(text: string, dropNorm: number): string {
  if (dropNorm <= 0) return text;
  let count = 0;
  let i = 0;
  while (i < text.length && count < dropNorm) {
    const cp = text.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (!STRIP_NORM_RE.test(ch)) {
      count += ch.toLowerCase().length;
    }
    i = next;
  }
  return text.slice(i).replace(LEADING_TRIM_PUNCT_RE, "").trim();
}

function trimWordsKeepPrefix(
  words: SynthesizedWord[] | undefined,
  keepNormChars: number
): SynthesizedWord[] | undefined {
  if (!Array.isArray(words) || words.length === 0 || keepNormChars <= 0) {
    return undefined;
  }
  const kept: SynthesizedWord[] = [];
  let remaining = keepNormChars;
  for (const w of words) {
    if (remaining <= 0) break;
    const n = countNormChars(w.word);
    if (n <= remaining) {
      kept.push({ ...w });
      remaining -= n;
    } else {
      const sliced = takeRawPrefixByNormCount(w.word, remaining);
      if (sliced) {
        kept.push({ ...w, word: sliced });
      }
      remaining = 0;
    }
  }
  return kept.length > 0 ? kept : undefined;
}

function trimWordsDropPrefix(
  words: SynthesizedWord[] | undefined,
  dropNormChars: number
): SynthesizedWord[] | undefined {
  if (!Array.isArray(words) || words.length === 0) {
    return undefined;
  }
  if (dropNormChars <= 0) {
    return words.map((w) => ({ ...w }));
  }
  const kept: SynthesizedWord[] = [];
  let remainingToDrop = dropNormChars;
  for (const w of words) {
    if (remainingToDrop <= 0) {
      kept.push({ ...w });
      continue;
    }
    const n = countNormChars(w.word);
    if (n <= remainingToDrop) {
      remainingToDrop -= n;
    } else {
      const sliced = dropRawPrefixByNormCount(w.word, remainingToDrop);
      remainingToDrop = 0;
      if (sliced) {
        kept.push({ ...w, word: sliced });
      }
    }
  }
  return kept.length > 0 ? kept : undefined;
}

interface NormCharRef {
  itemIdx: number;
  rawIdx: number;
  rawEndIdx: number;
}

interface NormalizedStream {
  norm: string;
  refs: NormCharRef[];
}

function buildNormalizedStream(items: RichSubtitleItem[]): NormalizedStream {
  let norm = "";
  const refs: NormCharRef[] = [];
  for (let itemIdx = 0; itemIdx < items.length; itemIdx += 1) {
    const content = items[itemIdx].content;
    for (let rawIdx = 0; rawIdx < content.length; ) {
      const cp = content.codePointAt(rawIdx)!;
      const rawCh = String.fromCodePoint(cp);
      const nextRawIdx = rawIdx + rawCh.length;
      if (!STRIP_NORM_RE.test(rawCh)) {
        const lower = rawCh.toLowerCase();
        for (let k = 0; k < lower.length; k += 1) {
          norm += lower[k];
          refs.push({ itemIdx, rawIdx, rawEndIdx: nextRawIdx });
        }
      }
      rawIdx = nextRawIdx;
    }
  }
  return { norm, refs };
}

function isSameRawToken(refs: NormCharRef[], leftIdx: number, rightIdx: number): boolean {
  return (
    refs[leftIdx].itemIdx === refs[rightIdx].itemIdx &&
    refs[leftIdx].rawEndIdx === refs[rightIdx].rawIdx
  );
}

interface OverlapMatchResult {
  tStart: number;
  tEnd: number;
  tTailSlack: number;
  hStart: number;
  hEnd: number;
  hHeadSlack: number;
}

function alignMatchToWordBoundaries(
  tNorm: string,
  tRefs: NormCharRef[],
  hNorm: string,
  hRefs: NormCharRef[],
  rawStartT: number,
  rawStartH: number,
  rawLen: number
): { startT: number; startH: number; len: number } {
  let startT = rawStartT;
  let startH = rawStartH;
  let endT = rawStartT + rawLen;
  let endH = rawStartH + rawLen;

  while (startT < endT && startH < endH) {
    const leftInsideT =
      startT > 0 &&
      ASCII_WORD_CHAR_RE.test(tNorm[startT]) &&
      ASCII_WORD_CHAR_RE.test(tNorm[startT - 1]) &&
      isSameRawToken(tRefs, startT - 1, startT);
    const leftInsideH =
      startH > 0 &&
      ASCII_WORD_CHAR_RE.test(hNorm[startH]) &&
      ASCII_WORD_CHAR_RE.test(hNorm[startH - 1]) &&
      isSameRawToken(hRefs, startH - 1, startH);
    if (!leftInsideT && !leftInsideH) break;
    startT += 1;
    startH += 1;
  }

  while (endT > startT && endH > startH) {
    const rightInsideT =
      endT < tNorm.length &&
      ASCII_WORD_CHAR_RE.test(tNorm[endT - 1]) &&
      ASCII_WORD_CHAR_RE.test(tNorm[endT]) &&
      isSameRawToken(tRefs, endT - 1, endT);
    const rightInsideH =
      endH < hNorm.length &&
      ASCII_WORD_CHAR_RE.test(hNorm[endH - 1]) &&
      ASCII_WORD_CHAR_RE.test(hNorm[endH]) &&
      isSameRawToken(hRefs, endH - 1, endH);
    if (!rightInsideT && !rightInsideH) break;
    endT -= 1;
    endH -= 1;
  }

  return { startT, startH, len: Math.min(endT - startT, endH - startH) };
}

function findBestOverlapMatch(
  tailSlice: RichSubtitleItem[],
  headSlice: RichSubtitleItem[]
): OverlapMatchResult | null {
  const tStream = buildNormalizedStream(tailSlice);
  const hStream = buildNormalizedStream(headSlice);
  if (!tStream.norm || !hStream.norm) {
    return null;
  }

  const tBase = Math.max(0, tStream.norm.length - MAX_NORM_OVERLAP_CHARS);
  const hLimit = Math.min(hStream.norm.length, MAX_NORM_OVERLAP_CHARS);
  const tNorm = tStream.norm.slice(tBase);
  const tRefs = tStream.refs.slice(tBase);
  const hNorm = hStream.norm.slice(0, hLimit);
  const hRefs = hStream.refs.slice(0, hLimit);

  const tLen = tNorm.length;
  const hLen = hNorm.length;
  let prevRow = new Int32Array(hLen + 1);
  let currRow = new Int32Array(hLen + 1);

  let bestScore = -1;
  let bestSlack = Infinity;
  let bestEndT = -1;
  let bestResult: OverlapMatchResult | null = null;

  for (let i = 1; i <= tLen; i += 1) {
    currRow.fill(0);
    const tc = tNorm[i - 1];
    for (let j = 1; j <= hLen; j += 1) {
      if (tc !== hNorm[j - 1]) {
        continue;
      }
      const rawLen = prevRow[j - 1] + 1;
      currRow[j] = rawLen;

      const rawStartT = i - rawLen;
      const rawStartH = j - rawLen;
      if (tLen - i > 3 || rawStartH > 3) {
        continue;
      }

      const aligned = alignMatchToWordBoundaries(tNorm, tRefs, hNorm, hRefs, rawStartT, rawStartH, rawLen);
      if (aligned.len <= 0) {
        continue;
      }
      const { startT, startH, len } = aligned;
      const tTailSlack = tLen - (startT + len);
      const hHeadSlack = startH;
      if (tTailSlack > 3 || hHeadSlack > 3) {
        continue;
      }

      const prevFrom = tailSlice[tRefs[startT].itemIdx].from;
      const prevTo = tailSlice[tRefs[startT + len - 1].itemIdx].to;
      const nextFrom = headSlice[hRefs[startH].itemIdx].from;
      const nextTo = headSlice[hRefs[startH + len - 1].itemIdx].to;
      const timeOverlap = Math.min(prevTo, nextTo) - Math.max(prevFrom, nextFrom);
      if (timeOverlap <= -0.25) {
        continue;
      }

      const matchedStr = tNorm.slice(startT, startT + len);
      const hasNoSpace = NO_SPACE_CHAR_RE.test(matchedStr);
      const exactEdge = tTailSlack === 0 && hHeadSlack === 0;
      if (exactEdge) {
        if (hasNoSpace) {
          if (len < 1 || (len === 1 && timeOverlap < 0.1)) continue;
        } else if (len < 2) {
          continue;
        }
      } else {
        const minLen = hasNoSpace ? 3 : 5;
        if (len < minLen || len <= tTailSlack + hHeadSlack) {
          continue;
        }
      }

      const slack = tTailSlack + hHeadSlack;
      const score = len * 10 - slack;
      const endT = startT + len;
      if (
        score > bestScore ||
        (score === bestScore && (slack < bestSlack || (slack === bestSlack && endT > bestEndT)))
      ) {
        bestScore = score;
        bestSlack = slack;
        bestEndT = endT;
        bestResult = {
          tStart: tBase + startT,
          tEnd: tBase + endT,
          tTailSlack,
          hStart: startH,
          hEnd: startH + len,
          hHeadSlack
        };
      }
    }
    const tmp = prevRow;
    prevRow = currRow;
    currRow = tmp;
  }

  return bestResult;
}

function deduplicateOverlapBetweenChunks(
  prevRecord: AsrChunkRecord,
  prevItems: RichSubtitleItem[],
  nextRecord: AsrChunkRecord,
  nextItems: RichSubtitleItem[]
): {
  prevItems: RichSubtitleItem[];
  nextItems: RichSubtitleItem[];
  seamSec?: number;
} {
  if (prevItems.length === 0 || nextItems.length === 0) {
    return { prevItems, nextItems };
  }

  const prevEnd = (Number(prevRecord.startSec) || 0) + (Number(prevRecord.durationSec) || 0);
  const nextStart = Number(nextRecord.startSec) || 0;
  let tailStartIdx = prevItems.findIndex((item) => item.to > prevEnd - OVERLAP_WINDOW_SEC);
  if (tailStartIdx < 0) {
    tailStartIdx = prevItems.length;
  }
  let headEndIdx = 0;
  while (headEndIdx < nextItems.length && nextItems[headEndIdx].from < nextStart + OVERLAP_WINDOW_SEC) {
    headEndIdx += 1;
  }

  let outPrev = prevItems.map(cloneRichItem);
  let outNext = nextItems.map(cloneRichItem);
  let textDedupApplied = false;
  let nFirstTrimmed = false;
  let droppedHeadMaxTo = -Infinity;

  if (tailStartIdx < outPrev.length && headEndIdx > 0) {
    const tailSlice = outPrev.slice(tailStartIdx);
    const headSlice = outNext.slice(0, headEndIdx);
    const match = findBestOverlapMatch(tailSlice, headSlice);

    if (match) {
      textDedupApplied = true;
      const tStream = buildNormalizedStream(tailSlice);
      const hStream = buildNormalizedStream(headSlice);

      if (match.tTailSlack > 0 && match.tEnd > 0) {
        const lastRef = tStream.refs[match.tEnd - 1];
        const keepCount = tailStartIdx + lastRef.itemIdx + 1;
        outPrev = outPrev.slice(0, keepCount);
        const keptTail = outPrev[keepCount - 1];
        let keepNormInLast = 0;
        for (let idx = match.tEnd - 1; idx >= 0 && tStream.refs[idx].itemIdx === lastRef.itemIdx; idx -= 1) {
          keepNormInLast += 1;
        }
        const nextDroppedRef = match.tEnd < tStream.refs.length ? tStream.refs[match.tEnd] : undefined;
        const cutLimit =
          nextDroppedRef && nextDroppedRef.itemIdx === lastRef.itemIdx
            ? nextDroppedRef.rawIdx
            : keptTail.content.length;
        const closingPunct = keptTail.content
          .slice(lastRef.rawEndIdx, cutLimit)
          .match(/^[。！？.!?…]["'”’」』）\)\]]*/);
        const sliceEnd = lastRef.rawEndIdx + (closingPunct ? closingPunct[0].length : 0);
        keptTail.content = keptTail.content
          .slice(0, sliceEnd)
          .replace(TRAILING_DANGLING_PUNCT_RE, "")
          .trim();
        if (keptTail.words) {
          const trimmedWords = trimWordsKeepPrefix(keptTail.words, keepNormInLast);
          if (trimmedWords) {
            keptTail.words = trimmedWords;
          } else {
            delete keptTail.words;
          }
        }
        if (!keptTail.content) {
          outPrev.pop();
        }
      }

      if (match.hEnd >= hStream.norm.length) {
        for (let i = 0; i < headEndIdx; i += 1) {
          if (outNext[i].to > droppedHeadMaxTo) {
            droppedHeadMaxTo = outNext[i].to;
          }
        }
        outNext = outNext.slice(headEndIdx);
      } else {
        const firstRef = hStream.refs[match.hEnd];
        const firstKeptHeadIdx = firstRef.itemIdx;
        for (let i = 0; i < firstKeptHeadIdx; i += 1) {
          if (outNext[i].to > droppedHeadMaxTo) {
            droppedHeadMaxTo = outNext[i].to;
          }
        }
        let dropNormInFirst = 0;
        for (let idx = match.hEnd - 1; idx >= 0 && hStream.refs[idx].itemIdx === firstKeptHeadIdx; idx -= 1) {
          dropNormInFirst += 1;
        }
        const target = outNext[firstKeptHeadIdx];
        const trimmedContent = target.content
          .slice(firstRef.rawIdx)
          .replace(LEADING_TRIM_PUNCT_RE, "")
          .trim();
        if (trimmedContent) {
          target.content = trimmedContent;
          if (target.words) {
            const trimmedWords = trimWordsDropPrefix(target.words, dropNormInFirst);
            if (trimmedWords) {
              target.words = trimmedWords;
            } else {
              delete target.words;
            }
          }
          nFirstTrimmed = firstRef.rawIdx > 0;
          outNext = outNext.slice(firstKeptHeadIdx);
        } else {
          if (target.to > droppedHeadMaxTo) {
            droppedHeadMaxTo = target.to;
          }
          outNext = outNext.slice(firstKeptHeadIdx + 1);
        }
      }
    }
  }

  let seamSec: number | undefined;
  const pLast = outPrev[outPrev.length - 1];
  const nFirst = outNext[0];
  if (pLast && nFirst) {
    const needMidpointSmooth =
      pLast.to > nFirst.from ||
      (textDedupApplied && (nFirstTrimmed || droppedHeadMaxTo === -Infinity));
    if (needMidpointSmooth) {
      const rawMid = (Math.max(pLast.from, nFirst.from) + Math.min(pLast.to, nFirst.to)) / 2;
      const mid = Math.min(Math.max(pLast.from, nFirst.to), Math.max(pLast.from, rawMid));
      pLast.to = mid;
      if (pLast.words?.length) {
        pLast.words = pLast.words.map((w) => {
          const start = Math.min(w.start, mid);
          const end = Math.max(start, Math.min(w.end, mid));
          return { ...w, start, end };
        });
      }
      nFirst.from = mid;
      nFirst.to = Math.max(nFirst.from, nFirst.to);
      if (nFirst.words?.length) {
        nFirst.words = nFirst.words.map((w) => {
          const start = Math.max(w.start, mid);
          const end = Math.max(start, w.end);
          return { ...w, start, end };
        });
      }
      seamSec = mid;
    } else if (droppedHeadMaxTo > -Infinity) {
      pLast.to = Math.min(Math.max(pLast.to, droppedHeadMaxTo), nFirst.from);
      seamSec = Math.max(pLast.to, prevEnd);
    }
  } else if (pLast && droppedHeadMaxTo > -Infinity) {
    pLast.to = Math.max(pLast.to, droppedHeadMaxTo);
  }

  return { prevItems: outPrev, nextItems: outNext, seamSec };
}

function findLastNonSpeechExcludedIdx(items: RichSubtitleItem[]): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (!isNonSpeechSegment(items[i].content)) {
      return i;
    }
  }
  return -1;
}

function findFirstNonSpeechExcludedIdx(items: RichSubtitleItem[]): number {
  for (let i = 0; i < items.length; i += 1) {
    if (!isNonSpeechSegment(items[i].content)) {
      return i;
    }
  }
  return -1;
}

function stitchUnclosedTrailingSentence(
  prevRecord: AsrChunkRecord,
  prevItems: RichSubtitleItem[],
  nextRecord: AsrChunkRecord,
  nextItems: RichSubtitleItem[],
  seamSec?: number
): { prevItems: RichSubtitleItem[]; nextItems: RichSubtitleItem[] } {
  if (prevItems.length === 0 || nextItems.length === 0) {
    return { prevItems, nextItems };
  }

  const lastNonSfxIdx = findLastNonSpeechExcludedIdx(prevItems);
  const firstNonSfxIdx = findFirstNonSpeechExcludedIdx(nextItems);
  if (lastNonSfxIdx < 0 || firstNonSfxIdx < 0) {
    return { prevItems, nextItems };
  }

  const prevItem = prevItems[lastNonSfxIdx];
  const nextItem = nextItems[firstNonSfxIdx];
  if (SENTENCE_END_PUNCT_RE.test(prevItem.content.trim())) {
    return { prevItems, nextItems };
  }

  const prevEnd = (Number(prevRecord.startSec) || 0) + (Number(prevRecord.durationSec) || 0);
  const nextStart = Number(nextRecord.startSec) || 0;
  const nextEnd = nextStart + (Number(nextRecord.durationSec) || 0);
  const overlapLead = Math.max(0, Number(nextRecord.overlapLeadSec) || 0);

  let prevBoundaryGap: number;
  let nextBoundaryGap: number;
  if (overlapLead > 0) {
    if (nextStart > prevEnd + 0.5 || nextEnd < prevEnd - 0.5) {
      return { prevItems, nextItems };
    }
    if (seamSec !== undefined) {
      prevBoundaryGap = Math.abs(seamSec - prevItem.to);
      nextBoundaryGap = Math.abs(nextItem.from - seamSec);
    } else {
      prevBoundaryGap = prevEnd - prevItem.to;
      nextBoundaryGap = Math.min(
        Math.abs(nextItem.from - nextStart),
        Math.abs(nextItem.from - prevItem.to),
        Math.abs(nextItem.from - prevEnd)
      );
    }
  } else {
    if (Math.abs(nextStart - prevEnd) >= 0.5) {
      return { prevItems, nextItems };
    }
    prevBoundaryGap = prevEnd - prevItem.to;
    nextBoundaryGap = nextItem.from - nextStart;
  }

  if (prevBoundaryGap >= STITCH_BOUNDARY_GAP_SEC || nextBoundaryGap >= STITCH_BOUNDARY_GAP_SEC) {
    return { prevItems, nextItems };
  }

  const stitchedTo = Math.max(prevItem.to, nextItem.to);
  if (stitchedTo - prevItem.from > STITCH_MAX_DURATION_SEC) {
    return { prevItems, nextItems };
  }

  const stitchedItem: RichSubtitleItem = {
    from: prevItem.from,
    to: stitchedTo,
    content: joinSubtitleText(prevItem.content, nextItem.content)
  };
  if (prevItem.words?.length && nextItem.words?.length) {
    stitchedItem.words = [
      ...prevItem.words.map((w) => ({ ...w })),
      ...nextItem.words.map((w) => ({ ...w }))
    ];
  }
  return {
    prevItems: [...prevItems.slice(0, lastNonSfxIdx), stitchedItem],
    nextItems: nextItems.slice(firstNonSfxIdx + 1)
  };
}

export interface AsrProgressiveMergeSnapshot {
  mergedItems: RichSubtitleItem[];
  chunkItems: Map<number, RichSubtitleItem[]>;
  updatedChunkIndices: number[];
}

function wordsEqual(a: SynthesizedWord[] | undefined, b: SynthesizedWord[] | undefined): boolean {
  const lenA = a?.length ?? 0;
  const lenB = b?.length ?? 0;
  if (lenA !== lenB) return false;
  for (let i = 0; i < lenA; i += 1) {
    if (a![i].word !== b![i].word || a![i].start !== b![i].start || a![i].end !== b![i].end) {
      return false;
    }
  }
  return true;
}

function itemsEqual(a: RichSubtitleItem[] | undefined, b: RichSubtitleItem[]): boolean {
  if (!a || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (
      a[i].from !== b[i].from ||
      a[i].to !== b[i].to ||
      a[i].content !== b[i].content ||
      !wordsEqual(a[i].words, b[i].words)
    ) {
      return false;
    }
  }
  return true;
}

function assembleOrderedChunks(records: AsrChunkRecord[]): {
  mergedItems: RichSubtitleItem[];
  chunkItems: Map<number, RichSubtitleItem[]>;
} {
  const ordered = records
    .filter((record): record is AsrChunkRecord => Boolean(record && record.result))
    .slice()
    .sort((a, b) => (Number(a.index) || 0) - (Number(b.index) || 0));

  const chunkItems = new Map<number, RichSubtitleItem[]>();
  const synthesized: RichSubtitleItem[][] = ordered.map((record) =>
    synthesizeChunk({
      startSec: record.startSec,
      durationSec: record.durationSec,
      result: record.result
    })
  );

  for (let i = 0; i + 1 < ordered.length; i += 1) {
    const prevRecord = ordered[i];
    const nextRecord = ordered[i + 1];
    if ((Number(nextRecord.index) || 0) !== (Number(prevRecord.index) || 0) + 1) {
      continue;
    }

    let prevList = synthesized[i];
    let nextList = synthesized[i + 1];
    let seamSec: number | undefined;

    if ((Number(nextRecord.overlapLeadSec) || 0) > 0) {
      const deduped = deduplicateOverlapBetweenChunks(prevRecord, prevList, nextRecord, nextList);
      prevList = deduped.prevItems;
      nextList = deduped.nextItems;
      seamSec = deduped.seamSec;
    }

    const stitched = stitchUnclosedTrailingSentence(prevRecord, prevList, nextRecord, nextList, seamSec);
    synthesized[i] = stitched.prevItems;
    synthesized[i + 1] = stitched.nextItems;
  }

  const mergedItems: RichSubtitleItem[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    const chunkIndex = Number(ordered[i].index) || 0;
    const list = synthesized[i];
    for (const item of list) {
      if (mergedItems.length > 0 && item.from < mergedItems[mergedItems.length - 1].to) {
        const clampedFrom = mergedItems[mergedItems.length - 1].to;
        item.from = clampedFrom;
        item.to = Math.max(clampedFrom, item.to);
        if (item.words?.length) {
          item.words = item.words.map((w) => {
            const start = Math.max(w.start, clampedFrom);
            const end = Math.max(start, w.end);
            return { ...w, start, end };
          });
        }
      }
      mergedItems.push(item);
    }
    chunkItems.set(chunkIndex, list);
  }

  return { mergedItems, chunkItems };
}

export function createProgressiveChunkMerger(): {
  push(record: AsrChunkRecord): AsrProgressiveMergeSnapshot;
  getSnapshot(): AsrProgressiveMergeSnapshot;
} {
  const received = new Map<number, AsrChunkRecord>();
  let prevChunkItems = new Map<number, RichSubtitleItem[]>();
  let latestMerged: RichSubtitleItem[] = [];

  function recompute(forceIncludeIndex?: number): AsrProgressiveMergeSnapshot {
    const { mergedItems, chunkItems } = assembleOrderedChunks(Array.from(received.values()));
    const updatedSet = new Set<number>();
    if (forceIncludeIndex !== undefined) {
      updatedSet.add(forceIncludeIndex);
    }
    for (const [idx, items] of chunkItems.entries()) {
      if (
        !prevChunkItems.has(idx) ||
        !itemsEqual(prevChunkItems.get(idx), items)
      ) {
        updatedSet.add(idx);
      }
    }
    prevChunkItems = chunkItems;
    latestMerged = mergedItems;
    return {
      mergedItems,
      chunkItems,
      updatedChunkIndices: Array.from(updatedSet).sort((a, b) => a - b)
    };
  }

  return {
    push(record: AsrChunkRecord): AsrProgressiveMergeSnapshot {
      const idx = Number(record.index) || 0;
      received.set(idx, record);
      return recompute(idx);
    },
    getSnapshot(): AsrProgressiveMergeSnapshot {
      return {
        mergedItems: latestMerged,
        chunkItems: prevChunkItems,
        updatedChunkIndices: []
      };
    }
  };
}

export function mergeChunkResults(chunkResults: AsrChunkRecord[]): RichSubtitleItem[] {
  return assembleOrderedChunks(chunkResults).mergedItems;
}

export type { AsrAttemptOutcome };

export interface RunAsrPipelineArgs {
  bvid: string;
  cid: string;
  onProgress?: (message: string) => void;
  site?: SiteId;
  trigger?: AsrTriggerMode;
  streamSource?: AudioStreamSource;
  chunkHost?: OffscreenChunkHost;
  sourceTransport?: JsonTransport;
  onEmptyDiagnostic?: (diagText: string) => void;
  onAttemptOutcome?: (outcome: AsrAttemptOutcome) => void;
  onChunkResult?: (
    record: AsrChunkRecord,
    items: RichSubtitleItem[],
    snapshot?: AsrProgressiveMergeSnapshot
  ) => void;
  signal?: AbortSignal | null;
}

export async function runAsrPipeline({
  bvid,
  cid,
  site,
  trigger,
  streamSource,
  onProgress,
  chunkHost,
  sourceTransport,
  onEmptyDiagnostic,
  onAttemptOutcome,
  onChunkResult,
  signal
}: RunAsrPipelineArgs): Promise<RichSubtitleItem[]> {
  const host = chunkHost || createOffscreenChunkHost();
  const startedAt = Date.now();
  const isYoutube = site === "youtube";

  const progressiveMerger = createProgressiveChunkMerger();
  const handleChunkResult = (record: AsrChunkRecord) => {
    if (onChunkResult) {
      const snapshot = progressiveMerger.push(record);
      const items = snapshot.chunkItems.get(Number(record.index) || 0) ?? [];
      try {
        onChunkResult(record, items, snapshot);
      } catch (error) {
        logWarn("[BILISCRIPT] asr onChunkResult callback failed", {
          chunkIndex: record.index,
          error
        });
      }
    }
  };

  let hostResult;
  if (isYoutube || typeof streamSource === "function") {
    if (typeof streamSource !== "function") {
      throw new Error("YouTube 语音转写需要页内音频流采集源");
    }
    onProgress?.("无字幕轨，正在采集音频流…");
    hostResult = await host({
      streamSource,
      trigger,
      onProgress,
      signal,
      onChunkResult: handleChunkResult
    });
  } else {
    onProgress?.("无字幕轨，正在获取音频流…");
    const source = await getSourceAudioUrl({ bvid, cid }, sourceTransport);

    onProgress?.("音频下载与解码中…");
    hostResult = await host({
      audioUrl: source.url,
      backupUrls: source.backupUrls || [],
      trigger,
      onProgress,
      signal,
      onChunkResult: handleChunkResult
    });
  }
  const { results, totalChunks, skippedSegments, failedChunks } = hostResult;

  const merged = mergeChunkResults(results);
  if (merged.length === 0 && typeof onEmptyDiagnostic === "function") {
    const diagnostics = results
      .map((r) => r?.result?._asrDiag)
      .filter(Boolean)
      .slice(0, 1);
    const plannedChunks = Number(totalChunks) > 0 ? Number(totalChunks) : results.length;
    let diagText =
      `分片 ${plannedChunks} 片、各片文本长度[${results.map((r) => String(r?.result?.text || "").length).join(",")}]`;
    if (diagnostics[0]) {
      diagText += `；事件诊断 ${JSON.stringify(diagnostics[0])}`;
    }
    const failureParts: string[] = [];
    if (Number(failedChunks) > 0) {
      failureParts.push(`${Number(failedChunks)} 片转写失败`);
    }
    if (Number(skippedSegments) > 0) {
      failureParts.push(`${Number(skippedSegments)} 段解码失败已跳过`);
    }
    if (failureParts.length > 0) {
      diagText += `；${failureParts.join("、")}`;
    }
    try {
      onEmptyDiagnostic(diagText.slice(0, 400));
    } catch {
    }
  }
  if (typeof onAttemptOutcome === "function") {
    onAttemptOutcome({
      totalChunks: Number(totalChunks) > 0 ? Number(totalChunks) : results.length,
      failedChunks: Number(failedChunks) || 0,
      elapsedMs: Date.now() - startedAt,
      ...projectAsrFailureSummary(readAsrFailureSummary(hostResult))
    });
  }
  return merged;
}
