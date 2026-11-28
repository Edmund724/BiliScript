import { buildContextKey } from "../ai/conversation.js";
import { computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { chatSessionState } from "../chat/chat-state.js";
import { state } from "../core/state.js";
import { stripThinkBlocks } from "../ui/markdown.js";
import {
  getCapturedFramesForMessage,
  type NoteKeyframeCandidate
} from "./turn-frame-cache.js";

export interface SessionVideoNoteRecord {
  clipSignature: string;
  contextKey: string;
  markdown: string;
  capturedFrames: NoteKeyframeCandidate[];
  isVideoNote: boolean;
}

export interface SessionNoteCandidate {
  markdown: string;
  capturedFrames: NoteKeyframeCandidate[];
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

export function captureLiveClipSignature(): string {
  const stateSig = String(state.clip.currentClipSignature || "").trim();
  const urlSig = String(computeCurrentClipSignature() || "").trim();
  if (!stateSig && !urlSig) {
    return "";
  }
  return `${stateSig}||${urlSig}`;
}

export function resolveCurrentClipContextKey(): string {
  const clip = state.clip;
  const bvid = String(clip.bvid || "").trim();
  if (!bvid) {
    return "";
  }
  return buildContextKey({
    site: clip.site,
    bvid,
    cid: clip.cid,
    aid: clip.aid,
    url: clip.currentUrl || (typeof location !== "undefined" ? location.href : "")
  });
}

export function resolveActiveClipNoteCandidate(): SessionNoteCandidate | null {
  const clipSignature = captureLiveClipSignature();
  const contextKey = resolveCurrentClipContextKey();
  const recorded = findLatestSessionNoteForClip({ clipSignature, contextKey });
  if (recorded) {
    return {
      markdown: recorded.markdown,
      capturedFrames: recorded.capturedFrames
    };
  }

  const sessionKey = String(
    chatSessionState.currentConversationMeta?.contextKey || chatSessionState.currentContextKey || ""
  ).trim();
  if (contextKey && sessionKey && sessionKey !== contextKey) {
    return null;
  }

  const history = Array.isArray(chatSessionState.chatHistory) ? chatSessionState.chatHistory : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (!message || message.role !== "assistant" || message.stopped) {
      continue;
    }
    const content = typeof message.content === "string" ? message.content : "";
    if (!stripThinkBlocks(content).trim()) {
      continue;
    }
    return {
      markdown: content,
      capturedFrames: getCapturedFramesForMessage(message)
    };
  }
  return null;
}

export function clearSessionNoteRecords(): void {
  latestVideoNotesByClip.clear();
  latestRepliesByClip.clear();
}
