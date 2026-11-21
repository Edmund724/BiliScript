import { parseClock } from "./clock-text.js";
import { decodeHtmlEntities } from "./string-utils.js";

export interface OutlineChapter {
  seconds: number;
  title: string;
  to?: number;
}

export const MAX_OUTLINE_CHAPTERS = 100;

const OUTLINE_LINE_RE = /^(?:[-*•>#\s]|\d+[.、)])*\s*(\d{1,2}:\d{2}(?::\d{2})?)[\s・·]+(.{1,120}?)\s*$/;

function parseOutlineClock(text: string): number {
  return parseClock(text) ?? -1;
}

export function hasOutlineTimestampLine(text: unknown): boolean {
  return String(text ?? "")
    .split(/\r?\n/)
    .some((line) => OUTLINE_LINE_RE.test(line));
}

export function parseChapterOutline(text: unknown, limit: number = MAX_OUTLINE_CHAPTERS): OutlineChapter[] {
  const lines = String(text ?? "").split(/\r?\n/);
  const out: OutlineChapter[] = [];
  const seen = new Set<number>();
  for (const line of lines) {
    const match = line.match(OUTLINE_LINE_RE);
    if (!match) continue;
    const seconds = parseOutlineClock(match[1]);
    const title = decodeHtmlEntities(match[2]).trim();
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

export function hotCommentsText(hotComments: unknown): string {
  if (!Array.isArray(hotComments)) return "";
  return hotComments
    .map((item) => {
      const message = String((item as { message?: unknown })?.message ?? "");
      const subs = (item as { subMessages?: unknown })?.subMessages;
      const subText = Array.isArray(subs)
        ? subs.map((sub) => String((sub as unknown) ?? "")).filter(Boolean).join("\n")
        : "";
      return subText ? `${message}\n${subText}` : message;
    })
    .filter(Boolean)
    .join("\n");
}

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

export type ChapterSourceKind = "outline" | "manuscript" | "auto";

export interface ChapterSource {
  kind: ChapterSourceKind;
  chapters: OutlineChapter[];
  signatureChapters: unknown[];
}

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
