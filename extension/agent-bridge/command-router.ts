import { extractBvid, extractPageIndex } from "../bilibili/video-id-shared.js";
import { withBiliMediaSessionRule } from "../core/offscreen-host.js";
import { getErrorMessage, withTimeout } from "../shared/error-helpers.js";
import type { ContentScriptMessage, ResponseOf } from "../shared/messaging-protocol.js";
import {
  detectSiteFromUrl,
  extractYoutubeVideoId,
  normalizeSiteId,
  YOUTUBE_UNIT_CID,
  type SiteId
} from "../shared/site.js";
import { sendMessageToTab } from "../shared/tab-utils.js";
import {
  MAX_BRIDGE_FRAMES_PER_REQUEST,
  type AgentBridgeComment,
  type AgentBridgeCommentsResult,
  type AgentBridgeContentSubtitlesResult,
  type AgentBridgeFetchResult,
  type AgentBridgeFramesResult,
  type AgentBridgeOffscreenFrameResponse,
  type AgentBridgeRequestOptions,
  type AgentBridgeSubtitlesResult,
  type AgentBridgeTabSnapshot,
  type AgentBridgeTabsResult,
  type AgentBridgeVideo
} from "./protocol.js";
import {
  createAgentBridgeVideoService,
  filterSubtitleRange,
  validateSubtitleRange,
  type AgentBridgeVideoService
} from "./video-service.js";

const TAB_SNAPSHOT_TIMEOUT_MS = 2000;
const VIDEO_URL_PATTERNS = [
  "https://www.bilibili.com/video/*",
  "https://www.bilibili.com/list/*",
  "https://www.bilibili.com/festival/*",
  "https://www.youtube.com/watch*"
];

export type AgentBridgeTabMessage = Extract<
  ContentScriptMessage,
  {
    type:
      | "agent-bridge-snapshot"
      | "agent-bridge-subtitles"
      | "agent-bridge-comments"
      | "agent-bridge-frame";
  }
>;

type AgentBridgeTabResultMessage = Exclude<AgentBridgeTabMessage, { type: "agent-bridge-snapshot" }>;

export interface AgentBridgeOffscreenFrameInput {
  bvid: string;
  cid: string;
  targetTime?: number;
  times?: number[];
  spanSeconds?: number;
}

export interface AgentBridgeHostAdapter {
  queryTabs: (queryInfo: Parameters<typeof chrome.tabs.query>[0]) => Promise<chrome.tabs.Tab[]>;
  getTab: (tabId: number) => Promise<chrome.tabs.Tab>;
  sendTabMessage: <M extends AgentBridgeTabMessage>(
    tabId: number,
    message: M
  ) => Promise<ResponseOf<M> | undefined>;
  captureOffscreenFrames: (input: AgentBridgeOffscreenFrameInput) => Promise<AgentBridgeFramesResult>;
}

export interface AgentBridgeCommandRouterDeps {
  host?: Partial<AgentBridgeHostAdapter>;
  videoService?: AgentBridgeVideoService;
}

export interface AgentBridgeCommandRouter {
  listTabs: () => Promise<AgentBridgeTabsResult>;
  execute: (command: unknown, options?: unknown) => Promise<unknown>;
}

interface ResolvedTarget extends AgentBridgeRequestOptions {
  site: SiteId;
  bvid: string;
  pageIndex: number;
  cid?: string;
  tabId?: number;
}

