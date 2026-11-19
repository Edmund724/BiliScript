import { bgFetchJson, type JsonTransport } from "../bilibili/gateway-core.js";
import {
  fetchSubtitleBundle,
  fetchVideoMeta,
  resolveVideoPageFromMeta,
  type Chapter,
  type SubtitleTrack,
  type VideoMeta,
  type VideoPage
} from "../bilibili/video-api.js";
import { fetchHotCommentsJson } from "../bilibili/hot-comments.js";
import { getSettingsSnapshot, getProviderStore } from "../core/settings-snapshot.js";
import { acquireBiliMediaSessionRule, releaseBiliMediaSessionRule } from "../core/offscreen-host.js";
import { runAsrPipeline } from "../asr/pipeline.js";
import { createOffscreenChunkHost } from "../asr/offscreen-bridge.page.js";
import { resolveActiveAsrProviderId, type AsrProvider } from "../asr/asr-provider-store.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import { loadPreferredNativeSubtitle } from "../subtitle/body.js";
import {
  clearSubtitleCacheByKey,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  normalizeSubtitleItems,
  persistAsrSubtitleToCache
} from "../subtitle/cache.js";
import { validateSubtitleByDuration } from "../subtitle/duration-validation.js";
import { buildAsrSubtitleLabel } from "../subtitle/labels.js";
import type { TrackIdentity } from "../subtitle/source-key.js";
import type {
  AgentBridgeComment,
  AgentBridgeCommentsResult,
  AgentBridgeContentSubtitlesResult,
  AgentBridgeFetchResult,
  AgentBridgeSubtitle,
  AgentBridgeSubtitleItem,
  AgentBridgeSubtitlesResult,
  AgentBridgeVideo
} from "./protocol.js";

export interface AgentBridgeSubtitleQuery {
  bvid: string;
  pageIndex?: number;
  cid?: string;
  from?: number;
  to?: number;
}

interface ResolvedVideo {
  meta: VideoMeta;
  page: VideoPage;
  video: AgentBridgeVideo;
}

interface AsrRuntime {
  enabled: boolean;
  provider: AsrProvider | null;
  language: string;
}

export interface AgentBridgeVideoServiceDeps {
  transport?: JsonTransport;
  getAsrRuntime?: () => Promise<AsrRuntime>;
  transcribe?: (bvid: string, cid: string) => Promise<AgentBridgeSubtitleItem[]>;
}

async function defaultTranscribe(bvid: string, cid: string): Promise<AgentBridgeSubtitleItem[]> {
  return runAsrPipeline({
    bvid,
    cid,
    sourceTransport: bgFetchJson,
    chunkHost: createOffscreenChunkHost({
      prepare: async () => {
        try {
          return { ok: true, ruleId: await acquireBiliMediaSessionRule("audio-xhr", "o") };
        } catch (error) {
          return { ok: false, error: getErrorMessage(error) };
        }
      },
      cleanup: async (ruleId: number) => {
        try {
          await releaseBiliMediaSessionRule(ruleId, "o");
          return { ok: true };
        } catch (error) {
          return { ok: false, error: getErrorMessage(error) };
        }
      }
    })
  });
}

async function defaultAsrRuntime(): Promise<AsrRuntime> {
  const [settings, store] = await Promise.all([
    getSettingsSnapshot(),
    getProviderStore("asr")
  ]);
  const activeId = resolveActiveAsrProviderId(store.providers, settings.activeAsrProviderId);
  return {
    enabled: settings.asrAutoFallback === true,
    provider: store.providers.find((provider) => provider.id === activeId && provider.enabled !== false) || null,
    language: String(settings.asrLanguage || "").trim() || "auto"
  };
}

function normalizeItems(items: unknown): AgentBridgeSubtitleItem[] {
  return normalizeSubtitleItems(items)
    .map((item) => ({
      from: Number(item.from) || 0,
      to: Number(item.to) || Number(item.from) || 0,
      content: String(item.content || "").trim()
    }))
    .sort((a, b) => a.from - b.from);
}

function resolveVideo(meta: VideoMeta, pageIndex = 1, cid = ""): ResolvedVideo {
  const resolved = resolveVideoPageFromMeta(meta, { cid, pageIndex });
  if (!resolved.cid) throw new Error("视频信息缺少 cid，无法获取字幕或评论");
  const resolvedPage: VideoPage = resolved.page
    ? { ...resolved.page, cid: resolved.cid }
    : {
        cid: resolved.cid,
        page: resolved.pageIndex,
        part: resolved.pageTitle,
        duration: resolved.duration
      };
  return {
    meta,
    page: resolvedPage,
    video: {
      bvid: "",
      aid: meta.aid,
      cid: resolved.cid,
      title: meta.title,
      author: meta.author,
      description: meta.description,
      uploadDate: meta.uploadDate,
      duration: resolved.duration,
      page: resolved.pageIndex,
      pageCount: resolved.pageCount
    }
  };
}

