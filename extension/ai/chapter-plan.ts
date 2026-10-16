// 概览「分章计划」单源（arch-review-2026-09 候选 2）：把分章来源裁定的结果
// （shared/chapter-outline.ts 的 ChapterSource）一次翻译成管线要用的全部事实——
// 系统提示词三选一、给定章节（含越界过滤）、用户提示词变量、预算切段输入与
// 产物章节的 graft。此前这七处解释散在 ai/analysis-orchestrate.ts 里各判一次，
// 且末章界有两套独立推导（单发路径取 built.timing.maxTimestampSeconds、分段路径取
// resolveEndSeconds 的结果）——两者数值严格相等（同一 normalize + 同一
// max(floor(时长), 字幕末条) 公式），却只能靠注释对齐。现在 endSeconds 只在本模块
// 推导一次，由 graft 的闭包捕获，调用方拿不到第二个 end 值。
//
// 静态依赖：analysis-prompts（三份系统提示词常量）与 analysis-validate（产物章节
// 形状与上限）两个纯片、shared/chapter-outline 的裁定类型、subtitle/cache 的
// normalizeSubtitleItems。无 chrome / 网络依赖，纯函数。

import { normalizeSubtitleItems } from "../subtitle/cache.js";
import {
  ANALYSIS_SYSTEM_PROMPT,
  GIVEN_CHAPTERS_SYSTEM_PROMPT,
  OUTLINE_QUOTES_SYSTEM_PROMPT
} from "./analysis-prompts.js";
import { MAX_ANALYSIS_CHAPTERS, type AnalysisChapter, type OverviewAnalysis } from "./analysis-validate.js";
import type { ChapterSource, ChapterSourceKind, OutlineChapter } from "../shared/chapter-outline.js";

// 用户提示词变量（buildAnalysisPrompt 的章节目录相关入参）：title / ownerName /
// videoDescription 透传上下文，chapterOutline 与 titlesOnly 随来源而定。
export interface ChapterPlanPromptVars {
  title: unknown;
  ownerName: unknown;
  videoDescription: unknown;
  chapterOutline: OutlineChapter[];
  titlesOnly: boolean;
}

// 预算切段输入：官方章节（manuscript）时由 signatureChapters 重映射为 {from, title}；
// 其余来源为空（时间轴不参与切段，见 resolveChapterPlan 内注）。
export interface ChapterPlanBudgetChapter {
  from?: unknown;
  title?: unknown;
}

export interface ChapterPlan {
  /** 裁定来源（透传 chapterSource.kind，供消费方诊断/断言，不重复解释）。 */
  kind: ChapterSourceKind;
  /** 简介/评论时间轴来源：章节只留标题、summary 一律空串。 */
  titlesOnly: boolean;
  /** 过滤后仍有给定章节 → 章节不是模型的活儿（照抄 + 补 summary）。 */
  hasGivenChapters: boolean;
  /** 过滤后的给定章节清单（提示词与产物边界都用它）。 */
  givenChapters: OutlineChapter[];
  /** 三选一的系统提示词。 */
  systemPrompt: string;
  /** 用户提示词变量。 */
  promptVars: ChapterPlanPromptVars;
  /** 预算切段输入（口径见 ChapterPlanBudgetChapter）。 */
  budgetChapters: ChapterPlanBudgetChapter[];
  /**
   * 模型产出章节 → 产物章节：有给定章节时照抄给定清单（模型只贡献 summary），
   * 末章界用构造时闭包捕获的 endSeconds；给定章节为空时原样返回入参。
   */
  graft(modelChapters: AnalysisChapter[]): AnalysisChapter[];
}

/**
 * 解析分章计划（唯一读点）：给定来源裁定 + 上下文 + 字幕体，产出管线要用的全部
 * 分章事实。endSeconds（给定章节的越界上限与末章落界）只在这里推导一次。
 */
