export type SiteId = "bilibili" | "youtube";

export const YOUTUBE_UNIT_CID = "yt" as const;
export const YOUTUBE_STORAGE_KEY_PREFIX = "yt~" as const;

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export interface SiteCapabilities {
  readonly supportsAsr: boolean;
  readonly supportsLiveCompanion: boolean;
  readonly supportsNativeBilingualPair: boolean;
  readonly supportsPlayerInterpretOverlay: boolean;
  readonly supportsPlayerQuickAiButton: boolean;
  readonly supportsExtraPlaybackRates: boolean;
  readonly supportsCurrentFrameCapture: boolean;
  readonly supportsHistoricalFrameCapture: boolean;
  readonly supportsHotComments: boolean;
  readonly supportsAgentBridge: boolean;
  readonly supportsMultiPage: boolean;
}

const SITE_CAPABILITIES: Record<SiteId, SiteCapabilities> = Object.freeze({
  bilibili: Object.freeze({
    supportsAsr: true,
    supportsLiveCompanion: true,
    supportsNativeBilingualPair: true,
    supportsPlayerInterpretOverlay: true,
    supportsPlayerQuickAiButton: true,
    supportsExtraPlaybackRates: true,
    supportsCurrentFrameCapture: true,
    supportsHistoricalFrameCapture: true,
    supportsHotComments: true,
    supportsAgentBridge: true,
    supportsMultiPage: true
  }),
  youtube: Object.freeze({
    supportsAsr: true,
    supportsLiveCompanion: false,
    supportsNativeBilingualPair: false,
    supportsPlayerInterpretOverlay: true,
    supportsPlayerQuickAiButton: true,
    supportsExtraPlaybackRates: false,
    supportsCurrentFrameCapture: true,
    supportsHistoricalFrameCapture: true,
    supportsHotComments: true,
    supportsAgentBridge: true,
    supportsMultiPage: false
  })
});

function defaultHref(): string {
  return typeof location !== "undefined" ? location.href : "";
}

export function normalizeSiteId(value: unknown): SiteId {
  return typeof value === "string" && value.trim().toLowerCase() === "youtube"
    ? "youtube"
    : "bilibili";
}

export function getSiteCapabilities(site: SiteId | unknown = "bilibili"): SiteCapabilities {
  return SITE_CAPABILITIES[normalizeSiteId(site)];
}

export function detectSiteFromUrl(url?: unknown): SiteId {
  const target = arguments.length === 0 ? defaultHref() : url;
  try {
    const host = new URL(String(target || "")).hostname.toLowerCase();
    if (host === "youtube.com" || host.endsWith(".youtube.com") || host === "youtu.be") {
      return "youtube";
    }
  } catch {
  }
  return "bilibili";
}

export function detectActiveSite(): SiteId {
  return detectSiteFromUrl(defaultHref());
}

export function extractYoutubeVideoId(url?: unknown): string {
  const target = arguments.length === 0 ? defaultHref() : url;
  if (typeof target !== "string" || !target) {
    return "";
  }
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== "https:" || parsed.hostname !== "www.youtube.com") {
      return "";
    }
    if (parsed.pathname.replace(/\/+$/, "") !== "/watch") {
      return "";
    }
    const videoId = parsed.searchParams.get("v") || "";
    return YOUTUBE_VIDEO_ID_RE.test(videoId) ? videoId : "";
  } catch {
    return "";
  }
}

export function isYoutubeWatchPage(url?: unknown): boolean {
  const target = arguments.length === 0 ? defaultHref() : url;
  return Boolean(extractYoutubeVideoId(target));
}

export function isYoutubeAutoOpenEligible(url?: unknown): boolean {
  const target = arguments.length === 0 ? defaultHref() : url;
  if (!isYoutubeWatchPage(target)) {
    return false;
  }
  try {
    const parsed = new URL(String(target || ""));
    return !parsed.searchParams.has("list");
  } catch {
    return false;
  }
}

export function cleanYoutubeWatchUrl(url?: string): string {
  const target = arguments.length === 0 ? defaultHref() : url;
  if (typeof target !== "string") {
    return String(target ?? "");
  }
  const videoId = extractYoutubeVideoId(target);
  return videoId ? `https://www.youtube.com/watch?v=${videoId}` : target;
}

export function isToastEligibleHostPage(url: unknown): boolean {
  try {
    const hostname = new URL(String(url || "")).hostname;
    return hostname === "www.bilibili.com" || hostname === "www.youtube.com";
  } catch {
    return false;
  }
}

export function isEncodedYoutubeStorageBvid(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(YOUTUBE_STORAGE_KEY_PREFIX);
}

export function encodeVideoStorageBvid(site: SiteId | unknown, rawVideoId: string): string {
  const raw = String(rawVideoId ?? "").trim();
  if (!raw) {
    return "";
  }
  if (normalizeSiteId(site) !== "youtube") {
    return raw;
  }
  if (isEncodedYoutubeStorageBvid(raw)) {
    return raw;
  }
  return `${YOUTUBE_STORAGE_KEY_PREFIX}${raw.replace(/~/g, "~t").replace(/_/g, "~u")}`;
}

export function decodeVideoStorageBvid(storedBvid: string): string {
  const raw = String(storedBvid ?? "").trim();
  if (!isEncodedYoutubeStorageBvid(raw)) {
    return raw;
  }
  return raw
    .slice(YOUTUBE_STORAGE_KEY_PREFIX.length)
    .replace(/~([tu])/g, (_, code: string) => (code === "u" ? "_" : "~"));
}

export interface VideoStorageKey {
  site: SiteId;
  bvid: string;
  cid: string;
}

export function resolveVideoStorageKey(
  site: SiteId | unknown,
  rawVideoId: string,
  cid: string | number = ""
): VideoStorageKey {
  const normalizedSite = normalizeSiteId(site);
  if (normalizedSite === "youtube") {
    return {
      site: "youtube",
      bvid: encodeVideoStorageBvid("youtube", rawVideoId),
      cid: YOUTUBE_UNIT_CID
    };
  }
  return {
    site: "bilibili",
    bvid: encodeVideoStorageBvid("bilibili", rawVideoId),
    cid: String(cid ?? "").trim()
  };
}
