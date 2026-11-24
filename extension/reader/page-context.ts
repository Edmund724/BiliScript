import {
  BILI_HOST_SELECTORS,
  querySelectorFallback
} from "../bilibili/host-selectors.js";
import { getRuntimeVideoElement as defaultGetVideo } from "../bilibili/video-probe.js";
import { extractPageIndex } from "../bilibili/video-id-shared.js";
import { resolveVideoPageFromMeta } from "../bilibili/video-api.js";
import { isDomExceptionNamed } from "../shared/dom-utils.js";
import { detectSiteFromUrl, YOUTUBE_UNIT_CID } from "../shared/site.js";
import { getYoutubeVideoElement } from "../youtube/host-adapter.js";

interface PageItem {
  cid?: string | number;
  page?: string | number;
  part?: string;
  duration?: string | number;
}

interface PageContextMeta {
  aid?: string | number;
  defaultCid?: string | number;
  defaultDuration?: string | number;
  pages?: PageItem[];
}

interface PageContextCtx {
  href?: string;
  document?: { querySelector: (selector: string) => Element | null };
  __INITIAL_STATE__?: Record<string, unknown>;
  __PLAYER_STATE__?: Record<string, unknown>;
  __BILI_PLAYER__?: Record<string, unknown>;
}

interface PageContextOptions {
  ctx?: PageContextCtx;
  getVideo?: () => HTMLVideoElement | null;
  aid?: string | number;
  defaultCid?: string | number;
}

function parseUrlSafely(rawUrl: string | undefined | null): URL | null {
  if (!rawUrl || !URL.canParse(rawUrl)) {
    return null;
  }
  return new URL(rawUrl);
}

function readCrossOriginSafely<T>(reader: () => T): T | undefined {
  try {
    return reader();
  } catch (error) {
    if (isDomExceptionNamed(error, ["SecurityError"])) {
      return undefined;
    }
    throw error;
  }
}

function hasExplicitPageParam(url: string) {
  return parseUrlSafely(url)?.searchParams.has("p") ?? false;
}

function extractOid(url: string) {
  return String(parseUrlSafely(url)?.searchParams.get("oid") || "").trim();
}

function pickPageIndexFromOid(pages: PageItem[], oid: string | number, options: PageContextOptions = {}) {
  const safeOid = String(oid || "").trim();
  if (!safeOid) {
    return 0;
  }

  const safePages = Array.isArray(pages) ? pages : [];
  const pageByCid = safePages.find((item) => String(item?.cid || "") === safeOid);
  if (pageByCid?.page) {
    return Number(pageByCid.page) || 0;
  }

  const safeAid = String(options?.aid || "").trim();
  if (safeAid && safeOid === safeAid) {
    return readCurrentPageFromPageState(safePages, options?.defaultCid, options);
  }

  return 0;
}

function readCurrentPageFromPageState(pages: PageItem[], fallbackCid: string | number = "", options: PageContextOptions = {}) {
  const safePages = Array.isArray(pages) ? pages : [];
  const { ctx = {} } = options;

  const rawHref =
    readCrossOriginSafely(() => ctx.href) ||
    (typeof location !== "undefined" ? readCrossOriginSafely(() => location.href) : undefined) ||
    "";
  const pageFromUrl = Number(parseUrlSafely(rawHref)?.searchParams.get("p") || "0");
  if (Number.isFinite(pageFromUrl) && pageFromUrl > 0) {
    return pageFromUrl;
  }

  const globalWin = typeof window !== "undefined" ? window : undefined;
  const rootState = (readCrossOriginSafely(
    () => ctx.__INITIAL_STATE__ || globalWin?.__INITIAL_STATE__
  ) || {}) as Record<string, unknown>;
  const playerState = readCrossOriginSafely(
    () =>
      rootState?.player ||
      ctx.__PLAYER_STATE__ ||
      ctx.__BILI_PLAYER__ ||
      globalWin?.__PLAYER_STATE__ ||
      globalWin?.__BILI_PLAYER__
  ) as Record<string, unknown> | undefined;
  if (playerState) {
    const playerData = playerState.data as Record<string, unknown> | undefined;
    const candidates = [
      playerState.page,
      playerState.pageIndex,
      playerState.currentPage,
      playerData?.page,
      playerData?.pageIndex
    ];
    for (const value of candidates) {
      const pageFromState = Number(value || "0");
      if (Number.isFinite(pageFromState) && pageFromState > 0) {
        return pageFromState;
      }
    }
  }

  const videoData = (rootState?.videoData || rootState?.playletInfo) as Record<string, unknown> | undefined;
  if (videoData) {
    const videoInnerData = videoData.data as Record<string, unknown> | undefined;
    const pageFromVideoData = Number(
      videoData.page || videoData.pageIndex || videoData.currentPage || videoInnerData?.page || "0"
    );
    if (Number.isFinite(pageFromVideoData) && pageFromVideoData > 0) {
      return pageFromVideoData;
    }
    const cidFromVideoData = String(videoData.cid || videoInnerData?.cid || "");
    if (cidFromVideoData) {
      const matched = safePages.find((item) => String(item?.cid || "") === cidFromVideoData);
      if (matched?.page) {
        return Number(matched.page) || 0;
      }
    }
  }

  const pageFromDom = readPageFromPlayerDom(safePages, options);
  if (Number.isFinite(pageFromDom) && pageFromDom > 0) {
    return pageFromDom;
  }

  if (fallbackCid) {
    const pageByCid = safePages.find((item) => String(item?.cid || "") === String(fallbackCid));
    if (pageByCid?.page) {
      return Number(pageByCid.page) || 1;
    }
  }

  return safePages.length > 0 ? 1 : 0;
}

