import { state, type ClipState } from "../core/state.js";
import { extractBvid, extractPageIndex, isPlaylistPage, parseLiveRoomId } from "../bilibili/video-id-shared.js";
import { getRuntimeVideoElement } from "../bilibili/video-probe.js";
import { formatClock } from "../shared/clock-text.js";
import { getReadingSubtitleItems, type ReadingSubtitleItem } from "../subtitle/core.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import type { MossLiveToolCall, MossLiveVideoContext, MossLiveVideoIdentity } from "./moss-live-protocol.js";
import { projectLiveOverview, type LiveOverviewSource } from "./live-overview-context.js";
import {
  ensureReaderOverviewSource,
  getReaderOverviewSource
} from "../reader/live-overview-source.js";

export interface LiveToolsBridgeDeps {
  getClip?: () => Partial<ClipState>;
  getUrl?: () => string;
  getCurrentTime?: () => number;
  getPlayer?: () => HTMLVideoElement | null;
  getVideoBaseVolume?: () => number | null;
  setVideoBaseVolume?: (volume: number) => number | null;
  isSharingVideoAudio?: () => boolean;
  getOverview?: () => LiveOverviewSource | null;
  ensureOverview?: (options?: { forceRefresh?: boolean }) => Promise<LiveOverviewSource | null>;
  showNotice?: (message: string, autoHideMs?: number) => void;
  now?: () => number;
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
  if (isPlaylistPage(url)) {
    try {
      const parsed = new URL(url);
      if (parsed.searchParams.has("p")) {
        const clipPage = Number(clip.pageIndex) > 0 ? Number(clip.pageIndex) : 1;
        return clipPage === extractPageIndex(url);
      }
      const oid = String(parsed.searchParams.get("oid") || "").trim();
      if (oid && clip.cid && oid !== clip.cid && oid !== String(clip.aid || "").trim()) {
        return false;
      }
    } catch {}
    return true;
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

export const MIN_PLAYER_PLAYBACK_RATE = 0.5;
export const MAX_PLAYER_PLAYBACK_RATE = 4;
export const PLAYER_CONTROL_DEDUP_WINDOW_MS = 500;

type PlayerCommand = "seek" | "seekBy" | "pause" | "play" | "rate" | "volume";
type PlayerControlAxis = "time" | "playstate" | "rate" | "volume";

interface RecentPlayerControlEntry {
  videoKey: string;
  signature: string;
  turnId: string;
  at: number;
  promise: Promise<Record<string, unknown>>;
}

function normalizePlayerCommand(raw: unknown): PlayerCommand {
  const command = String(raw || "").trim();
  if (!command) throw new Error("control_bilibili_player 缺少 command");
  switch (command) {
    case "seek":
    case "seekTo":
      return "seek";
    case "seekBy":
    case "seek_by":
      return "seekBy";
    case "pause":
    case "play":
    case "volume":
      return command;
    case "rate":
    case "setPlaybackRate":
      return "rate";
    default:
      throw new Error(`不支持的播放器命令：${command}`);
  }
}

function clampVideoTime(targetSeconds: number, video: HTMLVideoElement): number {
  const maxTime = Number.isFinite(video.duration) && video.duration >= 0
    ? video.duration
    : Number.POSITIVE_INFINITY;
  return clamp(targetSeconds, 0, maxTime);
}

function playerCommandAxis(command: PlayerCommand): PlayerControlAxis {
  if (command === "seek" || command === "seekBy") return "time";
  if (command === "pause" || command === "play") return "playstate";
  return command;
}

export function createLiveToolsBridge(deps: LiveToolsBridgeDeps = {}): LiveToolsBridge {
  const getClip = deps.getClip || (() => state.clip);
  const getUrl = deps.getUrl || (() => location.href);
  const getPlayer = deps.getPlayer || getRuntimeVideoElement;
  const getCurrentTime = deps.getCurrentTime || (() => getPlayer()?.currentTime || 0);
  const showNotice = deps.showNotice || (() => {});
  const getOverview = deps.getOverview || getReaderOverviewSource;
  const ensureOverview = deps.ensureOverview || ensureReaderOverviewSource;
  const now = deps.now || Date.now;
  const recentPlayerControls = new Map<PlayerControlAxis, RecentPlayerControlEntry>();

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

  function readBaseVolume(video: HTMLVideoElement): number {
    const provided = deps.getVideoBaseVolume?.();
    if (typeof provided === "number" && Number.isFinite(provided)) {
      return clamp(provided, 0, 1);
    }
    return Number.isFinite(video.volume) ? clamp(video.volume, 0, 1) : 1;
  }

  function writeBaseVolume(video: HTMLVideoElement, nextVolume: number): number {
    const clamped = clamp(nextVolume, 0, 1);
    const applied = deps.setVideoBaseVolume?.(clamped);
    if (typeof applied === "number" && Number.isFinite(applied)) {
      return clamp(applied, 0, 1);
    }
    video.volume = clamped;
    return clamped;
  }

  function playerSnapshot(command: string, video: HTMLVideoElement, context: MossLiveVideoContext, message: string) {
    return {
      ok: true,
      command,
      message,
      video: projectVideoIdentity(context),
      currentTime: video.currentTime,
      paused: video.paused,
      playbackRate: video.playbackRate,
      volume: Math.round(readBaseVolume(video) * 100),
      muted: Boolean(video.muted)
    };
  }

  async function controlPlayer(
    args: Record<string, unknown>,
    call: MossLiveToolCall,
    context: MossLiveVideoContext
  ): Promise<Record<string, unknown>> {
    const command = normalizePlayerCommand(args.command);

    let targetTime = 0;
    let offsetSeconds = 0;
    let targetRate = 0;
    const hasVolume = args.volume !== undefined;
    const hasDelta = args.delta !== undefined;
    const hasMuted = args.muted !== undefined;
    if (command === "seek") {
      if (typeof args.time !== "number" || !Number.isFinite(args.time)) {
        throw new Error("seek 需要有限数值 time（秒）");
      }
      targetTime = args.time;
    } else if (command === "seekBy") {
      const rawOffset = args.offset !== undefined ? args.offset : args.delta;
      if (typeof rawOffset !== "number" || !Number.isFinite(rawOffset)) {
        throw new Error("seekBy 需要有限数值 offset（秒）");
      }
      offsetSeconds = rawOffset;
    } else if (command === "rate") {
      if (
        typeof args.rate !== "number" ||
        !Number.isFinite(args.rate) ||
        args.rate < MIN_PLAYER_PLAYBACK_RATE ||
        args.rate > MAX_PLAYER_PLAYBACK_RATE
      ) {
        throw new Error(`rate 需要 ${MIN_PLAYER_PLAYBACK_RATE} 到 ${MAX_PLAYER_PLAYBACK_RATE} 之间的有限倍速`);
      }
      targetRate = args.rate;
    } else if (command === "volume") {
      if (!hasVolume && !hasDelta && !hasMuted) {
        throw new Error("volume 需要至少提供 volume、delta 或 muted 之一");
      }
      if (hasVolume && hasDelta) {
        throw new Error("volume 与 delta 不能同时指定");
      }
      if (hasVolume && (typeof args.volume !== "number" || !Number.isFinite(args.volume) || args.volume < 0 || args.volume > 100)) {
        throw new Error("volume 需要 0 到 100 之间的有限数值");
      }
      if (hasDelta && (typeof args.delta !== "number" || !Number.isFinite(args.delta) || args.delta < -100 || args.delta > 100)) {
        throw new Error("delta 需要 -100 到 100 之间的有限数值");
      }
      if (hasMuted && typeof args.muted !== "boolean") {
        throw new Error("muted 需要布尔值");
      }
    }

    const video = getPlayer();
    if (!video || !video.isConnected || video.readyState < 1) {
      const error = "播放器尚未就绪，请等待当前视频加载后再试。";
      showNotice(error, 4000);
      return { ok: false, error };
    }

    const axis = playerCommandAxis(command);
    const signature = command === "seek"
      ? `seek:${targetTime}`
      : command === "seekBy"
        ? `seekBy:${offsetSeconds}`
        : command === "rate"
          ? `rate:${targetRate}`
          : command === "volume"
            ? `volume:${hasVolume ? args.volume : ""}:${hasDelta ? args.delta : ""}:${hasMuted ? args.muted : ""}`
            : command;
    const videoKey = `${context.bvid}:${context.cid}:${context.pageIndex}`;
    const turnId = String(call.turnId || "").trim();
    const timestamp = now();
    const prev = recentPlayerControls.get(axis);
    if (
      prev &&
      prev.videoKey === videoKey &&
      prev.signature === signature &&
      (Boolean(turnId && prev.turnId && turnId === prev.turnId) ||
        (timestamp - prev.at >= 0 && timestamp - prev.at < PLAYER_CONTROL_DEDUP_WINDOW_MS))
    ) {
      const cached = await prev.promise;
      if (cached.ok === true) {
        return { ...cached };
      }
    }

    let entry!: RecentPlayerControlEntry;
    const executePromise = (async (): Promise<Record<string, unknown>> => {
      try {
        let message = "";
        let notice = "";
        if (command === "pause") {
          video.pause();
          message = "已暂停播放";
        } else if (command === "play") {
          await video.play();
          const currentContext = getVideoContext();
          if (getPlayer() !== video || !currentContext || !contextMatchesCall(call, currentContext)) {
            const error = "播放期间视频已切换，本次控制结果已失效。";
            showNotice(error, 4000);
            if (recentPlayerControls.get(axis) === entry) {
              recentPlayerControls.delete(axis);
            }
            return { ok: false, error };
          }
          message = "已继续播放";
        } else if (command === "rate") {
          video.playbackRate = targetRate;
          message = `已切换到 ${targetRate} 倍速`;
        } else if (command === "volume") {
          if (hasVolume || hasDelta) {
            const currentPercent = Math.round(readBaseVolume(video) * 100);
            const targetPercent = hasVolume
              ? Math.round(clamp(args.volume as number, 0, 100))
              : Math.round(clamp(currentPercent + (args.delta as number), 0, 100));
            writeBaseVolume(video, targetPercent / 100);
            if (!hasMuted && video.muted && (hasVolume ? targetPercent > 0 : (args.delta as number) > 0)) {
              video.muted = false;
            }
          }
          if (hasMuted) {
            video.muted = args.muted as boolean;
          }
          const nextPercent = Math.round(readBaseVolume(video) * 100);
          if (video.muted) {
            notice = "已静音视频";
          } else if (hasMuted && !hasVolume && !hasDelta) {
            notice = `已取消视频静音（当前音量 ${nextPercent}%）`;
          } else {
            notice = `已将视频音量调至 ${nextPercent}%`;
          }
          const shareMutedWarning = Boolean(deps.isSharingVideoAudio?.()) && (video.muted || nextPercent === 0);
          message = shareMutedWarning
            ? `${notice}（当前已开启分享视频声音，静音后 AI 将暂时听不到视频原声）`
            : notice;
        } else if (command === "seekBy") {
          const baseTime = Number.isFinite(video.currentTime) ? Math.max(0, video.currentTime) : 0;
          const finalTime = clampVideoTime(baseTime + offsetSeconds, video);
          video.currentTime = finalTime;
          const directionText = offsetSeconds >= 0
            ? `已快进 ${Math.abs(offsetSeconds)} 秒`
            : `已快退 ${Math.abs(offsetSeconds)} 秒`;
          message = `${directionText}，当前位于 ${formatClock(finalTime, { hours: "auto" })}`;
        } else {
          const finalTime = clampVideoTime(targetTime, video);
          video.currentTime = finalTime;
          message = `已跳转到 ${formatClock(finalTime, { hours: "auto" })}`;
        }

        const result = playerSnapshot(command, video, context, message);
        showNotice(notice || message, 1800);
        return result;
      } catch (error) {
        if (recentPlayerControls.get(axis) === entry) {
          recentPlayerControls.delete(axis);
        }
        throw error;
      }
    })();

    entry = { videoKey, signature, turnId, at: timestamp, promise: executePromise };
    recentPlayerControls.set(axis, entry);
    return executePromise;
  }

  async function executeTool(call: MossLiveToolCall): Promise<Record<string, unknown>> {
    const toolName = String(call?.name || "").trim();
    const isPlayerControl = toolName === "control_bilibili_player";
    const isSummarizeVideo = toolName === "summarize_video";
    if (!isPlayerControl) {
      const statusNotice = isSummarizeVideo
        ? "正在生成全片概览..."
        : "正在查阅当前视频字幕...";
      showNotice(statusNotice, 1800);
    }
    try {
      const url = getUrl();
      if (parseLiveRoomId(url)) {
        const result = { ok: false, error: "直播间伴看模式不支持点播播放器控制与字幕工具。" };
        showNotice(result.error, 4000);
        return result;
      }
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
      const context = projectVideoContext(clip, url, getOverview());
      if (!context || !contextMatchesCall(call, context)) {
        const result = { ok: false, error: "视频已切换或视频上下文尚未就绪，请稍后再试；不要沿用上一个视频的内容。" };
        showNotice(result.error, 4000);
        return result;
      }

      if (isPlayerControl) {
        return await controlPlayer(args, call, context);
      }

      if (isSummarizeVideo) {
        const cachedSnapshot = getOverview();
        const cachedOverview = projectLiveOverview(cachedSnapshot, { fetchState: clip.subtitleFetchState });
        if (cachedOverview && (cachedOverview.coverage === "complete" || cachedOverview.coverage === "partial")) {
          const message = cachedOverview.coverage === "partial" ? "全片概览覆盖不完整" : "全片概览已就绪";
          showNotice(message, 1800);
          return projectOverviewResponse(context, cachedOverview);
        }

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
