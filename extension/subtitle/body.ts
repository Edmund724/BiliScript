// extension/subtitle/body.ts
// 「取体」深 module：取一条字幕轨的正文（body）与按偏好回退候选的唯一实现。
//
// 本模块不绑定 DOM / core/state / ui-status / 页面传输，由调用方显式注入视频身份、
// JsonTransport、活跃校验与写失败通知；出口（body 到手之后做什么）同样由调用方注入，
// 保持主副轨两条接受事务并列（ADR-0016）。
//
// 流程：
//   1. 缓存键装配（per-track 键：bvid + cid + source key，cache.js）
//   2. 缓存命中与时长校验（validateSubtitleByDuration）
//   3. 坏缓存清理（时长不匹配即清键，随后落到网络路径）
//   4. 网络取体（fetchSubtitleBodyJson(transport, url)）+ 空体拒绝 + 网络体时长校验
//   5. 落缓存与写失败上浮回调（onCacheSaveFailed）

import { logInfo, logWarn } from "../shared/logging.js";
import type { JsonTransport } from "../bilibili/gateway-core.js";
import { fetchSubtitleBodyJson, type SubtitleTrack } from "../bilibili/video-api.js";
import { validateSubtitleByDuration } from "./duration-validation.js";
import type { DurationValidationResult } from "./duration-validation.js";
import {
  buildSubtitleCandidates,
  clearSubtitleCacheByKey,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "./cache.js";
import {
  normalizeSubtitleTracks,
  pickPreferredSubtitle,
  resolveTrackTarget,
  type PreferredSubtitleContext
} from "./selection.js";
// 轨身份的构造单点（三字段 → track / url / lang 优先级裁定）：缓存键入口只收身份。
import { trackIdentity } from "./source-key.js";

// 时长不匹配的 distinct 错误（读路径按 code 分流文案），details 带校验结果供日志。
interface SubtitleDurationMismatchError extends Error {
  code: "SUBTITLE_DURATION_MISMATCH";
  details: DurationValidationResult;
}

export interface SubtitleBodyRequest {
  /** 视频 BVID。 */
  bvid: string;
  /** 分 P CID。 */
  cid: string;
  /** 视频时长（秒），用于时长校验。 */
  videoDuration: number;
  /** 轨的签名 URL。 */
  url: string;
  /** 槽语言（轨 id 为空时它是缓存 source key 的分量）。 */
  lang: string;
  /** 轨 id（B 站 `id_str`）；空串表示只能退到 url / lang 分量。 */
  subtitleId?: string;
  /** true 时跳过缓存直走网络。 */
  forceRefresh?: boolean;
  /** 网络取数传输实现（如 contentFetchJson 或 bgFetchJson）。 */
  transport: JsonTransport;
  /** 可选活跃守卫：缓存命中后与网络取体后各调用一次（如 ensureRunActive）。 */
  checkActive?: () => void;
  /** 本地缓存淘汰后写入仍失败时的可选提示回调。 */
  onCacheSaveFailed?: () => void;
}

/**
 * 出口：正文到手后把它写成什么。可以同步也可以异步（模块只 await 它，不看返回值）。
 */
export type SubtitleBodyExit<T = unknown> = (body: T[]) => unknown;

export interface SubtitleBodyLog {
  /** 缓存命中日志前缀。 */
  cacheHit: string;
  /** 缓存时长不匹配日志前缀。 */
  cacheMismatch: string;
}

export interface SubtitleBodyHooks<T = unknown> {
  onBody?: SubtitleBodyExit<T>;
  log?: SubtitleBodyLog;
}

const DEFAULT_BODY_LOG: SubtitleBodyLog = {
  cacheHit: "[BILISCRIPT] using cached subtitle",
  cacheMismatch: "[BILISCRIPT] cached subtitle duration mismatch, clearing cache"
};

/**
 * 取体：缓存优先 → 时长校验（坏缓存清键后落网络）→ 网络取体 → 空体拒绝 →
 * 时长校验 → 落缓存（写失败上浮）→ 交给注入的出口并返回正文。
 *
 * 排序不在此处做：稳定排序收口在接受事务或业务归一处，本函数保留原始顺序。
 */
export async function loadTrackBody<T = unknown>(
  {
    bvid,
    cid,
    videoDuration,
    url,
    lang,
    subtitleId = "",
    forceRefresh = false,
    transport,
    checkActive,
    onCacheSaveFailed
  }: SubtitleBodyRequest,
  { onBody, log = DEFAULT_BODY_LOG }: SubtitleBodyHooks<T> = {}
): Promise<T[]> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }
  const cacheKey = getSubtitleCacheKey({
    bvid,
    cid,
    identity: trackIdentity(subtitleId, url, lang)
  });

  // 缓存优先：命中且时长合规即交付；命中的是坏体（时长不匹配）则清键落到网络。
  if (!forceRefresh) {
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, videoDuration);
      if (!cachedCheck.ok) {
        logWarn(log.cacheMismatch, { cacheKey, reason: cachedCheck.reason });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        logInfo(log.cacheHit, { cacheKey, itemCount: cachedBody.length });
        checkActive?.();
        await onBody?.(cachedBody as T[]);
        return cachedBody as T[];
      }
    }
  }

  // 网络取体：保持返回的原始顺序。
  const body = await fetchSubtitleBodyJson<T>(transport, url);
  checkActive?.();
  if (!Array.isArray(body) || body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。") as SubtitleDurationMismatchError;
    mismatchError.code = "SUBTITLE_DURATION_MISMATCH";
    mismatchError.details = durationCheck;
    throw mismatchError;
  }

  // 落缓存（写入带 LRU 淘汰：失败先清理旧视频再重试一次）。
  const saveResult = await saveSubtitleToCache(cacheKey, body);
  if (saveResult && saveResult.ok === false) {
    onCacheSaveFailed?.();
  }

  // 出口晚于落缓存：网络体先落盘再交付调用方。
  await onBody?.(body);
  return body;
}

