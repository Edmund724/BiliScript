import { state, type ClipState } from "../core/state.js";
import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { formatClock } from "../shared/clock-text.js";
import { getReadingSubtitleItems, type ReadingSubtitleItem } from "../subtitle/core.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import type { MossLiveToolCall, MossLiveVideoContext, MossLiveVideoIdentity } from "./moss-live-protocol.js";
import { projectLiveOverview, type LiveOverviewSource } from "./live-overview-context.js";

export interface LiveToolsBridgeDeps {
  getClip?: () => Partial<ClipState>;
  getUrl?: () => string;
  getCurrentTime?: () => number;
  getPlayer?: () => HTMLVideoElement | null;
  getOverview?: () => LiveOverviewSource | null;
  ensureOverview?: (options?: { forceRefresh?: boolean }) => Promise<LiveOverviewSource | null>;
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

function projectVideoContext(
  clip: Partial<ClipState>,
  url: string,
  overviewSource: LiveOverviewSource | null
): MossLiveVideoContext | null {
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
    })),
    overview: projectLiveOverview(overviewSource, { fetchState: clip.subtitleFetchState })
  };
}

function projectVideoIdentity(context: MossLiveVideoContext): MossLiveVideoIdentity {
  return { bvid: context.bvid, cid: context.cid, pageIndex: context.pageIndex };
}