function readPageFromPlayerDom(pages: PageItem[], options: PageContextOptions = {}) {
  const safePages = Array.isArray(pages) ? pages : [];
  const { ctx = {}, getVideo = defaultGetVideo } = options;
  const doc =
    readCrossOriginSafely(() => ctx.document) ||
    (typeof document !== "undefined" ? document : null);

  const video = readCrossOriginSafely(() => getVideo());
  const src = String(video?.currentSrc || video?.src || "").trim();
  if (src) {
    const cidMatch = src.match(/[?&]cid=(\d+)/i);
    if (cidMatch) {
      const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
      if (matched?.page) {
        return Number(matched.page) || 0;
      }
    }
    const pageMatch = src.match(/[?&]page=(\d+)/i);
    if (pageMatch) {
      const page = Number(pageMatch[1]);
      if (Number.isFinite(page) && page > 0) {
        return page;
      }
    }
  }

  const iframeSrc = readCrossOriginSafely(() =>
    querySelectorFallback<HTMLIFrameElement>(BILI_HOST_SELECTORS.playerIframes, doc)?.src
  );
  if (iframeSrc) {
    const pageMatch = iframeSrc.match(/[?&]page=(\d+)/i);
    if (pageMatch) {
      const page = Number(pageMatch[1]);
      if (Number.isFinite(page) && page > 0) {
        return page;
      }
    }
    const cidMatch = iframeSrc.match(/[?&]cid=(\d+)/i);
    if (cidMatch) {
      const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
      if (matched?.page) {
        return Number(matched.page) || 0;
      }
    }
  }

  const playerText = readCrossOriginSafely(() => {
    const playerRoot = querySelectorFallback<Element>(
      [
        BILI_HOST_SELECTORS.playerControlWrap,
        `#bilibili-player ${BILI_HOST_SELECTORS.playerControlWrap}`,
        ".player-wrap"
      ],
      doc
    );
    return playerRoot?.textContent || "";
  });
  if (playerText) {
    const pageMatch = playerText.match(/(?:^|\s|第)\s*(\d+)\s*(?:集|话|P|part)/i);
    if (pageMatch) {
      const page = Number(pageMatch[1]);
      if (Number.isFinite(page) && page > 0) {
        return page;
      }
    }
  }

  return 0;
}

export function resolvePageContext(
  url: string,
  meta: PageContextMeta = {},
  options: PageContextOptions = {}
) {
  const safePages = Array.isArray(meta.pages) ? meta.pages : [];
  if (detectSiteFromUrl(url || options.ctx?.href) === "youtube") {
    const firstPage = safePages[0];
    const videoDuration = readCrossOriginSafely(() => {
      const video = (options.getVideo ?? (() => getYoutubeVideoElement(document)))();
      const raw = Number(video?.duration);
      return Number.isFinite(raw) && raw > 0 ? raw : 0;
    });
    const duration =
      Number(meta.defaultDuration || 0) ||
      Number(firstPage?.duration || 0) ||
      videoDuration ||
      0;
    const cid =
      String(meta.defaultCid || options.defaultCid || YOUTUBE_UNIT_CID).trim() ||
      YOUTUBE_UNIT_CID;
    const pageTitle = String(firstPage?.part || "").trim();
    return {
      pageIndex: 1,
      cid,
      cidSource: "youtube-unit",
      duration,
      pageTitle
    };
  }

  const defaultPageIndex = extractPageIndex(url);
  const oid = extractOid(url);
  const hasPageParam = hasExplicitPageParam(url);

  let resolvedPageIndex = defaultPageIndex;
  if (safePages.length > 1 && !hasPageParam) {
    const pageIndexFromOid = pickPageIndexFromOid(safePages, oid, {
      aid: meta.aid,
      defaultCid: meta.defaultCid,
      ...options
    });
    if (pageIndexFromOid > 0) {
      resolvedPageIndex = pageIndexFromOid;
    } else {
      resolvedPageIndex = 1;
    }
  }

  const resolved = resolveVideoPageFromMeta(meta, { pageIndex: resolvedPageIndex });
  if (!resolved.cid) {
    throw new Error("没有找到当前分P的 CID。");
  }
  return {
    pageIndex: resolvedPageIndex,
    cid: resolved.cid,
    cidSource: "meta-pages",
    duration: resolved.duration,
    pageTitle: resolved.pageTitle
  };
}
