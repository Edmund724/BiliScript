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

function isUpowerBlockedPayload(data: Record<string, unknown> | null | undefined): boolean {
  return Boolean(data?.is_upower_exclusive) && !Boolean(data?.is_upower_play);
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

export async function fetchSubtitleBundle(
  transport: JsonTransport,
  { bvid, cid, aid }: { bvid?: string | number; cid?: string | number; aid?: string | number }
): Promise<{ tracks: SubtitleTrack[]; chapters: Chapter[]; upowerBlocked?: boolean }> {
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
): Promise<{ tracks: SubtitleTrack[]; chapters: Chapter[]; upowerBlocked?: boolean }> {
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
    return { chapters, withUrl, upowerBlocked };
  };

  if (requests.length === 0) {
    return { tracks: [], chapters: [] };
  }

  const primaryRequest = requests[0];
  try {
    const primaryResult = await fetchByRequest(primaryRequest);
    const extra = primaryResult.upowerBlocked ? { upowerBlocked: true } : {};
    return {
      tracks: primaryResult.withUrl,
      chapters: primaryResult.chapters,
      ...extra
    };
  } catch (primaryError) {
    if (requests.length > 1) {
      const secondaryResult = await fetchByRequest(requests[1]);
      const extra = secondaryResult.upowerBlocked ? { upowerBlocked: true } : {};
      return {
        tracks: secondaryResult.withUrl,
        chapters: secondaryResult.chapters,
        ...extra
      };
    }
    throw primaryError;
  }
}