function projectOverviewResponse(
  context: MossLiveVideoContext,
  overview: NonNullable<ReturnType<typeof projectLiveOverview>>
): Record<string, unknown> {
  return {
    ok: true,
    video: projectVideoIdentity(context),
    coverage: overview.coverage,
    summary: overview.summary,
    chapters: overview.chapters,
    quotes: overview.quotes,
    ...(overview.failedRanges ? { failedRanges: overview.failedRanges } : {}),
    ...(overview.summaryFailed ? { summaryFailed: overview.summaryFailed } : {})
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

const PLAYER_RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];

export function createLiveToolsBridge(deps: LiveToolsBridgeDeps = {}): LiveToolsBridge {
  const getClip = deps.getClip || (() => state.clip);
  const getUrl = deps.getUrl || (() => location.href);
  const getPlayer = deps.getPlayer || getRuntimeVideoElement;
  const getCurrentTime = deps.getCurrentTime || (() => getPlayer()?.currentTime || 0);
  const showNotice = deps.showNotice || (() => {});
  const getOverview = deps.getOverview || (() => null);
  const ensureOverview = deps.ensureOverview;

  function getVideoContext(): MossLiveVideoContext | null {
    return projectVideoContext(getClip(), getUrl(), getOverview());
  }

  function contextMatchesCall(call: MossLiveToolCall, context: MossLiveVideoContext): boolean {
    if (call.video === undefined) return true;
    return Boolean(call.video &&
      call.video.bvid === context.bvid &&
      call.video.cid === context.cid &&
      call.video.pageIndex === context.pageIndex);
  }

  function playerSnapshot(command: string, video: HTMLVideoElement, context: MossLiveVideoContext, message: string) {
    return {
      ok: true,
      command,
      message,
      video: projectVideoIdentity(context),
      currentTime: video.currentTime,
      paused: video.paused,
      playbackRate: video.playbackRate
    };
  }

  async function controlPlayer(
    args: Record<string, unknown>,
    call: MossLiveToolCall,
    context: MossLiveVideoContext
  ): Promise<Record<string, unknown>> {
    const command = String(args.command || "").trim();
    if (!command) throw new Error("control_bilibili_player 缺少 command");
    if (command !== "seek" && command !== "pause" && command !== "play" && command !== "rate") {
      throw new Error(`不支持的播放器命令：${command}`);
    }

    let targetTime = 0;
    let targetRate = 0;
    if (command === "seek") {
      if (typeof args.time !== "number" || !Number.isFinite(args.time) || args.time < 0) {
        throw new Error("seek 需要有限且非负的 time（秒）");
      }
      targetTime = args.time;
    } else if (command === "rate") {
      if (typeof args.rate !== "number" || !PLAYER_RATES.includes(args.rate)) {
        throw new Error(`rate 需要有效倍速：${PLAYER_RATES.join("、")}`);
      }
      targetRate = args.rate;
    }

    const video = getPlayer();
    if (!video || !video.isConnected || video.readyState < 1) {
      const error = "播放器尚未就绪，请等待当前视频加载后再试。";
      showNotice(error, 4000);
      return { ok: false, error };
    }
    if (command === "seek" && Number.isFinite(video.duration) && targetTime > video.duration) {
      throw new Error(`跳转时间不能超出视频时长（${video.duration} 秒）`);
    }

    let message = "";
    if (command === "pause") {
      video.pause();
      message = "已暂停播放";
    } else if (command === "play") {
      await video.play();
      const currentContext = getVideoContext();
      if (getPlayer() !== video || !currentContext || !contextMatchesCall(call, currentContext)) {
        const error = "播放期间视频已切换，本次控制结果已失效。";
        showNotice(error, 4000);
        return { ok: false, error };
      }
      message = "已继续播放";
    } else if (command === "rate") {
      video.playbackRate = targetRate;
      message = `已切换到 ${targetRate} 倍速`;
    } else {
      video.currentTime = targetTime;
      message = `已跳转到 ${formatClock(targetTime, { hours: "auto" })}`;
    }

    const result = playerSnapshot(command, video, context, message);
    showNotice(message, 1800);
    return result;
  }

  async function executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>> {
    const toolName = String(call?.name || "").trim();
    const isPlayerControl = toolName === "control_bilibili_player";
    const isSummarizeVideo = toolName === "summarize_video";
    const statusNotice = isPlayerControl
      ? "正在控制当前视频播放器..."
      : isSummarizeVideo
        ? "正在生成全片概览..."
        : "正在查阅当前视频字幕...";
    showNotice(statusNotice, 1800);
    try {
      if (
        !isPlayerControl &&
        !isSummarizeVideo &&
        toolName !== "get_subtitles_around_time" &&
        toolName !== "search_video_subtitles"
      ) {
        throw new Error(`不支持的页面工具：${toolName || "未命名"}`);
      }
      const args = parseArguments(call.arguments);
      const clip = getClip();
      const context = projectVideoContext(clip, getUrl(), getOverview());
      if (!context || !contextMatchesCall(call, context)) {
        const result = { ok: false, error: "视频已切换或视频上下文尚未就绪，请稍后再试；不要沿用上一个视频的内容。" };
        showNotice(result.error, 4000);
        return result;
      }

      if (isPlayerControl) {
        return await controlPlayer(args, call, context);
      }

      if (isSummarizeVideo) {
        // 1. 缓存优先：已有完整或部分概览时直接返回，不受字幕当前加载状态阻碍
        const cachedSnapshot = getOverview();
        const cachedOverview = projectLiveOverview(cachedSnapshot, { fetchState: clip.subtitleFetchState });
        if (cachedOverview && (cachedOverview.coverage === "complete" || cachedOverview.coverage === "partial")) {
          const message = cachedOverview.coverage === "partial" ? "全片概览覆盖不完整" : "全片概览已就绪";
          showNotice(message, 1800);
          return projectOverviewResponse(context, cachedOverview);
        }

        // 2. 字幕守卫：尚未生成时必须依赖有效字幕
        if (clip.subtitleFetchState === "loading") {
          const message = "当前视频字幕仍在加载，请稍后重试。";
          showNotice(message, 4000);
          return { ok: false, error: message };
        }
        if (clip.subtitleFetchState === "error") {
          const message = "当前视频字幕加载失败，无法生成全片概览。";
          showNotice(message, 4000);
          return { ok: false, error: message };
        }
        const items = getReadingSubtitleItems(clip.subtitleBody || []);
        if (items.length === 0) {
          const message = "当前视频没有可用字幕，无法生成全片概览。";
          showNotice(message, 4000);
          return { ok: false, error: message };
        }

        if (!ensureOverview) {
          const message = "未接入概览生成管线，无法生成全片概览。";
          showNotice(message, 4000);
          return { ok: false, error: message };
        }

        showNotice("正在生成全片概览...", 35000);
        const shouldForceRefresh =
          cachedSnapshot?.phase === "error" || cachedSnapshot?.phase === "cancelled";
        const source = await ensureOverview({ forceRefresh: shouldForceRefresh });
        const currentContext = getVideoContext();
        if (!currentContext || !contextMatchesCall(call, currentContext)) {
          const error = "视频已切换，本次全片概览结果已失效。";
          showNotice(error, 4000);
          return { ok: false, error };
        }

        const overview = projectLiveOverview(source, { fetchState: getClip().subtitleFetchState });
        if (overview && (overview.coverage === "complete" || overview.coverage === "partial")) {
          const message = overview.coverage === "partial" ? "全片概览覆盖不完整" : "全片概览生成完成";
          showNotice(message, 1800);
          return projectOverviewResponse(currentContext, overview);
        }

        let error = overview?.statusText || source?.errorText || "全片概览生成失败";
        if (source?.phase === "cancelled") {
          error = source.errorText || "全片概览生成已取消，未生成全片概览。";
        } else if (source?.phase === "error") {
          error = source.errorText || "全片概览生成失败，请稍后重试。";
        }
        showNotice(error, 4000);
        return { ok: false, error };
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
          video: projectVideoIdentity(context),
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
        video: projectVideoIdentity(context),
        currentTime,
        window: { from, to },
        total: matches.length,
        items: matches
      };
    } catch (error) {
      const prefix = isPlayerControl
        ? "播放器控制失败"
        : isSummarizeVideo
          ? "全片概览生成失败"
          : "字幕工具执行失败";
      const message = `${prefix}：${(error as Error)?.message || String(error)}`;
      showNotice(message, 4000);
      return { ok: false, error: message };
    }
  }

  return { getVideoContext, executeTool };
}
