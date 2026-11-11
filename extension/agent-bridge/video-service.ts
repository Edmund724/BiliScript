import { bgFetchJson, type JsonTransport } from "../bilibili/gateway-core.js";
import {
  fetchSubtitleBundle,
  fetchVideoMeta,
  type Chapter,
  type SubtitleTrack,
  type VideoMeta,
  type VideoPage
} from "../bilibili/video-api.js";
import { fetchHotCommentsJson } from "../bilibili/hot-comments.js";
import { getSettingsSnapshot, getProviderStore } from "../core/settings-snapshot.js";
import { runAsrPipeline } from "../asr/pipeline.js";
import { createOffscreenChunkHost } from "../asr/offscreen-bridge.page.js";
import { handleAsrDecodeCleanup, handleAsrDecodePrepare } from "../asr/offscreen-bridge.bg.js";
import { resolveActiveAsrProviderId, type AsrProvider } from "../asr/asr-provider-store.js";
import { getErrorMessage } from "../shared/error-helpers.js";
import {
  clearStaleAsrSubtitleCache,
  clearSubtitleCacheByKey,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "../subtitle/cache.js";
import { validateSubtitleByDuration } from "../subtitle/duration-validation.js";
import { buildAsrSubtitleLabel } from "../subtitle/labels.js";
import {
  buildSubtitleCandidates,
  normalizeSubtitleItems
} from "../subtitle/cache.js";
import { normalizeSubtitleTracks, pickPreferredSubtitle } from "../subtitle/selection.js";
import { trackIdentity } from "../subtitle/source-key.js";
import type {
  AgentBridgeCommentsResult,
  AgentBridgeContentSubtitlesResult,
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

function prepareOffscreenTask(): Promise<{ ok: boolean; ruleId?: number; error?: string }> {
  return new Promise((resolve) => {
    void handleAsrDecodePrepare({}, {}, resolve);
  });
}

function cleanupOffscreenTask(ruleId: number): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    void handleAsrDecodeCleanup({ ruleId }, {}, resolve);
  });
}

