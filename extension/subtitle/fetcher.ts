// 候选03 常驻瘦身：setMessage / setStatus 迁入 core/ui-status.js。
import { setMessage, setStatus } from "../core/ui-status.js";
import { state, clipState } from "../core/state.js";
import type { SubtitleOption } from "../core/state.js";
import { extractBvid, computeCurrentClipSignature } from "../bilibili/video-id-shared.js";
import { getSettings } from "../core/runtime.js";
import {
  ensureRunActive,
  isStaleRunError,
  getErrorMessage,
  toReadableText,
  isRetryableNetworkError,
  retryAsync
} from "../shared/error-helpers.js";
import { logInfo, logWarn, shouldDebugLog } from "../shared/logging.js";
// isReaderViewOpen 位于 reader 状态微模块（候选04 结构归并）：纯 state 读取，
// 不再经 reader/index.js facade 静态转发（否则整条 reader 域会被拖进本链闭包）。
import { isReaderViewOpen } from "../reader/state.js";
import { readVideoTitle, readVideoAuthor, readUploadDate, readVideoDescription } from "./core.js";
import { normalizeChapters } from "./chapters.js";
import { normalizeSubtitleTracks, pickPreferredSubtitle } from "./selection.js";
import { buildSubtitleCandidates } from "./cache.js";
import { resolvePageContext } from "../reader/page-context.js";
import { notifyReaderPresenter, subscribeSubtitleRefresh } from "../reader/reader-bus.js";
// 字幕接受事务（CONTEXT.md 域词条）：接受/无字幕出口的唯一入口。渲染与状态栏
// 回调在模块求值期注入（下方 configureCommitUi），保持 commit → 本模块/UI 层
// 无静态边。
import { acceptSubtitle, acceptSecondarySubtitle, commitNoSubtitle, configureCommitUi } from "./commit.js";
import {
  fetchVideoMeta as gatewayFetchVideoMeta,
  fetchSubtitleBundle as gatewayFetchSubtitleBundle,
  readRuntimeVideoDuration,
  contentFetchJson
} from "../bilibili/gateway.js";
import type { SubtitleTrack } from "../bilibili/gateway.js";
// 取体深 module（CONTEXT.md「字幕」的正文）：两条装载链共用的唯一取体实现，
// 出口（接受事务）由下方两个装载器注入。
import { loadTrackBody } from "./body.js";

// ASR 域（pipeline + fallback 及其专属依赖 audio-source/offscreen-bridge.page）
// 经动态 import 按需加载（候选4 分包）：只有视频无 CC 字幕时才需要语音转写。
// 装配组合根（provider 列表读取 + createAsrFallback deps 装配 + promise 缓存
// 单例 + broadcastSubtitleStatus）已归位 asr/active-fallback.ts
//（arch-review-2026-09/09）；本模块只经下方 loadAsrFallbackOrNull /
// finishNoSubtitle 的动态 import 边获取回退单例——此依赖为单向边，import 环 A
// 不再成立。分包前这些模块随单文件 bundle 常驻；分包后成为动态 import 边被切
// 进 entry/chunks/。实例缓存与失败重试语义见 asr/active-fallback.ts。

// The fetcher is lazily loaded as part of the summarize chain (候选02 分层惰性
// ，见 subtitle/lazy.js): the reader-bus (presenter seam) registration below used
// to be a module-level side effect, which relied on "fetcher is always loaded at
// startup" — no longer true once the chain is on-demand. Registration now
// binds to chain loading: initSummarizeChain() runs once on the
// ensureSummarizeChain() success path (subscribeSubtitleRefresh 自带去重，
// 重复调用安全), and the reader side triggers a re-fetch by ensuring the chain
// first (call site in reader/lifecycle.js) and then calling requestSubtitleRefresh().
export function initSummarizeChain(): void {
  subscribeSubtitleRefresh(refreshClip);
}

// 字幕接受事务的渲染/状态栏回调接线（CONTEXT.md：DOM 渲染回调由 fetcher 注入，
// 保持静态图无环）。放在模块求值期执行：本模块任何导出可被调用前必然完成，
// asr/active-fallback.ts 装配（loadActiveAsrFallback）注入的 commitNoSubtitle
// 也因此保证先接线后可用。
configureCommitUi({
  setStatus
});

