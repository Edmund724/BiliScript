// extension/ai/context-resolver.ts
// AI 对话上下文的纯网络路径适配器（arch-slim/07 收口后的角色）：仅在「无页面 /
// 无标签页」场景被消费，不持有进程内装配策略——AiContext 快照的装配知识单源在
// core/context-payload（形状/校验/签名）+ core/context-assembly（唯一装配链）。
// 本文件只做取数：视频元信息/分 P/字幕轨与正文/章节经 bgFetchJson 拉取并按
// ref 偏好挑选，交付 core/context-payload 的 createFetchedContextPayload 组装
//（字段清单/key 序/缺省与数组守卫不在此文件复制）。
//   resolveAiConversationContext   按任意 contextRef 装配整份上下文：pinned 补水
//                                  身份短路未命中（无当前页面可快照）时的兜底，
//                                  组合根经 conversation-store 的
//                                  resolveAiConversationRef 接缝注入（purpose="context"）；
//   resolveAiConversationPageRef  分页信息解析（purpose="page"）。
// （原 getAiContextState 的 tab transport 随扩展页消息链策略退役，见 ticket
// arch-slim-4/01——它是 reader-get-context / clip-refresh 两条消息的唯一发送方。）
// B站抓取统一走 bilibili/gateway-core.js 的 bgFetchJson 传输叶（arch-slim-2/04 拆叶）。

import { getSubtitleCacheKey, loadSubtitleFromCache } from "../subtitle/cache.js";
// 轨身份的构造单点（三字段 → track / url / lang 优先级裁定）：缓存键入口只收身份。
import { trackIdentity } from "../subtitle/source-key.js";
import {
  fetchVideoMeta,
  fetchSubtitleBundle,
  fetchSubtitleBody,
  type VideoMeta,
  type VideoPage,
  type SubtitleTrack
} from "../bilibili/gateway.js";
import { bgFetchJson } from "../bilibili/gateway-core.js";
import {
  extractPageIndexFromUrl,
  buildCanonicalVideoUrl
} from "../bilibili/video-id-shared.js";
import {
  pickPreferredSubtitle as pickPreferredSubtitleTrack,
  normalizeSubtitleTracks
} from "../subtitle/selection.js";
import { getMergedSettings } from "../core/settings-store.js";
import { createFetchedContextPayload } from "../core/context-payload.js";
import type { ChapterItem, SubtitleBodyItem, SubtitleOption } from "../core/state.js";
import { buildAiContextRef } from "./conversation.js";
import type { AiContext } from "./types.js";

// ===== 上下文解析 =====

function pickPageForAiContext(pages: VideoPage[], ref: AiContext): VideoPage | undefined {
  const safePages = Array.isArray(pages) ? pages : [];
  const targetCid = String(ref?.cid || "").trim();
  if (targetCid) {
    const byCid = safePages.find((item) => String(item?.cid || "") === targetCid);
    if (byCid) {
      return byCid;
    }
  }

  const pageIndex = extractPageIndexFromUrl(ref?.url || "");
  const byPage = safePages.find((item) => Number(item?.page) === pageIndex);
  if (byPage) {
    return byPage;
  }
}

