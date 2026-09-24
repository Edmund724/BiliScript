// extension/notes/render.ts
// Note/export rendering logic (Markdown, SRT, TXT, chapters, subtitles).
// 导出正文只有 简介 / 章节 / 字幕 三段：frontmatter、播放器 <iframe> 与评论节
// 随笔记导出功能删除，Markdown/SRT/TXT 下载与时间戳口径原样保留。

import { type Settings } from "../core/defaults.js";
import { formatTimestamp } from "../shared/string-utils.js";
import { formatClock, shouldUseHours } from "../shared/clock-text.js";
import { normalizeChapters } from "../subtitle/chapters.js";
import { buildSubtitleSectionLines, shouldShowHoursInNote } from "./section-lines.js";
import { state, type State } from "../core/state.js";

// 渲染入参的宽松 meta 形状：字段全部按可选收口，各渲染函数内部沿用原有的
// String()/Number() 归一，行为与迁出前一致。clipState 片段按结构直接兼容；
// State 容器（无同名字段）经 buildMarkdown 的联合参数收口（TS 弱类型检查
// 要求联合显式包含 State）。
interface NoteRenderMeta {
  description?: unknown;
  videoDuration?: unknown;
  chapters?: unknown[];
}

// 字幕条目的宽松形状：ai/subtitle-prompt 的 unknown[] body 与 core/state 的
// SubtitleBodyItem 都按此结构传入；时间戳消费点按 number 断言（与迁出前
// 直传的运行时值一致），文案统一经 String() 归一。
interface SubtitleBodyItemLike {
  from?: unknown;
  to?: unknown;
  content?: unknown;
}

// 派生渲染（预览/字幕段/TXT）只读 includeTimestampInBody 一个开关；
// 字幕段行渲染（arch-review-2026-09/04 起在 ./section-lines.ts）同口径。
interface NoteRenderSettings {
  includeTimestampInBody?: boolean;
}

function buildChapterLines(chapters: unknown[] | null | undefined, withHours = false): string[] {
  const chapterItems = normalizeChapters(chapters);
  if (chapterItems.length === 0) {
    return [];
  }

  return chapterItems.map((item) => {
    const fromText = formatClock(item.from, { hours: withHours });
    return `- \`${fromText}\` ${item.title}`;
  });
}

export function buildMarkdown(meta: NoteRenderMeta | State, body: unknown[] | null | undefined, settings: Settings): string {
  const m = meta as NoteRenderMeta;
  const compactWithHours = shouldShowHoursInNote(m, body);
  const chapterLines = buildChapterLines(m.chapters || [], compactWithHours);
  const subtitleSectionLines = buildSubtitleSectionLines(
    body,
    m.chapters || [],
    settings,
    compactWithHours
  );

  const intro = String(m.description || "").trim();

  const lines: string[] = [];
  if (intro) {
    lines.push("## 简介", "", intro, "");
  }

  if (chapterLines.length > 0) {
    lines.push("## 章节", "", ...chapterLines, "");
  }

  lines.push("## 字幕", "", ...subtitleSectionLines);

  return lines.join("\n");
}

export function buildSrt(body: SubtitleBodyItemLike[] | null | undefined): string {
  return (body || [])
    .map((item, index) => {
      const from = formatTimestamp(item.from as number, true);
      const to = formatTimestamp(item.to as number, true);
      const text = String(item.content || "").trim();
      return `${index + 1}\n${from} --> ${to}\n${text}`;
    })
    .join("\n\n");
}

export function buildSubtitlePreview(body: SubtitleBodyItemLike[] | null | undefined, settings: NoteRenderSettings): string {
  const compactWithHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (settings.includeTimestampInBody) {
        return `\`${formatClock(item.from as number, { hours: compactWithHours })}\` ${text}`;
      }
      return text;
    })
    .filter(Boolean)
    .join("\n");
}

export function buildTxt(body: SubtitleBodyItemLike[] | null | undefined, settings?: NoteRenderSettings): string {
  const withHours = shouldShowHoursInSubtitle(body);
  return (body || [])
    .map((item) => {
      const text = String(item?.content || "").trim();
      if (!text) {
        return "";
      }
      if (!settings?.includeTimestampInBody) {
        return text;
      }
      return `${formatClock(item.from as number, { hours: withHours })} ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

// withHours 字幕级判定：只聚合字幕末尾 to；「≥3600 才带小时位」的阈值判定
// 单源 shared/clock-text.ts。含章节边界/视频时长的元数据级口径见
// ./section-lines.ts 的 shouldShowHoursInNote。
function shouldShowHoursInSubtitle(body: SubtitleBodyItemLike[] | null | undefined): boolean {
  const maxTo = (body || []).reduce((max, item) => {
    const to = Number(item?.to || 0);
    return Number.isFinite(to) && to > max ? to : max;
  }, 0);
  return shouldUseHours(maxTo);
}