// fetchVideoMeta / fetchSubtitleBundle 纯直通包装已删除（arch-slim-2/03）：原
// 26 行只加 logInfo/logWarn，日志下沉到 gateway 对应函数（debug 级差异），本
// 模块与 ai/context-resolver 一致直用 bilibili/gateway 的函数 + contentFetchJson。

export async function tryLoadSubtitleCandidates(
  candidates: SubtitleTrack[],
  runId: number,
  forceRefresh: boolean
): Promise<SubtitleTrack> {
  let lastError: unknown = null;
  for (const item of candidates || []) {
    try {
      logInfo("[BILISCRIPT] try subtitle track", {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        url: item.subtitleUrl
      });
      await loadSubtitle(
        item.subtitleUrl,
        item.lanDoc || item.lan || "unknown",
        runId,
        item.id,
        forceRefresh
      );
      return item;
    } catch (error) {
      lastError = error;
      const reasonCode = toReadableText((error as { code?: unknown }).code, "");
      const reasonMessage = getErrorMessage(error, "unknown");
      const meta = {
        id: item.id,
        lan: item.lan,
        lanDoc: item.lanDoc,
        reason: reasonCode || reasonMessage
      };
      if (reasonCode === "SUBTITLE_DURATION_MISMATCH") {
        logInfo(`[BILISCRIPT] subtitle track skipped ${JSON.stringify(meta)}`);
      } else {
        logWarn(`[BILISCRIPT] subtitle track rejected ${JSON.stringify(meta)}`);
      }
      ensureRunActive(runId, state.clip.fetchRunId);
      continue;
    }
  }

  if (lastError) {
    throw lastError;
  }
  throw new Error("这个视频暂时没有可用字幕。");
}

// keepFetchState：错误路径专用（586c61b 纪律，见 sidepanel-subtitle-wait.js
// 复述）——reset 全清会把 fetchState 洗成 idle，等待转写的侧边栏轮询会误判
// "非转写中"提前放行空字幕。错误路径传 true 保留调用方随后覆写的 "error"
//（见 refreshClip catch），其余调用方（message-handler 的 URL 变化等）默认
// 全清，语义不变。
// runId 代次协调（M23）：本函数不递增 fetchRunId——递增单点在 URL 变化编排
//（entry/message-handler 的 handleUrlChange）感知签名变化处同步先行，早于本
// reset 与新视频 refreshClip 各自的异步装载链（递增若放在这里，新视频的
// refreshClip 可能先起跑再被迟到的递增误杀）。在飞 run 的让位由提交事务的
// runId 自检（commit.acceptSubtitle / commitNoSubtitle）与各 ensureRunActive
// 检查点承担。错误路径的 reset 不递增：本 run 已终态，不得顶掉并发中更新的
// 同视频抓取。
export function resetClipState({ keepFetchState = false }: { keepFetchState?: boolean } = {}): void {
  clipState.setBvid("");
  clipState.setAid("");
  clipState.setCid("");
  clipState.setCidSource("");
  clipState.setPageIndex(1);
  clipState.setPageCount(0);
  clipState.setPageTitle("");
  clipState.setVideoDuration(0);
  clipState.setDescription("");
  clipState.setTitle("");
  clipState.setAuthor("");
  clipState.setUploadDate("");
  clipState.setSubtitles([]);
  clipState.setSelectedSubtitleId("");
  clipState.setSelectedSubtitleUrl("");
  clipState.setSelectedSubtitleLang("");
  clipState.setSubtitleBody([]);
  // 副轨槽与 clip 同生命周期：换视频（含错误路径的 keepFetchState 清场）一并复位——
  // 双语的目标语言是全局偏好（不清），但"本视频已装好的那份副轨 body"必须清
  //（05 号票 Q4；无字幕出口的逆事务 commitNoSubtitle **不**清副轨槽）。
  clipState.clearSecondarySubtitle();
  if (!keepFetchState) {
    clipState.setSubtitleFetchState("idle");
  }
  clipState.setNoSubtitleReason(null);
  // 详情与原因同生命周期：切视频不继承上一个视频的失败报文明细
  clipState.setNoSubtitleDetail("");
  clipState.setChapters([]);
  clipState.setHotComments([]);
  clipState.setMarkdown("");
  clipState.setSrt("");
  clipState.setTxt("");
  clipState.setCurrentClipSignature(computeCurrentClipSignature());
  notifyReaderPresenter("reset");
  state.reader.setActiveSubtitleIndex(-1);
  state.reader.setActiveChapterIndex(-1);
  state.reader.readingVideoEl = null;

  setMessage("");
  if (isReaderViewOpen()) {
    notifyReaderPresenter("rerender");
    // 中性文案：resetClipState 的两个调用方里，URL 变化编排（entry/message-handler）
    // 之后必有抓取接力（阅读模式分支自身刷新，普通页分支由预抓取起跑），而
    // handleClipFetchError 的终态失败清场之后不再抓取——不承诺「自动重新抓取」
    // 才不会在失败路径上说假话（该路径随后同步覆写为失败文案）。
    notifyReaderPresenter("status", "视频已切换，字幕将自动重新抓取。");
  }
}