function normalizeYoutubeTargetId(candidate: string): string {
  if (!candidate || /[/?#&%=\s]/.test(candidate)) return "";
  return extractYoutubeVideoId(`https://www.youtube.com/watch?v=${candidate}`);
}

function extractYoutubeTargetId(value: string): string {
  const input = value.trim();
  if (!input) return "";
  const directWatch = extractYoutubeVideoId(input);
  if (directWatch) return directWatch;
  const bareId = normalizeYoutubeTargetId(input);
  if (bareId) return bareId;
  if (detectSiteFromUrl(input) !== "youtube") return "";
  try {
    const parsed = new URL(input);
    const host = parsed.hostname.toLowerCase();
    if (host === "youtu.be") {
      return normalizeYoutubeTargetId(parsed.pathname.replace(/^\/+/, "").split("/")[0] || "");
    }
    if (parsed.pathname.replace(/\/+$/, "") === "/watch") {
      return normalizeYoutubeTargetId(parsed.searchParams.get("v") || "");
    }
  } catch {
  }
  return "";
}

function parseTargetInput(value: unknown): { site: SiteId; bvid: string; pageIndex: number; cid?: string } {
  const input = String(value || "").trim();
  const bvid = /^BV[0-9A-Za-z]+$/.test(input) ? input : extractBvid(input);
  if (bvid) {
    return { site: "bilibili", bvid, pageIndex: extractPageIndex(input) };
  }
  const youtubeId = extractYoutubeTargetId(input);
  if (youtubeId) {
    return { site: "youtube", bvid: youtubeId, pageIndex: 1, cid: YOUTUBE_UNIT_CID };
  }
  throw new Error("请传入有效的 BV 号、YouTube 视频 ID 或视频链接");
}

function fallbackTabSnapshot(tab: chrome.tabs.Tab): AgentBridgeTabSnapshot {
  const url = tab.url || "";
  const site = detectSiteFromUrl(url);
  return {
    site,
    tabId: tab.id || 0,
    bvid: site === "youtube" ? extractYoutubeVideoId(url) : extractBvid(url),
    cid: site === "youtube" ? YOUTUBE_UNIT_CID : "",
    title: tab.title || "",
    currentTime: 0,
    duration: 0,
    subtitlesReady: false
  };
}

function resolveYoutubeVideo(target: ResolvedTarget, content: AgentBridgeContentSubtitlesResult): AgentBridgeVideo {
  if (content.video) {
    return {
      ...content.video,
      site: "youtube",
      bvid: content.video.bvid || target.bvid,
      aid: "",
      cid: content.video.cid || YOUTUBE_UNIT_CID,
      page: 1,
      pageCount: 1
    };
  }
  return {
    site: "youtube",
    bvid: target.bvid,
    aid: "",
    cid: target.cid || YOUTUBE_UNIT_CID,
    title: "",
    author: "",
    description: "",
    uploadDate: "",
    duration: 0,
    page: 1,
    pageCount: 1
  };
}

const FRAME_DEDUP_EPSILON_SEC = 0.25;

function countExpandedDedupedFrames(times: readonly number[], spanSeconds: number): number {
  const expanded: Array<{ targetTime: number; isCenter: boolean }> = [];
  for (const anchorTime of times) {
    if (spanSeconds > 0) {
      expanded.push({ targetTime: Math.max(0, anchorTime - spanSeconds), isCenter: false });
      expanded.push({ targetTime: anchorTime, isCenter: true });
      expanded.push({ targetTime: anchorTime + spanSeconds, isCenter: false });
    } else {
      expanded.push({ targetTime: anchorTime, isCenter: true });
    }
  }
  expanded.sort((a, b) => {
    if (a.targetTime !== b.targetTime) return a.targetTime - b.targetTime;
    if (a.isCenter !== b.isCenter) return a.isCenter ? -1 : 1;
    return 0;
  });
  const deduped: Array<{ targetTime: number; isCenter: boolean }> = [];
  for (const item of expanded) {
    const last = deduped[deduped.length - 1];
    if (last && item.targetTime - last.targetTime < FRAME_DEDUP_EPSILON_SEC) {
      if (!last.isCenter && item.isCenter) {
        deduped[deduped.length - 1] = item;
      }
      continue;
    }
    deduped.push(item);
  }
  return deduped.length;
}

function normalizeHistoricalFrameRequest(
  target: ResolvedTarget
): { times: number[]; targetTime: number; spanSeconds: number } | null {
  if (target.times === undefined && target.targetTime === undefined) {
    return null;
  }
  let times: number[];
  if (target.times !== undefined) {
    if (!Array.isArray(target.times) || target.times.length === 0) {
      throw new Error("--times 必须是非空的时间点数组");
    }
    times = target.times.map((raw) => {
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error("--times 必须包含大于或等于 0 的有限秒数");
      }
      return value;
    });
  } else {
    const targetTime = Number(target.targetTime);
    if (!Number.isFinite(targetTime) || targetTime < 0) {
      throw new Error("--time 必须是大于或等于 0 的有限秒数");
    }
    times = [targetTime];
  }
  const spanSeconds = target.spanSeconds === undefined ? 0 : Number(target.spanSeconds);
  if (!Number.isFinite(spanSeconds) || spanSeconds < 0) {
    throw new Error("--span 必须是大于或等于 0 的有限秒数");
  }
  const totalFrames = countExpandedDedupedFrames(times, spanSeconds);
  if (totalFrames > MAX_BRIDGE_FRAMES_PER_REQUEST) {
    throw new Error(
      `单次截帧最多支持 ${MAX_BRIDGE_FRAMES_PER_REQUEST} 帧（当前展开后为 ${totalFrames} 帧），请分批请求或减小 spanSeconds`
    );
  }
  return {
    times,
    targetTime: times[0],
    spanSeconds
  };
}

async function defaultCaptureOffscreenFrames(
  input: AgentBridgeOffscreenFrameInput
): Promise<AgentBridgeFramesResult> {
  return withBiliMediaSessionRule("video-media", async () => {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: "agent-bridge-offscreen-frame",
        ...input
      })) as AgentBridgeOffscreenFrameResponse | undefined;
      if (!response?.ok || !response.result) {
        throw new Error(response?.error || "Offscreen 文档未完成视频截帧");
      }
      return response.result;
    } catch (error) {
      throw new Error(getErrorMessage(error));
    }
  });
}

