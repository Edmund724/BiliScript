import {
  YOUTUBE_UNIT_CID,
  cleanYoutubeWatchUrl,
  decodeVideoStorageBvid,
  detectSiteFromUrl,
  extractYoutubeVideoId,
  isYoutubeAutoOpenEligible,
  isYoutubeWatchPage,
  normalizeSiteId,
  type SiteId
} from "../shared/site.js";

function defaultHref(): string {
  return typeof location !== "undefined" ? location.href : "";
}

export function isReaderMode(url: string = defaultHref()): boolean {
  try {
    return new URL(url).searchParams.get("biliscript_reader") === "1";
  } catch {
    return false;
  }
}

export function stripReaderModeUrl(url: string = defaultHref()): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("biliscript_reader");
    return parsed.toString();
  } catch {
    return url;
  }
}

const PLAYLIST_PATH_RE = /^\/list\/(?:watchlater|ml\d+|\d+)\/?$/;
const FESTIVAL_PATH_RE = /^\/festival\/[^/]+\/?$/;

export function isWatchlaterPage(url: string = defaultHref()): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/list/watchlater";
  } catch {
    return false;
  }
}

export function isPlaylistPage(url: string = defaultHref()): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.bilibili.com" && PLAYLIST_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isFestivalPage(url: string = defaultHref()): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "www.bilibili.com" && FESTIVAL_PATH_RE.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isAutoOpenEligible(url: string = defaultHref()): boolean {
  if (detectSiteFromUrl(url) === "youtube") {
    return isYoutubeAutoOpenEligible(url);
  }
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    if (!parsed.pathname.startsWith("/video/")) {
      return false;
    }
    if (isWatchlaterPage(url)) {
      return false;
    }
    const from = (parsed.searchParams.get("from") || "").toLowerCase();
    const business = (parsed.searchParams.get("business") || "").toLowerCase();
    if (from.includes("watchlater") || business.includes("watchlater")) {
      return false;
    }
    if (
      from.includes("fav") ||
      from.includes("collection") ||
      business.includes("fav") ||
      business.includes("collection")
    ) {
      return false;
    }
    if (parsed.pathname.startsWith("/list/") || parsed.pathname.startsWith("/medialist/")) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isSupportedVideoPage(url: string = defaultHref()): boolean {
  if (detectSiteFromUrl(url) === "youtube") {
    return isYoutubeWatchPage(url);
  }
  if (isPlaylistPage(url)) {
    return true;
  }
  if (isFestivalPage(url)) {
    return Boolean(extractBvid(url));
  }
  try {
    return /\/video\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function parseLiveRoomId(url: string = defaultHref()): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "live.bilibili.com") {
      return "";
    }
    return parsed.pathname.match(/^\/(?:blanc\/)?(\d+)\/?$/)?.[1] ?? "";
  } catch {
    return "";
  }
}

export function isLiveRoomPage(
  url: string = defaultHref(),
  embedded: boolean = typeof window !== "undefined" ? window.self !== window.top : false
): boolean {
  if (!parseLiveRoomId(url)) return false;
  return embedded || !new URL(url).pathname.startsWith("/blanc/");
}

export function computeCurrentClipSignature(url: string = defaultHref()): string {
  if (detectSiteFromUrl(url) === "youtube") {
    const videoId = extractYoutubeVideoId(url);
    return `youtube|${videoId}|${YOUTUBE_UNIT_CID}`;
  }
  const bvid = extractBvid(url);
  const page = extractPageIndex(url);
  return [bvid, page].map((item) => String(item || "").trim()).join("|");
}

export function extractBvid(url: string): string {
  const match = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (match?.[1]) {
    return match[1];
  }

  try {
    const parsed = new URL(url);
    const fromQuery = String(parsed.searchParams.get("bvid") || "").trim();
    if (/^BV[0-9A-Za-z]+$/.test(fromQuery)) {
      return fromQuery;
    }
  } catch {
  }

  return "";
}