export async function refreshClip(): Promise<void> {
  const runId = state.clip.fetchRunId + 1;
  clipState.setFetchRunId(runId);
  try {
    setMessage("");
    setStatus("正在抓取视频信息...");
    clipState.setSubtitleFetchState("loading");
    if (isReaderViewOpen()) {
      notifyReaderPresenter("rerender");
    }
    state.setSettings(await getSettings());
    ensureRunActive(runId, state.clip.fetchRunId);

    await resolveClipMeta(runId);

    // 视频身份（作者/分P）此刻已落 state，但字幕还没到手：无字幕轨时更是整轮
    // ASR 转写（几分钟到几小时）期间不会再有任何渲染通知——subtitle-ready 在
    // 转写收尾才发，reset 后的空 meta 会一直留在面板 header。身份一确定就按
    // 当前 state 重投影一次（rerender 是纯 state 投影，幂等）。
    if (isReaderViewOpen()) {
      notifyReaderPresenter("rerender");
    }

    setStatus("正在获取可用字幕...");
    const subtitleBundle = await retryAsync(
      () => gatewayFetchSubtitleBundle(contentFetchJson, {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        aid: state.clip.aid
      }),
      3,
      500
    );
    ensureRunActive(runId, state.clip.fetchRunId);
    clipState.setSubtitles(normalizeSubtitleTracks(subtitleBundle.tracks) as unknown as SubtitleOption[]);
    clipState.setChapters(normalizeChapters(subtitleBundle.chapters) as import("../core/state.js").ChapterItem[]);
    // 惰性求值（10-9）：logInfo 内部按调试门过滤，但 .map() 作为实参会先于门
    // 判定无条件执行、为每条章节/字幕各分配一个数组——门关闭时零收益纯浪费。
    // 改在门外先判 shouldDebugLog()，门关时跳过整套 map 分配。
    if (shouldDebugLog()) {
      logInfo(
        "[BILISCRIPT] chapters",
        state.clip.chapters.map((item) => ({
          from: item.from,
          to: item.to,
          title: item.title
        }))
      );
      logInfo(
        "[BILISCRIPT] subtitle tracks",
        state.clip.subtitles.map((item) => ({
          id: item.id,
          lan: item.lan,
          lanDoc: item.lanDoc,
          url: item.subtitleUrl
        }))
      );
    }

    // 显式点击“刷新抓取”时默认走网络，避免命中历史缓存导致字幕错位。
    const forceRefresh = true;

    const preferred = await selectSubtitleTrack(runId);
    if (!preferred) {
      return;
    }

    const candidates = buildSubtitleCandidates(state.clip.subtitles as unknown as SubtitleTrack[], preferred);
    let selected: SubtitleTrack | null = null;

    try {
      selected = await tryLoadSubtitleCandidates(candidates, runId, forceRefresh);
    } catch (error) {
      const message = getErrorMessage(error, "");
      if (!message.includes("HTTP") && (error as { code?: string }).code !== "SUBTITLE_DURATION_MISMATCH") {
        throw error;
      }

      // Retry because subtitle signed URLs may expire quickly or hit rate limit.
      selected = await retryWithFreshBundle({ retryReason: error, preferred, runId, forceRefresh });
    }
    ensureRunActive(runId, state.clip.fetchRunId);
    if (selected) {
      logInfo("[BILISCRIPT] selected subtitle track", {
        id: selected.id,
        lan: selected.lan,
        lanDoc: selected.lanDoc
      });
    }
    // fetchState/reason 已由 tryLoadSubtitleCandidates → loadSubtitle 内的
    // 字幕接受事务（commit.acceptSubtitle）落位（ready + 清原因），渲染也由
    // 事务内的 subtitle-ready 通知驱动（唯一 emit 点，此处补发即双渲染），
    // 这里只做完成提示。提示走 reader-bus "status" 通知（与渲染同通道、由
    // reader 侧同序收敛），不经 setStatus 直写——直写会绕过门控，在渲染缺席
    // 时先行宣告成功（「抓取完成但显示无字幕」的文案半边）。
    notifyReaderPresenter("status", "抓取完成，可以复制或下载字幕。");
  } catch (error) {
    await handleClipFetchError(error, runId);
  }
}

