export function isReaderMode(url: string = location.href): boolean {
  try {
    return new URL(url).searchParams.get("biliscript_reader") === "1";
  } catch {
    return false;
  }
}

export function stripReaderModeUrl(url: string = location.href): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("biliscript_reader");
    return parsed.toString();
  } catch {
    return url;
  }
}

export function isWatchlaterPage(url: string = location.href): boolean {
  try {
    return new URL(url).pathname.replace(/\/+$/, "") === "/list/watchlater";
  } catch {
    return false;
  }
}

export function isAutoOpenEligible(url: string = location.href): boolean {
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

export function isSupportedVideoPage(url: string = location.href): boolean {
  if (isWatchlaterPage(url)) {
    return true;
  }
  try {
    return /\/video\//.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function parseLiveRoomId(url: string = location.href): string {
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

export function isLiveRoomPage(url: string = location.href, embedded: boolean = window.self !== window.top): boolean {
  if (!parseLiveRoomId(url)) return false;
  return embedded || !new URL(url).pathname.startsWith("/blanc/");
}

export function computeCurrentClipSignature(url: string = location.href): string {
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

function cleanWatchlaterUrl(parsed: URL): string {
  const cleaned = new URL("https://www.bilibili.com/list/watchlater");
  for (const [key, value] of parsed.searchParams.entries()) {
    if (!isWatchlaterTrackingParam(key)) {
      cleaned.searchParams.append(key, value);
    }
  }
  return cleaned.toString();
}

export function cleanVideoUrl(href: string = location.href): string {
  try {
    const parsed = new URL(href);
    if (parsed.hostname !== "www.bilibili.com") {
      return href;
    }

    if (parsed.pathname === "/list/watchlater" || parsed.pathname === "/list/watchlater/") {
      return cleanWatchlaterUrl(parsed);
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

export function buildCanonicalVideoUrl(bvid: string, pageIndex: number | string = 1): string {
  const safeBvid = String(bvid || "").trim();
  if (!safeBvid) {
    return "";
  }
  if (Number(pageIndex) > 1) {
    return `https://www.bilibili.com/video/${safeBvid}/?p=${Number(pageIndex)}`;
  }
  return `https://www.bilibili.com/video/${safeBvid}/`;
}

export function isSupportedBilibiliPage(url: unknown): boolean {
  try {
    const parsed = new URL(String(url || ""));
    if (parsed.hostname !== "www.bilibili.com") {
      return false;
    }
    return (
      parsed.pathname === "/list/watchlater" ||
      parsed.pathname === "/list/watchlater/" ||
      parsed.pathname.startsWith("/video/")
    );
  } catch {
    return false;
  }
}