export function extractVideoId(url: string = defaultHref()): string {
  if (detectSiteFromUrl(url) === "youtube") {
    return extractYoutubeVideoId(url);
  }
  return extractBvid(url);
}

const WATCHLATER_TRACKING_PARAM_NAMES = new Set([
  "biliscript_reader",
  "spm_id_from",
  "vd_source",
  "from_spmid",
  "buvid",
  "is_story_h5",
  "plat_id",
  "seid",
  "search_source",
  "unique_k",
  "bbid",
  "fbclid",
  "gclid"
]);

const WATCHLATER_TRACKING_PARAM_PREFIXES = ["share_", "utm_"];

function isWatchlaterTrackingParam(name: string): boolean {
  const normalized = name.toLowerCase();
  if (WATCHLATER_TRACKING_PARAM_NAMES.has(normalized)) {
    return true;
  }
  return WATCHLATER_TRACKING_PARAM_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function cleanContextPreservingUrl(parsed: URL, normalizedPath: string): string {
  const cleaned = new URL(`https://www.bilibili.com${normalizedPath}`);
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!isWatchlaterTrackingParam(key)) {
      cleaned.searchParams.append(key, value);
    }
  }
  return cleaned.toString();
}

export function cleanVideoUrl(href: string = defaultHref()): string {
  if (detectSiteFromUrl(href) === "youtube") {
    return cleanYoutubeWatchUrl(href);
  }
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== "www.bilibili.com") {
      return href;
    }

    if (PLAYLIST_PATH_RE.test(parsed.pathname) || FESTIVAL_PATH_RE.test(parsed.pathname)) {
      return cleanContextPreservingUrl(parsed, parsed.pathname.replace(/\/+$/, ""));
    }

    const bvid = extractBvid(href);
    if (!bvid) {
      return href;
    }
    const p = parsed.searchParams.get("p");
    const qs = p ? `?p=${encodeURIComponent(p)}` : "";
    return `https://www.bilibili.com/video/${bvid}/${qs}`;
  } catch {
    return href;
  }
}

export function buildReaderModeUrl(rawUrl: string): string {
  const base = cleanVideoUrl(rawUrl);
  try {
    const parsed = new URL(base);
    parsed.searchParams.set("biliscript_reader", "1");
    return parsed.toString();
  } catch {
    return base;
  }
}

export function extractPageIndex(url: string): number {
  return extractPageIndexFromUrl(url);
}

export function extractPageIndexFromUrl(url: string): number {
  try {
    const page = Number(new URL(String(url || "")).searchParams.get("p") || "1");
    return Number.isFinite(page) && page > 0 ? page : 1;
  } catch {
    return 1;
  }
}

export function buildCanonicalVideoUrl(
  videoId: string,
  pageIndex: number | string = 1,
  site?: SiteId
): string {
  const safeId = String(videoId || "").trim();
  if (!safeId) {
    return "";
  }
  if (normalizeSiteId(site) === "youtube") {
    const decoded = decodeVideoStorageBvid(safeId);
    return decoded ? `https://www.youtube.com/watch?v=${encodeURIComponent(decoded)}` : "";
  }
  if (Number(pageIndex) > 1) {
    return `https://www.bilibili.com/video/${safeId}/?p=${Number(pageIndex)}`;
  }
  return `https://www.bilibili.com/video/${safeId}/`;
}

export function isSupportedBilibiliPage(url: unknown): boolean {
  try {
    const raw = String(url || "");
    const parsed = new URL(raw);
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    if (PLAYLIST_PATH_RE.test(parsed.pathname)) {
      return true;
    }
    if (FESTIVAL_PATH_RE.test(parsed.pathname)) {
      return Boolean(extractBvid(raw));
    }
    return parsed.pathname.startsWith("/video/");
  } catch {
    return false;
  }
}

export function isSupportedPage(url: unknown): boolean {
  if (typeof url !== "string" || !url) {
    return false;
  }
  return isSupportedBilibiliPage(url) || isYoutubeWatchPage(url);
}