// ===== refreshClip 三段纯提取（arch-review-2026-09/09，零行为变化）=====

// 段1 meta 解析：bvid 校验 → meta 抓取（带重试）→ clipState 基础信息写入 →
// 分 P / cid / duration 经 page-context seam 解析（时长缺失兜底
// readRuntimeVideoDuration，仍缺失则中止）→ resolved ids 日志。
async function resolveClipMeta(runId: number): Promise<void> {
  clipState.setBvid(extractBvid(location.href));
  if (!state.clip.bvid) {
    throw new Error("当前页面不是标准 BV 视频地址，无法抓取字幕。");
  }

  const meta = await retryAsync(() => gatewayFetchVideoMeta(contentFetchJson, state.clip.bvid), 2, 250);
  ensureRunActive(runId, state.clip.fetchRunId);

  // 调试：打印 API 返回的原始数据
  logInfo("[BILISCRIPT] raw meta data", {
    meta,
    defaultCid: meta.defaultCid,
    pagesCount: (meta.pages || []).length
  });

  clipState.setAid(meta.aid || "");
  clipState.setTitle(meta.title || readVideoTitle());
  clipState.setAuthor(meta.author || readVideoAuthor());
  clipState.setUploadDate(meta.uploadDate || readUploadDate());
  clipState.setDescription(meta.description || readVideoDescription());
  clipState.setPageCount(Array.isArray(meta.pages) ? meta.pages.length : 0);
  clipState.setCurrentClipSignature(computeCurrentClipSignature());

  // 分 P / cid / duration 解析统一走 page-context seam；结果由本模块写入 state.clip。
  const pageContext = resolvePageContext(location.href, meta);
  const resolvedPageIndex = pageContext.pageIndex;
  clipState.setPageIndex(resolvedPageIndex);
  clipState.setPageTitle(pageContext.pageTitle);
  clipState.setCid(String(pageContext.cid || ""));
  clipState.setCidSource(pageContext.cidSource);
  clipState.setVideoDuration(Number(pageContext.duration || 0));
  if (!(state.clip.videoDuration > 0)) {
    clipState.setVideoDuration(readRuntimeVideoDuration());
  }
  if (!(state.clip.videoDuration > 0)) {
    throw new Error("无法获取当前视频时长，已停止抓取以避免串到错误字幕。");
  }

  logInfo("[BILISCRIPT] resolved video ids", {
    url: location.href,
    aid: state.clip.aid,
    bvid: state.clip.bvid,
    cid: state.clip.cid,
    cidSource: state.clip.cidSource,
    pageIndex: resolvedPageIndex,
    videoDuration: state.clip.videoDuration
  });
}