export async function resolveAiConversationContext(contextRef: unknown): Promise<AiContext> {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      title: ref.title,
      url: ref.url,
      author: ref.author,
      uploadDate: ref.uploadDate,
      subtitleBody: [],
      hotComments: [],
      isVideoContext: false
    };
  }

  const settings = await getMergedSettings();
  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const cid = String(page?.cid || ref.cid || videoMeta.defaultCid || "").trim();
  if (!cid) {
    throw new Error("无法定位原视频分P");
  }
  const aid = String(videoMeta.aid || ref.aid || "").trim();
  const subtitleBundle = await fetchSubtitleBundle(bgFetchJson, { bvid: ref.bvid, cid, aid });
  const tracks = normalizeSubtitleTracks(subtitleBundle.tracks || []);
  if (!tracks.length) {
    throw new Error("原视频暂时没有可用字幕");
  }
  const selectedTrack = pickPreferredSubtitleTrack(tracks, {
    previousId: ref.selectedSubtitleId,
    previousUrl: ref.selectedSubtitleUrl,
    previousLang: ref.subtitleLang
  }) || tracks[0];
  const cacheKey = getSubtitleCacheKey({
    bvid: ref.bvid,
    cid,
    identity: trackIdentity(selectedTrack.id, selectedTrack.subtitleUrl, selectedTrack.lanDoc || selectedTrack.lan)
  });
  const cachedBody = await loadSubtitleFromCache(cacheKey);
  // 缓存命中免一次字幕正文下载；未命中按 gateway 现代签名只传 url、解构
  // { body }（与 subtitle/fetcher 等其余调用点同一条 contentFetchJson 通道）。
  const body = Array.isArray(cachedBody) && cachedBody.length > 0
    ? cachedBody
    : (await fetchSubtitleBody(selectedTrack.subtitleUrl)).body;
  if (!body.length) {
    throw new Error("原视频字幕为空");
  }

  const pageIndex = Number(page?.page || extractPageIndexFromUrl(ref.url || "") || 1) || 1;
  const title = String(videoMeta.title || ref.title || "").trim();
  const author = String(videoMeta.author || ref.author || "").trim();
  const uploadDate = String(videoMeta.uploadDate || ref.uploadDate || "").trim();
  const pageTitle = String(page?.part || ref.pageTitle || "").trim();
  const url = buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url;
  const videoDuration = Number(page?.duration || videoMeta.defaultDuration || 0) || 0;
  // 选定轨的身份三元组（可选轨清单按 gateway 轨原样交出，字段名映射单源在
  // core/context-payload 的工厂投影里）。
  const selectedSubtitleId = String(selectedTrack.id || "").trim();
  const selectedSubtitleUrl = String(selectedTrack.subtitleUrl || "").trim();
  const subtitleLang = String(selectedTrack.lanDoc || selectedTrack.lan || "").trim();

  // payload 一律经 core/context-payload 的取数构造器产出（字段清单/key 序/缺省
  // 与数组守卫的单源），本文件只做取数与事实归一。热评不在本路径拉取：gateway
  // 的 fetchHotComments(count) 按 getCurrentAid() 取「当前视频」的 aid，对任意
  // contextRef 的网络解析会装进别的视频的热评；取数构造器给出空数组占位，恢复
  // 历史会话时由装配链决定热评来源。
  // ChapterItem 是 gateway Chapter 的宽窄同形（该类型缺省 to），跨层边界经
  // unknown 对齐（payload 的 chapters 由工厂按数组守卫收口，消费方均按
  // Array.isArray 容忍）。
  const payload = createFetchedContextPayload({
    bvid: ref.bvid,
    cid,
    aid,
    title,
    author,
    uploadDate,
    url,
    pageIndex,
    pageCount: videoMeta.pages.length,
    pageTitle,
    duration: videoDuration,
    subtitleBody: body as SubtitleBodyItem[],
    selectedSubtitleId,
    selectedSubtitleUrl,
    subtitleLang,
    // 轨条目与 clip.subtitles 同源同形（fetcher 亦以 gateway 轨写入该槽）：
    // 探针只取长度，跨层类型面按既有手法对齐。
    subtitleOptions: tracks as unknown as SubtitleOption[],
    chapters: subtitleBundle.chapters as unknown as ChapterItem[],
    settings
  });
  // 跨层形状对齐：core/context-payload 的 SubtitleOption/ChapterItem 与
  // ai/types 的同名字段是同形结构类型（可选性/必选性略宽窄不同），边界处经
  // unknown 断言对齐 AiContext（与 core/context-assembly 的全量路径同一手法）。
  return { ...payload, isVideoContext: true } as unknown as AiContext;
}

export async function resolveAiConversationPageRef(contextRef: unknown): Promise<{
  url: string;
  bvid: string;
  cid: string;
  pageIndex: number;
  pageTitle: string;
}> {
  const ref = buildAiContextRef(contextRef);
  if (!ref.isVideoContext || !ref.bvid) {
    return {
      url: ref.url || "",
      bvid: ref.bvid || "",
      cid: ref.cid || "",
      pageIndex: Number(ref.pageIndex) > 0 ? Number(ref.pageIndex) : 1,
      pageTitle: ref.pageTitle || ""
    };
  }

  const videoMeta = await fetchVideoMeta(bgFetchJson, ref.bvid);
  const page = pickPageForAiContext(videoMeta.pages, ref);
  const pageIndex = Number(page?.page || ref.pageIndex || extractPageIndexFromUrl(ref.url || "") || 1) || 1;
  return {
    url: buildCanonicalVideoUrl(ref.bvid, pageIndex) || ref.url || "",
    bvid: ref.bvid,
    cid: String(page?.cid || ref.cid || "").trim(),
    pageIndex,
    pageTitle: String(page?.part || ref.pageTitle || "").trim()
  };
}
