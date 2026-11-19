import { formatLocalDate } from "../shared/utils.js";
import { getErrorMessage, toReadableText } from "../shared/error-helpers.js";
import { logInfo, logWarn } from "../shared/logging.js";
import type { JsonTransport } from "./gateway-core.js";
import {
  buildSubtitleInfoRequests,
  buildBiliApiError,
  type SubtitleInfoRequest
} from "./bili-api-shared.js";
import { mapChaptersFromPlayerData, mapSubtitleTracks } from "./native-payload.js";

export interface VideoPage {
  cid: string;
  page: number;
  part: string;
  duration: number;
}

export interface VideoPageQuery {
  cid?: string;
  pageIndex?: number;
}

export interface VideoMetaLike {
  aid?: string | number;
  defaultCid?: string | number;
  defaultDuration?: string | number;
  pages?: ReadonlyArray<{
    cid?: string | number;
    page?: string | number;
    part?: string;
    duration?: string | number;
  }>;
}

export interface ResolvedVideoPage {
  page: VideoPage | null;
  cid: string;
  pageIndex: number;
  pageTitle: string;
  duration: number;
  pageCount: number;
}

export interface VideoMeta {
  aid: string;
  title: string;
  author: string;
  description: string;
  uploadDate: string;
  defaultCid: string;
  defaultDuration: number;
  pages: VideoPage[];
  upowerBlocked?: boolean;
}

/**
 * 从视频元信息中按 `cid` → `page === pageIndex` → `pages[pageIndex - 1]` 顺序解析当前分P，
 * 并统一处理 cid / duration / pageIndex 的兜底逻辑。
 */
export function resolveVideoPageFromMeta(
  meta: VideoMetaLike | null | undefined,
  query: VideoPageQuery = {}
): ResolvedVideoPage {
  const rawPages = Array.isArray(meta?.pages) ? meta.pages : [];
  const pages: VideoPage[] = rawPages.map((item) => ({
    cid: String(item?.cid ?? "").trim(),
    page: Number(item?.page || 0) || 0,
    part: String(item?.part || "").trim(),
    duration: Number(item?.duration || 0) || 0
  }));

  const targetCid = String(query.cid || "").trim();
  const hasExplicitPage = query.pageIndex !== undefined && Number(query.pageIndex) > 0;
  const safePageIndex = hasExplicitPage ? Math.floor(Number(query.pageIndex)) : 1;

  let matched: VideoPage | null = null;
  if (targetCid) {
    matched = pages.find((item) => item.cid === targetCid) || null;
  }
  if (!matched) {
    matched =
      pages.find((item) => item.page === safePageIndex && Boolean(item.cid)) ||
      pages.find((item) => item.page === safePageIndex) ||
      null;
  }
  if (!matched && safePageIndex > 0) {
    const byPos = pages[safePageIndex - 1];
    if (byPos) {
      matched = byPos;
    }
  }

  const firstWithCid = pages.find((item) => Boolean(item.cid));
  const cid = String(targetCid || matched?.cid || firstWithCid?.cid || meta?.defaultCid || "").trim();
  const firstWithDuration = pages.find((item) => item.duration > 0);
  const duration =
    (matched && matched.duration > 0 ? matched.duration : 0) ||
    firstWithDuration?.duration ||
    (Number(meta?.defaultDuration || 0) || 0);
  const pageIndex = matched?.page && matched.page > 0 ? matched.page : safePageIndex;
  const pageTitle = matched?.part || "";

  return {
    page: matched,
    cid,
    pageIndex,
    pageTitle,
    duration,
    pageCount: pages.length
  };
}

export async function fetchSubtitleBodyJson<T = unknown>(
  transport: JsonTransport,
  url: string
): Promise<T[]> {
  logInfo("[BILISCRIPT] fetch subtitle body", { url });
  const payload = await transport(url);
  return Array.isArray((payload as { body?: unknown })?.body) ? (payload as { body: T[] }).body : [];
}

function isUpowerBlockedPayload(data: Record<string, unknown> | null | undefined): boolean {
  return Boolean(data?.is_upower_exclusive) && !Boolean(data?.is_upower_play);
}

function isLoginRequiredPayload(data: Record<string, unknown> | null | undefined): boolean {
  if (!data) {
    return false;
  }
  if (Boolean(data.need_login_subtitle)) {
    return true;
  }
  return data.login_mid === 0 || data.login_mid === "0";
}

