import { isYoutubeWatchPage } from "../shared/site.js";
import { withOkResponse } from "./provider-handlers.js";
import type {
  BackgroundMessage,
  BackgroundMessageHandler,
  BackgroundResponseOf,
  MessageReplyDecision,
  MessageSender,
  YoutubePageSnapshot
} from "../shared/messaging-protocol.js";

const YOUTUBE_SABR_WORKER_FILE = "entry/youtube-sabr-worker.main.js";

export interface YoutubeScriptingInjectionResult {
  result?: unknown;
}

export interface YoutubeScriptingAdapter {
  executeScript?: {
    (injection: {
      target: { tabId: number };
      world: "MAIN";
      files: string[];
    }): Promise<YoutubeScriptingInjectionResult[]>;
    (injection: {
      target: { tabId: number };
      world: "MAIN";
      func: () => unknown;
    }): Promise<YoutubeScriptingInjectionResult[]>;
    (injection: {
      target: { tabId: number };
      world: "MAIN";
      func: (...args: never[]) => unknown;
      args?: unknown[];
    }): Promise<YoutubeScriptingInjectionResult[]>;
  };
}

export interface YoutubeScriptingHostAdapter {
  scripting?: YoutubeScriptingAdapter;
}

export interface YoutubeScriptingHandlers {
  pageSnapshot: BackgroundMessageHandler<"youtube-page-snapshot">;
  captureTimedtextPot: BackgroundMessageHandler<"youtube-capture-timedtext-pot">;
  ensureSabrWorker: BackgroundMessageHandler<"youtube-ensure-sabr-worker">;
}

type YoutubeScriptingMsg<
  T extends "youtube-page-snapshot" | "youtube-capture-timedtext-pot" | "youtube-ensure-sabr-worker"
> = Extract<BackgroundMessage, { type: T }>;

type YoutubeScriptingReply<
  T extends "youtube-page-snapshot" | "youtube-capture-timedtext-pot" | "youtube-ensure-sabr-worker"
> = (response: BackgroundResponseOf<T>) => void;

type ReadyScriptingAdapter = YoutubeScriptingAdapter & {
  executeScript: NonNullable<YoutubeScriptingAdapter["executeScript"]>;
};