export function resolveChapterPlan({
  chapterSource,
  context,
  body
}: {
  chapterSource: ChapterSource;
  context?: Record<string, unknown> | null;
  body?: unknown[];
}): ChapterPlan {
  const ctx = context || {};
  const bodyItems = Array.isArray(body) ? body : [];
  // 给定章节（时间轴目录或官方章节）非空 → 章节不是模型的活儿，走「照抄 + 补 summary」
  // 提示词；空则自由分章（概览分章票 03 决议）。先按可覆盖时长裁一遍：评论时间轴里
  // 可能混进别的视频/片尾之后的时间戳，越界条目不进提示词也不进产物（两者一致）。
  const endSeconds = resolveEndSeconds(ctx, bodyItems);
  const givenChapters = chapterSource.chapters.filter((chapter) => chapter.seconds <= endSeconds);
  const hasGivenChapters = givenChapters.length > 0;
  // 简介/评论时间轴目录（outline）只留标题、不写 AI 简介（用户拍板 2026-09-30）：
  // 模型只挑金句；官方章节（manuscript）仍逐章补简介。
  const titlesOnly = chapterSource.kind === "outline";
  const systemPrompt = !hasGivenChapters
    ? ANALYSIS_SYSTEM_PROMPT
    : titlesOnly
      ? OUTLINE_QUOTES_SYSTEM_PROMPT
      : GIVEN_CHAPTERS_SYSTEM_PROMPT;

  const promptVars: ChapterPlanPromptVars = {
    title: ctx.title,
    ownerName: ctx.author,
    videoDescription: ctx.videoDescription,
    chapterOutline: givenChapters,
    titlesOnly
  };
  // 分段计划：只有官方章节进切段对齐——平台章节由 UP 维护、间隔以分钟计，对齐能让
  // 每章字幕落在同一段里；简介/评论时间轴可能每几十秒一条（切段会碎成多条小请求，
  // 调用数按目录条数放大），故时间轴只决定章节与提示词，不参与预算切段。
  // 注意用**未过滤**的 signatureChapters 重映射（与 givenChapters 的越界过滤不一致）：
  // 这是刻意的行为冻结，切段输入口径不变。
  const budgetChapters: ChapterPlanBudgetChapter[] =
    chapterSource.kind === "manuscript"
      ? chapterSource.signatureChapters.map((chapter) => {
          const item = chapter as { from?: unknown; title?: unknown };
          return { from: item?.from, title: item?.title };
        })
      : [];

  return {
    kind: chapterSource.kind,
    titlesOnly,
    hasGivenChapters,
    givenChapters,
    systemPrompt,
    promptVars,
    budgetChapters,
    // endSeconds / titlesOnly 由构造闭包捕获：调用方只交模型章节，末章界单源。
    graft: (modelChapters: AnalysisChapter[]): AnalysisChapter[] =>
      hasGivenChapters ? applyGivenChapters(givenChapters, modelChapters, endSeconds, titlesOnly) : modelChapters
  };
}

// 给定章节 → 产物章节（概览分章票 03 决议）：标题与边界一律以给定清单为准，模型
// 只提供每章 summary——按 from 最近邻一对一 graft（每个模型章节最多被认领一次），
// 对不上的章留空串。时间轴目录没有 to，边界取下一章 from；末章回落 endSeconds。
// titlesOnly（简介/评论时间轴来源，用户拍板 2026-09-30）：章节只留标题，summary
// 一律空串——即使模型不听话硬写简介也丢弃（F7）。
// 非 titlesOnly（官方章节）的空串是缺陷而非设计：模型少返回一章时贪心认领的缺口
// 总落在清单尾部，这类章打 missingSummary 标记，UI 显示「本章概括缺失」+ 重跑入口。
function applyGivenChapters(
  given: OutlineChapter[],
  modelChapters: AnalysisChapter[],
  endSeconds: number,
  titlesOnly = false
): AnalysisChapter[] {
  const remaining = (Array.isArray(modelChapters) ? modelChapters : []).slice();
  const out: AnalysisChapter[] = [];
  for (let i = 0; i < given.length; i += 1) {
    const from = Math.floor(Number(given[i]?.seconds) || 0);
    const nextFrom = i + 1 < given.length ? Math.floor(Number(given[i + 1]?.seconds) || 0) : null;
    const explicitTo = Math.floor(Number(given[i]?.to));
    const to =
      Number.isFinite(explicitTo) && explicitTo > from
        ? explicitTo
        : nextFrom !== null && nextFrom > from
          ? nextFrom
          : Math.max(from, Math.floor(Number(endSeconds) || 0));
    const summary = titlesOnly ? "" : takeNearestSummary(remaining, from);
    out.push({
      from,
      to,
      title: String(given[i]?.title ?? "").trim().slice(0, 300),
      summary,
      ...(!titlesOnly && !summary ? { missingSummary: true } : {})
    });
  }
  return out.slice(0, MAX_ANALYSIS_CHAPTERS);
}

// 缓存装载路径的缺章补标（与 graft 同口径）：旧产物没有 missingSummary 字段，
// manuscript 来源命中缓存时补打，UI 因此能对旧缓存也显示缺章占位与重跑入口。
// 调用方按 kind 把关——outline 的 titlesOnly 空串是设计内行为，不应走到这里。
export function flagMissingChapterSummaries(analysis: OverviewAnalysis): OverviewAnalysis {
  const chapters = (Array.isArray(analysis?.chapters) ? analysis.chapters : []).map((chapter) =>
    String(chapter?.summary ?? "").trim() ? chapter : { ...chapter, missingSummary: true }
  );
  return { ...analysis, chapters };
}

// 取「from 最接近」的模型章节的 summary，取走即从候选里移除（一对一，不重复认领）。
function takeNearestSummary(remaining: AnalysisChapter[], from: number): string {
  if (!remaining.length) {
    return "";
  }
  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < remaining.length; i += 1) {
    const distance = Math.abs(Number(remaining[i]?.from) - from);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = i;
    }
  }
  return bestIndex < 0 ? "" : String(remaining.splice(bestIndex, 1)[0]?.summary ?? "");
}

// 给定章节的末章落界兜底：视频时长与字幕末条时间戳取大（与提示词时长变量同口径）。
function resolveEndSeconds(ctx: Record<string, unknown>, body: unknown[]): number {
  const items = normalizeSubtitleItems(body);
  const last = items.length ? items[items.length - 1] : null;
  const lastSeconds = last ? Math.max(0, Math.floor(Number(last?.to) || Number(last?.from) || 0)) : 0;
  return Math.max(Math.floor(Number(ctx.videoDuration) || 0), lastSeconds);
}
