import type { SubtitleBodyItem } from "../shared/video-dto.js";

export type { SubtitleBodyItem } from "../shared/video-dto.js";

export type SubtitleBody = SubtitleBodyItem[];

export interface ChatMessage {
  context?: Record<string, unknown>;
  contextKey?: string;
  [key: string]: unknown;
}

export interface SettleOk {
  ok: true;
  contextKey: string;
}

export interface SettleError {
  ok: false;
  error: string;
  code: string;
}

export type SettleResult = SettleOk | SettleError;

export interface SubtitleBodySlotOptions {
  maxEntries?: number;
  maxTotalChars?: number;
  maxTotalBytes?: number;
}

export const DEFAULT_MAX_SUBTITLE_SLOTS = 8;
export const DEFAULT_MAX_SUBTITLE_SLOT_CHARS = 2_000_000;
export const DEFAULT_MAX_SUBTITLE_SLOT_BYTES = 16 * 1024 * 1024;

export const SUBTITLE_ITEM_OVERHEAD_BYTES = 64;

export const SUBTITLE_BODY_MISSING_MESSAGE = "字幕体缺失，请重发一次";
export const SUBTITLE_BODY_MISSING_CODE = "subtitle-body-missing";

interface SlotEntry {
  subtitleBody: SubtitleBody;
  chars: number;
  bytes: number;
}

function measureSubtitleBody(body: unknown): { chars: number; bytes: number } {
  if (!Array.isArray(body)) {
    return { chars: 0, bytes: 0 };
  }
  let chars = 0;
  let bytes = 0;
  for (const item of body) {
    const contentLength = String((item as { content?: unknown } | null)?.content ?? "").length;
    chars += contentLength;
    bytes += SUBTITLE_ITEM_OVERHEAD_BYTES + contentLength * 2;
  }
  return { chars, bytes };
}

export function estimateSubtitleBodyBytes(body: unknown): number {
  return measureSubtitleBody(body).bytes;
}

export function createSubtitleBodySlot(
  options: SubtitleBodySlotOptions = {}
): { settle(msg: ChatMessage): SettleResult } {
  const maxEntries = Math.max(
    1,
    Math.floor(Number(options.maxEntries ?? DEFAULT_MAX_SUBTITLE_SLOTS)) || DEFAULT_MAX_SUBTITLE_SLOTS
  );
  const rawMaxTotalChars = Number(options.maxTotalChars);
  const maxTotalChars = Number.isFinite(rawMaxTotalChars)
    ? Math.max(0, rawMaxTotalChars)
    : DEFAULT_MAX_SUBTITLE_SLOT_CHARS;
  const rawMaxTotalBytes = Number(options.maxTotalBytes);
  const maxTotalBytes = Number.isFinite(rawMaxTotalBytes)
    ? Math.max(0, rawMaxTotalBytes)
    : DEFAULT_MAX_SUBTITLE_SLOT_BYTES;

  const slots = new Map<string, SlotEntry>();
  let totalChars = 0;
  let totalBytes = 0;

  function settle(msg: ChatMessage): SettleResult {
    const context = msg?.context && typeof msg.context === "object" ? msg.context : null;
    if (!context) {
      return { ok: false, error: SUBTITLE_BODY_MISSING_MESSAGE, code: SUBTITLE_BODY_MISSING_CODE };
    }
    const contextKey = String(msg.contextKey || "");

    if (context.subtitleBody !== undefined) {
      const { chars, bytes } = measureSubtitleBody(context.subtitleBody);
      const existing = slots.get(contextKey);
      if (existing) {
        totalChars -= existing.chars;
        totalBytes -= existing.bytes;
        slots.delete(contextKey);
      }
      slots.set(contextKey, {
        subtitleBody: context.subtitleBody as SubtitleBody,
        chars,
        bytes
      });
      totalChars += chars;
      totalBytes += bytes;
      while (
        slots.size > maxEntries ||
        (slots.size > 1 && (totalChars > maxTotalChars || totalBytes > maxTotalBytes))
      ) {
        const oldestKey = slots.keys().next().value;
        if (oldestKey === undefined) {
          break;
        }
        const oldest = slots.get(oldestKey);
        slots.delete(oldestKey);
        if (oldest) {
          totalChars -= oldest.chars;
          totalBytes -= oldest.bytes;
        }
      }
      return { ok: true, contextKey };
    }

    const entry = slots.get(contextKey);
    if (entry && Array.isArray(entry.subtitleBody)) {
      slots.delete(contextKey);
      slots.set(contextKey, entry);
      context.subtitleBody = entry.subtitleBody;
      return { ok: true, contextKey };
    }
    return { ok: false, error: SUBTITLE_BODY_MISSING_MESSAGE, code: SUBTITLE_BODY_MISSING_CODE };
  }

  return { settle };
}
