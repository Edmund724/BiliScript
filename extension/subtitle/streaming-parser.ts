import type { SubtitleBodyItem } from "../ai/types.js";
import {
  joinEventsSliceText,
  parseGroupIdRange,
  parseSingleEventId,
  stripTrailingCommasOutsideStrings
} from "./boundary-protocol.js";
import type { AtomicSubtitleEvent } from "./segmentation.js";

export interface StreamingSubtitleCue {
  startIndex: number;
  endIndex: number;
  from: number;
  to: number;
  text: string;
  translation: string;
}

export interface CreateStreamingSubtitleParserOptions {
  events?: readonly AtomicSubtitleEvent[];
  items?: readonly SubtitleBodyItem[];
  sourceLang?: string;
  mode?: "auto" | "boundary-v3" | "cc-json";
  initialExpectedIndex?: number;
  indexOffset?: number;
  emittedKeys?: Set<string>;
  onCueReady?: (cue: StreamingSubtitleCue) => void;
}

export interface StreamingSubtitleParser {
  feed(chunk: string | Uint8Array): StreamingSubtitleCue[];
  push(chunk: string | Uint8Array): StreamingSubtitleCue[];
  resetStreamAttempt(): void;
  reset(): void;
  getCues(): StreamingSubtitleCue[];
  getBuffer(): string;
}

const WRAPPER_ARRAY_KEYS = new Set(["groups", "translations", "items"]);