async function defaultTranscribe(bvid: string, cid: string): Promise<AgentBridgeSubtitleItem[]> {
  return runAsrPipeline({
    bvid,
    cid,
    sourceTransport: bgFetchJson,
    chunkHost: createOffscreenChunkHost({
      prepare: prepareOffscreenTask,
      cleanup: cleanupOffscreenTask
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
  const pages = Array.isArray(meta.pages) ? meta.pages : [];
  const page = pages.find((item) => cid && item.cid === cid)
    || pages.find((item) => item.page === pageIndex)
    || pages[0]
    || {
      cid: cid || meta.defaultCid,
      page: pageIndex,
      part: "",
      duration: meta.defaultDuration
    };
  const resolvedCid = String(cid || page.cid || meta.defaultCid || "");
  if (!resolvedCid) throw new Error("视频信息缺少 cid，无法获取字幕或评论");
  const resolvedPage = { ...page, cid: resolvedCid };
  return {
    meta,
    page: resolvedPage,
    video: {
      bvid: "",
      aid: meta.aid,
      cid: resolvedCid,
      title: meta.title,
      author: meta.author,
      description: meta.description,
      uploadDate: meta.uploadDate,
      duration: Number(page.duration || meta.defaultDuration || 0),
      page: Number(page.page || pageIndex || 1),
      pageCount: pages.length
    }
  };
}

function filterRange(items: AgentBridgeSubtitleItem[], from = 0, to = Number.POSITIVE_INFINITY): AgentBridgeSubtitleItem[] {
  if (!Number.isFinite(from) || from < 0 || (!(to === Number.POSITIVE_INFINITY) && (!Number.isFinite(to) || to < 0))) {
    throw new Error("--from 与 --to 必须是非负秒数");
  }
  if (to < from) throw new Error("--to 不能小于 --from");
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

  async function loadNativeTrack(
    track: SubtitleTrack,
    resolved: ResolvedVideo
  ): Promise<AgentBridgeSubtitleItem[]> {
    const { bvid, cid } = resolved.video;
    const language = track.lanDoc || track.lan || "unknown";
    const cacheKey = getSubtitleCacheKey({
      bvid,
      cid,
      identity: trackIdentity(track.id, track.subtitleUrl, language)
    });
    const cached = await loadSubtitleFromCache(cacheKey);
    if (cached?.length) {
      const items = normalizeItems(cached);
      if (validateSubtitleByDuration(items, resolved.video.duration).ok) return items;
      await clearSubtitleCacheByKey(cacheKey);
    }

    const payload = await transport(track.subtitleUrl);
    const items = normalizeItems((payload as { body?: unknown })?.body);
    if (!items.length) throw new Error("字幕文件为空。");
    if (!validateSubtitleByDuration(items, resolved.video.duration).ok) {
      throw new Error("字幕时长与当前视频不匹配。");
    }
    await saveSubtitleToCache(cacheKey, items);
    return items;
  }

  async function loadNativeSubtitle(resolved: ResolvedVideo): Promise<{
    track: SubtitleTrack;
    chapters: Chapter[];
    items: AgentBridgeSubtitleItem[];
  } | null> {
    const { bvid, cid, aid } = resolved.video;
    const bundle = await fetchSubtitleBundle(transport, { bvid, cid, aid });
    const tracks = normalizeSubtitleTracks(bundle.tracks);
    const preferred = pickPreferredSubtitle(tracks);
    const candidates = buildSubtitleCandidates(tracks, preferred);
    if (!candidates.length) {
      if (bundle.upowerBlocked || resolved.meta.upowerBlocked) {
        throw new Error("该视频为充电专属视频，当前账号无法获取完整音轨，不能进行 ASR 转写");
      }
      return null;
    }

    let lastError: unknown = null;
    for (const track of candidates) {
      try {
        const items = await loadNativeTrack(track, resolved);
        return { track, chapters: bundle.chapters, items };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("这个视频暂时没有可用字幕。");
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
    const cacheKey = getSubtitleCacheKey({
      bvid,
      cid,
      identity: {
        kind: "asr",
        providerId: runtime.provider.id,
        model,
        lang: runtime.language
      }
    });
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
        const saved = await saveSubtitleToCache(cacheKey, items);
        if (saved.ok) await clearStaleAsrSubtitleCache({ bvid, cid, keepKey: cacheKey });
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

  return {
    async completeContentSubtitles(
      query: AgentBridgeSubtitleQuery,
      content: AgentBridgeContentSubtitlesResult
    ): Promise<AgentBridgeSubtitlesResult> {
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
      const resolved = await resolve(query.bvid, query.pageIndex, query.cid);
      const native = await loadNativeSubtitle(resolved);
      if (native) {
        return {
          video: resolved.video,
          pages: resolved.meta.pages,
          chapters: native.chapters,
          subtitle: {
            source: native.track.source || "bilibili",
            trackId: native.track.id,
            language: native.track.lanDoc || native.track.lan || "unknown",
            items: filterRange(native.items, query.from, query.to)
          }
        };
      }

      const asr = await loadAsrSubtitle(resolved);
      return {
        video: resolved.video,
        pages: resolved.meta.pages,
        chapters: [],
        subtitle: {
          source: "asr",
          trackId: "asr",
          language: asr.language,
          items: filterRange(asr.items, query.from, query.to)
        }
      };
    },

    async getComments(query: AgentBridgeSubtitleQuery): Promise<AgentBridgeCommentsResult> {
      const resolved = await resolve(query.bvid, query.pageIndex, query.cid);
      return {
        video: resolved.video,
        comments: await fetchHotCommentsJson(transport, resolved.video.aid, 20, { includeHighLikedReplies: true })
      };
    }
  };
}