function validateRange(from = 0, to = Number.POSITIVE_INFINITY): void {
  if (!Number.isFinite(from) || from < 0 || (!(to === Number.POSITIVE_INFINITY) && (!Number.isFinite(to) || to < 0))) {
    throw new Error("--from 与 --to 必须是非负秒数");
  }
  if (to < from) throw new Error("--to 不能小于 --from");
}

function filterRange(items: AgentBridgeSubtitleItem[], from = 0, to = Number.POSITIVE_INFINITY): AgentBridgeSubtitleItem[] {
  validateRange(from, to);
  return items.filter((item) => item.to >= from && item.from <= to);
}

export function createAgentBridgeVideoService(deps: AgentBridgeVideoServiceDeps = {}) {
  const transport = deps.transport || bgFetchJson;
  const getAsrRuntime = deps.getAsrRuntime || defaultAsrRuntime;
  const transcribe = deps.transcribe || defaultTranscribe;
  const activeAsr = new Map<string, Promise<AgentBridgeSubtitleItem[]>>();

  async function resolve(bvid: string, pageIndex?: number, cid?: string): Promise<ResolvedVideo> {
    const meta = await fetchVideoMeta(transport, bvid);
    const resolved = resolveVideo(meta, pageIndex, cid);
    resolved.video.bvid = bvid;
    return resolved;
  }

  async function loadNativeSubtitle(resolved: ResolvedVideo): Promise<{
    track: SubtitleTrack;
    chapters: Chapter[];
    items: AgentBridgeSubtitleItem[];
  } | null> {
    const { bvid, cid, aid, duration } = resolved.video;
    const bundle = await fetchSubtitleBundle(transport, { bvid, cid, aid });
    const loaded = await loadPreferredNativeSubtitle({
      tracks: bundle.tracks,
      bvid,
      cid,
      videoDuration: duration,
      transport
    });
    if (!loaded) {
      if (bundle.upowerBlocked || resolved.meta.upowerBlocked) {
        throw new Error("该视频为充电专属视频，当前账号无法获取完整音轨，不能进行 ASR 转写");
      }
      if (bundle.loginRequired) {
        throw new Error("未登录 B 站，无法获取视频自带字幕。请在浏览器登录 B 站后重试。");
      }
      return null;
    }
    const items = normalizeItems(loaded.body);
    if (!items.length) {
      throw new Error("字幕文件为空。");
    }
    return { track: loaded.track, chapters: bundle.chapters, items };
  }

  async function loadAsrSubtitle(resolved: ResolvedVideo): Promise<{
    items: AgentBridgeSubtitleItem[];
    language: string;
  }> {
    const runtime = await getAsrRuntime();
    if (!runtime.enabled) {
      throw new Error("该视频没有可用字幕，且「无字幕时自动生成字幕」未开启。请在扩展设置中开启后重试。");
    }
    if (!runtime.provider) {
      throw new Error("该视频没有可用字幕，且未配置可用的语音识别平台。请在扩展设置中配置后重试。");
    }

    const { bvid, cid } = resolved.video;
    const model = String(runtime.provider.model || "").trim();
    const identity: TrackIdentity = {
      kind: "asr",
      providerId: runtime.provider.id,
      model,
      lang: runtime.language
    };
    const cacheKey = getSubtitleCacheKey({ bvid, cid, identity });
    const cached = await loadSubtitleFromCache(cacheKey);
    if (cached?.length) {
      const items = normalizeItems(cached);
      if (validateSubtitleByDuration(items, resolved.video.duration).ok) {
        return { items, language: buildAsrSubtitleLabel(runtime.language) };
      }
      await clearSubtitleCacheByKey(cacheKey);
    }

    let task = activeAsr.get(cacheKey);
    if (!task) {
      task = (async () => {
        const items = normalizeItems(await transcribe(bvid, cid));
        if (!items.length) throw new Error("ASR 转写完成，但未识别到语音内容。");
        await persistAsrSubtitleToCache({ bvid, cid, identity, body: items });
        return items;
      })();
      activeAsr.set(cacheKey, task);
      task.catch(() => {}).finally(() => activeAsr.delete(cacheKey));
    }

    try {
      return { items: await task, language: buildAsrSubtitleLabel(runtime.language) };
    } catch (error) {
      const reason = (error as { reason?: unknown }).reason;
      if (reason === "asr-disabled") {
        throw new Error("该视频没有可用字幕，且「无字幕时自动生成字幕」未开启。请在扩展设置中开启后重试。");
      }
      if (reason === "no-asr-config") {
        throw new Error("语音识别平台不可用。请在扩展设置中检查平台、模型与域名授权后重试。");
      }
      throw new Error(`ASR 转写失败：${getErrorMessage(error)}`);
    }
  }

  async function loadSubtitleForResolved(resolved: ResolvedVideo): Promise<{
    chapters: Chapter[];
    subtitle: AgentBridgeSubtitle;
  }> {
    const native = await loadNativeSubtitle(resolved);
    if (native) {
      return {
        chapters: native.chapters,
        subtitle: {
          source: native.track.source || "bilibili",
          trackId: native.track.id,
          language: native.track.lanDoc || native.track.lan || "unknown",
          items: native.items
        }
      };
    }

    const asr = await loadAsrSubtitle(resolved);
    return {
      chapters: [],
      subtitle: {
        source: "asr",
        trackId: "asr",
        language: asr.language,
        items: asr.items
      }
    };
  }

  return {
    async resolveVideoInfo(query: AgentBridgeSubtitleQuery): Promise<AgentBridgeVideo> {
      return (await resolve(query.bvid, query.pageIndex, query.cid)).video;
    },

    async completeContentSubtitles(
      query: AgentBridgeSubtitleQuery,
      content: AgentBridgeContentSubtitlesResult
    ): Promise<AgentBridgeSubtitlesResult> {
      validateRange(query.from, query.to);
      const resolved = await resolve(query.bvid, content.pageIndex, content.cid);
      return {
        video: resolved.video,
        pages: resolved.meta.pages,
        chapters: content.chapters,
        subtitle: {
          ...content.subtitle,
          items: filterRange(content.subtitle.items, query.from, query.to)
        }
      };
    },

    async getSubtitles(query: AgentBridgeSubtitleQuery): Promise<AgentBridgeSubtitlesResult> {
      validateRange(query.from, query.to);
      const resolved = await resolve(query.bvid, query.pageIndex, query.cid);
      const { chapters, subtitle } = await loadSubtitleForResolved(resolved);
      return {
        video: resolved.video,
        pages: resolved.meta.pages,
        chapters,
        subtitle: {
          ...subtitle,
          items: filterRange(subtitle.items, query.from, query.to)
        }
      };
    },

    async getComments(query: AgentBridgeSubtitleQuery): Promise<AgentBridgeCommentsResult> {
      const resolved = await resolve(query.bvid, query.pageIndex, query.cid);
      return {
        video: resolved.video,
        comments: await fetchHotCommentsJson(transport, resolved.video.aid, 20, { includeHighLikedReplies: true })
      };
    },

    async getVideoBundle(
      query: AgentBridgeSubtitleQuery,
      loadContentSubtitles?: () => Promise<AgentBridgeContentSubtitlesResult | null>
    ): Promise<AgentBridgeFetchResult> {
      validateRange(query.from, query.to);
      const metaTask = fetchVideoMeta(transport, query.bvid);
      const contentTask = loadContentSubtitles ? loadContentSubtitles() : Promise.resolve(null);
      const commentsTask = metaTask.then(
        (meta) =>
          fetchHotCommentsJson(transport, meta.aid, 20, { includeHighLikedReplies: true }).then(
            (comments) => ({ comments, commentsError: undefined as string | undefined }),
            (error) => ({ comments: [] as AgentBridgeComment[], commentsError: getErrorMessage(error) })
          ),
        () => ({ comments: [] as AgentBridgeComment[], commentsError: undefined as string | undefined })
      );

      const [meta, content] = await Promise.all([metaTask, contentTask]);
      const resolved = content
        ? resolveVideo(meta, content.pageIndex, content.cid)
        : resolveVideo(meta, query.pageIndex, query.cid);
      resolved.video.bvid = query.bvid;

      const [{ chapters, subtitle }, { comments, commentsError }] = await Promise.all([
        content
          ? Promise.resolve({ chapters: content.chapters, subtitle: content.subtitle })
          : loadSubtitleForResolved(resolved),
        commentsTask
      ]);

      return {
        video: resolved.video,
        pages: resolved.meta.pages,
        chapters,
        subtitle: {
          ...subtitle,
          items: filterRange(subtitle.items, query.from, query.to)
        },
        comments,
        ...(commentsError ? { commentsError } : {})
      };
    }
  };
}