export interface SubtitleTrackCandidate {
  id?: string;
  lan?: string;
  lanDoc?: string;
  subtitleUrl?: string;
  source?: string;
}

export interface PreferredNativeSubtitleRequest<TTrack extends SubtitleTrackCandidate = SubtitleTrack> {
  tracks: TTrack[] | null | undefined;
  preferred?: PreferredSubtitleContext;
  bvid: string;
  cid: string;
  videoDuration: number;
  forceRefresh?: boolean;
  transport: JsonTransport;
  checkActive?: () => void;
  onCacheSaveFailed?: () => void;
  log?: SubtitleBodyLog;
}

export interface LoadedNativeSubtitle<TBody = unknown, TTrack extends SubtitleTrackCandidate = SubtitleTrack> {
  tracks: TTrack[];
  track: TTrack;
  body: TBody[];
}

/**
 * 归一候选轨 → 选偏好轨 → 构造去重候选序列并逐条尝试取体（失败回退下一候选轨）。
 * 无可用轨时返回 null；全部候选均失败时抛出最后一个异常。
 */
export async function loadPreferredNativeSubtitle<
  TBody = unknown,
  TTrack extends SubtitleTrackCandidate = SubtitleTrack
>({
  tracks,
  preferred,
  bvid,
  cid,
  videoDuration,
  forceRefresh = false,
  transport,
  checkActive,
  onCacheSaveFailed,
  log
}: PreferredNativeSubtitleRequest<TTrack>): Promise<LoadedNativeSubtitle<TBody, TTrack> | null> {
  const normalizedTracks = normalizeSubtitleTracks(tracks as SubtitleTrack[] | null | undefined) as unknown as TTrack[];
  if (normalizedTracks.length === 0) {
    return null;
  }
  const preferredTrack = pickPreferredSubtitle(normalizedTracks as unknown as SubtitleTrack[], preferred);
  const candidates = buildSubtitleCandidates(
    normalizedTracks as unknown as SubtitleTrack[],
    preferredTrack
  ) as unknown as TTrack[];
  if (candidates.length === 0) {
    return null;
  }

  let lastError: unknown = null;
  for (const track of candidates) {
    try {
      const target = resolveTrackTarget(track);
      const body = await loadTrackBody<TBody>(
        {
          bvid,
          cid,
          videoDuration,
          url: target.url,
          lang: target.lang,
          subtitleId: target.id,
          forceRefresh,
          transport,
          checkActive,
          onCacheSaveFailed
        },
        { log }
      );
      return { tracks: normalizedTracks, track, body };
    } catch (error) {
      lastError = error;
      checkActive?.();
    }
  }

  throw lastError || new Error("这个视频暂时没有可用字幕。");
}
