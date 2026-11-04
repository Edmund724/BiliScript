import { state, type ClipState } from "../core/state.js";
import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import { formatClock } from "../shared/clock-text.js";
import { getReadingSubtitleItems, type ReadingSubtitleItem } from "../subtitle/core.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import type { MossLiveToolCall, MossLiveVideoContext } from "./moss-live-protocol.js";

export interface LiveToolsBridgeDeps {
  getClip?: () => Partial<ClipState>;
  getUrl?: () => string;
  getCurrentTime?: () => number;
  showNotice?: (message: string, autoHideMs?: number) => void;
}

export interface LiveToolsBridge {
  getVideoContext(): MossLiveVideoContext | null;
  executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>>;
}

function finiteNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseArguments(raw: unknown): Record<string, unknown> {
  if (raw == null || raw === "") return {};
  if (typeof raw === "string") {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("工具参数必须是 JSON 对象");
    }
    return parsed as Record<string, unknown>;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  throw new Error("工具参数必须是 JSON 对象");
}

function clipMatchesPage(clip: Partial<ClipState>, url: string): boolean {
  const pageBvid = extractBvid(url);
  const clipBvid = String(clip.bvid || "").trim();
  if (!pageBvid || !clipBvid || pageBvid !== clipBvid || !String(clip.cid || "").trim()) {
    return false;
  }
  const clipPage = Number(clip.pageIndex) > 0 ? Number(clip.pageIndex) : 1;
  return clipPage === extractPageIndex(url);
}

function projectVideoContext(clip: Partial<ClipState>, url: string): MossLiveVideoContext | null {
  if (!clipMatchesPage(clip, url)) return null;
  return {
    url,
    bvid: String(clip.bvid || "").trim(),
    cid: String(clip.cid || "").trim(),
    title: String(clip.title || "").trim(),
    pageIndex: Number(clip.pageIndex) > 0 ? Number(clip.pageIndex) : 1,
    pageCount: Number(clip.pageCount) > 0 ? Number(clip.pageCount) : 0,
    pageTitle: String(clip.pageTitle || "").trim(),
    chapters: normalizeChapters(clip.chapters || []).map((chapter) => ({
      title: chapter.title,
      from: chapter.from,
      to: chapter.to
    }))
  };
}

function projectSubtitle(item: ReadingSubtitleItem): Record<string, unknown> {
  return {
    from: item.from,
    to: item.to,
    time: formatClock(item.from, { hours: "auto" }),
    content: item.content
  };
}

export function createLiveToolsBridge(deps: LiveToolsBridgeDeps = {}): LiveToolsBridge {
  const getClip = deps.getClip || (() => state.clip);
  const getUrl = deps.getUrl || (() => location.href);
  const getCurrentTime = deps.getCurrentTime || (() => state.reader.readingVideoEl?.currentTime || 0);
  const showNotice = deps.showNotice || (() => {});

  function getVideoContext(): MossLiveVideoContext | null {
    return projectVideoContext(getClip(), getUrl());
  }

  async function executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>> {
    const toolName = String(call?.name || "").trim();
    showNotice("正在查阅当前视频字幕...", 1800);
    try {
      if (toolName !== "get_subtitles_around_time" && toolName !== "search_video_subtitles") {
        throw new Error(`不支持的字幕工具：${toolName || "未命名"}`);
      }
      const args = parseArguments(call.arguments);
      const clip = getClip();
      const context = projectVideoContext(clip, getUrl());
      if (!context) {
        const result = { ok: false, error: "视频已切换或视频上下文尚未就绪，请稍后再试；不要沿用上一个视频的内容。" };
        showNotice(result.error, 4000);
        return result;
      }

      const items = getReadingSubtitleItems(clip.subtitleBody || []);
      if (items.length === 0) {
        const message = clip.subtitleFetchState === "loading"
          ? "当前视频字幕仍在加载，请稍后重试。"
          : clip.subtitleFetchState === "error"
            ? "当前视频字幕加载失败，本次无法检索。"
            : "当前视频没有可用字幕。";
        showNotice(message, 4000);
        return { ok: false, error: message };
      }

      if (toolName === "search_video_subtitles") {
        const query = String(args.query || "").trim();
        if (!query) {
          throw new Error("search_video_subtitles 缺少 query");
        }
        const limit = Math.round(clamp(finiteNumber(args.max_results ?? args.limit, 20), 1, 50));
        const needle = query.toLocaleLowerCase();
        const matchedItems = items.filter((item) => item.content.toLocaleLowerCase().includes(needle));
        return {
          ok: true,
          video: { bvid: context.bvid, cid: context.cid, pageIndex: context.pageIndex },
          query,
          total: matchedItems.length,
          items: matchedItems.slice(0, limit).map(projectSubtitle)
        };
      }

      const currentTime = Math.max(0, finiteNumber(
        args.current_time ?? args.time_seconds ?? args.time ?? args.seconds,
        getCurrentTime()
      ));
      const windowSeconds = finiteNumber(args.window_seconds, 30);
      const before = clamp(finiteNumber(args.before_seconds ?? args.before, windowSeconds), 0, 300);
      const after = clamp(finiteNumber(args.after_seconds ?? args.after, windowSeconds), 0, 300);
      const from = Math.max(0, currentTime - before);
      const to = currentTime + after;
      const matches = items
        .filter((item) => item.from <= to && (item.to > item.from ? item.to : item.from + 2) >= from)
        .map(projectSubtitle);
      return {
        ok: true,
        video: { bvid: context.bvid, cid: context.cid, pageIndex: context.pageIndex },
        currentTime,
        window: { from, to },
        total: matches.length,
        items: matches
      };
    } catch (error) {
      const message = `字幕工具执行失败：${(error as Error)?.message || String(error)}`;
      showNotice(message, 4000);
      return { ok: false, error: message };
    }
  }

  return { getVideoContext, executeTool };
}
