// extension/subtitle/body.ts
// 「取体」深 module：取一条字幕轨的正文（body）的唯一实现。
//
// 领域词取自 CONTEXT.md「字幕」词条：一条轨的正文就是 `subtitleBody` 的那份
// `{from, to, content}` 数组。本模块回答一个问题——**给定一条轨的地址与身份，
// 拿到它这次的正文**——并把这条链上的全部口径收在自己内部：
//
//   1. 缓存键装配（per-track 键：bvid + cid + source key，cache.js）
//   2. 缓存命中与时长校验（validateSubtitleByDuration：180/300/600 三档覆盖率
//      门槛 + 15% 上限容忍）
//   3. 坏缓存清理（时长不匹配即清键，随后落到网络路径）
//   4. 网络取体（gateway.fetchSubtitleBody）+ 空体拒绝 + 网络体时长校验
//   5. 落缓存与写失败上浮（LRU 淘汰后重试仍失败 → 消息栏一次性提示，不阻断）
//
// 出口（body 到手之后做什么）由调用方注入：主轨是 `acceptSubtitle` 接受事务，
// 副轨是先乐观写槽、失败再写 error 的并列事务。**注入是刻意的**——本模块不认识
// 任何一条接受事务，也就不会让「主轨成为生效字幕」的语义渗进副轨（ADR-0016
// 决定 2：两条事务并列，不给 acceptSubtitle 加角色参数）。
//
// 历史注记（为什么删掉了「与 loadSubtitle 的重复是有意的对称」）：那条注释成立
// 的前提是「两轨的取体链逐行同形、只有收尾不同」，于是对称被当成了不动它的
// 理由。取体链收口后，唯一的分叉点是出口，而出口本来就该是参数——再看不出任何
// 一处「为了对称而保留」的重复。若将来两轨的取体口径真的要分叉（例如副轨换一套
// 时长校验），分叉点也仍然显式落在调用方传入的出口与文案上，而不是散在两条
// 逐行重复的函数体里。
//
// 本模块**不**持有：URL 空值守卫（副轨必须先于乐观写入抛错，顺序属装载器）、
// runId 代次自检的入口位置（副轨的「先于乐观写入」那一次在装载器里）、失败出口
// （主轨交给 refreshClip 的 catch；副轨写槽 error 态、STALE_RUN 不写）。这些是
// 两条装载链的真实差异，留在各自的薄壳里。
//
// 关于 asr/fallback.ts 的第三个同类取体调用组（不予复用的证据）：它的键取自
// **发起转写时快照**的 bvid/cid（不读 `state.clip`，见该文件 267-278 行），
// 取体的「网络」一环是音频转写管线（含共享在飞值、整轮重试、孤儿清理），
// 落缓存在 `runAttempt` 内带 ASR 专属文案与孤儿清理后置，出口是
// `finishAsrFallback`（种伪轨 + 不传 runId，另有 isStale 视频键门控）。
// 键的身份、取体的边界、落缓存的顺序与出口四处都不重合——这是语义差异，
// 不是抄写差异，故保持独立。
//
// 依赖方向：subtitle 域内的叶子（cache / duration-validation / core.state / core.ui-status
// / shared.logging / shared.error-helpers / bilibili.gateway）。本模块不 import
// fetcher / ui / commit，静态图无环。

import { state } from "../core/state.js";
import { setMessage } from "../core/ui-status.js";
import { logInfo, logWarn } from "../shared/logging.js";
import { ensureRunActive } from "../shared/error-helpers.js";
import { fetchSubtitleBody } from "../bilibili/gateway.js";
import { validateSubtitleByDuration } from "./duration-validation.js";
import type { DurationValidationResult } from "./duration-validation.js";
import {
  clearSubtitleCacheByKey,
  getSubtitleCacheKey,
  loadSubtitleFromCache,
  saveSubtitleToCache
} from "./cache.js";
// 轨身份的构造单点（三字段 → track / url / lang 优先级裁定）：缓存键入口只收身份。
import { trackIdentity } from "./source-key.js";

// 时长不匹配的 distinct 错误（读路径按 code 分流文案：refreshClip 的 catch 认
// 这个 code 落「未找到与当前视频时长匹配的字幕轨」），details 带校验结果供日志。
interface SubtitleDurationMismatchError extends Error {
  code: "SUBTITLE_DURATION_MISMATCH";
  details: DurationValidationResult;
}