function collectYoutubeMainWorldSnapshot(): YoutubePageSnapshot | null {
  type JsonObj = Record<string, unknown>;
  const asObj = (value: unknown): JsonObj | null =>
    value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObj) : null;
  const readText = (value: unknown): string => {
    if (typeof value === "string") {
      return value;
    }
    const obj = asObj(value);
    if (!obj) {
      return "";
    }
    if (typeof obj.simpleText === "string") {
      return obj.simpleText;
    }
    if (Array.isArray(obj.runs)) {
      return obj.runs
        .map((run) => {
          const r = asObj(run);
          return typeof r?.text === "string" ? r.text : "";
        })
        .join("");
    }
    return "";
  };

  let urlVideoId = "";
  try {
    const v = new URL(location.href).searchParams.get("v") || "";
    if (/^[A-Za-z0-9_-]{11}$/.test(v)) {
      urlVideoId = v;
    }
  } catch {
  }

  const win = window as unknown as JsonObj;
  const moviePlayer = document.getElementById("movie_player") as
    | {
        getPlayerResponse?: () => unknown;
        getVideoData?: () => JsonObj | null;
        getDuration?: () => number;
      }
    | null;
  const watchFlexy = document.querySelector("ytd-watch-flexy") as
    | { playerData?: unknown; data?: unknown }
    | null;

  const matchesUrlVideoId = (candidateId: unknown): boolean =>
    !urlVideoId || typeof candidateId !== "string" || !candidateId || candidateId === urlVideoId;

  let livePlayerResponse: unknown = null;
  try {
    if (typeof moviePlayer?.getPlayerResponse === "function") {
      livePlayerResponse = moviePlayer.getPlayerResponse();
    }
  } catch {
  }

  let movieVideoData: JsonObj | null = null;
  try {
    if (typeof moviePlayer?.getVideoData === "function") {
      movieVideoData = asObj(moviePlayer.getVideoData());
    }
  } catch {
  }
  const rawMovieVideoId = typeof movieVideoData?.video_id === "string" ? movieVideoData.video_id : "";
  const livePlayerVideoId = asObj(asObj(livePlayerResponse)?.videoDetails)?.videoId;
  const moviePlayerMismatched =
    !matchesUrlVideoId(rawMovieVideoId) || !matchesUrlVideoId(livePlayerVideoId);
  if (!matchesUrlVideoId(rawMovieVideoId)) {
    movieVideoData = null;
  }

  const playerCandidates = [
    asObj(livePlayerResponse),
    asObj(watchFlexy?.playerData),
    asObj(win.ytInitialPlayerResponse)
  ].filter(
    (item): item is JsonObj =>
      item !== null && matchesUrlVideoId(asObj(item.videoDetails)?.videoId)
  );

  let playerResponse: JsonObj | null = null;
  if (urlVideoId) {
    playerResponse =
      playerCandidates.find((cand) => asObj(cand.videoDetails)?.videoId === urlVideoId) ?? null;
  }
  if (!playerResponse) {
    playerResponse = playerCandidates[0] ?? null;
  }

  const getInitialDataVideoId = (cand: JsonObj): unknown =>
    asObj(asObj(cand.currentVideoEndpoint)?.watchEndpoint)?.videoId;

  const dataCandidates = [asObj(watchFlexy?.data), asObj(win.ytInitialData)].filter(
    (item): item is JsonObj => item !== null && matchesUrlVideoId(getInitialDataVideoId(item))
  );
  let initialData: JsonObj | null = null;
  if (urlVideoId) {
    initialData =
      dataCandidates.find((cand) => getInitialDataVideoId(cand) === urlVideoId) ?? null;
  }
  if (!initialData) {
    initialData = dataCandidates[0] ?? null;
  }

  const videoDetails = asObj(playerResponse?.videoDetails);
  const microformat = asObj(asObj(playerResponse?.microformat)?.playerMicroformatRenderer);
  const liveBroadcastDetails = asObj(microformat?.liveBroadcastDetails);

  const videoId = String(
    (typeof videoDetails?.videoId === "string" && videoDetails.videoId) ||
      (typeof movieVideoData?.video_id === "string" && movieVideoData.video_id) ||
      urlVideoId ||
      ""
  );
  const title = String(
    (typeof videoDetails?.title === "string" && videoDetails.title) ||
      (typeof movieVideoData?.title === "string" && movieVideoData.title) ||
      ""
  );
  const author = String(
    (typeof videoDetails?.author === "string" && videoDetails.author) ||
      (typeof movieVideoData?.author === "string" && movieVideoData.author) ||
      ""
  );
  const description = typeof videoDetails?.shortDescription === "string"
    ? videoDetails.shortDescription
    : "";

  let playerDuration = 0;
  if (!moviePlayerMismatched) {
    try {
      if (typeof moviePlayer?.getDuration === "function") {
        playerDuration = Number(moviePlayer.getDuration());
      }
    } catch {
    }
  }
  const detailDuration = Number(videoDetails?.lengthSeconds);
  const safePlayerDuration = Number.isFinite(playerDuration) && playerDuration > 0 ? playerDuration : 0;
  const duration =
    Number.isFinite(detailDuration) && detailDuration > 0 ? detailDuration : safePlayerDuration;

  const publishDate = String(
    (typeof microformat?.publishDate === "string" && microformat.publishDate) ||
      (typeof microformat?.uploadDate === "string" && microformat.uploadDate) ||
      ""
  );
  const isLiveContent = Boolean(videoDetails?.isLiveContent);
  const isLiveNow = Boolean(videoDetails?.isLive || liveBroadcastDetails?.isLiveNow);

  const rawCaptionTracks = asObj(
    asObj(playerResponse?.captions)?.playerCaptionsTracklistRenderer
  )?.captionTracks;
  const captionTracks: Array<{
    baseUrl: string;
    languageCode: string;
    name: string;
    kind?: string;
    vssId?: string;
    isTranslatable?: boolean;
  }> = [];
  if (Array.isArray(rawCaptionTracks)) {
    for (const rawTrack of rawCaptionTracks) {
      const track = asObj(rawTrack);
      if (!track) continue;
      const baseUrl = typeof track.baseUrl === "string" ? track.baseUrl : "";
      const languageCode = typeof track.languageCode === "string" ? track.languageCode : "";
      if (!baseUrl && !languageCode) continue;
      const item: {
        baseUrl: string;
        languageCode: string;
        name: string;
        kind?: string;
        vssId?: string;
        isTranslatable?: boolean;
      } = {
        baseUrl,
        languageCode,
        name: readText(track.name)
      };
      if (typeof track.kind === "string" && track.kind) {
        item.kind = track.kind;
      }
      if (typeof track.vssId === "string" && track.vssId) {
        item.vssId = track.vssId;
      }
      if (typeof track.isTranslatable === "boolean") {
        item.isTranslatable = track.isTranslatable;
      }
      captionTracks.push(item);
    }
  }

  const chapterMap = new Map<number, { title: string; from: number }>();
  const addChapter = (rawTitle: unknown, rawStartMs: unknown) => {
    const chapterTitle = readText(rawTitle).trim();
    const startMs = Number(rawStartMs);
    if (!chapterTitle || !Number.isFinite(startMs) || startMs < 0) {
      return;
    }
    const from = Math.floor(startMs / 1000);
    if (!chapterMap.has(from)) {
      chapterMap.set(from, { title: chapterTitle, from });
    }
  };

  const markersBar = asObj(
    asObj(
      asObj(
        asObj(asObj(initialData?.playerOverlays)?.playerOverlayRenderer)
          ?.decoratedPlayerBarRenderer
      )?.decoratedPlayerBarRenderer
    )?.playerBar
  );
  const rawMarkersMap = asObj(markersBar?.multiMarkersPlayerBarRenderer)?.markersMap;
  if (Array.isArray(rawMarkersMap)) {
    const prioritized = [...rawMarkersMap].sort((a, b) => {
      const ka = String(asObj(a)?.key || "");
      const kb = String(asObj(b)?.key || "");
      const rank = (k: string) => (k === "DESCRIPTION_CHAPTERS" ? 0 : k === "AUTO_CHAPTERS" ? 1 : 2);
      return rank(ka) - rank(kb);
    });
    for (const markerEntry of prioritized) {
      const markerChapters = asObj(asObj(markerEntry)?.value)?.chapters;
      if (Array.isArray(markerChapters) && markerChapters.length > 0) {
        for (const rawChapter of markerChapters) {
          const renderer = asObj(asObj(rawChapter)?.chapterRenderer);
          if (renderer) {
            addChapter(renderer.title, renderer.timeRangeStartMillis);
          }
        }
        if (chapterMap.size > 0) {
          break;
        }
      }
    }
  }

  let transcriptParams = "";
  let modernTranscriptParams = "";
  let commentsContinuation = "";
  let hasCommentsDisabledMessage = false;

  const extractModernTranscriptParams = (node: unknown, depth = 0): string => {
    if (!node || typeof node !== "object" || depth > 14) {
      return "";
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = extractModernTranscriptParams(item, depth + 1);
        if (hit) return hit;
      }
      return "";
    }
    const obj = node as JsonObj;
    const updateCmd = asObj(obj.updateEngagementPanelContentCommand);
    if (
      updateCmd &&
      asObj(updateCmd.contentSourcePanelIdentifier)?.tag === "PAmodern_transcript_view"
    ) {
      const p = asObj(updateCmd.globalConfiguration)?.params;
      if (typeof p === "string" && p.trim()) {
        return p.trim();
      }
    }
    for (const value of Object.values(obj)) {
      if (value && typeof value === "object") {
        const hit = extractModernTranscriptParams(value, depth + 1);
        if (hit) return hit;
      }
    }
    return "";
  };

  const extractCommentsFromItemSections = (rawSections: unknown) => {
    if (!Array.isArray(rawSections)) return;
    for (const rawSection of rawSections) {
      const section = asObj(asObj(rawSection)?.itemSectionRenderer);
      if (!section) continue;
      const sectionId = typeof section.sectionIdentifier === "string" ? section.sectionIdentifier : "";
      const targetId = typeof section.targetId === "string" ? section.targetId : "";
      if (sectionId !== "comment-item-section" && targetId !== "comments-section") {
        continue;
      }
      const sectionContents = section.contents;
      if (!Array.isArray(sectionContents)) continue;
      for (const rawItem of sectionContents) {
        const item = asObj(rawItem);
        const token = asObj(
          asObj(asObj(item?.continuationItemRenderer)?.continuationEndpoint)?.continuationCommand
        )?.token;
        if (typeof token === "string" && token.trim() && !commentsContinuation) {
          commentsContinuation = token.trim();
        }
        if (asObj(item?.messageRenderer)) {
          hasCommentsDisabledMessage = true;
        }
      }
    }
  };

  extractCommentsFromItemSections(
    asObj(
      asObj(asObj(asObj(initialData?.contents)?.twoColumnWatchNextResults)?.results)?.results
    )?.contents
  );

  const engagementPanels = initialData?.engagementPanels;
  if (Array.isArray(engagementPanels)) {
    for (const rawPanel of engagementPanels) {
      const section = asObj(asObj(rawPanel)?.engagementPanelSectionListRenderer);
      if (!section) continue;
      const content = asObj(section.content);
      const panelParams = asObj(
        asObj(asObj(content?.continuationItemRenderer)?.continuationEndpoint)?.getTranscriptEndpoint
      )?.params;
      if (typeof panelParams === "string" && panelParams && !transcriptParams) {
        transcriptParams = panelParams;
      }
      if (!modernTranscriptParams) {
        modernTranscriptParams =
          extractModernTranscriptParams(content) || extractModernTranscriptParams(section.header);
      }
      const panelId = typeof section.panelIdentifier === "string" ? section.panelIdentifier : "";
      if (!commentsContinuation && panelId === "engagement-panel-comments-section") {
        extractCommentsFromItemSections(asObj(content?.sectionListRenderer)?.contents);
      }
      if (chapterMap.size === 0) {
        if (
          panelId === "engagement-panel-macro-markers-description-chapters" ||
          panelId === "engagement-panel-macro-markers-auto-chapters"
        ) {
          const macroContents = asObj(content?.macroMarkersListRenderer)?.contents;
          if (Array.isArray(macroContents)) {
            for (const rawItem of macroContents) {
              const itemRenderer = asObj(asObj(rawItem)?.macroMarkersListItemRenderer);
              if (!itemRenderer) continue;
              const startSec = Number(
                asObj(asObj(itemRenderer.onTap)?.watchEndpoint)?.startTimeSeconds
              );
              const titleText = readText(itemRenderer.title).trim();
              if (titleText && Number.isFinite(startSec) && startSec >= 0) {
                const from = Math.floor(startSec);
                if (!chapterMap.has(from)) {
                  chapterMap.set(from, { title: titleText, from });
                }
              }
            }
          }
        }
      }
    }
  }

  const sortedChapters = [...chapterMap.values()].sort((a, b) => a.from - b.from);
  const chapters: Array<{ title: string; from: number; to?: number }> = sortedChapters.map(
    (item, idx) => {
      const next = sortedChapters[idx + 1];
      if (next && next.from > item.from) {
        return { title: item.title, from: item.from, to: next.from };
      }
      if (!next && duration > item.from) {
        return { title: item.title, from: item.from, to: Math.floor(duration) };
      }
      return { title: item.title, from: item.from };
    }
  );

  const ytcfg = asObj(win.ytcfg);
  const readYtcfg = (key: string): unknown => {
    try {
      if (typeof ytcfg?.get === "function") {
        return (ytcfg.get as (k: string) => unknown)(key);
      }
    } catch {
    }
    return asObj(ytcfg?.data_)?.[key];
  };
  const rawApiKey = readYtcfg("INNERTUBE_API_KEY");
  const innertubeApiKey = typeof rawApiKey === "string" ? rawApiKey : "";
  const rawVisitorData = readYtcfg("VISITOR_DATA");
  const visitorData = typeof rawVisitorData === "string" ? rawVisitorData.trim() : "";
  let innertubeContext: Record<string, unknown> | null = null;
  try {
    const rawContext = readYtcfg("INNERTUBE_CONTEXT");
    if (rawContext && typeof rawContext === "object") {
      const parsed = JSON.parse(JSON.stringify(rawContext));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const ctx = parsed as Record<string, unknown>;
        const client = asObj(ctx.client);
        const existingVisitor =
          typeof client?.visitorData === "string" ? client.visitorData.trim() : "";
        if (client && !existingVisitor && visitorData) {
          ctx.client = { ...client, visitorData };
        }
        innertubeContext = ctx;
      }
    }
  } catch {
  }

  const observedTimedtextUrls: string[] = [];
  const seenUrls = new Set<string>();
  try {
    const entries = performance.getEntriesByType("resource");
    for (const entry of entries) {
      const name = typeof entry?.name === "string" ? entry.name : "";
      if (!name || !name.includes("/api/timedtext")) {
        continue;
      }
      try {
        const parsed = new URL(name);
        if (!parsed.pathname.includes("/api/timedtext")) {
          continue;
        }
        const entryVideoId = parsed.searchParams.get("v");
        if (urlVideoId && entryVideoId && entryVideoId !== urlVideoId) {
          continue;
        }
      } catch {
        continue;
      }
      if (!seenUrls.has(name)) {
        seenUrls.add(name);
        observedTimedtextUrls.push(name);
      }
    }
  } catch {
  }

  if (!playerResponse && !initialData && !ytcfg && !urlVideoId && observedTimedtextUrls.length === 0) {
    return null;
  }

  return {
    videoId,
    title,
    author,
    description,
    duration,
    publishDate,
    isLiveContent,
    isLiveNow,
    captionTracks,
    chapters,
    innertubeContext,
    innertubeApiKey,
    transcriptParams,
    ...(modernTranscriptParams ? { modernTranscriptParams } : {}),
    commentsContinuation,
    commentsDisabled: !commentsContinuation && hasCommentsDisabledMessage,
    observedTimedtextUrls
  };
}