function createDefaultHostAdapter(): AgentBridgeHostAdapter {
  return {
    queryTabs: (queryInfo) => chrome.tabs.query(queryInfo),
    getTab: (tabId) => chrome.tabs.get(tabId),
    sendTabMessage: (tabId, message) => sendMessageToTab(tabId, message),
    captureOffscreenFrames: defaultCaptureOffscreenFrames
  };
}

export function createAgentBridgeCommandRouter(
  deps: AgentBridgeCommandRouterDeps = {}
): AgentBridgeCommandRouter {
  const defaultHost = createDefaultHostAdapter();
  const host: AgentBridgeHostAdapter = {
    queryTabs: deps.host?.queryTabs || defaultHost.queryTabs,
    getTab: deps.host?.getTab || defaultHost.getTab,
    sendTabMessage: deps.host?.sendTabMessage || defaultHost.sendTabMessage,
    captureOffscreenFrames: deps.host?.captureOffscreenFrames || defaultHost.captureOffscreenFrames
  };
  const videoService = deps.videoService || createAgentBridgeVideoService();

  const readTabSnapshot = async (tab: chrome.tabs.Tab): Promise<AgentBridgeTabSnapshot> => {
    const fallback = fallbackTabSnapshot(tab);
    if (!tab.id) return fallback;
    const response = await withTimeout(
      host.sendTabMessage(tab.id, { type: "agent-bridge-snapshot" }).catch(() => undefined),
      TAB_SNAPSHOT_TIMEOUT_MS
    );
    const snapshot = response?.ok && response.snapshot ? response.snapshot : null;
    if (!snapshot) return fallback;
    const site = snapshot.site ? normalizeSiteId(snapshot.site) : fallback.site;
    return {
      site,
      tabId: fallback.tabId,
      bvid: String(snapshot.bvid || fallback.bvid),
      cid: String(snapshot.cid || (site === "youtube" ? YOUTUBE_UNIT_CID : "")),
      title: String(snapshot.title || fallback.title),
      currentTime: Number.isFinite(snapshot.currentTime) ? Number(snapshot.currentTime) : 0,
      duration: Number.isFinite(snapshot.duration) ? Number(snapshot.duration) : 0,
      subtitlesReady: snapshot.subtitlesReady === true
    };
  };

  const listTabs = async (): Promise<AgentBridgeTabsResult> => {
    const [tabs, activeTabs] = await Promise.all([
      host.queryTabs({ url: VIDEO_URL_PATTERNS }),
      host.queryTabs({ active: true, currentWindow: true, url: VIDEO_URL_PATTERNS }).catch(() => [] as chrome.tabs.Tab[])
    ]);
    const activeTabId = activeTabs.find((tab) => tab.id && tab.active === true)?.id;
    const snapshots = await Promise.all(
      tabs
        .filter((tab) => tab.id)
        .map(async (tab) => {
          const snapshot = await readTabSnapshot(tab);
          return tab.id === activeTabId ? { ...snapshot, active: true } : snapshot;
        })
    );
    return {
      tabs: snapshots.filter((snapshot) => snapshot.site !== "youtube" || Boolean(snapshot.bvid))
    };
  };

  const snapshotTarget = async (tab: chrome.tabs.Tab): Promise<ResolvedTarget> => {
    const snapshot = await readTabSnapshot(tab);
    const site = snapshot.site || detectSiteFromUrl(tab.url || "");
    if (!snapshot.bvid) {
      throw new Error("目标标签页不是支持的视频页（B 站 / YouTube）");
    }
    return {
      site,
      bvid: snapshot.bvid,
      pageIndex: site === "youtube" ? 1 : extractPageIndex(tab.url || ""),
      cid: snapshot.cid || (site === "youtube" ? YOUTUBE_UNIT_CID : undefined),
      tabId: snapshot.tabId
    };
  };

  const resolveTarget = async (rawOptions: unknown): Promise<ResolvedTarget> => {
    const options = (rawOptions && typeof rawOptions === "object" ? rawOptions : {}) as AgentBridgeRequestOptions;
    let target: ResolvedTarget;
    if (options.tabId !== undefined) {
      const tabId = Number(options.tabId);
      if (!Number.isInteger(tabId) || tabId <= 0) throw new Error("--tab 必须是正整数标签页 ID");
      target = await snapshotTarget(await host.getTab(tabId));
    } else if (String(options.bvid || "").trim()) {
      const parsed = parseTargetInput(options.bvid);
      const tabs = await host.queryTabs({ url: VIDEO_URL_PATTERNS });
      if (parsed.site === "youtube") {
        const match = tabs.find((tab) => extractYoutubeVideoId(tab.url || "") === parsed.bvid);
        if (!match?.id) {
          throw new Error("目标 YouTube 视频未在浏览器标签页中打开，请先在浏览器打开该视频页后重试");
        }
        target = { ...parsed, ...(await snapshotTarget(match)) };
      } else {
        const match = tabs.find(
          (tab) =>
            extractBvid(tab.url || "") === parsed.bvid && extractPageIndex(tab.url || "") === parsed.pageIndex
        );
        target = match?.id ? { ...parsed, ...(await snapshotTarget(match)) } : parsed;
      }
    } else {
      const [tab] = await host.queryTabs({ active: true, currentWindow: true, url: VIDEO_URL_PATTERNS });
      if (!tab) throw new Error("当前活动标签页不是支持的视频页（B 站 / YouTube），请使用 --tab 或 --bvid 指定目标");
      target = await snapshotTarget(tab);
    }
    return {
      ...target,
      from: options.from,
      to: options.to,
      targetTime: options.targetTime,
      times: options.times,
      spanSeconds: options.spanSeconds
    };
  };

  const requestTabResult = async <M extends AgentBridgeTabResultMessage>(
    tabId: number,
    message: M,
    fallbackError: string
  ): Promise<NonNullable<ResponseOf<M>["result"]> | null> => {
    let response: ResponseOf<M> | undefined;
    try {
      response = await host.sendTabMessage(tabId, message);
    } catch {
      return null;
    }
    if (!response) return null;
    if (!response.ok || !response.result) {
      throw new Error(response.error || fallbackError);
    }
    return response.result as NonNullable<ResponseOf<M>["result"]>;
  };

  const captureFrames = async (options: unknown): Promise<AgentBridgeFramesResult> => {
    const target = await resolveTarget(options);
    const historical = normalizeHistoricalFrameRequest(target);
    if (!historical) {
      if (!target.tabId) {
        throw new Error("目标视频未在标签页中打开；未打开视频请使用 --time <sec> 截取历史帧");
      }
      const result = await requestTabResult(
        target.tabId,
        { type: "agent-bridge-frame", bvid: target.bvid, cid: target.cid || "" },
        "页内视频截帧失败"
      );
      if (!result) throw new Error("目标标签页尚未加载扩展，请刷新页面后重试当前帧截取");
      return result;
    }

    if (target.site === "youtube") {
      if (!target.tabId) {
        throw new Error("未在浏览器标签页中找到该 YouTube 视频，请先打开视频页后重试");
      }
      const result = await requestTabResult(
        target.tabId,
        {
          type: "agent-bridge-frame",
          bvid: target.bvid,
          cid: target.cid || YOUTUBE_UNIT_CID,
          targetTime: historical.targetTime,
          times: historical.times,
          spanSeconds: historical.spanSeconds
        },
        "页内视频截帧失败"
      );
      if (!result) throw new Error("目标标签页尚未加载扩展，请刷新页面后重试历史截帧");
      return result;
    }

    const cid = target.cid || (await videoService.resolveVideoInfo(target)).cid;
    const input: AgentBridgeOffscreenFrameInput = {
      bvid: target.bvid,
      cid,
      targetTime: historical.targetTime,
      times: historical.times,
      spanSeconds: historical.spanSeconds
    };
    let contextTabId = target.tabId;
    if (!contextTabId) {
      const tabs = await host.queryTabs({ url: VIDEO_URL_PATTERNS });
      contextTabId = tabs.find((tab) => tab.id && detectSiteFromUrl(tab.url || "") === "bilibili")?.id;
    }
    if (contextTabId) {
      const result = await requestTabResult(
        contextTabId,
        { type: "agent-bridge-frame", ...input },
        "页内视频截帧失败"
      );
      if (result) return result;
    }
    return host.captureOffscreenFrames(input);
  };

  const executeYoutube = async (
    command: "fetch" | "subtitles" | "comments",
    target: ResolvedTarget
  ): Promise<AgentBridgeFetchResult | AgentBridgeSubtitlesResult | AgentBridgeCommentsResult> => {
    if (!target.tabId) {
      throw new Error("目标 YouTube 视频未在浏览器标签页中打开，请先在浏览器打开该视频页后重试");
    }
    if (command === "comments") {
      const result = await requestTabResult(target.tabId, { type: "agent-bridge-comments" }, "页内热门评论抓取失败");
      if (!result) throw new Error("目标标签页尚未加载扩展，请刷新页面后重试");
      return { video: result.video, comments: result.comments };
    }

    validateSubtitleRange(target.from, target.to);
    if (command === "subtitles") {
      const content = await requestTabResult(target.tabId, { type: "agent-bridge-subtitles" }, "页内字幕抓取失败");
      if (!content) throw new Error("目标标签页尚未加载扩展，请刷新页面后重试");
      return {
        video: resolveYoutubeVideo(target, content),
        pages: [],
        chapters: content.chapters,
        subtitle: {
          ...content.subtitle,
          items: filterSubtitleRange(content.subtitle.items, target.from, target.to)
        }
      };
    }

    const [content, commentsOutcome] = await Promise.all([
      requestTabResult(target.tabId, { type: "agent-bridge-subtitles" }, "页内字幕抓取失败"),
      requestTabResult(target.tabId, { type: "agent-bridge-comments" }, "页内热门评论抓取失败").then(
        (res) => ({
          comments: res?.comments ?? ([] as AgentBridgeComment[]),
          commentsError: res ? undefined : "目标标签页尚未加载扩展，无法获取热门评论"
        }),
        (error) => ({
          comments: [] as AgentBridgeComment[],
          commentsError: getErrorMessage(error)
        })
      )
    ]);
    if (!content) throw new Error("目标标签页尚未加载扩展，请刷新页面后重试");
    return {
      video: resolveYoutubeVideo(target, content),
      pages: [],
      chapters: content.chapters,
      subtitle: {
        ...content.subtitle,
        items: filterSubtitleRange(content.subtitle.items, target.from, target.to)
      },
      comments: commentsOutcome.comments,
      ...(commentsOutcome.commentsError ? { commentsError: commentsOutcome.commentsError } : {})
    };
  };

  const execute = async (command: unknown, options?: unknown): Promise<unknown> => {
    if (command === "tabs") return listTabs();
    if (command === "frame") return captureFrames(options);
    if (command !== "fetch" && command !== "subtitles" && command !== "comments") {
      throw new Error("不支持的桥接命令");
    }
    const target = await resolveTarget(options);
    if (target.site === "youtube") {
      return executeYoutube(command, target);
    }
    if (command === "comments") return videoService.getComments(target);
    if (command === "fetch") {
      return videoService.getVideoBundle(
        target,
        target.tabId
          ? () => requestTabResult(target.tabId!, { type: "agent-bridge-subtitles" }, "页内字幕抓取失败")
          : undefined
      );
    }
    if (target.tabId) {
      const content = await requestTabResult(target.tabId, { type: "agent-bridge-subtitles" }, "页内字幕抓取失败");
      if (content) return videoService.completeContentSubtitles(target, content);
    }
    return videoService.getSubtitles(target);
  };

  return {
    listTabs,
    execute
  };
}
