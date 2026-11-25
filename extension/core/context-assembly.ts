import { buildAiContextRef } from "../ai/conversation.js";
import type { AiContext } from "../ai/types.js";
import { extractVideoId } from "../bilibili/video-id-shared.js";
import { fetchHotCommentsWithLedger } from "../bilibili/gateway.js";
import { detectSiteFromUrl, getSiteCapabilities, normalizeSiteId, type SiteId } from "../shared/site.js";
import {
  createReaderContextPayload,
  computeContextStateSignature
} from "./context-payload.js";
import { DEFAULT_SETTINGS, type Settings } from "./defaults.js";
import type { ClipState, HotComment } from "./state.js";

export type ContextFetchPayload = AiContext | { unchanged: true };

export type ContextFetchOutcome =
  | { kind: "no-tab" }
  | { kind: "payload"; tabUrl: string; payload: ContextFetchPayload }
  | { kind: "error"; tabUrl?: string; error: unknown };

export interface ContextFetchOptions {
  forceRefresh: boolean;
  ifSignature: string;
}

export type ContextFetch = (opts: ContextFetchOptions) => Promise<ContextFetchOutcome>;

export interface InProcessContextFetchDeps {
  clip?: () => Partial<ClipState>;
  settings?: () => Partial<Settings>;
  url?: () => string;
  fetchHotComments?: () => Promise<HotComment[]>;
  verifyPageIdentity?: boolean;
}

async function defaultFetchHotComments(site: SiteId, bvid: string): Promise<HotComment[]> {
  if (site === "youtube") {
    const ytGateway = await import("../youtube/gateway.js");
    return (await ytGateway.fetchYoutubeHotCommentsWithLedger(bvid)).comments;
  }
  return (await fetchHotCommentsWithLedger()).comments;
}

function doesClipMatchPageUrl(clip: Partial<ClipState>, url: string): boolean {
  const pageVideoId = extractVideoId(url);
  if (!pageVideoId) {
    return true;
  }
  if (normalizeSiteId(clip?.site) !== detectSiteFromUrl(url)) {
    return false;
  }
  const clipBvid = String(clip?.bvid || "").trim();
  return !clipBvid || clipBvid === pageVideoId;
}

export function createInProcessContextFetch(deps: InProcessContextFetchDeps = {}): ContextFetch {
  const getClip = deps.clip || (() => ({}));
  const getSettings = deps.settings || (() => DEFAULT_SETTINGS);
  const getUrl = deps.url || (() => (typeof location !== "undefined" ? location.href : ""));
  const customFetchHotComments = deps.fetchHotComments;
  const verifyPageIdentity = deps.verifyPageIdentity !== false;

  return async function fetchContext({ forceRefresh, ifSignature }: ContextFetchOptions): Promise<ContextFetchOutcome> {
    const tabUrl = getUrl();
    const clip = getClip();
    const payload = createReaderContextPayload({
      clip: verifyPageIdentity && !doesClipMatchPageUrl(clip, tabUrl) ? {} : clip,
      settings: getSettings(),
      url: tabUrl
    });
    const signature = computeContextStateSignature(payload);
    if (!forceRefresh && ifSignature && ifSignature === signature) {
      return { kind: "payload", tabUrl, payload: { unchanged: true } };
    }
    const hotComments = getSiteCapabilities(payload.site).supportsHotComments
      ? customFetchHotComments
        ? await customFetchHotComments()
        : await defaultFetchHotComments(payload.site, payload.bvid)
      : [];
    return {
      kind: "payload",
      tabUrl,
      payload: { ...payload, hotComments, isVideoContext: true, signature }
    };
  };
}

function doesContextRefMatchCurrentClip(
  contextRef: unknown,
  clip: Partial<ClipState> | null | undefined
): boolean {
  const ref = buildAiContextRef(contextRef);
  if (normalizeSiteId(ref.site) !== normalizeSiteId(clip?.site)) {
    return false;
  }
  const refBvid = String(ref.bvid || "").trim();
  const refCid = String(ref.cid || "").trim();
  const clipBvid = String(clip?.bvid || "").trim();
  const clipCid = String(clip?.cid || "").trim();
  if (!refBvid || !refCid || refBvid !== clipBvid || refCid !== clipCid) {
    return false;
  }
  const trackFields = [ref.selectedSubtitleId, ref.selectedSubtitleUrl, ref.subtitleLang].map((item) =>
    String(item || "").trim()
  );
  const clipTrackFields = [
    clip?.selectedSubtitleId,
    clip?.selectedSubtitleUrl,
    clip?.selectedSubtitleLang
  ].map((item) => String(item || "").trim());
  if (trackFields.some((item, index) => !item || item !== clipTrackFields[index])) {
    return false;
  }
  return Array.isArray(clip?.subtitleBody) && clip.subtitleBody.length > 0;
}

export interface InProcessPinnedContextResolverDeps {
  clip?: () => Partial<ClipState>;
  settings?: () => Partial<Settings>;
  url?: () => string;
  fetchHotComments?: () => Promise<HotComment[]>;
  resolveNetwork: (contextRef: unknown) => Promise<Record<string, unknown>>;
}

export function createInProcessPinnedContextResolver(
  deps: InProcessPinnedContextResolverDeps
): (contextRef: unknown) => Promise<Record<string, unknown>> {
  const fetchContext = createInProcessContextFetch({
    clip: deps.clip,
    settings: deps.settings,
    url: deps.url,
    fetchHotComments: deps.fetchHotComments,
    verifyPageIdentity: false
  });
  const getClip = deps.clip || (() => ({}));
  const resolveNetwork = deps.resolveNetwork;

  return async function resolveAiConversationContext(contextRef: unknown): Promise<Record<string, unknown>> {
    if (doesContextRefMatchCurrentClip(contextRef, getClip())) {
      const outcome = await fetchContext({ forceRefresh: true, ifSignature: "" });
      if (
        outcome.kind === "payload" &&
        outcome.payload &&
        (outcome.payload as { unchanged?: unknown }).unchanged !== true
      ) {
        return outcome.payload as Record<string, unknown>;
      }
    }
    return resolveNetwork(contextRef);
  };
}