export async function fetchVideoMeta(transport: JsonTransport, bvid: string): Promise<VideoMeta> {
  const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
  logInfo("[BILISCRIPT] fetch video meta", { url, bvid });
  const payload = await transport(url);
  if ((payload as { code?: unknown })?.code !== 0) {
    throw new Error(toReadableText((payload as { message?: unknown })?.message, "无法获取视频信息"));
  }

  const data = (payload as { data?: Record<string, unknown> }).data || {};
  const pubdate = Number(data.pubdate || 0);
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const upowerBlocked = isUpowerBlockedPayload(data);

  return {
    aid: String(data.aid || ""),
    title: String(data.title || ""),
    author: String((data.owner as { name?: unknown })?.name || ""),
    description: String(data.desc || ""),
    uploadDate: pubdate > 0 ? formatLocalDate(pubdate * 1000) : "",
    defaultCid: data.cid ? String(data.cid) : "",
    defaultDuration: Number(data.duration || 0) || 0,
    pages: pages.map((item) => ({
      cid: String((item as { cid?: unknown })?.cid || ""),
      page: Number((item as { page?: unknown })?.page || 0) || 0,
      part: String((item as { part?: unknown })?.part || "").trim(),
      duration: Number((item as { duration?: unknown })?.duration || 0) || 0
    })),
    ...(upowerBlocked ? { upowerBlocked: true } : {})
  };
}

export interface SubtitleTrack {
  id: string;
  lan: string;
  lanDoc: string;
  subtitleUrl: string;
  source: string;
}

export interface Chapter {
  title: string;
  from: number;
  to: number;
  source: string;
}

export interface SubtitleBundleResult {
  tracks: SubtitleTrack[];
  chapters: Chapter[];
  upowerBlocked?: boolean;
  loginRequired?: boolean;
}

function buildSubtitleBundleResult(result: {
  chapters: Chapter[];
  withUrl: SubtitleTrack[];
  upowerBlocked: boolean;
  loginRequired: boolean;
}): SubtitleBundleResult {
  return {
    tracks: result.withUrl,
    chapters: result.chapters,
    ...(result.upowerBlocked ? { upowerBlocked: true } : {}),
    ...(result.loginRequired ? { loginRequired: true } : {})
  };
}

export async function fetchSubtitleBundle(
  transport: JsonTransport,
  { bvid, cid, aid }: { bvid?: string | number; cid?: string | number; aid?: string | number }
): Promise<SubtitleBundleResult> {
  try {
    return await fetchSubtitleBundleInner(transport, { bvid, cid, aid });
  } catch (error) {
    logWarn("[BILISCRIPT] subtitles API request failed", {
      bvid,
      cid,
      aid,
      message: getErrorMessage(error)
    });
    throw error;
  }
}

async function fetchSubtitleBundleInner(
  transport: JsonTransport,
  { bvid, cid, aid }: { bvid?: string | number; cid?: string | number; aid?: string | number }
): Promise<SubtitleBundleResult> {
  logInfo("[BILISCRIPT] fetch subtitles list", { bvid, cid, aid });
  const requests: SubtitleInfoRequest[] = buildSubtitleInfoRequests({ bvid, cid, aid });

  const fetchByRequest = async (request: SubtitleInfoRequest) => {
    const payload = await transport(request.url);
    if ((payload as { code?: unknown })?.code !== 0) {
      throw buildBiliApiError(payload, "无法获取字幕列表");
    }

    const data = (payload as { data?: Record<string, unknown> }).data;
    const chapters = mapChaptersFromPlayerData(data) as Chapter[];
    const subtitles = mapSubtitleTracks(
      ((data as { subtitle?: { subtitles?: unknown } } | undefined)?.subtitle?.subtitles || []) as unknown[],
      request.source
    ) as SubtitleTrack[];
    const withUrl = subtitles.filter((item) => item.subtitleUrl);
    const upowerBlocked = isUpowerBlockedPayload(data);
    const loginRequired = isLoginRequiredPayload(data);
    return { chapters, withUrl, upowerBlocked, loginRequired };
  };

  if (requests.length === 0) {
    return { tracks: [], chapters: [] };
  }

  const primaryRequest = requests[0];
  try {
    return buildSubtitleBundleResult(await fetchByRequest(primaryRequest));
  } catch (primaryError) {
    if (requests.length > 1) {
      return buildSubtitleBundleResult(await fetchByRequest(requests[1]));
    }
    throw primaryError;
  }
}