async function captureYoutubeTimedtextPotInMainWorld(
  expectedVideoId: string,
  preferredLang: string,
  preferredKind: string
): Promise<{ observedTimedtextUrls: string[]; skippedReason?: string }> {
  type TrackObj = { languageCode?: string; kind?: string; vss_id?: string };
  type MoviePlayerLike = HTMLElement & {
    getVideoData?: () => { video_id?: string } | null;
    getPlayerState?: () => number;
    loadModule?: (name: string) => void;
    unloadModule?: (name: string) => void;
    getOption?: (moduleName: string, option: string) => unknown;
    setOption?: (moduleName: string, option: string, value: unknown) => void;
    toggleSubtitles?: () => void;
  };

  const collectMatchingPotUrls = (targetVideoId: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const name = typeof entry?.name === "string" ? entry.name : "";
        if (!name || !name.includes("/api/timedtext")) continue;
        try {
          const u = new URL(name);
          if (!u.pathname.includes("/api/timedtext")) continue;
          const v = (u.searchParams.get("v") || "").trim();
          const pot = (u.searchParams.get("pot") || "").trim();
          const c = (u.searchParams.get("c") || "").trim();
          if (!pot || /\s/.test(pot)) continue;
          if (c && c !== "WEB") continue;
          if (targetVideoId && v && v !== targetVideoId) continue;
          if (!seen.has(name)) {
            seen.add(name);
            out.push(name);
          }
        } catch {
        }
      }
    } catch {
    }
    return out;
  };

  let urlVideoId = "";
  try {
    const v = new URL(location.href).searchParams.get("v") || "";
    if (/^[A-Za-z0-9_-]{11}$/.test(v)) urlVideoId = v;
  } catch {
  }
  const mp = document.getElementById("movie_player") as MoviePlayerLike | null;
  let playerVideoId = "";
  try {
    playerVideoId = String(mp?.getVideoData?.()?.video_id || "").trim();
  } catch {
  }
  const targetVideoId = String(expectedVideoId || playerVideoId || urlVideoId || "").trim();
  if (!targetVideoId) {
    return { observedTimedtextUrls: [], skippedReason: "missing-video-id" };
  }
  if (playerVideoId && targetVideoId !== playerVideoId) {
    return { observedTimedtextUrls: [], skippedReason: "video-id-mismatch" };
  }

  const already = collectMatchingPotUrls(targetVideoId);
  if (already.length > 0) {
    return { observedTimedtextUrls: already };
  }

  if (!mp || typeof mp.setOption !== "function") {
    return { observedTimedtextUrls: [], skippedReason: "player-unavailable" };
  }

  let playerState = -1;
  try {
    playerState = typeof mp.getPlayerState === "function" ? Number(mp.getPlayerState()) : -1;
  } catch {
    playerState = -1;
  }
  if (!Number.isFinite(playerState) || playerState === -1) {
    return { observedTimedtextUrls: [], skippedReason: "player-unstarted" };
  }

  const snapStorage = (store: Storage): Record<string, string> => {
    const res: Record<string, string> = {};
    try {
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k && (k.includes("caption") || k.includes("subtitle"))) {
          const val = store.getItem(k);
          if (val !== null) res[k] = val;
        }
      }
    } catch {
    }
    return res;
  };
  const restoreStorage = (store: Storage, before: Record<string, string>) => {
    try {
      const keys = new Set<string>(Object.keys(before));
      for (let i = 0; i < store.length; i += 1) {
        const k = store.key(i);
        if (k && (k.includes("caption") || k.includes("subtitle"))) keys.add(k);
      }
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(before, k)) {
          if (store.getItem(k) !== before[k]) store.setItem(k, before[k]);
        } else {
          store.removeItem(k);
        }
      }
    } catch {
    }
  };
  const readPrefCookie = (): string | null => {
    try {
      const m = document.cookie.match(/(?:^|;\s*)PREF=([^;]*)/);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  };

  const ccBtn = document.querySelector(".ytp-subtitles-button");
  const wasCcOn = ccBtn?.getAttribute("aria-pressed") === "true";
  let prevTrack: TrackObj | null = null;
  try {
    const rawPrev = mp.getOption?.("captions", "track");
    if (rawPrev && typeof rawPrev === "object") prevTrack = rawPrev as TrackObj;
  } catch {
  }

  const lsBefore = snapStorage(localStorage);
  const ssBefore = snapStorage(sessionStorage);
  const prefBefore = readPrefCookie();

  let hideStyle: HTMLStyleElement | null = null;
  if (!wasCcOn) {
    try {
      hideStyle = document.createElement("style");
      hideStyle.id = "__biliscript_silent_cc_hide";
      hideStyle.textContent =
        ".ytp-caption-window-container { opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; }";
      (document.head || document.documentElement).appendChild(hideStyle);
    } catch {
      hideStyle = null;
    }
  }

  const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const pollForPot = async (maxMs: number): Promise<string[]> => {
    const deadline = performance.now() + maxMs;
    while (performance.now() < deadline) {
      const hits = collectMatchingPotUrls(targetVideoId);
      if (hits.length > 0) return hits;
      await sleepMs(35);
    }
    return collectMatchingPotUrls(targetVideoId);
  };

  let captured: string[] = [];
  let toggled = false;
  try {
    try {
      mp.loadModule?.("captions");
    } catch {
    }
    let tracklist: TrackObj[] = [];
    const modDeadline = performance.now() + 1200;
    while (performance.now() < modDeadline) {
      try {
        const rawList = mp.getOption?.("captions", "tracklist");
        if (Array.isArray(rawList) && rawList.length > 0) {
          tracklist = rawList as TrackObj[];
          break;
        }
      } catch {
      }
      captured = collectMatchingPotUrls(targetVideoId);
      if (captured.length > 0) break;
      await sleepMs(40);
    }

    if (captured.length === 0 && tracklist.length > 0) {
      const wantLang = String(preferredLang || "").trim().toLowerCase();
      const wantKind = String(preferredKind || "").trim().toLowerCase();
      const pick =
        tracklist.find(
          (t) =>
            String(t?.languageCode || "").toLowerCase() === wantLang &&
            String(t?.kind || "").toLowerCase() === wantKind
        ) ??
        tracklist.find((t) => String(t?.languageCode || "").toLowerCase() === wantLang) ??
        tracklist[0];
      try {
        mp.setOption("captions", "track", pick);
      } catch {
      }
      captured = await pollForPot(2200);
    }

    if (
      captured.length === 0 &&
      !wasCcOn &&
      ccBtn?.getAttribute("aria-pressed") === "false" &&
      typeof mp.toggleSubtitles === "function"
    ) {
      try {
        mp.toggleSubtitles();
        toggled = true;
      } catch {
      }
      captured = await pollForPot(2000);
    }
  } finally {
    try {
      if (!wasCcOn) {
        if (toggled && ccBtn?.getAttribute("aria-pressed") === "true") {
          mp.toggleSubtitles?.();
        }
        mp.setOption?.("captions", "track", {});
        mp.unloadModule?.("captions");
      } else if (prevTrack && prevTrack.languageCode) {
        mp.setOption?.("captions", "track", prevTrack);
      }
    } catch {
    }
    await sleepMs(60);
    try {
      hideStyle?.remove();
    } catch {
    }
    restoreStorage(localStorage, lsBefore);
    restoreStorage(sessionStorage, ssBefore);
    const prefAfter = readPrefCookie();
    if (prefBefore !== null && prefAfter !== prefBefore) {
      try {
        document.cookie = `PREF=${prefBefore}; domain=.youtube.com; path=/`;
      } catch {
      }
    }
  }

  return {
    observedTimedtextUrls: captured,
    ...(captured.length === 0 ? { skippedReason: "pot-not-observed" } : {})
  };
}

