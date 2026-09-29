// 章节来源叶子（概览分章票 03 决议）：从视频简介/评论里解析「时间戳 + 标题」目录、
// 把 B 站官方章节（player/v2 的 view_points）归一成同一形状，并裁定概览的分章来源
// 优先级——简介/评论时间轴 > 官方章节 > AI 自由分章。
//
// 为什么住在 shared 叶子：概览管线的提示词装配与缓存签名要用这份裁定，reader
// 概览 tab 的「当前产物身份键」也必须用同一份裁定与同一份指纹（否则目录变化后
// 面板会继续复用旧产物）；而 reader 不得静态引 AI 管线（build-content 的装载图
// 守卫），故下沉到此。定位容错单源 shared/clock-text.ts 的 parseClock。

import { parseClock } from "./clock-text.js";

/** 时间轴目录里的单条章节：秒数 + 标题（标题原样保留，不让模型改写）。 */
export interface OutlineChapter {
  seconds: number;
  title: string;
  /** 官方章节自带的结束秒（简介/评论时间轴目录没有此字段），末章落界时优先用它。 */
  to?: number;
}

// 目录条数上限：防止简介/评论里上百行时间戳把提示词撑爆。与产物裁剪上限
// （analysis-validate.ts 的 MAX_ANALYSIS_CHAPTERS）同量级但各自独立——这里是
// 「解析上限」，那里是「产物上限」，改动需同时复核。
export const MAX_OUTLINE_CHAPTERS = 100;

// 时间戳行识别：行首（可带列表符号/引用符号）后跟 M:SS / MM:SS / H:MM:SS，
// 后接标题文字（标题与时间戳之间也可用「・」「·」等间隔符）。纯时间戳行（无标题）
// 不算章节条目。上游正则约束形状，数值容错（2 段分钟位不封顶、拒 ss≥60/
// 3 段 mm≥60/hh≥24）单源到 clock-text 的 parseClock。
const OUTLINE_LINE_RE = /^(?:[-*•>#\s]|\d+[.、)])*\s*(\d{1,2}:\d{2}(?::\d{2})?)[\s・·]+(.{1,120}?)\s*$/;

// 目录时间戳解析：容错规则单源（parseClock），哨兵语义保留——解不出返回 -1，
// parseChapterOutline 丢弃该条（「99:99」这类非法时刻归一后按拍板拒绝）。
function parseOutlineClock(text: string): number {
  return parseClock(text) ?? -1;
}

/**
 * 从简介/评论文本提取「时间戳目录」：形如「00:00 开场 / 03:25 安装」的行。
 * 至少 2 条才认定为现成章节划分（单条时间戳行不构成划分）；重复秒数去重、
 * 按秒排序；默认上限 MAX_OUTLINE_CHAPTERS。
 */
export function parseChapterOutline(text: unknown, limit: number = MAX_OUTLINE_CHAPTERS): OutlineChapter[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: OutlineChapter[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    const match = line.match(OUTLINE_LINE_RE);
    if (!match) continue;
    const seconds = parseOutlineClock(match[1]);
    const title = match[2].trim();
    if (seconds < 0 || !title || seen.has(seconds)) continue;
    seen.add(seconds);
    out.push({ seconds, title });
  }
  if (out.length < 2) {
    return [];
  }
  out.sort((a, b) => a.seconds - b.seconds);
  return out.slice(0, Math.max(0, Math.floor(Number(limit) || 0)));
}

/** 热门评论（HotComment[]）→ 可解析文本：只取 message 正文，一行一条。 */
export function hotCommentsText(hotComments: unknown): string {
  if (!Array.isArray(hotComments)) return "";
  return hotComments
    .map((item) => String((item as { message?: unknown })?.message ?? ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * B 站官方章节（view_points）→ 目录形状：剔空标题与非法 from、按 from 升序、
 * 同秒去重（保留先到者），保留 to 供末章落界。
 * 注：这里按**秒**去重（不是 subtitle/chapters.ts 的 (from, title) 对）——给定章节
 * 以秒为身份，同秒两条会让章界塌成 0 长度。
 */
export function manuscriptChapterOutline(chapters: unknown): OutlineChapter[] {
  const list = (Array.isArray(chapters) ? chapters : [])
    .map((raw) => {
      const item = raw as { from?: unknown; to?: unknown; title?: unknown };
      const seconds = Math.floor(Number(item?.from));
      const to = Math.floor(Number(item?.to));
      return {
        seconds,
        to: Number.isFinite(to) && to > seconds ? to : undefined,
        title: typeof item?.title === "string" ? item.title.trim().slice(0, 300) : ""
      };
    })
    .filter((item) => Number.isFinite(item.seconds) && item.seconds >= 0 && item.title)
    .sort((a, b) => a.seconds - b.seconds);

  const out: OutlineChapter[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    if (seen.has(item.seconds)) continue;
    seen.add(item.seconds);
    out.push(item.to === undefined ? { seconds: item.seconds, title: item.title } : item);
  }
  return out.slice(0, MAX_OUTLINE_CHAPTERS);
}

/** 概览的分章来源：时间轴目录 / 官方章节 / AI 自由分章。 */
export type ChapterSourceKind = "outline" | "manuscript" | "auto";

export interface ChapterSource {
  kind: ChapterSourceKind;
  /** 给定章节清单（outline / manuscript 非空；auto 为空）——提示词、边界与签名都用它。 */
  chapters: OutlineChapter[];
  /**
   * 进签名的章节模式位：只有「官方章节作给定来源」时才是原始官方章节数组，其余为空。
   * 管线与 reader 都从这里取值，禁止各自手拼——同构是「目录/章节变化后面板旧产物
   * 必须退场」的前提。数组内容变（标题/秒数）即签名变（见 subtitle/cache.ts 的指纹位）。
   */
  signatureChapters: unknown[];
}

/**
 * 裁定分章来源（概览分章票 03 决议）：简介 + 评论里的时间轴目录（≥2 条）优先；
 * 没有目录时用 B 站官方章节；两者都没有则 auto（AI 自由分章 + 后段门槛）。
 */
export function resolveChapterSource(
  description: unknown,
  hotComments: unknown,
  chapters: unknown
): ChapterSource {
  const timeline = parseChapterOutline([String(description ?? ""), hotCommentsText(hotComments)].join("\n"));
  if (timeline.length) {
    return { kind: "outline", chapters: timeline, signatureChapters: [] };
  }
  const manuscript = Array.isArray(chapters) ? chapters : [];
  const given = manuscriptChapterOutline(manuscript);
  if (given.length) {
    return { kind: "manuscript", chapters: given, signatureChapters: manuscript };
  }
  return { kind: "auto", chapters: [], signatureChapters: [] };
}