function parseJsonStringToken(rawToken: string): string | null {
  if (!rawToken.includes("\\")) {
    return rawToken.slice(1, -1);
  }
  try {
    const parsed = JSON.parse(rawToken);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function isWhitespaceChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

export function createStreamingSubtitleParser(
  options: CreateStreamingSubtitleParserOptions = {}
): StreamingSubtitleParser {
  const {
    events,
    items,
    sourceLang,
    initialExpectedIndex = 0,
    indexOffset = 0,
    onCueReady
  } = options;

  const hasEvents = Array.isArray(events) && events.length > 0;
  const hasItems = !hasEvents && Array.isArray(items) && items.length > 0;
  const maxItemCount = hasEvents ? events!.length : hasItems ? items!.length : undefined;
  const emittedKeys = options.emittedKeys ?? new Set<string>();

  let decoder = new TextDecoder("utf-8");
  let buffer = "";
  let scanIndex = 0;
  let inString = false;
  let escaped = false;
  let stringStart = -1;
  let rootBraceDepth = 0;
  let nonTargetBracketDepth = 0;
  let pendingTopArrayConfirm = false;
  let awaitingColonForArrayKey = false;
  let awaitingBracketForArrayKey = false;
  let justSawColonAtRoot1 = false;
  let targetArrayFound = false;
  let targetArrayBracketDepth = 0;
  let targetArrayClosed = false;
  let elementBraceDepth = 0;
  let currentObjectStart = -1;
  let expectedNextIndex = initialExpectedIndex;
  let halted = false;
  let cues: StreamingSubtitleCue[] = [];

  function resetScannerState(): void {
    decoder = new TextDecoder("utf-8");
    buffer = "";
    scanIndex = 0;
    inString = false;
    escaped = false;
    stringStart = -1;
    rootBraceDepth = 0;
    nonTargetBracketDepth = 0;
    pendingTopArrayConfirm = false;
    awaitingColonForArrayKey = false;
    awaitingBracketForArrayKey = false;
    justSawColonAtRoot1 = false;
    targetArrayFound = false;
    targetArrayBracketDepth = 0;
    targetArrayClosed = false;
    elementBraceDepth = 0;
    currentObjectStart = -1;
    expectedNextIndex = initialExpectedIndex;
    halted = false;
    cues = [];
  }

  function buildCueFromObject(rawObject: string): StreamingSubtitleCue | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripTrailingCommasOutsideStrings(rawObject));
    } catch {
      halted = true;
      return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      halted = true;
      return null;
    }

    const obj = parsed as {
      ids?: unknown;
      id?: unknown;
      text?: unknown;
      translation?: unknown;
      from?: unknown;
      to?: unknown;
    };

    let range: { startIndex: number; endIndex: number } | null = null;
    if (obj.ids !== undefined) {
      range = parseGroupIdRange(obj.ids);
    } else if (obj.id !== undefined) {
      const singleId = parseSingleEventId(obj.id);
      if (singleId !== null) {
        range = { startIndex: singleId, endIndex: singleId };
      }
    }

    if (!range) {
      halted = true;
      return null;
    }

    const { startIndex, endIndex } = range;
    if (
      !Number.isInteger(startIndex) ||
      !Number.isInteger(endIndex) ||
      startIndex !== expectedNextIndex ||
      endIndex < startIndex ||
      (maxItemCount !== undefined && endIndex >= maxItemCount)
    ) {
      halted = true;
      return null;
    }

    expectedNextIndex = endIndex + 1;

    const globalStart = startIndex + indexOffset;
    const globalEnd = endIndex + indexOffset;
    const dedupeKey = `${globalStart}:${globalEnd}`;
    if (emittedKeys.has(dedupeKey)) {
      return null;
    }
    emittedKeys.add(dedupeKey);

    let from: number;
    let to: number;
    let text: string;
    const rawText = String(obj.text ?? "").trim();

    if (hasEvents) {
      const slice = events!.slice(startIndex, endIndex + 1);
      from = events![startIndex].startMs / 1000;
      to = events![endIndex].endMs / 1000;
      text = joinEventsSliceText(slice, sourceLang) || rawText;
    } else if (hasItems) {
      from = Number(items![startIndex]?.from) || 0;
      to = Number(items![endIndex]?.to) || 0;
      text = String(items![startIndex]?.content ?? rawText).trim();
    } else {
      from = Number(obj.from) || 0;
      to = Number(obj.to) || 0;
      text = rawText;
    }

    const explicitTranslation = String(obj.translation ?? "").trim();
    const fallbackTranslation =
      !explicitTranslation && obj.translation === undefined
        ? String(obj.text ?? "").trim()
        : "";

    const cue: StreamingSubtitleCue = {
      startIndex: globalStart,
      endIndex: globalEnd,
      from,
      to,
      text,
      translation: explicitTranslation || fallbackTranslation
    };

    cues.push(cue);
    onCueReady?.(cue);
    return cue;
  }

  function scanPendingBuffer(): StreamingSubtitleCue[] {
    const newlyEmitted: StreamingSubtitleCue[] = [];

    for (; scanIndex < buffer.length; scanIndex += 1) {
      if (halted || targetArrayClosed) {
        scanIndex = buffer.length;
        break;
      }

      const ch = buffer[scanIndex];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
          if (
            !targetArrayFound &&
            rootBraceDepth === 1 &&
            nonTargetBracketDepth === 0 &&
            !justSawColonAtRoot1 &&
            stringStart >= 0
          ) {
            const keyName = parseJsonStringToken(buffer.slice(stringStart, scanIndex + 1));
            if (keyName !== null && WRAPPER_ARRAY_KEYS.has(keyName)) {
              awaitingColonForArrayKey = true;
            }
          }
          stringStart = -1;
        }
        continue;
      }

      if (pendingTopArrayConfirm) {
        if (isWhitespaceChar(ch)) {
          continue;
        }
        pendingTopArrayConfirm = false;
        if (ch === "{") {
          targetArrayFound = true;
          targetArrayBracketDepth = 1;
          elementBraceDepth = 1;
          currentObjectStart = scanIndex;
          continue;
        }
        if (ch === "]") {
          continue;
        }
      }

      if (awaitingColonForArrayKey) {
        if (isWhitespaceChar(ch)) {
          continue;
        }
        awaitingColonForArrayKey = false;
        if (ch === ":") {
          awaitingBracketForArrayKey = true;
          continue;
        }
      }

      if (awaitingBracketForArrayKey) {
        if (isWhitespaceChar(ch)) {
          continue;
        }
        awaitingBracketForArrayKey = false;
        if (ch === "[") {
          targetArrayFound = true;
          targetArrayBracketDepth = 1;
          elementBraceDepth = 0;
          currentObjectStart = -1;
          continue;
        }
      }

      if (ch === '"') {
        inString = true;
        escaped = false;
        stringStart = scanIndex;
        continue;
      }

      if (!targetArrayFound) {
        if (ch === "{") {
          rootBraceDepth += 1;
          justSawColonAtRoot1 = false;
        } else if (ch === "}") {
          if (rootBraceDepth > 0) {
            rootBraceDepth -= 1;
          }
          justSawColonAtRoot1 = false;
        } else if (ch === "[") {
          if (rootBraceDepth === 0 && nonTargetBracketDepth === 0) {
            pendingTopArrayConfirm = true;
          } else {
            nonTargetBracketDepth += 1;
          }
          justSawColonAtRoot1 = false;
        } else if (ch === "]") {
          if (nonTargetBracketDepth > 0) {
            nonTargetBracketDepth -= 1;
          }
          justSawColonAtRoot1 = false;
        } else if (rootBraceDepth === 1 && nonTargetBracketDepth === 0) {
          if (ch === ":") {
            justSawColonAtRoot1 = true;
          } else if (ch === ",") {
            justSawColonAtRoot1 = false;
          }
        }
        continue;
      }

      if (ch === "{") {
        if (elementBraceDepth === 0) {
          currentObjectStart = scanIndex;
        }
        elementBraceDepth += 1;
      } else if (ch === "}") {
        if (elementBraceDepth > 0) {
          elementBraceDepth -= 1;
          if (elementBraceDepth === 0 && targetArrayBracketDepth === 1 && currentObjectStart >= 0) {
            const rawObject = buffer.slice(currentObjectStart, scanIndex + 1);
            currentObjectStart = -1;
            const emitted = buildCueFromObject(rawObject);
            if (emitted) {
              newlyEmitted.push(emitted);
            }
          }
        }
      } else if (ch === "[") {
        targetArrayBracketDepth += 1;
      } else if (ch === "]") {
        targetArrayBracketDepth -= 1;
        if (targetArrayBracketDepth <= 0) {
          targetArrayClosed = true;
          elementBraceDepth = 0;
          currentObjectStart = -1;
        }
      }
    }

    return newlyEmitted;
  }

  function feed(chunk: string | Uint8Array): StreamingSubtitleCue[] {
    const text =
      typeof chunk === "string"
        ? chunk
        : ArrayBuffer.isView(chunk)
          ? decoder.decode(chunk, { stream: true })
          : "";
    if (!text) {
      return [];
    }
    buffer += text;
    if (halted || targetArrayClosed) {
      scanIndex = buffer.length;
      return [];
    }
    return scanPendingBuffer();
  }

  function resetStreamAttempt(): void {
    resetScannerState();
  }

  function reset(): void {
    emittedKeys.clear();
    resetScannerState();
  }

  return {
    feed,
    push: feed,
    resetStreamAttempt,
    reset,
    getCues: () => cues.slice(),
    getBuffer: () => buffer
  };
}
