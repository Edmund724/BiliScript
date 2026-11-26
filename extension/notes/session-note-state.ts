import type { NoteKeyframeCandidate } from "./turn-frame-cache.js";

export interface SessionVideoNoteRecord {
  clipSignature: string;
  contextKey: string;
  markdown: string;
  capturedFrames: NoteKeyframeCandidate[];
  isVideoNote: boolean;
}

const latestVideoNotesByClip = new Map<string, SessionVideoNoteRecord>();
const latestRepliesByClip = new Map<string, SessionVideoNoteRecord>();

function normalizeKey(value: string | null | undefined): string {
  return String(value || "").trim();
}

function cloneRecord(record: SessionVideoNoteRecord): SessionVideoNoteRecord {
  return {
    clipSignature: record.clipSignature,
    contextKey: record.contextKey,
    markdown: record.markdown,
    capturedFrames: record.capturedFrames.map((frame) => ({ ...frame })),
    isVideoNote: record.isVideoNote
  };
}

export function recordSessionNoteReply(record: SessionVideoNoteRecord): void {
  const clipSignature = normalizeKey(record.clipSignature);
  const contextKey = normalizeKey(record.contextKey);
  const markdown = String(record.markdown || "").trim();
  if (!markdown || (!clipSignature && !contextKey)) {
    return;
  }
  const normalized = cloneRecord({
    clipSignature,
    contextKey,
    markdown,
    capturedFrames: Array.isArray(record.capturedFrames) ? record.capturedFrames : [],
    isVideoNote: Boolean(record.isVideoNote)
  });
  const key = clipSignature || contextKey;
  latestRepliesByClip.set(key, normalized);
  if (normalized.isVideoNote) {
    latestVideoNotesByClip.set(key, normalized);
  }
}

export function findLatestSessionNoteForClip(match: {
  clipSignature?: string;
  contextKey?: string;
}): SessionVideoNoteRecord | null {
  const clipSignature = normalizeKey(match.clipSignature);
  const contextKey = normalizeKey(match.contextKey);
  if (!clipSignature && !contextKey) {
    return null;
  }

  const lookup = (map: Map<string, SessionVideoNoteRecord>): SessionVideoNoteRecord | null => {
    if (clipSignature && map.has(clipSignature)) {
      return cloneRecord(map.get(clipSignature)!);
    }
    if (contextKey && map.has(contextKey)) {
      return cloneRecord(map.get(contextKey)!);
    }
    for (const item of map.values()) {
      if (clipSignature && item.clipSignature === clipSignature) {
        return cloneRecord(item);
      }
      if (contextKey && item.contextKey === contextKey) {
        return cloneRecord(item);
      }
    }
    return null;
  };

  return lookup(latestVideoNotesByClip) ?? lookup(latestRepliesByClip);
}

export function clearSessionNoteRecords(): void {
  latestVideoNotesByClip.clear();
  latestRepliesByClip.clear();
}