// 段2 轨道选择：无字幕轨 / 无偏好轨两个守卫出口经 finishNoSubtitle 收尾
//（转写成果在 fallback 内经字幕接受事务落位后直接让调用方 return），返回选中
// 的偏好轨，null = 已走无字幕出口。
async function selectSubtitleTrack(runId: number): Promise<SubtitleTrack | null> {
  // 无字幕时也允许进入阅读视图，只是字幕区域保持空态。
  if (state.clip.subtitles.length === 0) {
    await finishNoSubtitle(runId);
    return null;
  }

  const preferred = pickPreferredSubtitle(state.clip.subtitles, {
    previousId: state.clip.selectedSubtitleId,
    previousUrl: state.clip.selectedSubtitleUrl,
    previousLang: state.clip.selectedSubtitleLang
  });

  if (!preferred) {
    await finishNoSubtitle(runId);
    return null;
  }
  return preferred;
}

// 段3 错误分类与 ASR 等待（refreshClip 的 catch 主体）：stale 让位 → 当前视频
// 有 ASR 转写进行中则等待共享转写继续收尾 → 其余落 reset+error 统一收尾，并按
// 错误类型分类文案（时长不匹配 vs 通用失败）。
async function handleClipFetchError(error: unknown, runId: number): Promise<void> {
  if (isStaleRunError(error)) {
    return;
  }
  // 当前视频有 ASR 转写进行中：本轮辅助抓取的失败绝不能清上下文（
  // resetClipState 会把 subtitleFetchState 置回 idle，等待转写的侧边栏轮询
  // 会误判"非转写中"提前放行空字幕）。改为等待共享转写结果继续收尾。
  // 探针按当前视频 bvid/cid 匹配——切走视频后仍在后台跑的其它视频转写
  // 不拦截本路径，其成果也不会串到当前 UI（转写与视频切换解耦，见
  // asr/fallback.js）。
  const asrFallbackInstance = await loadAsrFallbackOrNull();
  if (asrFallbackInstance?.hasActiveAsrTranscribe({ bvid: state.clip.bvid, cid: state.clip.cid })) {
    setStatus(`抓取失败：${getErrorMessage(error)}，继续等待音频转写…`);
    await asrFallbackInstance.awaitActiveAsrTranscribe({ runId, bvid: state.clip.bvid, cid: state.clip.cid });
    return;
  }
  // 586c61b 纪律：reset 全清会把 fetchState 洗回 idle（等待转写的侧边栏轮询
  // 会误判"非转写中"提前放行空字幕），错误路径以 keepFetchState 保住状态、
  // 再一次写 error，替代历史「error → reset → error」双写。
  resetClipState({ keepFetchState: true });
  clipState.setSubtitleFetchState("error");
  if (isReaderViewOpen()) {
    notifyReaderPresenter("rerender");
  }
  if ((error as { code?: string }).code === "SUBTITLE_DURATION_MISMATCH") {
    setStatus("抓取失败：未找到与当前视频时长匹配的字幕轨，可能该视频无可用字幕。");
    return;
  }
  setStatus(`抓取失败：${getErrorMessage(error)}`);
}

// 无字幕出口编排（refreshClip 两处守卫分支共用，原为逐行相同的两段手抄）：
// 先给 ASR 回退一个机会——done 时转写成果已在 fallback 内经字幕接受事务
//（commit.acceptSubtitle）收尾，这里直接 return；skip / empty / error 三种
// 都落回无字幕状态（逆事务 commit.commitNoSubtitle）。失败/空结果/配置原因
// 已由 fallback 各终态分支写进 clipState（reason + detail），出口只负责清空
// 与呈现——状态栏与 reader 通知的文案由事务统一拼装（唯一出口）。
// STALE_RUN（发起前被顶掉 / 切走视频）原样上抛，由 refreshClip 的 catch 静默吞掉。
async function finishNoSubtitle(runId: number): Promise<void> {
  const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
  const asrResult = await (await loadActiveAsrFallback()).maybeRunAsrFallback({ runId });
  if (asrResult === "done") {
    return;
  }
  // 无字幕出口逆事务随行 runId 自检（M23）：maybeRunAsrFallback 的 skip/empty
  // 判定与出口提交之间隔着 await，reset/新抓取推进代次后不把「无字幕」写进
  // 新视频的 state（STALE_RUN 上抛，refreshClip catch 静默吞掉）。
  await commitNoSubtitle({ runId });
}