// 取体请求：一条轨的地址 + 身份（两个装载器的现有维度，逐字沿用其调用形状）。
export interface SubtitleBodyRequest {
  /** 轨的签名 URL（空串由调用方先行守卫）。 */
  url: string;
  /** 槽语言（轨 id 为空时它是缓存 source key 的分量）。 */
  lang: string;
  /** 轨 id（B 站 `id_str`）；空串表示只能退到 url / lang 分量。 */
  subtitleId?: string;
  /**
   * 发起方抓取代次（可选，语义同 commit 两条事务的 runId）：传入则在「缓存命中
   * 之后」与「网络取体之后」两次自检代次，已被推进时抛 STALE_RUN 让位。
   */
  runId?: number;
  /** true 时跳过缓存直走网络（只有弹层的「重试」与「刷新抓取」传 true）。 */
  forceRefresh?: boolean;
}

/**
 * 出口：正文到手后把它写成什么。可以同步也可以异步（模块只 await 它，不看
 * 返回值）——主轨注入 `acceptSubtitle`，副轨注入 `acceptSecondarySubtitle` 的
 * 调用；若将来要加第三条轨，只需再注入一个出口，取体链零改动。
 */
export type SubtitleBodyExit = (body: unknown[]) => unknown;

// 取体日志文案：主副轨只有名词不同（subtitle / secondary subtitle），逐字注入
// 以钉住既有文案，不在模块里拼串（拼串会让将来某一轨改词时悄悄改掉另一轨）。
export interface SubtitleBodyLog {
  /** 缓存命中：`[BILISCRIPT] using cached <名词>`。 */
  cacheHit: string;
  /** 缓存时长不匹配：`[BILISCRIPT] cached <名词> duration mismatch, clearing cache`。 */
  cacheMismatch: string;
}

export interface SubtitleBodyHooks {
  onBody: SubtitleBodyExit;
  log: SubtitleBodyLog;
}

/**
 * 取体：缓存优先 → 时长校验（坏缓存清键后落网络）→ 网络取体 → 空体拒绝 →
 * 时长校验 → 落缓存（写失败上浮）→ 交给注入的出口。
 *
 * 排序**不在此处**做：稳定排序统一收口在两条接受事务内（旧缓存条目可能无序，
 * 「subtitleBody 按 from 升序」不变量的依据在 commit.ts）。这里保持取到的原始
 * 顺序，落缓存的有序性由事务的幂等排序兜底。
 */
export async function loadTrackBody(
  { url, lang, subtitleId = "", runId, forceRefresh = false }: SubtitleBodyRequest,
  { onBody, log }: SubtitleBodyHooks
): Promise<void> {
  const cacheKey = getSubtitleCacheKey({
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    identity: trackIdentity(subtitleId, url, lang)
  });

  // 缓存优先：命中且时长合规即交付；命中的是坏体（时长不匹配）则清键落到网络。
  if (!forceRefresh) {
    const cachedBody = await loadSubtitleFromCache(cacheKey);
    if (cachedBody && Array.isArray(cachedBody) && cachedBody.length > 0) {
      const cachedCheck = validateSubtitleByDuration(cachedBody, state.clip.videoDuration);
      if (!cachedCheck.ok) {
        logWarn(log.cacheMismatch, { cacheKey, reason: cachedCheck.reason });
        await clearSubtitleCacheByKey(cacheKey);
      } else {
        logInfo(log.cacheHit, { cacheKey, itemCount: cachedBody.length });
        // 代次自检先于出口（M23 runId 协调）：读缓存也隔着 await，reset/新抓取
        // 推进代次后到站的旧 run 在出口门口让位。
        if (runId !== undefined) {
          ensureRunActive(runId, state.clip.fetchRunId);
        }
        await onBody(cachedBody);
        return;
      }
    }
  }

  // 网络取体：保持返回的原始顺序（排序见上）。
  const subtitle = await fetchSubtitleBody(url);
  if (runId !== undefined) {
    ensureRunActive(runId, state.clip.fetchRunId);
  }
  const body = Array.isArray(subtitle.body) ? subtitle.body : [];
  if (body.length === 0) {
    throw new Error("字幕文件为空。");
  }
  const durationCheck = validateSubtitleByDuration(body, state.clip.videoDuration);
  if (!durationCheck.ok) {
    const mismatchError = new Error("字幕时长与当前视频不匹配。") as SubtitleDurationMismatchError;
    mismatchError.code = "SUBTITLE_DURATION_MISMATCH";
    mismatchError.details = durationCheck;
    throw mismatchError;
  }

  // 落缓存（写入带 LRU 淘汰：失败先清理旧视频再重试一次）。
  const saveResult = await saveSubtitleToCache(cacheKey, body);
  if (saveResult && saveResult.ok === false) {
    // 淘汰后重试仍失败：经既有消息栏一次性上浮，不阻断主流程。
    setMessage("字幕已加载，但本地缓存写入失败（已自动清理旧缓存仍失败），重启浏览器后需重新抓取。");
  }

  // 出口晚于落缓存：网络体先落盘再进 state（缓存写入方持有有序副本的现状不变）。
  await onBody(body);
}
