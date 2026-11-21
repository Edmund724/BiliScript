import type { ChatSessionContextSnapshot } from "./chat-state.js";
import type { ClipState, SubtitleFetchState } from "../core/state.js";

export interface SubtitleReadiness {
  hasBody: boolean;
  fetchState: SubtitleFetchState;
  asrActive: boolean;
}

function hasSubtitleBody(body: unknown): boolean {
  return Array.isArray(body) && body.length > 0;
}

function normalizeFetchState(value: unknown): SubtitleFetchState {
  return value === "loading" || value === "ready" || value === "error" || value === "empty" ? value : "idle";
}

export function readinessFromClip(clip: Pick<ClipState, "subtitleBody" | "subtitleFetchState">): SubtitleReadiness {
  return {
    hasBody: hasSubtitleBody(clip.subtitleBody),
    fetchState: normalizeFetchState(clip.subtitleFetchState),
    asrActive: false
  };
}

export function readinessFromSnapshot(
  snapshot: ChatSessionContextSnapshot | null | undefined,
  { asrTranscribingActive = false }: { asrTranscribingActive?: boolean } = {}
): SubtitleReadiness | null {
  if (!snapshot) {
    return null;
  }
  return {
    hasBody: hasSubtitleBody(snapshot.subtitleBody),
    fetchState: normalizeFetchState(snapshot.subtitleFetchState),
    asrActive: asrTranscribingActive === true
  };
}

export function isPending(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && (view.fetchState === "loading" || view.asrActive);
}

export function isNoSubtitleEmpty(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "empty";
}

export function isSubtitleFetchFailed(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "error";
}

export function wantsWaitNotice(view: SubtitleReadiness | null | undefined): boolean {
  return view != null && !view.hasBody && view.fetchState === "loading";
}