// 签名 URL 失效重试（refreshClip 的 catch 路径）：字幕签名 URL 可能快速过期
// 或触发限流，重抓 bundle 后重建轨道/章节、按原偏好重选轨并重试候选。与主
// 路径重复的 normalizeSubtitleTracks/normalizeChapters/setSubtitles/
// setChapters 四步收拢于此，避免双抄。无合适轨时抛出触发重试的原始错误，
// 交由 refreshClip 的错误路径统一收尾。
async function retryWithFreshBundle({
  retryReason,
  preferred,
  runId,
  forceRefresh
}: {
  retryReason: unknown;
  preferred: SubtitleTrack;
  runId: number;
  forceRefresh: boolean;
}): Promise<SubtitleTrack> {
  const bundle = await retryAsync(
    () =>
      gatewayFetchSubtitleBundle(contentFetchJson, {
        bvid: state.clip.bvid,
        cid: state.clip.cid,
        aid: state.clip.aid
      }),
    2,
    500
  );
  ensureRunActive(runId, state.clip.fetchRunId);
  clipState.setSubtitles(normalizeSubtitleTracks(bundle.tracks) as unknown as SubtitleOption[]);
  clipState.setChapters(normalizeChapters(bundle.chapters) as import("../core/state.js").ChapterItem[]);
  const retryPreferred = pickPreferredSubtitle(state.clip.subtitles, {
    previousId: preferred.id,
    previousUrl: preferred.subtitleUrl,
    previousLang: preferred.lanDoc || preferred.lan || ""
  });
  if (!retryPreferred) {
    throw retryReason;
  }
  const retryCandidates = buildSubtitleCandidates(state.clip.subtitles as unknown as SubtitleTrack[], retryPreferred);
  return tryLoadSubtitleCandidates(retryCandidates, runId, forceRefresh);
}

export async function loadSubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false
): Promise<void> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }
  // 取体链已收口 subtitle/body.js（缓存键装配 → 缓存命中与时长校验 → 坏缓存
  // 清键 → 网络取体 → 空体/时长校验 → 落缓存与写失败上浮）。本壳只保留主轨
  // 特有的两件事：URL 空值守卫，与出口——主轨的接受事务。排序不在此处做：
  // 稳定排序统一收口在事务内（旧缓存条目可能无序）。
  await loadTrackBody(
    // forceRefresh 缺省 false（切轨语义：优先命中 per-track 缓存）。
    { url, lang, subtitleId, runId, forceRefresh },
    {
      log: {
        cacheHit: "[BILISCRIPT] using cached subtitle",
        cacheMismatch: "[BILISCRIPT] cached subtitle duration mismatch, clearing cache"
      },
      // 出口：字幕接受事务（commit.acceptSubtitle）——写 selected 三项 →
      // ready → 清原因 → 刷新派生（含事务内排序后的 body）→ 通知 reader。
      // runId 随行自检（M23）：取体链的 await（读缓存 / 落缓存）之后到站的旧
      // run 在事务门口让位，旧视频字幕不写进已重置的 state。
      onBody: (body) =>
        acceptSubtitle({
          body,
          // 轨 id 缺省时沿用当前已选中的那条（主轨口径；副轨回退空串）。
          selectedSubtitleId: subtitleId ? String(subtitleId) : state.clip.selectedSubtitleId,
          selectedSubtitleUrl: url,
          selectedSubtitleLang: lang,
          runId
        })
    }
  );
}

