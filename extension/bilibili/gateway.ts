import { getErrorMessage } from "../shared/error-helpers.js";
import { state, clipState } from "../core/state.js";
import { getRuntimeVideoElement } from "./video-probe.js";
import { contentFetchJson } from "./content-transport.js";
import type { JsonTransport } from "./gateway-core.js";
import type { HotComment } from "./bili-api-shared.js";
import { fetchHotCommentsJson } from "./hot-comments.js";
import { fetchSubtitleBodyJson } from "./video-api.js";
export { fetchHotCommentsJson } from "./hot-comments.js";
export {
  fetchVideoMeta,
  fetchSubtitleBundle,
  fetchSubtitleBodyJson,
  resolveVideoPageFromMeta
} from "./video-api.js";
export type {
  VideoPage,
  VideoPageQuery,
  VideoMetaLike,
  ResolvedVideoPage,
  VideoMeta,
  SubtitleTrackOrigin,
  SubtitleTrack,
  Chapter
} from "./video-api.js";

declare global {
  interface Window {
    __INITIAL_STATE__?: { aid?: unknown };
  }
}

export { bgFetchJson, isBiliUrl } from "./gateway-core.js";
export { contentFetchJson } from "./content-transport.js";
export type { JsonTransport } from "./gateway-core.js";

export function getCurrentAid(): number {
  let aid = Number(state.clip.aid) || 0;
  if (!aid && typeof window !== "undefined") {
    try {
      aid = Number(window.__INITIAL_STATE__?.aid) || 0;
    } catch {}
  }
  return aid;
}

export function readRuntimeVideoDuration(): number {
  const video = getRuntimeVideoElement();
  const duration = Number(video?.duration);
  if (Number.isFinite(duration) && duration > 0) {
    return duration;
  }
  return 0;
}

export async function fetchSubtitleBody<T = unknown>(url: string): Promise<{ body: T[] }> {
  const body = await fetchSubtitleBodyJson<T>(contentFetchJson, url);
  return { body };
}

export async function fetchHotComments(count = 20): Promise<HotComment[]> {
  const safeCount = Math.max(0, Number(count) || 0);
  if (!safeCount) {
    return [];
  }

  const aid = getCurrentAid();
  if (!aid) {
    return [];
  }

  return fetchHotCommentsJson(contentFetchJson, aid, safeCount);
}

export interface HotCommentsWithLedgerDeps {
  clipState?: { setHotComments(comments: HotComment[]): void };
  getCurrentAid?: () => number;
  fetchHotComments?: (count: number) => Promise<HotComment[]>;
}

export interface HotCommentsWithLedgerOutcome {
  comments: HotComment[];
  note?: string;
}

export async function fetchHotCommentsWithLedger(
  deps: HotCommentsWithLedgerDeps = {}
): Promise<HotCommentsWithLedgerOutcome> {
  const ledger = deps.clipState || clipState;
  const aidOf = deps.getCurrentAid || getCurrentAid;
  const fetchComments = deps.fetchHotComments || fetchHotComments;
  try {
    if (!aidOf()) {
      ledger.setHotComments([]);
      return { comments: [], note: "无法获取视频 aid" };
    }
    const comments = await fetchComments(20);
    ledger.setHotComments(comments);
    return { comments };
  } catch (error) {
    ledger.setHotComments([]);
    return { comments: [], note: getErrorMessage(error) };
  }
}
