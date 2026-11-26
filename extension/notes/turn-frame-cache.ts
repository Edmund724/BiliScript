import type { CapturedVideoFrame } from "../ai/types.js";
import type { ChatSessionMessage } from "../chat/conversation-types.js";

export interface NoteKeyframeCandidate {
  seconds: number;
  dataUrl: string;
}

const MAX_STORED_TURN_FRAMES = 32;

let messageFrameMap = new WeakMap<ChatSessionMessage, NoteKeyframeCandidate[]>();
const historyIndexFrameMap = new Map<number, NoteKeyframeCandidate[]>();
let latestCapturedFrames: NoteKeyframeCandidate[] = [];

function normalizeCandidate(candidate: NoteKeyframeCandidate | null | undefined): NoteKeyframeCandidate | null {
  if (!candidate) {
    return null;
  }
  const seconds = Number(candidate.seconds);
  const dataUrl = String(candidate.dataUrl ?? "").trim();
  if (!Number.isFinite(seconds) || seconds < 0 || !dataUrl.startsWith("data:image/")) {
    return null;
  }
  return { seconds, dataUrl };
}

function normalizeCandidateList(frames: readonly NoteKeyframeCandidate[]): NoteKeyframeCandidate[] {
  const out: NoteKeyframeCandidate[] = [];
  for (const frame of frames) {
    const normalized = normalizeCandidate(frame);
    if (!normalized) {
      continue;
    }
    out.push(normalized);
    if (out.length >= MAX_STORED_TURN_FRAMES) {
      break;
    }
  }
  return out;
}

function cloneCandidateList(frames: readonly NoteKeyframeCandidate[] | undefined): NoteKeyframeCandidate[] {
  if (!frames || frames.length === 0) {
    return [];
  }
  return frames.map((frame) => ({ seconds: frame.seconds, dataUrl: frame.dataUrl }));
}

export function capturedVideoFrameToCandidate(
  frame: CapturedVideoFrame | null | undefined
): NoteKeyframeCandidate | null {
  if (!frame || !frame.image) {
    return null;
  }
  const seconds = Number(frame.currentTime);
  const rawData = String(frame.image.data ?? "").trim();
  if (!Number.isFinite(seconds) || seconds < 0 || !rawData) {
    return null;
  }
  if (rawData.startsWith("data:image/")) {
    return { seconds, dataUrl: rawData };
  }
  const mime = String(frame.image.mime || "image/jpeg").trim() || "image/jpeg";
  return {
    seconds,
    dataUrl: `data:${mime};base64,${rawData}`
  };
}

export function capturedVideoFramesToCandidates(
  input: CapturedVideoFrame | readonly CapturedVideoFrame[] | null | undefined
): NoteKeyframeCandidate[] {
  if (!input) {
    return [];
  }
  const list = Array.isArray(input) ? input : [input];
  const out: NoteKeyframeCandidate[] = [];
  for (const item of list) {
    const candidate = capturedVideoFrameToCandidate(item);
    if (candidate) {
      out.push(candidate);
    }
  }
  return out;
}

export function bindCapturedFramesToMessage(
  message: ChatSessionMessage,
  frames: readonly NoteKeyframeCandidate[],
  historyIndex?: number
): NoteKeyframeCandidate[] {
  const normalized = normalizeCandidateList(frames);
  if (normalized.length === 0) {
    return [];
  }
  messageFrameMap.set(message, normalized);
  if (typeof historyIndex === "number" && Number.isInteger(historyIndex) && historyIndex >= 0) {
    historyIndexFrameMap.set(historyIndex, normalized);
  }
  latestCapturedFrames = normalized;
  return cloneCandidateList(normalized);
}

export function setLatestCapturedFrames(frames: readonly NoteKeyframeCandidate[]): void {
  latestCapturedFrames = normalizeCandidateList(frames);
}

export function getCapturedFramesForMessage(
  message: ChatSessionMessage | null | undefined
): NoteKeyframeCandidate[] {
  if (!message) {
    return [];
  }
  return cloneCandidateList(messageFrameMap.get(message));
}

export function getCapturedFramesForHistoryIndex(historyIndex: number): NoteKeyframeCandidate[] {
  if (!Number.isInteger(historyIndex) || historyIndex < 0) {
    return [];
  }
  return cloneCandidateList(historyIndexFrameMap.get(historyIndex));
}

export function getLatestCapturedFrames(): NoteKeyframeCandidate[] {
  return cloneCandidateList(latestCapturedFrames);
}

export function clearTurnCapturedFrameCache(): void {
  messageFrameMap = new WeakMap<ChatSessionMessage, NoteKeyframeCandidate[]>();
  historyIndexFrameMap.clear();
  latestCapturedFrames = [];
}