export function createYoutubeScriptingHandlers(
  adapter: YoutubeScriptingHostAdapter
): YoutubeScriptingHandlers {
  function resolveWatchScriptingTab(
    sender: MessageSender,
    missingTabError: string
  ): { ok: true; tabId: number; scripting: ReadyScriptingAdapter } | { ok: false; error: string } {
    const tabId = Number(sender.tab?.id) || 0;
    if (!tabId) {
      return { ok: false, error: missingTabError };
    }
    if (!isYoutubeWatchPage(sender.tab?.url)) {
      return { ok: false, error: "当前网页不是 YouTube 视频页" };
    }
    const scripting = adapter.scripting;
    if (!scripting || typeof scripting.executeScript !== "function") {
      return { ok: false, error: "scripting API 不可用" };
    }
    return { ok: true, tabId, scripting: scripting as ReadyScriptingAdapter };
  }

  function pageSnapshot(
    _message: YoutubeScriptingMsg<"youtube-page-snapshot">,
    sender: MessageSender,
    sendResponse: YoutubeScriptingReply<"youtube-page-snapshot">
  ): MessageReplyDecision {
    const resolved = resolveWatchScriptingTab(sender, "仅支持标签页内请求 YouTube 页面快照");
    if (!resolved.ok) {
      sendResponse(resolved);
      return "answered";
    }

    withOkResponse(
      (async () => {
        const results = await resolved.scripting.executeScript({
          target: { tabId: resolved.tabId },
          world: "MAIN",
          func: collectYoutubeMainWorldSnapshot
        });
        const snapshot = results?.[0]?.result as YoutubePageSnapshot | null | undefined;
        if (!snapshot || typeof snapshot !== "object") {
          return { ok: false, error: "未读取到 YouTube 页面播放器快照" };
        }
        return { ok: true, snapshot };
      })(),
      sendResponse,
      (error) => (error as Error | undefined)?.message || String(error)
    );
    return "hold";
  }

  function captureTimedtextPot(
    message: YoutubeScriptingMsg<"youtube-capture-timedtext-pot">,
    sender: MessageSender,
    sendResponse: YoutubeScriptingReply<"youtube-capture-timedtext-pot">
  ): MessageReplyDecision {
    const resolved = resolveWatchScriptingTab(sender, "仅支持标签页内请求 YouTube 字幕凭证");
    if (!resolved.ok) {
      sendResponse(resolved);
      return "answered";
    }

    const expectedVideoId =
      typeof message.expectedVideoId === "string" ? message.expectedVideoId.trim() : "";
    const languageCode =
      typeof message.languageCode === "string" ? message.languageCode.trim() : "";
    const kind = typeof message.kind === "string" ? message.kind.trim() : "";

    withOkResponse(
      (async () => {
        const results = await resolved.scripting.executeScript({
          target: { tabId: resolved.tabId },
          world: "MAIN",
          func: captureYoutubeTimedtextPotInMainWorld,
          args: [expectedVideoId, languageCode, kind]
        });
        const payload = results?.[0]?.result as
          | { observedTimedtextUrls?: string[]; skippedReason?: string }
          | null
          | undefined;
        const observedTimedtextUrls = Array.isArray(payload?.observedTimedtextUrls)
          ? payload.observedTimedtextUrls.filter(
              (u): u is string => typeof u === "string" && u.trim().length > 0
            )
          : [];
        return {
          ok: true,
          observedTimedtextUrls,
          ...(payload?.skippedReason ? { skippedReason: payload.skippedReason } : {})
        };
      })(),
      sendResponse,
      (error) => (error as Error | undefined)?.message || String(error)
    );
    return "hold";
  }

  function ensureSabrWorker(
    _message: YoutubeScriptingMsg<"youtube-ensure-sabr-worker">,
    sender: MessageSender,
    sendResponse: YoutubeScriptingReply<"youtube-ensure-sabr-worker">
  ): MessageReplyDecision {
    const resolved = resolveWatchScriptingTab(sender, "仅支持标签页内注入 YouTube 音频采集模块");
    if (!resolved.ok) {
      sendResponse(resolved);
      return "answered";
    }

    withOkResponse(
      (async () => {
        await resolved.scripting.executeScript({
          target: { tabId: resolved.tabId },
          world: "MAIN",
          files: [YOUTUBE_SABR_WORKER_FILE]
        });
        return { ok: true };
      })(),
      sendResponse,
      (error) => (error as Error | undefined)?.message || String(error)
    );
    return "hold";
  }

  return {
    pageSnapshot,
    captureTimedtextPot,
    ensureSabrWorker
  };
}
