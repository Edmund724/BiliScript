import {
  BILI_HOST_SELECTORS,
  querySelectorFallback
} from "../bilibili/host-selectors.js";
import { getRuntimeVideoElement as defaultGetVideo } from "../bilibili/video-probe.js";
import { extractPageIndex } from "../bilibili/video-id-shared.js";
import { resolveVideoPageFromMeta } from "../bilibili/video-api.js";

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

function hasExplicitPageParam(url: string) {
  try {
    return new URL(url).searchParams.has("p");
  } catch {
    return false;
  }
}

function extractOid(url: string) {
  try {
    return String(new URL(url).searchParams.get("oid") || "").trim();
  } catch {
    return "";
  }
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
  const { ctx = {}, getVideo = defaultGetVideo } = options;

  try {
    const pageFromUrl = Number(new URL(ctx.href || location.href).searchParams.get("p") || "0");
    if (Number.isFinite(pageFromUrl) && pageFromUrl > 0) {
      return pageFromUrl;
    }
  } catch {
  }

  try {
    const rootState = (ctx.__INITIAL_STATE__ || window?.__INITIAL_STATE__ || {}) as Record<string, unknown>;
    const playerState =
      (rootState.player || ctx.__PLAYER_STATE__ || ctx.__BILI_PLAYER__ || window?.__PLAYER_STATE__ || window?.__BILI_PLAYER__) as Record<string, unknown> | undefined;
    if (playerState) {
      const candidates = [
        playerState.page,
        playerState.pageIndex,
        playerState.currentPage,
        (playerState.data as Record<string, unknown> | undefined)?.page,
        (playerState.data as Record<string, unknown> | undefined)?.pageIndex
      ];
      for (const value of candidates) {
        const pageFromState = Number(value || "0");
        if (Number.isFinite(pageFromState) && pageFromState > 0) {
          return pageFromState;
        }
      }
    }

    const videoData = (rootState.videoData || rootState.playletInfo) as Record<string, unknown> | undefined;
    if (videoData) {
      const pageFromVideoData = Number(
        videoData.page || videoData.pageIndex || videoData.currentPage || (videoData.data as Record<string, unknown> | undefined)?.page || "0"
      );
      if (Number.isFinite(pageFromVideoData) && pageFromVideoData > 0) {
        return pageFromVideoData;
      }
      const cidFromVideoData = String(videoData.cid || (videoData.data as Record<string, unknown> | undefined)?.cid || "");
      if (cidFromVideoData) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidFromVideoData);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
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
  const doc = ctx.document || document;

  try {
    const video = getVideo();
    if (video) {
      const src = String(video.currentSrc || video.src || "").trim();
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
    }
  } catch {
  }

  try {
    const iframe = querySelectorFallback<HTMLIFrameElement>(
      BILI_HOST_SELECTORS.playerIframes,
      doc
    );
    if (iframe?.src) {
      const pageMatch = iframe.src.match(/[?&]page=(\d+)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
      const cidMatch = iframe.src.match(/[?&]cid=(\d+)/i);
      if (cidMatch) {
        const matched = safePages.find((item) => String(item?.cid || "") === cidMatch[1]);
        if (matched?.page) {
          return Number(matched.page) || 0;
        }
      }
    }
  } catch {
  }

  try {
    const playerRoot = querySelectorFallback<Element>(
      [
        BILI_HOST_SELECTORS.playerControlWrap,
        `#bilibili-player ${BILI_HOST_SELECTORS.playerControlWrap}`,
        ".player-wrap"
      ],
      doc
    );
    if (playerRoot) {
      const text = playerRoot.textContent || "";
      const pageMatch = text.match(/(?:^|\s|第)\s*(\d+)\s*(?:集|话|P|part)/i);
      if (pageMatch) {
        const page = Number(pageMatch[1]);
        if (Number.isFinite(page) && page > 0) {
          return page;
        }
      }
    }
  } catch {
  }

  return 0;
}

export function resolvePageContext(
  url: string,
  meta: PageContextMeta = {},
  options: PageContextOptions = {}
) {
  const safePages = Array.isArray(meta.pages) ? meta.pages : [];
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