// ===== 双语副轨装载（bilingual-subtitles/02 + 05 号票）=====
//
// 与主轨并列的第二条装载链：取体链走同一个 module（subtitle/body.js），**唯一**
// 的分叉是出口——副轨的收尾是乐观写槽（clip.secondarySubtitle，自带
// idle|loading|ready|error）+ 并列的 acceptSecondarySubtitle：**不改** selected
// 三项、**不写** subtitleFetchState（那是整片单相位，写了会把整个字幕 tab 洗成
// 加载/失败面）。
//
// 历史注记：这里原有一句「与 loadSubtitle 的重复是有意的对称」。取体链收口后
// 该理由已失效——两轨的分叉点就是出口，而出口是注入的参数，重复不再承担任何
// 「保护上一张图」的职责（依据见 subtitle/body.js 头注）。
//
// forceRefresh 缺省 false（切轨语义：优先命中 per-track 缓存）——只有弹层的"重试"
// 与"刷新抓取"传 true（02 号票 Q1/Q6）。
export async function loadSecondarySubtitle(
  url: string,
  lang: string,
  runId: number = state.clip.fetchRunId,
  subtitleId: string = "",
  forceRefresh: boolean = false
): Promise<void> {
  if (!url) {
    throw new Error("字幕 URL 为空。");
  }
  // 代次自检先于乐观写入：迟到的旧 run 不得把目标写进已重置的新视频槽。
  if (runId !== undefined) {
    ensureRunActive(runId, state.clip.fetchRunId);
  }
  // 乐观写「目标 + loading」早于任何 await（02 号票 Q3：副轨的「选中」=「目标」）：
  // 副列的选中态与列表的「译文加载中…」占位立刻反映用户的选择，网络结果只改
  // state/body，**失败也不回退目标**（与主轨 Q14 相反，理由见 02 号票裁定）。
  clipState.markSecondarySubtitleLoading({ id: subtitleId ? String(subtitleId) : "", url });
  if (isReaderViewOpen()) {
    notifyReaderPresenter("rerender");
  }

  try {
    // 取体链与主轨同一份实现（subtitle/body.js）：缓存 → 时长校验 → 网络 →
    // 落缓存。本壳只保留副轨特有的三件事：先于乐观写入的代次自检（见上）、
    // 出口（乐观写槽的并列接受事务）、失败出口（error 写 + STALE_RUN 不写）。
    await loadTrackBody(
      { url, lang, subtitleId, runId, forceRefresh },
      {
        log: {
          cacheHit: "[BILISCRIPT] using cached secondary subtitle",
          cacheMismatch: "[BILISCRIPT] cached secondary subtitle duration mismatch, clearing cache"
        },
        // 出口：副轨的接受事务（commit.acceptSecondarySubtitle）——写副轨槽
        // （目标轨身份 + 事务内排序后的 body + ready）并发
        // "secondary-subtitle-ready"；不碰主轨 selected 三项与整片相位。
        // 轨 id 缺省时回退空串（副轨口径；主轨沿用已选中那条）。
        onBody: (body) =>
          acceptSecondarySubtitle({
            body,
            subtitleId: subtitleId ? String(subtitleId) : "",
            subtitleUrl: url,
            runId
          })
      }
    );
  } catch (error) {
    // 让位（STALE_RUN）不写 error：那是"更新的 run 已接手"，把旧 run 的失败写进
    // 新视频的副轨槽正是 runId 纪律要防的那类串体。
    if (!isStaleRunError(error)) {
      clipState.markSecondarySubtitleError();
      if (isReaderViewOpen()) {
        notifyReaderPresenter("rerender");
      }
    }
    throw error;
  }
}

// 无字幕提示文案（buildNoSubtitleStatusMessage）已随无字幕出口迁入
// subtitle/commit.js——它是无字幕出口事务的一部分，唯一消费点在该事务内。
//
// ASR 回退装配（broadcastSubtitleStatus / loadAsrProviderList / createAsrFallback
// deps 八项 / promise 缓存单例）已整体归位 asr/active-fallback.ts
//（arch-review-2026-09/09）。本模块只保留下方动态 import 边：加载失败按
//「无活动转写」降级（返回 null 继续原错误处理）——chunk 加载失败绝不能掩盖
// 原始抓取错误；加载成功后与原同步调用语义一致（awaitActiveAsrTranscribe 的
// 异常保持原样向上抛）。
async function loadAsrFallbackOrNull() {
  try {
    const { loadActiveAsrFallback } = await import("../asr/active-fallback.js");
    return await loadActiveAsrFallback();
  } catch (asrLoadError) {
    logWarn("[BILISCRIPT] asr fallback module load failed; treat as no active transcribe", asrLoadError);
    return null;
  }
}
